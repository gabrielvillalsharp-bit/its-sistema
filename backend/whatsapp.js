if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const path = require('path');
const fs   = require('fs');

const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'wa_auth')
  : path.join(__dirname, '../data/wa_auth');

let sock        = null;
let estado      = 'desconectado';
let ultimoError = null;
let _reconnTimer = null;
let _qrActual   = null;   // QR string actual para mostrar en el panel
let _baileys    = null;

async function loadBaileys() {
  if (_baileys) return _baileys;
  const B = await import('baileys');
  const makeWASocket =
    (typeof B.makeWASocket === 'function' ? B.makeWASocket : null) ??
    (typeof B.default === 'function'      ? B.default      : null) ??
    B.default?.makeWASocket;
  if (typeof makeWASocket !== 'function')
    throw new Error('makeWASocket no encontrado. Exports: ' + Object.keys(B).join(', '));
  _baileys = {
    makeWASocket,
    Browsers:                    B.Browsers ?? null,
    useMultiFileAuthState:       B.useMultiFileAuthState,
    DisconnectReason:            B.DisconnectReason,
    fetchLatestBaileysVersion:   B.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: B.makeCacheableSignalKeyStore,
  };
  return _baileys;
}

async function conectar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const {
    makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore
  } = await loadBaileys();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  estado      = 'conectando';
  ultimoError = null;
  _qrActual   = null;

  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.0.0.0'],
    markOnlineOnConnect:   false,
    keepAliveIntervalMs:   15000,
    connectTimeoutMs:      60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      _qrActual = qr;
      console.log('[WhatsApp] QR generado — esperando escaneo');
    }

    if (connection === 'open') {
      estado      = 'conectado';
      ultimoError = null;
      _qrActual   = null;
      if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
      console.log('[WhatsApp] ✅ Conectado');
    }

    if (connection === 'close') {
      estado    = 'desconectado';
      _qrActual = null;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const razon = lastDisconnect?.error?.message || 'desconocido';

      if (code === DisconnectReason.loggedOut) {
        console.log('[WhatsApp] Logout desde el teléfono');
        borrarSesion();
      } else {
        ultimoError = `Desconectado (${code ?? razon}) — reconectando en 15s`;
        console.warn('[WhatsApp]', ultimoError);
        _reconnTimer = setTimeout(() => conectar(), 15000);
      }
    }
  });
}

async function enviarMensaje(numero, texto) {
  if (!sock || estado !== 'conectado') throw new Error('WhatsApp no está conectado');
  let num = String(numero).replace(/[^0-9]/g, '');
  if (!num.startsWith('595') && num.length <= 10) num = '595' + num;
  await sock.sendMessage(num + '@s.whatsapp.net', { text: texto });
  console.log(`[WhatsApp] Enviado a ${num}`);
}

async function desconectar() {
  if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
  try { if (sock) await sock.logout(); } catch {}
  sock    = null;
  estado  = 'desconectado';
  _qrActual = null;
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
    qr:           _qrActual,
  };
}

function autoConectar() {
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log('[WhatsApp] Sesión guardada — reconectando...');
    conectar().catch(e => console.error('[WhatsApp] Auto-conectar:', e.message));
  }
}

module.exports = { conectar, enviarMensaje, desconectar, getEstado, autoConectar };
