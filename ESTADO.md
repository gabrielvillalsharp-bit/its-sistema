# ESTADO DEL PROYECTO — ITS Sistema

> Actualizado: 2026-06-18  
> Leer este archivo al inicio de cada nueva conversación para retomar sin perder contexto.

---

## Resumen ejecutivo

Sistema de gestión académica del Instituto Técnico Superior (Paraguay). Monolito Node.js + Express, SQLite, frontend HTML/JS sin framework, notificaciones por WhatsApp (Evolution API). Desplegado en Railway.

**Archivos críticos:**
- `backend/server.js` — ~8400 líneas, toda la lógica de backend
- `backend/db.js` — schema SQLite + `calcularPuntaje()`
- `frontend/public/index.html` — ~1.2 MB, SPA completa

---

## Sistema de pagos y cuotas (implementado completamente)

### Montos base fijos por cuota

| Año | Carrera | Cuotas | Monto |
|-----|---------|--------|-------|
| 1° | Todas | 1–10 | Gs. 300.000 |
| 2° | Todas (excl. Cosmiatría) | 1–10 | Gs. 400.000 |
| 2° | Cosmiatría | 1–5 (Marzo–Julio) | Gs. 300.000 |
| 2° | Cosmiatría | 6–10 (Agosto–Dic) | Gs. 400.000 |
| 3° | Todas | 1–10 | Gs. 400.000 |
| — | Mora (todos) | Día ≥ 11 del mes de la cuota | Gs. 50.000 |

**Regla de mora:** Cuota N vence el mes N+2 (Cuota 1 = Marzo, Cuota 2 = Abril, …). La mora se aplica solo si el mes actual > mes de la cuota, o si es el mismo mes y el día ≥ 11.

### Mapeo Cuota N → Mes

```
Cuota 1 = Marzo    Cuota 6 = Agosto
Cuota 2 = Abril    Cuota 7 = Setiembre
Cuota 3 = Mayo     Cuota 8 = Octubre
Cuota 4 = Junio    Cuota 9 = Noviembre
Cuota 5 = Julio    Cuota 10 = Diciembre
```

### Funciones clave — Backend (`server.js`)

```js
// Línea ~6856
function cuotaBaseAlumno(al, cuotaNum)
// al requiere: al.curso_anio, al.carrera_nombre

// Línea ~6867
function calcCuotasEstado(al)
// Devuelve array de 10 objetos: {n, concepto, mes, base, mora, esperado, totalPagado, diferencia, pagada, fecha}
```

### Funciones clave — Frontend (`index.html`)

```js
// Línea ~1529
const _MESES_CUOTA_GLOBAL = ['','Marzo','Abril',...,'Diciembre'];
function cuotaAMes(c)        // "Cuota 3" → "Mayo"
function cuotaBaseParaAlumno(al, cuotaNum)  // espejo del backend
```

---

## Tablas nuevas (agregadas en esta etapa)

### `deuda_exoneraciones`
```sql
id TEXT PRIMARY KEY, alumno_id TEXT, monto INTEGER, motivo TEXT,
director_id TEXT, fecha TEXT DEFAULT (datetime('now','localtime'))
```

### `compromisos_pago`
```sql
id TEXT PRIMARY KEY,        -- 'cp_' + Date.now()
alumno_id TEXT,
director_id TEXT,
fecha_limite TEXT,          -- 'YYYY-MM-DD'
monto_total INTEGER DEFAULT 0,
concepto TEXT,
estado TEXT DEFAULT 'pendiente',   -- 'pendiente' | 'vencido' | 'cancelado'
fecha_creacion TEXT,
fecha_pago TEXT,
pago_id TEXT
```

### Columnas nuevas en `pagos`
```sql
mora_exonerada INTEGER DEFAULT 0
mora_monto INTEGER DEFAULT 0
```

---

## Endpoints de pagos/deuda

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/api/alumnos/:id/deuda` | director \| alumno propio | Deuda bruta/neta + exoneraciones |
| POST | `/api/alumnos/:id/exonerar-deuda` | director | Registrar exoneración |
| DELETE | `/api/alumnos/:id/exonerar-deuda/:exonId` | director | Eliminar exoneración |
| GET | `/api/alumnos/:id/cuotas-estado` | director \| alumno propio | Estado 10 cuotas + compromiso activo |
| GET | `/api/alumnos/:id/compromiso-pago` | director \| alumno propio | Lista compromisos |
| POST | `/api/alumnos/:id/compromiso-pago` | director | Crear compromiso (cancela pendiente previo) |
| DELETE | `/api/alumnos/:id/compromiso-pago/:compId` | director | Eliminar compromiso |

**Respuesta de `/api/alumnos/:id/deuda`:**
```json
{
  "deudaBruta": 50000,
  "totalExonerado": 0,
  "deudaNeta": 50000,
  "detalle": [{ "concepto":"Cuota 3","base":300000,"esperado":350000,"pagado":300000,"diferencia":50000,"fecha":"..." }],
  "exoneraciones": []
}
```

**Respuesta de `/api/alumnos/:id/cuotas-estado`:**
```json
{
  "cuotas": [{ "n":1,"concepto":"Cuota 1","mes":3,"base":300000,"mora":0,"esperado":300000,"totalPagado":300000,"diferencia":0,"pagada":true,"fecha":"..." }],
  "todasPagadas": false,
  "compromiso": { "id":"cp_...", "estado":"pendiente", "fecha_limite":"2026-07-01", "monto_total":600000 }
}
```

---

## Compromisos de pago — reglas de negocio

1. **Director** crea un compromiso con fecha límite para un alumno con cuotas pendientes.
2. Al crear, el sistema cancela el compromiso pendiente anterior automáticamente.
3. El cron diario (7 AM) vence compromisos cuya `fecha_limite < hoy`.
4. Si hay compromiso `vencido`: **los docentes no pueden cargar notas finales** (final_ord, final_recuperatorio, complementario, extraordinario). El director sí puede.
5. Recordatorios WA: 3 días antes y 1 día antes de la fecha límite.

---

## UI — Panel de director (historial de pagos de alumno)

Función: `selAlumnoPago(alId)` — línea **~11996**

Botones en el header del alumno:
- ↕ Mover sección
- 🔓 Habilitar examen
- ✏ Modificar nombre
- 💸 Exonerar deuda (solo si deudaNeta > 0)
- 📋 Compromiso de pago (siempre visible para director)
- 🗑 Eliminar alumno

Cards que aparecen en el cuerpo:
1. **Estado financiero** (habilitación, beca)
2. **Card de deuda** (naranja, solo si deudaBruta > 0) — con tabla por cuota y botón exonerar
3. **Card de compromiso** (verde/rojo según estado) — con botón editar y ✕ eliminar
4. Estado de cuotas + exámenes con arancel
5. Recuperatorios habilitados
6. Habilitaciones de examen
7. Historial de pagos

Funciones relacionadas:
- `mExonerarDeuda(alId, deudaNeta)` — línea **~12452**
- `confirmarExoneracion(alId, deudaNeta)` — línea **~12497**
- `eliminarExoneracion(exonId, alId)` — línea **~12489**
- `mCompromisoPago(alId)` — línea **~12512**
- `guardarCompromiso(alId)` — línea **~12543**
- `eliminarCompromiso(compId, alId)` — línea **~12556**

---

## UI — Vista alumno (Mi estado de cuenta)

Función: `pgMiEstadoCuenta(el)` — línea **~14145**

Llama a:
- `GET /api/pagos/alumno/:id`
- `GET /api/alumnos/:id/deuda`
- `GET /api/alumnos/:id/cuotas-estado`

Muestra:
- Banner de compromiso activo/vencido (si existe)
- Cards: Total abonado | Cuota mensual (monto correcto por año) | Saldo pendiente
- Grilla de 11 celdas (Matrícula + Cuotas 1-10), color por estado
- Card de deuda acumulada (si existe)
- Historial agrupado por tipo

---

## Lógica de mora (backend y frontend)

**Backend — `POST /api/pagos` (~línea 2790):**
```js
const esCuotaMensual = /^cuota\s+\d+/i.test(concepto || '');
const cuotaNum = esCuotaMensual ? parseInt(...) : 0;
const cuotaMes = cuotaNum + 2;  // Cuota 1 → mes 3 (Marzo)
const hoy = new Date();
const vencioMora = esCuotaMensual &&
  (cuotaMes < mesActual || (cuotaMes === mesActual && diaActual >= 11));
const moraMonto = vencioMora ? 50000 : 0;
```

**Frontend — `pgActualizarMora()` (~línea 12944):**
Misma lógica. Muestra/oculta el campo de mora al registrar un pago.

---

## Cron jobs relacionados con pagos

| Expresión | Propósito |
|-----------|-----------|
| `0 7 * * *` | Vence compromisos expirados + WA recordatorio 3d y 1d antes |

---

## Convenciones de IDs

| Prefijo | Tabla |
|---------|-------|
| `a_` | alumnos |
| `u_` | usuarios |
| `d_` | docentes |
| `n_` | notas |
| `p_` | pagos |
| `de_` | deuda_exoneraciones |
| `cp_` | compromisos_pago |
| `wam_` | wa_mensajes |

---

## Variables de entorno requeridas

```
PORT              JWT_SECRET          DB_PATH
RAILWAY_VOLUME_MOUNT_PATH
EVOLUTION_URL     EVOLUTION_KEY       EVOLUTION_INSTANCE
GITHUB_BACKUP_TOKEN   GITHUB_BACKUP_REPO
ALLOWED_ORIGIN
```

**NUNCA hardcodear claves en el código.** Siempre en Railway environment variables.

---

## Migraciones — cómo agregar una

En `server.js`, justo después del bloque `init()`, agregar:

```js
try { db.prepare("ALTER TABLE tabla ADD COLUMN col TEXT").run(); } catch {}
// o para tablas nuevas:
try { db.exec(`CREATE TABLE IF NOT EXISTS nueva_tabla (...)`); } catch {}
```

---

## Cambios aplicados 2026-06-18

### Bug Cosmiatría — deuda falsa de 100k
`GET /api/pagos/alumno/:id` (server.js ~línea 2777) no incluía JOIN con `carreras`.
`al.carrera_nombre` llegaba `undefined` al frontend → `cuotaBaseParaAlumno` no detectaba
Cosmiatría y devolvía 400k en lugar de 300k para cuotas 1–5.
**Fix:** agregado `LEFT JOIN carreras c ON a.carrera_id=c.id` y `c.nombre as carrera_nombre`.

### Nueva lógica de bloqueo de notas finales (server.js ~línea 1633)
**Antes:** bloqueaba al docente solo si había compromiso VENCIDO.
**Ahora:** si el alumno tiene cuotas con diferencia > 0 → bloquea al docente,
SALVO que exista un compromiso en estado `pendiente` (que actúa como pase temporal).
Director siempre puede cargar notas sin restricción.

### Panel de alumno — UI refactorizada
- **3 cards → 1 card financiera unificada**: estado (badge) + fila de deuda colapsable
  (tabla oculta por defecto, toggle con "▾ Ver detalle") + fila de compromiso
  (solo visible si el director creó uno)
- **Pestañas sutiles**: Tab "💰 Pagos" (card financiera + grilla de cuotas/exámenes intacta)
  y Tab "📋 Historial" (recuperatorios + habilitaciones + historial de pagos).
  Función global `swPTab(id, tab)` en index.html.
- **Header limpio**: eliminados botones "Mover sección" y "Modificar nombre".
  Todos los botones del header con el mismo estilo `rgba(255,255,255,.15)`.

### Texto modal compromiso actualizado
Describe correctamente que el compromiso *habilita* al alumno para rendir finales,
y que vencido lo bloquea nuevamente.

---

## Pendientes / ideas futuras (no implementados)

- Pago de exámenes por lote (múltiples materias, modal con checkboxes)
- Reporte de compromisos vencidos para el director
- Marcar compromiso como pagado automáticamente cuando el alumno regulariza todas las cuotas
- El alumno en vista Mi Estado de Cuenta no ve el monto del compromiso en la grilla de cuotas individuales (solo en el banner)
