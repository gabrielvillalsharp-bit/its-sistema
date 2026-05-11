// ── WHATSAPP VIA BAILEYS ──────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

// Node 18 no expone crypto globalmente — requerido por Baileys v7
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'wa_auth')
  : path.join(__dirname, '../data/wa_auth');

let sock        = null;
let estado      = 'desconectado';
let ultimoError = null;
let _reconnTimer = null;
let _baileys    = null; // cache del módulo

async function loadBaileys() {
  if (_baileys) return _baileys;
  const B = await import('@whiskeysockets/baileys');

  const makeWASocket =
    (typeof B.makeWASocket === 'function' ? B.makeWASocket : null) ??
    (typeof B.default === 'function'      ? B.default      : null) ??
    B.default?.makeWASocket;

  if (typeof makeWASocket !== 'function') {
    throw new Error('makeWASocket no encontrado. Exports: ' + Object.keys(B).join(', '));
  }

  // Browsers helper — disponible en v6, puede no estar en v7
  const Browsers = B.Browsers ?? null;

  _baileys = {
    makeWASocket,
    Browsers,
    useMultiFileAuthState:       B.useMultiFileAuthState,
    DisconnectReason:            B.DisconnectReason,
    fetchLatestBaileysVersion:   B.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: B.makeCacheableSignalKeyStore,
  };
  return _baileys;
}

// ── Conectar ──────────────────────────────────────────────────────────────────
async function conectar(telefono) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const {
    makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore
  } = await loadBaileys();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  estado      = 'conectando';
  ultimoError = null;

  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });

  // Usar Browsers.ubuntu si está disponible (mejor compatibilidad con pairing code)
  const browserConfig = Browsers
    ? Browsers.ubuntu('Chrome')
    : ['Ubuntu', 'Chrome', '22.0.0.0'];

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser:              browserConfig,
    markOnlineOnConnect:  false,
    keepAliveIntervalMs:  15000,
    connectTimeoutMs:     60000,
    defaultQueryTimeoutMs: 60000,
  });

  // ── Pairing code ─────────────────────────────────────────────────────────
  let codigoPairing = null;
  if (!state.creds.registered && telefono) {
    const num = String(telefono).replace(/[^0-9]/g, '');
    console.log(`[WhatsApp] Solicitando pairing code para ${num}...`);

    // Esperar exactamente a que el socket esté en estado 'connecting'
    // (después del handshake de ruido pero antes de autenticar)
    await new Promise(resolve => {
      let resolved = false;
      sock.ev.on('connection.update', ({ connection }) => {
        if (!resolved && (connection === 'connecting' || connection === 'open')) {
          resolved = true;
          resolve();
        }
      });
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 3000);
    });

    try {
      codigoPairing = await sock.requestPairingCode(num);
      console.log(`[WhatsApp] ✅ Pairing code: ${codigoPairing}`);
    } catch (e) {
      console.error('[WhatsApp] Error pairing code:', e.message);
      ultimoError = 'Error: ' + e.message;
    }
  }

  // ── Eventos ───────────────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      estado      = 'conectado';
      ultimoError = null;
      if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
      console.log('[WhatsApp] ✅ Conectado');

    } else if (connection === 'close') {
      estado = 'desconectado';
      const code  = lastDisconnect?.error?.output?.statusCode;
      const razon = lastDisconnect?.error?.message || 'desconocido';

      if (code === DisconnectReason.loggedOut) {
        console.log('[WhatsApp] Sesión cerrada desde el teléfono');
        borrarSesion();
      } else {
        ultimoError = `Desconectado (${code ?? razon}) — reconectando en 15s`;
        console.warn('[WhatsApp]', ultimoError);
        _reconnTimer = setTimeout(() => conectar(), 15000);
      }
    }
  });

  return codigoPairing;
}

// ── Enviar mensaje ────────────────────────────────────────────────────────────
async function enviarMensaje(numero, texto) {
  if (!sock || estado !== 'conectado') throw new Error('WhatsApp no está conectado');
  let num = String(numero).replace(/[^0-9]/g, '');
  if (!num.startsWith('595') && num.length <= 10) num = '595' + num;
  await sock.sendMessage(num + '@s.whatsapp.net', { text: texto });
  console.log(`[WhatsApp] Mensaje enviado a ${num}`);
}

// ── Desconectar ───────────────────────────────────────────────────────────────
async function desconectar() {
  if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
  try { if (sock) await sock.logout(); } catch {}
  sock   = null;
  estado = 'desconectado';
  borrarSesion();
}

function borrarSesion() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
}

function getEstado() {
  return {
    estado,
    conectado:    estado === 'conectado',
    error:        ultimoError,
    tiene_sesion: fs.existsSync(path.join(AUTH_DIR, 'creds.json')),
  };
}

function autoConectar() {
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log('[WhatsApp] Sesión guardada — reconectando...');
    conectar().catch(e => console.error('[WhatsApp] Auto-conectar error:', e.message));
  }
}

module.exports = { conectar, enviarMensaje, desconectar, getEstado, autoConectar };
