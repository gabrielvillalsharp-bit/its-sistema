if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const path = require('path');
const fs   = require('fs');
const { exec } = require('child_process');

const AUTH_DIR = path.join(__dirname, 'wa_auth_local');
const QR_FILE  = path.join(__dirname, 'qr.html');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

(async () => {
  console.log('Cargando Baileys...');
  const B = await import('baileys');

  const makeWASocket =
    (typeof B.makeWASocket === 'function' ? B.makeWASocket : null) ??
    (typeof B.default === 'function'      ? B.default      : null) ??
    B.default?.makeWASocket;

  const { useMultiFileAuthState, fetchLatestBaileysVersion,
          makeCacheableSignalKeyStore, Browsers } = B;

  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });

  // Versión fija conocida que funciona — no usar fetchLatestBaileysVersion (puede fallar con RC)
  const version = [2, 3000, 1023141582];
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  console.log('Conectando a WhatsApp (version ' + version.join('.') + ')...');

  const sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    browser: ['Windows', 'Chrome', '124.0.0'],
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 15000,
    connectTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {

    if (qr) {
      // Generar HTML con QR usando API publica
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WhatsApp QR</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0fdf4}
h2{color:#166534}p{color:#555;font-size:14px}img{border:8px solid #25D366;border-radius:12px}</style>
</head><body>
<h2>📱 Vincular WhatsApp — ITS Sistema</h2>
<img src="${qrUrl}" width="300" height="300"><br><br>
<p><strong>Abrí WhatsApp en tu celular</strong></p>
<p>⋮ Menú → Dispositivos vinculados → Vincular dispositivo → Apuntá la cámara aquí</p>
<p style="color:#ef4444;font-weight:bold">⏱ El QR expira en 60 segundos — si expira, corré node par.js de nuevo</p>
</body></html>`;
      fs.writeFileSync(QR_FILE, html);
      exec('start "" "' + QR_FILE + '"');
      console.log('\n✅ Se abrio el QR en tu navegador. Escanealo con WhatsApp.\n');
    }

    if (connection === 'open') {
      console.log('\n✅ VINCULADO CORRECTAMENTE!');
      console.log('Sesion guardada en: ' + AUTH_DIR);
      console.log('\nAvisale a Claude para subir la sesion a Railway.\n');
      // Limpiar QR
      try { fs.unlinkSync(QR_FILE); } catch {}
      setTimeout(() => process.exit(0), 1000);
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error?.message || '';
      console.log('Conexion cerrada:', err || 'sin detalle');
    }
  });

})().catch(e => { console.error('Error:', e.message); process.exit(1); });
