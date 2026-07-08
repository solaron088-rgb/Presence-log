const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const API_KEY = process.env.API_KEY || 'presence-baileys-key';

// Cada cuanto se refresca la suscripcion de presencia (en minutos).
// La suscripcion de WhatsApp expira sola despues de unos minutos, por eso
// hay que renovarla periodicamente para los numeros que queremos monitorear.
const RESUBSCRIBE_INTERVAL_MINUTES = 4;

let sock = null;
let qrString = null;
let connectionState = 'disconnected';
let subscribedNumbers = new Set();
let resubscribeTimer = null;

// Mapa LID -> numero de telefono. WhatsApp identifica a algunos contactos
// con un "@lid" (Linked ID) en vez del numero real por privacidad. Lo
// capturamos aqui en el momento de suscribirnos, cuando SI sabemos con
// certeza a que numero corresponde.
let lidToNumberMap = new Map();

const logger = pino({ level: 'silent' });

async function sendToN8N(event, data) {
  if (!N8N_WEBHOOK_URL) return;
  try {
    await axios.post(N8N_WEBHOOK_URL, {
      event, instance: 'presence-baileys', data,
      date_time: new Date().toISOString(),
      sender: sock?.user?.id || ''
    }, { timeout: 5000 });
  } catch (err) {
    console.log(`[N8N] Error enviando ${event}:`, err.message);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      connectionState = 'qr';
      console.log('[QR] Nuevo QR generado');
      try {
        const base64 = await QRCode.toDataURL(qr);
        await sendToN8N('qrcode.updated', { qrcode: { base64 } });
      } catch (e) {}
    }

    if (connection === 'open') {
      qrString = null;
      connectionState = 'connected';
      console.log('[WA] Conectado:', sock.user?.id);
      await sendToN8N('connection.update', { state: 'open', wuid: sock.user?.id });

      // Nos marcamos como "no disponible" apenas conectamos, para no
      // aparecer en linea ante nuestros contactos solo por tener el
      // servicio corriendo en el servidor.
      try {
        await sock.sendPresenceUpdate('unavailable');
        console.log('[PRESENCE] Marcado como unavailable al conectar');
      } catch (e) {
        console.log('[PRESENCE] Error marcando unavailable:', e.message);
      }

      // (Re)suscribimos a todos los numeros conocidos al reconectar
      for (const number of subscribedNumbers) await subscribeToPresence(number);

      // Arrancamos el refresco periodico de suscripcion (si no estaba ya corriendo)
      startResubscribeLoop();
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      stopResubscribeLoop();
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true;
      console.log('[WA] Desconectado. Reconectar:', shouldReconnect);
      await sendToN8N('connection.update', { state: 'close' });
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('presence.update', async ({ id, presences }) => {
    console.log('[PRESENCE]', id, JSON.stringify(presences));

    let contactNumber = id.split('@')[0];

    // Si WhatsApp nos dio un @lid en vez del numero real, intentamos
    // traducirlo usando el mapa que armamos al suscribirnos, y si no,
    // preguntandole directamente a Baileys.
    if (id.endsWith('@lid')) {
      if (lidToNumberMap.has(id)) {
        contactNumber = lidToNumberMap.get(id);
        console.log('[LID] Resuelto desde mapa local:', id, '->', contactNumber);
      } else {
        console.log('[LID] no esta en el mapa local. signalRepository disponible:', !!sock.signalRepository, '| lidMapping disponible:', !!sock.signalRepository?.lidMapping, '| getPNForLID disponible:', typeof sock.signalRepository?.lidMapping?.getPNForLID);
        if (sock.signalRepository?.lidMapping?.getPNForLID) {
          try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(id);
            console.log('[DEBUG getPNForLID]', id, '->', pn);
            if (pn) {
              contactNumber = pn.split('@')[0];
              lidToNumberMap.set(id, contactNumber);
              console.log('[LID] Resuelto por signalRepository:', id, '->', contactNumber);
            } else {
              console.log('[LID] No se pudo resolver (getPNForLID devolvio vacio):', id);
            }
          } catch (e) {
            console.log('[LID] Error resolviendo:', e.message);
          }
        }
      }
    }

    const presenceInfo = presences[id] || presences[Object.keys(presences)[0]] || {};
    await sendToN8N('presence.update', { id: contactNumber, presences: { [id]: presenceInfo } });
  });
}

async function subscribeToPresence(number) {
  if (!sock || connectionState !== 'connected') return false;
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    // Intentamos obtener el LID asociado a este numero ANTES de suscribirnos,
    // porque en este momento sabemos con certeza el numero real detras de el.
    try {
      const results = await sock.onWhatsApp(jid);
      console.log('[DEBUG onWhatsApp]', number, '->', JSON.stringify(results));
      const info = results?.[0];
      if (info?.lid) {
        lidToNumberMap.set(info.lid, number);
        console.log(`[LID] Mapeado ${info.lid} -> ${number}`);
      } else {
        console.log(`[LID] onWhatsApp no devolvio campo lid para ${number}`);
      }
    } catch (e) {
      console.log('[LID] No se pudo obtener lid para', number, ':', e.message);
    }

    await sock.presenceSubscribe(jid);
    subscribedNumbers.add(number);
    console.log('[SUBSCRIBE] Suscrito a:', jid);
    return true;
  } catch (err) {
    console.log('[SUBSCRIBE] Error:', err.message);
    return false;
  }
}

// Vuelve a suscribirse a todos los numeros conocidos cada X minutos,
// porque la suscripcion de presencia en WhatsApp expira sola.
function startResubscribeLoop() {
  if (resubscribeTimer) return; // ya esta corriendo
  resubscribeTimer = setInterval(async () => {
    if (connectionState !== 'connected') return;

    // Refrescamos tambien nuestro propio estado "no disponible", por si
    // WhatsApp lo resetea solo despues de un rato.
    try {
      await sock.sendPresenceUpdate('unavailable');
    } catch (e) {}

    if (subscribedNumbers.size === 0) return;
    console.log(`[RESUBSCRIBE] Refrescando ${subscribedNumbers.size} suscripciones...`);
    for (const number of subscribedNumbers) {
      await subscribeToPresence(number);
      await new Promise(r => setTimeout(r, 400));
    }
  }, RESUBSCRIBE_INTERVAL_MINUTES * 60 * 1000);
}

function stopResubscribeLoop() {
  if (resubscribeTimer) {
    clearInterval(resubscribeTimer);
    resubscribeTimer = null;
  }
}

function authMiddleware(req, res, next) {
  const key = req.headers['apikey'] || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Pagina web con QR que se refresca automaticamente
app.get('/qr-page', (req, res) => {
  if (connectionState === 'connected') {
    return res.send('<html><body style="background:#0B1120;color:#22D67A;font-family:sans-serif;text-align:center;padding:50px"><h1>&#10003; WhatsApp Conectado</h1><p>La sesion esta activa. Puedes cerrar esta pagina.</p></body></html>');
  }
  res.send(`<html>
<head><meta charset="utf-8"><title>Escanear QR</title>
<meta http-equiv="refresh" content="20">
<style>body{background:#0B1120;color:#E7EAF2;font-family:sans-serif;text-align:center;padding:40px}
h1{color:#22D67A}img{border:8px solid white;border-radius:12px;margin:20px}
p{color:#6B7494}</style></head>
<body>
<h1>Monitor de Presencia</h1>
<p>Escanea este codigo QR desde WhatsApp &rarr; Dispositivos vinculados</p>
<img id="qr" src="/qr-image" width="280" height="280" alt="QR Code">
<p>Estado: <strong style="color:#F0A830">${connectionState}</strong></p>
<p>Esta pagina se refresca automaticamente cada 20 segundos</p>
</body></html>`);
});

// Endpoint que devuelve el QR como imagen PNG directa
app.get('/qr-image', async (req, res) => {
  if (!qrString) {
    return res.status(404).send('No QR disponible');
  }
  try {
    const buffer = await QRCode.toBuffer(qrString, { width: 280, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (e) {
    res.status(500).send('Error generando QR');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', state: connectionState }));

app.get('/status', authMiddleware, (req, res) => {
  res.json({ state: connectionState, number: sock?.user?.id || null, subscribedNumbers: [...subscribedNumbers] });
});

app.get('/qr', authMiddleware, async (req, res) => {
  if (connectionState === 'connected') return res.json({ state: 'connected' });
  if (!qrString) return res.json({ state: connectionState, message: 'No hay QR aun' });
  try {
    const base64 = await QRCode.toDataURL(qrString);
    res.json({ state: 'qr', base64 });
  } catch (e) {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

app.post('/subscribe', authMiddleware, async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number requerido' });
  const success = await subscribeToPresence(number);
  res.json({ success, number, state: connectionState });
});

app.post('/subscribe/bulk', authMiddleware, async (req, res) => {
  const { numbers } = req.body;
  if (!numbers || !Array.isArray(numbers)) return res.status(400).json({ error: 'numbers array requerido' });
  const results = [];
  for (const number of numbers) {
    const success = await subscribeToPresence(number);
    results.push({ number, success });
    await new Promise(r => setTimeout(r, 500));
  }
  res.json({ results });
});

// Marca tu propia cuenta como "no disponible" manualmente, por si acaso.
app.post('/set-unavailable', authMiddleware, async (req, res) => {
  try {
    await sock?.sendPresenceUpdate('unavailable');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/disconnect', authMiddleware, async (req, res) => {
  try {
    await sock?.logout();
    connectionState = 'disconnected';
    subscribedNumbers.clear();
    stopResubscribeLoop();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[SERVER] Escuchando en puerto ${PORT}`);
  connectToWhatsApp();
});
