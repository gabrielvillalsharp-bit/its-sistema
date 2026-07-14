// Test de regresión para el bug de julio 2026: un campo ausente del payload de
// guardado de notas (ej. "parcial", que el frontend nunca manda para docentes)
// NO debe borrar el valor existente en la base. Costó 66 notas perdidas en
// producción. Correr con: node --test backend/mergeCamposNota.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
// Aislar de la DB real: db.js abre una conexión al requerirse, y no queremos
// tocar ni /data/its.db ni el Volume de Railway solo por correr el test.
process.env.DB_PATH = path.join(os.tmpdir(), 'its_test_mergeCamposNota_' + Date.now() + '.db');
const { mergeCamposNota } = require('./db');

const CAMPOS = ['tp1','tp2','tp3','tp4','tp5','parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario','ausente','director_pts'];

test('campo ausente del payload conserva el valor existente (no lo borra)', () => {
  const antes = { tp1: 5, tp2: 5, tp3: null, tp4: null, tp5: null, parcial: 20, parcial_recuperatorio: null, final_ord: null, final_recuperatorio: null, complementario: null, extraordinario: null, ausente: null, director_pts: null };
  // Payload típico de un docente: guarda tp2, pero "parcial" nunca viaja en el body.
  const body = { tp1: 5, tp2: 5, tp3: '', tp4: '', tp5: '', parcial_recuperatorio: '', final_ord: '', final_recuperatorio: '', complementario: '', extraordinario: '', director_pts: '' };
  const vals = mergeCamposNota(CAMPOS, antes, body);
  const parcialIdx = CAMPOS.indexOf('parcial');
  assert.equal(vals[parcialIdx], 20, 'parcial debe conservarse en 20, no borrarse a null');
});

test('campo presente y explícitamente vacío SÍ se borra (clear intencional)', () => {
  const antes = { tp1: 5, tp2: 5, tp3: null, tp4: null, tp5: null, parcial: 20, parcial_recuperatorio: null, final_ord: null, final_recuperatorio: null, complementario: null, extraordinario: null, ausente: null, director_pts: null };
  // El director SÍ manda "parcial" explícitamente vacío -> intención real de borrar.
  const body = { tp1: 5, tp2: 5, tp3: '', tp4: '', tp5: '', parcial: '', parcial_recuperatorio: '', final_ord: '', final_recuperatorio: '', complementario: '', extraordinario: '', director_pts: '' };
  const vals = mergeCamposNota(CAMPOS, antes, body);
  const parcialIdx = CAMPOS.indexOf('parcial');
  assert.equal(vals[parcialIdx], null, 'parcial debe borrarse cuando el payload lo manda vacío a propósito');
});

test('campo presente con valor nuevo lo actualiza', () => {
  const antes = { tp1: 5, tp2: null, tp3: null, tp4: null, tp5: null, parcial: 20, parcial_recuperatorio: null, final_ord: null, final_recuperatorio: null, complementario: null, extraordinario: null, ausente: null, director_pts: null };
  const body = { tp1: 5, tp2: 5, tp3: '', tp4: '', tp5: '', parcial_recuperatorio: '', final_ord: '', final_recuperatorio: '', complementario: '', extraordinario: '', director_pts: '' };
  const vals = mergeCamposNota(CAMPOS, antes, body);
  const tp2Idx = CAMPOS.indexOf('tp2');
  assert.equal(vals[tp2Idx], 5, 'tp2 debe actualizarse al nuevo valor enviado');
});

test('fila sin estado previo (antes={}) no explota y usa null para lo ausente', () => {
  const antes = {};
  const body = { tp1: 5 };
  const vals = mergeCamposNota(CAMPOS, antes, body);
  const tp1Idx = CAMPOS.indexOf('tp1');
  const parcialIdx = CAMPOS.indexOf('parcial');
  assert.equal(vals[tp1Idx], 5);
  assert.equal(vals[parcialIdx], null);
});
