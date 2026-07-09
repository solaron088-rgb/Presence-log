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

// Intervalos sigilosos
const HEARTBEAT_INTERVAL_MS = 15000;  // Latido cada 15s (mantiene el socket vivo)
const PROBE_INTERVAL_MS = 30000;      // Consulta sigilosa cada 30s
const RESUB_INTERVAL_MS = 45000;      // Re-suscripción cada 45s

let sock = null;
let qrString = null;
let connectionState = 'disconnected';
let subscribedNumbers = new Set();
let lastPresenceState = new Map();

// Timers
let heartbeatTimer = null;
let probeTimer = null;
let resubTimer = null;

// Mapeos LID (La clave real del éxito)
let numberToLidMap = new Map();
let lidToNumberMap = new Map();

const logger = pino({ level: 'silent' });

// ============================================
// ENVIAR A N8N
// ============================================
async function sendToN8N(event, data) {
  if (!N8N_WEBHOOK_URL) return;
  try {
    await axios.post(N8N_WEBHOOK_URL, {
      event, instance: 'presence-stealth', data,
      date_time: new Date().toISOString(),
      sender: sock?.user?.id || ''
    }, { timeout: 5000 });
  } catch (err) {
    console.log(`[N8N] Error:`, err.message);
  }
}

// ============================================
// TÉCNICA 1: STEALTH HEARTBEAT (Latido Sigiloso)
// ============================================
// Consultar tu propia foto de perfil genera tráfico WebSocket
// necesario para que WhatsApp no considere la conexión "muerta",
// pero NO te muestra online ni envía nada a nadie.
// ============================================
async function stealthHeartbeat() {
  if (!sock || connectionState !== 'connected') return;
  try {
    // Asegurar que seguimos invisibles
    await sock.sendPresenceUpdate('unavailable');
    
    // Consultar nuestra propia foto de perfil (genera tráfico interno)
    if (sock.profilePictureUrl) {
      await sock.profilePictureUrl(sock.user.id, 'preview').catch(() => {});
    }
  } catch (e) {}
}

// ============================================
// TÉCNICA 2: STEALTH PROBE (Sonda de Estado)
// ============================================
// En lugar de enviar un mensaje, consultamos el ESTADO (Status/Texto)
// del contacto. Esto obliga a WhatsApp a consultar su perfil,
// lo que a menudo dispara un evento de presencia en nuestro socket.
// ES 100% INVISIBLE. No genera notificación ni "escribiendo...".
// ============================================
async function stealthProbe(number) {
  if (!sock || connectionState !== 'connected') return;
  
  const cleanNumber = String(number).replace(/[^0-9]/g, '');
  const jid = `${cleanNumber}@s.whatsapp.net`;
  const lidJid = numberToLidMap.get(cleanNumber);

  try {
    // Consultar el texto de estado (bio) del número
    await sock.fetchStatus(jid).catch(() => {});
    
    // Si tiene LID, también consultamos el LID
    if (lidJid) {
      await sock.fetchStatus(lidJid).catch(() => {});
    }
    
    // También consultamos la foto de perfil (otro read-only que despierta el canal)
    if (sock.profilePictureUrl) {
      await sock.profilePictureUrl(jid, 'preview').catch(() => {});
      if (lidJid) {
        await sock.profilePictureUrl(lidJid, 'preview').catch(() => {});
      }
    }
  } catch (e) {
    // Ignorar errores, es normal si tienen privacidad estricta
  }
}

// ============================================
// RESOLVER JID A NÚMERO
// ============================================
function resolveJidToNumber(jid) {
  if (!jid) return 'unknown';
  if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0];
  
  if (jid.endsWith('@lid')) {
    // Búsqueda exacta
    if (lidToNumberMap.has(jid)) return lidToNumberMap.get(jid);
    
    // Búsqueda parcial (a veces el JID viene con prefijos extra)
    const lidPart = jid.replace('@lid', '');
    for (const [lid, num] of lidToNumberMap.entries()) {
      if (lid.includes(lidPart)) return num;
    }
    return jid; // Si no encuentra, devuelve el LID
  }
  return jid.split('@')[0];
}

// ============================================
// SUSCRIBIRSE (NÚMERO + LID)
// ============================================
async function subscribeToPresence(number) {
  if (!sock || connectionState !== 'connected') return false;
  
  try {
    const cleanNumber = String(number).replace(/[^0-9]/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    
    // 1. Pedir info del número (aquí obtenemos el LID)
    const [info] = await sock.onWhatsApp(jid);
    if (!info?.exists) return false;
    
    let lidJid = null;
    if (info?.lid) {
      lidJid = info.lid;
      numberToLidMap.set(cleanNumber, lidJid);
      lidToNumberMap.set(lidJid, cleanNumber);
      console.log(`[MAP] LID Detectado: ${cleanNumber} ↔ ${lidJid}`);
    }
    
    // 2. Suscribirse al NÚMERO
    await sock.presenceSubscribe(jid);
    
    // 3. Suscribirse al LID (OBLIGATORIO: WhatsApp usa el LID para enviar el evento)
    if (lidJid) {
      await new Promise(r => setTimeout(r, 200));
      await sock.presenceSubscribe(lidJid);
    }
    
    subscribedNumbers.add(cleanNumber);
    console.log(`[SUB] Vigilando a: ${cleanNumber}`);
    return true;
    
  } catch (err) {
    console.log('[SUB] Error:', err.message);
    return false;
  }
}

// ============================================
// PROCESAR EVENTO DE PRESENCIA
// ============================================
async function processPresenceEvent(id, presences) {
  if (!id || !presences) return;
  
  let presenceInfo = presences[id];
  if (!presenceInfo) {
    const keys = Object.keys(presences);
    if (keys.length > 0) {
      id = keys[0];
      presenceInfo = presences[id];
    }
  }
  
  if (!presenceInfo) return;
  
  const contactNumber = resolveJidToNumber(id);
  const newState = presenceInfo.lastKnownPresence || presenceInfo.type || 'unknown';
  const lastSeen = presenceInfo.lastSeen || null;
  
  const prevState = lastPresenceState.get(contactNumber);
  
  // Filtrar duplicados exactos
  if (prevState === newState && !lastSeen) return;
  
  lastPresenceState.set(contactNumber, newState);
  
  const stateText = newState === 'available' ? '🟢 EN LÍNEA' : 
                    newState === 'unavailable' ? '🔴 DESCONECTADO' : 
                    `⚪ ${newState}`;
  
  console.log(`\n[!] EVENTO DETECTADO: ${contactNumber}`);
  console.log(`    Estado: ${stateText}`);
  console.log(`    Anterior: ${prevState || 'Desconocido'}`);
  if (lastSeen) console.log(`    Últ. vez: ${new Date(lastSeen * 1000).toLocaleString()}`);
  
  await sendToN8N('presence.update', {
    id: contactNumber,
    originalJid: id,
    state: newState,
    stateText: stateText,
    lastSeen: lastSeen ? new Date(lastSeen * 1000).toISOString() : null,
    previousState: prevState || 'unknown',
    timestamp: Date.now()
  });
}

// ============================================
// LOOPS DE FONDO
// ============================================
function startLoops() {
  if (heartbeatTimer) return;
  
  console.log('[LOOPS] Iniciando sistema sigiloso...');
  
  // Loop 1: Latido (Mantener socket vivo sin aparecer online)
  heartbeatTimer = setInterval(stealthHeartbeat, HEARTBEAT_INTERVAL_MS);
  
  // Loop 2: Sonda (Consultar status/foto para forzar detección)
  probeTimer = setInterval(async () => {
    if (connectionState !== 'connected' || subscribedNumbers.size === 0) return;
    
    for (const number of subscribedNumbers) {
      await stealthProbe(number);
      await new Promise(r => setTimeout(r, 300)); // Pausa para no hacer spam
    }
  }, PROBE_INTERVAL_MS);
  
  // Loop 3: Re-suscripción (Renovar la petición de presencia)
  resubTimer = setInterval(async () => {
    if (connectionState !== 'connected' || subscribedNumbers.size === 0) return;
    
    for (const number of subscribedNumbers) {
      const jid = `${number}@s.whatsapp.net`;
      const lidJid = numberToLidMap.get(number);
      
      try {
        await sock.presenceSubscribe(jid);
        if (lidJid) await sock.presenceSubscribe(lidJid);
      } catch (e) {}
      
      await new Promise(r => setTimeout(r, 200));
    }
  }, RESUB_INTERVAL_MS);
}

function stopLoops() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  if (resubTimer) { clearInterval(resubTimer); resubTimer = null; }
}

// ============================================
// CONEXIÓN A WHATSAPP
// ============================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    markOnlineOnConnect: false, // CLAVE: No aparecer online
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      connectionState = 'qr';
      try {
        const base64 = await QRCode.toDataURL(qr);
        await sendToN8N('qrcode.updated', { qrcode: { base64 } });
      } catch (e) {}
    }

    if (connection === 'open') {
      qrString = null;
      connectionState = 'connected';
      console.log('\n========================================');
      console.log(`  ✓ MODO SIGILOSO ACTIVADO`);
      console.log(`  Sesión: ${sock.user?.id}`);
      console.log('========================================\n');
      
      await sendToN8N('connection.update', { state: 'open', wuid: sock.user?.id });

      await new Promise(r => setTimeout(r, 1000));
      await sock.sendPresenceUpdate('unavailable');
      
      // Re-suscribir a conocidos
      for (const number of subscribedNumbers) {
        await subscribeToPresence(number);
        await new Promise(r => setTimeout(r, 300));
      }
      
      // Iniciar loops invisibles
      startLoops();
    }

    if (connection === 'close') {
      connectionState = 'disconnected';
      stopLoops();
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true;
      
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
      else if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // CAPTURA DE PRESENCIA
  // ============================================
  sock.ev.on('presence.update', async (eventData) => {
    // Log crudo para que veas qué llega exactamente
    console.log('[RAW-DATA]', JSON.stringify(eventData));
    
    if (eventData?.id && eventData?.presences) {
      await processPresenceEvent(eventData.id, eventData.presences);
    } else if (Array.isArray(eventData)) {
      for (const item of eventData) {
        if (item?.id && item?.presences) await processPresenceEvent(item.id, item.presences);
      }
    } else if (eventData && typeof eventData === 'object') {
      for (const key of Object.keys(eventData)) {
        if (typeof eventData[key] === 'object') await processPresenceEvent(key, eventData[key]);
      }
    }
  });
}

// ============================================
// ENDPOINTS
// ============================================
function authMiddleware(req, res, next) {
  const key = req.headers['apikey'] || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/qr-page', (req, res) => {
  if (connectionState === 'connected') {
    return res.send(`<html><body style="background:#0B1120;color:#22D67A;font-family:sans-serif;text-align:center;padding:50px">
      <h1>✓ Sigiloso Activado</h1><p>Número: ${sock?.user?.id}</p>
      <p>Vigilando: ${subscribedNumbers.size} contactos</p>
      <p style="color:#666;font-size:12px">No apareces en línea. No dejas rastro.</p>
    </body></html>`);
  }
  res.send(`<html><head><meta charset="utf-8"><title>QR</title>
  <meta http-equiv="refresh" content="10"><style>body{background:#0B1120;color:#E7EAF2;font-family:sans-serif;text-align:center;padding:40px}h1{color:#22D67A}img{border:8px solid white;border-radius:12px;margin:20px}</style></head>
  <body><h1>Monitor Sigiloso</h1><p>Escanea QR</p><img src="/qr-image" width="280" height="280"><p>Estado: ${connectionState}</p></body></html>`);
});

app.get('/qr-image', async (req, res) => {
  if (!qrString) return res.status(404).send('Sin QR');
  const buffer = await QRCode.toBuffer(qrString, { width: 280, margin: 2 });
  res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-cache'); res.send(buffer);
});

app.get('/health', (req, res) => res.json({ state: connectionState, active: !!heartbeatTimer, monitored: subscribedNumbers.size }));

app.get('/status', authMiddleware, (req, res) => {
  res.json({ 
    state: connectionState, number: sock?.user?.id, 
    subscribed: [...subscribedNumbers],
    lids: Object.fromEntries(lidToNumberMap),
    lastStates: Object.fromEntries(lastPresenceState)
  });
});

app.post('/subscribe', authMiddleware, async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number requerido' });
  const clean = String(number).replace(/[^0-9]/g, '');
  const success = await subscribeToPresence(clean);
  res.json({ success, number: clean, lid: numberToLidMap.get(clean) || null });
});

app.post('/subscribe/bulk', authMiddleware, async (req, res) => {
  const { numbers } = req.body;
  if (!Array.isArray(numbers)) return res.status(400).json({ error: 'array requerido' });
  const results = [];
  for (const n of numbers) {
    const clean = String(n).replace(/[^0-9]/g, '');
    results.push({ number: clean, success: await subscribeToPresence(clean), lid: numberToLidMap.get(clean) || null });
    await new Promise(r => setTimeout(r, 500));
  }
  res.json({ results });
});

app.post('/disconnect', authMiddleware, async (req, res) => {
  stopLoops(); await sock?.logout(); connectionState = 'disconnected';
  subscribedNumbers.clear(); numberToLidMap.clear(); lidToNumberMap.clear(); lastPresenceState.clear();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Modo Sigiloso en puerto ${PORT}`);
  connectToWhatsApp();
});
