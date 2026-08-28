/**
 * Elimina TODAS las materias creadas por seed_2do_semestre.js (y sus
 * asignaciones/notas/horarios asociados) para volver a un estado limpio,
 * de forma que el 2do Semestre 2026 se arme materia por materia manualmente
 * desde Estructura Académica → Materias.
 *
 * Seguro de correr: el período "2do Semestre 2026" nunca se activó, por lo
 * tanto no hay notas reales cargadas (todas están en estado 'Pendiente'
 * vacío). No toca el período en sí, ni ninguna otra materia/carrera.
 *
 * Uso local:
 *   node backend/borrar_materias_seed_2do_semestre.js
 * Uso en Railway Shell:
 *   node backend/borrar_materias_seed_2do_semestre.js
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/its.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

// Códigos exactos creados por seed_2do_semestre.js (79 materias)
const CODIGOS = [
  'ENF-S2-101','ENF-S2-102','ENF-S2-103','ENF-S2-104','ENF-S2-105',
  'ENF-S4-101','ENF-S4-102','ENF-S4-103','ENF-S4-104','ENF-S4-105',
  'RAD-S2-101','RAD-S2-102','RAD-S2-103','RAD-S2-104',
  'RAD-S4-101','RAD-S4-102','RAD-S4-103','RAD-S4-104','RAD-S4-105','RAD-S4-106','RAD-S4-107',
  'IQ-S2-101','IQ-S2-102','IQ-S2-103','IQ-S2-104','IQ-S2-105',
  'IQ-S4-101','IQ-S4-102','IQ-S4-103','IQ-S4-104','IQ-S4-105','IQ-S4-106','IQ-S4-107',
  'FAR-S2-101','FAR-S2-102','FAR-S2-103','FAR-S2-104','FAR-S2-105',
  'FAR-S4-101','FAR-S4-102','FAR-S4-103','FAR-S4-104','FAR-S4-105','FAR-S4-106','FAR-S4-107','FAR-S4-108',
  'COS-S2-101','COS-S2-102','COS-S2-103','COS-S2-104','COS-S2-105',
  'COS-S4-102','COS-S4-103','COS-S4-104','COS-S4-105','COS-S4-106',
  'AGR-S2-101','AGR-S2-102','AGR-S2-103','AGR-S2-104','AGR-S2-105','AGR-S2-108',
  'AGR-S4-101','AGR-S4-102','AGR-S4-103','AGR-S4-104','AGR-S4-106','AGR-S4-107','AGR-S4-108',
  'CRM-S2-101','CRM-S2-102','CRM-S2-103','CRM-S2-104','CRM-S2-105',
  'CRM-S4-101','CRM-S4-102','CRM-S4-104','CRM-S4-105','CRM-S4-106',
];

console.log(`📋 Códigos a procesar: ${CODIGOS.length}`);

let notasElim = 0, horariosElim = 0, asigsElim = 0, matsElim = 0, matsNoEncontradas = 0;

db.transaction(() => {
  CODIGOS.forEach(cod => {
    const mat = db.prepare("SELECT id, nombre FROM materias WHERE codigo=?").get(cod);
    if (!mat) { matsNoEncontradas++; return; }

    const asigs = db.prepare("SELECT id FROM asignaciones WHERE materia_id=?").all(mat.id);
    asigs.forEach(a => {
      const rn = db.prepare("DELETE FROM notas WHERE asignacion_id=?").run(a.id);
      notasElim += rn.changes;
      const rh = db.prepare("DELETE FROM horarios WHERE asignacion_id=?").run(a.id);
      horariosElim += rh.changes;
      db.prepare("DELETE FROM asignaciones WHERE id=?").run(a.id);
      asigsElim++;
    });

    db.prepare("DELETE FROM materias WHERE id=?").run(mat.id);
    matsElim++;
  });
})();

console.log(`\n✅ Resultado:`);
console.log(`   Materias eliminadas   : ${matsElim}`);
console.log(`   Materias no encontradas (ya no existían) : ${matsNoEncontradas}`);
console.log(`   Asignaciones eliminadas: ${asigsElim}`);
console.log(`   Notas eliminadas       : ${notasElim}`);
console.log(`   Horarios eliminados    : ${horariosElim}`);
console.log(`\n📌 El período "2do Semestre 2026" sigue existiendo, ahora vacío.`);
console.log(`   Cargá las materias manualmente desde Estructura Académica → Materias.`);
