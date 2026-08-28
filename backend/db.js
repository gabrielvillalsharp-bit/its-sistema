const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Orden de prioridad para la ruta de la DB:
// 1. Variable de entorno DB_PATH explícita
// 2. Railway Volume: $RAILWAY_VOLUME_MOUNT_PATH/its.db  (persiste entre deploys)
// 3. Fallback local: <repo_root>/data/its.db
//
// MIGRACIÓN AUTOMÁTICA: si el destino del Volume no tiene DB pero existe la
// DB legacy en /app/data/its.db (ruta antigua), la copiamos automáticamente.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  const legacyPath = path.join(__dirname, '..', 'data', 'its.db');

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    const volumePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'its.db');

    // Si ya existe la DB en el volumen → úsala directamente
    if (fs.existsSync(volumePath)) return volumePath;

    // Si NO existe en el volumen pero sí en la ruta legacy → migrar
    if (fs.existsSync(legacyPath)) {
      try {
        const dir = path.dirname(volumePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(legacyPath, volumePath);
        console.log('[DB] ✅ Migración automática: DB copiada de', legacyPath, '→', volumePath);
      } catch (e) {
        console.error('[DB] ⚠️  No se pudo migrar DB legacy:', e.message, '— usando ruta legacy');
        return legacyPath;
      }
    }

    return volumePath; // nueva DB en el volumen (o migrada)
  }

  return legacyPath;
}

// ── SISTEMA DE BACKUP AUTOMÁTICO ─────────────────────────────────────────────
// Guarda hasta 3 copias rotativas de la DB en /backups/ junto al archivo principal.
// Se llama al final de init(), solo si hay alumnos reales registrados.
// Al abrir la DB, si detecta que está vacía pero hay backup, restaura automáticamente.

function getBackupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

function autoRestoreIfEmpty(dbPath) {
  // Si la DB existe, verificar si tiene datos
  if (fs.existsSync(dbPath)) {
    let alumnosCount = 0;
    try {
      const tmp = new Database(dbPath, { readonly: true });
      try { alumnosCount = tmp.prepare("SELECT COUNT(*) as n FROM alumnos").get()?.n || 0; } catch {}
      tmp.close();
    } catch {}
    if (alumnosCount > 0) return; // DB tiene datos → todo bien
    console.log('[RESTORE] DB existe pero está vacía — buscando backup...');
  } else {
    console.log('[RESTORE] DB no encontrada — buscando backup...');
  }

  // DB vacía o inexistente: buscar backup
  const backupDir = getBackupDir(dbPath);
  const candidates = ['its_backup_1.db', 'its_backup_2.db', 'its_backup_3.db']
    .map(f => path.join(backupDir, f)).filter(f => fs.existsSync(f));
  if (candidates.length === 0) {
    console.log('[RESTORE] Sin backups disponibles — arrancando vacío');
    return;
  }
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(candidates[0], dbPath);
    console.log('[RESTORE] ✅ Restaurada desde backup:', candidates[0]);
  } catch(e) {
    console.error('[RESTORE] ⚠️  No se pudo restaurar:', e.message);
  }
}

function autoBackup(db, dbPath) {
  // Este backup por arranque fue desactivado: cada deploy generaba 3 copias de
  // 433 MB (its_backup_1/2/3.db) acumulando 1.3 GB en el volumen. El backup real
  // lo maneja hacerBackupAutomatico() en server.js cada 48hs con rotación de 1 copia.
  // Se conserva la función para que autoRestore siga encontrando sus candidatos
  // si existían de antes, pero ya no se genera ninguna copia nueva al arrancar.
  console.log('[BACKUP] Backup por arranque desactivado — usa el cron de 48hs en server.js');
}

const DB_PATH = resolveDbPath();
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
console.log('[DB] Ruta:', DB_PATH, '| Volume Railway:', process.env.RAILWAY_VOLUME_MOUNT_PATH||'no detectado');

// Auto-restaurar si la DB estaba vacía (volumen reiniciado, etc.)
autoRestoreIfEmpty(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -32000');   // 32 MB de caché en memoria
db.pragma('synchronous = NORMAL');  // más rápido, igual de seguro con WAL
db.pragma('temp_store = MEMORY');   // tablas temporales en RAM

// ── MERGE DE CAMPOS PARA GUARDADO PARCIAL (notas) ────────────────────────────
// Regla de oro, violada dos veces ya con costo real (ver commits de julio 2026
// sobre pérdida de notas): un campo AUSENTE del payload de un guardado NUNCA
// significa "vaciar ese campo" -- significa "este guardado no lo tocó". Cualquier
// endpoint que escriba varios campos de una fila a partir de un payload parcial
// (distintos roles mandan distintos subconjuntos de campos) tiene que usar este
// patrón: mergear contra el valor actual en DB, nunca contra `null`/`undefined`
// por defecto. Extraído a función aparte para poder testearlo sin levantar el
// servidor entero (ver backend/mergeCamposNota.test.js).
function mergeCamposNota(campos, antes, body) {
  return campos.map(c => {
    if (!(c in body)) return (antes && antes[c] !== undefined) ? antes[c] : null;
    const v = body[c];
    if (v === '' || v === undefined || v === null) return null;
    return Math.round(Number(String(v).replace(',', '.')));
  });
}

// ── CÁLCULO DE PUNTAJE (lógica ITS) ──────────────────────────────────────────
// Parcial: si hay recuperatorio, REEMPLAZA al ordinario (no importa cuál es mayor)
// TPs: 4 campos independientes, suma simple (max 5 cada uno, max 20 total)
// Dirección: 10 pts adicionales asignados por el director
// Final: última instancia cargada reemplaza las anteriores (ord → recup → complementario)
// Extraordinario: RESET total — ignora todo y usa solo ese valor (escala sobre 100)
// Total posible: 4 TPs (20) + Parcial (20) + Dirección (10) + Final (50) = 100 pts
function calcularPuntaje(tp1, tp2, tp3, tp4, tp5, parcial, parcial_recuperatorio, final_ord, final_recuperatorio, complementario, extraordinario, director_pts) {
  const hayDatos = [tp1,tp2,tp3,tp4,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario,director_pts]
    .some(v => v !== null && v !== undefined && v !== '');
  if (!hayDatos) return { puntaje: null, nota: null, estado: 'Pendiente' };

  const n = v => (v !== null && v !== undefined && v !== '') ? parseFloat(v) : null;

  // EXTRAORDINARIO: resetea todo
  const extr = n(extraordinario);
  if (extr !== null) {
    const puntaje = Math.round(extr * 100) / 100;
    const nota = puntaje >= 94 ? 5 : puntaje >= 86 ? 4 : puntaje >= 78 ? 3 : puntaje >= 70 ? 2 : 1;
    const estado = nota >= 2 ? 'Aprobado' : 'Reprobado';
    return { puntaje, nota, estado, parcial_ef: null, final_ef: null, tp_total: null };
  }

  const parOrd = n(parcial);
  const parRec = n(parcial_recuperatorio);
  const parcial_ef = parRec !== null ? parRec : parOrd;

  // Solo 4 TPs (tp5 ignorado en el cálculo)
  const tps = [n(tp1), n(tp2), n(tp3), n(tp4)];
  const tp_total = tps.every(t => t === null) ? null : tps.reduce((acc, t) => acc + (t || 0), 0);

  const dir = n(director_pts);

  const finOrd = n(final_ord);
  const finRec = n(final_recuperatorio);
  const finCom = n(complementario);
  let final_ef = null;
  if (finCom !== null) final_ef = finCom;
  else if (finRec !== null) final_ef = finRec;
  else if (finOrd !== null) final_ef = finOrd;

  // ── REGLA CLAVE: solo mostrar Aprobado/Reprobado cuando hay un final cargado
  // Si solo hay TPs y/o parciales → Pendiente (esperando el final)
  if (final_ef === null) {
    // Calcular puntaje parcial para mostrar, pero estado = Pendiente
    const puntajeParcial = Math.round(((parcial_ef || 0) + (tp_total || 0) + (dir || 0)) * 100) / 100;
    return { puntaje: puntajeParcial||null, nota: null, estado: 'Pendiente', parcial_ef, final_ef, tp_total };
  }

  // Hay final → calcular nota definitiva
  const puntaje = Math.round(((parcial_ef || 0) + (tp_total || 0) + (dir || 0) + (final_ef || 0)) * 100) / 100;
  const nota = puntaje >= 94 ? 5 : puntaje >= 86 ? 4 : puntaje >= 78 ? 3 : puntaje >= 70 ? 2 : 1;
  const estado = nota >= 2 ? 'Aprobado' : 'Reprobado';
  return { puntaje, nota, estado, parcial_ef, final_ef, tp_total };
}

// ── TABLAS ────────────────────────────────────────────────────────────────────
function crearTablas() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institucion (
      id INTEGER PRIMARY KEY DEFAULT 1,
      nombre TEXT NOT NULL DEFAULT 'Instituto Técnico Superior',
      direccion TEXT, telefono TEXT, email TEXT, mision TEXT,
      logo_base64 TEXT
    );
    CREATE TABLE IF NOT EXISTS escala_notas (
      id TEXT PRIMARY KEY, nota INTEGER NOT NULL,
      puntaje_min REAL NOT NULL, puntaje_max REAL NOT NULL, descripcion TEXT
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL, apellido TEXT,
      ci TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('director','docente','alumno')),
      activo INTEGER NOT NULL DEFAULT 1,
      fecha_registro TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE TABLE IF NOT EXISTS docentes (
      id TEXT PRIMARY KEY, usuario_id TEXT NOT NULL REFERENCES usuarios(id),
      especialidad TEXT, titulo TEXT, telefono TEXT
    );
    CREATE TABLE IF NOT EXISTS periodos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL,
      anio INTEGER NOT NULL, semestre INTEGER,
      fecha_inicio TEXT, fecha_fin TEXT, activo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS carreras (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL, codigo TEXT NOT NULL,
      turno TEXT, semestres INTEGER NOT NULL DEFAULT 4, activa INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cursos (
      id TEXT PRIMARY KEY, carrera_id TEXT NOT NULL REFERENCES carreras(id),
      anio INTEGER NOT NULL, division TEXT NOT NULL DEFAULT 'U',
      turno TEXT, activo INTEGER NOT NULL DEFAULT 1,
      UNIQUE(carrera_id, anio, division)
    );
    CREATE TABLE IF NOT EXISTS materias (
      id TEXT PRIMARY KEY, carrera_id TEXT NOT NULL REFERENCES carreras(id),
      nombre TEXT NOT NULL, codigo TEXT, horas_semanales INTEGER DEFAULT 4,
      anio INTEGER DEFAULT 1,
      peso_tp INTEGER NOT NULL DEFAULT 25,
      peso_parcial INTEGER NOT NULL DEFAULT 25,
      peso_final INTEGER NOT NULL DEFAULT 50
    );
    CREATE TABLE IF NOT EXISTS alumnos (
      id TEXT PRIMARY KEY, usuario_id TEXT REFERENCES usuarios(id),
      matricula TEXT UNIQUE, carrera_id TEXT NOT NULL REFERENCES carreras(id),
      curso_id TEXT REFERENCES cursos(id), fecha_ingreso TEXT,
      estado TEXT NOT NULL DEFAULT 'Activo' CHECK(estado IN ('Activo','Inactivo','Egresado','Retirado')),
      telefono TEXT, direccion TEXT, ci TEXT, nombre TEXT, apellido TEXT
    );
    CREATE TABLE IF NOT EXISTS asignaciones (
      id TEXT PRIMARY KEY,
      docente_id TEXT NOT NULL REFERENCES docentes(id),
      materia_id TEXT NOT NULL REFERENCES materias(id),
      curso_id TEXT NOT NULL REFERENCES cursos(id),
      periodo_id INTEGER NOT NULL REFERENCES periodos(id),
      UNIQUE(docente_id, materia_id, curso_id, periodo_id)
    );
    CREATE TABLE IF NOT EXISTS notas (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      tp1 REAL, tp2 REAL, tp3 REAL, tp4 REAL, tp5 REAL,
      tp_total REAL,
      parcial REAL, parcial_recuperatorio REAL, parcial_efectivo REAL,
      final_ord REAL, final_recuperatorio REAL, complementario REAL, final_efectivo REAL,
      extraordinario REAL,
      ausente INTEGER DEFAULT 0,
      puntaje_total REAL, nota_final INTEGER,
      estado TEXT DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','Aprobado','Reprobado','Ausente')),
      UNIQUE(alumno_id, asignacion_id)
    );
    CREATE TABLE IF NOT EXISTS asistencia (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      fecha TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'P' CHECK(estado IN ('P','A','T','J')),
      observacion TEXT,
      UNIQUE(alumno_id, asignacion_id, fecha)
    );
    CREATE TABLE IF NOT EXISTS pagos (
      id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      periodo_id INTEGER REFERENCES periodos(id),
      concepto TEXT NOT NULL, monto REAL NOT NULL,
      fecha_pago TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'Pagado',
      comprobante TEXT, descuento REAL DEFAULT 0, beca TEXT,
      medio_pago TEXT DEFAULT 'Efectivo'
    );
    CREATE TABLE IF NOT EXISTS examenes (
      id TEXT PRIMARY KEY,
      asignacion_id TEXT REFERENCES asignaciones(id),
      tipo TEXT NOT NULL,
      fecha TEXT NOT NULL, hora TEXT, aula TEXT,
      periodo_id INTEGER REFERENCES periodos(id),
      observacion TEXT,
      puntos_max INTEGER NOT NULL DEFAULT 50
    );
    CREATE TABLE IF NOT EXISTS avisos (
      id TEXT PRIMARY KEY,
      titulo TEXT NOT NULL,
      contenido TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'info' CHECK(tipo IN ('info','urgente','examen','administrativo')),
      fijado INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      destinatario TEXT NOT NULL DEFAULT 'todos' CHECK(destinatario IN ('todos','docentes','alumnos')),
      usuario_id TEXT NOT NULL REFERENCES usuarios(id),
      fecha_creacion TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS becas (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('Beca Total','Beca Parcial','Descuento','Convenio')),
      porcentaje REAL, monto_fijo REAL, descripcion TEXT,
      fecha_inicio TEXT NOT NULL, fecha_fin TEXT,
      activa INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS aranceles (
      id TEXT PRIMARY KEY,
      concepto TEXT NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      tipo TEXT NOT NULL DEFAULT 'cuota' CHECK(tipo IN ('matricula','cuota','parcial','final','extraordinario','certificado','otro')),
      carrera_id TEXT REFERENCES carreras(id),
      descripcion TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      fecha_actualizacion TEXT DEFAULT (date('now'))
    );
    CREATE TABLE IF NOT EXISTS habilitaciones_examen (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      tipo_examen TEXT NOT NULL CHECK(tipo_examen IN ('parcial','final','extraordinario')),
      asignacion_id TEXT REFERENCES asignaciones(id),
      habilitado INTEGER NOT NULL DEFAULT 0,
      habilitado_por TEXT REFERENCES usuarios(id),
      motivo TEXT,
      fecha TEXT DEFAULT (date('now'))
    );
    CREATE TABLE IF NOT EXISTS auditoria (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      accion TEXT NOT NULL,
      tabla TEXT NOT NULL,
      registro_id TEXT,
      detalle TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS qr_cambios (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      campo TEXT NOT NULL,
      valor_anterior TEXT,
      valor_nuevo TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS constancias (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      tipo TEXT NOT NULL DEFAULT 'estudios' CHECK(tipo IN ('estudios','regularidad','notas')),
      pago_id TEXT REFERENCES pagos(id),
      fecha TEXT NOT NULL DEFAULT (date('now')),
      emitido_por TEXT REFERENCES usuarios(id),
      observacion TEXT
    );
    CREATE TABLE IF NOT EXISTS deudas_cuotas (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      periodo_id INTEGER NOT NULL REFERENCES periodos(id),
      concepto TEXT NOT NULL,
      monto_total REAL NOT NULL,
      monto_pagado REAL NOT NULL DEFAULT 0,
      fecha_vencimiento TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','parcial','pagado','vencido'))
    );
    CREATE TABLE IF NOT EXISTS honorarios (
      id TEXT PRIMARY KEY,
      docente_id TEXT NOT NULL REFERENCES docentes(id),
      asignacion_id TEXT REFERENCES asignaciones(id),
      fecha TEXT NOT NULL,
      turno INTEGER NOT NULL DEFAULT 1,
      monto REAL NOT NULL DEFAULT 80000,
      estado TEXT NOT NULL DEFAULT 'generado' CHECK(estado IN ('generado','pagado','anulado')),
      tipo TEXT NOT NULL DEFAULT 'clase' CHECK(tipo IN ('clase','reemplazo')),
      reemplazo_id TEXT,
      observacion TEXT,
      fecha_registro TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reemplazos (
      id TEXT PRIMARY KEY,
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      docente_titular_id TEXT NOT NULL REFERENCES docentes(id),
      docente_reemplazante_id TEXT NOT NULL REFERENCES docentes(id),
      fecha TEXT NOT NULL,
      turno INTEGER NOT NULL DEFAULT 1,
      motivo TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
      registrado_por TEXT NOT NULL REFERENCES usuarios(id),
      aprobado_por TEXT REFERENCES usuarios(id),
      fecha_aprobacion TEXT,
      fecha_registro TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS feriados (
      id TEXT PRIMARY KEY,
      fecha TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'nacional' CHECK(tipo IN ('nacional','institucional')),
      activo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS actividades (
      id TEXT PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      fecha TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'otros' CHECK(tipo IN ('examen','academico','administrativo','otros')),
      carrera_id TEXT REFERENCES carreras(id),
      materia_id TEXT REFERENCES materias(id),
      usuario_id TEXT NOT NULL REFERENCES usuarios(id),
      activo INTEGER NOT NULL DEFAULT 1,
      fecha_creacion TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS horarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asignacion_id TEXT REFERENCES asignaciones(id),
      dia TEXT NOT NULL CHECK(dia IN ('Lunes','Martes','Miércoles','Jueves','Viernes')),
      turno INTEGER NOT NULL DEFAULT 1 CHECK(turno IN (1,2)),
      hora_inicio TEXT NOT NULL DEFAULT '19:00',
      hora_fin TEXT NOT NULL DEFAULT '20:20',
      aula TEXT
    );
    CREATE TABLE IF NOT EXISTS informes_asistencia (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      docente_id TEXT NOT NULL REFERENCES docentes(id),
      observacion TEXT,
      fecha TEXT NOT NULL DEFAULT (date('now')),
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','visto','resuelto'))
    );
  `);

  // Índices para consultas frecuentes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alumnos_carrera ON alumnos(carrera_id);
    CREATE INDEX IF NOT EXISTS idx_alumnos_curso ON alumnos(curso_id);
    CREATE INDEX IF NOT EXISTS idx_alumnos_estado ON alumnos(estado);
    CREATE INDEX IF NOT EXISTS idx_notas_alumno ON notas(alumno_id);
    CREATE INDEX IF NOT EXISTS idx_notas_asignacion ON notas(asignacion_id);
    CREATE INDEX IF NOT EXISTS idx_asistencia_asignacion ON asistencia(asignacion_id);
    CREATE INDEX IF NOT EXISTS idx_asistencia_alumno ON asistencia(alumno_id);
    CREATE INDEX IF NOT EXISTS idx_asistencia_fecha ON asistencia(fecha);
    CREATE INDEX IF NOT EXISTS idx_asignaciones_docente ON asignaciones(docente_id);
    CREATE INDEX IF NOT EXISTS idx_asignaciones_curso ON asignaciones(curso_id);
    CREATE INDEX IF NOT EXISTS idx_asignaciones_periodo ON asignaciones(periodo_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_alumno ON pagos(alumno_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_periodo ON pagos(periodo_id);
    CREATE INDEX IF NOT EXISTS idx_examenes_fecha ON examenes(fecha);
    CREATE INDEX IF NOT EXISTS idx_examenes_periodo ON examenes(periodo_id);
    CREATE INDEX IF NOT EXISTS idx_materias_carrera ON materias(carrera_id);
    CREATE INDEX IF NOT EXISTS idx_cursos_carrera ON cursos(carrera_id);
    CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_auditoria_tabla ON auditoria(tabla);
    CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha);
    CREATE INDEX IF NOT EXISTS idx_notas_asig_alumno ON notas(asignacion_id, alumno_id);
    CREATE INDEX IF NOT EXISTS idx_asistencia_fecha_asig ON asistencia(fecha, asignacion_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_alumno_periodo ON pagos(alumno_id, periodo_id);
    CREATE INDEX IF NOT EXISTS idx_honorarios_docente_fecha ON honorarios(docente_id, fecha);
  `);
}

// ── SEED DE DATOS REALES DEL INSTITUTO ───────────────────────────────────────
function seedDatos() {

  // Institución
  if (!db.prepare('SELECT id FROM institucion WHERE id=1').get()) {
    db.prepare('INSERT INTO institucion (id,nombre,direccion,telefono,email,mision) VALUES (1,?,?,?,?,?)')
      .run('Instituto Técnico Superior Santísima Trinidad',
           'Pedro Juan Caballero, Amambay, Paraguay', '', '',
           'Formar profesionales técnicos de calidad para el desarrollo de la región.');
  }

  // Escala de notas
  if (!db.prepare('SELECT COUNT(*) as n FROM escala_notas').get().n) {
    const ins = db.prepare('INSERT INTO escala_notas (id,nota,puntaje_min,puntaje_max,descripcion) VALUES (?,?,?,?,?)');
    db.transaction(() => {
      ins.run('en_1', 1,  0,    59.99, 'Reprobado');
      ins.run('en_2', 2, 60,   69.99, 'Suficiente');
      ins.run('en_3', 3, 70,   79.99, 'Bueno');
      ins.run('en_4', 4, 80,   89.99, 'Muy Bueno');
      ins.run('en_5', 5, 90,  100,    'Sobresaliente');
    })();
  }

  // Director
  if (!db.prepare("SELECT id FROM usuarios WHERE email='director@its.edu.py'").get()) {
    db.prepare('INSERT INTO usuarios (id,nombre,apellido,email,password_hash,rol) VALUES (?,?,?,?,?,?)')
      .run('u_director', 'Director', 'Sistema', 'director@its.edu.py', bcrypt.hashSync('director123', 10), 'director');
  }

  // Período lectivo 2026
  if (!db.prepare('SELECT id FROM periodos WHERE anio=2026').get()) {
    db.prepare('INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin,activo) VALUES (?,?,?,?,?,1)')
      .run('Año Lectivo 2026', 2026, 1, '2026-03-01', '2026-11-30');
  }
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();

  // ── CARRERAS ────────────────────────────────────────────────────────────────
  const carreras = [
    { id: 'agro',  nombre: 'Agropecuaria',              codigo: 'AGR' },
    { id: 'cont',  nombre: 'Contabilidad',               codigo: 'CON' },
    { id: 'cosA',  nombre: 'Cosmiatría',                 codigo: 'COS' },
    { id: 'crim',  nombre: 'Criminalística',             codigo: 'CRM' },
    { id: 'elec',  nombre: 'Electricidad',               codigo: 'ELC' },
    { id: 'enf',   nombre: 'Enfermería',                 codigo: 'ENF' },
    { id: 'farm',  nombre: 'Farmacia',                   codigo: 'FAR' },
    { id: 'instr', nombre: 'Instrumentación Quirúrgica', codigo: 'IQ'  },
    { id: 'rad',   nombre: 'Radiología',                 codigo: 'RAD' },
  ];
  const insC = db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,turno,semestres,activa) VALUES (?,?,?,?,4,1)');
  db.transaction(() => carreras.forEach(c => insC.run(c.id, c.nombre, c.codigo, 'Nocturno')))();

  // ── CURSOS ──────────────────────────────────────────────────────────────────
  const insCu = db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division,turno) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    carreras.forEach(c => {
      // Cosmiatría 1° año usa divisiones A y B (no 'U')
      if (c.id !== 'cosA') insCu.run(`${c.id}_1u`, c.id, 1, 'U', 'Nocturno');
      insCu.run(`${c.id}_2u`, c.id, 2, 'U', 'Nocturno');
    });
    // Cosmiatría tiene dos divisiones en 1er año (A y B)
    insCu.run('cosA_1a', 'cosA', 1, 'A', 'Nocturno');
    insCu.run('cosA_1b', 'cosA', 1, 'B', 'Nocturno');
  })();

  // ── DOCENTES ────────────────────────────────────────────────────────────────
  // [doc_id, titulo, nombre, apellido, especialidad, email]
  const docentes = [
    ['doc_alum',      'Abg.',  'César',       'Alum',             'Derecho',                    'c.alum@its.edu.py'],
    ['doc_sharp',     'Abg.',  'Gabriel',     'Sharp',            'Derecho / Matemática',       'g.sharp@its.edu.py'],
    ['doc_ocampos',   'Abg.',  'María Paz',   'Ocampos',          'Derecho Penal',              'm.ocampos@its.edu.py'],
    ['doc_carrillo',  'Abg.',  'Myrian',      'Carrillo',         'Derecho / Ética',            'm.carrillo@its.edu.py'],
    ['doc_rojas',     'Dr.',   'Favio',       'Rojas',            'Medicina',                   'f.rojas@its.edu.py'],
    ['doc_espinola',  'Dra.',  'Cinthia',     'Espínola',         'Farmacología',               'c.espinola@its.edu.py'],
    ['doc_valenz',    'Dra.',  'Natalia',     'Valenzuela',       'Salud Pública',              'n.valenzuela@its.edu.py'],
    ['doc_mareco',    'Ing.',  'Oscar',       'Mareco',           'Ingeniería Eléctrica',       'o.mareco@its.edu.py'],
    ['doc_gonzalez',  'Inst.', 'Karen',       'González',         'Instrumentación Quirúrgica', 'k.gonzalez@its.edu.py'],
    ['doc_ayala_a',   'Lic.',  'Ana',         'Ayala',            'Enfermería',                 'ana.ayala@its.edu.py'],
    ['doc_aranda',    'Lic.',  'Angela',      'Aranda',           'Química / Salud',            'a.aranda@its.edu.py'],
    ['doc_villar',    'Lic.',  'Blanca',      'Villar',           'Gestión en Salud',           'b.villar@its.edu.py'],
    ['doc_aguero',    'Lic.',  'Gabriela',    'Agüero',           'Farmacia',                   'g.aguero@its.edu.py'],
    ['doc_torales',   'Lic.',  'Jannyne',     'Torales',          'Psicología / Coaching',      'j.torales@its.edu.py'],
    ['doc_palacios',  'Lic.',  'Marcial',     'Palacios',         'Radiología',                 'm.palacios@its.edu.py'],
    ['doc_romero',    'Lic.',  'Micheli',     'Romero',           'Enfermería',                 'mi.romero@its.edu.py'],
    ['doc_gimenez',   'Lic.',  'Mirta',       'Giménez',          'Agropecuaria / Contabilidad','mir.gimenez@its.edu.py'],
    ['doc_natalia',   'Lic.',  'Natalia',     'Martínez',         'Psicología',                 'nat.martinez@its.edu.py'],
    ['doc_carmona',   'Lic.',  'Nelly',       'Carmona',          'Agropecuaria',               'n.carmona@its.edu.py'],
    ['doc_dominguez', 'Lic.',  'Nelson',      'Domínguez',        'Criminalística',             'n.dominguez@its.edu.py'],
    ['doc_ayala_n',   'Lic.',  'Noelia',      'Ayala',            'Cosmiatría',                 'noelia.ayala@its.edu.py'],
    ['doc_jimenez',   'Lic.',  'Pamela',      'Jiménez',          'Idiomas / Inglés',           'p.jimenez@its.edu.py'],
    ['doc_carballo',  'Lic.',  'Raqueline',   'Carballo',         'Cosmiatría',                 'r.carballo@its.edu.py'],
    ['doc_perez',     '',      'Maria Elena', 'Perez de Cantero', 'Lengua Castellana',          'me.perez@its.edu.py'],
    ['doc_higuchi',   'Rad.',  'Paulo',       'Higuchi',          'Radiología',                 'p.higuchi@its.edu.py'],
  ];

  const insU = db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol) VALUES (?,?,?,?,?,?)');
  const insD = db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,especialidad,titulo) VALUES (?,?,?,?)');
  const passDoc = bcrypt.hashSync('docente123', 10);
  db.transaction(() => {
    docentes.forEach(([did, titulo, nombre, apellido, esp, email]) => {
      const uid = 'u_' + did;
      insU.run(uid, nombre, apellido, email, passDoc, 'docente');
      insD.run(did, uid, esp, titulo);
    });
  })();

  // ── MATERIAS ────────────────────────────────────────────────────────────────
  // [carrera_id, nombre, anio, codigo]
  const materias = [
    // AGROPECUARIA
    ['agro', 'Inglés',                                    1, 'AGR-101'],
    ['agro', 'Apicultura',                                1, 'AGR-102'],
    ['agro', 'Deontología y Ética Profesional',           1, 'AGR-103'],
    ['agro', 'Productividad Agropecuaria',                1, 'AGR-104'],
    ['agro', 'Producción Porcina I',                      1, 'AGR-105'],
    ['agro', 'Equipos y Maquinarias Agropecuarias',       2, 'AGR-201'],
    ['agro', 'Cultivos, Forrajes y Pasturas',             2, 'AGR-202'],
    ['agro', 'Zootecnia',                                 2, 'AGR-203'],
    ['agro', 'Producción Porcina II',                     2, 'AGR-204'],
    ['agro', 'Inglés II',                                 2, 'AGR-205'],
    // CONTABILIDAD
    ['cont', 'Inglés',                                    1, 'CON-101'],
    ['cont', 'Castellano',                                1, 'CON-102'],
    ['cont', 'Contabilidad Básica',                       1, 'CON-103'],
    ['cont', 'Introducción a la Administración',          1, 'CON-104'],
    ['cont', 'Matemática',                                1, 'CON-105'],
    // COSMIATRÍA
    ['cosA', 'Anatomía y Fisiología Humana',              1, 'COS-101'],
    ['cosA', 'Biología de la Piel I / II',                1, 'COS-102'],
    ['cosA', 'Dermatología Básica / Técnicas Faciales',   1, 'COS-103'],
    ['cosA', 'Farmacología en Cosmiatría',                1, 'COS-104'],
    ['cosA', 'Salud Pública',                             1, 'COS-105'],
    ['cosA', 'Farmacología',                              1, 'COS-106'],
    ['cosA', 'Competencias Socioemocionales',             2, 'COS-201'],
    ['cosA', 'Química Cosmética',                         2, 'COS-202'],
    ['cosA', 'Semiología de la Piel I',                   2, 'COS-203'],
    ['cosA', 'Técnicas Cosméticas',                       2, 'COS-204'],
    ['cosA', 'Técnicas de Masajes y Drenaje Linfático',   2, 'COS-205'],
    // CRIMINALÍSTICA
    ['crim', 'Aspectos Legales del Peritaje',             1, 'CRM-101'],
    ['crim', 'Comunicación Escrita, Oral y Guaraní',      1, 'CRM-102'],
    ['crim', 'Deontología y Ética Profesional',           1, 'CRM-103'],
    ['crim', 'Introducción a la Criminalística',          1, 'CRM-104'],
    ['crim', 'Introducción al Derecho',                   1, 'CRM-105'],
    ['crim', 'Accidentología Vial',                       2, 'CRM-201'],
    ['crim', 'Criminología y Victimología',               2, 'CRM-202'],
    ['crim', 'Dibujo Técnico y Pericial',                 2, 'CRM-203'],
    ['crim', 'Química Aplicada a la Criminalística',      2, 'CRM-204'],
    // ELECTRICIDAD
    ['elec', 'Electrónica Analógica',                     2, 'ELC-201'],
    ['elec', 'Electrotecnia I',                           2, 'ELC-202'],
    ['elec', 'Inglés',                                    2, 'ELC-203'],
    ['elec', 'Maquinarias Eléctricas',                    2, 'ELC-204'],
    ['elec', 'Sistema de Potencia',                       2, 'ELC-205'],
    // ENFERMERÍA
    ['enf', 'Anatomía y Fisiología Humana',               1, 'ENF-101'],
    ['enf', 'Farmacología',                               1, 'ENF-102'],
    ['enf', 'Primeros Auxilios',                          1, 'ENF-103'],
    ['enf', 'Salud Pública',                              1, 'ENF-104'],
    ['enf', 'Ética Profesional',                          1, 'ENF-105'],
    ['enf', 'Enfermería Materno Infantil I',              2, 'ENF-201'],
    ['enf', 'Enfermería en Salud del Adulto I/II',        2, 'ENF-202'],
    ['enf', 'Ética y Legislación',                        2, 'ENF-203'],
    // FARMACIA
    ['farm', 'Anatomía y Fisiología Humana',              1, 'FAR-101'],
    ['farm', 'Calidad en Salud',                          1, 'FAR-102'],
    ['farm', 'Farmacología',                              1, 'FAR-103'],
    ['farm', 'Salud Pública',                             1, 'FAR-104'],
    ['farm', 'Ética Profesional',                         1, 'FAR-105'],
    ['farm', 'Lengua Extranjera – Inglés I',              1, 'FAR-106'],
    ['farm', 'Cosmetología Básica',                       2, 'FAR-201'],
    ['farm', 'Farmacotecnia II',                          2, 'FAR-202'],
    ['farm', 'Lengua Extranjera – Inglés II',             2, 'FAR-203'],
    ['farm', 'Química Inorgánica',                        2, 'FAR-204'],
    ['farm', 'Ética y Legislación',                       2, 'FAR-205'],
    // INSTRUMENTACIÓN QUIRÚRGICA
    ['instr', 'Anatomía y Fisiología Humana',             1, 'IQ-101'],
    ['instr', 'Calidad en Salud',                         1, 'IQ-102'],
    ['instr', 'Farmacología',                             1, 'IQ-103'],
    ['instr', 'Salud Pública',                            1, 'IQ-104'],
    ['instr', 'Ética Profesional',                        1, 'IQ-105'],
    ['instr', 'Medicina Legal y Ética',                   2, 'IQ-201'],
    ['instr', 'Patología Quirúrgica',                     2, 'IQ-202'],
    ['instr', 'Psicología General',                       2, 'IQ-203'],
    ['instr', 'Técnicas Quirúrgicas General y Especializada', 2, 'IQ-204'],
    // RADIOLOGÍA
    ['rad', 'Anatomía y Fisiología Humana',               1, 'RAD-101'],
    ['rad', 'Farmacología',                               1, 'RAD-102'],
    ['rad', 'Primeros Auxilios',                          1, 'RAD-103'],
    ['rad', 'Salud Pública',                              1, 'RAD-104'],
    ['rad', 'Ética Profesional',                          1, 'RAD-105'],
    ['rad', 'Administración Hospitalaria',                2, 'RAD-201'],
    ['rad', 'Física Radiológica',                         2, 'RAD-202'],
    ['rad', 'Prácticas Radiológicas III',                 2, 'RAD-203'],
    ['rad', 'Psicología',                                 2, 'RAD-204'],
    ['rad', 'Técnicas Radiológicas III',                  2, 'RAD-205'],
  ];

  const insM = db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    materias.forEach(([car, nombre, anio, cod]) => {
      const mid = 'm_' + cod.toLowerCase().replace(/[^a-z0-9]/g, '_');
      insM.run(mid, car, nombre, cod, 4, anio, 25, 25, 50);
    });
  })();

  // ── ASIGNACIONES (docente → materia → curso, extraídas del horario) ──────────
  if (periodo) {
    // [docente_id, materia_codigo, curso_id]
    const asigs = [
      // AGROPECUARIA
      ['doc_jimenez',   'AGR-101', 'agro_1u'],
      ['doc_carmona',   'AGR-102', 'agro_1u'],
      ['doc_alum',      'AGR-103', 'agro_1u'],
      ['doc_gimenez',   'AGR-104', 'agro_1u'],
      ['doc_gimenez',   'AGR-105', 'agro_1u'],
      ['doc_gimenez',   'AGR-201', 'agro_2u'],
      ['doc_gimenez',   'AGR-202', 'agro_2u'],
      ['doc_carmona',   'AGR-203', 'agro_2u'],
      ['doc_gimenez',   'AGR-204', 'agro_2u'],
      ['doc_jimenez',   'AGR-205', 'agro_2u'],
      // CONTABILIDAD
      ['doc_jimenez',   'CON-101', 'cont_1u'],
      ['doc_perez',     'CON-102', 'cont_1u'],
      ['doc_gimenez',   'CON-103', 'cont_1u'],
      ['doc_gimenez',   'CON-104', 'cont_1u'],
      ['doc_sharp',     'CON-105', 'cont_1u'],
      // COSMIATRÍA A - 1er año
      ['doc_higuchi',   'COS-101', 'cosA_1a'],
      ['doc_ayala_n',   'COS-102', 'cosA_1a'],
      ['doc_carballo',  'COS-103', 'cosA_1a'],
      ['doc_espinola',  'COS-104', 'cosA_1a'],
      ['doc_rojas',     'COS-105', 'cosA_1a'],
      // COSMIATRÍA B - 1er año
      ['doc_higuchi',   'COS-101', 'cosA_1b'],
      ['doc_carballo',  'COS-103', 'cosA_1b'],
      ['doc_valenz',    'COS-105', 'cosA_1b'],
      ['doc_espinola',  'COS-106', 'cosA_1b'],
      // COSMIATRÍA - 2do año
      ['doc_torales',   'COS-201', 'cosA_2u'],
      ['doc_ayala_n',   'COS-202', 'cosA_2u'],
      ['doc_rojas',     'COS-203', 'cosA_2u'],
      ['doc_carballo',  'COS-204', 'cosA_2u'],
      ['doc_carballo',  'COS-205', 'cosA_2u'],
      // CRIMINALÍSTICA
      ['doc_ocampos',   'CRM-101', 'crim_1u'],
      ['doc_perez',     'CRM-102', 'crim_1u'],
      ['doc_alum',      'CRM-103', 'crim_1u'],
      ['doc_dominguez', 'CRM-104', 'crim_1u'],
      ['doc_sharp',     'CRM-105', 'crim_1u'],
      ['doc_dominguez', 'CRM-201', 'crim_2u'],
      ['doc_dominguez', 'CRM-202', 'crim_2u'],
      ['doc_dominguez', 'CRM-203', 'crim_2u'],
      ['doc_aranda',    'CRM-204', 'crim_2u'],
      // ELECTRICIDAD
      ['doc_mareco',    'ELC-201', 'elec_2u'],
      ['doc_mareco',    'ELC-202', 'elec_2u'],
      ['doc_jimenez',   'ELC-203', 'elec_2u'],
      ['doc_mareco',    'ELC-204', 'elec_2u'],
      ['doc_mareco',    'ELC-205', 'elec_2u'],
      // ENFERMERÍA
      ['doc_higuchi',   'ENF-101', 'enf_1u'],
      ['doc_rojas',     'ENF-102', 'enf_1u'],
      ['doc_romero',    'ENF-103', 'enf_1u'],
      ['doc_ayala_a',   'ENF-104', 'enf_1u'],
      ['doc_carrillo',  'ENF-105', 'enf_1u'],
      ['doc_romero',    'ENF-201', 'enf_2u'],
      ['doc_ayala_a',   'ENF-202', 'enf_2u'],
      ['doc_carrillo',  'ENF-203', 'enf_2u'],
      // FARMACIA
      ['doc_rojas',     'FAR-101', 'farm_1u'],
      ['doc_villar',    'FAR-102', 'farm_1u'],
      ['doc_aguero',    'FAR-103', 'farm_1u'],
      ['doc_aranda',    'FAR-104', 'farm_1u'],
      ['doc_carrillo',  'FAR-105', 'farm_1u'],
      ['doc_jimenez',   'FAR-106', 'farm_1u'],
      ['doc_ayala_n',   'FAR-201', 'farm_2u'],
      ['doc_aguero',    'FAR-202', 'farm_2u'],
      ['doc_jimenez',   'FAR-203', 'farm_2u'],
      ['doc_aranda',    'FAR-204', 'farm_2u'],
      ['doc_carrillo',  'FAR-205', 'farm_2u'],
      // INSTRUMENTACIÓN QUIRÚRGICA
      ['doc_rojas',     'IQ-101',  'instr_1u'],
      ['doc_villar',    'IQ-102',  'instr_1u'],
      ['doc_aguero',    'IQ-103',  'instr_1u'],
      ['doc_aranda',    'IQ-104',  'instr_1u'],
      ['doc_carrillo',  'IQ-105',  'instr_1u'],
      ['doc_alum',      'IQ-201',  'instr_2u'],
      ['doc_rojas',     'IQ-202',  'instr_2u'],
      ['doc_natalia',   'IQ-203',  'instr_2u'],
      ['doc_gonzalez',  'IQ-204',  'instr_2u'],
      // RADIOLOGÍA
      ['doc_higuchi',   'RAD-101', 'rad_1u'],
      ['doc_rojas',     'RAD-102', 'rad_1u'],
      ['doc_romero',    'RAD-103', 'rad_1u'],
      ['doc_ayala_a',   'RAD-104', 'rad_1u'],
      ['doc_carrillo',  'RAD-105', 'rad_1u'],
      ['doc_aranda',    'RAD-201', 'rad_2u'],
      ['doc_higuchi',   'RAD-202', 'rad_2u'],
      ['doc_palacios',  'RAD-203', 'rad_2u'],
      ['doc_natalia',   'RAD-204', 'rad_2u'],
      ['doc_palacios',  'RAD-205', 'rad_2u'],
    ];

    const insA = db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)');
    db.transaction(() => {
      asigs.forEach(([doc_id, mat_cod, cur_id]) => {
        const mat = db.prepare('SELECT id FROM materias WHERE codigo=?').get(mat_cod);
        if (!mat) return;
        const asig_id = `asig_${doc_id}_${mat_cod}_${cur_id}`.replace(/[^a-z0-9_]/gi, '_');
        insA.run(asig_id, doc_id, mat.id, cur_id, periodo.id);
      });
    })();
  }

  console.log('✓ Instituto Técnico Superior Santísima Trinidad — datos cargados.');
  console.log('  Director : director@its.edu.py  /  director123');
  console.log('  Docentes : [su email]            /  docente123');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
function init() {
  crearTablas();
  // ── MIGRACIONES NO DESTRUCTIVAS ──────────────────────────────────────────────
  // Pagos
  try { db.prepare("ALTER TABLE pagos ADD COLUMN medio_pago TEXT DEFAULT 'Efectivo'").run(); } catch {}
  // Usuarios
  try { db.prepare("ALTER TABLE usuarios ADD COLUMN ci_raw TEXT").run(); } catch {}
  // Limpiar ci='' (string vacío) → NULL para evitar UNIQUE constraint duplicado entre docentes sin CI
  try {
    db.prepare("UPDATE usuarios SET ci=NULL WHERE ci='' OR ci='0.000.000'").run();
  } catch {}
  // Horarios (para bases antiguas que no tienen la tabla)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS horarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asignacion_id TEXT REFERENCES asignaciones(id),
      dia TEXT NOT NULL, turno INTEGER NOT NULL DEFAULT 1,
      hora_inicio TEXT NOT NULL DEFAULT '19:00',
      hora_fin TEXT NOT NULL DEFAULT '20:20', aula TEXT
    )`);
  } catch {}
  // Notas: columnas nuevas
  const colsNotas = ['tp1','tp2','tp3','tp4','tp5','tp_total','final_ord','final_recuperatorio','complementario','extraordinario','ausente'];
  colsNotas.forEach(col => {
    try { db.prepare(`ALTER TABLE notas ADD COLUMN ${col} ${col==='ausente'?'INTEGER DEFAULT 0':'REAL'}`).run(); } catch {}
  });
  // Alumnos: columnas que pueden faltar en DBs antiguas
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN ci TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN nombre TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN apellido TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN telefono TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN direccion TEXT").run(); } catch {}
  // Alumnos: habilitación especial de pago y bloqueo de notas
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN habilitado_pago_pendiente INTEGER DEFAULT 0").run(); } catch {}
  try { db.prepare("ALTER TABLE avisos ADD COLUMN destinatario TEXT DEFAULT 'todos'").run(); } catch {}
  try { db.prepare("ALTER TABLE institucion ADD COLUMN logo_base64 TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE habilitaciones_examen ADD COLUMN motivo TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE habilitaciones_examen ADD COLUMN habilitado_recuperatorio INTEGER DEFAULT 0").run(); } catch {}
  // Migración: expandir tipo_examen para soportar todos los tipos de examen
  try {
    const schRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='habilitaciones_examen'").get();
    if (schRow && schRow.sql && schRow.sql.includes("CHECK(tipo_examen IN ('parcial','final','extraordinario'))")) {
      db.exec(`CREATE TABLE IF NOT EXISTS habilitaciones_examen_v2 (
        id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, tipo_examen TEXT NOT NULL,
        asignacion_id TEXT, habilitado INTEGER NOT NULL DEFAULT 0, habilitado_por TEXT,
        motivo TEXT, fecha TEXT DEFAULT (date('now')), habilitado_recuperatorio INTEGER DEFAULT 0
      )`);
      db.exec(`INSERT OR IGNORE INTO habilitaciones_examen_v2
        SELECT id, alumno_id, tipo_examen, asignacion_id, habilitado, habilitado_por, motivo, fecha,
          COALESCE(habilitado_recuperatorio, 0)
        FROM habilitaciones_examen`);
      db.exec(`DROP TABLE habilitaciones_examen`);
      db.exec(`ALTER TABLE habilitaciones_examen_v2 RENAME TO habilitaciones_examen`);
      console.log('✓ Migración habilitaciones_examen: CHECK constraint expandido');
    }
  } catch(e) { console.error('Error migrando habilitaciones_examen:', e.message); }
  // Migración: expandir wa_mensajes.tipo para incluir 'bienvenida' — enviarBienvenidaQR()
  // insertaba tipo='bienvenida' pero el CHECK original no lo permitía, así que el INSERT
  // fallaba en silencio (capturado por el catch) y esos envíos nunca quedaban en el
  // Historial, sin forma de saber si el mensaje realmente había llegado o no.
  try {
    const schRowWA = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wa_mensajes'").get();
    if (schRowWA && schRowWA.sql && schRowWA.sql.includes("CHECK(tipo IN ('individual','masivo','programado','aviso'))")) {
      db.exec(`CREATE TABLE wa_mensajes_v2 (
        id TEXT PRIMARY KEY,
        tipo TEXT NOT NULL DEFAULT 'individual' CHECK(tipo IN ('individual','masivo','programado','aviso','bienvenida')),
        destinatario_tipo TEXT DEFAULT 'custom' CHECK(destinatario_tipo IN ('docente','alumno','custom')),
        destinatario_id TEXT,
        destinatario_nombre TEXT,
        destinatario_telefono TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        estado TEXT DEFAULT 'enviado' CHECK(estado IN ('enviado','fallido')),
        enviado_por TEXT,
        fecha TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec(`INSERT INTO wa_mensajes_v2 SELECT * FROM wa_mensajes`);
      db.exec(`DROP TABLE wa_mensajes`);
      db.exec(`ALTER TABLE wa_mensajes_v2 RENAME TO wa_mensajes`);
      console.log('✓ Migración wa_mensajes: CHECK de tipo expandido para incluir bienvenida');
    }
  } catch(e) { console.error('Error migrando wa_mensajes:', e.message); }
  try { db.prepare("ALTER TABLE materias ADD COLUMN dia TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN turno INTEGER").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN curso_id TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN docente_id TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_nombre TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_data BLOB").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_tipo TEXT").run(); } catch {}
  // Corrección: parciales pasan de 25 pts a 20 pts
  try { db.prepare("UPDATE examenes SET puntos_max=20 WHERE tipo='Parcial' AND puntos_max=25").run(); } catch {}
  // Eliminar curso fantasma cosA_1u (Cosmiatría 1° año div='U') — Cosmiatría usa A y B
  try { db.prepare("DELETE FROM cursos WHERE id='cosA_1u' AND NOT EXISTS (SELECT 1 FROM alumnos WHERE curso_id='cosA_1u') AND NOT EXISTS (SELECT 1 FROM asignaciones WHERE curso_id='cosA_1u')").run(); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS repositorio (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL CHECK(tipo IN ('programa','contenido')),
    materia_id TEXT REFERENCES materias(id),
    carrera_id TEXT REFERENCES carreras(id),
    curso_id TEXT REFERENCES cursos(id),
    nombre_archivo TEXT NOT NULL,
    datos BLOB NOT NULL,
    mime_tipo TEXT,
    subido_por TEXT REFERENCES usuarios(id),
    fecha TEXT NOT NULL,
    descripcion TEXT
  )`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS solicitudes_alumno (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    apellido TEXT,
    ci TEXT,
    asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
    docente_id TEXT NOT NULL REFERENCES docentes(id),
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
    registrado_por TEXT NOT NULL REFERENCES usuarios(id),
    fecha TEXT NOT NULL DEFAULT (datetime('now')),
    observacion TEXT
  )`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS solicitudes_registro (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    ci TEXT,
    telefono TEXT,
    carrera_id TEXT NOT NULL REFERENCES carreras(id),
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
    motivo_rechazo TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS solicitudes_egreso (
    id TEXT PRIMARY KEY,
    alumno_id TEXT NOT NULL REFERENCES alumnos(id),
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
    materias_aprobadas INTEGER NOT NULL DEFAULT 0,
    materias_total INTEGER NOT NULL DEFAULT 0,
    pagos_completos INTEGER NOT NULL DEFAULT 0,
    aprobado_por TEXT REFERENCES usuarios(id),
    fecha_solicitud TEXT NOT NULL DEFAULT (datetime('now')),
    fecha_resolucion TEXT,
    observacion TEXT
  )`); } catch {}
  try { db.prepare("ALTER TABLE docentes ADD COLUMN celular TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE solicitudes_registro ADD COLUMN curso_id TEXT").run(); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS constancias (id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'estudios', pago_id TEXT, fecha TEXT NOT NULL DEFAULT (date('now')), emitido_por TEXT, observacion TEXT)`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS deudas_cuotas (id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, periodo_id INTEGER NOT NULL, concepto TEXT NOT NULL, monto_total REAL NOT NULL, monto_pagado REAL NOT NULL DEFAULT 0, fecha_vencimiento TEXT, estado TEXT NOT NULL DEFAULT 'pendiente')`); } catch {}
  // Tablas de honorarios
  try { db.exec(`CREATE TABLE IF NOT EXISTS honorarios (id TEXT PRIMARY KEY, docente_id TEXT NOT NULL, asignacion_id TEXT, fecha TEXT NOT NULL, turno INTEGER NOT NULL DEFAULT 1, monto REAL NOT NULL DEFAULT 80000, estado TEXT NOT NULL DEFAULT 'generado', tipo TEXT NOT NULL DEFAULT 'clase', reemplazo_id TEXT, observacion TEXT, fecha_registro TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS reemplazos (id TEXT PRIMARY KEY, asignacion_id TEXT NOT NULL, docente_titular_id TEXT NOT NULL, docente_reemplazante_id TEXT NOT NULL, fecha TEXT NOT NULL, turno INTEGER NOT NULL DEFAULT 1, motivo TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', registrado_por TEXT NOT NULL, aprobado_por TEXT, fecha_aprobacion TEXT, fecha_registro TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS feriados (id TEXT PRIMARY KEY, fecha TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'nacional', activo INTEGER NOT NULL DEFAULT 1)`); } catch {}
  // Comprobantes de transferencia recibidos por WhatsApp, pendientes de aprobación
  try { db.exec(`CREATE TABLE IF NOT EXISTS pagos_pendientes_wa (
    id TEXT PRIMARY KEY,
    numero TEXT NOT NULL,
    nombre_contacto TEXT,
    alumno_id TEXT REFERENCES alumnos(id),
    imagen_data TEXT NOT NULL,
    imagen_mime TEXT NOT NULL DEFAULT 'image/jpeg',
    mensaje_texto TEXT,
    estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','Aprobado','Rechazado')),
    pago_id TEXT REFERENCES pagos(id),
    resuelto_por TEXT,
    fecha_resolucion TEXT,
    monto_sugerido REAL,
    fecha_sugerida TEXT,
    nombre_detectado TEXT,
    banco_detectado TEXT,
    referencia_detectada TEXT,
    ia_estado TEXT DEFAULT 'pendiente',
    estado_transferencia_ia TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`); } catch {}
  // Configuración editable del sistema (plantillas WA, etc.)
  try { db.exec(`CREATE TABLE IF NOT EXISTS configuracion (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, descripcion TEXT)`); } catch {}
  // Registro de notificaciones WA enviadas (evita duplicados)
  try { db.exec(`CREATE TABLE IF NOT EXISTS notif_wa_enviadas (examen_id TEXT NOT NULL, intervalo TEXT NOT NULL, fecha_envio TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(examen_id, intervalo))`); } catch {}
  // ── WHATSAPP GESTIÓN ──────────────────────────────────────────────────────────
  // Historial de mensajes enviados (individual, masivo, programado)
  try { db.exec(`CREATE TABLE IF NOT EXISTS wa_mensajes (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL DEFAULT 'individual' CHECK(tipo IN ('individual','masivo','programado','aviso')),
    destinatario_tipo TEXT DEFAULT 'custom' CHECK(destinatario_tipo IN ('docente','alumno','custom')),
    destinatario_id TEXT,
    destinatario_nombre TEXT,
    destinatario_telefono TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    estado TEXT DEFAULT 'enviado' CHECK(estado IN ('enviado','fallido')),
    enviado_por TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  // Mensajes programados para envío futuro
  try { db.exec(`CREATE TABLE IF NOT EXISTS wa_programados (
    id TEXT PRIMARY KEY,
    titulo TEXT,
    destinatario_tipo TEXT NOT NULL DEFAULT 'masivo' CHECK(destinatario_tipo IN ('masivo','individual')),
    destinatario_id TEXT,
    destinatario_nombre TEXT,
    destinatario_telefono TEXT,
    mensaje TEXT NOT NULL,
    fecha_envio TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','enviado','cancelado')),
    creado_por TEXT,
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  // Mensajes recibidos (via webhook Evolution API)
  try { db.exec(`CREATE TABLE IF NOT EXISTS wa_recibidos (
    id TEXT PRIMARY KEY,
    numero TEXT NOT NULL,
    nombre_contacto TEXT,
    mensaje TEXT NOT NULL,
    leido INTEGER NOT NULL DEFAULT 0,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  // Control de recordatorios automáticos de carga de examen
  try { db.exec(`CREATE TABLE IF NOT EXISTS wa_recordatorios_examen (
    id TEXT PRIMARY KEY,
    examen_id TEXT NOT NULL,
    docente_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'enviado',
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  try { db.prepare("CREATE INDEX IF NOT EXISTS idx_wa_rec_examen ON wa_recordatorios_examen(examen_id, tipo, fecha)").run(); } catch {}
  // Plantillas WA por defecto (INSERT OR IGNORE para no sobreescribir ediciones)
  const insConf = db.prepare('INSERT OR IGNORE INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)');
  insConf.run('wa_tpl_72h',
    '📚 *ITS Santísima Trinidad*\nHola Prof. {docente}, le recordamos que en *3 días* tiene programado:\n\n📋 *{tipo}* de {materia}\n🎓 {carrera} {curso}\n📅 {fecha}  🕐 {hora}\n\nPor favor tenga lista el material necesario.',
    'Mensaje WhatsApp 72 horas antes del examen');
  insConf.run('wa_tpl_48h',
    '⏰ *ITS Santísima Trinidad*\nHola Prof. {docente}, le recordamos que en *2 días* tiene programado:\n\n📋 *{tipo}* de {materia}\n🎓 {carrera} {curso}\n📅 {fecha}  🕐 {hora}\n\nRecuerde preparar el acta de examen.',
    'Mensaje WhatsApp 48 horas antes del examen');
  insConf.run('wa_tpl_36h',
    '📋 *ITS Santísima Trinidad*\nHola Prof. {docente}, le recordamos que en *36 horas* tiene programado:\n\n📋 *{tipo}* de {materia}\n🎓 {carrera} {curso}\n📅 {fecha}  🕐 {hora}\n\nRecuerde preparar el acta y los materiales del examen.',
    'Mensaje WhatsApp 36 horas antes del examen');
  insConf.run('wa_tpl_24h',
    '🔔 *ITS Santísima Trinidad*\nHola Prof. {docente}, *mañana* tiene programado:\n\n📋 *{tipo}* de {materia}\n🎓 {carrera} {curso}\n📅 {fecha}  🕐 {hora}\n\nNo olvide traer el acta de examen y los materiales necesarios. ¡Éxitos!',
    'Mensaje WhatsApp 24 horas antes del examen');
  insConf.run('wa_tpl_puntajes',
    '⚠️ *Aviso Institucional — Carga de Puntajes Pendiente*\n\nProf. {docente}:\n\nEl *{tipo}* de *{materia}* ({carrera} — {curso}) se realizó hace *{dias} días* y a la fecha *no figura ningún puntaje registrado* en el sistema.\n\nLa institución requiere que los puntajes sean cargados con la mayor brevedad posible. Los alumnos no pueden acceder a sus calificaciones hasta que esto sea completado.\n\n*Ingrese al portal institucional y regularice la situación a la brevedad.*\n\n_Dirección Académica — ITS Santísima Trinidad._',
    'Aviso diario: puntajes sin cargar 8+ días después del examen');
  // Índices honorarios
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_honorarios_docente ON honorarios(docente_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_honorarios_fecha ON honorarios(fecha)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_reemplazos_fecha ON reemplazos(fecha)'); } catch {}
  // Tabla auditoría para bases existentes
  try { db.exec(`CREATE TABLE IF NOT EXISTS auditoria (id TEXT PRIMARY KEY, usuario_id TEXT NOT NULL, accion TEXT NOT NULL, tabla TEXT NOT NULL, registro_id TEXT, detalle TEXT, fecha TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  // Crear tablas nuevas si no existen
  try { db.exec(`CREATE TABLE IF NOT EXISTS aranceles (
    id TEXT PRIMARY KEY, concepto TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    tipo TEXT NOT NULL DEFAULT 'cuota', carrera_id TEXT, descripcion TEXT, activo INTEGER DEFAULT 1,
    fecha_actualizacion TEXT DEFAULT (date('now')))`); } catch {}
  // Migración: agregar columna fecha_actualizacion a aranceles si no existe (bases de datos existentes)
  try { db.exec(`ALTER TABLE aranceles ADD COLUMN fecha_actualizacion TEXT DEFAULT (date('now'))`); } catch {}
  // Migración: agregar columna anio a aranceles (para diferenciar por año de cursado)
  try { db.exec(`ALTER TABLE aranceles ADD COLUMN anio INTEGER`); } catch {}
  // Aranceles diferenciados por año (1° y 2°)
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO aranceles (id,concepto,tipo,monto,anio,descripcion,activo) VALUES (?,?,?,?,?,?,1)');
    ins.run('ar_cuota_1anio','Cuota mensual 1° año','cuota',300000,1,'Cuota para alumnos de primer año');
    ins.run('ar_cuota_2anio','Cuota mensual 2° año','cuota',400000,2,'Cuota para alumnos de segundo año');
  } catch {}
  // Migración: permitir carrera_id NULL en alumnos (para alumnos "sin asignar")
  try {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='alumnos'").get();
    if (info && info.sql && info.sql.includes('carrera_id TEXT NOT NULL')) {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        CREATE TABLE alumnos_new (
          id TEXT PRIMARY KEY, usuario_id TEXT REFERENCES usuarios(id),
          matricula TEXT UNIQUE, carrera_id TEXT REFERENCES carreras(id),
          curso_id TEXT REFERENCES cursos(id), fecha_ingreso TEXT,
          estado TEXT NOT NULL DEFAULT 'Activo' CHECK(estado IN ('Activo','Inactivo','Egresado','Retirado')),
          ci TEXT, nombre TEXT, apellido TEXT, telefono TEXT, email TEXT
        );
        INSERT INTO alumnos_new SELECT id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido,telefono,NULL FROM alumnos;
        DROP TABLE alumnos;
        ALTER TABLE alumnos_new RENAME TO alumnos;
        CREATE INDEX IF NOT EXISTS idx_alumnos_carrera ON alumnos(carrera_id);
        CREATE INDEX IF NOT EXISTS idx_alumnos_curso ON alumnos(curso_id);
        CREATE INDEX IF NOT EXISTS idx_alumnos_estado ON alumnos(estado);
        PRAGMA foreign_keys=ON;
      `);
    }
  } catch(e) { console.warn('Migración alumnos carrera_id nullable:', e.message); }
  // Migración: director_pts en notas (10 pts asignados por dirección)
  try { db.prepare('ALTER TABLE notas ADD COLUMN director_pts REAL').run(); } catch {}
  // Migración: normalizar tipo de examen a mayúscula inicial
  try { db.prepare("UPDATE examenes SET tipo='Parcial' WHERE tipo='parcial'").run(); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS habilitaciones_examen (
    id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, tipo_examen TEXT NOT NULL,
    asignacion_id TEXT, habilitado INTEGER DEFAULT 0, habilitado_por TEXT, motivo TEXT, fecha TEXT DEFAULT (date('now')))`); } catch {}
  // Seed aranceles por defecto si está vacío
  if (db.prepare('SELECT COUNT(*) as n FROM aranceles').get().n === 0) {
    const ins = db.prepare('INSERT INTO aranceles (id,concepto,tipo,monto) VALUES (?,?,?,?)');
    [['ar1','Matrícula','matricula',500000],['ar2','Cuota mensual','cuota',350000],
     ['ar3','Examen Parcial Ordinario','parcial',150000],['ar4','Examen Parcial Recuperatorio','parcial',150000],
     ['ar5','Examen Final Ordinario','final',200000],['ar6','Examen Final Recuperatorio (Complementario)','final',200000],
     ['ar7','Examen Extraordinario','extraordinario',300000],['ar8','Certificado de estudios','certificado',100000]
    ].forEach(([id,concepto,tipo,monto])=>ins.run(id,concepto,tipo,monto));
  }
  // Tabla actividades para calendario académico
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS actividades (
      id TEXT PRIMARY KEY, titulo TEXT NOT NULL, descripcion TEXT,
      fecha TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'otros',
      carrera_id TEXT, materia_id TEXT, usuario_id TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      fecha_creacion TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch {}
  // Asignaciones: horario embebido (día y turno para el horario semanal)
  try { db.prepare("ALTER TABLE asignaciones ADD COLUMN dia TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE asignaciones ADD COLUMN turno INTEGER DEFAULT 1").run(); } catch {}
  try { db.prepare("ALTER TABLE asignaciones ADD COLUMN hora_inicio TEXT DEFAULT '19:00'").run(); } catch {}
  try { db.prepare("ALTER TABLE asignaciones ADD COLUMN hora_fin TEXT DEFAULT '20:20'").run(); } catch {}
  try { db.prepare("ALTER TABLE asignaciones ADD COLUMN aula TEXT").run(); } catch {}
  // Examenes: nombre_custom para unificaciones
  try { db.prepare("ALTER TABLE examenes ADD COLUMN nombre_custom TEXT").run(); } catch {}
  // Tabla de conflictos de horario (para avisos automáticos)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS conflictos_horario (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      asignacion_id TEXT,
      resuelto INTEGER DEFAULT 0,
      fecha_deteccion TEXT DEFAULT (date('now'))
    )`);
  } catch {}
  // Cierre y Promoción Semestral: registro formal de la decisión de promoción por alumno+periodo de origen
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS promocion_semestral (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      periodo_origen_id INTEGER NOT NULL REFERENCES periodos(id),
      periodo_destino_id INTEGER REFERENCES periodos(id),
      estado TEXT NOT NULL CHECK(estado IN ('Promovido','Promovido con Extraordinario Pendiente','No Habilitado')),
      fecha_promocion TEXT NOT NULL DEFAULT (datetime('now')),
      promovido_por TEXT,
      UNIQUE(alumno_id, periodo_origen_id)
    )`);
  } catch {}
  // Materias con nota 1 en el periodo de origen: quedan pendientes de rendir en el extraordinario de diciembre
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS extraordinarios_pendientes (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      nota_original INTEGER NOT NULL,
      periodo_origen_id INTEGER NOT NULL REFERENCES periodos(id),
      estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','Aprobado','Reprobado')),
      nota_extraordinario REAL,
      fecha_rendicion TEXT,
      fecha_creacion TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(alumno_id, asignacion_id)
    )`);
  } catch {}
  // Tabla de alumnos faltantes (registro rápido para identificación)
  try { db.exec(`CREATE TABLE IF NOT EXISTS alumnos_faltantes (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    carrera_id TEXT NOT NULL REFERENCES carreras(id),
    ci TEXT,
    registrado_por TEXT NOT NULL,
    fecha_registro TEXT NOT NULL DEFAULT (datetime('now'))
  )`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS actas_examen (
    id TEXT PRIMARY KEY,
    asignacion_id TEXT NOT NULL,
    tipo_examen TEXT NOT NULL,
    docente_id TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'cerrada',
    alumnos_faltantes TEXT,
    observacion TEXT,
    desbloqueada_por TEXT,
    motivo_desbloqueo TEXT,
    fecha_cierre TEXT NOT NULL DEFAULT (datetime('now')),
    fecha_desbloqueo TEXT
  )`); } catch {}
  try { db.prepare('ALTER TABLE actas_examen ADD COLUMN periodo_id INTEGER').run(); } catch {}
  seedDatos();
  seedHorarios();
  migrateMatrixV2();
  migrateMatrixV3();
  migrarMateriasParciales();   // agrega materias/asignaciones faltantes del cronograma
  seedExamenesParciales();     // BACKUP PERMANENTE — siempre restaura exámenes faltantes
  // Recalcular tp_total en registros donde es NULL pero hay TPs cargados
  try {
    const fixed = db.prepare(`
      UPDATE notas SET tp_total = (
        COALESCE(tp1,0) + COALESCE(tp2,0) + COALESCE(tp3,0) + COALESCE(tp4,0)
      )
      WHERE tp_total IS NULL
        AND (tp1 IS NOT NULL OR tp2 IS NOT NULL OR tp3 IS NOT NULL OR tp4 IS NOT NULL)
    `).run();
    if (fixed.changes > 0) console.log(`[DB] Recalculados tp_total en ${fixed.changes} registros`);
  } catch(e) { console.warn('[DB] No se pudo recalcular tp_total:', e.message); }
  // Liberación manual del bloqueo de notas por mora (independiente de habilitado_pago_pendiente,
  // que solo habilita exámenes) — el director puede liberar el acceso a "Mis notas" alumno por
  // alumno, pero SOLO por 48hs (vence solo, sin cron: se compara contra la fecha al consultar).
  try { db.prepare('ALTER TABLE alumnos ADD COLUMN notas_liberadas_hasta TEXT').run(); } catch {}
  // Limpieza puntual: solicitudes de prueba insertadas al reproducir en vivo el bug
  // del QR de autorregistro (2026-07-23) — no son alumnos reales.
  try {
    const testCIs = ['9999999', '8888888'];
    testCIs.forEach(ci => {
      db.prepare("DELETE FROM solicitudes_registro WHERE ci=? AND nombre LIKE 'TestClaude%'").run(ci);
    });
  } catch(e) { console.warn('[DB] Limpieza solicitudes de prueba:', e.message); }

  // Carga puntual (2026-07-23): puntajes de Técnicas Radiológicas III (prof. Marcial
  // Palacios) entregados por planilla del director. Se busca al alumno por CI (algunos
  // traían un dígito mal tipeado en la planilla, corregido acá contra la CI real) y se
  // carga en `final_ord` — único campo vacío para todos ellos en esa asignación.
  try {
    const asigTecRad = 'asig_doc_palacios_RAD_205_rad_2u';
    const puntajesTecRad = [
      ['6938023', 44], ['4798278', 46], ['3963900', 42], ['7363571', 38],
      ['7760902', 50], ['7290257', 40], ['4689552', 38], ['3240933', 32],
      ['7133874', 44], ['7396069', 50], ['3870521', 40], ['5097018', 42],
      ['7464341', 40], ['3421194', 46], ['7379468', 50], ['5942567', 40],
      ['6629243', 40], ['5000861', 46], ['6600844', 38], ['7044329', 42],
    ];
    const asigExiste = db.prepare('SELECT id FROM asignaciones WHERE id=?').get(asigTecRad);
    if (asigExiste) {
      let cargados = 0;
      puntajesTecRad.forEach(([ci, puntaje]) => {
        const al = db.prepare('SELECT id FROM alumnos WHERE ci=?').get(ci);
        if (!al) { console.warn(`[Carga TecRad] No se encontró alumno con CI ${ci}`); return; }
        const actual = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(al.id, asigTecRad);
        if (!actual || actual.final_ord !== null) return; // ya tiene un valor — no pisar
        const r = calcularPuntaje(actual.tp1, actual.tp2, actual.tp3, actual.tp4, actual.tp5,
          actual.parcial, actual.parcial_recuperatorio, puntaje, actual.final_recuperatorio,
          actual.complementario, actual.extraordinario, actual.director_pts);
        db.prepare(`UPDATE notas SET final_ord=?, final_efectivo=?, puntaje_total=?, nota_final=?, estado=? WHERE id=?`)
          .run(puntaje, r.final_ef, r.puntaje, r.nota, r.estado, actual.id);
        cargados++;
      });
      if (cargados > 0) console.log(`[Carga TecRad] ✓ ${cargados} puntajes de Técnicas Radiológicas III (Palacios) cargados`);
    }
  } catch(e) { console.warn('[DB] Carga puntajes TecRad:', e.message); }

  // Carga puntual (2026-07-25): Examen Final de Introducción al Derecho (Criminalística
  // 1er año, prof. Gabriel Villalba Sharp), planilla "planilla_examen_final.xlsx". Se
  // busca por CI; un alumno de la planilla no traía CI ("Rosalba Martinez Villalba") y
  // se identificó por coincidencia exacta de nombre/apellido dentro de esa misma sección.
  try {
    const asigDerecho = 'asig_doc_sharp_CRM_105_crim_1u';
    const puntajesDerecho = [
      ['5596356', 25], ['5312991', 50], ['6917673', 43], ['5284217', 44],
      ['9259490', 20], ['8118459', 30], ['9444970', 50], ['4431023', 50],
      ['5900461', 39], ['6146486', 37], ['6826530', 20], ['8959709', 46],
      ['8541571', 38], ['7044175', 28], ['6100827', 34], ['6820340', 17],
      ['7255653', 50], ['7060617', 16], ['6324832', 50], ['8421897', 31],
    ];
    const asigExisteDer = db.prepare('SELECT id FROM asignaciones WHERE id=?').get(asigDerecho);
    if (asigExisteDer) {
      let cargados = 0;
      puntajesDerecho.forEach(([ci, puntaje]) => {
        const al = db.prepare('SELECT id FROM alumnos WHERE ci=?').get(ci);
        if (!al) { console.warn(`[Carga Derecho] No se encontró alumno con CI ${ci}`); return; }
        const actual = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(al.id, asigDerecho);
        if (!actual || actual.final_ord !== null) return; // ya tiene un valor — no pisar
        const r = calcularPuntaje(actual.tp1, actual.tp2, actual.tp3, actual.tp4, actual.tp5,
          actual.parcial, actual.parcial_recuperatorio, puntaje, actual.final_recuperatorio,
          actual.complementario, actual.extraordinario, actual.director_pts);
        db.prepare(`UPDATE notas SET final_ord=?, final_efectivo=?, puntaje_total=?, nota_final=?, estado=? WHERE id=?`)
          .run(puntaje, r.final_ef, r.puntaje, r.nota, r.estado, actual.id);
        cargados++;
      });
      if (cargados > 0) console.log(`[Carga Derecho] ✓ ${cargados} puntajes de Introducción al Derecho (Criminalística 1°) cargados`);
    }
  } catch(e) { console.warn('[DB] Carga puntajes Introducción al Derecho:', e.message); }

  // Dirección real del instituto (2026-07-30), confirmada por el director vía Google Maps:
  // UAL Universidad Autónoma de Luque, Jóvenes por la Democracia casi esquina — Pedro Juan
  // Caballero. Reemplaza el valor genérico "Pedro Juan Caballero, Amambay, Paraguay".
  try {
    db.prepare("UPDATE institucion SET direccion=? WHERE id=1 AND direccion='Pedro Juan Caballero, Amambay, Paraguay'")
      .run('Jóvenes por la Democracia casi Esq., Pedro Juan Caballero, Amambay, Paraguay');
  } catch(e) { console.warn('[DB] Actualizar dirección institución:', e.message); }
  autoBackup(db, DB_PATH);     // copia de seguridad automática si hay alumnos
  console.log('✓ Base de datos lista en:', DB_PATH);
}

module.exports = { db, init, calcularPuntaje, mergeCamposNota, seedHorarios, migrateMatrixV2, migrateMatrixV3, DB_PATH };

// ── MIGRACIÓN DE MATERIAS — agrega materias/asignaciones faltantes del cronograma PDF ──
function migrarMateriasParciales() {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();

  // 1. Renombrar 'Dermatología Básica / Técnicas Faciales' → 'Técnicas Faciales' (materia propia)
  db.prepare("UPDATE materias SET nombre='Técnicas Faciales' WHERE codigo='COS-103' AND nombre LIKE '%Dermatología%'").run();

  // 2. Agregar materia 'Dermatología Básica' (COS-107) si no existe
  db.prepare("INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES ('m_cos_107','cosA','Dermatología Básica','COS-107',4,1,25,25,50)").run();

  // 3. Agregar materias faltantes del cronograma
  const extraMat = [
    ['m_crm_205','crim','Fotografía Pericial',         'CRM-205',4,2],
    ['m_iq_205', 'instr','Bioseguridad',               'IQ-205', 4,2],
    ['m_enf_204','enf', 'Nutrición y Dietoterapia',    'ENF-204',4,2],
    ['m_enf_205','enf', 'Farmacología',                'ENF-205',4,2], // Farmacología Enfermería 2°
  ];
  const insM = db.prepare("INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,25,25,50)");
  extraMat.forEach(([id,car,nom,cod,h,anio]) => insM.run(id,car,nom,cod,h,anio));

  if (!periodo) return; // sin período activo, no agregar asignaciones

  // 4. Agregar asignaciones faltantes
  const getDocente = email => db.prepare('SELECT id FROM docentes WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE ?)').get(email);
  const getCurso   = id    => db.prepare('SELECT id FROM cursos WHERE id=?').get(id);
  const insA = db.prepare("INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)");

  // doc_carballo → Dermatología Básica (COS-107) para cosA_1a y cosA_1b
  const docCarballo = getDocente('%carballo%');
  if (docCarballo) {
    if (getCurso('cosA_1a')) insA.run('asig_cos107_1a', docCarballo.id, 'm_cos_107', 'cosA_1a', periodo.id);
    if (getCurso('cosA_1b')) insA.run('asig_cos107_1b', docCarballo.id, 'm_cos_107', 'cosA_1b', periodo.id);
  }
  // doc_dominguez → Fotografía Pericial (CRM-205) para crim_2u
  const docDominguez = getDocente('%dominguez%');
  if (docDominguez && getCurso('crim_2u')) insA.run('asig_crm205_2u', docDominguez.id, 'm_crm_205', 'crim_2u', periodo.id);

  // doc_valenz → Bioseguridad (IQ-205) para instr_2u
  const docValenz = getDocente('%valenz%');
  if (docValenz && getCurso('instr_2u')) insA.run('asig_iq205_2u', docValenz.id, 'm_iq_205', 'instr_2u', periodo.id);

  // doc_ayala_n → Nutrición y Dietoterapia (ENF-204) para enf_2u
  const docAyalaN = getDocente('%noelia%');
  if (docAyalaN && getCurso('enf_2u')) insA.run('asig_enf204_2u', docAyalaN.id, 'm_enf_204', 'enf_2u', periodo.id);

  // doc_rojas → Farmacología Enfermería 2° (ENF-205) para enf_2u
  const docRojas = getDocente('%rojas%');
  if (docRojas && getCurso('enf_2u')) insA.run('asig_enf205_2u', docRojas.id, 'm_enf_205', 'enf_2u', periodo.id);

  console.log('✓ Materias/asignaciones del cronograma verificadas');
}

// ── SEED EXÁMENES PARCIALES ITS 2026 — BACKUP PERMANENTE ─────────────────────
// Fuente: Cronograma Oficial PDF + instrucciones de la Dirección
// Se ejecuta en CADA arranque del servidor → INSERT OR IGNORE → NUNCA pierde datos
// Si alguien borra exámenes, se restauran automáticamente en el próximo reinicio
function seedExamenesParciales() {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) { console.log('⚠ Sin período activo — seed de exámenes omitido'); return; }

  // Queries: sin sección y con sección (division A/B/U)
  const qA  = db.prepare(`SELECT a.id FROM asignaciones a JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id WHERE ca.nombre LIKE ? AND cu.anio=? AND m.nombre LIKE ? LIMIT 1`);
  const qAs = db.prepare(`SELECT a.id FROM asignaciones a JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id WHERE ca.nombre LIKE ? AND cu.anio=? AND cu.division=? AND m.nombre LIKE ? LIMIT 1`);
  const qIn = db.prepare('INSERT OR IGNORE INTO examenes (id,asignacion_id,tipo,fecha,hora,periodo_id,puntos_max) VALUES (?,?,?,?,?,?,?)');
  let creados=0, omitidos=0;

  // ins(id, carrera, anio, materia, fecha, hora [, seccion])
  const ins = (id,car,anio,mat,fecha,hora,sec) => {
    const a = sec ? qAs.get(car,anio,sec,mat) : qA.get(car,anio,mat);
    if(!a){ console.log('  ⚠ Sin asignación:',mat,'|',car,anio,(sec||'')); omitidos++; return; }
    const r = qIn.run(id,a.id,'Parcial',fecha,hora,periodo.id,20);
    if(r.changes>0) creados++; else omitidos++;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // SEMANA 1 — 11 al 13 de mayo 2026
  // ════════════════════════════════════════════════════════════════════════════

  // LUNES 11/05 ─────────────────────────────────────────────────────────────
  ins('ep_011_01','%Enfermer%', 2,'%Enfermería Materno%',          '2026-05-11','19:00');
  ins('ep_011_02','%Radiolog%', 2,'%Física Radiológ%',             '2026-05-11','19:00');
  ins('ep_011_03','%Instrume%', 2,'%Patología Quirú%',             '2026-05-11','19:00');
  ins('ep_011_04','%Enfermer%', 1,'%Salud Pública%',               '2026-05-11','19:00'); // unificado
  ins('ep_011_05','%Radiolog%', 1,'%Salud Pública%',               '2026-05-11','19:00'); // unificado
  ins('ep_011_06','%Farmacia%', 1,'%Salud Pública%',               '2026-05-11','19:00'); // unificado
  ins('ep_011_07','%Instrume%', 1,'%Salud Pública%',               '2026-05-11','19:00'); // unificado
  ins('ep_011_08','%Farmacia%', 2,'%Química Inorgán%',             '2026-05-11','20:40');

  // MARTES 12/05 — Raqueline Carballo: Técnicas Faciales SIEMPRE EN MARTES ──
  // 1er turno (19:00): cosA 1° Secc.A
  ins('ep_012_01','%Cosmiatr%', 1,'%Técnicas Faciale%',            '2026-05-12','19:00','A');
  // 2do turno (20:40): cosA 1° Secc.B
  ins('ep_012_02','%Cosmiatr%', 1,'%Técnicas Faciale%',            '2026-05-12','20:40','B');
  // Otros exámenes del día
  ins('ep_012_03','%Cosmiatr%', 1,'%Anatomía y Fisi%',             '2026-05-12','19:00','B'); // Higuchi
  ins('ep_012_04','%Cosmiatr%', 2,'%Química Cosméti%',             '2026-05-12','19:00');     // Noelia Ayala
  ins('ep_012_05','%Criminal%', 2,'%Dibujo Técnico%',              '2026-05-12','19:00');     // Domínguez

  // MIÉRCOLES 13/05 ─────────────────────────────────────────────────────────
  // 1er turno unificados
  ins('ep_013_01','%Criminal%', 1,'%Comunicación Es%',             '2026-05-13','19:00'); // Perez de Cantero
  ins('ep_013_02','%Contabil%', 1,'%Castellano%',                  '2026-05-13','19:00'); // Perez de Cantero (unificado)
  ins('ep_013_03','%Agropecu%', 1,'%Inglés%',                      '2026-05-13','19:00'); // Jiménez unificado
  ins('ep_013_04','%Agropecu%', 2,'%Inglés%',                      '2026-05-13','19:00'); // unificado
  ins('ep_013_05','%Electric%', 2,'%Inglés%',                      '2026-05-13','19:00'); // unificado
  // 2do turno
  ins('ep_013_06','%Radiolog%', 2,'%Administración %',             '2026-05-13','20:40'); // Aranda
  ins('ep_013_07','%Farmacia%', 1,'%Calidad en Salu%',             '2026-05-13','20:40'); // Villar unificado
  ins('ep_013_08','%Instrume%', 1,'%Calidad en Salu%',             '2026-05-13','20:40'); // unificado
  ins('ep_013_09','%Enfermer%', 2,'%Ética y Legisla%',             '2026-05-13','20:40'); // Carrillo unificado
  ins('ep_013_10','%Farmacia%', 2,'%Ética y Legisla%',             '2026-05-13','20:40'); // unificado
  ins('ep_013_11','%Enfermer%', 1,'%Primeros Auxili%',             '2026-05-13','20:40'); // Romero unificado
  ins('ep_013_12','%Radiolog%', 1,'%Primeros Auxili%',             '2026-05-13','20:40'); // unificado
  ins('ep_013_13','%Instrume%', 2,'%Técnicas Quirúr%',             '2026-05-13','20:40'); // González

  // ════════════════════════════════════════════════════════════════════════════
  // SEMANA 2 — 18 al 22 de mayo 2026
  // ════════════════════════════════════════════════════════════════════════════

  // LUNES 18/05 ─────────────────────────────────────────────────────────────
  ins('ep_018_01','%Enfermer%', 1,'%Anatomía y Fisi%',             '2026-05-18','20:40'); // Higuchi unificado
  ins('ep_018_02','%Radiolog%', 1,'%Anatomía y Fisi%',             '2026-05-18','20:40'); // unificado
  ins('ep_018_03','%Farmacia%', 1,'%Anatomía y Fisi%',             '2026-05-18','20:40'); // Rojas unificado
  ins('ep_018_04','%Instrume%', 1,'%Anatomía y Fisi%',             '2026-05-18','20:40'); // unificado
  ins('ep_018_05','%Enfermer%', 2,'%Enfermería en Sa%',            '2026-05-18','20:40'); // Ayala
  ins('ep_018_06','%Radiolog%', 2,'%Técnicas Radiol%',             '2026-05-18','20:40'); // Palacios

  // MARTES 19/05 — Raqueline cosA 1°B MOVIDA A 12/05 por instrucción de Dirección ──
  ins('ep_019_01','%Electric%', 2,'%Electrónica Ana%',             '2026-05-19','19:00'); // Mareco
  ins('ep_019_02','%Agropecu%', 2,'%Equipos y Maqui%',            '2026-05-19','19:00'); // Giménez
  ins('ep_019_03','%Cosmiatr%', 1,'%Biología de la %',             '2026-05-19','20:40','A'); // Noelia Ayala
  ins('ep_019_04','%Criminal%', 2,'%Fotografía Pericia%',          '2026-05-19','20:40'); // Domínguez
  ins('ep_019_05','%Agropecu%', 1,'%Deontología%',                 '2026-05-19','20:40'); // Alum unificado
  ins('ep_019_06','%Criminal%', 1,'%Deontología y É%',             '2026-05-19','20:40'); // unificado
  ins('ep_019_07','%Cosmiatr%', 2,'%Semiología de l%',             '2026-05-19','20:40'); // Rojas

  // MIÉRCOLES 20/05 ─────────────────────────────────────────────────────────
  ins('ep_020_01','%Contabil%', 1,'%Contabilidad Bá%',             '2026-05-20','20:40'); // Giménez

  // JUEVES 21/05 ────────────────────────────────────────────────────────────
  ins('ep_021_01','%Cosmiatr%', 1,'%Anatomía y Fisi%',             '2026-05-21','19:00','A'); // Rojas
  ins('ep_021_02','%Criminal%', 1,'%Introducción a l%',            '2026-05-21','19:00'); // Domínguez
  ins('ep_021_03','%Electric%', 2,'%Maquinarias Eléc%',            '2026-05-21','19:00'); // Mareco
  ins('ep_021_04','%Cosmiatr%', 1,'%Salud Pública%',               '2026-05-21','19:00','B'); // Valenzuela
  ins('ep_021_05','%Cosmiatr%', 2,'%Técnicas de Masa%',            '2026-05-21','19:00'); // Raqueline
  ins('ep_021_06','%Criminal%', 2,'%Accidentología%',              '2026-05-21','20:40'); // Domínguez
  ins('ep_021_07','%Agropecu%', 1,'%Producción Porcin%',           '2026-05-21','20:40'); // Giménez unificado
  ins('ep_021_08','%Agropecu%', 2,'%Producción Porcin%',           '2026-05-21','20:40'); // unificado

  // VIERNES 22/05 ───────────────────────────────────────────────────────────
  ins('ep_022_01','%Farmacia%', 2,'%Cosmetología Bá%',             '2026-05-22','19:00'); // Noelia Ayala
  ins('ep_022_02','%Enfermer%', 1,'%Ética Profesion%',             '2026-05-22','19:00'); // Carrillo unificado
  ins('ep_022_03','%Radiolog%', 1,'%Ética Profesion%',             '2026-05-22','19:00'); // unificado
  ins('ep_022_04','%Farmacia%', 1,'%Farmacología%',                '2026-05-22','19:00'); // Agüero unificado
  ins('ep_022_05','%Instrume%', 1,'%Farmacología%',                '2026-05-22','19:00'); // unificado
  ins('ep_022_06','%Contabil%', 1,'%Matemática%',                  '2026-05-22','19:00'); // Sharp
  ins('ep_022_07','%Radiolog%', 2,'%Psicología%',                  '2026-05-22','19:00'); // Natalia Martínez
  ins('ep_022_08','%Instrume%', 2,'%Bioseguridad%',                '2026-05-22','19:00'); // Valenzuela
  ins('ep_022_09','%Enfermer%', 2,'%Nutrición%',                   '2026-05-22','20:40'); // Noelia Ayala

  // ════════════════════════════════════════════════════════════════════════════
  // SEMANA 3 — 25 al 29 de mayo 2026
  // ════════════════════════════════════════════════════════════════════════════

  // LUNES 25/05 ─────────────────────────────────────────────────────────────
  ins('ep_025_01','%Contabil%', 1,'%Inglés%',                      '2026-05-25','19:00'); // Jiménez unificado
  ins('ep_025_02','%Farmacia%', 2,'%Inglés%',                      '2026-05-25','19:00'); // unificado
  ins('ep_025_03','%Instrume%', 2,'%Medicina Legal%',              '2026-05-25','20:40'); // Alum

  // MARTES 26/05 — Raqueline: Dermatología Básica SIEMPRE EN MARTES ─────────
  // 1er turno (19:00): cosA 1° Secc.A
  ins('ep_026_01','%Cosmiatr%', 1,'%Dermatología Básica%',         '2026-05-26','19:00','A');
  // 2do turno (20:40): cosA 1° Secc.B
  ins('ep_026_02','%Cosmiatr%', 1,'%Dermatología Básica%',         '2026-05-26','20:40','B');
  // Otros del día
  ins('ep_026_03','%Agropecu%', 1,'%Apicultura%',                  '2026-05-26','19:00'); // Carmona
  ins('ep_026_04','%Criminal%', 1,'%Aspectos Legale%',             '2026-05-26','19:00'); // Ocampos
  ins('ep_026_05','%Agropecu%', 2,'%Cultivos%',                    '2026-05-26','20:40'); // Giménez
  ins('ep_026_06','%Electric%', 2,'%Electrotecnia%',               '2026-05-26','20:40'); // Mareco

  // MIÉRCOLES 27/05 ─────────────────────────────────────────────────────────
  ins('ep_027_01','%Cosmiatr%', 1,'%Biología de la %',             '2026-05-27','19:00','B'); // Noelia Ayala
  ins('ep_027_02','%Cosmiatr%', 2,'%Competencias So%',             '2026-05-27','19:00'); // Torales
  ins('ep_027_03','%Cosmiatr%', 1,'%Farmacología en Cosm%',        '2026-05-27','19:00','A'); // Espínola
  ins('ep_027_04','%Criminal%', 2,'%Química Aplicad%',             '2026-05-27','19:00'); // Aranda

  // JUEVES 28/05 ────────────────────────────────────────────────────────────
  ins('ep_028_01','%Agropecu%', 1,'%Productividad%',               '2026-05-28','19:00'); // Giménez
  ins('ep_028_02','%Agropecu%', 2,'%Zootecnia%',                   '2026-05-28','19:00'); // Carmona
  ins('ep_028_03','%Criminal%', 2,'%Criminología%',                '2026-05-28','19:00'); // Domínguez
  ins('ep_028_04','%Cosmiatr%', 1,'%Farmacología%',                '2026-05-28','20:40','B'); // Espínola cosA 1B COS-106
  ins('ep_028_05','%Criminal%', 1,'%Introducción al Der%',         '2026-05-28','20:40'); // Sharp
  ins('ep_028_06','%Cosmiatr%', 1,'%Salud Pública%',               '2026-05-28','20:40','A'); // Rojas cosA 1A
  ins('ep_028_07','%Electric%', 2,'%Sistema de Poten%',            '2026-05-28','20:40'); // Mareco
  ins('ep_028_08','%Cosmiatr%', 2,'%Técnicas Cosmét%',             '2026-05-28','20:40'); // Raqueline cosA 2°

  // VIERNES 29/05 ───────────────────────────────────────────────────────────
  ins('ep_029_01','%Enfermer%', 2,'%Farmacología%',                '2026-05-29','19:00'); // Rojas Enf.2°
  ins('ep_029_02','%Farmacia%', 1,'%Ética Profesion%',             '2026-05-29','20:40'); // Carrillo unificado
  ins('ep_029_03','%Instrume%', 1,'%Ética Profesion%',             '2026-05-29','20:40'); // unificado
  ins('ep_029_04','%Enfermer%', 1,'%Farmacología%',                '2026-05-29','20:40'); // Rojas unificado
  ins('ep_029_05','%Radiolog%', 1,'%Farmacología%',                '2026-05-29','20:40'); // unificado
  ins('ep_029_06','%Farmacia%', 2,'%Farmacotecnia%',               '2026-05-29','20:40'); // Agüero
  ins('ep_029_07','%Contabil%', 1,'%Introducción a la Adm%',       '2026-05-29','20:40'); // Giménez
  ins('ep_029_08','%Radiolog%', 2,'%Prácticas Radiol%',            '2026-05-29','20:40'); // Palacios
  ins('ep_029_09','%Instrume%', 2,'%Psicología Gen%',              '2026-05-29','20:40'); // Natalia Martínez

  console.log(`🗓 Backup exámenes parciales ITS 2026: ${creados} restaurados, ${omitidos} ya existían`);
}

// ── SEED HORARIOS ─────────────────────────────────────────────────────────────
function seedHorarios() {
  if (db.prepare('SELECT COUNT(*) as n FROM horarios').get().n > 0) return;
  const mapa = [
    ['Lunes',1,'19:00','20:20','Contabilidad',1,'Inglés','Jiménez'],
    ['Lunes',1,'19:00','20:20','Enfermería',1,'Salud Pública','Ayala'],
    ['Lunes',1,'19:00','20:20','Enfermería',2,'Enfermería Materno Infantil','Romero'],
    ['Lunes',1,'19:00','20:20','Farmacia',1,'Salud Pública','Aranda'],
    ['Lunes',1,'19:00','20:20','Farmacia',2,'Inglés','Jiménez'],
    ['Lunes',1,'19:00','20:20','Instrumentación',1,'Salud Pública','Aranda'],
    ['Lunes',1,'19:00','20:20','Instrumentación',2,'Patología Quirúrgica','Rojas'],
    ['Lunes',1,'19:00','20:20','Radiología',1,'Salud Pública','Ayala'],
    ['Lunes',1,'19:00','20:20','Radiología',2,'Física Radiológica','Higuchi'],
    ['Lunes',2,'20:40','22:00','Enfermería',1,'Anatomía','Higuchi'],
    ['Lunes',2,'20:40','22:00','Enfermería',2,'Enfermería en Salud del Adulto','Ayala'],
    ['Lunes',2,'20:40','22:00','Farmacia',1,'Anatomía','Rojas'],
    ['Lunes',2,'20:40','22:00','Farmacia',2,'Química Inorgánica','Aranda'],
    ['Lunes',2,'20:40','22:00','Instrumentación',1,'Anatomía','Rojas'],
    ['Lunes',2,'20:40','22:00','Instrumentación',2,'Medicina Legal','Alum'],
    ['Lunes',2,'20:40','22:00','Radiología',1,'Anatomía','Higuchi'],
    ['Lunes',2,'20:40','22:00','Radiología',2,'Técnicas Radiológicas','Palacios'],
    ['Martes',1,'19:00','20:20','Agropecuaria',1,'Apicultura','Carmona'],
    ['Martes',1,'19:00','20:20','Agropecuaria',2,'Equipos y Maquinarias','Giménez'],
    ['Martes',1,'19:00','20:20','Cosmiatría',1,'Dermatología Básica','Carballo'],
    ['Martes',1,'19:00','20:20','Cosmiatría',2,'Química Cosmética','Ayala'],
    ['Martes',1,'19:00','20:20','Criminalística',1,'Aspectos Legales','Ocampos'],
    ['Martes',1,'19:00','20:20','Criminalística',2,'Dibujo Técnico','Domínguez'],
    ['Martes',1,'19:00','20:20','Electricidad',2,'Electrónica Analógica','Mareco'],
    ['Martes',2,'20:40','22:00','Agropecuaria',1,'Deontología','Alum'],
    ['Martes',2,'20:40','22:00','Agropecuaria',2,'Cultivos','Giménez'],
    ['Martes',2,'20:40','22:00','Cosmiatría',1,'Biología de la Piel','Ayala'],
    ['Martes',2,'20:40','22:00','Cosmiatría',2,'Semiología de la Piel','Rojas'],
    ['Martes',2,'20:40','22:00','Criminalística',1,'Deontología y Ética','Alum'],
    ['Martes',2,'20:40','22:00','Criminalística',2,'Criminología','Domínguez'],
    ['Martes',2,'20:40','22:00','Electricidad',2,'Electrotecnia','Mareco'],
    ['Miércoles',1,'19:00','20:20','Agropecuaria',1,'Inglés','Jiménez'],
    ['Miércoles',1,'19:00','20:20','Agropecuaria',2,'Inglés','Jiménez'],
    ['Miércoles',1,'19:00','20:20','Contabilidad',1,'Castellano','Perez'],
    ['Miércoles',1,'19:00','20:20','Cosmiatría',1,'Farmacología','Espínola'],
    ['Miércoles',1,'19:00','20:20','Cosmiatría',2,'Competencias Socioemocionales','Torales'],
    ['Miércoles',1,'19:00','20:20','Criminalística',1,'Comunicación Escrita','Perez'],
    ['Miércoles',1,'19:00','20:20','Criminalística',2,'Química Aplicada','Aranda'],
    ['Miércoles',1,'19:00','20:20','Electricidad',2,'Inglés','Jiménez'],
    ['Miércoles',2,'20:40','22:00','Contabilidad',1,'Contabilidad Básica','Giménez'],
    ['Miércoles',2,'20:40','22:00','Enfermería',1,'Primeros Auxilios','Romero'],
    ['Miércoles',2,'20:40','22:00','Enfermería',2,'Ética y Legislación','Carrillo'],
    ['Miércoles',2,'20:40','22:00','Farmacia',1,'Calidad en Salud','Villar'],
    ['Miércoles',2,'20:40','22:00','Farmacia',2,'Ética y Legislación','Carrillo'],
    ['Miércoles',2,'20:40','22:00','Instrumentación',1,'Calidad en Salud','Villar'],
    ['Miércoles',2,'20:40','22:00','Instrumentación',2,'Técnicas Quirúrgicas','González'],
    ['Miércoles',2,'20:40','22:00','Radiología',1,'Primeros Auxilios','Romero'],
    ['Miércoles',2,'20:40','22:00','Radiología',2,'Administración Hospitalaria','Aranda'],
    ['Jueves',1,'19:00','20:20','Agropecuaria',1,'Productividad','Giménez'],
    ['Jueves',1,'19:00','20:20','Agropecuaria',2,'Zootecnia','Carmona'],
    ['Jueves',1,'19:00','20:20','Cosmiatría',1,'Anatomía','Rojas'],
    ['Jueves',1,'19:00','20:20','Cosmiatría',2,'Técnicas de Masajes','Carballo'],
    ['Jueves',1,'19:00','20:20','Criminalística',1,'Introducción a la Criminalística','Domínguez'],
    ['Jueves',1,'19:00','20:20','Electricidad',2,'Maquinarias Eléctricas','Mareco'],
    ['Jueves',2,'20:40','22:00','Agropecuaria',1,'Producción Porcina','Giménez'],
    ['Jueves',2,'20:40','22:00','Agropecuaria',2,'Producción Porcina','Giménez'],
    ['Jueves',2,'20:40','22:00','Cosmiatría',1,'Salud Pública','Rojas'],
    ['Jueves',2,'20:40','22:00','Cosmiatría',2,'Técnicas Cosméticas','Carballo'],
    ['Jueves',2,'20:40','22:00','Criminalística',1,'Introducción al Derecho','Sharp'],
    ['Jueves',2,'20:40','22:00','Criminalística',2,'Accidentología Vial','Domínguez'],
    ['Jueves',2,'20:40','22:00','Electricidad',2,'Sistema de Potencia','Mareco'],
    ['Viernes',1,'19:00','20:20','Enfermería',1,'Ética Profesional','Carrillo'],
    ['Viernes',1,'19:00','20:20','Farmacia',1,'Farmacología','Agüero'],
    ['Viernes',1,'19:00','20:20','Farmacia',2,'Cosmetología Básica','Ayala'],
    ['Viernes',1,'19:00','20:20','Instrumentación',1,'Farmacología','Agüero'],
    ['Viernes',1,'19:00','20:20','Instrumentación',2,'Psicología','Martínez'],
    ['Viernes',1,'19:00','20:20','Radiología',1,'Ética Profesional','Carrillo'],
    ['Viernes',1,'19:00','20:20','Radiología',2,'Psicología','Martínez'],
    ['Viernes',1,'19:00','20:20','Contabilidad',1,'Matemática','Sharp'],
    ['Viernes',2,'20:40','22:00','Contabilidad',1,'Introducción a la Administración','Giménez'],
    ['Viernes',2,'20:40','22:00','Enfermería',1,'Farmacología','Rojas'],
    ['Viernes',2,'20:40','22:00','Farmacia',1,'Ética Profesional','Carrillo'],
    ['Viernes',2,'20:40','22:00','Farmacia',2,'Farmacotécnia','Agüero'],
    ['Viernes',2,'20:40','22:00','Instrumentación',1,'Ética Profesional','Carrillo'],
    ['Viernes',2,'20:40','22:00','Instrumentación',2,'Psicología General','Martínez'],
    ['Viernes',2,'20:40','22:00','Radiología',1,'Farmacología','Rojas'],
    ['Viernes',2,'20:40','22:00','Radiología',2,'Prácticas Radiológicas','Palacios'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    mapa.forEach(([dia,turno,hi,hf,carr,anio,mat,doc]) => {
      const asig = db.prepare(`
        SELECT a.id FROM asignaciones a
        JOIN materias m ON a.materia_id=m.id
        JOIN cursos cu ON a.curso_id=cu.id
        JOIN carreras ca ON cu.carrera_id=ca.id
        JOIN docentes d ON a.docente_id=d.id
        JOIN usuarios u ON d.usuario_id=u.id
        WHERE ca.nombre LIKE ? AND cu.anio=? AND m.nombre LIKE ? AND (u.apellido LIKE ? OR u.nombre LIKE ?)
        LIMIT 1`).get('%'+carr+'%', anio, '%'+mat+'%', '%'+doc+'%', '%'+doc+'%');
      ins.run(asig ? asig.id : null, dia, turno, hi, hf);
    });
  })();
  console.log('Horarios cargados: ' + mapa.length + ' entradas');
}

// ── MIGRATE MATRIX V2 ─────────────────────────────────────────────────────────
function migrateMatrixV2() {
  try {
    // Step 1: Create meta table and check if migration already ran
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    if (db.prepare("SELECT value FROM meta WHERE key='matrix_v2'").get()) return;

    // Step 2: Fix wrong docente assignment (doc_higuchi → doc_rojas for COS-101 / cosA_1a)
    db.prepare(
      "UPDATE asignaciones SET docente_id='doc_rojas' WHERE materia_id=(SELECT id FROM materias WHERE codigo='COS-101') AND curso_id='cosA_1a' AND docente_id='doc_higuchi'"
    ).run();

    // Step 3: Add missing asignacion — cosA_1b needs COS-102 (Biología de la Piel) with doc_ayala_n
    const periodo = db.prepare("SELECT id FROM periodos WHERE activo=1").get();
    const matCos102 = db.prepare("SELECT id FROM materias WHERE codigo='COS-102'").get();
    if (matCos102 && periodo) {
      db.prepare(
        "INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)"
      ).run('asig_cos102_cosA_1b', 'doc_ayala_n', matCos102.id, 'cosA_1b', periodo.id);
    }

    // Step 4: Add new materia "Psicología" for Instrumentación 2do año (IQ-206)
    db.prepare(
      "INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run('m_iq_206', 'instr', 'Psicología', 'IQ-206', 4, 2, 25, 25, 50);
    const matIq206 = db.prepare("SELECT id FROM materias WHERE codigo='IQ-206'").get();
    if (matIq206 && periodo) {
      db.prepare(
        "INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)"
      ).run('asig_iq206_instr_2u', 'doc_natalia', matIq206.id, 'instr_2u', periodo.id);
    }

    // Step 5: Rebuild the horarios table with complete precise data (82 rows)
    const schedule = [
      // LUNES
      ['doc_jimenez','CON-101','cont_1u','Lunes',1,'19:00','20:20'],
      ['doc_ayala_a','ENF-104','enf_1u','Lunes',1,'19:00','20:20'],
      ['doc_romero','ENF-201','enf_2u','Lunes',1,'19:00','20:20'],
      ['doc_aranda','FAR-104','farm_1u','Lunes',1,'19:00','20:20'],
      ['doc_jimenez','FAR-203','farm_2u','Lunes',1,'19:00','20:20'],
      ['doc_aranda','IQ-104','instr_1u','Lunes',1,'19:00','20:20'],
      ['doc_rojas','IQ-202','instr_2u','Lunes',1,'19:00','20:20'],
      ['doc_ayala_a','RAD-104','rad_1u','Lunes',1,'19:00','20:20'],
      ['doc_higuchi','RAD-202','rad_2u','Lunes',1,'19:00','20:20'],
      ['doc_higuchi','ENF-101','enf_1u','Lunes',2,'20:40','22:00'],
      ['doc_ayala_a','ENF-202','enf_2u','Lunes',2,'20:40','22:00'],
      ['doc_rojas','FAR-101','farm_1u','Lunes',2,'20:40','22:00'],
      ['doc_aranda','FAR-204','farm_2u','Lunes',2,'20:40','22:00'],
      ['doc_rojas','IQ-101','instr_1u','Lunes',2,'20:40','22:00'],
      ['doc_alum','IQ-201','instr_2u','Lunes',2,'20:40','22:00'],
      ['doc_higuchi','RAD-101','rad_1u','Lunes',2,'20:40','22:00'],
      ['doc_palacios','RAD-205','rad_2u','Lunes',2,'20:40','22:00'],
      // MARTES
      ['doc_carmona','AGR-102','agro_1u','Martes',1,'19:00','20:20'],
      ['doc_gimenez','AGR-201','agro_2u','Martes',1,'19:00','20:20'],
      ['doc_carballo','COS-103','cosA_1a','Martes',1,'19:00','20:20'],
      ['doc_ayala_n','COS-202','cosA_2u','Martes',1,'19:00','20:20'],
      ['doc_higuchi','COS-101','cosA_1b','Martes',1,'19:00','20:20'],
      ['doc_ocampos','CRM-101','crim_1u','Martes',1,'19:00','20:20'],
      ['doc_dominguez','CRM-203','crim_2u','Martes',1,'19:00','20:20'],
      ['doc_mareco','ELC-201','elec_2u','Martes',1,'19:00','20:20'],
      ['doc_alum','AGR-103','agro_1u','Martes',2,'20:40','22:00'],
      ['doc_gimenez','AGR-202','agro_2u','Martes',2,'20:40','22:00'],
      ['doc_ayala_n','COS-102','cosA_1a','Martes',2,'20:40','22:00'],
      ['doc_rojas','COS-203','cosA_2u','Martes',2,'20:40','22:00'],
      ['doc_carballo','COS-103','cosA_1b','Martes',2,'20:40','22:00'],
      ['doc_alum','CRM-103','crim_1u','Martes',2,'20:40','22:00'],
      ['doc_dominguez','CRM-202','crim_2u','Martes',2,'20:40','22:00'],
      ['doc_mareco','ELC-202','elec_2u','Martes',2,'20:40','22:00'],
      // MIÉRCOLES
      ['doc_jimenez','AGR-101','agro_1u','Miércoles',1,'19:00','20:20'],
      ['doc_jimenez','AGR-205','agro_2u','Miércoles',1,'19:00','20:20'],
      ['doc_perez','CON-102','cont_1u','Miércoles',1,'19:00','20:20'],
      ['doc_espinola','COS-104','cosA_1a','Miércoles',1,'19:00','20:20'],
      ['doc_torales','COS-201','cosA_2u','Miércoles',1,'19:00','20:20'],
      ['doc_ayala_n','COS-102','cosA_1b','Miércoles',1,'19:00','20:20'],
      ['doc_perez','CRM-102','crim_1u','Miércoles',1,'19:00','20:20'],
      ['doc_aranda','CRM-204','crim_2u','Miércoles',1,'19:00','20:20'],
      ['doc_jimenez','ELC-203','elec_2u','Miércoles',1,'19:00','20:20'],
      ['doc_gimenez','CON-103','cont_1u','Miércoles',2,'20:40','22:00'],
      ['doc_romero','ENF-103','enf_1u','Miércoles',2,'20:40','22:00'],
      ['doc_carrillo','ENF-203','enf_2u','Miércoles',2,'20:40','22:00'],
      ['doc_villar','FAR-102','farm_1u','Miércoles',2,'20:40','22:00'],
      ['doc_carrillo','FAR-205','farm_2u','Miércoles',2,'20:40','22:00'],
      ['doc_villar','IQ-102','instr_1u','Miércoles',2,'20:40','22:00'],
      ['doc_gonzalez','IQ-204','instr_2u','Miércoles',2,'20:40','22:00'],
      ['doc_romero','RAD-103','rad_1u','Miércoles',2,'20:40','22:00'],
      ['doc_aranda','RAD-201','rad_2u','Miércoles',2,'20:40','22:00'],
      // JUEVES
      ['doc_gimenez','AGR-104','agro_1u','Jueves',1,'19:00','20:20'],
      ['doc_carmona','AGR-203','agro_2u','Jueves',1,'19:00','20:20'],
      ['doc_rojas','COS-101','cosA_1a','Jueves',1,'19:00','20:20'],
      ['doc_carballo','COS-205','cosA_2u','Jueves',1,'19:00','20:20'],
      ['doc_valenz','COS-105','cosA_1b','Jueves',1,'19:00','20:20'],
      ['doc_dominguez','CRM-104','crim_1u','Jueves',1,'19:00','20:20'],
      ['doc_mareco','ELC-204','elec_2u','Jueves',1,'19:00','20:20'],
      ['doc_gimenez','AGR-105','agro_1u','Jueves',2,'20:40','22:00'],
      ['doc_gimenez','AGR-204','agro_2u','Jueves',2,'20:40','22:00'],
      ['doc_rojas','COS-105','cosA_1a','Jueves',2,'20:40','22:00'],
      ['doc_carballo','COS-204','cosA_2u','Jueves',2,'20:40','22:00'],
      ['doc_espinola','COS-106','cosA_1b','Jueves',2,'20:40','22:00'],
      ['doc_sharp','CRM-105','crim_1u','Jueves',2,'20:40','22:00'],
      ['doc_dominguez','CRM-201','crim_2u','Jueves',2,'20:40','22:00'],
      ['doc_mareco','ELC-205','elec_2u','Jueves',2,'20:40','22:00'],
      // VIERNES
      ['doc_sharp','CON-105','cont_1u','Viernes',1,'19:00','20:20'],
      ['doc_carrillo','ENF-105','enf_1u','Viernes',1,'19:00','20:20'],
      ['doc_ayala_n','FAR-201','farm_2u','Viernes',1,'19:00','20:20'],
      ['doc_aguero','FAR-103','farm_1u','Viernes',1,'19:00','20:20'],
      ['doc_natalia','IQ-206','instr_2u','Viernes',1,'19:00','20:20'],
      ['doc_aguero','IQ-103','instr_1u','Viernes',1,'19:00','20:20'],
      ['doc_carrillo','RAD-105','rad_1u','Viernes',1,'19:00','20:20'],
      ['doc_natalia','RAD-204','rad_2u','Viernes',1,'19:00','20:20'],
      ['doc_gimenez','CON-104','cont_1u','Viernes',2,'20:40','22:00'],
      ['doc_rojas','ENF-102','enf_1u','Viernes',2,'20:40','22:00'],
      ['doc_aguero','FAR-202','farm_2u','Viernes',2,'20:40','22:00'],
      ['doc_carrillo','FAR-105','farm_1u','Viernes',2,'20:40','22:00'],
      ['doc_natalia','IQ-203','instr_2u','Viernes',2,'20:40','22:00'],
      ['doc_carrillo','IQ-105','instr_1u','Viernes',2,'20:40','22:00'],
      ['doc_rojas','RAD-102','rad_1u','Viernes',2,'20:40','22:00'],
      ['doc_palacios','RAD-203','rad_2u','Viernes',2,'20:40','22:00'],
    ];

    const insHorario = db.prepare(
      "INSERT OR REPLACE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin,aula) VALUES (?,?,?,?,?,'')"
    );
    const updAsig = db.prepare(
      "UPDATE asignaciones SET dia=?,turno=?,hora_inicio=?,hora_fin=? WHERE id=?"
    );
    const findAsig = db.prepare(
      "SELECT id FROM asignaciones WHERE docente_id=? AND materia_id=(SELECT id FROM materias WHERE codigo=?) AND curso_id=?"
    );

    db.transaction(() => {
      for (const [docId, matCod, curId, dia, turno, horaInicio, horaFin] of schedule) {
        const asig = findAsig.get(docId, matCod, curId);
        if (!asig) {
          console.warn(`migrateMatrixV2: asignacion no encontrada — docente=${docId} materia=${matCod} curso=${curId}`);
          continue;
        }
        insHorario.run(asig.id, dia, turno, horaInicio, horaFin);
        updAsig.run(dia, turno, horaInicio, horaFin, asig.id);
      }
    })();

    // Step 6: Mark migration as done
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('matrix_v2','done')").run();
    console.log('✓ Migración Matrix v2: horarios 2026 cargados desde Excel (82 entradas)');
  } catch (err) {
    console.error('Error en migrateMatrixV2:', err);
  }
}

// ── MIGRATE MATRIX V3 ─────────────────────────────────────────────────────────
// Borra horarios duplicados (seed + v2), actualiza nombres de materias desde Excel
function migrateMatrixV3() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    if (db.prepare("SELECT value FROM meta WHERE key='matrix_v3'").get()) return;

    // PASO 1: Borrar TODOS los horarios (seed + V2 duplicados)
    db.prepare('DELETE FROM horarios').run();

    // PASO 2: Actualizar nombres de materias desde el Excel
    const updNombre = db.prepare('UPDATE materias SET nombre=? WHERE codigo=?');
    [
      [['CON-101','AGR-101','AGR-205','ELC-203'], 'Inglés'],
      [['ENF-104','FAR-104','IQ-104','RAD-104','COS-105'], 'Salud Pública'],
      [['ENF-201'], 'Enfermería Materno Infantil I'],
      [['FAR-203'], 'Lengua Extranjera – Inglés'],
      [['IQ-202'], 'Patología Quirúrgica'],
      [['RAD-202'], 'Física Radiológica'],
      [['ENF-101','FAR-101','IQ-101','RAD-101','COS-101'], 'Anatomía y Fisiología Humana'],
      [['ENF-202'], 'Enfermería en Salud del Adulto I / II'],
      [['FAR-204'], 'Química Inorgánica'],
      [['IQ-201'], 'Medicina Legal y Ética'],
      [['RAD-205'], 'Técnicas Radiológicas III'],
      [['AGR-102'], 'Apicultura'],
      [['AGR-201'], 'Equipos y Maquinarias Agropecuarias'],
      [['COS-103'], 'Dermatología Básica / Técnicas Faciales'],
      [['COS-202'], 'Química Cosmética'],
      [['CRM-101'], 'Aspectos Legales del Peritaje'],
      [['CRM-203'], 'Dibujo Técnico y Pericial'],
      [['ELC-201'], 'Electrónica Analógica'],
      [['AGR-103','CRM-103'], 'Deontología y Ética Profesional'],
      [['AGR-202'], 'Cultivos, Forrajes y Pasturas'],
      [['COS-102'], 'Biología de la Piel I / II'],
      [['COS-203'], 'Semiología de la Piel I'],
      [['CRM-202'], 'Criminología y Victimología'],
      [['ELC-202'], 'Electrotecnia I'],
      [['CON-102'], 'Castellano'],
      [['COS-104'], 'Farmacología en Cosmiatría'],
      [['COS-201'], 'Competencias Socioemocionales'],
      [['CRM-102'], 'Comunicación Escrita y Oral y Lengua Guaraní'],
      [['CRM-204'], 'Química Aplicada a la Criminalística'],
      [['CON-103'], 'Contabilidad Básica'],
      [['ENF-103','RAD-103'], 'Primeros Auxilios'],
      [['ENF-203','FAR-205'], 'Ética y Legislación'],
      [['FAR-102','IQ-102'], 'Calidad en Salud'],
      [['IQ-204'], 'Técnicas Quirúrgicas General y Especializada'],
      [['RAD-201'], 'Administración Hospitalaria'],
      [['AGR-104'], 'Productividad Agropecuaria'],
      [['AGR-203'], 'Zootecnia'],
      [['COS-205'], 'Técnicas de Masajes y Drenaje Linfático'],
      [['CRM-104'], 'Introducción a la Criminalística'],
      [['ELC-204'], 'Maquinarias Eléctricas'],
      [['AGR-105','AGR-204'], 'Producción Porcina'],
      [['COS-204'], 'Técnicas Cosméticas'],
      [['COS-106','FAR-103','IQ-103','ENF-102','RAD-102'], 'Farmacología'],
      [['CRM-105'], 'Introducción al Derecho'],
      [['CRM-201'], 'Accidentología Vial'],
      [['ELC-205'], 'Sistema de Potencia'],
      [['CON-105'], 'Matemática'],
      [['ENF-105','RAD-105','FAR-105','IQ-105'], 'Ética Profesional'],
      [['FAR-201'], 'Cosmetología Básica'],
      [['IQ-206','RAD-204'], 'Psicología'],
      [['CON-104'], 'Introducción a la Administración'],
      [['FAR-202'], 'Farmacotécnia II'],
      [['IQ-203'], 'Psicología General'],
      [['RAD-203'], 'Prácticas Radiológicas III'],
    ].forEach(([codigos, nombre]) => codigos.forEach(c => updNombre.run(nombre, c)));

    // PASO 3: Reinsertar los 82 horarios correctos del Excel
    const schedule = [
      // LUNES
      ['doc_jimenez','CON-101','cont_1u','Lunes',1,'19:00','20:20'],
      ['doc_ayala_a','ENF-104','enf_1u','Lunes',1,'19:00','20:20'],
      ['doc_romero','ENF-201','enf_2u','Lunes',1,'19:00','20:20'],
      ['doc_aranda','FAR-104','farm_1u','Lunes',1,'19:00','20:20'],
      ['doc_jimenez','FAR-203','farm_2u','Lunes',1,'19:00','20:20'],
      ['doc_aranda','IQ-104','instr_1u','Lunes',1,'19:00','20:20'],
      ['doc_rojas','IQ-202','instr_2u','Lunes',1,'19:00','20:20'],
      ['doc_ayala_a','RAD-104','rad_1u','Lunes',1,'19:00','20:20'],
      ['doc_higuchi','RAD-202','rad_2u','Lunes',1,'19:00','20:20'],
      ['doc_higuchi','ENF-101','enf_1u','Lunes',2,'20:40','22:00'],
      ['doc_ayala_a','ENF-202','enf_2u','Lunes',2,'20:40','22:00'],
      ['doc_rojas','FAR-101','farm_1u','Lunes',2,'20:40','22:00'],
      ['doc_aranda','FAR-204','farm_2u','Lunes',2,'20:40','22:00'],
      ['doc_rojas','IQ-101','instr_1u','Lunes',2,'20:40','22:00'],
      ['doc_alum','IQ-201','instr_2u','Lunes',2,'20:40','22:00'],
      ['doc_higuchi','RAD-101','rad_1u','Lunes',2,'20:40','22:00'],
      ['doc_palacios','RAD-205','rad_2u','Lunes',2,'20:40','22:00'],
      // MARTES
      ['doc_carmona','AGR-102','agro_1u','Martes',1,'19:00','20:20'],
      ['doc_gimenez','AGR-201','agro_2u','Martes',1,'19:00','20:20'],
      ['doc_carballo','COS-103','cosA_1a','Martes',1,'19:00','20:20'],
      ['doc_ayala_n','COS-202','cosA_2u','Martes',1,'19:00','20:20'],
      ['doc_higuchi','COS-101','cosA_1b','Martes',1,'19:00','20:20'],
      ['doc_ocampos','CRM-101','crim_1u','Martes',1,'19:00','20:20'],
      ['doc_dominguez','CRM-203','crim_2u','Martes',1,'19:00','20:20'],
      ['doc_mareco','ELC-201','elec_2u','Martes',1,'19:00','20:20'],
      ['doc_alum','AGR-103','agro_1u','Martes',2,'20:40','22:00'],
      ['doc_gimenez','AGR-202','agro_2u','Martes',2,'20:40','22:00'],
      ['doc_ayala_n','COS-102','cosA_1a','Martes',2,'20:40','22:00'],
      ['doc_rojas','COS-203','cosA_2u','Martes',2,'20:40','22:00'],
      ['doc_carballo','COS-103','cosA_1b','Martes',2,'20:40','22:00'],
      ['doc_alum','CRM-103','crim_1u','Martes',2,'20:40','22:00'],
      ['doc_dominguez','CRM-202','crim_2u','Martes',2,'20:40','22:00'],
      ['doc_mareco','ELC-202','elec_2u','Martes',2,'20:40','22:00'],
      // MIÉRCOLES
      ['doc_jimenez','AGR-101','agro_1u','Miércoles',1,'19:00','20:20'],
      ['doc_jimenez','AGR-205','agro_2u','Miércoles',1,'19:00','20:20'],
      ['doc_perez','CON-102','cont_1u','Miércoles',1,'19:00','20:20'],
      ['doc_espinola','COS-104','cosA_1a','Miércoles',1,'19:00','20:20'],
      ['doc_torales','COS-201','cosA_2u','Miércoles',1,'19:00','20:20'],
      ['doc_ayala_n','COS-102','cosA_1b','Miércoles',1,'19:00','20:20'],
      ['doc_perez','CRM-102','crim_1u','Miércoles',1,'19:00','20:20'],
      ['doc_aranda','CRM-204','crim_2u','Miércoles',1,'19:00','20:20'],
      ['doc_jimenez','ELC-203','elec_2u','Miércoles',1,'19:00','20:20'],
      ['doc_gimenez','CON-103','cont_1u','Miércoles',2,'20:40','22:00'],
      ['doc_romero','ENF-103','enf_1u','Miércoles',2,'20:40','22:00'],
      ['doc_carrillo','ENF-203','enf_2u','Miércoles',2,'20:40','22:00'],
      ['doc_villar','FAR-102','farm_1u','Miércoles',2,'20:40','22:00'],
      ['doc_carrillo','FAR-205','farm_2u','Miércoles',2,'20:40','22:00'],
      ['doc_villar','IQ-102','instr_1u','Miércoles',2,'20:40','22:00'],
      ['doc_gonzalez','IQ-204','instr_2u','Miércoles',2,'20:40','22:00'],
      ['doc_romero','RAD-103','rad_1u','Miércoles',2,'20:40','22:00'],
      ['doc_aranda','RAD-201','rad_2u','Miércoles',2,'20:40','22:00'],
      // JUEVES
      ['doc_gimenez','AGR-104','agro_1u','Jueves',1,'19:00','20:20'],
      ['doc_carmona','AGR-203','agro_2u','Jueves',1,'19:00','20:20'],
      ['doc_rojas','COS-101','cosA_1a','Jueves',1,'19:00','20:20'],
      ['doc_carballo','COS-205','cosA_2u','Jueves',1,'19:00','20:20'],
      ['doc_valenz','COS-105','cosA_1b','Jueves',1,'19:00','20:20'],
      ['doc_dominguez','CRM-104','crim_1u','Jueves',1,'19:00','20:20'],
      ['doc_mareco','ELC-204','elec_2u','Jueves',1,'19:00','20:20'],
      ['doc_gimenez','AGR-105','agro_1u','Jueves',2,'20:40','22:00'],
      ['doc_gimenez','AGR-204','agro_2u','Jueves',2,'20:40','22:00'],
      ['doc_rojas','COS-105','cosA_1a','Jueves',2,'20:40','22:00'],
      ['doc_carballo','COS-204','cosA_2u','Jueves',2,'20:40','22:00'],
      ['doc_espinola','COS-106','cosA_1b','Jueves',2,'20:40','22:00'],
      ['doc_sharp','CRM-105','crim_1u','Jueves',2,'20:40','22:00'],
      ['doc_dominguez','CRM-201','crim_2u','Jueves',2,'20:40','22:00'],
      ['doc_mareco','ELC-205','elec_2u','Jueves',2,'20:40','22:00'],
      // VIERNES
      ['doc_sharp','CON-105','cont_1u','Viernes',1,'19:00','20:20'],
      ['doc_carrillo','ENF-105','enf_1u','Viernes',1,'19:00','20:20'],
      ['doc_ayala_n','FAR-201','farm_2u','Viernes',1,'19:00','20:20'],
      ['doc_aguero','FAR-103','farm_1u','Viernes',1,'19:00','20:20'],
      ['doc_natalia','IQ-206','instr_2u','Viernes',1,'19:00','20:20'],
      ['doc_aguero','IQ-103','instr_1u','Viernes',1,'19:00','20:20'],
      ['doc_carrillo','RAD-105','rad_1u','Viernes',1,'19:00','20:20'],
      ['doc_natalia','RAD-204','rad_2u','Viernes',1,'19:00','20:20'],
      ['doc_gimenez','CON-104','cont_1u','Viernes',2,'20:40','22:00'],
      ['doc_rojas','ENF-102','enf_1u','Viernes',2,'20:40','22:00'],
      ['doc_aguero','FAR-202','farm_2u','Viernes',2,'20:40','22:00'],
      ['doc_carrillo','FAR-105','farm_1u','Viernes',2,'20:40','22:00'],
      ['doc_natalia','IQ-203','instr_2u','Viernes',2,'20:40','22:00'],
      ['doc_carrillo','IQ-105','instr_1u','Viernes',2,'20:40','22:00'],
      ['doc_rojas','RAD-102','rad_1u','Viernes',2,'20:40','22:00'],
      ['doc_palacios','RAD-203','rad_2u','Viernes',2,'20:40','22:00'],
    ];

    const insH = db.prepare("INSERT INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin,aula) VALUES (?,?,?,?,?,'')");
    const updA = db.prepare('UPDATE asignaciones SET dia=?,turno=?,hora_inicio=?,hora_fin=? WHERE id=?');
    const findA = db.prepare("SELECT id FROM asignaciones WHERE docente_id=? AND materia_id=(SELECT id FROM materias WHERE codigo=?) AND curso_id=?");

    db.transaction(() => {
      for (const [docId,matCod,curId,dia,turno,hi,hf] of schedule) {
        const asig = findA.get(docId, matCod, curId);
        if (!asig) { console.warn(`migrateMatrixV3: no asig — ${docId}/${matCod}/${curId}`); continue; }
        insH.run(asig.id, dia, turno, hi, hf);
        updA.run(dia, turno, hi, hf, asig.id);
      }
    })();

    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('matrix_v3','done')").run();
    console.log('✓ Migración Matrix v3: horarios limpios (82) + nombres de materias actualizados desde Excel');
  } catch(err) {
    console.error('Error en migrateMatrixV3:', err);
  }
}

// ══════════════════════════════════════════════════════════════════
