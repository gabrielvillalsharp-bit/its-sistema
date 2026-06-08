# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run (from repo root)
npm start                   # node backend/server.js
node backend/server.js      # direct

# Run with auto-reload (from backend/)
cd backend && npm run dev   # nodemon server.js

# Link WhatsApp locally (generates QR in browser)
node par.js
```

There is no test suite and no linter configured.

## Architecture

This is an academic management system ("ITS — Instituto Técnico Superior") for a Paraguayan school, deployed on Railway.

### Stack
- **Backend**: Node.js + Express (single-file monolith)
- **Database**: SQLite via `better-sqlite3` (WAL mode, FK on)
- **Frontend**: Static HTML/CSS/JS, no framework, no build step — served by Express from `frontend/public/`
- **Auth**: JWT, 3 roles: `director`, `docente`, `alumno`
- **Notifications**: WhatsApp via Evolution API (external service)
- **Deployment**: Railway with a persistent volume for the database

### File map
| File | Purpose |
|---|---|
| `backend/server.js` | ~6800-line Express monolith — all API routes, middleware, cron jobs, migrations |
| `backend/db.js` | SQLite schema (`crearTablas`), scoring logic (`calcularPuntaje`), exports `{ db, init, calcularPuntaje, DB_PATH }` |
| `backend/whatsapp.js` | Baileys (legacy, not used in production — Evolution API replaced it) |
| `backend/cloud-backup.js` | Pushes the DB to a private GitHub repo on startup |
| `par.js` | Standalone script to scan a WhatsApp QR locally and save the Baileys session |
| `frontend/public/index.html` | ~976 KB single-page app |
| `frontend/public/registro.html` | Public self-registration form |
| `frontend/public/inscripcion.html` | Public course enrollment form |

### Database path resolution (in `db.js`)
1. `DB_PATH` env var (explicit override)
2. `$RAILWAY_VOLUME_MOUNT_PATH/its.db` (Railway persistent volume)
3. `data/its.db` (local fallback)

On startup the DB is auto-restored from `backups/its_backup_1.db` if it is found empty or missing.

### Key schema relationships
```
carreras → cursos (carrera_id, anio, division)
         → materias (carrera_id, anio)
usuarios → docentes (usuario_id)
         → alumnos (usuario_id)
alumnos  → notas, asistencia, pagos, becas, habilitaciones_examen
asignaciones → docente_id + materia_id + curso_id + periodo_id
             → notas, asistencia, examenes, horarios
```

### Scoring logic (`calcularPuntaje` in `db.js`)
- 4 TPs × 5 pts = 20 + Parcial 20 + Director pts 10 + Final 50 = **100 total**
- `parcial_recuperatorio` **replaces** (does not add to) the ordinary parcial
- Final effective order: `complementario` > `final_recuperatorio` > `final_ord`
- `extraordinario` resets all other scores (scale 0–100)
- Status stays `Pendiente` until a final score is entered

### Auth middleware
`auth(roles?)` in `server.js` validates JWT from `Authorization: Bearer <token>` header or `?token=` query param. Role constants: `ADM = ['director']`.

### In-memory cache
Static endpoints (carreras, cursos, periodos, institucion) use a simple 60-second TTL cache (`cacheGet/cacheSet/cacheInvalidate`). Call `cacheInvalidate(key)` after any write to these tables.

### Inline migrations
Schema changes are applied at startup via `try { db.prepare("ALTER TABLE …").run() } catch {}` blocks in `server.js`, right after `init()`. Add new migrations there.

### WhatsApp (Evolution API)
Required env vars: `EVOLUTION_URL`, `EVOLUTION_KEY`, `EVOLUTION_INSTANCE`. Most WA-sending code follows:
```js
const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, { method:'POST', headers:{apikey:EVO_KEY}, body:JSON.stringify({number, text}) });
```
Cron jobs send exam reminders (daily 8:00, every hour on weekdays), a watchdog reconnects WA every 15 min, and scheduled messages fire every minute. All cron jobs skip outside 07:00–22:00 PY (`enHoraPermitida()`).

### Environment variables
| Var | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `JWT_SECRET` | JWT signing secret |
| `DB_PATH` | Explicit DB path override |
| `RAILWAY_VOLUME_MOUNT_PATH` | Set by Railway; triggers volume-based DB path |
| `GITHUB_BACKUP_TOKEN` | PAT with `repo` scope for cloud DB backup |
| `GITHUB_BACKUP_REPO` | `user/repo` target for cloud backup |
| `EVOLUTION_URL` | Evolution API base URL |
| `EVOLUTION_KEY` | Evolution API key |
| `EVOLUTION_INSTANCE` | Evolution API instance name |
| `ALLOWED_ORIGIN` | Comma-separated CORS origins (permissive if unset) |

### Emergency endpoints (no auth)
- `GET /api/setup` — creates or resets the `director@its.edu.py` account (password: `director123`)
- `GET /api/logo` — public logo for the login screen

### Student login
Alumnos can log in with their CI as username and either their full CI or the last 3 digits as password. The hash is auto-upgraded to full CI on first successful login with 3-digit shortcut.

---

## Database Schema (production snapshot 2026-06-08)

All tables with column definitions and approximate row counts:

| Table | Rows | Key columns |
|---|---|---|
| `usuarios` | 605 | id, nombre, apellido, ci, email, password_hash, rol, activo |
| `alumnos` | 583 | id, usuario_id, matricula, carrera_id, curso_id, estado, ci, nombre, apellido, telefono |
| `docentes` | 26 | id, usuario_id, especialidad, titulo, telefono, celular |
| `carreras` | 9 | id, nombre, codigo, turno, semestres, activa |
| `cursos` | 19 | id, carrera_id, anio, division, turno, activo |
| `materias` | 84 | id, carrera_id, nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final |
| `asignaciones` | 89 | id, docente_id, materia_id, curso_id, periodo_id, dia, hora_inicio, hora_fin, aula |
| `periodos` | 2 | id, nombre, anio, semestre, fecha_inicio, fecha_fin, activo |
| `notas` | 2908 | id, alumno_id, asignacion_id, tp1-tp5, parcial, parcial_recuperatorio, final_ord, final_recuperatorio, complementario, extraordinario, puntaje_total, nota_final, estado, director_pts |
| `examenes` | 169 | id, asignacion_id, tipo, fecha, hora, aula, periodo_id, puntos_max, archivo_data |
| `asistencia` | 2253 | id, alumno_id, asignacion_id, fecha, estado (P/A/T/J), observacion |
| `pagos` | 933 | id, alumno_id, periodo_id, concepto, monto, fecha_pago, estado, descuento, medio_pago |
| `aranceles` | 14 | id, concepto, monto, tipo, carrera_id, anio, activo |
| `becas` | 0 | id, alumno_id, tipo, porcentaje, monto_fijo, fecha_inicio, fecha_fin, activa |
| `horarios` | 82 | id, asignacion_id, dia, turno, hora_inicio, hora_fin, aula |
| `avisos` | 165 | id, titulo, contenido, tipo, fijado, destinatario, usuario_id |
| `honorarios` | 78 | id, docente_id, asignacion_id, fecha, monto, estado, tipo |
| `actas_examen` | 4 | id, asignacion_id, tipo_examen, docente_id, estado, periodo_id |
| `habilitaciones_examen` | 2 | id, alumno_id, tipo_examen, asignacion_id, habilitado, habilitado_recuperatorio |
| `qr_cambios` | 226 | id, alumno_id, campo, valor_anterior, valor_nuevo, fecha |
| `solicitudes_registro` | 13 | id, nombre, apellido, ci, telefono, carrera_id, estado, curso_id, alumno_id, tipo |
| `solicitudes_alumno` | 21 | id, nombre, apellido, ci, asignacion_id, docente_id, estado |
| `wa_mensajes` | 160 | id, tipo, destinatario_telefono, mensaje, estado, fecha |
| `wa_programados` | 0 | id, destinatario_tipo, mensaje, fecha_envio, estado |
| `wa_recibidos` | 0 | id, numero, nombre_contacto, mensaje, leido |
| `wa_recordatorios_examen` | 106 | id, examen_id, docente_id, tipo, estado, fecha |
| `notif_wa_enviadas` | 42 | examen_id PK, intervalo PK, fecha_envio |
| `auditoria` | 19680 | id, usuario_id, accion, tabla, registro_id, detalle, fecha |
| `configuracion` | 5 | clave PK, valor, descripcion |
| `institucion` | 1 | id, nombre, direccion, telefono, email, mision, logo_base64 |
| `escala_notas` | 5 | id, nota, puntaje_min, puntaje_max, descripcion |
| `constancias` | 3 | id, alumno_id, tipo, pago_id, fecha |
| `repositorio` | 0 | id, tipo, materia_id, carrera_id, nombre_archivo, datos BLOB |
| `reemplazos` | 0 | id, asignacion_id, docente_titular_id, docente_reemplazante_id, fecha, estado |
| `alumnos_faltantes` | 2 | id, nombre, apellido, carrera_id, ci |
| `solicitudes_egreso` | 0 | id, alumno_id, estado, materias_aprobadas, materias_total |
| `actividades` | 0 | id, titulo, descripcion, fecha, tipo, carrera_id |
| `feriados` | 0 | id, fecha, nombre, tipo, activo |

### Important notes on schema
- `notas.estado`: `'Pendiente'` until a final score exists; then `'Aprobado'`/`'Reprobado'`/`'Ausente'`
- `asistencia.estado`: `P` = Presente, `A` = Ausente, `T` = Tardanza, `J` = Justificado
- `alumnos.estado`: `Activo`, `Inactivo`, `Retirado`, `Egresado`
- `pagos.estado`: `Pagado`, `Pendiente`, `Anulado`
- All `id` fields are TEXT (prefixed strings like `a_`, `u_`, `d_`, `n_`, etc.) except `periodos.id`, `horarios.id`, `institucion.id` which are INTEGER
- Foreign keys are ON — disable with `PRAGMA foreign_keys=OFF` inside transactions when doing bulk deletes
