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
