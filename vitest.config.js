// Pruebas automáticas con vitest + supertest. Correr con: npm test
// (el test viejo de node:test, backend/mergeCamposNota.test.js, se corre con: npm run test:notas)
module.exports = {
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
};
