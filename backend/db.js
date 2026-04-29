const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'its.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── CÁLCULO DE PUNTAJE (lógica ITS) ──────────────────────────────────────────
// Parcial: si hay recuperatorio, REEMPLAZA al ordinario (no importa cuál es mayor)
// TPs: 5 campos independientes, suma simple (max 5 cada uno, max 25 total)
// Final: última instancia cargada reemplaza las anteriores (ord → recup → complementario)
// Extraordinario: RESET total — ignora todo y usa solo ese valor (escala sobre 100)
function calcularPuntaje(tp1, tp2, tp3, tp4, tp5, parcial, parcial_recuperatorio, final_ord, final_recuperatorio, complementario, extraordinario) {
  const hayDatos = [tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario]
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

  const tps = [n(tp1), n(tp2), n(tp3), n(tp4), n(tp5)];
  const tp_total = tps.every(t => t === null) ? null : tps.reduce((acc, t) => acc + (t || 0), 0);

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
    const puntajeParcial = Math.round(((parcial_ef || 0) + (tp_total || 0)) * 100) / 100;
    return { puntaje: puntajeParcial||null, nota: null, estado: 'Pendiente', parcial_ef, final_ef, tp_total };
  }

  // Hay final → calcular nota definitiva
  const puntaje = Math.round(((parcial_ef || 0) + (tp_total || 0) + (final_ef || 0)) * 100) / 100;
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
      insCu.run(`${c.id}_1u`, c.id, 1, 'U', 'Nocturno');
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
  // Alumnos: habilitación especial de pago y bloqueo de notas
  try { db.prepare("ALTER TABLE alumnos ADD COLUMN habilitado_pago_pendiente INTEGER DEFAULT 0").run(); } catch {}
  try { db.prepare("ALTER TABLE avisos ADD COLUMN destinatario TEXT DEFAULT 'todos'").run(); } catch {}
  try { db.prepare("ALTER TABLE institucion ADD COLUMN logo_base64 TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE habilitaciones_examen ADD COLUMN habilitado_recuperatorio INTEGER DEFAULT 0").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN dia TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN turno INTEGER").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN curso_id TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE materias ADD COLUMN docente_id TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_nombre TEXT").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_data BLOB").run(); } catch {}
  try { db.prepare("ALTER TABLE examenes ADD COLUMN archivo_tipo TEXT").run(); } catch {}
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
  try { db.exec(`CREATE TABLE IF NOT EXISTS constancias (id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'estudios', pago_id TEXT, fecha TEXT NOT NULL DEFAULT (date('now')), emitido_por TEXT, observacion TEXT)`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS deudas_cuotas (id TEXT PRIMARY KEY, alumno_id TEXT NOT NULL, periodo_id INTEGER NOT NULL, concepto TEXT NOT NULL, monto_total REAL NOT NULL, monto_pagado REAL NOT NULL DEFAULT 0, fecha_vencimiento TEXT, estado TEXT NOT NULL DEFAULT 'pendiente')`); } catch {}
  // Tablas de honorarios
  try { db.exec(`CREATE TABLE IF NOT EXISTS honorarios (id TEXT PRIMARY KEY, docente_id TEXT NOT NULL, asignacion_id TEXT, fecha TEXT NOT NULL, turno INTEGER NOT NULL DEFAULT 1, monto REAL NOT NULL DEFAULT 80000, estado TEXT NOT NULL DEFAULT 'generado', tipo TEXT NOT NULL DEFAULT 'clase', reemplazo_id TEXT, observacion TEXT, fecha_registro TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS reemplazos (id TEXT PRIMARY KEY, asignacion_id TEXT NOT NULL, docente_titular_id TEXT NOT NULL, docente_reemplazante_id TEXT NOT NULL, fecha TEXT NOT NULL, turno INTEGER NOT NULL DEFAULT 1, motivo TEXT, estado TEXT NOT NULL DEFAULT 'pendiente', registrado_por TEXT NOT NULL, aprobado_por TEXT, fecha_aprobacion TEXT, fecha_registro TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS feriados (id TEXT PRIMARY KEY, fecha TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'nacional', activo INTEGER NOT NULL DEFAULT 1)`); } catch {}
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
  seedDatos();
  seedHorarios();
  console.log('✓ Base de datos lista en:', DB_PATH);
}

module.exports = { db, init, calcularPuntaje, seedHorarios, DB_PATH };

// ── SEED HORARIOS — generado desde Excel actualizado ──────────────────────────
// 82 clases | 9 carreras | 25 docentes | 54 materias | Turno Nocturno
// ════════════════════════════════════════════════════════════
// SEED HORARIO ITS — 82 clases | 9 carreras | 25 docentes | 54 materias
// ════════════════════════════════════════════════════════════
// SEED HORARIO ITS — 82 clases | 9 carreras | 25 docentes | 54 materias
function seedHorarios() {
  console.log('🌱 Iniciando seed horario ITS (limpieza + recarga)...');
  // ── LIMPIAR DATOS DEL SEED ANTERIOR ─────────────────────
  // Eliminar horarios, asignaciones, docentes y materias previos del seed
  // para evitar duplicados entre el seed viejo (nombres abreviados) y el nuevo
  try {
    db.prepare('DELETE FROM horarios').run();
    db.prepare('DELETE FROM asignaciones').run();
    // Eliminar docentes del seed (los que tienen email @its.edu.py y rol=docente)
    const docsSeed = db.prepare("SELECT d.id, d.usuario_id FROM docentes d JOIN usuarios u ON d.usuario_id=u.id WHERE u.email LIKE '%@its.edu.py' AND u.rol='docente'").all();
    docsSeed.forEach(d => {
      db.prepare('DELETE FROM docentes WHERE id=?').run(d.id);
      db.prepare("DELETE FROM usuarios WHERE id=? AND rol='docente'").run(d.usuario_id);
    });
    // Eliminar materias del seed
    db.prepare('DELETE FROM materias').run();
    // Eliminar cursos del seed
    db.prepare('DELETE FROM cursos').run();
    // Eliminar carreras del seed (se recrean con nombres oficiales)
    db.prepare('DELETE FROM carreras').run();
    console.log('✓ Datos anteriores limpiados');
  } catch(e) { console.log('Aviso limpieza:', e.message); }

  const bcrypt = require('bcryptjs');
  const carrMap = {}, cursoMap = {}, docMap = {}, matMap = {};
  let asigN = 0, horN = 0;

  // ── CARRERAS ──────────────────────────────────────────────
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_agropecuaria','Agropecuaria','AGR',4,'Nocturno');
  carrMap['Agropecuaria']='carr_agropecuaria';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_contabilidad','Contabilidad','CON',4,'Nocturno');
  carrMap['Contabilidad']='carr_contabilidad';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_cosmiatria','Cosmiatría','COS',4,'Nocturno');
  carrMap['Cosmiatría']='carr_cosmiatria';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_criminalistica','Criminalística','CRI',4,'Nocturno');
  carrMap['Criminalística']='carr_criminalistica';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_electricidad','Electricidad','ELE',4,'Nocturno');
  carrMap['Electricidad']='carr_electricidad';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_enfermeria','Enfermería','ENF',4,'Nocturno');
  carrMap['Enfermería']='carr_enfermeria';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_farmacia','Farmacia','FAR',4,'Nocturno');
  carrMap['Farmacia']='carr_farmacia';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_instrumentacion_quirurgica','Instrumentación Quirúrgica','INQ',4,'Nocturno');
  carrMap['Instrumentación Quirúrgica']='carr_instrumentacion_quirurgica';
  db.prepare('INSERT OR IGNORE INTO carreras (id,nombre,codigo,semestres,turno) VALUES (?,?,?,?,?)').run('carr_radiologia','Radiología','RAD',4,'Nocturno');
  carrMap['Radiología']='carr_radiologia';

  // ── CURSOS/SECCIONES ──────────────────────────────────────
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_agropecuaria_1_u',carrMap['Agropecuaria'],1,'U');
  cursoMap['Agropecuaria|1|U']='cu_agropecuaria_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_agropecuaria_2_u',carrMap['Agropecuaria'],2,'U');
  cursoMap['Agropecuaria|2|U']='cu_agropecuaria_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_contabilidad_1_u',carrMap['Contabilidad'],1,'U');
  cursoMap['Contabilidad|1|U']='cu_contabilidad_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_cosmiatria_1_a',carrMap['Cosmiatría'],1,'A');
  cursoMap['Cosmiatría|1|A']='cu_cosmiatria_1_a';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_cosmiatria_1_b',carrMap['Cosmiatría'],1,'B');
  cursoMap['Cosmiatría|1|B']='cu_cosmiatria_1_b';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_cosmiatria_1_u',carrMap['Cosmiatría'],1,'U');
  cursoMap['Cosmiatría|1|U']='cu_cosmiatria_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_cosmiatria_2_u',carrMap['Cosmiatría'],2,'U');
  cursoMap['Cosmiatría|2|U']='cu_cosmiatria_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_criminalistica_1_u',carrMap['Criminalística'],1,'U');
  cursoMap['Criminalística|1|U']='cu_criminalistica_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_criminalistica_2_u',carrMap['Criminalística'],2,'U');
  cursoMap['Criminalística|2|U']='cu_criminalistica_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_electricidad_2_u',carrMap['Electricidad'],2,'U');
  cursoMap['Electricidad|2|U']='cu_electricidad_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_enfermeria_1_u',carrMap['Enfermería'],1,'U');
  cursoMap['Enfermería|1|U']='cu_enfermeria_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_enfermeria_2_u',carrMap['Enfermería'],2,'U');
  cursoMap['Enfermería|2|U']='cu_enfermeria_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_farmacia_1_u',carrMap['Farmacia'],1,'U');
  cursoMap['Farmacia|1|U']='cu_farmacia_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_farmacia_2_u',carrMap['Farmacia'],2,'U');
  cursoMap['Farmacia|2|U']='cu_farmacia_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_instrumentacion_quirurgica_1_u',carrMap['Instrumentación Quirúrgica'],1,'U');
  cursoMap['Instrumentación Quirúrgica|1|U']='cu_instrumentacion_quirurgica_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_instrumentacion_quirurgica_2_u',carrMap['Instrumentación Quirúrgica'],2,'U');
  cursoMap['Instrumentación Quirúrgica|2|U']='cu_instrumentacion_quirurgica_2_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_radiologia_1_u',carrMap['Radiología'],1,'U');
  cursoMap['Radiología|1|U']='cu_radiologia_1_u';
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division) VALUES (?,?,?,?)').run('cu_radiologia_2_u',carrMap['Radiología'],2,'U');
  cursoMap['Radiología|2|U']='cu_radiologia_2_u';

  // ── DOCENTES ─────────────────────────────────────────────
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_abg_cesar_alum','César','Alum','cesar.alum@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_abg_cesar_alum','u_doc_abg_cesar_alum','Abg.');
  docMap['Abg. César Alum']='doc_abg_cesar_alum';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_abg_gabriel_sharp','Gabriel','Sharp','gabriel.sharp@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_abg_gabriel_sharp','u_doc_abg_gabriel_sharp','Abg.');
  docMap['Abg. Gabriel Sharp']='doc_abg_gabriel_sharp';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_abg_maria_paz_ocampos','María','Paz Ocampos','maria.paz_ocampos@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_abg_maria_paz_ocampos','u_doc_abg_maria_paz_ocampos','Abg.');
  docMap['Abg. María Paz Ocampos']='doc_abg_maria_paz_ocampos';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_abg_myrian_carrillo','Myrian','Carrillo','myrian.carrillo@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_abg_myrian_carrillo','u_doc_abg_myrian_carrillo','Abg.');
  docMap['Abg. Myrian Carrillo']='doc_abg_myrian_carrillo';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_dr_favio_rojas','Favio','Rojas','favio.rojas@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_dr_favio_rojas','u_doc_dr_favio_rojas','Dr.');
  docMap['Dr. Favio Rojas']='doc_dr_favio_rojas';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_dra_cinthia_espinola','Cinthia','Espínola','cinthia.espinola@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_dra_cinthia_espinola','u_doc_dra_cinthia_espinola','Dra.');
  docMap['Dra. Cinthia Espínola']='doc_dra_cinthia_espinola';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_dra_natalia_valenzuela','Natalia','Valenzuela','natalia.valenzuela@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_dra_natalia_valenzuela','u_doc_dra_natalia_valenzuela','Dra.');
  docMap['Dra. Natalia Valenzuela']='doc_dra_natalia_valenzuela';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_ing_oscar_mareco','Oscar','Mareco','oscar.mareco@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_ing_oscar_mareco','u_doc_ing_oscar_mareco','Ing.');
  docMap['Ing. Oscar Mareco']='doc_ing_oscar_mareco';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_inst_karen_gonzalez','Karen','González','karen.gonzalez@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_inst_karen_gonzalez','u_doc_inst_karen_gonzalez','Inst.');
  docMap['Inst. Karen González']='doc_inst_karen_gonzalez';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_ana_ayala','Ana','Ayala','ana.ayala@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_ana_ayala','u_doc_lic_ana_ayala','Lic.');
  docMap['Lic. Ana Ayala']='doc_lic_ana_ayala';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_angela_aranda','Angela','Aranda','angela.aranda@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_angela_aranda','u_doc_lic_angela_aranda','Lic.');
  docMap['Lic. Angela Aranda']='doc_lic_angela_aranda';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_blanca_villar','Blanca','Villar','blanca.villar@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_blanca_villar','u_doc_lic_blanca_villar','Lic.');
  docMap['Lic. Blanca Villar']='doc_lic_blanca_villar';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_gabriela_aguero','Gabriela','Agüero','gabriela.aguero@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_gabriela_aguero','u_doc_lic_gabriela_aguero','Lic.');
  docMap['Lic. Gabriela Agüero']='doc_lic_gabriela_aguero';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_jannyne_torales','Jannyne','Torales','jannyne.torales@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_jannyne_torales','u_doc_lic_jannyne_torales','Lic.');
  docMap['Lic. Jannyne Torales']='doc_lic_jannyne_torales';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_marcial_palacios','Marcial','Palacios','marcial.palacios@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_marcial_palacios','u_doc_lic_marcial_palacios','Lic.');
  docMap['Lic. Marcial Palacios']='doc_lic_marcial_palacios';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_maria_elena_perez_de_can','Maria','Elena Perez de Cantero','maria.elena_perez_de_cantero@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_maria_elena_perez_de_can','u_doc_lic_maria_elena_perez_de_can','Lic.');
  docMap['Lic. Maria Elena Perez de Cantero']='doc_lic_maria_elena_perez_de_can';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_micheli_romero','Micheli','Romero','micheli.romero@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_micheli_romero','u_doc_lic_micheli_romero','Lic.');
  docMap['Lic. Micheli Romero']='doc_lic_micheli_romero';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_mirta_gimenez','Mirta','Giménez','mirta.gimenez@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_mirta_gimenez','u_doc_lic_mirta_gimenez','Lic.');
  docMap['Lic. Mirta Giménez']='doc_lic_mirta_gimenez';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_natalia_martinez','Natalia','Martínez','natalia.martinez@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_natalia_martinez','u_doc_lic_natalia_martinez','Lic.');
  docMap['Lic. Natalia Martínez']='doc_lic_natalia_martinez';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_nelly_carmona','Nelly','Carmona','nelly.carmona@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_nelly_carmona','u_doc_lic_nelly_carmona','Lic.');
  docMap['Lic. Nelly Carmona']='doc_lic_nelly_carmona';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_nelson_dominguez','Nelson','Domínguez','nelson.dominguez@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_nelson_dominguez','u_doc_lic_nelson_dominguez','Lic.');
  docMap['Lic. Nelson Domínguez']='doc_lic_nelson_dominguez';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_noelia_ayala','Noelia','Ayala','noelia.ayala@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_noelia_ayala','u_doc_lic_noelia_ayala','Lic.');
  docMap['Lic. Noelia Ayala']='doc_lic_noelia_ayala';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_pamela_jimenez','Pamela','Jiménez','pamela.jimenez@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_pamela_jimenez','u_doc_lic_pamela_jimenez','Lic.');
  docMap['Lic. Pamela Jiménez']='doc_lic_pamela_jimenez';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_lic_raqueline_carballo','Raqueline','Carballo','raqueline.carballo@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_lic_raqueline_carballo','u_doc_lic_raqueline_carballo','Lic.');
  docMap['Lic. Raqueline Carballo']='doc_lic_raqueline_carballo';
  db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)').run('u_doc_rad_paulo_higuchi','Paulo','Higuchi','paulo.higuchi@its.edu.py',bcrypt.hashSync('docente123',10),'docente');
  db.prepare('INSERT OR IGNORE INTO docentes (id,usuario_id,titulo) VALUES (?,?,?)').run('doc_rad_paulo_higuchi','u_doc_rad_paulo_higuchi','Rad.');
  docMap['Rad. Paulo Higuchi']='doc_rad_paulo_higuchi';

  // ── MATERIAS ─────────────────────────────────────────────
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_accidentologia_vial_criminalistica_2',carrMap['Criminalística'],'Accidentología Vial',2,2);
  matMap['Accidentología Vial|Criminalística|2']='mat_accidentologia_vial_criminalistica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_administracion_hospitalaria_radiologia_2',carrMap['Radiología'],'Administración Hospitalaria',2,2);
  matMap['Administración Hospitalaria|Radiología|2']='mat_administracion_hospitalaria_radiologia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_anatomia_y_fisiologia_humana_cosmiatria_1',carrMap['Cosmiatría'],'Anatomía y Fisiología Humana',1,2);
  matMap['Anatomía y Fisiología Humana|Cosmiatría|1']='mat_anatomia_y_fisiologia_humana_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_anatomia_y_fisiologia_humana_enfermeria_1',carrMap['Enfermería'],'Anatomía y Fisiología Humana',1,2);
  matMap['Anatomía y Fisiología Humana|Enfermería|1']='mat_anatomia_y_fisiologia_humana_enfermeria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_anatomia_y_fisiologia_humana_farmacia_1',carrMap['Farmacia'],'Anatomía y Fisiología Humana',1,2);
  matMap['Anatomía y Fisiología Humana|Farmacia|1']='mat_anatomia_y_fisiologia_humana_farmacia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_anatomia_y_fisiologia_humana_instrumentacion_quirurgica_1',carrMap['Instrumentación Quirúrgica'],'Anatomía y Fisiología Humana',1,2);
  matMap['Anatomía y Fisiología Humana|Instrumentación Quirúrgica|1']='mat_anatomia_y_fisiologia_humana_instrumentacion_quirurgica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_anatomia_y_fisiologia_humana_radiologia_1',carrMap['Radiología'],'Anatomía y Fisiología Humana',1,2);
  matMap['Anatomía y Fisiología Humana|Radiología|1']='mat_anatomia_y_fisiologia_humana_radiologia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_apicultura_agropecuaria_1',carrMap['Agropecuaria'],'Apicultura',1,2);
  matMap['Apicultura|Agropecuaria|1']='mat_apicultura_agropecuaria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_aspectos_legales_del_peritaj_criminalistica_1',carrMap['Criminalística'],'Aspectos Legales del Peritaje',1,2);
  matMap['Aspectos Legales del Peritaje|Criminalística|1']='mat_aspectos_legales_del_peritaj_criminalistica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_biologia_de_la_piel_i_ii_cosmiatria_1',carrMap['Cosmiatría'],'Biología de la Piel I / II',1,2);
  matMap['Biología de la Piel I / II|Cosmiatría|1']='mat_biologia_de_la_piel_i_ii_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_calidad_en_salud_farmacia_1',carrMap['Farmacia'],'Calidad en Salud',1,2);
  matMap['Calidad en Salud|Farmacia|1']='mat_calidad_en_salud_farmacia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_calidad_en_salud_instrumentacion_quirurgica_1',carrMap['Instrumentación Quirúrgica'],'Calidad en Salud',1,2);
  matMap['Calidad en Salud|Instrumentación Quirúrgica|1']='mat_calidad_en_salud_instrumentacion_quirurgica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_castellano_contabilidad_1',carrMap['Contabilidad'],'Castellano',1,2);
  matMap['Castellano|Contabilidad|1']='mat_castellano_contabilidad_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_competencias_socioemocionale_cosmiatria_2',carrMap['Cosmiatría'],'Competencias Socioemocionales',2,2);
  matMap['Competencias Socioemocionales|Cosmiatría|2']='mat_competencias_socioemocionale_cosmiatria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_comunicacion_escrita_y_oral__criminalistica_1',carrMap['Criminalística'],'Comunicación Escrita y Oral y Lengua Guaraní',1,2);
  matMap['Comunicación Escrita y Oral y Lengua Guaraní|Criminalística|1']='mat_comunicacion_escrita_y_oral__criminalistica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_contabilidad_basica_contabilidad_1',carrMap['Contabilidad'],'Contabilidad Básica',1,2);
  matMap['Contabilidad Básica|Contabilidad|1']='mat_contabilidad_basica_contabilidad_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_cosmetologia_basica_farmacia_2',carrMap['Farmacia'],'Cosmetología Básica',2,2);
  matMap['Cosmetología Básica|Farmacia|2']='mat_cosmetologia_basica_farmacia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_criminologia_y_victimologia_criminalistica_2',carrMap['Criminalística'],'Criminología y Victimología',2,2);
  matMap['Criminología y Victimología|Criminalística|2']='mat_criminologia_y_victimologia_criminalistica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_cultivos_forrajes_y_pasturas_agropecuaria_2',carrMap['Agropecuaria'],'Cultivos, Forrajes y Pasturas',2,2);
  matMap['Cultivos, Forrajes y Pasturas|Agropecuaria|2']='mat_cultivos_forrajes_y_pasturas_agropecuaria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_deontologia_y_etica_profesio_agropecuaria_1',carrMap['Agropecuaria'],'Deontología y Ética Profesional',1,2);
  matMap['Deontología y Ética Profesional|Agropecuaria|1']='mat_deontologia_y_etica_profesio_agropecuaria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_deontologia_y_etica_profesio_criminalistica_1',carrMap['Criminalística'],'Deontología y Ética Profesional',1,2);
  matMap['Deontología y Ética Profesional|Criminalística|1']='mat_deontologia_y_etica_profesio_criminalistica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_dermatologia_basica_tecnicas_cosmiatria_1',carrMap['Cosmiatría'],'Dermatología Básica / Técnicas Faciales',1,2);
  matMap['Dermatología Básica / Técnicas Faciales|Cosmiatría|1']='mat_dermatologia_basica_tecnicas_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_dibujo_tecnico_y_pericial_criminalistica_2',carrMap['Criminalística'],'Dibujo Técnico y Pericial',2,2);
  matMap['Dibujo Técnico y Pericial|Criminalística|2']='mat_dibujo_tecnico_y_pericial_criminalistica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_electrotecnia_i_electricidad_2',carrMap['Electricidad'],'Electrotecnia I',2,2);
  matMap['Electrotecnia I|Electricidad|2']='mat_electrotecnia_i_electricidad_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_electronica_analogica_electricidad_2',carrMap['Electricidad'],'Electrónica Analógica',2,2);
  matMap['Electrónica Analógica|Electricidad|2']='mat_electronica_analogica_electricidad_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_enfermeria_materno_infantil__enfermeria_2',carrMap['Enfermería'],'Enfermería Materno Infantil I',2,2);
  matMap['Enfermería Materno Infantil I|Enfermería|2']='mat_enfermeria_materno_infantil__enfermeria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_enfermeria_en_salud_del_adul_enfermeria_2',carrMap['Enfermería'],'Enfermería en Salud del Adulto I / II',2,2);
  matMap['Enfermería en Salud del Adulto I / II|Enfermería|2']='mat_enfermeria_en_salud_del_adul_enfermeria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_equipos_y_maquinarias_agrope_agropecuaria_2',carrMap['Agropecuaria'],'Equipos y Maquinarias Agropecuarias',2,2);
  matMap['Equipos y Maquinarias Agropecuarias|Agropecuaria|2']='mat_equipos_y_maquinarias_agrope_agropecuaria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_cosmiatria_1',carrMap['Cosmiatría'],'Farmacología',1,2);
  matMap['Farmacología|Cosmiatría|1']='mat_farmacologia_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_enfermeria_1',carrMap['Enfermería'],'Farmacología',1,2);
  matMap['Farmacología|Enfermería|1']='mat_farmacologia_enfermeria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_farmacia_1',carrMap['Farmacia'],'Farmacología',1,2);
  matMap['Farmacología|Farmacia|1']='mat_farmacologia_farmacia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_instrumentacion_quirurgica_1',carrMap['Instrumentación Quirúrgica'],'Farmacología',1,2);
  matMap['Farmacología|Instrumentación Quirúrgica|1']='mat_farmacologia_instrumentacion_quirurgica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_radiologia_1',carrMap['Radiología'],'Farmacología',1,2);
  matMap['Farmacología|Radiología|1']='mat_farmacologia_radiologia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacologia_en_cosmiatria_cosmiatria_1',carrMap['Cosmiatría'],'Farmacología en Cosmiatría',1,2);
  matMap['Farmacología en Cosmiatría|Cosmiatría|1']='mat_farmacologia_en_cosmiatria_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_farmacotecnia_ii_farmacia_2',carrMap['Farmacia'],'Farmacotécnia II',2,2);
  matMap['Farmacotécnia II|Farmacia|2']='mat_farmacotecnia_ii_farmacia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_fisica_radiologica_radiologia_2',carrMap['Radiología'],'Física Radiológica',2,2);
  matMap['Física Radiológica|Radiología|2']='mat_fisica_radiologica_radiologia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_ingles_agropecuaria_1',carrMap['Agropecuaria'],'Inglés',1,2);
  matMap['Inglés|Agropecuaria|1']='mat_ingles_agropecuaria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_ingles_agropecuaria_2',carrMap['Agropecuaria'],'Inglés',2,2);
  matMap['Inglés|Agropecuaria|2']='mat_ingles_agropecuaria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_ingles_contabilidad_1',carrMap['Contabilidad'],'Inglés',1,2);
  matMap['Inglés|Contabilidad|1']='mat_ingles_contabilidad_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_ingles_electricidad_2',carrMap['Electricidad'],'Inglés',2,2);
  matMap['Inglés|Electricidad|2']='mat_ingles_electricidad_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_introduccion_a_la_administra_contabilidad_1',carrMap['Contabilidad'],'Introducción a la Administración',1,2);
  matMap['Introducción a la Administración|Contabilidad|1']='mat_introduccion_a_la_administra_contabilidad_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_introduccion_a_la_criminalis_criminalistica_1',carrMap['Criminalística'],'Introducción a la Criminalística',1,2);
  matMap['Introducción a la Criminalística|Criminalística|1']='mat_introduccion_a_la_criminalis_criminalistica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_introduccion_al_derecho_criminalistica_1',carrMap['Criminalística'],'Introducción al Derecho',1,2);
  matMap['Introducción al Derecho|Criminalística|1']='mat_introduccion_al_derecho_criminalistica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_lengua_extranjera_ingles_farmacia_2',carrMap['Farmacia'],'Lengua Extranjera – Inglés',2,2);
  matMap['Lengua Extranjera – Inglés|Farmacia|2']='mat_lengua_extranjera_ingles_farmacia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_maquinarias_electricas_electricidad_2',carrMap['Electricidad'],'Maquinarias Eléctricas',2,2);
  matMap['Maquinarias Eléctricas|Electricidad|2']='mat_maquinarias_electricas_electricidad_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_matematica_contabilidad_1',carrMap['Contabilidad'],'Matematica',1,2);
  matMap['Matematica|Contabilidad|1']='mat_matematica_contabilidad_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_medicina_legal_y_etica_instrumentacion_quirurgica_2',carrMap['Instrumentación Quirúrgica'],'Medicina Legal y Ética',2,2);
  matMap['Medicina Legal y Ética|Instrumentación Quirúrgica|2']='mat_medicina_legal_y_etica_instrumentacion_quirurgica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_patologia_quirurgica_instrumentacion_quirurgica_2',carrMap['Instrumentación Quirúrgica'],'Patología Quirúrgica',2,2);
  matMap['Patología Quirúrgica|Instrumentación Quirúrgica|2']='mat_patologia_quirurgica_instrumentacion_quirurgica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_primeros_auxilios_enfermeria_1',carrMap['Enfermería'],'Primeros Auxilios',1,2);
  matMap['Primeros Auxilios|Enfermería|1']='mat_primeros_auxilios_enfermeria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_primeros_auxilios_radiologia_1',carrMap['Radiología'],'Primeros Auxilios',1,2);
  matMap['Primeros Auxilios|Radiología|1']='mat_primeros_auxilios_radiologia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_produccion_porcina_agropecuaria_1',carrMap['Agropecuaria'],'Producción Porcina',1,2);
  matMap['Producción Porcina|Agropecuaria|1']='mat_produccion_porcina_agropecuaria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_produccion_porcina_agropecuaria_2',carrMap['Agropecuaria'],'Producción Porcina',2,2);
  matMap['Producción Porcina|Agropecuaria|2']='mat_produccion_porcina_agropecuaria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_productividad_agropecuaria_agropecuaria_1',carrMap['Agropecuaria'],'Productividad Agropecuaria',1,2);
  matMap['Productividad Agropecuaria|Agropecuaria|1']='mat_productividad_agropecuaria_agropecuaria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_practicas_radiologicas_iii_radiologia_2',carrMap['Radiología'],'Prácticas Radiológicas III',2,2);
  matMap['Prácticas Radiológicas III|Radiología|2']='mat_practicas_radiologicas_iii_radiologia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_psicologia_instrumentacion_quirurgica_2',carrMap['Instrumentación Quirúrgica'],'Psicología',2,2);
  matMap['Psicología|Instrumentación Quirúrgica|2']='mat_psicologia_instrumentacion_quirurgica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_psicologia_radiologia_2',carrMap['Radiología'],'Psicología',2,2);
  matMap['Psicología|Radiología|2']='mat_psicologia_radiologia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_psicologia_general_instrumentacion_quirurgica_2',carrMap['Instrumentación Quirúrgica'],'Psicología General',2,2);
  matMap['Psicología General|Instrumentación Quirúrgica|2']='mat_psicologia_general_instrumentacion_quirurgica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_quimica_aplicada_a_la_crimin_criminalistica_2',carrMap['Criminalística'],'Química Aplicada a la Criminalística',2,2);
  matMap['Química Aplicada a la Criminalística|Criminalística|2']='mat_quimica_aplicada_a_la_crimin_criminalistica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_quimica_cosmetica_cosmiatria_2',carrMap['Cosmiatría'],'Química Cosmética',2,2);
  matMap['Química Cosmética|Cosmiatría|2']='mat_quimica_cosmetica_cosmiatria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_quimica_inorganica_farmacia_2',carrMap['Farmacia'],'Química Inorgánica',2,2);
  matMap['Química Inorgánica|Farmacia|2']='mat_quimica_inorganica_farmacia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_salud_publica_cosmiatria_1',carrMap['Cosmiatría'],'Salud Pública',1,2);
  matMap['Salud Pública|Cosmiatría|1']='mat_salud_publica_cosmiatria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_salud_publica_enfermeria_1',carrMap['Enfermería'],'Salud Pública',1,2);
  matMap['Salud Pública|Enfermería|1']='mat_salud_publica_enfermeria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_salud_publica_farmacia_1',carrMap['Farmacia'],'Salud Pública',1,2);
  matMap['Salud Pública|Farmacia|1']='mat_salud_publica_farmacia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_salud_publica_instrumentacion_quirurgica_1',carrMap['Instrumentación Quirúrgica'],'Salud Pública',1,2);
  matMap['Salud Pública|Instrumentación Quirúrgica|1']='mat_salud_publica_instrumentacion_quirurgica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_salud_publica_radiologia_1',carrMap['Radiología'],'Salud Pública',1,2);
  matMap['Salud Pública|Radiología|1']='mat_salud_publica_radiologia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_semiologia_de_la_piel_i_cosmiatria_2',carrMap['Cosmiatría'],'Semiología de la Piel I',2,2);
  matMap['Semiología de la Piel I|Cosmiatría|2']='mat_semiologia_de_la_piel_i_cosmiatria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_sistema_de_potencia_electricidad_2',carrMap['Electricidad'],'Sistema de Potencia',2,2);
  matMap['Sistema de Potencia|Electricidad|2']='mat_sistema_de_potencia_electricidad_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_tecnicas_cosmeticas_cosmiatria_2',carrMap['Cosmiatría'],'Técnicas Cosméticas',2,2);
  matMap['Técnicas Cosméticas|Cosmiatría|2']='mat_tecnicas_cosmeticas_cosmiatria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_tecnicas_quirurgicas_general_instrumentacion_quirurgica_2',carrMap['Instrumentación Quirúrgica'],'Técnicas Quirúrgicas General y Especializada',2,2);
  matMap['Técnicas Quirúrgicas General y Especializada|Instrumentación Quirúrgica|2']='mat_tecnicas_quirurgicas_general_instrumentacion_quirurgica_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_tecnicas_radiologicas_iii_radiologia_2',carrMap['Radiología'],'Técnicas Radiológicas III',2,2);
  matMap['Técnicas Radiológicas III|Radiología|2']='mat_tecnicas_radiologicas_iii_radiologia_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_tecnicas_de_masajes_y_drenaj_cosmiatria_2',carrMap['Cosmiatría'],'Técnicas de Masajes y Drenaje Linfático',2,2);
  matMap['Técnicas de Masajes y Drenaje Linfático|Cosmiatría|2']='mat_tecnicas_de_masajes_y_drenaj_cosmiatria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_zootecnia_agropecuaria_2',carrMap['Agropecuaria'],'Zootecnia',2,2);
  matMap['Zootecnia|Agropecuaria|2']='mat_zootecnia_agropecuaria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_profesional_enfermeria_1',carrMap['Enfermería'],'Ética Profesional',1,2);
  matMap['Ética Profesional|Enfermería|1']='mat_etica_profesional_enfermeria_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_profesional_farmacia_1',carrMap['Farmacia'],'Ética Profesional',1,2);
  matMap['Ética Profesional|Farmacia|1']='mat_etica_profesional_farmacia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_profesional_instrumentacion_quirurgica_1',carrMap['Instrumentación Quirúrgica'],'Ética Profesional',1,2);
  matMap['Ética Profesional|Instrumentación Quirúrgica|1']='mat_etica_profesional_instrumentacion_quirurgica_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_profesional_radiologia_1',carrMap['Radiología'],'Ética Profesional',1,2);
  matMap['Ética Profesional|Radiología|1']='mat_etica_profesional_radiologia_1';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_y_legislacion_enfermeria_2',carrMap['Enfermería'],'Ética y Legislación',2,2);
  matMap['Ética y Legislación|Enfermería|2']='mat_etica_y_legislacion_enfermeria_2';
  db.prepare('INSERT OR IGNORE INTO materias (id,carrera_id,nombre,anio,horas_semanales) VALUES (?,?,?,?,?)').run('mat_etica_y_legislacion_farmacia_2',carrMap['Farmacia'],'Ética y Legislación',2,2);
  matMap['Ética y Legislación|Farmacia|2']='mat_etica_y_legislacion_farmacia_2';

  // ── ASIGNACIONES + HORARIOS ─────────────────────────────
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) { console.log('⚠ Sin período activo'); return; }
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_ingles_contabilidad_1_lun_1',docMap['Lic. Pamela Jiménez'],matMap['Inglés|Contabilidad|1'],cursoMap['Contabilidad|1|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_ingles_contabilidad_1_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_enfermeria_1_lun_1',docMap['Lic. Ana Ayala'],matMap['Salud Pública|Enfermería|1'],cursoMap['Enfermería|1|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_enfermeria_1_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_enfermeria_materno_infantil__enfermeria_2_lun_1',docMap['Lic. Micheli Romero'],matMap['Enfermería Materno Infantil I|Enfermería|2'],cursoMap['Enfermería|2|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_enfermeria_materno_infantil__enfermeria_2_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_farmacia_1_lun_1',docMap['Lic. Angela Aranda'],matMap['Salud Pública|Farmacia|1'],cursoMap['Farmacia|1|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_farmacia_1_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_lengua_extranjera_ingles_farmacia_2_lun_1',docMap['Lic. Pamela Jiménez'],matMap['Lengua Extranjera – Inglés|Farmacia|2'],cursoMap['Farmacia|2|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_lengua_extranjera_ingles_farmacia_2_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_instrumentacion_quirurgica_1_lun_1',docMap['Lic. Angela Aranda'],matMap['Salud Pública|Instrumentación Quirúrgica|1'],cursoMap['Instrumentación Quirúrgica|1|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_instrumentacion_quirurgica_1_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_patologia_quirurgica_instrumentacion_quirurgica_2_lun_1',docMap['Dr. Favio Rojas'],matMap['Patología Quirúrgica|Instrumentación Quirúrgica|2'],cursoMap['Instrumentación Quirúrgica|2|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_patologia_quirurgica_instrumentacion_quirurgica_2_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_radiologia_1_lun_1',docMap['Lic. Ana Ayala'],matMap['Salud Pública|Radiología|1'],cursoMap['Radiología|1|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_radiologia_1_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_fisica_radiologica_radiologia_2_lun_1',docMap['Rad. Paulo Higuchi'],matMap['Física Radiológica|Radiología|2'],cursoMap['Radiología|2|U'],periodo.id,1,'19:00','20:20','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_fisica_radiologica_radiologia_2_lun_1','Lunes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_enfermeria_1_lun_2',docMap['Rad. Paulo Higuchi'],matMap['Anatomía y Fisiología Humana|Enfermería|1'],cursoMap['Enfermería|1|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_enfermeria_1_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_enfermeria_en_salud_del_adul_enfermeria_2_lun_2',docMap['Lic. Ana Ayala'],matMap['Enfermería en Salud del Adulto I / II|Enfermería|2'],cursoMap['Enfermería|2|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_enfermeria_en_salud_del_adul_enfermeria_2_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_farmacia_1_lun_2',docMap['Dr. Favio Rojas'],matMap['Anatomía y Fisiología Humana|Farmacia|1'],cursoMap['Farmacia|1|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_farmacia_1_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_quimica_inorganica_farmacia_2_lun_2',docMap['Lic. Angela Aranda'],matMap['Química Inorgánica|Farmacia|2'],cursoMap['Farmacia|2|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_quimica_inorganica_farmacia_2_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_instrumentacion_quirurgica_1_lun_2',docMap['Dr. Favio Rojas'],matMap['Anatomía y Fisiología Humana|Instrumentación Quirúrgica|1'],cursoMap['Instrumentación Quirúrgica|1|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_instrumentacion_quirurgica_1_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_medicina_legal_y_etica_instrumentacion_quirurgica_2_lun_2',docMap['Abg. César Alum'],matMap['Medicina Legal y Ética|Instrumentación Quirúrgica|2'],cursoMap['Instrumentación Quirúrgica|2|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_medicina_legal_y_etica_instrumentacion_quirurgica_2_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_radiologia_1_lun_2',docMap['Rad. Paulo Higuchi'],matMap['Anatomía y Fisiología Humana|Radiología|1'],cursoMap['Radiología|1|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_radiologia_1_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_tecnicas_radiologicas_iii_radiologia_2_lun_2',docMap['Lic. Marcial Palacios'],matMap['Técnicas Radiológicas III|Radiología|2'],cursoMap['Radiología|2|U'],periodo.id,2,'20:40','22:00','Lunes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_tecnicas_radiologicas_iii_radiologia_2_lun_2','Lunes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_apicultura_agropecuaria_1_mar_1',docMap['Lic. Nelly Carmona'],matMap['Apicultura|Agropecuaria|1'],cursoMap['Agropecuaria|1|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_apicultura_agropecuaria_1_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_equipos_y_maquinarias_agrope_agropecuaria_2_mar_1',docMap['Lic. Mirta Giménez'],matMap['Equipos y Maquinarias Agropecuarias|Agropecuaria|2'],cursoMap['Agropecuaria|2|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_equipos_y_maquinarias_agrope_agropecuaria_2_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_dermatologia_basica_tecnicas_cosmiatria_1_mar_1',docMap['Lic. Raqueline Carballo'],matMap['Dermatología Básica / Técnicas Faciales|Cosmiatría|1'],cursoMap['Cosmiatría|1|A'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_dermatologia_basica_tecnicas_cosmiatria_1_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_quimica_cosmetica_cosmiatria_2_mar_1',docMap['Lic. Noelia Ayala'],matMap['Química Cosmética|Cosmiatría|2'],cursoMap['Cosmiatría|2|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_quimica_cosmetica_cosmiatria_2_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_cosmiatria_1_mar_1',docMap['Rad. Paulo Higuchi'],matMap['Anatomía y Fisiología Humana|Cosmiatría|1'],cursoMap['Cosmiatría|1|B'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_cosmiatria_1_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_aspectos_legales_del_peritaj_criminalistica_1_mar_1',docMap['Abg. María Paz Ocampos'],matMap['Aspectos Legales del Peritaje|Criminalística|1'],cursoMap['Criminalística|1|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_aspectos_legales_del_peritaj_criminalistica_1_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_dibujo_tecnico_y_pericial_criminalistica_2_mar_1',docMap['Lic. Nelson Domínguez'],matMap['Dibujo Técnico y Pericial|Criminalística|2'],cursoMap['Criminalística|2|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_dibujo_tecnico_y_pericial_criminalistica_2_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_electronica_analogica_electricidad_2_mar_1',docMap['Ing. Oscar Mareco'],matMap['Electrónica Analógica|Electricidad|2'],cursoMap['Electricidad|2|U'],periodo.id,1,'19:00','20:20','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_electronica_analogica_electricidad_2_mar_1','Martes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_deontologia_y_etica_profesio_agropecuaria_1_mar_2',docMap['Abg. César Alum'],matMap['Deontología y Ética Profesional|Agropecuaria|1'],cursoMap['Agropecuaria|1|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_deontologia_y_etica_profesio_agropecuaria_1_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_cultivos_forrajes_y_pasturas_agropecuaria_2_mar_2',docMap['Lic. Mirta Giménez'],matMap['Cultivos, Forrajes y Pasturas|Agropecuaria|2'],cursoMap['Agropecuaria|2|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_cultivos_forrajes_y_pasturas_agropecuaria_2_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_biologia_de_la_piel_i_ii_cosmiatria_1_mar_2',docMap['Lic. Noelia Ayala'],matMap['Biología de la Piel I / II|Cosmiatría|1'],cursoMap['Cosmiatría|1|A'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_biologia_de_la_piel_i_ii_cosmiatria_1_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_semiologia_de_la_piel_i_cosmiatria_2_mar_2',docMap['Dr. Favio Rojas'],matMap['Semiología de la Piel I|Cosmiatría|2'],cursoMap['Cosmiatría|2|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_semiologia_de_la_piel_i_cosmiatria_2_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_dermatologia_basica_tecnicas_cosmiatria_1_mar_2',docMap['Lic. Raqueline Carballo'],matMap['Dermatología Básica / Técnicas Faciales|Cosmiatría|1'],cursoMap['Cosmiatría|1|B'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_dermatologia_basica_tecnicas_cosmiatria_1_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_deontologia_y_etica_profesio_criminalistica_1_mar_2',docMap['Abg. César Alum'],matMap['Deontología y Ética Profesional|Criminalística|1'],cursoMap['Criminalística|1|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_deontologia_y_etica_profesio_criminalistica_1_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_criminologia_y_victimologia_criminalistica_2_mar_2',docMap['Lic. Nelson Domínguez'],matMap['Criminología y Victimología|Criminalística|2'],cursoMap['Criminalística|2|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_criminologia_y_victimologia_criminalistica_2_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_electrotecnia_i_electricidad_2_mar_2',docMap['Ing. Oscar Mareco'],matMap['Electrotecnia I|Electricidad|2'],cursoMap['Electricidad|2|U'],periodo.id,2,'20:40','22:00','Martes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_electrotecnia_i_electricidad_2_mar_2','Martes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_ingles_agropecuaria_1_mié_1',docMap['Lic. Pamela Jiménez'],matMap['Inglés|Agropecuaria|1'],cursoMap['Agropecuaria|1|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_ingles_agropecuaria_1_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_ingles_agropecuaria_2_mié_1',docMap['Lic. Pamela Jiménez'],matMap['Inglés|Agropecuaria|2'],cursoMap['Agropecuaria|2|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_ingles_agropecuaria_2_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_castellano_contabilidad_1_mié_1',docMap['Lic. Maria Elena Perez de Cantero'],matMap['Castellano|Contabilidad|1'],cursoMap['Contabilidad|1|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_castellano_contabilidad_1_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_en_cosmiatria_cosmiatria_1_mié_1',docMap['Dra. Cinthia Espínola'],matMap['Farmacología en Cosmiatría|Cosmiatría|1'],cursoMap['Cosmiatría|1|A'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_en_cosmiatria_cosmiatria_1_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_competencias_socioemocionale_cosmiatria_2_mié_1',docMap['Lic. Jannyne Torales'],matMap['Competencias Socioemocionales|Cosmiatría|2'],cursoMap['Cosmiatría|2|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_competencias_socioemocionale_cosmiatria_2_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_biologia_de_la_piel_i_ii_cosmiatria_1_mié_1',docMap['Lic. Noelia Ayala'],matMap['Biología de la Piel I / II|Cosmiatría|1'],cursoMap['Cosmiatría|1|B'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_biologia_de_la_piel_i_ii_cosmiatria_1_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_comunicacion_escrita_y_oral__criminalistica_1_mié_1',docMap['Lic. Maria Elena Perez de Cantero'],matMap['Comunicación Escrita y Oral y Lengua Guaraní|Criminalística|1'],cursoMap['Criminalística|1|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_comunicacion_escrita_y_oral__criminalistica_1_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_quimica_aplicada_a_la_crimin_criminalistica_2_mié_1',docMap['Lic. Angela Aranda'],matMap['Química Aplicada a la Criminalística|Criminalística|2'],cursoMap['Criminalística|2|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_quimica_aplicada_a_la_crimin_criminalistica_2_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_ingles_electricidad_2_mié_1',docMap['Lic. Pamela Jiménez'],matMap['Inglés|Electricidad|2'],cursoMap['Electricidad|2|U'],periodo.id,1,'19:00','20:20','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_ingles_electricidad_2_mié_1','Miércoles',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_contabilidad_basica_contabilidad_1_mié_2',docMap['Lic. Mirta Giménez'],matMap['Contabilidad Básica|Contabilidad|1'],cursoMap['Contabilidad|1|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_contabilidad_basica_contabilidad_1_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_primeros_auxilios_enfermeria_1_mié_2',docMap['Lic. Micheli Romero'],matMap['Primeros Auxilios|Enfermería|1'],cursoMap['Enfermería|1|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_primeros_auxilios_enfermeria_1_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_y_legislacion_enfermeria_2_mié_2',docMap['Abg. Myrian Carrillo'],matMap['Ética y Legislación|Enfermería|2'],cursoMap['Enfermería|2|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_y_legislacion_enfermeria_2_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_calidad_en_salud_farmacia_1_mié_2',docMap['Lic. Blanca Villar'],matMap['Calidad en Salud|Farmacia|1'],cursoMap['Farmacia|1|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_calidad_en_salud_farmacia_1_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_y_legislacion_farmacia_2_mié_2',docMap['Abg. Myrian Carrillo'],matMap['Ética y Legislación|Farmacia|2'],cursoMap['Farmacia|2|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_y_legislacion_farmacia_2_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_calidad_en_salud_instrumentacion_quirurgica_1_mié_2',docMap['Lic. Blanca Villar'],matMap['Calidad en Salud|Instrumentación Quirúrgica|1'],cursoMap['Instrumentación Quirúrgica|1|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_calidad_en_salud_instrumentacion_quirurgica_1_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_tecnicas_quirurgicas_general_instrumentacion_quirurgica_2_mié_2',docMap['Inst. Karen González'],matMap['Técnicas Quirúrgicas General y Especializada|Instrumentación Quirúrgica|2'],cursoMap['Instrumentación Quirúrgica|2|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_tecnicas_quirurgicas_general_instrumentacion_quirurgica_2_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_primeros_auxilios_radiologia_1_mié_2',docMap['Lic. Micheli Romero'],matMap['Primeros Auxilios|Radiología|1'],cursoMap['Radiología|1|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_primeros_auxilios_radiologia_1_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_administracion_hospitalaria_radiologia_2_mié_2',docMap['Lic. Angela Aranda'],matMap['Administración Hospitalaria|Radiología|2'],cursoMap['Radiología|2|U'],periodo.id,2,'20:40','22:00','Miércoles');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_administracion_hospitalaria_radiologia_2_mié_2','Miércoles',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_productividad_agropecuaria_agropecuaria_1_jue_1',docMap['Lic. Mirta Giménez'],matMap['Productividad Agropecuaria|Agropecuaria|1'],cursoMap['Agropecuaria|1|U'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_productividad_agropecuaria_agropecuaria_1_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_zootecnia_agropecuaria_2_jue_1',docMap['Lic. Nelly Carmona'],matMap['Zootecnia|Agropecuaria|2'],cursoMap['Agropecuaria|2|U'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_zootecnia_agropecuaria_2_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_cosmiatria_1_jue_1',docMap['Dr. Favio Rojas'],matMap['Anatomía y Fisiología Humana|Cosmiatría|1'],cursoMap['Cosmiatría|1|A'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_anatomia_y_fisiologia_humana_cosmiatria_1_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_tecnicas_de_masajes_y_drenaj_cosmiatria_2_jue_1',docMap['Lic. Raqueline Carballo'],matMap['Técnicas de Masajes y Drenaje Linfático|Cosmiatría|2'],cursoMap['Cosmiatría|2|U'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_tecnicas_de_masajes_y_drenaj_cosmiatria_2_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_cosmiatria_1_jue_1',docMap['Dra. Natalia Valenzuela'],matMap['Salud Pública|Cosmiatría|1'],cursoMap['Cosmiatría|1|B'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_cosmiatria_1_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_introduccion_a_la_criminalis_criminalistica_1_jue_1',docMap['Lic. Nelson Domínguez'],matMap['Introducción a la Criminalística|Criminalística|1'],cursoMap['Criminalística|1|U'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_introduccion_a_la_criminalis_criminalistica_1_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_maquinarias_electricas_electricidad_2_jue_1',docMap['Ing. Oscar Mareco'],matMap['Maquinarias Eléctricas|Electricidad|2'],cursoMap['Electricidad|2|U'],periodo.id,1,'19:00','20:20','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_maquinarias_electricas_electricidad_2_jue_1','Jueves',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_produccion_porcina_agropecuaria_1_jue_2',docMap['Lic. Mirta Giménez'],matMap['Producción Porcina|Agropecuaria|1'],cursoMap['Agropecuaria|1|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_produccion_porcina_agropecuaria_1_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_produccion_porcina_agropecuaria_2_jue_2',docMap['Lic. Mirta Giménez'],matMap['Producción Porcina|Agropecuaria|2'],cursoMap['Agropecuaria|2|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_produccion_porcina_agropecuaria_2_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_salud_publica_cosmiatria_1_jue_2',docMap['Dr. Favio Rojas'],matMap['Salud Pública|Cosmiatría|1'],cursoMap['Cosmiatría|1|A'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_salud_publica_cosmiatria_1_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_tecnicas_cosmeticas_cosmiatria_2_jue_2',docMap['Lic. Raqueline Carballo'],matMap['Técnicas Cosméticas|Cosmiatría|2'],cursoMap['Cosmiatría|2|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_tecnicas_cosmeticas_cosmiatria_2_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_cosmiatria_1_jue_2',docMap['Dra. Cinthia Espínola'],matMap['Farmacología|Cosmiatría|1'],cursoMap['Cosmiatría|1|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_cosmiatria_1_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_introduccion_al_derecho_criminalistica_1_jue_2',docMap['Abg. Gabriel Sharp'],matMap['Introducción al Derecho|Criminalística|1'],cursoMap['Criminalística|1|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_introduccion_al_derecho_criminalistica_1_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_accidentologia_vial_criminalistica_2_jue_2',docMap['Lic. Nelson Domínguez'],matMap['Accidentología Vial|Criminalística|2'],cursoMap['Criminalística|2|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_accidentologia_vial_criminalistica_2_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_sistema_de_potencia_electricidad_2_jue_2',docMap['Ing. Oscar Mareco'],matMap['Sistema de Potencia|Electricidad|2'],cursoMap['Electricidad|2|U'],periodo.id,2,'20:40','22:00','Jueves');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_sistema_de_potencia_electricidad_2_jue_2','Jueves',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_profesional_enfermeria_1_vie_1',docMap['Abg. Myrian Carrillo'],matMap['Ética Profesional|Enfermería|1'],cursoMap['Enfermería|1|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_profesional_enfermeria_1_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_farmacia_1_vie_1',docMap['Lic. Gabriela Agüero'],matMap['Farmacología|Farmacia|1'],cursoMap['Farmacia|1|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_farmacia_1_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_cosmetologia_basica_farmacia_2_vie_1',docMap['Lic. Noelia Ayala'],matMap['Cosmetología Básica|Farmacia|2'],cursoMap['Farmacia|2|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_cosmetologia_basica_farmacia_2_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_instrumentacion_quirurgica_1_vie_1',docMap['Lic. Gabriela Agüero'],matMap['Farmacología|Instrumentación Quirúrgica|1'],cursoMap['Instrumentación Quirúrgica|1|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_instrumentacion_quirurgica_1_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_psicologia_instrumentacion_quirurgica_2_vie_1',docMap['Lic. Natalia Martínez'],matMap['Psicología|Instrumentación Quirúrgica|2'],cursoMap['Instrumentación Quirúrgica|2|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_psicologia_instrumentacion_quirurgica_2_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_profesional_radiologia_1_vie_1',docMap['Abg. Myrian Carrillo'],matMap['Ética Profesional|Radiología|1'],cursoMap['Radiología|1|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_profesional_radiologia_1_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_psicologia_radiologia_2_vie_1',docMap['Lic. Natalia Martínez'],matMap['Psicología|Radiología|2'],cursoMap['Radiología|2|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_psicologia_radiologia_2_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_matematica_contabilidad_1_vie_1',docMap['Abg. Gabriel Sharp'],matMap['Matematica|Contabilidad|1'],cursoMap['Contabilidad|1|U'],periodo.id,1,'19:00','20:20','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_matematica_contabilidad_1_vie_1','Viernes',1,'19:00','20:20');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_introduccion_a_la_administra_contabilidad_1_vie_2',docMap['Lic. Mirta Giménez'],matMap['Introducción a la Administración|Contabilidad|1'],cursoMap['Contabilidad|1|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_introduccion_a_la_administra_contabilidad_1_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_enfermeria_1_vie_2',docMap['Dr. Favio Rojas'],matMap['Farmacología|Enfermería|1'],cursoMap['Enfermería|1|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_enfermeria_1_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_profesional_farmacia_1_vie_2',docMap['Abg. Myrian Carrillo'],matMap['Ética Profesional|Farmacia|1'],cursoMap['Farmacia|1|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_profesional_farmacia_1_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacotecnia_ii_farmacia_2_vie_2',docMap['Lic. Gabriela Agüero'],matMap['Farmacotécnia II|Farmacia|2'],cursoMap['Farmacia|2|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacotecnia_ii_farmacia_2_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_etica_profesional_instrumentacion_quirurgica_1_vie_2',docMap['Abg. Myrian Carrillo'],matMap['Ética Profesional|Instrumentación Quirúrgica|1'],cursoMap['Instrumentación Quirúrgica|1|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_etica_profesional_instrumentacion_quirurgica_1_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_psicologia_general_instrumentacion_quirurgica_2_vie_2',docMap['Lic. Natalia Martínez'],matMap['Psicología General|Instrumentación Quirúrgica|2'],cursoMap['Instrumentación Quirúrgica|2|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_psicologia_general_instrumentacion_quirurgica_2_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_farmacologia_radiologia_1_vie_2',docMap['Dr. Favio Rojas'],matMap['Farmacología|Radiología|1'],cursoMap['Radiología|1|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_farmacologia_radiologia_1_vie_2','Viernes',2,'20:40','22:00');
  horN++;
  db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin,dia) VALUES (?,?,?,?,?,?,?,?,?)').run('asig_practicas_radiologicas_iii_radiologia_2_vie_2',docMap['Lic. Marcial Palacios'],matMap['Prácticas Radiológicas III|Radiología|2'],cursoMap['Radiología|2|U'],periodo.id,2,'20:40','22:00','Viernes');
  asigN++;
  db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?)').run('asig_practicas_radiologicas_iii_radiologia_2_vie_2','Viernes',2,'20:40','22:00');
  horN++;

  console.log(`✅ Seed ITS completado: ${asigN} asignaciones, ${horN} horarios`);
}
