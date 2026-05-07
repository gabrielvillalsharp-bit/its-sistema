// ── BACKUP AUTOMÁTICO A GOOGLE DRIVE ─────────────────────────────────────────
// Requiere variables de entorno en Railway:
//   GOOGLE_SERVICE_ACCOUNT_JSON — JSON de cuenta de servicio (base64)
//   GOOGLE_DRIVE_FOLDER_ID      — ID de la carpeta en Google Drive
//
// Configuración:
//   1. Crear proyecto en console.cloud.google.com
//   2. Habilitar Google Drive API
//   3. Crear cuenta de servicio → descargar JSON
//   4. Codificar: base64 -i service-account.json | tr -d '\n'
//   5. Compartir carpeta de Drive con el email de la cuenta de servicio
//   6. Copiar el ID de la carpeta (último segmento de la URL de Drive)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

async function cloudBackupDrive(dbPath) {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!serviceAccountJson || !folderId) return; // No configurado — saltar silenciosamente

  let google;
  try { ({ google } = require('googleapis')); }
  catch { console.error('[CLOUD-BACKUP] googleapis no instalado'); return; }

  try {
    const creds = JSON.parse(Buffer.from(serviceAccountJson, 'base64').toString('utf-8'));
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    const drive = google.drive({ version: 'v3', auth });

    const fecha = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const nombre = `its_backup_${fecha}.db`;

    // Subir archivo
    await drive.files.create({
      requestBody: { name: nombre, parents: [folderId] },
      media: {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(dbPath)
      }
    });
    console.log(`[CLOUD-BACKUP] ✅ Backup subido a Google Drive: ${nombre}`);

    // Mantener solo las últimas 10 copias — borrar las más viejas
    const lista = await drive.files.list({
      q: `'${folderId}' in parents and name contains 'its_backup' and trashed=false`,
      orderBy: 'createdTime desc',
      fields: 'files(id,name)',
      pageSize: 100
    });
    const archivos = lista.data.files || [];
    for (const viejo of archivos.slice(10)) {
      await drive.files.delete({ fileId: viejo.id }).catch(() => {});
    }
  } catch(e) {
    console.error('[CLOUD-BACKUP] ⚠️  Error al subir a Google Drive:', e.message);
  }
}

module.exports = { cloudBackupDrive };
