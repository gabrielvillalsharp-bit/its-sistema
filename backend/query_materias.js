const Database = require('better-sqlite3');
const db = new Database('../data/its.db');

const materias = db.prepare(`
  SELECT DISTINCT m.nombre as materia, c.nombre as carrera
  FROM materias m
  JOIN carreras c ON m.carrera_id = c.id
  ORDER BY m.nombre, c.nombre
`).all();

const porMateria = {};
for (const r of materias) {
  if (!porMateria[r.materia]) porMateria[r.materia] = new Set();
  porMateria[r.materia].add(r.carrera);
}

// Convert Sets to sorted arrays
const resultado = Object.fromEntries(
  Object.entries(porMateria).map(([m, cs]) => [m, [...cs].sort()])
);

const enVariasCarreras = Object.entries(resultado)
  .filter(([_, cs]) => cs.length > 1)
  .sort(([a], [b]) => a.localeCompare(b));

console.log('=== TODAS LAS MATERIAS ===');
for (const [mat, carreras] of Object.entries(resultado)) {
  console.log(`${mat}: ${carreras.join(' | ')}`);
}

console.log('\n=== EN MAS DE UNA CARRERA ===');
for (const [mat, carreras] of enVariasCarreras) {
  console.log(`${mat}: ${carreras.join(' | ')}`);
}

console.log('\nTotal materias únicas:', Object.keys(resultado).length);
console.log('En más de una carrera:', enVariasCarreras.length);
