// ── CÓDIGOS Y NUMERACIÓN (2026-10-23) ─────────────────────────────────────────────────────────────────────────────
// Pedido del director: que todo registro importante tenga un código legible para mantener el orden y el control.
//  1. Matrícula automática para todo alumno con carrera (formato existente: COS-2026-118; sigue la secuencia de su carrera y año).
//  2. Número de constancia de estudios / regularidad / notas:   CE-2026-0001 · CR-2026-0001 · CN-2026-0001
//  3. Código de docente:                                         DOC-001
//  4. Número de acta por examen:                                 AC-2026-0001
//  5. Número de seguimiento de solicitudes (alumno, registro, egreso): SOL-2026-0001 (una sola serie)
//  6. Número de beca (BEC-2026-0001) y de exoneración de deuda (EXO-2026-0001); la beca guarda quién la autorizó y cuándo.
//  7. Código de materia: se completa el que falta y se ordenan los que no seguían el formato (ABC-123).
// Como con los recibos de pago, la numeración la asigna la BASE (triggers): vale para TODOS los caminos que crean registros
// (pantallas, importaciones, WhatsApp, procesos automáticos). Los registros anteriores se numeran una sola vez, por orden de fecha.

function prepararCodigos(db, log = console.log) {
  const existe = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const columnas = t => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(c => c.name);
  const agregar = (t, c, tipo) => { if (existe(t) && !columnas(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${tipo}`); };

  db.exec('CREATE TABLE IF NOT EXISTS codigos_secuencia (clave TEXT PRIMARY KEY, ultimo INTEGER NOT NULL DEFAULT 0)');
  agregar('constancias', 'numero', 'TEXT');
  agregar('examenes', 'acta_nro', 'TEXT');
  agregar('docentes', 'codigo', 'TEXT');
  for (const t of ['solicitudes_alumno', 'solicitudes_registro', 'solicitudes_egreso']) agregar(t, 'nro_seguimiento', 'TEXT');
  agregar('becas', 'numero', 'TEXT'); agregar('becas', 'autorizado_por', 'TEXT'); agregar('becas', 'autorizado_en', 'TEXT');
  agregar('deuda_exoneraciones', 'numero', 'TEXT');

  // Trigger de numeración: AFTER INSERT, solo si el campo viene vacío. clave = prefijo[-año]; el número sigue la serie guardada en codigos_secuencia.
  const anioDe = col => `COALESCE(strftime('%Y', ${col}), strftime('%Y','now','-3 hours'))`;
  const trgNumerado = ({ nombre, tabla, col, prefSql, anioSql, pad }) => {
    const clave = anioSql ? `(${prefSql}) || '-' || ${anioSql}` : `(${prefSql})`;
    return `CREATE TRIGGER IF NOT EXISTS ${nombre} AFTER INSERT ON ${tabla} WHEN NEW.${col} IS NULL
    BEGIN
      INSERT OR IGNORE INTO codigos_secuencia (clave, ultimo) VALUES (${clave}, 0);
      UPDATE codigos_secuencia SET ultimo = ultimo + 1 WHERE clave = ${clave};
      UPDATE ${tabla} SET ${col} = ${clave} || '-' || printf('%0${pad}d', (SELECT ultimo FROM codigos_secuencia WHERE clave = ${clave})) WHERE rowid = NEW.rowid;
    END;`;
  };
  const trg = [];
  if (existe('constancias')) trg.push(trgNumerado({ nombre: 'trg_constancias_numero', tabla: 'constancias', col: 'numero',
    prefSql: "CASE NEW.tipo WHEN 'regularidad' THEN 'CR' WHEN 'notas' THEN 'CN' ELSE 'CE' END", anioSql: anioDe('NEW.fecha'), pad: 4 }));
  if (existe('examenes')) trg.push(trgNumerado({ nombre: 'trg_examenes_acta', tabla: 'examenes', col: 'acta_nro', prefSql: "'AC'", anioSql: anioDe('NEW.fecha'), pad: 4 }));
  if (existe('docentes')) trg.push(trgNumerado({ nombre: 'trg_docentes_codigo', tabla: 'docentes', col: 'codigo', prefSql: "'DOC'", anioSql: null, pad: 3 }));
  for (const t of ['solicitudes_alumno', 'solicitudes_registro', 'solicitudes_egreso'])
    if (existe(t)) trg.push(trgNumerado({ nombre: `trg_${t}_nro`, tabla: t, col: 'nro_seguimiento', prefSql: "'SOL'",
      anioSql: anioDe(t === 'solicitudes_egreso' ? 'NEW.fecha_solicitud' : 'NEW.fecha'), pad: 4 }));
  if (existe('becas')) trg.push(trgNumerado({ nombre: 'trg_becas_numero', tabla: 'becas', col: 'numero', prefSql: "'BEC'", anioSql: anioDe('NEW.fecha_inicio'), pad: 4 }));
  if (existe('deuda_exoneraciones')) trg.push(trgNumerado({ nombre: 'trg_exoneraciones_numero', tabla: 'deuda_exoneraciones', col: 'numero', prefSql: "'EXO'", anioSql: anioDe('NEW.fecha'), pad: 4 }));

  // Matrícula: al crear un alumno con carrera (o al asignarle carrera después) sin matrícula, se le da la siguiente de su carrera y año
  const asignarMatricula = `
    UPDATE alumnos SET matricula = (
      SELECT p.pref || '-' || printf('%03d', COALESCE((SELECT MAX(CAST(substr(a.matricula, length(p.pref) + 2) AS INTEGER)) FROM alumnos a WHERE a.matricula LIKE p.pref || '-%'), 0) + 1)
      FROM (SELECT (SELECT codigo FROM carreras WHERE id = NEW.carrera_id) || '-' || COALESCE(strftime('%Y', NULLIF(NEW.fecha_ingreso, '')), strftime('%Y','now','-3 hours')) AS pref) p
    ) WHERE id = NEW.id AND (matricula IS NULL OR TRIM(matricula) = '');
    INSERT INTO auditoria (id, usuario_id, accion, tabla, registro_id, detalle, fecha, origen)
      SELECT 'aud_' || hex(randomblob(6)), 'sistema', 'MATRICULA_ASIGNADA', 'alumnos', NEW.id, json_object('matricula', matricula), datetime('now'), 'automatico'
      FROM alumnos WHERE id = NEW.id AND matricula IS NOT NULL;`;
  const cuandoMatricula = `WHEN (NEW.matricula IS NULL OR TRIM(NEW.matricula) = '') AND NEW.carrera_id IS NOT NULL AND (SELECT codigo FROM carreras WHERE id = NEW.carrera_id) IS NOT NULL`;
  trg.push(`CREATE TRIGGER IF NOT EXISTS trg_alumnos_matricula_alta AFTER INSERT ON alumnos ${cuandoMatricula}
    BEGIN ${asignarMatricula} END;`);
  trg.push(`CREATE TRIGGER IF NOT EXISTS trg_alumnos_matricula_carrera AFTER UPDATE OF carrera_id ON alumnos ${cuandoMatricula}
    BEGIN ${asignarMatricula} END;`);
  db.exec(trg.join('\n'));

  // ── Numeración de los registros anteriores (una sola vez) ──
  if (db.prepare("SELECT 1 FROM configuracion WHERE clave='mig_codigos_20261023'").get()) return;
  const resumen = {};
  const getSeq = db.prepare('SELECT ultimo FROM codigos_secuencia WHERE clave=?');
  const setSeq = db.prepare('INSERT INTO codigos_secuencia (clave, ultimo) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET ultimo = excluded.ultimo');
  const siguiente = (clave, pad) => { const n = (getSeq.get(clave)?.ultimo || 0) + 1; setSeq.run(clave, n); return `${clave}-${String(n).padStart(pad, '0')}`; };
  const anio = f => (String(f || '').match(/^(\d{4})/) || [])[1] || new Date(Date.now() - 3 * 3600e3).getUTCFullYear();

  db.transaction(() => {
    // 1) Matrículas: a quien tiene carrera y no tiene matrícula (se usa el mismo trigger: reasignar la carrera lo dispara)
    if (existe('alumnos')) {
      const sin = db.prepare("SELECT id FROM alumnos WHERE (matricula IS NULL OR TRIM(matricula)='') AND carrera_id IS NOT NULL ORDER BY fecha_ingreso, rowid").all();
      const upd = db.prepare('UPDATE alumnos SET carrera_id = carrera_id WHERE id = ?');
      sin.forEach(a => upd.run(a.id));
      const quedan = db.prepare("SELECT COUNT(*) n FROM alumnos WHERE (matricula IS NULL OR TRIM(matricula)='') AND carrera_id IS NULL").get().n;
      resumen.matriculas = { asignadas: sin.length, sin_carrera: quedan };
    }
    // 2) Constancias
    if (existe('constancias')) {
      const f = db.prepare("SELECT rowid rid, tipo, fecha FROM constancias WHERE numero IS NULL ORDER BY fecha, rowid").all();
      const u = db.prepare('UPDATE constancias SET numero=? WHERE rowid=?');
      f.forEach(r => u.run(siguiente(`${r.tipo === 'regularidad' ? 'CR' : r.tipo === 'notas' ? 'CN' : 'CE'}-${anio(r.fecha)}`, 4), r.rid));
      resumen.constancias = f.length;
    }
    // 3) Docentes
    if (existe('docentes')) {
      const f = db.prepare('SELECT rowid rid FROM docentes WHERE codigo IS NULL ORDER BY rowid').all();
      const u = db.prepare('UPDATE docentes SET codigo=? WHERE rowid=?');
      f.forEach(r => u.run(siguiente('DOC', 3), r.rid));
      resumen.docentes = f.length;
    }
    // 4) Actas de examen (solo se leen fecha e id: los exámenes pueden traer archivos pesados)
    if (existe('examenes')) {
      const f = db.prepare('SELECT rowid rid, fecha FROM examenes WHERE acta_nro IS NULL ORDER BY fecha, id').all();
      const u = db.prepare('UPDATE examenes SET acta_nro=? WHERE rowid=?');
      f.forEach(r => u.run(siguiente(`AC-${anio(r.fecha)}`, 4), r.rid));
      resumen.actas = f.length;
    }
    // 5) Solicitudes: una sola serie ordenada por fecha entre las tres tablas
    {
      const todas = [];
      for (const [t, campo] of [['solicitudes_alumno', 'fecha'], ['solicitudes_registro', 'fecha'], ['solicitudes_egreso', 'fecha_solicitud']])
        if (existe(t)) db.prepare(`SELECT rowid rid, ${campo} AS f FROM ${t} WHERE nro_seguimiento IS NULL`).all().forEach(r => todas.push({ t, ...r }));
      todas.sort((a, b) => String(a.f || '').localeCompare(String(b.f || '')) || a.t.localeCompare(b.t) || a.rid - b.rid);
      todas.forEach(r => db.prepare(`UPDATE ${r.t} SET nro_seguimiento=? WHERE rowid=?`).run(siguiente(`SOL-${anio(r.f)}`, 4), r.rid));
      resumen.solicitudes = todas.length;
    }
    // 6) Becas y exoneraciones
    if (existe('becas')) {
      const f = db.prepare('SELECT rowid rid, fecha_inicio FROM becas WHERE numero IS NULL ORDER BY fecha_inicio, rowid').all();
      f.forEach(r => db.prepare('UPDATE becas SET numero=? WHERE rowid=?').run(siguiente(`BEC-${anio(r.fecha_inicio)}`, 4), r.rid));
      resumen.becas = f.length;
    }
    if (existe('deuda_exoneraciones')) {
      const f = db.prepare('SELECT rowid rid, fecha FROM deuda_exoneraciones WHERE numero IS NULL ORDER BY fecha, rowid').all();
      f.forEach(r => db.prepare('UPDATE deuda_exoneraciones SET numero=? WHERE rowid=?').run(siguiente(`EXO-${anio(r.fecha)}`, 4), r.rid));
      resumen.exoneraciones = f.length;
    }
    // 7) Códigos de materia: completar el que falta y ordenar los que no tienen el formato ABC-123 / AB-123.
    //    Una materia sin código toma el número de su id (m_rad_204 → RAD-204); las demás, el siguiente libre de su carrera y año (RAD-1NN).
    if (existe('materias')) {
      const FORMATO = /^[A-Z]{2,3}-\d{3}$/;
      const todas = db.prepare('SELECT m.id, m.codigo, m.nombre, m.anio, c.codigo AS ccod FROM materias m LEFT JOIN carreras c ON c.id = m.carrera_id ORDER BY m.carrera_id, m.anio, m.id').all();
      const usados = new Set(todas.map(m => m.codigo).filter(Boolean));
      const cambios = []; const mapa = new Map();
      for (const m of todas) {
        if (!m.ccod || (m.codigo && FORMATO.test(m.codigo))) continue;
        const clave = `${m.codigo || ('#' + m.id)}|${m.ccod}|${m.anio}`;
        let nuevo = mapa.get(clave);
        if (!nuevo) {
          const delId = (!m.codigo && (m.id.match(/_(\d{3})$/) || [])[1]) ? `${m.ccod}-${m.id.match(/_(\d{3})$/)[1]}` : null;
          if (delId && !todas.some(o => o.codigo === delId && o.nombre !== m.nombre)) nuevo = delId;
          else {
            const digito = String(m.anio || 1);
            const re = new RegExp(`^${m.ccod}-${digito}(\\d\\d)$`);
            const max = Math.max(0, ...[...usados].map(c => (c.match(re) || [])[1]).filter(Boolean).map(Number));
            nuevo = `${m.ccod}-${digito}${String(max + 1).padStart(2, '0')}`;
          }
          mapa.set(clave, nuevo); usados.add(nuevo);
        }
        cambios.push({ id: m.id, nombre: m.nombre, antes: m.codigo || null, despues: nuevo });
      }
      const u = db.prepare('UPDATE materias SET codigo=? WHERE id=?');
      cambios.forEach(c => u.run(c.despues, c.id));
      resumen.materias = cambios;
    }
    db.prepare("INSERT OR IGNORE INTO configuracion (clave, valor, descripcion) VALUES ('mig_codigos_20261023', ?, 'Migración: matrículas faltantes, números de constancia/acta/solicitud/beca/exoneración, código de docente y de materia')")
      .run(JSON.stringify(resumen));
  })();
  log(`[Migración] Códigos: ${resumen.matriculas ? resumen.matriculas.asignadas + ' matrículas asignadas · ' : ''}${resumen.constancias || 0} constancias · ${resumen.docentes || 0} docentes · ${resumen.actas || 0} actas · ${resumen.solicitudes || 0} solicitudes · ${resumen.becas || 0} becas · ${resumen.exoneraciones || 0} exoneraciones · ${(resumen.materias || []).length} códigos de materia ✓`);
}

module.exports = { prepararCodigos };
