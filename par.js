// ── VINCULAR WHATSAPP LOCALMENTE ──────────────────────────────────────────────
// Correlo UNA VEZ en tu PC: node par.js
// Escanea el QR con WhatsApp → guarda la sesión en ./wa_auth_local/
// Luego subís esa carpeta a Railway con el script upload que aparece al final.
// ─────────────────────────────────────────────────────────────────────────────
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

const path = require('path');
const fs   = require('fs');
const AUTH_DIR = path.join(__dirname, 'wa_auth_local');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

(async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  VINCULAR WHATSAPP — ITS Sistema         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });

  const {
    makeWASocket, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: true,   // ← muestra el QR en la terminal
    logger,
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu','Chrome','22.0.0.0'],
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 15000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('\n📱 Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo');
      console.log('   Escaneá el código QR de arriba\n');
    }

    if (connection === 'open') {
      console.log('\n✅ ¡VINCULADO CORRECTAMENTE!\n');
      console.log('La sesión se guardó en: ' + AUTH_DIR);
      console.log('\n─────────────────────────────────────────────');
      console.log('PRÓXIMO PASO: subir la sesión a Railway');
      console.log('─────────────────────────────────────────────');
      console.log('1. Instalá Railway CLI:  npm install -g @railway/cli');
      console.log('2. Iniciá sesión:        railway login');
      console.log('3. Entrá al proyecto:    railway link');
      console.log('4. Subí la sesión:       railway volume cp ./wa_auth_local /data/wa_auth');
      console.log('─────────────────────────────────────────────\n');
      setTimeout(() => process.exit(0), 3000);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...');
        // No reconectar automáticamente en el script local
      }
    }
  });
})();
