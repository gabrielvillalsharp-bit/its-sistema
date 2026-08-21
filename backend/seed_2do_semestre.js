/**
 * seed_2do_semestre.js
 * Crea el período 2do Semestre 2026 con todas las materias y asignaciones
 * extraídas del Horario_Organizativo.xlsx
 *
 * Uso en Railway Shell:
 *   node backend/seed_2do_semestre.js
 *
 * IMPORTANTE: NO activa el período automáticamente. El director lo activa
 * desde Configuración → Períodos cuando corresponda.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/its.db');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

console.log('📚 Iniciando seed 2do Semestre 2026...\n');

// ── 1. PERÍODO ───────────────────────────────────────────────────────────────
const periodoExist = db.prepare("SELECT id FROM periodos WHERE anio=2026 AND semestre=2").get();
let periodoId;
if (periodoExist) {
  periodoId = periodoExist.id;
  console.log(`ℹ️  Período ya existe (id=${periodoId}), se reusan las materias y asignaciones.`);
} else {
  const r = db.prepare(
    "INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin,activo) VALUES (?,?,?,?,?,0)"
  ).run('2do Semestre 2026', 2026, 2, '2026-08-01', '2026-12-31');
  periodoId = r.lastInsertRowid;
  console.log(`✅ Período creado: id=${periodoId} — "2do Semestre 2026" (inactivo)`);
}

// ── 2. CURSOS (verificación — ya deberían existir) ────────────────────────────
const cursosNecesarios = [
  'enf_1u','enf_2u','rad_1u','rad_2u','instr_1u','instr_2u',
  'farm_1u','farm_2u','cosA_1a','cosA_1b','cosA_2u',
  'agro_1u','agro_2u','crim_1u','crim_2u',
];
cursosNecesarios.forEach(id => {
  const c = db.prepare('SELECT id FROM cursos WHERE id=?').get(id);
  if (!c) console.warn(`  ⚠️  Curso no encontrado: ${id}`);
});

// ── 3. MATERIAS ───────────────────────────────────────────────────────────────
// [carrera_id, codigo, nombre, anio_estudio]
// anio=1 → estudiantes en 1er año (2° semestre del plan)
// anio=2 → estudiantes en 2do año (4° semestre del plan)
const materias = [
  // ── ENFERMERÍA ──────────────────────────────────────────────────────────
  ['enf',   'ENF-S2-101', 'Psicología General',                            1],
  ['enf',   'ENF-S2-102', 'Anatomía y Fisiología I y II',                  1],
  ['enf',   'ENF-S2-103', 'Tecnología en Enfermería I, II y III',          1],
  ['enf',   'ENF-S2-104', 'Lengua Castellana I y II',                      1],
  ['enf',   'ENF-S2-105', 'Epidemiología',                                 1],
  ['enf',   'ENF-S4-101', 'Bioseguridad',                                  2],
  ['enf',   'ENF-S4-102', 'Lengua Guaraní',                                2],
  ['enf',   'ENF-S4-103', 'Lengua Castellana',                             2],
  ['enf',   'ENF-S4-104', 'Informática Aplicada a la Enfermería',          2],
  ['enf',   'ENF-S4-105', 'Enfermería en Salud Mental y Psiquiatría',      2],

  // ── RADIOLOGÍA ──────────────────────────────────────────────────────────
  ['rad',   'RAD-S2-101', 'Psicología General',                            1],
  ['rad',   'RAD-S2-102', 'Técnicas Radiológicas I, II, III y IV',         1],
  ['rad',   'RAD-S2-103', 'Comunicación Oral y Escrita',                   1],
  ['rad',   'RAD-S2-104', 'Práctica en Laboratorio I, II, III y IV',       1],
  // 4° semestre — materias compartidas divididas en registros separados
  ['rad',   'RAD-S4-101', 'Patología Médica',                              2],
  ['rad',   'RAD-S4-102', 'Fisiología',                                    2],
  ['rad',   'RAD-S4-103', 'Biología',                                      2],
  ['rad',   'RAD-S4-104', 'Bioquímica',                                    2],
  ['rad',   'RAD-S4-105', 'Matemática',                                    2],
  ['rad',   'RAD-S4-106', 'Comunicación Oral y Escrita',                   2],
  ['rad',   'RAD-S4-107', 'Embriología Básica',                            2],

  // ── INSTRUMENTACIÓN QUIRÚRGICA ───────────────────────────────────────────
  ['instr', 'IQ-S2-101',  'Lengua Castellana',                             1],
  ['instr', 'IQ-S2-102',  'Primeros Auxilios',                             1],
  ['instr', 'IQ-S2-103',  'Lengua Extranjera – Inglés',                   1],
  ['instr', 'IQ-S2-104',  'Fundamento de la Instrumentación Quirúrgica',   1],
  ['instr', 'IQ-S2-105',  'Patología Quirúrgica',                          1],
  // 4° semestre — divididas
  ['instr', 'IQ-S4-101',  'Hematología y Nutrición Parenteral',            2],
  ['instr', 'IQ-S4-102',  'Enfermería Quirúrgica',                         2],
  ['instr', 'IQ-S4-103',  'Lengua Extranjera – Inglés',                   2],
  ['instr', 'IQ-S4-104',  'Matemática',                                    2],
  ['instr', 'IQ-S4-105',  'Lengua Castellana',                             2],
  ['instr', 'IQ-S4-106',  'Lengua Guaraní',                                2],
  ['instr', 'IQ-S4-107',  'Técnicas Radiológicas',                         2],

  // ── FARMACIA ─────────────────────────────────────────────────────────────
  ['farm',  'FAR-S2-101', 'Lengua Castellana II',                          1],
  ['farm',  'FAR-S2-102', 'Primeros Auxilios',                             1],
  ['farm',  'FAR-S2-103', 'Lengua Extranjera – Inglés',                   1],
  ['farm',  'FAR-S2-104', 'Farmacotecnia I',                               1],
  ['farm',  'FAR-S2-105', 'Patología General',                             1],
  // 4° semestre — divididas
  ['farm',  'FAR-S4-101', 'Química Orgánica',                              2],
  ['farm',  'FAR-S4-102', 'Marketing Farmacéutico',                        2],
  ['farm',  'FAR-S4-103', 'Técnicas de Atención al Cliente',               2],
  ['farm',  'FAR-S4-104', 'Botánica Farmacéutica',                         2],
  ['farm',  'FAR-S4-105', 'Lengua Guaraní',                                2],
  ['farm',  'FAR-S4-106', 'Informática Aplicada',                          2],
  ['farm',  'FAR-S4-107', 'Contabilidad Básica',                           2],

  // ── COSMIATRÍA ────────────────────────────────────────────────────────────
  ['cosA',  'COS-S2-101', 'Ética y Deontología Profesional',               1],
  ['cosA',  'COS-S2-102', 'Química Cosmética I/II',                        1],
  ['cosA',  'COS-S2-103', 'Biología de la Piel II',                        1],
  ['cosA',  'COS-S2-104', 'Lengua Castellana',                             1],
  ['cosA',  'COS-S2-105', 'Técnica Cosmética II',                          1],
  // 4° semestre — divididas
  ['cosA',  'COS-S4-101', 'Lengua Castellana',                             2],
  ['cosA',  'COS-S4-102', 'Lengua Guaraní',                                2],
  ['cosA',  'COS-S4-103', 'Uso de Aparatología Cosmetológica',             2],
  ['cosA',  'COS-S4-104', 'Emprendimiento Laboral',                        2],
  ['cosA',  'COS-S4-105', 'Semiología de la Piel II',                      2],
  ['cosA',  'COS-S4-106', 'Bioquímica aplicada a la Cosmetología',         2],

  // ── AGROPECUARIA ─────────────────────────────────────────────────────────
  ['agro',  'AGR-S2-101', 'Suelo y Clima',                                 1],
  ['agro',  'AGR-S2-102', 'Horticultura',                                  1],
  ['agro',  'AGR-S2-103', 'Matemática Aplicada',                           1],
  ['agro',  'AGR-S2-104', 'Producción Bovina',                             1],
  ['agro',  'AGR-S2-105', 'Biología Aplicada a la Producción Agropecuaria',1],
  ['agro',  'AGR-S2-106', 'Introducción a la Economía',                    1], // dividida
  ['agro',  'AGR-S2-107', 'Contabilidad Básica',                           1], // dividida
  // 2° año
  ['agro',  'AGR-S4-101', 'Economía de la Empresa Agraria',                2],
  ['agro',  'AGR-S4-102', 'Emprendedurismo',                               2],
  ['agro',  'AGR-S4-103', 'Horticultura',                                  2],
  ['agro',  'AGR-S4-104', 'Matemática Aplicada',                           2],
  ['agro',  'AGR-S4-105', 'Informática Aplicada',                          2],
  ['agro',  'AGR-S4-106', 'Producción de Aves',                            2],
  ['agro',  'AGR-S4-107', 'Lengua Guaraní',                                2],

  // ── CRIMINALÍSTICA ───────────────────────────────────────────────────────
  ['crim',  'CRM-S2-101', 'Documentología',                                1],
  ['crim',  'CRM-S2-102', 'Medicina Legal y Forense',                      1],
  ['crim',  'CRM-S2-103', 'Sociología y Conocimiento Científico',          1],
  ['crim',  'CRM-S2-104', 'Introducción a la Genética Forense',            1],
  ['crim',  'CRM-S2-105', 'Física Aplicada a la Criminalística',           1],
  // 2° año
  ['crim',  'CRM-S4-101', 'Lengua Guaraní',                                2],
  ['crim',  'CRM-S4-102', 'Informática',                                   2],
  ['crim',  'CRM-S4-103', 'Introducción a la Criminalística',              2],
  ['crim',  'CRM-S4-104', 'Matemática',                                    2],
  ['crim',  'CRM-S4-105', 'Metodología de la Investigación Científica',    2],
];

const insM = db.prepare(
  'INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)'
);
let mInserted = 0;
db.transaction(() => {
  materias.forEach(([car, cod, nombre, anio]) => {
    const mid = 'm_' + cod.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const r = insM.run(mid, car, nombre, cod, 4, anio, 25, 25, 50);
    if (r.changes) mInserted++;
  });
})();
console.log(`✅ Materias: ${mInserted} nuevas insertadas (${materias.length - mInserted} ya existían)`);

// ── 4. ASIGNACIONES ───────────────────────────────────────────────────────────
// [docente_id, codigo_materia, curso_id]
// Nota: docentes sin asignar en el Excel → doc_sharp como placeholder temporal
// Los docentes "Nelly", "Karen", "Amelia", "Cristian", "Natalia Giménez" aún
// no tienen cuenta en el sistema — actualizar desde Configuración → Docentes.
const asigs = [
  // ENFERMERÍA 2° SEM
  ['doc_natalia',  'ENF-S2-101', 'enf_1u'], // Natalia Martínez
  ['doc_higuchi',  'ENF-S2-102', 'enf_1u'], // Paulo Higuchi
  ['doc_ayala_a',  'ENF-S2-103', 'enf_1u'], // Ana Ayala
  ['doc_perez',    'ENF-S2-104', 'enf_1u'], // María Elena Perez
  ['doc_aguero',   'ENF-S2-105', 'enf_1u'], // Gabriela Agüero (Epidemiología)
  // ENFERMERÍA 4° SEM
  ['doc_ayala_a',  'ENF-S4-101', 'enf_2u'], // Ana Ayala
  ['doc_perez',    'ENF-S4-102', 'enf_2u'], // María Elena
  ['doc_perez',    'ENF-S4-103', 'enf_2u'], // María Elena
  ['doc_sharp',    'ENF-S4-104', 'enf_2u'], // sin docente → placeholder
  ['doc_natalia',  'ENF-S4-105', 'enf_2u'], // Natalia Martínez

  // RADIOLOGÍA 2° SEM
  ['doc_natalia',  'RAD-S2-101', 'rad_1u'], // Natalia Martínez
  ['doc_palacios', 'RAD-S2-102', 'rad_1u'], // Marcial Palacios
  ['doc_perez',    'RAD-S2-103', 'rad_1u'], // María Elena
  ['doc_palacios', 'RAD-S2-104', 'rad_1u'], // Marcial Palacios
  // RADIOLOGÍA 4° SEM
  ['doc_higuchi',  'RAD-S4-101', 'rad_2u'], // Paulo
  ['doc_higuchi',  'RAD-S4-102', 'rad_2u'], // Paulo
  ['doc_aranda',   'RAD-S4-103', 'rad_2u'], // Angela Aranda
  ['doc_aranda',   'RAD-S4-104', 'rad_2u'], // Angela Aranda
  ['doc_gimenez',  'RAD-S4-105', 'rad_2u'], // Mirta Giménez
  ['doc_sharp',    'RAD-S4-106', 'rad_2u'], // sin docente → placeholder
  ['doc_sharp',    'RAD-S4-107', 'rad_2u'], // sin docente → placeholder

  // IQ 2° SEM
  ['doc_perez',    'IQ-S2-101',  'instr_1u'], // María Elena
  ['doc_ayala_a',  'IQ-S2-102',  'instr_1u'], // Ana Ayala
  ['doc_jimenez',  'IQ-S2-103',  'instr_1u'], // Pamela Jiménez (Inglés)
  ['doc_sharp',    'IQ-S2-104',  'instr_1u'], // Karen — pendiente agregar al sistema
  ['doc_rojas',    'IQ-S2-105',  'instr_1u'], // Favio Rojas
  // IQ 4° SEM
  ['doc_natalia',  'IQ-S4-101',  'instr_2u'], // Natalia Giménez (pendiente) → doc_natalia provisorio
  ['doc_romero',   'IQ-S4-102',  'instr_2u'], // Micheli Romero (Enfermería Quirúrgica)
  ['doc_jimenez',  'IQ-S4-103',  'instr_2u'], // Pamela Jiménez (Inglés)
  ['doc_gimenez',  'IQ-S4-104',  'instr_2u'], // Mirta Giménez
  ['doc_perez',    'IQ-S4-105',  'instr_2u'], // María Elena
  ['doc_perez',    'IQ-S4-106',  'instr_2u'], // María Elena (Guaraní)
  ['doc_palacios', 'IQ-S4-107',  'instr_2u'], // Marcial Palacios

  // FARMACIA 2° SEM
  ['doc_perez',    'FAR-S2-101', 'farm_1u'], // María Elena
  ['doc_ayala_a',  'FAR-S2-102', 'farm_1u'], // Ana Ayala
  ['doc_jimenez',  'FAR-S2-103', 'farm_1u'], // Pamela Jiménez (Inglés)
  ['doc_aguero',   'FAR-S2-104', 'farm_1u'], // Gabriela Agüero
  ['doc_rojas',    'FAR-S2-105', 'farm_1u'], // Favio Rojas
  // FARMACIA 4° SEM
  ['doc_aranda',   'FAR-S4-101', 'farm_2u'], // Angela Aranda
  ['doc_sharp',    'FAR-S4-102', 'farm_2u'], // sin docente → placeholder
  ['doc_sharp',    'FAR-S4-103', 'farm_2u'], // sin docente → placeholder
  ['doc_aguero',   'FAR-S4-104', 'farm_2u'], // Gabriela Agüero
  ['doc_sharp',    'FAR-S4-105', 'farm_2u'], // sin docente → placeholder
  ['doc_sharp',    'FAR-S4-106', 'farm_2u'], // sin docente → placeholder
  ['doc_gimenez',  'FAR-S4-107', 'farm_2u'], // Mirta Giménez (Contabilidad)

  // COSMIATRÍA 2° SEM — Grupo A y B (mismas materias)
  ['doc_carrillo', 'COS-S2-101', 'cosA_1a'], // Myrian Carrillo
  ['doc_ayala_n',  'COS-S2-102', 'cosA_1a'], // Noelia Ayala
  ['doc_ayala_n',  'COS-S2-103', 'cosA_1a'], // Noelia Ayala
  ['doc_perez',    'COS-S2-104', 'cosA_1a'], // María Elena (Amelia → pendiente)
  ['doc_carballo', 'COS-S2-105', 'cosA_1a'], // Raqueline Carballo
  ['doc_carrillo', 'COS-S2-101', 'cosA_1b'],
  ['doc_ayala_n',  'COS-S2-102', 'cosA_1b'],
  ['doc_ayala_n',  'COS-S2-103', 'cosA_1b'],
  ['doc_perez',    'COS-S2-104', 'cosA_1b'],
  ['doc_carballo', 'COS-S2-105', 'cosA_1b'],
  // COSMIATRÍA 4° SEM
  ['doc_perez',    'COS-S4-101', 'cosA_2u'], // María Elena
  ['doc_perez',    'COS-S4-102', 'cosA_2u'], // María Elena (Guaraní)
  ['doc_carballo', 'COS-S4-103', 'cosA_2u'], // Raqueline
  ['doc_carballo', 'COS-S4-104', 'cosA_2u'], // Raqueline
  ['doc_rojas',    'COS-S4-105', 'cosA_2u'], // Dr. Favio Rojas
  ['doc_aranda',   'COS-S4-106', 'cosA_2u'], // Angela Aranda

  // AGROPECUARIA 1° AÑO
  ['doc_valenz',   'AGR-S2-101', 'agro_1u'], // Nelly (pendiente) → doc_valenz provisorio
  ['doc_gimenez',  'AGR-S2-102', 'agro_1u'], // Mirta Giménez
  ['doc_gimenez',  'AGR-S2-103', 'agro_1u'], // Mirta Giménez
  ['doc_gimenez',  'AGR-S2-104', 'agro_1u'], // Mirta Giménez
  ['doc_valenz',   'AGR-S2-105', 'agro_1u'], // Nelly
  ['doc_sharp',    'AGR-S2-106', 'agro_1u'], // sin docente asignado
  ['doc_gimenez',  'AGR-S2-107', 'agro_1u'], // Mirta Giménez
  // AGROPECUARIA 2° AÑO
  ['doc_gimenez',  'AGR-S4-101', 'agro_2u'],
  ['doc_gimenez',  'AGR-S4-102', 'agro_2u'],
  ['doc_gimenez',  'AGR-S4-103', 'agro_2u'],
  ['doc_gimenez',  'AGR-S4-104', 'agro_2u'],
  ['doc_sharp',    'AGR-S4-105', 'agro_2u'], // sin docente
  ['doc_gimenez',  'AGR-S4-106', 'agro_2u'],
  ['doc_sharp',    'AGR-S4-107', 'agro_2u'], // sin docente

  // CRIMINALÍSTICA 1° AÑO
  ['doc_dominguez','CRM-S2-101', 'crim_1u'], // Nelson
  ['doc_dominguez','CRM-S2-102', 'crim_1u'], // Nelson
  ['doc_sharp',    'CRM-S2-103', 'crim_1u'], // Cristian — pendiente agregar al sistema
  ['doc_aranda',   'CRM-S2-104', 'crim_1u'], // Angela Aranda
  ['doc_dominguez','CRM-S2-105', 'crim_1u'], // Nelson
  // CRIMINALÍSTICA 2° AÑO
  ['doc_gimenez',  'CRM-S4-101', 'crim_2u'], // Mirta
  ['doc_dominguez','CRM-S4-102', 'crim_2u'], // Nelson
  ['doc_sharp',    'CRM-S4-103', 'crim_2u'], // sin docente
  ['doc_gimenez',  'CRM-S4-104', 'crim_2u'], // Mirta
  ['doc_dominguez','CRM-S4-105', 'crim_2u'], // Nelson
];

const insA = db.prepare(
  'INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)'
);
let aInserted = 0, aSkipped = 0;
db.transaction(() => {
  asigs.forEach(([doc_id, mat_cod, cur_id]) => {
    const mat = db.prepare('SELECT id FROM materias WHERE codigo=?').get(mat_cod);
    if (!mat) { console.warn(`  ⚠️  Materia no encontrada: ${mat_cod}`); aSkipped++; return; }
    const doc = db.prepare('SELECT id FROM docentes WHERE id=?').get(doc_id);
    if (!doc) { console.warn(`  ⚠️  Docente no encontrado: ${doc_id}`); aSkipped++; return; }
    const asig_id = `asig2s_${doc_id}_${mat_cod}_${cur_id}`.replace(/[^a-z0-9_]/gi, '_');
    const r = insA.run(asig_id, doc_id, mat.id, cur_id, periodoId);
    if (r.changes) aInserted++; else aSkipped++;
  });
})();
console.log(`✅ Asignaciones: ${aInserted} nuevas / ${aSkipped} ya existían o con advertencia`);

// ── 5. RESUMEN ────────────────────────────────────────────────────────────────
console.log('\n📋 RESUMEN FINAL:');
console.log(`   Período ID  : ${periodoId}`);
console.log(`   Materias    : ${materias.length} definidas`);
console.log(`   Asignaciones: ${asigs.length} definidas`);
console.log('\n⚠️  DOCENTES PENDIENTES DE AGREGAR AL SISTEMA:');
console.log('   • Karen         → IQ 2° Sem: Fundamento de Instrumentación Quirúrgica');
console.log('   • Amelia        → Cosmiatría 2° Sem: Lengua Castellana');
console.log('   • Natalia Giménez → IQ 4° Sem: Hematología y Nutrición Parenteral');
console.log('   • Nelly         → Agropecuaria 1°: Suelo y Clima, Biología Aplicada');
console.log('   • Cristian      → Criminalística 1°: Sociología y Conocimiento Científico');
console.log('\n   Hasta agregar esos docentes, sus materias quedan asignadas a un');
console.log('   docente placeholder (doc_sharp). Actualizar desde Configuración → Docentes.\n');
console.log('✅ Seed completado. Para activar el período: Configuración → Períodos → Activar.');
