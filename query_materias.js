const Database = require('better-sqlite3');
const db = new Database('./backend/its.db');

const materias = db.prepare(`
  SELECT m.nombre as materia, c.nombre as carrera
  FROM materias m
  JOIN carreras c ON m.carrera_id = c.id
  ORDER BY m.nombre, c.nombre
`).all();

const porMateria = {};
for (const r of materias) {
  if (!porMateria[r.materia]) porMateria[r.materia] = [];
  porMateria[r.materia].push(r.carrera);
}

const enVariasCarreras = Object.entries(porMateria)
  .filter(([_, cs]) => cs.length > 1)
  .map(([m, cs]) => ({ materia: m, carreras: cs }));

console.log('=== TODAS LAS MATERIAS ===');
for (const [mat, carreras] of Object.entries(porMateria)) {
  console.log(`${mat}: ${carreras.join(' | ')}`);
}

console.log('\n=== EN MAS DE UNA CARRERA ===');
for (const x of enVariasCarreras) {
  console.log(`${x.materia}: ${x.carreras.join(' | ')}`);
}

console.log('\nTotal materias:', Object.keys(porMateria).length);
console.log('En más de una carrera:', enVariasCarreras.length);
