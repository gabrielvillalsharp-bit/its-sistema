// ── BACKUP AUTOMÁTICO A GITHUB (repositorio privado) ─────────────────────────
// Requiere variables de entorno en Railway:
//   GITHUB_BACKUP_TOKEN  — Personal Access Token con permiso "repo"
//   GITHUB_BACKUP_REPO   — Usuario/repo, ej: gabrielvillalsharp-bit/its-backups
//
// El token se crea en: github.com → Settings → Developer settings →
//   Personal access tokens → Tokens (classic) → Generate new token
//   Permiso necesario: [x] repo (Full control of private repositories)
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');

async function cloudBackupDrive(dbPath) {
  const token  = process.env.GITHUB_BACKUP_TOKEN;
  const repo   = process.env.GITHUB_BACKUP_REPO; // ej: usuario/its-backups
  if (!token || !repo) {
    console.log('[GITHUB-BACKUP] Variables no configuradas — saltando');
    return;
  }
  if (!fs.existsSync(dbPath)) return;

  try {
    const fecha  = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const nombre = `its_backup_${fecha}.db`;
    const contenido = fs.readFileSync(dbPath).toString('base64');
    const url = `https://api.github.com/repos/${repo}/contents/backups/${nombre}`;

    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Backup automático ${fecha}`,
        content: contenido
      })
    });

    if (resp.ok) {
      console.log(`[GITHUB-BACKUP] ✅ Backup subido: backups/${nombre}`);
    } else {
      const err = await resp.json().catch(() => ({}));
      console.error('[GITHUB-BACKUP] ⚠️', resp.status, err.message || '');
    }
  } catch(e) {
    console.error('[GITHUB-BACKUP] ⚠️', e.message);
  }
}

module.exports = { cloudBackupDrive };
