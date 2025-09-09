// bridge.js — BOT Whats em nuvem (Baileys) chamando sua IA no Render
// Handoff p/ humano + sem "Fontes:" + retries + keep-alive

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // opcional local; no Render usamos vars de ambiente

const fs = require('fs');
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

// Keep-alive para evitar primeira chamada fria
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 240000); // 4 min

if (!APP_URL) {
  console.error('Defina APP_URL (ex.: https://desfrut-ia.onrender.com)');
  process.exit(1);
}

const logger = Pino({ level: 'info' });
let lastQR = null;
let isOpen = false;

// ======= IA (sua API Flask no Render) — com RETRIES =======
async function callIA(payload) {
  const tries = [0, 600, 1500]; // 3 tentativas com backoff
  let lastErr;
  for (const wait of tries) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const res = await axios.post(`${APP_URL}/ask`, payload, { timeout: TIMEOUT_MS });
      const { answer } = res.data || {};
      return answer || 'Sem resposta.';
    } catch (e) {
      lastErr = e;
    }
  }
  logger.error({ err: lastErr?.message }, 'Falha ao consultar IA');
  return 'Desculpa! O serviço está acordando ou indisponível agora. Tente novamente em alguns segundos 🙏';
}

// Mantém a IA “acordada”
async function pingIA() {
  try { await axios.get(`${APP_URL}/healthz`, { timeout: 5000 }); } catch {}
}
setInterval(pingIA, KEEPALIVE_MS);

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
// Remove qualquer linha iniciada por "Fontes:" que venha embutida na resposta da IA
function stripSources(ans) {
  if (!ans) return '';
  try {
    const lines = String(ans).split(/\r?\n/).filter(l => !/^\s*\*?fontes?:\*?/i.test(l));
    return lines.join('\n').trim();
  } catch { return String(ans); }
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
      // já dá um ping inicial na IA
      pingIA().catch(()=>{});
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

    const reply = await callIA({ question: cleaned, customer_id: from, customer_name: pushName });
    const finalReply = stripSources(reply);
    await sock.sendMessage(from, { text: finalReply }, { linkPreview: false });
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
