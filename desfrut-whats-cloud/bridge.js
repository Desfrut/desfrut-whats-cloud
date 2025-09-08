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
