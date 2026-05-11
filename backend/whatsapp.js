// ── WHATSAPP VIA BAILEYS ──────────────────────────────────────────────────────
// Conexión sin navegador (WebSocket directo). Sesión persistida en Railway Volume.
// Pairing code en vez de QR → funciona sin pantalla/terminal interactiva.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');

// Directorio donde se guarda la sesión (persiste en el Volume de Railway)
const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'wa_auth')
  : path.join(__dirname, '../data/wa_auth');

let sock        = null;
let estado      = 'desconectado'; // desconectado | conectando | conectado
let ultimoError = null;
let _reconnTimer = null;

// ── Cargar Baileys (ESM) mediante dynamic import ─────────────────────────────
async function loadBaileys() {
  const B = await import('@whiskeysockets/baileys');
  return {
    makeWASocket:              B.default ?? B.makeWASocket,
    useMultiFileAuthState:     B.useMultiFileAuthState,
    DisconnectReason:          B.DisconnectReason,
    fetchLatestBaileysVersion: B.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: B.makeCacheableSignalKeyStore,
  };
}

// ── Conectar / obtener pairing code ──────────────────────────────────────────
async function conectar(telefono) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const {
    makeWASocket, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore
  } = await loadBaileys();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  estado      = 'conectando';
  ultimoError = null;

  // Logger silencioso para no contaminar los logs del servidor
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
    browser: ['ITS Sistema', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
  });

  // ── Pairing code (solo si no hay sesión previa y se pasa teléfono) ─────────
  let codigoPairing = null;
  if (!state.creds.registered && telefono) {
    const num = String(telefono).replace(/[^0-9]/g, '');
    // Dar 2s para que el socket se inicialice antes de pedir el código
    await new Promise(r => setTimeout(r, 2000));
    try {
      codigoPairing = await sock.requestPairingCode(num);
      console.log(`[WhatsApp] Pairing code generado: ${codigoPairing}`);
    } catch (e) {
      ultimoError = 'Error al generar pairing code: ' + e.message;
      console.error('[WhatsApp]', ultimoError);
    }
  }

  // ── Eventos ───────────────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      estado      = 'conectado';
      ultimoError = null;
      if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
      console.log('[WhatsApp] ✅ Conectado correctamente');

    } else if (connection === 'close') {
      estado = 'desconectado';
      const code = lastDisconnect?.error?.output?.statusCode;
      const razon = lastDisconnect?.error?.message || 'desconocido';

      if (code === DisconnectReason.loggedOut) {
        // Sesión revocada desde el teléfono → borrar auth
        console.log('[WhatsApp] Sesión cerrada (logout desde teléfono)');
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

// ── Enviar mensaje de texto ───────────────────────────────────────────────────
async function enviarMensaje(numero, texto) {
  if (!sock || estado !== 'conectado') {
    throw new Error('WhatsApp no está conectado');
  }
  // Normalizar número: agregar 595 (Paraguay) si no empieza con código de país
  let num = String(numero).replace(/[^0-9]/g, '');
  if (!num.startsWith('595') && num.length <= 10) num = '595' + num;
  const jid = num + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: texto });
  console.log(`[WhatsApp] Mensaje enviado a ${num}`);
}

// ── Desconectar y borrar sesión ───────────────────────────────────────────────
async function desconectar() {
  if (_reconnTimer) { clearTimeout(_reconnTimer); _reconnTimer = null; }
  try { if (sock) await sock.logout(); } catch {}
  sock   = null;
  estado = 'desconectado';
  borrarSesion();
  console.log('[WhatsApp] Sesión cerrada y borrada');
}

function borrarSesion() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
}

// ── Estado actual ─────────────────────────────────────────────────────────────
function getEstado() {
  return {
    estado,
    conectado:   estado === 'conectado',
    error:       ultimoError,
    tiene_sesion: fs.existsSync(path.join(AUTH_DIR, 'creds.json')),
  };
}

// ── Auto-conectar al iniciar si hay sesión guardada ───────────────────────────
function autoConectar() {
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    console.log('[WhatsApp] Sesión guardada encontrada — reconectando...');
    conectar().catch(e => console.error('[WhatsApp] Error al auto-conectar:', e.message));
  } else {
    console.log('[WhatsApp] Sin sesión previa — esperando pairing code');
  }
}

module.exports = { conectar, enviarMensaje, desconectar, getEstado, autoConectar };
