// ── LIMPIEZA DE PESO DE LA BASE (2026-10-19) ─────────────────────────────────────────────────────────────────────
// La base llegó a ~500 MB por archivos guardados como BLOB. Esta limpieza (a pedido del director, con archivo de seguridad
// de los adjuntos en su PC y copia completa its_2026-10-19.db) hace dos cosas, y nada más:
//  1) Documentos del Drive: borra las copias EXACTAS repetidas dentro de la MISMA carpeta (mismo nombre, mismo contenido
//     comprobado con SHA-256). Deja la más antigua. Las copias en carpetas DISTINTAS no se tocan.
//  2) Adjuntos de exámenes del 1er semestre: borra solo el archivo (archivo_data/nombre/tipo). La fecha, hora, notas, actas
//     y pagos de esos exámenes NO se tocan. Los adjuntos del 2do semestre tampoco.
// Después compacta la base (VACUUM) para que el archivo realmente baje de tamaño. Idempotente: si no hay nada que borrar, no hace nada.
const crypto = require('crypto');

function limpiarPeso(db, log = console.log) {
  const t0 = Date.now();
  const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
  const stats = { docsBorrados: 0, docsBytes: 0, adjuntosBorrados: 0, adjuntosBytes: 0, gruposDistintos: 0 };

  // 1) Documentos repetidos en la misma carpeta
  const grupos = db.prepare(`SELECT COALESCE(carpeta_id,'') c, nombre_archivo n, length(datos) t, count(*) k FROM documentos
    GROUP BY 1,2,3 HAVING count(*)>1`).all();
  const filas = db.prepare(`SELECT id FROM documentos WHERE COALESCE(carpeta_id,'')=? AND nombre_archivo=? AND length(datos)=? ORDER BY fecha, id`);
  const blob = db.prepare('SELECT datos FROM documentos WHERE id=?');
  const borrar = db.prepare('DELETE FROM documentos WHERE id=?');
  db.transaction(() => {
    for (const g of grupos) {
      const ids = filas.all(g.c, g.n, g.t).map(f => f.id);
      const base = sha(blob.get(ids[0]).datos);
      for (const id of ids.slice(1)) {
        if (sha(blob.get(id).datos) !== base) { stats.gruposDistintos++; continue; } // mismo nombre/tamaño pero otro contenido: no se toca
        borrar.run(id); stats.docsBorrados++; stats.docsBytes += g.t;
      }
    }
  })();

  // 2) Adjuntos de exámenes del 1er semestre
  const sem1 = db.prepare('SELECT id FROM periodos WHERE semestre=1').all().map(p => p.id);
  if (sem1.length) {
    const ph = sem1.map(() => '?').join(',');
    const w = db.prepare(`SELECT count(*) n, COALESCE(sum(length(archivo_data)),0) s FROM examenes WHERE periodo_id IN (${ph}) AND archivo_data IS NOT NULL`).get(...sem1);
    if (w.n) {
      db.prepare(`UPDATE examenes SET archivo_data=NULL, archivo_nombre=NULL, archivo_tipo=NULL WHERE periodo_id IN (${ph}) AND archivo_data IS NOT NULL`).run(...sem1);
      stats.adjuntosBorrados = w.n; stats.adjuntosBytes = w.s;
    }
  }

  // 3) Compactar solo si se borró algo
  if (stats.docsBorrados || stats.adjuntosBorrados) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    db.exec('VACUUM');
  }
  stats.segundos = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[Limpieza peso] documentos repetidos borrados: ${stats.docsBorrados} (${(stats.docsBytes / 1048576).toFixed(1)} MB) · adjuntos 1er semestre borrados: ${stats.adjuntosBorrados} (${(stats.adjuntosBytes / 1048576).toFixed(1)} MB) · ${stats.segundos}s`);
  return stats;
}
module.exports = { limpiarPeso };
