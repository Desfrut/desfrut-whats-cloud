// bridge.js — BOT Whats em nuvem (Baileys) chamando sua IA no Render (com HANDOFF para humano)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // opcional local; no Render usamos vars de ambiente

const fs = require('fs'); // <— adicionado para handoff

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason } = baileys;

const express = require('express');
const Pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');

// ======= VARIÁVEIS DE AMBIENTE =======
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ALLOW_GROUPS = String(process.env.ALLOW_GROUPS || 'false').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');

// Handoff: tempo de pausa do bot (ms) e número do operador
const HANDOFF_TTL_MS = parseInt(process.env.HANDOFF_TTL_MS || '3600000', 10); // 1h por padrão
const OPERATOR_PHONE = (process.env.OPERATOR_PHONE || '').replace(/\D/g, ''); // ex.: +5592999999999

if (!APP_URL) {
  console.error('Defina APP_URL (ex.: https://desfrut-ia.onrender.com)');
  process.exit(1);
}

const logger = Pino({ level: 'info' });
let lastQR = null;
let isOpen = false;

// ======= IA (sua API Flask no Render) =======
async function callIA(question) {
  try {
    const res = await axios.post(`${APP_URL}/ask`, { question }, { timeout: TIMEOUT_MS });
    const { answer, fontes, error } = res.data || {};
    if (error) throw new Error(error);
    const fontesTxt = (Array.isArray(fontes) && fontes.length)
      ? `\n\n*Fontes:* ${fontes.join('; ')}`
      : '';
    return (answer || 'Sem resposta.') + fontesTxt;
  } catch (e) {
    logger.error({ err: e?.message }, 'Falha ao consultar IA');
    return 'Desculpa! O serviço está acordando ou indisponível agora. Tente novamente em alguns segundos 🙏';
  }
}

function isGroup(jid) {
  return jid.endsWith('@g.us');
}

// ======= HANDOFF: utilitários e banco simples em arquivo =======
const HANDOFF_DB = '/data/handoff.json';
function waJid(phoneE164) {
  const only = phoneE164.replace(/\D/g, '');
  return `${only}@s.whatsapp.net`;
}
function loadJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}
function saveJson(path, obj) {
  try { fs.writeFileSync(path, JSON.stringify(obj, null, 2)); } catch {}
}
let handoff = loadJson(HANDOFF_DB, {});
function inHandoff(jid) {
  const until = handoff[jid];
  return typeof until === 'number' && Date.now() < until;
}

// ======= Conexão WhatsApp =======
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    logger,
    printQRInTerminal: false, // logs em ASCII só local; na nuvem vamos usar /qr
    auth: state,
    browser: ['Desfrut IA', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false
  });

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQR = qr;
      // Mostra também no log (ASCII) para emergências
      qrcodeTerminal.generate(qr, { small: true });
      logger.info('QR atualizado. Acesse /qr para escanear.');
    }

    if (connection === 'close') {
      isOpen = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ reason }, 'Conexão fechada');
      if (reason !== DisconnectReason.loggedOut) startSock(); // tenta reconectar
      else logger.warn('Sessão expirada. Apague a pasta AUTH_DIR e reconecte.');
    } else if (connection === 'open') {
      isOpen = true;
      logger.info('✅ Conectado ao WhatsApp!');
      // Opcional: avisa o operador que o bot subiu
      if (OPERATOR_PHONE) {
        try { await sock.sendMessage(waJid(OPERATOR_PHONE), { text: '✅ Bot conectado e online.' }); } catch {}
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const up = m.messages && m.messages[0];
    if (!up || m.type !== 'notify') return;

    const from = up.key.remoteJid;
    const isFromMe = up.key.fromMe;
    if (isFromMe) return;
    if (!ALLOW_GROUPS && isGroup(from)) return;

    const msg = up.message || {};
    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';

    const cleaned = (text || '').trim();
    if (!cleaned) return;

    const pushName = up.pushName || 'Cliente';

    // ======= HANDOFF: comandos =======
    if (/^(quero falar com atendente|falar com atendente|atendente|humano)\b/i.test(cleaned)) {
      handoff[from] = Date.now() + HANDOFF_TTL_MS;
      saveJson(HANDOFF_DB, handoff);
      await sock.sendMessage(from, { text: 'Perfeito! Vou te conectar com um atendente humano agora. Você pode escrever por aqui. Para voltar ao autoatendimento depois, envie: "voltar".' });
      if (OPERATOR_PHONE) {
        await sock.sendMessage(waJid(OPERATOR_PHONE), { text: `⚠️ Handoff iniciado\nCliente: ${pushName} (${from})\nÚltima msg: “${cleaned}”` });
      }
      return; // pausa o fluxo de IA
    }

    if (/^voltar\b/i.test(cleaned)) {
      delete handoff[from];
      saveJson(HANDOFF_DB, handoff);
      await sock.sendMessage(from, { text: 'Voltei ao autoatendimento 🤖. Como posso te ajudar?' });
      return;
    }

    // Enquanto estiver em handoff, não responde como IA; apenas encaminha a msg ao operador
    if (inHandoff(from)) {
      if (OPERATOR_PHONE) {
        await sock.sendMessage(waJid(OPERATOR_PHONE), { text: `📩 ${pushName} (${from}): “${cleaned}”` });
      }
      return;
    }

    // ======= utilidades e IA =======
    if (cleaned.toLowerCase() === 'ping') {
      await sock.sendMessage(from, { text: 'pong ✅' }, { linkPreview: false });
      return;
    }

    const reply = await callIA(cleaned);
    await sock.sendMessage(from, { text: reply }, { linkPreview: false });
  });

  // ======= HTTP para QR e health =======
  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, whatsapp: isOpen ? 'connected' : (lastQR ? 'qr-waiting' : 'connecting') });
  });

  app.get('/qr', async (_req, res) => {
    if (isOpen) return res.send('<h2>✅ Conectado ao WhatsApp!</h2>');
    if (!lastQR) return res.send('<h2>Aguardando QR... atualize em alguns segundos.</h2>');

    try {
      const png = await qrcode.toDataURL(lastQR, { width: 300, margin: 1 });
      res.send(`<html><body style="font-family:Arial">
        <h2>Escaneie o QR no WhatsApp</h2>
        <img src="${png}" alt="QR"/>
        <p>WhatsApp > Dispositivos conectados > Conectar aparelho</p>
      </body></html>`);
    } catch {
      res.send('<h2>Falha ao gerar QR. Veja os logs ou tente novamente.</h2>');
    }
  });

  app.get('/', (_req, res) => {
    res.send('<h2>Desfrut Whats Bot</h2><p>Use <a href="/qr">/qr</a> para escanear o código.</p><p>Health: <a href="/healthz">/healthz</a></p>');
  });

  app.listen(PORT, () => logger.info(`HTTP pronto em 0.0.0.0:${PORT}`));
}

startSock().catch(err => console.error('Erro geral:', err));
# === Cole estes trechos no seu app.py (IA Flask) ===
# NOTA: Não apague o que você já tem. Vamos apenas adicionar blocos.

# 1) IMPORTS (adicione se ainda não existirem)
from flask import request, jsonify
import os, json, re, csv
import difflib

STATE_DB = os.environ.get("STATE_DB", "/data/state.json")  # memória por cliente
PRODUTOS_CSV = os.environ.get("PRODUTOS_CSV", "produtos.csv") # caminho do CSV de produtos

# 2) Memória simples por cliente (estado do carrinho, CEP, etc.)
def _load_state():
    try:
        with open(STATE_DB, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_state(d):
    try:
        with open(STATE_DB, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# 3) Utilitário: humanizar resposta com a “voz” Desfrut
VOZ = {
    "saudacao": "Oi! ",  # será usado quando fizer sentido
    "assinatura": "",
    "regras": [
        "Tom acolhedor, elegante e direto.",
        "Sem termos técnicos desnecessários.",
        "Foco em conforto, segurança e descrição do envio.",
        "Evitar emoji em excesso; use só quando ajudar (1 no máximo).",
    ]
}

def humanize(texto: str, nome: str | None = None) -> str:
    texto = texto.strip()
    if not texto:
        return "Posso te ajudar com mais alguma coisa?"
    # Ajuste sutil no início
    if nome:
        prefix = f"{VOZ['saudacao']}{nome.split(' ')[0]}, "
    else:
        prefix = VOZ['saudacao']
    # Evita duplicar cumprimentos se a resposta já começar amigável
    primeiros = texto[:20].lower()
    if any(p in primeiros for p in ["oi", "olá", "boa "]):
        prefix = ""
    return (prefix + texto).strip()

# 4) Ler produtos do CSV e fazer busca simples
# Esperado: colunas sku, nome (ou titulo), preco, estoque (se houver)

def _carregar_produtos():
    itens = []
    try:
        with open(PRODUTOS_CSV, newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for r in reader:
                itens.append({k.lower(): v for k, v in r.items()})
    except Exception:
        pass
    return itens

PROD_CACHE = None

def buscar_produto(termo: str, n=3):
    global PROD_CACHE
    if PROD_CACHE is None:
        PROD_CACHE = _carregar_produtos()
    if not PROD_CACHE:
        return []
    termo = termo.strip()
    # 1) Busca por SKU
    for p in PROD_CACHE:
        if termo.lower() in str(p.get('sku','')).lower():
            return [p]
    # 2) Fuzzy por nome/titulo
    nomes = [p.get('nome') or p.get('título') or p.get('titulo') or '' for p in PROD_CACHE]
    match = difflib.get_close_matches(termo, nomes, n=n, cutoff=0.5)
    res = [p for p in PROD_CACHE if (p.get('nome') or p.get('título') or p.get('titulo') or '') in match]
    return res[:n]

# 5) Ferramentas do agente
CEP_RE = re.compile(r"\b\d{5}-?\d{3}\b")


def tool_cotar_frete(cep: str):
    cep = re.sub(r"\D", "", cep)
    # Política simplificada (ajuste depois):
    # Manaus: frete imediato grátis (horário comercial). Interior/BR: prazos via Correios.
    if cep.startswith("690"):
        return "Em Manaus, oferecemos frete imediato grátis em horário comercial. Informe o bairro para estimativa do tempo de entrega."
    return (
        "Para o seu CEP, coto frete pelos Correios (PAC/Sedex). Me diga a cidade/UF e se deseja entrega econômica (PAC) "
        "ou rápida (Sedex). Se preferir, posso estimar com peso padrão (0,5 kg)."
    )


def tool_ver_produto(termo: str):
    itens = buscar_produto(termo, n=3)
    if not itens:
        return "Não encontrei esse item agora. Pode me enviar o nome exato ou o SKU?"
    linhas = []
    for p in itens:
        nome = p.get('nome') or p.get('título') or p.get('titulo') or 'Produto'
        sku = p.get('sku') or '—'
        preco = p.get('preco') or p.get('preço') or p.get('valor') or 'sob consulta'
        estoque = p.get('estoque') or p.get('qtd') or p.get('quantidade') or ''
        if estoque:
            linhas.append(f"• {nome} (SKU {sku}) – R$ {preco} — estoque: {estoque}")
        else:
            linhas.append(f"• {nome} (SKU {sku}) – R$ {preco}")
    linhas.append("Se quiser, já separo no seu nome. Me diga o SKU ou a opção que gostou.")
    return "\n".join(linhas)


def tool_criar_pedido(state: dict):
    # Simulação: gera um número e orienta próximo passo.
    pedido_id = f"DFT-{str(abs(hash(json.dumps(state))) % 100000).zfill(5)}"
    return (
        f"Pedido rascunho criado: {pedido_id}. Agora me confirme o método de pagamento (Pix ou cartão em até 6x) "
        f"e o endereço/retirada para eu finalizar."
    )

# 6) Roteador do agente (detecção simples por palavras/CEP)

def agente_responder(user_text: str, customer_id: str | None, customer_name: str | None):
    txt = (user_text or '').strip()
    if not txt:
        return None

    # Carrega estado do cliente
    db = _load_state()
    st = db.get(customer_id or 'anon', {"carrinho": []})

    # a) CEP / Frete
    m = CEP_RE.search(txt)
    if m:
        cep = m.group(0)
        st['cep'] = cep
        db[customer_id or 'anon'] = st
        _save_state(db)
        return tool_cotar_frete(cep)

    # b) Ver produto
    gatilhos = ["tem ", "estoque", "disponível", "preço", "valor", "sku", "tamanho", "cor"]
    if any(g in txt.lower() for g in gatilhos):
        # tenta adivinhar termo (tira palavras comuns)
        termo = re.sub(r"\b(tem|de|o|a|um|uma|preço|valor|do|da|no|na|sku|tamanho|cor|disponível|estoque)\b", "", txt, flags=re.I)
        termo = termo.strip() or txt
        resp = tool_ver_produto(termo)
        return resp

    # c) Criar pedido
    if re.search(r"\b(finalizar|fechar|comprar|fechar pedido|checkout)\b", txt, flags=re.I):
        return tool_criar_pedido(st)

    return None  # deixa o RAG responder

# 7) NOVO: endpoint auxiliar para testes (opcional)
@app.get('/produto')
def http_produto():
    q = request.args.get('q', '')
    return jsonify(buscar_produto(q, n=5))

# 8) Ajuste no /ask: usar a humanização e o agente ANTES do RAG
# Procure sua rota /ask existente e adapte conforme abaixo.
# Exemplo de referência:

@app.post('/ask')
def ask():
    data = request.get_json(silent=True) or {}
    user_q = (data.get('question') or '').strip()
    cust_id = data.get('customer_id')
    cust_name = data.get('customer_name')

    # 1) Prioriza Q&A se você já tiver a função answer_qna
    try:
        qna = answer_qna(user_q)  # se você já implementou
    except Exception:
        qna = None
    if qna:
        return jsonify({"answer": humanize(qna, cust_name)})

    # 2) Agente tenta executar ferramentas
    agent_ans = agente_responder(user_q, cust_id, cust_name)
    if agent_ans:
        return jsonify({"answer": humanize(agent_ans, cust_name)})

    # 3) Fallback: seu RAG / lógica atual (substitua pelo que já existe no seu app)
    # >>> COLE AQUI a chamada que você já usa hoje para gerar "answer" a partir da apostila/produtos <<<
    try:
        answer = gerar_resposta_existente(user_q)  # renomeie para a sua função real
    except NameError:
        answer = "Posso te ajudar com frete (me passe o CEP), disponibilidade ou preço (me diga o nome/SKU)."

    return jsonify({"answer": humanize(answer, cust_name)})


