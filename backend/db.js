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

// ── CÁLCULO DE PUNTAJE ────────────────────────────────────────────────────────
function calcularPuntaje(tp, parcial, parcial_recuperatorio, final, final_extraordinario, peso_tp, peso_parcial, peso_final) {
  let parcial_ef = null;
  if (parcial !== null && parcial !== undefined) {
    parcial_ef = parcial;
    if (parcial_recuperatorio !== null && parcial_recuperatorio !== undefined && parcial_recuperatorio > parcial)
      parcial_ef = parcial_recuperatorio;
  } else if (parcial_recuperatorio !== null && parcial_recuperatorio !== undefined) {
    parcial_ef = parcial_recuperatorio;
  }

  let final_ef = null;
  if (final !== null && final !== undefined) {
    final_ef = final;
    if (final_extraordinario !== null && final_extraordinario !== undefined && final_extraordinario > final)
      final_ef = final_extraordinario;
  } else if (final_extraordinario !== null && final_extraordinario !== undefined) {
    final_ef = final_extraordinario;
  }

  if (tp === null && parcial_ef === null && final_ef === null)
    return { puntaje: null, nota: null, parcial_ef, final_ef };

  const pt = (peso_tp || 25) / 100;
  const pp = (peso_parcial || 25) / 100;
  const pf = (peso_final || 50) / 100;

  let puntaje = 0, pesoUsado = 0;
  if (tp !== null)         { puntaje += tp * pt;         pesoUsado += pt; }
  if (parcial_ef !== null) { puntaje += parcial_ef * pp; pesoUsado += pp; }
  if (final_ef !== null)   { puntaje += final_ef * pf;   pesoUsado += pf; }
  if (pesoUsado > 0 && pesoUsado < 1) puntaje = puntaje / pesoUsado;

  puntaje = Math.round(puntaje * 100) / 100;
  const escala = db.prepare('SELECT nota FROM escala_notas WHERE puntaje_min<=? AND puntaje_max>=? LIMIT 1').get(puntaje, puntaje);
  return { puntaje, nota: escala ? escala.nota : null, parcial_ef, final_ef };
}

// ── TABLAS ────────────────────────────────────────────────────────────────────
function crearTablas() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institucion (
      id INTEGER PRIMARY KEY DEFAULT 1,
      nombre TEXT NOT NULL DEFAULT 'Instituto Técnico Superior',
      direccion TEXT, telefono TEXT, email TEXT, mision TEXT
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
      tp REAL, parcial REAL, parcial_recuperatorio REAL,
      final REAL, final_extraordinario REAL,
      parcial_efectivo REAL, final_efectivo REAL,
      puntaje_total REAL, nota_final INTEGER,
      estado TEXT DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','Aprobado','Reprobado')),
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
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('Parcial','Final','Recuperatorio','Extraordinario')),
      fecha TEXT NOT NULL, hora TEXT, aula TEXT,
      periodo_id INTEGER NOT NULL REFERENCES periodos(id),
      observacion TEXT
    );
    CREATE TABLE IF NOT EXISTS avisos (
      id TEXT PRIMARY KEY,
      titulo TEXT NOT NULL,
      contenido TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'info' CHECK(tipo IN ('info','urgente','examen','administrativo')),
      fijado INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
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

  // Período lectivo 2025
  if (!db.prepare('SELECT id FROM periodos WHERE anio=2025').get()) {
    db.prepare('INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin,activo) VALUES (?,?,?,?,?,1)')
      .run('Año Lectivo 2025', 2025, 1, '2025-03-01', '2025-11-30');
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
  // Migraciones para bases de datos existentes
  try { db.prepare("ALTER TABLE pagos ADD COLUMN medio_pago TEXT DEFAULT 'Efectivo'").run(); } catch {}
  seedDatos();
  console.log('✓ Base de datos lista en:', DB_PATH);
}

module.exports = { db, init, calcularPuntaje };
