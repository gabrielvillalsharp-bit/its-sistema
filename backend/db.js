const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'its.db');

// Asegura que el directorio exista
const fs = require('fs');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── CÁLCULO DE PUNTAJE ────────────────────────────────────────────────────────
/**
 * Calcula el puntaje final de un alumno según los pesos de la materia.
 * - El parcial recuperatorio reemplaza al parcial si es mayor.
 * - El final extraordinario reemplaza al final si es mayor.
 * - Retorna { puntaje, nota, parcial_ef, final_ef }
 */
function calcularPuntaje(tp, parcial, parcial_recuperatorio, final, final_extraordinario, peso_tp, peso_parcial, peso_final) {
  // Determinar el parcial efectivo (el mayor entre parcial y recuperatorio)
  let parcial_ef = null;
  if (parcial !== null && parcial !== undefined) {
    parcial_ef = parcial;
    if (parcial_recuperatorio !== null && parcial_recuperatorio !== undefined && parcial_recuperatorio > parcial) {
      parcial_ef = parcial_recuperatorio;
    }
  } else if (parcial_recuperatorio !== null && parcial_recuperatorio !== undefined) {
    parcial_ef = parcial_recuperatorio;
  }

  // Determinar el final efectivo (el mayor entre final y extraordinario)
  let final_ef = null;
  if (final !== null && final !== undefined) {
    final_ef = final;
    if (final_extraordinario !== null && final_extraordinario !== undefined && final_extraordinario > final) {
      final_ef = final_extraordinario;
    }
  } else if (final_extraordinario !== null && final_extraordinario !== undefined) {
    final_ef = final_extraordinario;
  }

  // Si no hay suficientes datos, no calcular
  if (tp === null && parcial_ef === null && final_ef === null) {
    return { puntaje: null, nota: null, parcial_ef, final_ef };
  }

  // Pesos normalizados (por defecto 25/25/50)
  const pt = (peso_tp || 25) / 100;
  const pp = (peso_parcial || 25) / 100;
  const pf = (peso_final || 50) / 100;

  // Calcular puntaje ponderado (solo con los componentes disponibles)
  let puntaje = 0;
  let pesoUsado = 0;

  if (tp !== null) { puntaje += tp * pt; pesoUsado += pt; }
  if (parcial_ef !== null) { puntaje += parcial_ef * pp; pesoUsado += pp; }
  if (final_ef !== null) { puntaje += final_ef * pf; pesoUsado += pf; }

  // Normalizar si no están todos los componentes
  if (pesoUsado > 0 && pesoUsado < 1) {
    puntaje = puntaje / pesoUsado;
  }

  puntaje = Math.round(puntaje * 100) / 100;

  // Determinar nota según la escala (se resuelve en la DB, pero calculamos aprox)
  const nota = calcularNota(puntaje);

  return { puntaje, nota, parcial_ef, final_ef };
}

function calcularNota(puntaje) {
  if (puntaje === null) return null;
  const escala = db.prepare('SELECT nota FROM escala_notas WHERE puntaje_min<=? AND puntaje_max>=? LIMIT 1').get(puntaje, puntaje);
  return escala ? escala.nota : null;
}

// ── INICIALIZACIÓN DE TABLAS ──────────────────────────────────────────────────
function init() {
  db.exec(`
    -- Institución
    CREATE TABLE IF NOT EXISTS institucion (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      nombre      TEXT NOT NULL DEFAULT 'Instituto Técnico Superior',
      direccion   TEXT,
      telefono    TEXT,
      email       TEXT,
      mision      TEXT
    );

    -- Escala de notas
    CREATE TABLE IF NOT EXISTS escala_notas (
      id          TEXT PRIMARY KEY,
      nota        INTEGER NOT NULL,
      puntaje_min REAL NOT NULL,
      puntaje_max REAL NOT NULL,
      descripcion TEXT
    );

    -- Usuarios (directores, docentes, alumnos)
    CREATE TABLE IF NOT EXISTS usuarios (
      id             TEXT PRIMARY KEY,
      nombre         TEXT NOT NULL,
      apellido       TEXT,
      ci             TEXT UNIQUE,
      email          TEXT UNIQUE,
      password_hash  TEXT NOT NULL,
      rol            TEXT NOT NULL CHECK(rol IN ('director','docente','alumno')),
      activo         INTEGER NOT NULL DEFAULT 1,
      fecha_registro TEXT NOT NULL DEFAULT (date('now'))
    );

    -- Docentes (extensión de usuarios con rol=docente)
    CREATE TABLE IF NOT EXISTS docentes (
      id           TEXT PRIMARY KEY,
      usuario_id   TEXT NOT NULL REFERENCES usuarios(id),
      especialidad TEXT,
      titulo       TEXT,
      telefono     TEXT
    );

    -- Períodos académicos
    CREATE TABLE IF NOT EXISTS periodos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre       TEXT NOT NULL,
      anio         INTEGER NOT NULL,
      semestre     INTEGER,
      fecha_inicio TEXT,
      fecha_fin    TEXT,
      activo       INTEGER NOT NULL DEFAULT 0
    );

    -- Carreras
    CREATE TABLE IF NOT EXISTS carreras (
      id        TEXT PRIMARY KEY,
      nombre    TEXT NOT NULL,
      codigo    TEXT NOT NULL,
      turno     TEXT,
      semestres INTEGER NOT NULL DEFAULT 4,
      activa    INTEGER NOT NULL DEFAULT 1
    );

    -- Cursos (año/división dentro de una carrera)
    CREATE TABLE IF NOT EXISTS cursos (
      id         TEXT PRIMARY KEY,
      carrera_id TEXT NOT NULL REFERENCES carreras(id),
      anio       INTEGER NOT NULL,
      division   TEXT NOT NULL DEFAULT 'U',
      turno      TEXT,
      activo     INTEGER NOT NULL DEFAULT 1,
      UNIQUE(carrera_id, anio, division)
    );

    -- Materias
    CREATE TABLE IF NOT EXISTS materias (
      id              TEXT PRIMARY KEY,
      carrera_id      TEXT NOT NULL REFERENCES carreras(id),
      nombre          TEXT NOT NULL,
      codigo          TEXT,
      horas_semanales INTEGER DEFAULT 4,
      anio            INTEGER DEFAULT 1,
      peso_tp         INTEGER NOT NULL DEFAULT 25,
      peso_parcial    INTEGER NOT NULL DEFAULT 25,
      peso_final      INTEGER NOT NULL DEFAULT 50
    );

    -- Alumnos
    CREATE TABLE IF NOT EXISTS alumnos (
      id            TEXT PRIMARY KEY,
      usuario_id    TEXT REFERENCES usuarios(id),
      matricula     TEXT UNIQUE,
      carrera_id    TEXT NOT NULL REFERENCES carreras(id),
      curso_id      TEXT REFERENCES cursos(id),
      fecha_ingreso TEXT,
      estado        TEXT NOT NULL DEFAULT 'Activo' CHECK(estado IN ('Activo','Inactivo','Egresado','Retirado')),
      telefono      TEXT,
      direccion     TEXT,
      ci            TEXT,
      nombre        TEXT,
      apellido      TEXT
    );

    -- Asignaciones (docente → materia → curso → período)
    CREATE TABLE IF NOT EXISTS asignaciones (
      id         TEXT PRIMARY KEY,
      docente_id TEXT NOT NULL REFERENCES docentes(id),
      materia_id TEXT NOT NULL REFERENCES materias(id),
      curso_id   TEXT NOT NULL REFERENCES cursos(id),
      periodo_id INTEGER NOT NULL REFERENCES periodos(id),
      UNIQUE(docente_id, materia_id, curso_id, periodo_id)
    );

    -- Notas
    CREATE TABLE IF NOT EXISTS notas (
      id                    TEXT PRIMARY KEY,
      alumno_id             TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id         TEXT NOT NULL REFERENCES asignaciones(id),
      tp                    REAL,
      parcial               REAL,
      parcial_recuperatorio REAL,
      final                 REAL,
      final_extraordinario  REAL,
      parcial_efectivo      REAL,
      final_efectivo        REAL,
      puntaje_total         REAL,
      nota_final            INTEGER,
      estado                TEXT DEFAULT 'Pendiente' CHECK(estado IN ('Pendiente','Aprobado','Reprobado')),
      UNIQUE(alumno_id, asignacion_id)
    );

    -- Asistencia
    CREATE TABLE IF NOT EXISTS asistencia (
      id            TEXT PRIMARY KEY,
      alumno_id     TEXT NOT NULL REFERENCES alumnos(id),
      asignacion_id TEXT NOT NULL REFERENCES asignaciones(id),
      fecha         TEXT NOT NULL,
      estado        TEXT NOT NULL DEFAULT 'P' CHECK(estado IN ('P','A','T','J')),
      observacion   TEXT,
      UNIQUE(alumno_id, asignacion_id, fecha)
    );

    -- Pagos
    CREATE TABLE IF NOT EXISTS pagos (
      id          TEXT PRIMARY KEY,
      alumno_id   TEXT NOT NULL REFERENCES alumnos(id),
      periodo_id  INTEGER REFERENCES periodos(id),
      concepto    TEXT NOT NULL,
      monto       REAL NOT NULL,
      fecha_pago  TEXT NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'Pagado',
      comprobante TEXT
    );
  `);

  // ── DATOS INICIALES ──────────────────────────────────────────────────────────

  // Institución por defecto
  const inst = db.prepare('SELECT id FROM institucion WHERE id=1').get();
  if (!inst) {
    db.prepare("INSERT INTO institucion (id,nombre) VALUES (1,'Instituto Técnico Superior')").run();
  }

  // Escala de notas por defecto (1–5)
  const escalaCount = db.prepare('SELECT COUNT(*) as n FROM escala_notas').get().n;
  if (escalaCount === 0) {
    const insEscala = db.prepare('INSERT INTO escala_notas (id,nota,puntaje_min,puntaje_max,descripcion) VALUES (?,?,?,?,?)');
    db.transaction(() => {
      insEscala.run('en_1', 1,  0,   59.99, 'Reprobado');
      insEscala.run('en_2', 2, 60,   69.99, 'Suficiente');
      insEscala.run('en_3', 3, 70,   79.99, 'Bueno');
      insEscala.run('en_4', 4, 80,   89.99, 'Muy bueno');
      insEscala.run('en_5', 5, 90,  100,    'Sobresaliente');
    })();
  }

  // Director por defecto
  const dir = db.prepare("SELECT id FROM usuarios WHERE email='director@its.edu.py'").get();
  if (!dir) {
    db.prepare('INSERT INTO usuarios (id,nombre,apellido,email,password_hash,rol) VALUES (?,?,?,?,?,?)')
      .run('u_director', 'Director', 'Sistema', 'director@its.edu.py', bcrypt.hashSync('director123', 10), 'director');
  }

  console.log('✓ Base de datos inicializada:', DB_PATH);
}

module.exports = { db, init, calcularPuntaje };
