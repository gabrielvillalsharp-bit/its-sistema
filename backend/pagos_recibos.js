// ── REGISTRO ÚNICO DE PAGOS (2026-10-21) ─────────────────────────────────────────────────────────────────────────
// Pedido del director: cada pago debe tener un registro único para poder auditar.
//  · Opción 1: número de recibo correlativo e irrepetible (R-000123), quién lo registró y cuándo (hora de Paraguay).
//  · Opción 2: los pagos NO se borran: se anulan (queda el número, el motivo, quién y cuándo) y toda edición guarda "antes y después".
//  · Opción 5: alerta de pagos posiblemente duplicados.
// El número se asigna con un TRIGGER de la base: vale para TODOS los caminos que insertan pagos (manual, lote, WhatsApp, importaciones).
const hoyPY = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Asuncion' });
const horaPY = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Asuncion' });
const utcAPY = (utc) => {
  const d = new Date(String(utc || '').replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d.toLocaleString('sv-SE', { timeZone: 'America/Asuncion' });
};
const fmtRecibo = n => 'R-' + String(n).padStart(6, '0');
// Conceptos que normalmente se pagan UNA vez por alumno (y materia): si se repiten, se avisa. Constancias, certificados y "Otro" pueden repetirse.
const SQL_CONCEPTO_UNICO = "(concepto LIKE 'Cuota %' OR concepto LIKE 'Matr%' OR concepto LIKE 'Examen %' OR concepto LIKE 'Parcial %' OR concepto LIKE 'Final %')";

function prepararPagos(db, log = console.log) {
  // 1) columnas nuevas
  const cols = db.prepare("SELECT name FROM pragma_table_info('pagos')").all().map(c => c.name);
  const add = (n, t) => { if (!cols.includes(n)) db.exec(`ALTER TABLE pagos ADD COLUMN ${n} ${t}`); };
  add('nro_recibo', 'TEXT'); add('nro_recibo_num', 'INTEGER'); add('registrado_por', 'TEXT'); add('registrado_en', 'TEXT');
  add('recibo_historico', 'INTEGER DEFAULT 0'); add('anulado_por', 'TEXT'); add('anulado_en', 'TEXT'); add('anulado_motivo', 'TEXT');
  // 2) tablas de apoyo
  db.exec(`
    CREATE TABLE IF NOT EXISTS pagos_secuencia (id INTEGER PRIMARY KEY CHECK (id = 1), ultimo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS pagos_historial (
      id TEXT PRIMARY KEY, pago_id TEXT NOT NULL, nro_recibo TEXT, fecha TEXT NOT NULL,
      usuario_id TEXT, usuario_nombre TEXT, accion TEXT NOT NULL, campo TEXT, antes TEXT, despues TEXT, motivo TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pagos_hist_pago ON pagos_historial(pago_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_hist_recibo ON pagos_historial(nro_recibo);
    CREATE TABLE IF NOT EXISTS pagos_dup_revisados (clave TEXT PRIMARY KEY, revisado_por TEXT, fecha TEXT, nota TEXT);
    INSERT OR IGNORE INTO pagos_secuencia (id, ultimo) VALUES (1, 0);
  `);
  // 3) numeración de los pagos anteriores (una sola vez): por orden de fecha, marcados como históricos
  if (!db.prepare("SELECT 1 FROM configuracion WHERE clave='mig_pagos_recibos_20261021'").get()) {
    const audit = new Map();
    db.prepare("SELECT registro_id, usuario_id, fecha FROM auditoria WHERE tabla='pagos' AND accion IN ('PAGO','PAGO_LOTE') ORDER BY fecha").all()
      .forEach(a => { if (!audit.has(a.registro_id)) audit.set(a.registro_id, a); });
    const sin = db.prepare("SELECT id, fecha_pago FROM pagos WHERE nro_recibo IS NULL ORDER BY fecha_pago, rowid").all();
    let ult = db.prepare("SELECT COALESCE(MAX(nro_recibo_num),0) m FROM pagos").get().m;
    const upd = db.prepare("UPDATE pagos SET nro_recibo=?, nro_recibo_num=?, recibo_historico=1, registrado_por=?, registrado_en=? WHERE id=?");
    let corregidos = 0;
    const histIns = db.prepare("INSERT INTO pagos_historial (id,pago_id,nro_recibo,fecha,usuario_id,usuario_nombre,accion,campo,antes,despues,motivo) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const updFecha = db.prepare("UPDATE pagos SET fecha_pago=? WHERE id=?");
    db.transaction(() => {
      for (const p of sin) {
        ult++;
        const a = audit.get(p.id);
        upd.run(fmtRecibo(ult), ult, a ? a.usuario_id : null, a ? utcAPY(a.fecha) : null, p.id);
        // Corrección de fecha: los pagos registrados después de las 21:00 (hora de Paraguay) con la fecha por defecto quedaron con la fecha del día SIGUIENTE
        // (se usaba la fecha universal). Solo se corrige cuando la fecha guardada coincide con la fecha universal del registro.
        if (a) {
          const py = utcAPY(a.fecha);
          if (py && p.fecha_pago === String(a.fecha).slice(0, 10) && py.slice(0, 10) !== p.fecha_pago) {
            updFecha.run(py.slice(0, 10), p.id);
            histIns.run('ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), p.id, fmtRecibo(ult), horaPY(), null, 'Sistema (corrección)',
              'fecha_corregida', 'fecha_pago', p.fecha_pago, py.slice(0, 10), 'Corrección de zona horaria: se registró después de las 21:00 (Paraguay) y quedó con la fecha del día siguiente');
            corregidos++;
          }
        }
      }
      db.prepare("UPDATE pagos_secuencia SET ultimo=? WHERE id=1").run(ult);
      db.prepare("INSERT OR IGNORE INTO configuracion (clave,valor,descripcion) VALUES ('mig_pagos_recibos_20261021',?,'Migración: número de recibo, historial de pagos y corrección de fechas')")
        .run(JSON.stringify({ numerados: sin.length, fechas_corregidas: corregidos }));
    })();
    log(`[Migración] Pagos: ${sin.length} recibos históricos numerados · ${corregidos} fechas corregidas (hora de Paraguay) ✓`);
  }
  // 4) la secuencia nunca queda por debajo del mayor número existente
  db.prepare("UPDATE pagos_secuencia SET ultimo=MAX(ultimo,(SELECT COALESCE(MAX(nro_recibo_num),0) FROM pagos)) WHERE id=1").run();
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_nro_recibo ON pagos(nro_recibo) WHERE nro_recibo IS NOT NULL");
  // 5) triggers: número automático para todo pago nuevo + huella de cualquier borrado
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_pagos_recibo AFTER INSERT ON pagos WHEN NEW.nro_recibo IS NULL
    BEGIN
      UPDATE pagos_secuencia SET ultimo = ultimo + 1 WHERE id = 1;
      UPDATE pagos SET
        nro_recibo = 'R-' || printf('%06d', (SELECT ultimo FROM pagos_secuencia WHERE id = 1)),
        nro_recibo_num = (SELECT ultimo FROM pagos_secuencia WHERE id = 1),
        registrado_en = COALESCE(registrado_en, strftime('%Y-%m-%d %H:%M:%S','now','-3 hours'))
      WHERE id = NEW.id;
      INSERT INTO pagos_historial (id,pago_id,nro_recibo,fecha,usuario_nombre,accion,despues)
        VALUES ('ph_' || hex(randomblob(6)), NEW.id, (SELECT nro_recibo FROM pagos WHERE id = NEW.id), strftime('%Y-%m-%d %H:%M:%S','now','-3 hours'), 'Sistema', 'creado',
          json_object('alumno_id', NEW.alumno_id, 'concepto', NEW.concepto, 'monto', NEW.monto, 'fecha_pago', NEW.fecha_pago, 'medio_pago', NEW.medio_pago));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_pagos_eliminado AFTER DELETE ON pagos
    BEGIN
      INSERT INTO pagos_historial (id,pago_id,nro_recibo,fecha,usuario_nombre,accion,antes)
        VALUES ('ph_' || hex(randomblob(6)), OLD.id, OLD.nro_recibo, strftime('%Y-%m-%d %H:%M:%S','now','-3 hours'), 'Sistema', 'eliminado',
          json_object('alumno_id', OLD.alumno_id, 'concepto', OLD.concepto, 'monto', OLD.monto, 'fecha_pago', OLD.fecha_pago, 'medio_pago', OLD.medio_pago, 'estado', OLD.estado));
    END;
  `);
}

function nombreUsuario(db, id) {
  if (!id) return null;
  const u = db.prepare('SELECT nombre, apellido FROM usuarios WHERE id=?').get(id);
  return u ? `${u.nombre || ''} ${u.apellido || ''}`.trim() : String(id);
}
function registrarHistorial(db, { pago_id, nro_recibo, usuario_id, accion, campo, antes, despues, motivo }) {
  db.prepare("INSERT INTO pagos_historial (id,pago_id,nro_recibo,fecha,usuario_id,usuario_nombre,accion,campo,antes,despues,motivo) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run('ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), pago_id, nro_recibo || null, horaPY(), usuario_id || null,
      nombreUsuario(db, usuario_id) || 'Sistema', accion, campo || null, antes == null ? null : String(antes), despues == null ? null : String(despues), motivo || null);
}
// Pagos válidos del mismo alumno + concepto (+ materia) que ya existen: sirve para avisar de un posible duplicado al registrar
function pagosSimilares(db, alumno_id, concepto, asignacion_id) {
  if (!alumno_id || !concepto) return [];
  const esUnico = /^(Cuota |Matr|Examen |Parcial |Final )/i.test(String(concepto));
  if (!esUnico) return [];
  return db.prepare(`SELECT id, nro_recibo, fecha_pago, monto, medio_pago FROM pagos WHERE alumno_id=? AND concepto=? AND COALESCE(asignacion_id,'')=? AND estado='Pagado' ORDER BY fecha_pago`)
    .all(alumno_id, concepto, asignacion_id || '');
}
// Grupos de posibles duplicados para revisar (los ya revisados por el director no se repiten)
function listarDuplicados(db) {
  const revisados = new Set(db.prepare('SELECT clave FROM pagos_dup_revisados').all().map(r => r.clave));
  const filas = db.prepare(`
    SELECT p.id, p.alumno_id, p.concepto, COALESCE(p.asignacion_id,'') asig, p.nro_recibo, p.fecha_pago, p.monto, p.medio_pago, p.comprobante, p.registrado_en,
           COALESCE(a.apellido,'') ape, COALESCE(a.nombre,'') nom, m.nombre materia,
           (SELECT TRIM(COALESCE(u.nombre,'')||' '||COALESCE(u.apellido,'')) FROM usuarios u WHERE u.id=p.registrado_por) registrado_por_nombre
    FROM pagos p LEFT JOIN alumnos a ON a.id=p.alumno_id LEFT JOIN asignaciones s ON s.id=p.asignacion_id LEFT JOIN materias m ON m.id=s.materia_id
    WHERE p.estado='Pagado' AND ${SQL_CONCEPTO_UNICO.replace(/concepto/g, 'p.concepto')}
    ORDER BY p.alumno_id, p.concepto, p.fecha_pago, p.rowid`).all();
  const grupos = new Map();
  for (const f of filas) { const k = `${f.alumno_id}|${f.concepto}|${f.asig}`; (grupos.has(k) ? grupos.get(k) : grupos.set(k, []).get(k)).push(f); }
  const out = [];
  for (const [clave, pagos] of grupos) {
    if (pagos.length < 2 || revisados.has(clave)) continue;
    const identicos = new Set(pagos.map(p => `${p.fecha_pago}|${p.monto}`)).size < pagos.length;
    out.push({ clave, alumno_id: pagos[0].alumno_id, alumno: `${pagos[0].ape}, ${pagos[0].nom}`.trim(), concepto: pagos[0].concepto, materia: pagos[0].materia || null,
      criterio: identicos ? 'Misma fecha y mismo monto (muy probable duplicado)' : 'Mismo concepto pagado más de una vez', probable: identicos, pagos });
  }
  return out.sort((a, b) => (b.probable - a.probable) || a.alumno.localeCompare(b.alumno));
}
module.exports = { prepararPagos, hoyPY, horaPY, fmtRecibo, registrarHistorial, nombreUsuario, pagosSimilares, listarDuplicados };
