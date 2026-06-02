const Database = require('./node_modules/better-sqlite3');
const db = new Database('./its.db', { readonly: true, fileMustExist: true });

try { db.pragma('wal_checkpoint(PASSIVE)'); } catch(e) { console.log('checkpoint skip:', e.message); }

const total = db.prepare('SELECT COUNT(*) as n FROM alumnos').get();
console.log('Total alumnos:', total.n);

const periodo = db.prepare('SELECT id, nombre FROM periodos WHERE activo=1').get();
console.log('Periodo activo:', periodo ? periodo.nombre : 'NINGUNO');

// Alumnos aprobados via QR (en auditoria)
const qrAudit = db.prepare("SELECT registro_id, detalle FROM auditoria WHERE accion='APROBAR_REGISTRO' ORDER BY fecha DESC LIMIT 20").all();
console.log('\nQR aprobaciones en auditoria:', qrAudit.length);

// Analizar cada alumno QR
qrAudit.forEach(a => {
  let det = {};
  try { det = JSON.parse(a.detalle); } catch(e) {}
  const nombre = det.nombre || a.registro_id;

  // Buscar solicitud
  const sol = db.prepare('SELECT * FROM solicitudes_registro WHERE id=?').get(a.registro_id);

  // Buscar alumno por nombre
  const alumno = sol ? db.prepare(`
    SELECT al.id, al.nombre, al.apellido, al.ci, al.curso_id, al.carrera_id, al.estado,
      c.nombre as carrera, cu.anio,
      COUNT(n.id) as notas
    FROM alumnos al
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    LEFT JOIN notas n ON n.alumno_id=al.id
    WHERE (al.nombre=? AND al.apellido=?) OR al.ci=?
    GROUP BY al.id LIMIT 1
  `).get(sol.nombre, sol.apellido, sol.ci||'__') : null;

  if (!alumno) {
    console.log(`  ❓ ${nombre} — alumno no encontrado`);
    return;
  }

  let asigDisp = 0;
  if (alumno.curso_id && periodo) {
    asigDisp = db.prepare('SELECT COUNT(*) as n FROM asignaciones WHERE curso_id=? AND periodo_id=?').get(alumno.curso_id, periodo.id)?.n || 0;
  }

  const problemas = [];
  if (!alumno.curso_id) problemas.push('SIN CURSO');
  if (alumno.notas === 0 && asigDisp > 0) problemas.push(`SIN NOTAS (hay ${asigDisp} asig)`);
  if (alumno.notas === 0 && asigDisp === 0) problemas.push('SIN NOTAS (curso sin asignaciones)');

  const icono = problemas.length ? '❌' : '✅';
  console.log(`  ${icono} ${alumno.apellido}, ${alumno.nombre} | ${alumno.carrera} ${alumno.anio||'-'}° | notas:${alumno.notas}/${asigDisp} | ${problemas.join(' | ') || 'OK'}`);
});
