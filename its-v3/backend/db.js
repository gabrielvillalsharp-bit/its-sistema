const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'its.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institucion (
      id INTEGER PRIMARY KEY DEFAULT 1,
      nombre TEXT NOT NULL DEFAULT 'Instituto Técnico Superior',
      direccion TEXT, telefono TEXT, email TEXT, mision TEXT
    );

    CREATE TABLE IF NOT EXISTS periodos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL, anio INTEGER NOT NULL,
      semestre TEXT NOT NULL, fecha_inicio TEXT, fecha_fin TEXT,
      activo INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS carreras (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL, codigo TEXT NOT NULL UNIQUE,
      turno TEXT, semestres INTEGER DEFAULT 4, activa INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cursos (
      id TEXT PRIMARY KEY,
      carrera_id TEXT NOT NULL REFERENCES carreras(id) ON DELETE CASCADE,
      anio INTEGER NOT NULL,
      division TEXT NOT NULL DEFAULT 'U',
      turno TEXT, activo INTEGER DEFAULT 1,
      UNIQUE(carrera_id, anio, division)
    );

    CREATE TABLE IF NOT EXISTS materias (
      id TEXT PRIMARY KEY,
      carrera_id TEXT NOT NULL REFERENCES carreras(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL, codigo TEXT,
      horas_semanales INTEGER DEFAULT 4,
      anio INTEGER DEFAULT 1,
      -- Pesos configurables por materia (deben sumar 100)
      peso_tp INTEGER DEFAULT 25,
      peso_parcial INTEGER DEFAULT 25,
      peso_final INTEGER DEFAULT 50
    );

    -- Escala de calificaciones (configurable por institución)
    CREATE TABLE IF NOT EXISTS escala_notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota INTEGER NOT NULL,          -- 1, 2, 3, 4, 5
      puntaje_min INTEGER NOT NULL,   -- 0, 70, 78, 86, 94
      puntaje_max INTEGER NOT NULL,   -- 69, 77, 85, 93, 100
      descripcion TEXT                -- Insuficiente, Suficiente...
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL, apellido TEXT NOT NULL,
      ci TEXT UNIQUE, email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK(rol IN ('director','docente','alumno','admin','secretaria')),
      activo INTEGER DEFAULT 1,
      fecha_registro TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS docentes (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL REFERENCES usuarios(id),
      especialidad TEXT, titulo TEXT, telefono TEXT
    );

    CREATE TABLE IF NOT EXISTS alumnos (
      id TEXT PRIMARY KEY,
      usuario_id TEXT REFERENCES usuarios(id),
      matricula TEXT UNIQUE,
      carrera_id TEXT NOT NULL REFERENCES carreras(id),
      curso_id TEXT REFERENCES cursos(id),
      fecha_ingreso TEXT, estado TEXT DEFAULT 'Activo',
      telefono TEXT, direccion TEXT, ci TEXT, nombre TEXT, apellido TEXT
    );

    CREATE TABLE IF NOT EXISTS asignaciones (
      id TEXT PRIMARY KEY,
      docente_id TEXT NOT NULL REFERENCES docentes(id),
      materia_id TEXT NOT NULL REFERENCES materias(id),
      curso_id TEXT NOT NULL REFERENCES cursos(id),
      periodo_id INTEGER NOT NULL REFERENCES periodos(id),
      UNIQUE(materia_id, curso_id, periodo_id)
    );

    -- Tabla de notas con todas las instancias
    CREATE TABLE IF NOT EXISTS notas (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),

      -- Instancias de evaluación
      tp REAL,                    -- Trabajo Práctico (max según peso_tp)
      parcial REAL,               -- Parcial ordinario
      parcial_recuperatorio REAL, -- Si rinde, reemplaza al parcial
      final REAL,                 -- Final ordinario
      final_extraordinario REAL,  -- Si rinde, reemplaza al final ordinario

      -- Calculados automáticamente
      parcial_efectivo REAL,      -- recuperatorio ?? parcial
      final_efectivo REAL,        -- extraordinario ?? final
      puntaje_total REAL,         -- suma ponderada sobre 100
      nota_final INTEGER,         -- 1 a 5 según escala
      estado TEXT DEFAULT 'Pendiente', -- Pendiente / Aprobado / Reprobado

      UNIQUE(alumno_id, asignacion_id)
    );

    CREATE TABLE IF NOT EXISTS asistencia (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      fecha TEXT NOT NULL, estado TEXT NOT NULL CHECK(estado IN ('P','A','T','J')),
      observacion TEXT,
      UNIQUE(alumno_id, asignacion_id, fecha)
    );

    CREATE TABLE IF NOT EXISTS pagos (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id),
      periodo_id INTEGER REFERENCES periodos(id),
      concepto TEXT NOT NULL, monto REAL NOT NULL,
      fecha_pago TEXT, estado TEXT DEFAULT 'Pagado', comprobante TEXT
    );
  `);

  // Escala de notas por defecto
  if (!db.prepare('SELECT id FROM escala_notas LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO escala_notas (nota,puntaje_min,puntaje_max,descripcion) VALUES (?,?,?,?)');
    ins.run(1, 0,  69, 'Insuficiente');
    ins.run(2, 70, 77, 'Suficiente');
    ins.run(3, 78, 85, 'Bueno');
    ins.run(4, 86, 93, 'Muy Bueno');
    ins.run(5, 94, 100,'Sobresaliente');
  }

  // Institución
  if (!db.prepare('SELECT id FROM institucion WHERE id=1').get()) {
    db.prepare(`INSERT INTO institucion (id,nombre,direccion,telefono,email,mision) VALUES
      (1,'Instituto Técnico Superior','Av. Mcal. López 1200, Pedro Juan Caballero, Amambay',
      '0336-272-000','secretaria@its.edu.py',
      'Formar profesionales técnicos de excelencia al servicio de la comunidad')`).run();
  }

  // Período
  if (!db.prepare('SELECT id FROM periodos LIMIT 1').get()) {
    db.prepare(`INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin,activo)
      VALUES ('2026 — 1er Semestre',2026,'1ro','2026-03-01','2026-07-31',1)`).run();
  }

  // Carreras
  if (!db.prepare('SELECT id FROM carreras LIMIT 1').get()) {
    const insC = db.prepare('INSERT INTO carreras (id,nombre,codigo,turno,semestres) VALUES (?,?,?,?,?)');
    [
      ['agro','Agropecuaria','AGR','Mañana',4],
      ['crim','Criminalística','CRM','Tarde',4],
      ['farm','Farmacia','FAR','Mañana',4],
      ['cosm','Cosmiatría','COS','Tarde',4],
      ['enfe','Enfermería','ENF','Mañana',4],
      ['elec','Eléctrica Industrial','ELC','Noche',4],
      ['radio','Radiología','RAD','Mañana',4],
      ['instr','Instrumentación Quirúrgica','IQU','Tarde',4],
    ].forEach(c => insC.run(...c));

    // Cursos ejemplo Criminalística
    const insCu = db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division,turno) VALUES (?,?,?,?,?)');
    insCu.run('crim_1a','crim',1,'A','Tarde');
    insCu.run('crim_1b','crim',1,'B','Tarde');
    insCu.run('crim_2u','crim',2,'U','Tarde');

    // Materias con pesos
    const insM = db.prepare('INSERT INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)');
    insM.run('m1','crim','Introducción al Derecho','CRM-101',4,1,25,25,50);
    insM.run('m2','crim','Criminalística General','CRM-102',4,1,25,25,50);
    insM.run('m3','crim','Medicina Legal','CRM-201',3,2,25,25,50);
    insM.run('m4','farm','Química Orgánica','FAR-101',4,1,25,25,50);
    insM.run('m5','farm','Farmacología I','FAR-102',4,1,25,25,50);
    insM.run('m6','enfe','Anatomía y Fisiología','ENF-101',5,1,25,25,50);
    insM.run('m7','enfe','Enfermería Básica','ENF-102',4,1,25,25,50);
  }

  // Cuentas iniciales
  const cuentasInit = [
    { id:'u_dir',     nombre:'Roberto', apellido:'Martínez', ci:'1.111.111', email:'director@its.edu.py', pass:'director123', rol:'director' },
    { id:'u_adm',     nombre:'Secretaría', apellido:'Académica', ci:'2.222.222', email:'admin@its.edu.py', pass:'admin123', rol:'admin' },
    { id:'u_gabriel', nombre:'Gabriel', apellido:'', ci:'', email:'gabriel@its.edu.py', pass:'gabriel1234', rol:'director' },
    { id:'u_delia',   nombre:'Delia',   apellido:'', ci:'', email:'delia@its.edu.py',   pass:'delia1234',   rol:'director' },
    { id:'u_lujan',   nombre:'Lujan',   apellido:'', ci:'', email:'lujan@its.edu.py',   pass:'lujan1234',   rol:'director' },
  ];
  cuentasInit.forEach(c => {
    if (!db.prepare('SELECT id FROM usuarios WHERE email=?').get(c.email)) {
      db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(c.id, c.nombre, c.apellido, c.ci, c.email, bcrypt.hashSync(c.pass, 10), c.rol);
    }
  });

  console.log('✓ ITS Sistema v3 — base de datos lista');
}

// Función para calcular nota a partir de puntaje usando la escala
function calcularNota(puntaje) {
  const escala = db.prepare('SELECT nota FROM escala_notas WHERE puntaje_min<=? AND puntaje_max>=?').get(puntaje, puntaje);
  return escala ? escala.nota : 1;
}

// Función principal de cálculo de notas
function calcularPuntaje(tp, parcial, parcial_rec, final, final_ext, peso_tp, peso_parcial, peso_final) {
  const parcial_ef = (parcial_rec !== null && parcial_rec !== undefined) ? parcial_rec : parcial;
  const final_ef   = (final_ext  !== null && final_ext  !== undefined) ? final_ext  : final;

  if (tp === null || tp === undefined) return { puntaje: null, nota: null, parcial_ef, final_ef };
  if (parcial_ef === null || parcial_ef === undefined) return { puntaje: null, nota: null, parcial_ef, final_ef };
  if (final_ef === null || final_ef === undefined) return { puntaje: null, nota: null, parcial_ef, final_ef };

  // Cada instancia se puntúa sobre su máximo y se pondera
  const pts_tp      = (tp       / peso_tp)      * peso_tp;
  const pts_parcial = (parcial_ef / peso_parcial) * peso_parcial;
  const pts_final   = (final_ef   / peso_final)   * peso_final;
  const puntaje     = Math.round((pts_tp + pts_parcial + pts_final) * 10) / 10;
  const nota        = calcularNota(puntaje);
  return { puntaje, nota, parcial_ef, final_ef };
}

module.exports = { db, init, calcularNota, calcularPuntaje };
