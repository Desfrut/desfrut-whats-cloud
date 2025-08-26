// bridge.js — BOT Whats em nuvem (Baileys) chamando sua IA no Render
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // opcional local; no Render usamos vars de ambiente

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { useMultiFileAuthState, DisconnectReason } = baileys;

const express = require('express');
const Pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ALLOW_GROUPS = String(process.env.ALLOW_GROUPS || 'false').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');

if (!APP_URL) {
  console.error('Defina APP_URL (ex.: https://desfrut-ia.onrender.com)');
  process.exit(1);
}

const logger = Pino({ level: 'info' });
let lastQR = null;
let isOpen = false;

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

    if (cleaned.toLowerCase() === 'ping') {
      await sock.sendMessage(from, { text: 'pong ✅' }, { linkPreview: false });
      return;
    }

    const reply = await callIA(cleaned);
    await sock.sendMessage(from, { text: reply }, { linkPreview: false });
  });

  // HTTP para QR e health
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
