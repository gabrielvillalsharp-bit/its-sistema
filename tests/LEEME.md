# Pruebas automáticas

- `npm test` → vitest + supertest (fechas, API, inactivos/aviso automático, exportaciones Excel y PDF).
- `npm run test:notas` → regresión de la pérdida de notas (node:test).

Las pruebas arrancan el servidor con `ITS_TEST=1` (sin puerto ni tareas programadas), con una base temporal y sin
WhatsApp/IA/respaldos. Una base NUEVA no trae todas las columnas de la de producción (ej. `alumnos.habilitado_pago_pendiente`),
por eso `tests/api.test.js` agrega la que necesita. Conviene agregar más pruebas aquí cada vez que se corrige un error.
