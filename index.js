const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://evolutionapi-monitor-n8n.zelwnc.easypanel.host/webhook/evolution-events';
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const API_KEY = process.env.API_KEY || 'presence-baileys-key';

// ── Estado global ────────────────────────────────────────
let sock = null;
let qrCode = null;
let connectionState = 'disconnected'; // disconnected | qr | connected
let subscribedNumbers = new Set();

// ── Logger silencioso ────────────────────────────────────
const logger = pino({ level: 'silent' });

// ── Enviar evento a N8N ──────────────────────────────────
async function sendToN8N(event, data) {
  try {
    await axios.post(N8N_WEBHOOK_URL, {
      event,
      instance: 'presence-baileys',
      data,
      date_time: new Date().toISOString(),
      sender: sock?.user?.id || ''
    }, { timeout: 5000 });
  } catch (err) {
    console.log(`[N8N] Error enviando ${event}:`, err.message);
  }
}

// ── Conectar a WhatsApp ──────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    markOnlineOnConnect: false, // No aparecer en línea al conectar
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // ── QR Code ──────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionState = 'qr';
      console.log('[QR] Nuevo QR generado');
      await sendToN8N('qrcode.updated', { qrcode: { base64: `data:image/png;base64,${Buffer.from(qr).toString('base64')}` } });
    }

    if (connection === 'open') {
      qrCode = null;
      connectionState = 'connected';
      console.log('[WA] Conectado:', sock.user?.id);
      await sendToN8N('connection.update', { state: 'open', wuid: sock.user?.id });

      // Re-suscribir a todos los números guardados
      for (const number of subscribedNumbers) {
        await subscribeToPresence(number);
      }
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log('[WA] Desconectado. Reconectar:', shouldReconnect);
      await sendToN8N('connection.update', { state: 'close' });

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        connectionState = 'disconnected';
        // Limpiar auth si fue logout
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── PRESENCE UPDATE — el evento clave ────────────────
  sock.ev.on('presence.update', async ({ id, presences }) => {
    console.log('[PRESENCE]', id, JSON.stringify(presences));

    const contactNumber = id.split('@')[0];
    const presenceInfo = presences[id] || presences[Object.keys(presences)[0]] || {};
    const lastKnownPresence = presenceInfo.lastKnownPresence || 'unavailable';

    await sendToN8N('presence.update', {
      id: contactNumber,
      presences: {
        [id]: presenceInfo
      }
    });
  });
}

// ── Suscribirse a presencia de un número ─────────────────
async function subscribeToPresence(number) {
  if (!sock || connectionState !== 'connected') return false;
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await sock.presenceSubscribe(jid);
    subscribedNumbers.add(number);
    console.log('[SUBSCRIBE] Suscrito a presencia de:', jid);
    return true;
  } catch (err) {
    console.log('[SUBSCRIBE] Error:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// API REST
// ════════════════════════════════════════════════════════

// Middleware de auth
function authMiddleware(req, res, next) {
  const key = req.headers['apikey'] || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /status — estado de conexión
app.get('/status', authMiddleware, (req, res) => {
  res.json({
    state: connectionState,
    number: sock?.user?.id || null,
    subscribedNumbers: [...subscribedNumbers]
  });
});

// GET /qr — obtener QR actual
app.get('/qr', authMiddleware, (req, res) => {
  if (connectionState === 'connected') {
    return res.json({ state: 'connected', message: 'Ya está conectado' });
  }
  if (!qrCode) {
    return res.json({ state: connectionState, message: 'No hay QR disponible aún' });
  }
  const base64 = `data:image/png;base64,${Buffer.from(qrCode).toString('base64')}`;
  res.json({ state: 'qr', base64 });
});

// POST /subscribe — suscribirse a presencia de un número
app.post('/subscribe', authMiddleware, async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number requerido' });

  const success = await subscribeToPresence(number);
  res.json({ success, number, state: connectionState });
});

// POST /subscribe/bulk — suscribirse a múltiples números
app.post('/subscribe/bulk', authMiddleware, async (req, res) => {
  const { numbers } = req.body;
  if (!numbers || !Array.isArray(numbers)) {
    return res.status(400).json({ error: 'numbers (array) requerido' });
  }

  const results = [];
  for (const number of numbers) {
    const success = await subscribeToPresence(number);
    results.push({ number, success });
    await new Promise(r => setTimeout(r, 500)); // Delay entre suscripciones
  }

  res.json({ results });
});

// POST /disconnect — cerrar sesión
app.post('/disconnect', authMiddleware, async (req, res) => {
  try {
    await sock?.logout();
    connectionState = 'disconnected';
    subscribedNumbers.clear();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// GET /health — health check sin auth
app.get('/health', (req, res) => {
  res.json({ status: 'ok', state: connectionState });
});

// ── Iniciar ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] Escuchando en puerto ${PORT}`);
  connectToWhatsApp();
});
