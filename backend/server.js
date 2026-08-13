process.env.TZ = 'America/Asuncion';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cron = require('node-cron');
const { db, init, calcularPuntaje, DB_PATH } = require('./db');
const { geminiChat, geminiLeerComprobante } = require('./gemini');

// ── CACHE EN MEMORIA para datos estáticos (TTL 60s) ──────────────────────────
const _cache = {};
function cacheGet(key) {
  const e = _cache[key];
  if (e && Date.now() - e.ts < 60000) return e.data;
  return null;
}
function cacheSet(key, data) { _cache[key] = { data, ts: Date.now() }; }
function cacheInvalidate(...keys) { keys.forEach(k => delete _cache[k]); }


const app = express();
app.set('trust proxy', 1); // Railway usa proxy — necesario para rate-limit y IPs reales
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'its_secret_2026_cambiar_en_produccion';
const upload = multer({ storage: multer.memoryStorage() });

// ── SEGURIDAD: CORS restringido ───────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    // En Railway permitir cualquier origen (el dominio cambia con cada deploy)
    // En producción con dominio fijo, configurar ALLOWED_ORIGIN en variables de entorno
    const allowed = process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : [];
    if (!origin || allowed.length === 0 || allowed.includes(origin) || allowed.includes('*')) {
      callback(null, true);
    } else {
      callback(null, true); // permisivo — Railway usa HTTPS propio
    }
  },
  credentials: true
}));

// ── SEGURIDAD: Rate limiting ──────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 50,
  message: { error: 'Demasiados intentos de login. Esperá un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300,
  message: { error: 'Demasiadas solicitudes. Esperá un momento.' },
});

app.use(compression());
app.use(express.json());
// Forzar UTF-8 en todas las respuestas JSON para evitar CÃ©sar en lugar de César
app.use((req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return orig(body);
  };
  next();
});
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));
init();

// ── MIGRACIÓN: tabla interesados_bot ─────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS interesados_bot (
    id           TEXT PRIMARY KEY,
    nombre       TEXT,
    telefono     TEXT,
    carrera_id   TEXT,
    carrera_nombre TEXT,
    fecha        TEXT DEFAULT (datetime('now','localtime')),
    estado       TEXT DEFAULT 'nuevo'
  )`).run();
} catch(e) { console.warn('[Migración] interesados_bot:', e.message); }

// ── MIGRACIÓN: tabla documentos (repositorio institucional tipo Drive) ───────
// Solo el director sube (doc/excel/ppt/pdf); cualquier usuario logueado puede
// ver/descargar. Archivos chicos, pocos usuarios subiendo → BLOB en SQLite,
// igual que el repositorio de programas/contenidos ya existente.
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS documentos (
    id TEXT PRIMARY KEY,
    nombre_archivo TEXT NOT NULL,
    datos BLOB NOT NULL,
    mime_tipo TEXT,
    tamano INTEGER,
    categoria TEXT,
    descripcion TEXT,
    subido_por TEXT REFERENCES usuarios(id),
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS documento_carpetas (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    creado_por TEXT REFERENCES usuarios(id),
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`).run();
  try { db.prepare('ALTER TABLE documentos ADD COLUMN carpeta_id TEXT REFERENCES documento_carpetas(id)').run(); } catch {}
} catch(e) { console.warn('[Migración] documentos:', e.message); }

// ── MIGRACIÓN: documentos institucionales ─────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS doc_institucionales (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL,
    numero TEXT NOT NULL,
    fecha_emision TEXT NOT NULL,
    asunto TEXT NOT NULL,
    institucion TEXT NOT NULL,
    nombre_archivo TEXT,
    datos BLOB,
    mime_tipo TEXT,
    tamano INTEGER,
    subido_por TEXT REFERENCES usuarios(id),
    creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[Migración] doc_institucionales:', e.message); }

// ── MIGRACIÓN: tablas de formularios (tipo Google Forms) ─────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS formularios (
    id TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    descripcion TEXT,
    creado_por TEXT REFERENCES usuarios(id),
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    activo INTEGER NOT NULL DEFAULT 1
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS formulario_preguntas (
    id TEXT PRIMARY KEY,
    formulario_id TEXT NOT NULL REFERENCES formularios(id),
    orden INTEGER NOT NULL DEFAULT 0,
    tipo TEXT NOT NULL CHECK(tipo IN ('texto','opcion_multiple')),
    texto_pregunta TEXT NOT NULL,
    opciones TEXT,
    requerida INTEGER NOT NULL DEFAULT 0
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS formulario_respuestas (
    id TEXT PRIMARY KEY,
    formulario_id TEXT NOT NULL REFERENCES formularios(id),
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS formulario_respuesta_valores (
    id TEXT PRIMARY KEY,
    respuesta_id TEXT NOT NULL REFERENCES formulario_respuestas(id),
    pregunta_id TEXT NOT NULL REFERENCES formulario_preguntas(id),
    valor TEXT
  )`).run();
} catch(e) { console.warn('[Migración] formularios:', e.message); }

// ── LIMPIEZA: purgar mensajes de grupos mal guardados en wa_recibidos ────────
try {
  // Eliminar entradas cuyo número tiene formato de grupo (>15 dígitos) o es conocidamente un grupo
  const purgados = db.prepare(`DELETE FROM wa_recibidos WHERE length(replace(replace(numero,'-',''),' ','')) > 15`).run();
  if (purgados.changes > 0) console.log(`[Limpieza] wa_recibidos: ${purgados.changes} mensajes de grupos eliminados`);
} catch(e) {}

// ── LIMPIEZA: deduplicar wa_recibidos (mismo numero+mensaje en ventana de 5 min) ──
try {
  const dedup = db.prepare(`
    DELETE FROM wa_recibidos WHERE id NOT IN (
      SELECT MIN(id) FROM wa_recibidos
      GROUP BY numero, mensaje, strftime('%Y-%m-%d %H:%M', fecha, 'localtime')
    )
  `).run();
  if (dedup.changes > 0) console.log(`[Limpieza] wa_recibidos: ${dedup.changes} mensajes duplicados eliminados`);
} catch(e) {}

// ── LIMPIEZA: deduplicar wa_mensajes (mismo numero+mensaje en ventana de 1 min) ──
try {
  const dedup2 = db.prepare(`
    DELETE FROM wa_mensajes WHERE id NOT IN (
      SELECT MIN(id) FROM wa_mensajes
      WHERE tipo='individual'
      GROUP BY destinatario_telefono, mensaje, strftime('%Y-%m-%d %H:%M', fecha)
    ) AND tipo='individual'
  `).run();
  if (dedup2.changes > 0) console.log(`[Limpieza] wa_mensajes: ${dedup2.changes} mensajes duplicados eliminados`);
} catch(e) {}

// ── MIGRACIÓN: tabla wa_consultas ─────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS wa_consultas (
    id             TEXT PRIMARY KEY,
    numero         TEXT,
    nombre         TEXT,
    tipo           TEXT DEFAULT 'externo',
    alumno_id      TEXT,
    carrera_nombre TEXT,
    anio           TEXT,
    ci             TEXT,
    consulta       TEXT,
    estado         TEXT DEFAULT 'pendiente',
    fecha          TEXT DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[Migración] wa_consultas:', e.message); }

// ── MIGRACIÓN: tabla papelera ─────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS papelera (
    id                TEXT PRIMARY KEY,
    tipo              TEXT,
    nombre_display    TEXT,
    datos_json        TEXT,
    eliminado_por     TEXT,
    fecha_eliminacion TEXT DEFAULT (datetime('now','localtime')),
    expira_en         TEXT
  )`).run();
} catch(e) { console.warn('[Migración] papelera:', e.message); }

// ── MIGRACIÓN: tabla movimientos_extra ───────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS movimientos_extra (
    id            TEXT PRIMARY KEY,
    tipo          TEXT NOT NULL,
    monto         REAL NOT NULL,
    descripcion   TEXT NOT NULL,
    fecha         TEXT NOT NULL,
    categoria     TEXT DEFAULT 'Otro',
    referencia    TEXT,
    observacion   TEXT,
    registrado_por TEXT,
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[Migración] movimientos_extra:', e.message); }

// ── MIGRACIÓN: columnas de precarga IA en pagos_pendientes_wa ───────────────
['monto_sugerido REAL','fecha_sugerida TEXT','nombre_detectado TEXT','banco_detectado TEXT','referencia_detectada TEXT',"ia_estado TEXT DEFAULT 'pendiente'",'estado_transferencia_ia TEXT',
 'pago_id TEXT','resuelto_por TEXT','fecha_resolucion TEXT','imagen_mime TEXT DEFAULT \'image/jpeg\''].forEach(col => {
  try { db.prepare(`ALTER TABLE pagos_pendientes_wa ADD COLUMN ${col}`).run(); } catch {}
});
try { db.prepare('ALTER TABLE interesados_bot ADD COLUMN ci TEXT').run(); } catch {}

// ── HELPER PAPELERA ───────────────────────────────────────────────────────────
function guardarEnPapelera(tipo, nombreDisplay, datos, eliminadoPor) {
  try {
    const pid    = 'pap_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
    const expira = new Date(Date.now() + 30*24*60*60*1000)
      .toLocaleString('sv-SE', { timeZone: 'America/Asuncion' }).replace('T',' ').slice(0,19);
    db.prepare(`INSERT INTO papelera (id,tipo,nombre_display,datos_json,eliminado_por,expira_en)
      VALUES (?,?,?,?,?,?)`)
      .run(pid, tipo, nombreDisplay, JSON.stringify(datos), eliminadoPor||null, expira);
  } catch(e) { console.error('[PAPELERA] guardar:', e.message); }
}

// ── BOT DE ADMISIONES ─────────────────────────────────────────────────────────
const _botEstados = new Map(); // numero → { historial:[{role,texto}], alumno, interesadoGuardado, consultaGuardada, ts }
setInterval(() => {
  const lim24h = Date.now() - 24*60*60*1000;
  _botEstados.forEach((v,k) => { if (v.ts < lim24h) _botEstados.delete(k); });
}, 30*60*1000);

// Caché @lid → JID real: WhatsApp Privacy Mode asigna @lid a contactos no guardados.
// Se puebla con eventos CONTACTS_UPSERT de Evolution API para poder responderles.
const _lidJidMap = new Map();

// Carreras — recargadas desde la BD en cada llamada al bot (así aparecen carreras nuevas sin reiniciar)
function _botCargarCarreras() {
  try {
    return db.prepare("SELECT id, nombre FROM carreras WHERE activa=1 ORDER BY nombre").all()
      .map((c, i) => ({ num: String(i + 1), id: c.id, nombre: c.nombre }));
  } catch(e) {
    console.warn('[BOT] Error cargando carreras:', e.message);
    return [];
  }
}
let BOT_CARRERAS = _botCargarCarreras();

// Aviso en startup si falta GEMINI_API_KEY
if (!process.env.GEMINI_API_KEY) {
  console.warn('[BOT] ⚠️ GEMINI_API_KEY no configurada — el bot de IA NO responderá mensajes.');
}

const BOT_MENU_PRINCIPAL =
  `Bienvenido/a al *Instituto Técnico Superior Santísima Trinidad*. 🎓\n\n` +
  `Para brindarle la atención correspondiente, por favor indíquenos cuál es su situación:\n\n` +
  `1️⃣ Soy alumno/a de la institución\n` +
  `2️⃣ No soy alumno/a - deseo realizar consultas`;

// Estado de pausa del bot (persiste en configuracion)
let _botPausado = (() => {
  try { return db.prepare("SELECT valor FROM configuracion WHERE clave='bot_pausado'").get()?.valor === '1'; }
  catch { return false; }
})();

function _botSystemPrompt(alumno) {
  const inst = (() => { try { return db.prepare('SELECT * FROM institucion LIMIT 1').get(); } catch { return null; } })();
  const nombreInst = inst?.nombre || 'Instituto Técnico Superior Santísima Trinidad';
  const direccion   = inst?.direccion || '';
  const telInst     = inst?.telefono  || '';

  // Recargar carreras para que el prompt sea siempre fresco
  BOT_CARRERAS = _botCargarCarreras();

  // Carreras con duración y horarios reales (agrupados por carrera)
  const carrerasTxt = BOT_CARRERAS.map(c => {
    const dur = /cosmiatr/i.test(c.nombre) ? '3 años' : '2 años';

    // Horarios de esta carrera desde la tabla asignaciones+horarios
    let horarioTxt = '';
    try {
      const dias = db.prepare(`
        SELECT DISTINCT h.dia, h.hora_inicio, h.hora_fin, h.turno
        FROM horarios h
        JOIN asignaciones a ON h.asignacion_id = a.id
        JOIN cursos cu ON a.curso_id = cu.id
        WHERE cu.carrera_id = ?
        ORDER BY h.dia, h.hora_inicio
        LIMIT 6
      `).all(c.id);
      if (dias.length) {
        // Agrupar por día
        const porDia = {};
        dias.forEach(d => {
          const k = d.dia;
          if (!porDia[k]) porDia[k] = { inicio: d.hora_inicio, fin: d.hora_fin };
          else {
            if (d.hora_inicio < porDia[k].inicio) porDia[k].inicio = d.hora_inicio;
            if (d.hora_fin   > porDia[k].fin)     porDia[k].fin   = d.hora_fin;
          }
        });
        const diasStr = Object.entries(porDia)
          .map(([dia, h]) => `${dia} ${h.inicio?.slice(0,5)}–${h.fin?.slice(0,5)}`)
          .join(', ');
        horarioTxt = ` | Clases: ${diasStr}`;
      }
    } catch {}

    return `- ${c.nombre} (${dur}${horarioTxt})`;
  }).join('\n') || '(sin carreras cargadas)';

  // Precios desde la tabla aranceles
  let preciosTxt = 'Gs. 300.000/mes (1° año) · Gs. 400.000/mes (2° año en adelante)';
  try {
    const cuotas = db.prepare("SELECT anio, monto FROM aranceles WHERE tipo='cuota' AND activo=1 ORDER BY anio").all();
    if (cuotas.length) {
      preciosTxt = cuotas.map(c => `${c.anio}° año: Gs. ${Number(c.monto).toLocaleString('es-PY')}/mes`).join(' · ');
    }
  } catch {}

  // Próxima inscripción / período activo
  let periodoTxt = '';
  try {
    const p = db.prepare("SELECT nombre, fecha_inicio, fecha_fin FROM periodos WHERE activo=1 LIMIT 1").get();
    if (p) periodoTxt = `\nPeríodo actual: ${p.nombre} (${p.fecha_inicio} al ${p.fecha_fin}).`;
  } catch {}

  let contexto = `Estás hablando por WhatsApp con una persona EXTERNA (no es alumno registrado) que puede estar interesada en inscribirse.`;
  if (alumno) {
    contexto = `Estás hablando con *${alumno.nombre} ${alumno.apellido}*, alumno/a ACTIVO/A de la institución (identificado por su número de WhatsApp). No le pidas nombre, CI ni carrera — ya los tenemos. Si tiene una consulta o reclamo, escuchalo con amabilidad y avisale que un encargado se va a comunicar con él/ella pronto.`;
  }

  const contactoTxt = [
    direccion && `Dirección: ${direccion}`,
    telInst   && `Teléfono: ${telInst}`,
  ].filter(Boolean).join(' | ');

  const linkInscripcion = 'https://its-sistema-production.up.railway.app/inscripcion';

  return `Sos el asistente de admisiones de "${nombreInst}", un instituto técnico en Paraguay. Respondés por WhatsApp en español paraguayo, con calidez y naturalidad — como lo haría un asesor humano amable, no un robot. Mensajes cortos (máximo 4-5 líneas), sin listas interminables. Emojis moderados cuando queden bien. Si la persona ya te está hablando, obviamente sos vos el que atendés — no hace falta que lo aclares en cada mensaje.

IDENTIDAD: Cuando alguien pregunte directamente "¿sos un bot?", "¿sos una persona?", "¿con quién hablo?" o similar, respondé con naturalidad y honestidad, algo como: "Soy un asistente virtual con IA 😊 Puedo responder la mayoría de las cosas. Si necesitás hablar con alguien del equipo, te voy a conectar con un asesor." No lo menciones si no te preguntan.

COMPORTAMIENTO:
- Si el mensaje ya trae una pregunta o necesidad, respondé directo con calidez — no hagas el "hola, ¿en qué te puedo ayudar?" de manual.
- Si el saludo es solo "Hola" o "Buenas" sin más, saludá amablemente y preguntá en qué podés ayudar.
- Si manda varios mensajes seguidos, esperá a tener todo el contexto y respondé de una sola vez.
- Si no sabés algo, no lo inventes: "Eso lo confirmaría mejor un asesor, pero por acá te cuento lo que sé..."

${contexto}

CARRERAS QUE OFRECE EL INSTITUTO (turno nocturno):
${carrerasTxt}
Duración: 2 años (excepto Cosmiatría: 3 años).
Clases: 3 veces por semana, de 19:00 a 22:00 hs (días según carrera).
Siempre hay cupo disponible en todas las carreras.

PRECIOS (1° AÑO — la mayoría de los interesados):
Cuota mensual: *Gs. 300.000/mes*. Matrícula de inscripción: *GRATIS* para 1° año.
10 cuotas por año (marzo a diciembre). Pago: efectivo en secretaría o transferencia bancaria.
Solo si preguntan específicamente por 2° año: cuota Gs. 400.000/mes + matrícula (monto exacto lo confirma un asesor).${periodoTxt}

REQUISITOS DE INSCRIPCIÓN:
- Certificado de estudios *autenticado* (título de bachiller)
- Copia de cédula de identidad *autenticada*
Sin límite de edad. Se puede inscribir en cualquier momento del año, incluso a mitad del año lectivo.

ATENCIÓN: lunes a viernes de 18:00 a 22:00 hs.
${contactoTxt}
Este número de WhatsApp es el contacto oficial del instituto.

REGLAS:
1. Alumnos activos que pregunten notas, pagos, asistencia o exámenes: deciles que ingresen a la *plataforma estudiantil* desde su celular con su número de cédula como usuario y contraseña. No des esa info por WhatsApp.
2. Cuando una persona externa muestre interés en inscribirse, pedile sus datos de forma natural (no como formulario rígido), en este orden:
   - Nombre completo
   - Número de cédula de identidad
   - Carrera de interés (si no la mencionó aún)
   Una vez que tengas los tres, confirmá: "¡Perfecto, [Nombre]! Ya registré tu interés en [Carrera]. Un asesor se va a comunicar con vos a la brevedad para coordinar los detalles 😊"
3. Para becas, descuentos o casos especiales: derivá al asesor.
4. Nunca inventes días exactos de clases, montos de matrícula 2° año ni datos no listados aquí.

ETIQUETAS INTERNAS (el usuario nunca las ve, se eliminan automáticamente):
- Cuando tengas nombre completo + carrera (con o sin cédula), agregá al final (línea aparte):
[[INTERESADO:Nombre Completo|Nombre exacto de la carrera|CedulaOVacio]]
- Si un alumno activo describe su consulta, agregá al final (línea aparte):
[[CONSULTA:resumen de la consulta]]
- Cada etiqueta máximo una vez por respuesta. Si no aplica, no agregues nada.`;
}

function _botExtraerEtiquetas(textoIA) {
  let limpio = textoIA;
  let interesado = null, consulta = null;
  const mInt = textoIA.match(/\[\[INTERESADO:([^|]+)\|([^|\]]+)\|?([^\]]*)\]\]/);
  if (mInt) {
    interesado = { nombre: mInt[1].trim(), carrera: mInt[2].trim(), ci: (mInt[3]||'').trim() };
    limpio = limpio.replace(mInt[0], '');
  }
  const mCons = textoIA.match(/\[\[CONSULTA:([^\]]+)\]\]/);
  if (mCons) { consulta = mCons[1].trim(); limpio = limpio.replace(mCons[0], ''); }
  return { limpio: limpio.trim(), interesado, consulta };
}

// Normaliza un número a formato Paraguay (595XXXXXXXX), sin símbolos ni @
function _normTelPY(num) {
  let t = String(num||'').replace(/\D/g,'');
  if (t.startsWith('0')) t = '595' + t.slice(1);
  if (!t.startsWith('595')) t = '595' + t;
  return t;
}

// Envía un mensaje de texto por WhatsApp (Evolution API) y registra el resultado en wa_mensajes.
async function enviarWA(numero, msg, tipo) {
  const EVO_URL  = process.env.EVOLUTION_URL;
  const EVO_KEY  = process.env.EVOLUTION_KEY;
  const EVO_INST = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INST) return;
  let numStr = String(numero||'');
  // Si es @lid, intentar resolver con el caché poblado por CONTACTS_UPSERT.
  // El caché puede haberse actualizado durante el tiempo que tardó Gemini en responder.
  if (numStr.endsWith('@lid') && _lidJidMap.has(numStr)) {
    const resolved = _lidJidMap.get(numStr);
    console.log(`[WA] @lid resuelto a ${resolved} desde caché`);
    numStr = resolved;
  }
  // @s.whatsapp.net y @c.us se pasan tal cual a Evolution. Números sin @ se normalizan a Paraguay.
  // @lid sin resolver: se pasa a Evolution y esperamos que enrute internamente.
  const numNorm = numStr.includes('@') ? numStr : _normTelPY(numStr);
  // Para guardar en wa_mensajes siempre usar formato dígitos (sin @suffix) para que coincida
  // con el campo `numero` de wa_recibidos y el agrupado de conversaciones funcione correctamente.
  const numForDb = numNorm.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
  try {
    const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/message/sendText/${EVO_INST}`, {
      method: 'POST',
      headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numNorm, textMessage: { text: msg } }),
      signal: AbortSignal.timeout(8000)
    });
    const respTxt = await r.text();
    const msgId = 'bm_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
    if (!r.ok) {
      console.error(`[WA] enviar ${r.status} → ${numNorm}: ${respTxt.slice(0,400)}`);
      botLog(numero, 'envio_fallido', `HTTP ${r.status} → ${numNorm}: ${respTxt.slice(0,300)}`);
      try { db.prepare("INSERT INTO wa_mensajes (id,tipo,destinatario_telefono,mensaje,estado,fecha) VALUES (?,?,?,?,?,?)").run(msgId,'individual',numForDb,msg.slice(0,200),'fallido',nowStr()); } catch {}
    } else {
      console.log(`[WA] enviar OK (${r.status}) → ${numNorm}`);
      botLog(numero, 'envio_ok', `→ ${numNorm}: "${msg}"`);
      try { db.prepare("INSERT INTO wa_mensajes (id,tipo,destinatario_telefono,mensaje,estado,fecha) VALUES (?,?,?,?,?,?)").run(msgId,'individual',numForDb,msg.slice(0,200),'enviado',nowStr()); } catch {}
    }
  } catch(e) {
    console.error('[WA] enviar error:', e.message);
    botLog(numero, 'envio_error', e.message);
    try { db.prepare("INSERT INTO wa_mensajes (id,tipo,destinatario_telefono,mensaje,estado,fecha) VALUES (?,?,?,?,?,?)").run('bm_'+Date.now(),'individual',numForDb,msg.slice(0,100),'fallido',nowStr()); } catch {}
  }
}

async function procesarMensajeBot(numero, texto) {
  if (_botPausado) { botLog(numero, 'ignorado', 'bot pausado por director'); return; }
  if (!process.env.EVOLUTION_URL || !process.env.EVOLUTION_KEY || !process.env.EVOLUTION_INSTANCE) { botLog(numero, 'ignorado', 'variables EVOLUTION no configuradas'); return; }

  // numNorm se calcula DESPUÉS del await Gemini para aprovechar CONTACTS_UPSERT que puede
  // llegar durante el tiempo que tarda Gemini (1-5 s) y revelar el JID real de un @lid.
  // Definida como función para evaluarse en el momento de uso.
  const _resolverNumNorm = () => {
    const raw = String(numero||'');
    if (raw.endsWith('@lid')) {
      if (_lidJidMap.has(raw)) {
        return _normTelPY(_lidJidMap.get(raw).replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, ''));
      }
      return raw; // @lid sin resolver: guardar como identificador hasta que llegue CONTACTS_UPSERT
    }
    return _normTelPY(raw);
  };
  const enviar = (msg) => enviarWA(numero, msg, 'bot');

  const txt = (texto||'').trim();
  if (!txt) return;

  botLog(numero, 'recibido', `"${txt}"`);

  // Si el número actual es un JID resuelto (dígitos), buscar si teníamos historial bajo el @lid original.
  // Esto ocurre cuando la primera conversación usó HASH@lid y CONTACTS_UPSERT lo resolvió después.
  let est = _botEstados.get(numero);
  if (!est) {
    for (const [lid, jid] of _lidJidMap) {
      const stripped = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
      if (stripped === numero && _botEstados.has(lid)) {
        est = _botEstados.get(lid);
        _botEstados.delete(lid);
        _botEstados.set(numero, est); // migrar al nuevo key real
        console.log(`[BOT] historial migrado de ${lid} a ${numero}`);
        break;
      }
    }
  }
  const hace24h = Date.now() - 24*60*60*1000;
  if (!est || est.ts < hace24h) {
    // Identificar si es un alumno activo por su teléfono (solo para dar contexto a la IA)
    let alumno = null;
    try {
      const numSin0 = numero.replace(/\D/g,'').replace(/^595/,'');
      const numCon0 = '0'+numSin0;
      alumno = db.prepare(`
        SELECT a.id, a.nombre, a.apellido FROM alumnos a
        WHERE (a.telefono LIKE ? OR a.telefono LIKE ? OR a.telefono LIKE ?) AND a.estado='Activo'
        LIMIT 1
      `).get('%'+numSin0, '%'+numCon0, numSin0);
    } catch(e) { console.error('[BOT] búsqueda alumno por teléfono:', e.message); }
    est = { historial: [], alumno: alumno || null, interesadoGuardado: false, consultaGuardada: false, ts: Date.now() };
  }
  est.ts = Date.now();

  let respuestaIA;
  try {
    botLog(numero, 'gemini_llamando', `historial: ${est.historial.length} turnos`);
    respuestaIA = await geminiChat(_botSystemPrompt(est.alumno), est.historial, txt);
    botLog(numero, 'gemini_ok', `respuesta: "${respuestaIA}"`);
  } catch(e) {
    console.error('[BOT] Gemini error:', e.message);
    botLog(numero, 'gemini_error', e.message);
    // Mensaje diferenciado: si es cuota excedida (429) vs error genérico
    const msg429 = e.status === 429 || (e.message||'').includes('429')
      ? 'Estamos recibiendo muchas consultas en este momento. Un asesor se comunicará con usted a la brevedad. ¡Gracias por contactarnos! 🙏'
      : 'Disculpe, en este momento no podemos procesar su mensaje automáticamente. Un encargado se comunicará con usted a la brevedad. 🙏';
    await enviar(msg429);
    _botEstados.set(numero, est);
    return;
  }

  // En este punto CONTACTS_UPSERT ya pudo haber llegado → resolver @lid al número real
  const numNorm = _resolverNumNorm();

  const { limpio, interesado, consulta } = _botExtraerEtiquetas(respuestaIA);

  // Detectar carrera mencionada en el mensaje del usuario o en la respuesta del bot
  const _textoDeteccion = (txt + ' ' + limpio).toLowerCase();
  const carreraDetectada = BOT_CARRERAS.find(c => _textoDeteccion.includes(c.nombre.toLowerCase()));

  if (interesado && !est.interesadoGuardado) {
    try {
      const carrera = BOT_CARRERAS.find(c =>
        c.nombre.toLowerCase() === interesado.carrera.toLowerCase() ||
        c.nombre.toLowerCase().includes(interesado.carrera.toLowerCase()) ||
        interesado.carrera.toLowerCase().includes(c.nombre.toLowerCase())
      ) || carreraDetectada;
      const iid = 'int_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT OR IGNORE INTO interesados_bot (id,nombre,ci,telefono,carrera_id,carrera_nombre,estado)
        VALUES (?,?,?,?,?,?,'nuevo')`)
        .run(iid, interesado.nombre, interesado.ci||'', numNorm, carrera?.id||'', carrera?.nombre||interesado.carrera);
      est.interesadoGuardado = true;
      est.carreraGuardada = carrera?.id||null;
    } catch(e) { console.error('[BOT] guardar interesado:', e.message); }
  } else if (carreraDetectada && !est.interesadoGuardado) {
    try {
      const iid = 'int_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT OR IGNORE INTO interesados_bot (id,nombre,ci,telefono,carrera_id,carrera_nombre,estado)
        VALUES (?,?,?,?,?,?,'nuevo')`)
        .run(iid, '', '', numNorm, carreraDetectada.id, carreraDetectada.nombre);
      est.interesadoGuardado = true;
      est.carreraGuardada = carreraDetectada.id;
    } catch(e) { console.error('[BOT] guardar interesado por carrera:', e.message); }
  } else if (interesado && est.interesadoGuardado) {
    // Actualizar nombre y/o CI si ahora los tenemos
    try {
      db.prepare(`UPDATE interesados_bot SET nombre=COALESCE(NULLIF(?,''),nombre), ci=COALESCE(NULLIF(?,''),ci) WHERE telefono=?`)
        .run(interesado.nombre, interesado.ci||'', numNorm);
    } catch(e) {}
  }

  if (consulta && !est.consultaGuardada) {
    try {
      const cid = 'wc_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_consultas (id,numero,nombre,tipo,alumno_id,consulta,estado,fecha)
        VALUES (?,?,?,'alumno_registrado',?,?,'pendiente',datetime('now','localtime'))`)
        .run(cid, numNorm, est.alumno ? `${est.alumno.nombre} ${est.alumno.apellido}`.trim() : '', est.alumno?.id||null, consulta);
      est.consultaGuardada = true;
    } catch(e) { console.error('[BOT] guardar consulta alumno:', e.message); }
  }

  est.historial.push({ role: 'user', texto: txt }, { role: 'model', texto: limpio });
  if (est.historial.length > 16) est.historial = est.historial.slice(-16);
  _botEstados.set(numero, est);

  await enviar(limpio || 'Un encargado se comunicará con usted a la brevedad. 🙏');
}

// ── TABLA: log del bot de WhatsApp ───────────────────────────────────────────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS wa_bot_log (
    id TEXT PRIMARY KEY,
    numero TEXT NOT NULL,
    evento TEXT NOT NULL,
    detalle TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
} catch {}

function botLog(numero, evento, detalle) {
  try {
    db.prepare("INSERT INTO wa_bot_log (id,numero,evento,detalle) VALUES (?,?,?,?)")
      .run('bl_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), String(numero||''), evento, detalle ? String(detalle).slice(0,3000) : null);
  } catch {}
}

// ── MIGRACIÓN: asignacion_id en pagos (para vincular pago con materia habilitada) ──
try {
  const cols = db.prepare("PRAGMA table_info(pagos)").all().map(c => c.name);
  if (!cols.includes('asignacion_id')) {
    db.prepare("ALTER TABLE pagos ADD COLUMN asignacion_id TEXT REFERENCES asignaciones(id)").run();
    console.log('[Migración] pagos.asignacion_id agregado');
  }
} catch(e) { console.warn('[Migración] pagos.asignacion_id:', e.message); }

try { db.prepare("ALTER TABLE pagos ADD COLUMN mora_exonerada INTEGER NOT NULL DEFAULT 0").run(); } catch {}
try { db.prepare("ALTER TABLE pagos ADD COLUMN mora_monto INTEGER NOT NULL DEFAULT 0").run(); } catch {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS deuda_exoneraciones (
    id TEXT PRIMARY KEY,
    alumno_id TEXT NOT NULL,
    monto INTEGER NOT NULL,
    motivo TEXT,
    director_id TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
} catch {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS compromisos_pago (
    id TEXT PRIMARY KEY,
    alumno_id TEXT NOT NULL,
    director_id TEXT NOT NULL,
    fecha_limite TEXT NOT NULL,
    monto_total INTEGER NOT NULL DEFAULT 0,
    concepto TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    fecha_pago TEXT,
    pago_id TEXT
  )`);
} catch {}

try { db.prepare("ALTER TABLE solicitudes_registro ADD COLUMN alumno_id TEXT").run(); } catch {}
try { db.prepare("ALTER TABLE solicitudes_registro ADD COLUMN tipo TEXT DEFAULT 'nuevo'").run(); } catch {}
try { db.prepare("ALTER TABLE asignaciones ADD COLUMN parcial_bloqueado INTEGER DEFAULT 0").run(); } catch {}

// ── MIGRACIÓN DE DATOS: asignar días a materias sin horario ──────────────────
{
  const migHorarios = [
    // [asignacion_id, dia, hora_inicio, hora_fin, turno]
    ['asig_cos107_1a',              'Martes',  '19:00', '20:20', 1],
    ['asig_cos107_1b',              'Martes',  '20:40', '22:00', 2],
    ['asig_crm205_2u',              'Martes',  '20:40', '22:00', 2],
    ['asig_enf205_2u',              'Viernes', '19:00', '20:20', 1],
    ['asig_enf204_2u',              'Viernes', '20:40', '22:00', 2],
    ['asig_iq205_2u',               'Viernes', '19:00', '20:20', 1],
  ];
  const updAsig = db.prepare(`UPDATE asignaciones SET dia=?, hora_inicio=?, hora_fin=? WHERE id=? AND (dia IS NULL OR dia='')`);
  const insHor  = db.prepare(`INSERT OR IGNORE INTO horarios(asignacion_id,dia,turno,hora_inicio,hora_fin,aula) VALUES(?,?,?,?,?,'')`);
  for (const [id, dia, hi, hf, turno] of migHorarios) {
    updAsig.run(dia, hi, hf, id);
    const yaExiste = db.prepare(`SELECT 1 FROM horarios WHERE asignacion_id=?`).get(id);
    if (!yaExiste) insHor.run(id, dia, turno, hi, hf);
  }
  // Criminología: cambiar de Martes a Jueves 1ra hora
  db.prepare(`UPDATE asignaciones SET dia='Jueves', hora_inicio='19:00', hora_fin='20:20' WHERE id='asig_doc_dominguez_CRM_202_crim_2u' AND dia='Martes'`).run();
  db.prepare(`UPDATE horarios SET dia='Jueves', turno=1, hora_inicio='19:00', hora_fin='20:20' WHERE asignacion_id='asig_doc_dominguez_CRM_202_crim_2u'`).run();
  // Eliminar asignación duplicada de Inglés I Farmacia 1° (sin notas reales)
  db.prepare(`DELETE FROM notas WHERE asignacion_id='asig_doc_jimenez_FAR_106_farm_1u'`).run();
  db.prepare(`DELETE FROM asignaciones WHERE id='asig_doc_jimenez_FAR_106_farm_1u'`).run();
}
// ── MIGRACIÓN: exámenes finales ordinarios julio 2026 ────────────────────────
{
  const insEx = db.prepare(`INSERT OR IGNORE INTO examenes(id,asignacion_id,tipo,fecha,hora,aula,periodo_id,puntos_max)
    VALUES(?,?,?,?,?,NULL,?,100)`);
  const exams = [
    ['ex_ford_asig_doc_gimenez_CON_104_cont_1u','asig_doc_gimenez_CON_104_cont_1u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_doc_sharp_CON_105_cont_1u','asig_doc_sharp_CON_105_cont_1u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_doc_rojas_ENF_102_enf_1u','asig_doc_rojas_ENF_102_enf_1u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_doc_rojas_RAD_102_rad_1u','asig_doc_rojas_RAD_102_rad_1u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_doc_carrillo_ENF_105_enf_1u','asig_doc_carrillo_ENF_105_enf_1u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_doc_carrillo_RAD_105_rad_1u','asig_doc_carrillo_RAD_105_rad_1u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_doc_aguero_FAR_103_farm_1u','asig_doc_aguero_FAR_103_farm_1u','final_ord','2026-07-10','19:00',1],
    ['ex_ford_asig_doc_aguero_IQ_103_instr_1u','asig_doc_aguero_IQ_103_instr_1u','final_ord','2026-07-10','19:00',1],
    ['ex_ford_asig_doc_carrillo_FAR_105_farm_1u','asig_doc_carrillo_FAR_105_farm_1u','final_ord','2026-07-17','20:40',1],
    ['ex_ford_asig_doc_carrillo_IQ_105_instr_1u','asig_doc_carrillo_IQ_105_instr_1u','final_ord','2026-07-17','20:40',1],
    ['ex_ford_asig_doc_ayala_n_FAR_201_farm_2u','asig_doc_ayala_n_FAR_201_farm_2u','final_ord','2026-07-10','19:00',1],
    ['ex_ford_asig_doc_aguero_FAR_202_farm_2u','asig_doc_aguero_FAR_202_farm_2u','final_ord','2026-07-17','20:40',1],
    ['ex_ford_asig_doc_natalia_IQ_203_instr_2u','asig_doc_natalia_IQ_203_instr_2u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_doc_palacios_RAD_203_rad_2u','asig_doc_palacios_RAD_203_rad_2u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_doc_natalia_RAD_204_rad_2u','asig_doc_natalia_RAD_204_rad_2u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_iq205_2u','asig_iq205_2u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_enf204_2u','asig_enf204_2u','final_ord','2026-07-10','20:40',1],
    ['ex_ford_asig_enf205_2u','asig_enf205_2u','final_ord','2026-07-17','19:00',1],
    ['ex_ford_asig_doc_carmona_AGR_102_agro_1u','asig_doc_carmona_AGR_102_agro_1u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_alum_AGR_103_agro_1u','asig_doc_alum_AGR_103_agro_1u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_doc_alum_CRM_103_crim_1u','asig_doc_alum_CRM_103_crim_1u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_doc_gimenez_AGR_201_agro_2u','asig_doc_gimenez_AGR_201_agro_2u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_gimenez_AGR_202_agro_2u','asig_doc_gimenez_AGR_202_agro_2u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_doc_ayala_n_COS_102_cosA_1a','asig_doc_ayala_n_COS_102_cosA_1a','final_ord','2026-07-07','20:40',1],
    ['ex_ford_asig_doc_carballo_COS_103_cosA_1a','asig_doc_carballo_COS_103_cosA_1a','final_ord','2026-07-14','19:00',1],
    ['ex_ford_asig_cos107_1a','asig_cos107_1a','final_ord','2026-07-21','19:00',1],
    ['ex_ford_asig_doc_higuchi_COS_101_cosA_1b','asig_doc_higuchi_COS_101_cosA_1b','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_carballo_COS_103_cosA_1b','asig_doc_carballo_COS_103_cosA_1b','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_cos107_1b','asig_cos107_1b','final_ord','2026-07-21','20:40',1],
    ['ex_ford_asig_doc_ayala_n_COS_202_cosA_2u','asig_doc_ayala_n_COS_202_cosA_2u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_rojas_COS_203_cosA_2u','asig_doc_rojas_COS_203_cosA_2u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_doc_ocampos_CRM_101_crim_1u','asig_doc_ocampos_CRM_101_crim_1u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_dominguez_CRM_203_crim_2u','asig_doc_dominguez_CRM_203_crim_2u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_mareco_ELC_201_elec_2u','asig_doc_mareco_ELC_201_elec_2u','final_ord','2026-07-07','19:00',1],
    ['ex_ford_asig_doc_mareco_ELC_202_elec_2u','asig_doc_mareco_ELC_202_elec_2u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_crm205_2u','asig_crm205_2u','final_ord','2026-07-14','20:40',1],
    ['ex_ford_asig_doc_gimenez_AGR_104_agro_1u','asig_doc_gimenez_AGR_104_agro_1u','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_gimenez_AGR_105_agro_1u','asig_doc_gimenez_AGR_105_agro_1u','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_gimenez_AGR_204_agro_2u','asig_doc_gimenez_AGR_204_agro_2u','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_carmona_AGR_203_agro_2u','asig_doc_carmona_AGR_203_agro_2u','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_higuchi_COS_101_cosA_1a','asig_doc_higuchi_COS_101_cosA_1a','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_rojas_COS_105_cosA_1a','asig_doc_rojas_COS_105_cosA_1a','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_valenz_COS_105_cosA_1b','asig_doc_valenz_COS_105_cosA_1b','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_espinola_COS_106_cosA_1b','asig_doc_espinola_COS_106_cosA_1b','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_carballo_COS_204_cosA_2u','asig_doc_carballo_COS_204_cosA_2u','final_ord','2026-07-09','20:40',1],
    ['ex_ford_asig_doc_carballo_COS_205_cosA_2u','asig_doc_carballo_COS_205_cosA_2u','final_ord','2026-07-16','19:00',1],
    ['ex_ford_asig_doc_dominguez_CRM_104_crim_1u','asig_doc_dominguez_CRM_104_crim_1u','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_dominguez_CRM_202_crim_2u','asig_doc_dominguez_CRM_202_crim_2u','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_sharp_CRM_105_crim_1u','asig_doc_sharp_CRM_105_crim_1u','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_dominguez_CRM_201_crim_2u','asig_doc_dominguez_CRM_201_crim_2u','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_mareco_ELC_204_elec_2u','asig_doc_mareco_ELC_204_elec_2u','final_ord','2026-07-09','19:00',1],
    ['ex_ford_asig_doc_mareco_ELC_205_elec_2u','asig_doc_mareco_ELC_205_elec_2u','final_ord','2026-07-16','20:40',1],
    ['ex_ford_asig_doc_jimenez_AGR_101_agro_1u','asig_doc_jimenez_AGR_101_agro_1u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_jimenez_AGR_205_agro_2u','asig_doc_jimenez_AGR_205_agro_2u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_jimenez_ELC_203_elec_2u','asig_doc_jimenez_ELC_203_elec_2u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_perez_CON_102_cont_1u','asig_doc_perez_CON_102_cont_1u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_perez_CRM_102_crim_1u','asig_doc_perez_CRM_102_crim_1u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_gimenez_CON_103_cont_1u','asig_doc_gimenez_CON_103_cont_1u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_espinola_COS_104_cosA_1a','asig_doc_espinola_COS_104_cosA_1a','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_torales_COS_201_cosA_2u','asig_doc_torales_COS_201_cosA_2u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_aranda_CRM_204_crim_2u','asig_doc_aranda_CRM_204_crim_2u','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_romero_ENF_103_enf_1u','asig_doc_romero_ENF_103_enf_1u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_romero_RAD_103_rad_1u','asig_doc_romero_RAD_103_rad_1u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_carrillo_ENF_203_enf_2u','asig_doc_carrillo_ENF_203_enf_2u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_carrillo_FAR_205_farm_2u','asig_doc_carrillo_FAR_205_farm_2u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_villar_FAR_102_farm_1u','asig_doc_villar_FAR_102_farm_1u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_villar_IQ_102_instr_1u','asig_doc_villar_IQ_102_instr_1u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_gonzalez_IQ_204_instr_2u','asig_doc_gonzalez_IQ_204_instr_2u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_doc_aranda_RAD_201_rad_2u','asig_doc_aranda_RAD_201_rad_2u','final_ord','2026-07-08','20:40',1],
    ['ex_ford_asig_cos102_cosA_1b','asig_cos102_cosA_1b','final_ord','2026-07-22','19:00',1],
    ['ex_ford_asig_doc_jimenez_CON_101_cont_1u','asig_doc_jimenez_CON_101_cont_1u','final_ord','2026-07-13','19:00',1],
    ['ex_ford_asig_doc_jimenez_FAR_203_farm_2u','asig_doc_jimenez_FAR_203_farm_2u','final_ord','2026-07-13','19:00',1],
    ['ex_ford_asig_doc_higuchi_ENF_101_enf_1u','asig_doc_higuchi_ENF_101_enf_1u','final_ord','2026-07-13','20:40',1],
    ['ex_ford_asig_doc_higuchi_RAD_101_rad_1u','asig_doc_higuchi_RAD_101_rad_1u','final_ord','2026-07-13','20:40',1],
    ['ex_ford_asig_doc_ayala_a_ENF_104_enf_1u','asig_doc_ayala_a_ENF_104_enf_1u','final_ord','2026-07-20','19:00',1],
    ['ex_ford_asig_doc_ayala_a_RAD_104_rad_1u','asig_doc_ayala_a_RAD_104_rad_1u','final_ord','2026-07-20','19:00',1],
    ['ex_ford_asig_doc_romero_ENF_201_enf_2u','asig_doc_romero_ENF_201_enf_2u','final_ord','2026-07-13','19:00',1],
    ['ex_ford_asig_doc_ayala_a_ENF_202_enf_2u','asig_doc_ayala_a_ENF_202_enf_2u','final_ord','2026-07-20','20:40',1],
    ['ex_ford_asig_doc_rojas_FAR_101_farm_1u','asig_doc_rojas_FAR_101_farm_1u','final_ord','2026-07-13','20:40',1],
    ['ex_ford_asig_doc_rojas_IQ_101_instr_1u','asig_doc_rojas_IQ_101_instr_1u','final_ord','2026-07-13','20:40',1],
    ['ex_ford_asig_doc_aranda_FAR_104_farm_1u','asig_doc_aranda_FAR_104_farm_1u','final_ord','2026-07-20','19:00',1],
    ['ex_ford_asig_doc_aranda_IQ_104_instr_1u','asig_doc_aranda_IQ_104_instr_1u','final_ord','2026-07-20','19:00',1],
    ['ex_ford_asig_doc_aranda_FAR_204_farm_2u','asig_doc_aranda_FAR_204_farm_2u','final_ord','2026-07-20','20:40',1],
    ['ex_ford_asig_doc_alum_IQ_201_instr_2u','asig_doc_alum_IQ_201_instr_2u','final_ord','2026-07-13','20:40',1],
    ['ex_ford_asig_doc_rojas_IQ_202_instr_2u','asig_doc_rojas_IQ_202_instr_2u','final_ord','2026-07-20','19:00',1],
    ['ex_ford_asig_doc_higuchi_RAD_202_rad_2u','asig_doc_higuchi_RAD_202_rad_2u','final_ord','2026-07-13','19:00',1],
    ['ex_ford_asig_doc_palacios_RAD_205_rad_2u','asig_doc_palacios_RAD_205_rad_2u','final_ord','2026-07-20','20:40',1],
  ];
  const ins = db.transaction(() => { for (const e of exams) insEx.run(...e); });
  ins();
}
// ── MIGRACIÓN: normalizar tipos de examen al estilo técnico ─────────────────
{
  db.prepare(`UPDATE examenes SET tipo='final_ord'           WHERE tipo='Final'`).run();
  db.prepare(`UPDATE examenes SET tipo='final_recuperatorio' WHERE tipo='Final Recuperatorio'`).run();
  db.prepare(`UPDATE examenes SET tipo='complementario'      WHERE tipo='Complementario'`).run();
  db.prepare(`UPDATE examenes SET tipo='extraordinario'      WHERE tipo='Extraordinario'`).run();
}
// ────────────────────────────────────────────────────────────────────────────

// Tablas auxiliares del bot (si no existen se crean aquí)
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS wa_consultas (
    id TEXT PRIMARY KEY, numero TEXT, nombre TEXT, tipo TEXT,
    alumno_id TEXT, carrera_nombre TEXT, anio TEXT, ci TEXT,
    consulta TEXT, estado TEXT DEFAULT 'pendiente', fecha TEXT
  )`).run();
} catch(e) { console.warn('[Migración] wa_consultas:', e.message); }
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS interesados_bot (
    id TEXT PRIMARY KEY, nombre TEXT, telefono TEXT,
    carrera_id TEXT, carrera_nombre TEXT, estado TEXT DEFAULT 'nuevo', fecha TEXT DEFAULT (datetime('now','localtime'))
  )`).run();
} catch(e) { console.warn('[Migración] interesados_bot:', e.message); }

// ── MIGRACIÓN: ampliar CHECK constraint de aranceles.tipo ────────────────────
try {
  const arancelSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='aranceles'").get()?.sql || '';
  const tiposNuevos = ['parcial_recuperatorio','final_ordinario','final_recuperatorio','complementario'];
  const necesitaMigracion = tiposNuevos.some(t => !arancelSql.includes(t));
  if (necesitaMigracion) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS aranceles_new (
        id TEXT PRIMARY KEY,
        concepto TEXT NOT NULL,
        monto INTEGER NOT NULL DEFAULT 0,
        tipo TEXT NOT NULL DEFAULT 'cuota' CHECK(tipo IN (
          'matricula','cuota','parcial','parcial_recuperatorio',
          'final','final_ordinario','final_recuperatorio',
          'complementario','extraordinario','certificado','otro'
        )),
        carrera_id TEXT REFERENCES carreras(id),
        descripcion TEXT,
        anio INTEGER,
        activo INTEGER NOT NULL DEFAULT 1,
        fecha_actualizacion TEXT DEFAULT (date('now'))
      );
      INSERT OR IGNORE INTO aranceles_new SELECT
        id, concepto, monto, tipo, carrera_id, descripcion, anio,
        COALESCE(activo,1), COALESCE(fecha_actualizacion, date('now'))
      FROM aranceles;
      DROP TABLE aranceles;
      ALTER TABLE aranceles_new RENAME TO aranceles;
      PRAGMA foreign_keys=ON;
    `);
    console.log('[Migración] aranceles.tipo CHECK constraint ampliado ✓');
  }
} catch(e) { console.warn('[Migración] aranceles constraint:', e.message); }

// ── MIGRACIÓN: ampliar CHECK constraint de avisos.destinatario (agrega 'director') ──
// Necesario para que el watchdog de WhatsApp pueda avisar solo al director sin que el
// aviso también le aparezca a todos los docentes/alumnos.
try {
  const avisosSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='avisos'").get()?.sql || '';
  if (avisosSql && !avisosSql.includes("'director'")) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS avisos_new (
        id TEXT PRIMARY KEY,
        titulo TEXT NOT NULL,
        contenido TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'info' CHECK(tipo IN ('info','urgente','examen','administrativo')),
        fijado INTEGER NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1,
        destinatario TEXT NOT NULL DEFAULT 'todos' CHECK(destinatario IN ('todos','docentes','alumnos','director')),
        usuario_id TEXT NOT NULL REFERENCES usuarios(id),
        fecha_creacion TEXT NOT NULL DEFAULT (datetime('now')),
        sede_id TEXT DEFAULT 'pjc'
      );
      INSERT OR IGNORE INTO avisos_new SELECT
        id, titulo, contenido, tipo, fijado, activo, destinatario, usuario_id,
        fecha_creacion, COALESCE(sede_id,'pjc')
      FROM avisos;
      DROP TABLE avisos;
      ALTER TABLE avisos_new RENAME TO avisos;
      PRAGMA foreign_keys=ON;
    `);
    console.log('[Migración] avisos.destinatario CHECK constraint ampliado (+ director) ✓');
  }
} catch(e) { console.warn('[Migración] avisos constraint:', e.message); }

// ── MIGRACIÓN DE DATOS: restaura notas perdidas por bug de cache vacio en updN ──
// Ver commit 5e1d7c1: guardar una nota sin haber cargado antes la grilla completa
// mandaba la fila entera con campos ausentes como '', que el backend guardaba como
// NULL, borrando valores reales ya cargados. Detectados 90 casos via auditoria
// (comparando el valor antes/despues de cada UPDATE_NOTA); esta migracion solo
// restaura los 49 que SIGUEN vacios ahora mismo -- si un docente ya volvio a
// cargar el valor a mano mientras tanto, se detecta (campo ya no esta en NULL)
// y se saltea sin tocarlo. Nunca resta puntos ni pisa un valor existente.
try {
  const yaAplicada = db.prepare("SELECT valor FROM configuracion WHERE clave='migracion_restaurar_notas_2026_07'").get();
  if (!yaAplicada) {
    const { calcularPuntaje } = require('./db');
    const restauraciones = [
      { alumno_id: 'a_1778458688838_x6f', asignacion_id: 'asig_doc_sharp_CON_105_cont_1u', campo: 'parcial', valor: 0 },
      { alumno_id: 'a_1778458688838_x6f', asignacion_id: 'asig_doc_sharp_CON_105_cont_1u', campo: 'tp1', valor: 5 },
      { alumno_id: 'a_1778459610968_zkn', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', campo: 'parcial', valor: 0 },
      { alumno_id: 'a_1778460585799_94w', asignacion_id: 'asig_doc_aguero_IQ_103_instr_1u', campo: 'tp4', valor: 5 },
      { alumno_id: 'a_1778446683571_30r', asignacion_id: 'asig_doc_jimenez_FAR_203_farm_2u', campo: 'tp4', valor: 4 },
      { alumno_id: 'a_1778446682734_lce', asignacion_id: 'asig_doc_jimenez_FAR_203_farm_2u', campo: 'tp4', valor: 4 },
      { alumno_id: 'a_1778617100280_pbz', asignacion_id: 'asig_doc_valenz_COS_105_cosA_1b', campo: 'tp2', valor: 0 },
      { alumno_id: 'a_1778617162855_1wq', asignacion_id: 'asig_doc_valenz_COS_105_cosA_1b', campo: 'tp2', valor: 0 },
      { alumno_id: 'a_1778446814694_0lm', asignacion_id: 'asig_doc_aranda_RAD_201_rad_2u', campo: 'tp1', valor: 15 },
      { alumno_id: 'a_1778446814694_0lm', asignacion_id: 'asig_doc_aranda_RAD_201_rad_2u', campo: 'tp1', valor: 1 },
      { alumno_id: 'a_1778460586676_y35', asignacion_id: 'asig_doc_aranda_IQ_104_instr_1u', campo: 'tp1', valor: 16 },
      { alumno_id: 'a_1779838845888', asignacion_id: 'asig_doc_perez_CRM_102_crim_1u', campo: 'tp2', valor: 0 },
      { alumno_id: 'a_1778458752721_kbn', asignacion_id: 'asig_doc_perez_CRM_102_crim_1u', campo: 'parcial', valor: 9 },
      { alumno_id: 'a_1778458752063_gz5', asignacion_id: 'asig_doc_perez_CRM_102_crim_1u', campo: 'parcial', valor: 5 },
      { alumno_id: 'a_1778617162791_8yy', asignacion_id: 'asig_cos102_cosA_1b', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778617161775_gsp', asignacion_id: 'asig_doc_espinola_COS_106_cosA_1b', campo: 'parcial', valor: 8 },
      { alumno_id: 'a_imp_81_09qy', asignacion_id: 'asig_doc_carballo_COS_103_cosA_1a', campo: 'parcial', valor: 16 },
      { alumno_id: 'a_imp_35_k46t', asignacion_id: 'asig_doc_carballo_COS_103_cosA_1a', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778443281108_u8o', asignacion_id: 'asig_doc_carballo_COS_204_cosA_2u', campo: 'tp1', valor: 1 },
      { alumno_id: 'a_1778617162536_foq', asignacion_id: 'asig_cos102_cosA_1b', campo: 'parcial', valor: 19 },
      { alumno_id: 'a_1778443281792_aby', asignacion_id: 'asig_doc_carballo_COS_205_cosA_2u', campo: 'tp3', valor: 5 },
      { alumno_id: 'a_1778446682809_8s2', asignacion_id: 'asig_doc_carrillo_FAR_205_farm_2u', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1779323444008', asignacion_id: 'asig_doc_higuchi_COS_101_cosA_1a', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778446787609_p2q', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', campo: 'parcial', valor: 15 },
      { alumno_id: 'a_1778458751006_376', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 0 },
      { alumno_id: 'a_1781566133474', asignacion_id: 'asig_doc_gimenez_CON_103_cont_1u', campo: 'parcial', valor: 17 },
      { alumno_id: 'a_1778458752853_ue0', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 13 },
      { alumno_id: 'a_1779834471242', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 15 },
      { alumno_id: 'a_1778458751141_6ue', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778458752653_17v', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 19 },
      { alumno_id: 'a_1778458752589_4o1', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 16 },
      { alumno_id: 'a_1779834464558', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 16 },
      { alumno_id: 'a_1778458752261_jo3', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 17 },
      { alumno_id: 'a_1778458751996_dyy', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778458751071_249', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 19 },
      { alumno_id: 'a_1778458751204_apl', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 18 },
      { alumno_id: 'a_1779834475495', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 13 },
      { alumno_id: 'a_1778458751271_356', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 11 },
      { alumno_id: 'a_1778458751602_gg6', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 19 },
      { alumno_id: 'a_1778458752131_ro1', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 17 },
      { alumno_id: 'a_1780526717517', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 12 },
      { alumno_id: 'a_1778458751800_y7v', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 10 },
      { alumno_id: 'a_1778458752721_kbn', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 18 },
      { alumno_id: 'a_1778458751341_g61', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 15 },
      { alumno_id: 'a_1778458752457_bhp', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 14 },
      { alumno_id: 'a_1778458752063_gz5', asignacion_id: 'asig_doc_ocampos_CRM_101_crim_1u', campo: 'parcial', valor: 15 },
      { alumno_id: 'a_imp_136_t2sp', asignacion_id: 'asig_doc_higuchi_COS_101_cosA_1b', campo: 'parcial', valor: 20 },
      { alumno_id: 'a_1778617162663_s5h', asignacion_id: 'asig_doc_higuchi_COS_101_cosA_1b', campo: 'parcial', valor: 15 },
      { alumno_id: 'a_1778443281792_aby', asignacion_id: 'asig_doc_carballo_COS_205_cosA_2u', campo: 'parcial', valor: 19 },
    ];
    const camposValidos = new Set(['tp1','tp2','tp3','tp4','tp5','parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario','director_pts']);
    let aplicados = 0, salteados = 0;
    const tx = db.transaction(() => {
      for (const r of restauraciones) {
        if (!camposValidos.has(r.campo)) continue;
        const actual = db.prepare(`SELECT ${r.campo} as v FROM notas WHERE alumno_id=? AND asignacion_id=?`).get(r.alumno_id, r.asignacion_id);
        if (!actual || actual.v !== null) { salteados++; continue; } // ya tiene valor (docente lo recargo) -> no tocar
        db.prepare(`UPDATE notas SET ${r.campo}=? WHERE alumno_id=? AND asignacion_id=?`).run(r.valor, r.alumno_id, r.asignacion_id);
        const fila = db.prepare('SELECT tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario,director_pts FROM notas WHERE alumno_id=? AND asignacion_id=?').get(r.alumno_id, r.asignacion_id);
        const calc = calcularPuntaje(fila.tp1,fila.tp2,fila.tp3,fila.tp4,fila.tp5,fila.parcial,fila.parcial_recuperatorio,fila.final_ord,fila.final_recuperatorio,fila.complementario,fila.extraordinario,fila.director_pts);
        db.prepare('UPDATE notas SET tp_total=?,puntaje_total=?,nota_final=?,estado=?,parcial_efectivo=?,final_efectivo=? WHERE alumno_id=? AND asignacion_id=?')
          .run(calc.tp_total, calc.puntaje, calc.nota, calc.estado, calc.parcial_ef, calc.final_ef, r.alumno_id, r.asignacion_id);
        audit('sistema_migracion', 'RESTAURAR_NOTA_PERDIDA', 'notas', r.alumno_id + '_' + r.asignacion_id, { campo: r.campo, valor_restaurado: r.valor });
        aplicados++;
      }
    });
    tx();
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)")
      .run('migracion_restaurar_notas_2026_07', '1', `Restauro ${aplicados} notas, salteo ${salteados} ya recargadas por docentes`);
    console.log(`[Migración] Restauradas ${aplicados} notas perdidas por bug de cache vacio (${salteados} ya recargadas manualmente, sin tocar) ✓`);
  }
} catch(e) { console.warn('[Migración] restaurar notas perdidas:', e.message); }

// ── MIGRACIÓN: Restaurar "parcial" perdido por bug de payload de docente ─────
// Causa raíz DISTINTA a la de arriba: el frontend nunca manda el campo "parcial"
// en el payload de un docente (a propósito, para que no lo edite libremente), pero
// el backend interpretaba "campo ausente" como "vaciar ese campo" -- así que CADA
// guardado de un docente de CUALQUIER otro campo (tp1, final, etc.) borraba el
// parcial ya cargado. Encontrado al investigar el reporte de Blanca Villar
// ("cargué las parciales el 26/05 y ya no aparecen"), y confirmado que afectaba a
// 6 docentes / 8 asignaciones en total (incluye el caso reportado de Natalia
// Martínez). El backend ya está corregido (ver el PUT de notas: ahora conserva el
// valor existente si el campo no vino en el request). Esto solo restaura los 66
// valores que TODAVÍA están vacíos hoy -- si un docente ya lo recargó a mano
// mientras tanto, se detecta (campo ya no está en NULL) y se saltea sin tocarlo.
try {
  const yaAplicada2 = db.prepare("SELECT valor FROM configuracion WHERE clave='migracion_restaurar_parcial_2026_07_2'").get();
  if (!yaAplicada2) {
    const { calcularPuntaje } = require('./db');
    const restauracionesParcial = [
      { alumno_id: 'a_1778446786868_gtd', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 19 },
      { alumno_id: 'a_1778446787001_nei', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 14 },
      { alumno_id: 'a_1778446787067_5jp', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 20 },
      { alumno_id: 'a_1778446787137_7de', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 15 },
      { alumno_id: 'a_1778446787270_pts', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 19 },
      { alumno_id: 'a_1778446787342_g7b', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 20 },
      { alumno_id: 'a_1778446787544_uhz', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 20 },
      { alumno_id: 'a_1778446787940_ycb', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 14 },
      { alumno_id: 'a_1778446788139_4aq', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 19 },
      { alumno_id: 'a_1778446788208_zoj', asignacion_id: 'asig_doc_natalia_IQ_203_instr_2u', valor: 17 },
      { alumno_id: 'a_1778446813292_nyz', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 19 },
      { alumno_id: 'a_1778446813360_jr6', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 16 },
      { alumno_id: 'a_1778446813428_qlv', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 20 },
      { alumno_id: 'a_1778446813565_mwp', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 11 },
      { alumno_id: 'a_1778446813631_1tj', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 20 },
      { alumno_id: 'a_1778446813833_scy', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 15 },
      { alumno_id: 'a_1778446813964_cw8', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 18 },
      { alumno_id: 'a_1778446814101_6ht', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 18 },
      { alumno_id: 'a_1778446814167_1hw', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 18 },
      { alumno_id: 'a_1778446814629_fnv', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 19 },
      { alumno_id: 'a_1778446814694_0lm', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 14 },
      { alumno_id: 'a_1778446814761_ep1', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 11 },
      { alumno_id: 'a_1778446814828_0ue', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 18 },
      { alumno_id: 'a_1778459609780_f4n', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459609911_gb5', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459609978_dgo', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610107_f7p', asignacion_id: 'asig_doc_rojas_FAR_101_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610107_f7p', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610176_xqt', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610243_gpv', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610308_ndi', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610440_yhs', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610569_77v', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610638_ar1', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610702_bv1', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610767_k6h', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459610902_8kr', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459611039_cqc', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778459611103_bu3', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778460281546_j83', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778460281546_zyf', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778460585663_l25', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460585730_0vm', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586341_6fl', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586407_3nh', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586474_5fg', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586541_yoq', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586676_y35', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586741_r9h', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460586804_8ei', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460587001_w8d', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460587261_jna', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460587331_50a', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778460587396_kh0', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1778617162473_ger', asignacion_id: 'asig_cos102_cosA_1b', valor: 18 },
      { alumno_id: 'a_1778460585465_8vz', asignacion_id: 'asig_doc_higuchi_COS_101_cosA_1b', valor: 19 },
      { alumno_id: 'a_1779150367342', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1779150423136', asignacion_id: 'asig_doc_rojas_FAR_101_farm_1u', valor: 20 },
      { alumno_id: 'a_1779150423136', asignacion_id: 'asig_doc_villar_FAR_102_farm_1u', valor: 20 },
      { alumno_id: 'a_1778896860362', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 14 },
      { alumno_id: 'a_1778896866597', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 17 },
      { alumno_id: 'a_1778896864098', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 20 },
      { alumno_id: 'a_1778461784690_obp', asignacion_id: 'asig_doc_natalia_RAD_204_rad_2u', valor: 17 },
      { alumno_id: 'a_1778446788277_97x', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1779920496517', asignacion_id: 'asig_doc_villar_IQ_102_instr_1u', valor: 20 },
      { alumno_id: 'a_1781566133474', asignacion_id: 'asig_doc_gimenez_CON_104_cont_1u', valor: 20 },
    ];
    let aplicados2 = 0, salteados2 = 0;
    const tx2 = db.transaction(() => {
      for (const r of restauracionesParcial) {
        const actual = db.prepare('SELECT parcial FROM notas WHERE alumno_id=? AND asignacion_id=?').get(r.alumno_id, r.asignacion_id);
        if (!actual || actual.parcial !== null) { salteados2++; continue; } // ya tiene valor -> no tocar
        db.prepare('UPDATE notas SET parcial=? WHERE alumno_id=? AND asignacion_id=?').run(r.valor, r.alumno_id, r.asignacion_id);
        const fila = db.prepare('SELECT tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario,director_pts FROM notas WHERE alumno_id=? AND asignacion_id=?').get(r.alumno_id, r.asignacion_id);
        const calc = calcularPuntaje(fila.tp1,fila.tp2,fila.tp3,fila.tp4,fila.tp5,fila.parcial,fila.parcial_recuperatorio,fila.final_ord,fila.final_recuperatorio,fila.complementario,fila.extraordinario,fila.director_pts);
        db.prepare('UPDATE notas SET tp_total=?,puntaje_total=?,nota_final=?,estado=?,parcial_efectivo=?,final_efectivo=? WHERE alumno_id=? AND asignacion_id=?')
          .run(calc.tp_total, calc.puntaje, calc.nota, calc.estado, calc.parcial_ef, calc.final_ef, r.alumno_id, r.asignacion_id);
        audit('sistema_migracion', 'RESTAURAR_NOTA_PERDIDA', 'notas', r.alumno_id + '_' + r.asignacion_id, { campo: 'parcial', valor_restaurado: r.valor, causa: 'bug_payload_docente_omite_parcial' });
        aplicados2++;
      }
    });
    tx2();
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)")
      .run('migracion_restaurar_parcial_2026_07_2', '1', `Restauro ${aplicados2} parciales, salteo ${salteados2} ya recargados por docentes`);
    console.log(`[Migración] Restaurados ${aplicados2} parciales perdidos por bug de payload de docente (${salteados2} ya recargados manualmente, sin tocar) ✓`);
  }
} catch(e) { console.warn('[Migración] restaurar parcial perdido:', e.message); }

// Restaurar final_ord=50 de Garcia Piris, Orlando Ramon (Anatomía y Fisiología Humana)
// detectado en audit log 2026-07-21 18:41:21, confirmado NULL en snapshot 2026-08-05
try {
  if (!db.prepare("SELECT valor FROM configuracion WHERE clave='restaura_final_ord_garcia_piris_2026_07_21'").get()) {
    const r = db.prepare("UPDATE notas SET final_ord=50 WHERE alumno_id='a_1778459611039_cqc' AND asignacion_id='asig_doc_rojas_FAR_101_farm_1u' AND final_ord IS NULL").run();
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)").run('restaura_final_ord_garcia_piris_2026_07_21','1',`Restauro final_ord=50 de Garcia Piris Orlando Ramon (${r.changes} fila)`);
    if (r.changes) console.log('[Migración] Restaurado final_ord=50 Garcia Piris, Orlando Ramon ✓');
  }
} catch(e) { console.warn('[Migración] restaurar Garcia Piris:', e.message); }

// Restaurar notas perdidas detectadas en audit log 2026-07-30
try {
  const yaAplicada3 = db.prepare("SELECT valor FROM configuracion WHERE clave='migracion_restaurar_notas_audit_2026_07_30'").get();
  if (!yaAplicada3) {
    const restauraciones = [
      // Introducción a la Criminalística
      { alumno_id:'a_1780531203780',       asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp1', valor:1  },
      { alumno_id:'a_1778458751472_vp3',   asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp2', valor:1  },
      { alumno_id:'a_1778458751737_qrf',   asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp1', valor:10 },
      { alumno_id:'a_1778458751737_qrf',   asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp2', valor:10 },
      { alumno_id:'a_1778458752523_ast',   asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp1', valor:10 },
      { alumno_id:'a_1778458752523_ast',   asig_id:'asig_doc_dominguez_CRM_104_crim_1u', campo:'tp2', valor:10 },
      // Accidentología Vial
      { alumno_id:'a_1780357719071',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp2', valor:5  },
      { alumno_id:'a_1780357719071',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp3', valor:5  },
      { alumno_id:'a_1780357719071',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp4', valor:5  },
      { alumno_id:'a_1778443319662_d9r',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp1', valor:5  },
      { alumno_id:'a_1778443319662_d9r',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp2', valor:5  },
      { alumno_id:'a_1778443319662_d9r',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp3', valor:5  },
      { alumno_id:'a_1778443319798_vzc',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp1', valor:5  },
      { alumno_id:'a_1778443319798_vzc',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp2', valor:5  },
      { alumno_id:'a_1778443319798_vzc',   asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp3', valor:5  },
      { alumno_id:'a_1780357683909',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp1', valor:5  },
      { alumno_id:'a_1780357683909',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp2', valor:5  },
      { alumno_id:'a_1780357683909',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp3', valor:5  },
      { alumno_id:'a_1780357683909',       asig_id:'asig_doc_dominguez_CRM_201_crim_2u', campo:'tp4', valor:5  },
      // Biología de la Piel
      { alumno_id:'a_imp_121_wfdu',        asig_id:'asig_cos102_cosA_1b',                campo:'final_ord', valor:31 },
      { alumno_id:'a_1778617162473_ger',   asig_id:'asig_cos102_cosA_1b',                campo:'parcial',   valor:18 },
      // Lengua Extranjera – Inglés
      { alumno_id:'a_1778446682734_lce',   asig_id:'asig_doc_jimenez_FAR_203_farm_2u',   campo:'tp4', valor:4  },
      { alumno_id:'a_1778446683571_30r',   asig_id:'asig_doc_jimenez_FAR_203_farm_2u',   campo:'tp4', valor:4  },
      // Dermatología Básica
      { alumno_id:'a_1778617161902_jwx',   asig_id:'asig_cos107_1b',                     campo:'parcial',   valor:18 },
      // Anatomía y Fisiología Humana
      { alumno_id:'a_1778460587396_kh0',   asig_id:'asig_doc_rojas_IQ_101_instr_1u',     campo:'final_ord', valor:50 },
    ];
    const stmt = db.prepare("UPDATE notas SET {campo}=? WHERE alumno_id=? AND asignacion_id=? AND {campo} IS NULL");
    let aplicados3 = 0, salteados3 = 0;
    const tx3 = db.transaction(() => {
      for (const r of restauraciones) {
        const sql = `UPDATE notas SET ${r.campo}=? WHERE alumno_id=? AND asignacion_id=? AND ${r.campo} IS NULL`;
        const res = db.prepare(sql).run(r.valor, r.alumno_id, r.asig_id);
        if (res.changes > 0) aplicados3++; else salteados3++;
      }
    });
    tx3();
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)")
      .run('migracion_restaurar_notas_audit_2026_07_30', '1', `Restauro ${aplicados3} notas perdidas del audit log 2026-07-30 (${salteados3} ya tenian valor o no encontradas)`);
    console.log(`[Migración] Restauradas ${aplicados3} notas perdidas detectadas en audit log 2026-07-30 (${salteados3} sin cambio) ✓`);
  }
} catch(e) { console.warn('[Migración] restaurar notas audit 2026-07-30:', e.message); }

// ── MIGRACIÓN DE DATOS: Cambio de fecha examen Técnicas Faciales ─────────────
// Cosmiatría 1er año Sección B (Raqueline Carballo) — 12/05/2026 → 19/05/2026
try {
  const exFacial = db.prepare(`
    SELECT e.id FROM examenes e
    JOIN asignaciones a ON e.asignacion_id = a.id
    JOIN materias m ON a.materia_id = m.id
    JOIN cursos cu ON a.curso_id = cu.id
    JOIN carreras ca ON cu.carrera_id = ca.id
    WHERE e.fecha = '2026-05-12'
      AND cu.division = 'B'
      AND cu.anio = 1
      AND (m.nombre LIKE '%acial%' OR m.nombre LIKE '%ecnica%facial%' OR m.nombre LIKE '%aciales%')
      AND (ca.nombre LIKE '%osmiat%' OR ca.nombre LIKE '%osmet%')
    LIMIT 1
  `).get();
  if (exFacial) {
    db.prepare("UPDATE examenes SET fecha='2026-05-19' WHERE id=? AND fecha='2026-05-12'").run(exFacial.id);
    console.log('[Migración] Examen Técnicas Faciales Cosm. 1° B: fecha actualizada a 2026-05-19');
  }
} catch(e) { console.warn('[Migración] Técnicas Faciales:', e.message); }

// ── MIGRACIÓN: Corrección de nombres de materias (sede Pedro Juan Caballero) ──
// Castellano/Inglés eran nombres inconsistentes con otras carreras del mismo contenido
try {
  const renombresMaterias = [
    ['m_con_102', 'Castellano', 'Comunicación Escrita y Oral y Lengua Guaraní'],
    ['m_agr_101', 'Inglés', 'Lengua Extranjera – Inglés'],
    ['m_agr_205', 'Inglés', 'Lengua Extranjera – Inglés'],
    ['m_con_101', 'Inglés', 'Lengua Extranjera – Inglés'],
    ['m_elc_203', 'Inglés', 'Lengua Extranjera – Inglés'],
  ];
  const updMat = db.prepare('UPDATE materias SET nombre=? WHERE id=? AND nombre=?');
  renombresMaterias.forEach(([id, antes, despues]) => updMat.run(despues, id, antes));
  console.log('[Migración] Nombres de materias corregidos (Castellano/Inglés) ✓');
} catch(e) { console.warn('[Migración] Renombre materias:', e.message); }

// ── MIGRACIÓN: Reprogramación final de exámenes (v4 — resuelve choques de aula) ──
// Al unificar el horario a las 19:00, 5 materias quedaban con el mismo docente
// examinando 2 materias distintas el mismo día; se posponen a otra fecha (nunca
// se adelantan) respetando siempre el día de clase real de cada materia. La
// profesora Ana Ayala pidió explícitamente rendir Salud Pública el 08/07
// (rompe su día de clase real -lunes- pero ese día sobran aulas). Química
// Cosmética y Biología de la Piel (misma docente, mismo día 07/07) no se pueden
// mover -el examen es inminente-, así que Biología de la Piel queda a las 20:40
// en vez de 19:00 (única excepción a la regla general, por choque de docente).
try {
  const fechaHoraFinalExamenes = [
  ['ex_ford_asig_doc_gimenez_CON_104_cont_1u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_sharp_CON_105_cont_1u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_rojas_ENF_102_enf_1u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_rojas_RAD_102_rad_1u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_carrillo_ENF_105_enf_1u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_carrillo_RAD_105_rad_1u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_aguero_FAR_103_farm_1u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_aguero_IQ_103_instr_1u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_carrillo_FAR_105_farm_1u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_carrillo_IQ_105_instr_1u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_ayala_n_FAR_201_farm_2u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_aguero_FAR_202_farm_2u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_natalia_IQ_203_instr_2u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_palacios_RAD_203_rad_2u', '2026-07-10', '19:00'],
  ['ex_ford_asig_doc_natalia_RAD_204_rad_2u', '2026-07-17', '19:00'],
  ['ex_ford_asig_iq205_2u', '2026-07-17', '19:00'],
  ['ex_ford_asig_enf204_2u', '2026-07-24', '19:00'],
  ['ex_ford_asig_enf205_2u', '2026-07-17', '19:00'],
  ['ex_ford_asig_doc_carmona_AGR_102_agro_1u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_alum_AGR_103_agro_1u', '2026-07-14', '19:00'],
  ['ex_ford_asig_doc_alum_CRM_103_crim_1u', '2026-07-14', '19:00'],
  ['ex_ford_asig_doc_gimenez_AGR_201_agro_2u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_gimenez_AGR_202_agro_2u', '2026-07-14', '19:00'],
  ['ex_ford_asig_doc_ayala_n_COS_102_cosA_1a', '2026-07-07', '20:40'],
  ['ex_ford_asig_doc_carballo_COS_103_cosA_1a', '2026-07-14', '19:00'],
  ['ex_ford_asig_cos107_1a', '2026-07-21', '19:00'],
  ['ex_ford_asig_doc_higuchi_COS_101_cosA_1b', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_carballo_COS_103_cosA_1b', '2026-07-14', '19:00'],
  ['ex_ford_asig_cos107_1b', '2026-07-21', '19:00'],
  ['ex_ford_asig_doc_ayala_n_COS_202_cosA_2u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_rojas_COS_203_cosA_2u', '2026-07-14', '19:00'],
  ['ex_ford_asig_doc_ocampos_CRM_101_crim_1u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_dominguez_CRM_203_crim_2u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_mareco_ELC_201_elec_2u', '2026-07-07', '19:00'],
  ['ex_ford_asig_doc_mareco_ELC_202_elec_2u', '2026-07-14', '19:00'],
  ['ex_ford_asig_crm205_2u', '2026-07-14', '19:00'],
  ['ex_ford_asig_doc_gimenez_AGR_104_agro_1u', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_gimenez_AGR_105_agro_1u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_gimenez_AGR_204_agro_2u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_carmona_AGR_203_agro_2u', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_higuchi_COS_101_cosA_1a', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_rojas_COS_105_cosA_1a', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_valenz_COS_105_cosA_1b', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_espinola_COS_106_cosA_1b', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_carballo_COS_204_cosA_2u', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_carballo_COS_205_cosA_2u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_dominguez_CRM_104_crim_1u', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_dominguez_CRM_202_crim_2u', '2026-07-23', '19:00'],
  ['ex_ford_asig_doc_sharp_CRM_105_crim_1u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_dominguez_CRM_201_crim_2u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_mareco_ELC_204_elec_2u', '2026-07-09', '19:00'],
  ['ex_ford_asig_doc_mareco_ELC_205_elec_2u', '2026-07-16', '19:00'],
  ['ex_ford_asig_doc_jimenez_AGR_101_agro_1u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_jimenez_AGR_205_agro_2u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_jimenez_ELC_203_elec_2u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_perez_CON_102_cont_1u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_perez_CRM_102_crim_1u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_gimenez_CON_103_cont_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_espinola_COS_104_cosA_1a', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_torales_COS_201_cosA_2u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_aranda_CRM_204_crim_2u', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_romero_ENF_103_enf_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_romero_RAD_103_rad_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_carrillo_ENF_203_enf_2u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_carrillo_FAR_205_farm_2u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_villar_FAR_102_farm_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_villar_IQ_102_instr_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_gonzalez_IQ_204_instr_2u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_aranda_RAD_201_rad_2u', '2026-07-08', '19:00'],
  ['ex_ford_asig_cos102_cosA_1b', '2026-07-22', '19:00'],
  ['ex_ford_asig_doc_jimenez_CON_101_cont_1u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_jimenez_FAR_203_farm_2u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_higuchi_ENF_101_enf_1u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_higuchi_RAD_101_rad_1u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_ayala_a_ENF_104_enf_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_ayala_a_RAD_104_rad_1u', '2026-07-08', '19:00'],
  ['ex_ford_asig_doc_romero_ENF_201_enf_2u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_ayala_a_ENF_202_enf_2u', '2026-07-20', '19:00'],
  ['ex_ford_asig_doc_rojas_FAR_101_farm_1u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_rojas_IQ_101_instr_1u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_aranda_FAR_104_farm_1u', '2026-07-20', '19:00'],
  ['ex_ford_asig_doc_aranda_IQ_104_instr_1u', '2026-07-20', '19:00'],
  ['ex_ford_asig_doc_aranda_FAR_204_farm_2u', '2026-07-27', '19:00'],
  ['ex_ford_asig_doc_alum_IQ_201_instr_2u', '2026-07-13', '19:00'],
  ['ex_ford_asig_doc_rojas_IQ_202_instr_2u', '2026-07-20', '19:00'],
  ['ex_ford_asig_doc_higuchi_RAD_202_rad_2u', '2026-07-20', '19:00'],
  ['ex_ford_asig_doc_palacios_RAD_205_rad_2u', '2026-07-20', '19:00'],
  ];
  const updEx = db.prepare('UPDATE examenes SET fecha=?, hora=? WHERE id=?');
  let n = 0;
  fechaHoraFinalExamenes.forEach(([id, fecha, hora]) => { const r = updEx.run(fecha, hora, id); if (r.changes) n++; });
  console.log('[Migración] ' + n + ' exámenes finales con fecha/hora definitiva aplicada (v4) ✓');
} catch(e) { console.warn('[Migración] Reprogramación final examenes v4:', e.message); }

// ── MIGRACIÓN: Fusionar 2 duplicados detectados en planilla Event Registration ──
// Nataly Gabriela Areco Escobar y Rosana Sequeira Ferreira tenían 2 fichas cada
// una (mismo curso, misma fecha de ingreso, CI casi idéntica o vacía en un lado).
// A diferencia de fusiones anteriores, acá SÍ había notas con valores distintos
// cargadas en ambas fichas para la misma materia (dos docentes cargando notas
// sin saber que existía la otra ficha) — se conserva el puntaje MÁS ALTO de
// las dos en cada materia en conflicto, y se mueven todos los pagos sin perder
// ninguno.
try {
  function unificarMayorPuntaje(conservar_id, eliminar_id, etiqueta) {
    const conservar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(conservar_id);
    const eliminar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(eliminar_id);
    if (!conservar || !eliminar) return;
    db.pragma('foreign_keys = OFF');
    const campos = ['tp1','tp2','tp3','tp4','tp5','tp_total','parcial','parcial_recuperatorio','parcial_efectivo','final_ord','final_recuperatorio','complementario','extraordinario','final_efectivo','puntaje_total','nota_final','estado','director_pts'];
    const tx = db.transaction(() => {
      db.prepare('SELECT id FROM pagos WHERE alumno_id=?').all(eliminar_id).forEach(p => {
        db.prepare('UPDATE pagos SET alumno_id=? WHERE id=?').run(conservar_id, p.id);
      });
      db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(eliminar_id).forEach(ne => {
        const exist = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(conservar_id, ne.asignacion_id);
        if (!exist) {
          db.prepare('UPDATE notas SET alumno_id=? WHERE id=?').run(conservar_id, ne.id);
        } else {
          const pExist = exist.puntaje_total ?? -Infinity;
          const pNe = ne.puntaje_total ?? -Infinity;
          if (pNe > pExist) {
            const sets = campos.map(c => c+'=?').join(',');
            const vals = campos.map(c => ne[c]);
            db.prepare('UPDATE notas SET '+sets+' WHERE id=?').run(...vals, exist.id);
          }
          db.prepare('DELETE FROM notas WHERE id=?').run(ne.id);
        }
      });
      db.prepare('SELECT id, asignacion_id, fecha FROM asistencia WHERE alumno_id=?').all(eliminar_id).forEach(as => {
        const existeAsist = db.prepare('SELECT id FROM asistencia WHERE alumno_id=? AND asignacion_id=? AND fecha=?').get(conservar_id, as.asignacion_id, as.fecha);
        if (existeAsist) db.prepare('DELETE FROM asistencia WHERE id=?').run(as.id);
        else db.prepare('UPDATE asistencia SET alumno_id=? WHERE id=?').run(conservar_id, as.id);
      });
      db.prepare('UPDATE becas SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE habilitaciones_examen SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE constancias SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE qr_cambios SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      ['telefono','ci','matricula'].forEach(c => {
        if ((!conservar[c] || conservar[c]==='') && eliminar[c]) db.prepare('UPDATE alumnos SET '+c+'=? WHERE id=?').run(eliminar[c], conservar_id);
      });
      const pid = 'pap_'+Date.now()+'_dup_'+Math.random().toString(36).slice(2,6);
      const expira = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      db.prepare('INSERT OR IGNORE INTO papelera (id,tipo,nombre_display,datos_json,eliminado_por,expira_en) VALUES (?,?,?,?,?,?)')
        .run(pid, 'alumno_duplicado', `${eliminar.apellido||''}, ${eliminar.nombre||''} (duplicado unificado — ${etiqueta})`,
          JSON.stringify({ alumno: eliminar, motivo: 'unificacion_duplicados_migracion', conservar_id }), null, expira);
      db.prepare('DELETE FROM alumnos WHERE id=?').run(eliminar_id);
      if (eliminar.usuario_id && eliminar.usuario_id !== conservar.usuario_id) {
        db.prepare('DELETE FROM usuarios WHERE id=?').run(eliminar.usuario_id);
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    console.log(`[Migración] Duplicado unificado (${etiqueta}), notas en conflicto resueltas con el puntaje mas alto ✓`);
  }
  unificarMayorPuntaje('a_1778617099895_3cr', 'a_imp_59_ygee', 'Nataly Gabriela Areco Escobar');
  unificarMayorPuntaje('a_1778617162473_ger', 'a_1778617162536_ojn', 'Rosana Sequeira Ferreira');
} catch(e) { console.warn('[Migración] Unificar duplicados Event Registration:', e.message); }

// ── MIGRACIÓN: Bonus +5 puntos por participación en Desfile Estudiantil ──────
// El director otorgó 5 puntos (director_pts) a cada alumno que participó en
// el desfile, en TODAS las materias que cursa en el período activo. Lista de
// 74 alumnos verificada por nombre contra la planilla de registro (81 filas
// originales, con 7 duplicados de la misma persona colapsados a 1 cada uno).
// Se suma (no pisa) sobre cualquier director_pts previo, y se recalcula
// puntaje/nota/estado con la misma fórmula que usa el endpoint de notas.
// Guardado en `configuracion` para que no se vuelva a aplicar en cada reinicio.
try {
  const YA_APLICADO = db.prepare("SELECT valor FROM configuracion WHERE clave='bonus_desfile_2026_aplicado'").get();
  if (!YA_APLICADO) {
    const alumnosDesfile2026 = ["a_1778452927866_dr9","a_1778617099579_vew","a_1778617099706_lb1","a_1778617099390_kln","a_1780610085297","a_1778617098735_1k6","a_1779148835323","a_imp_56_l7qi","a_1778617161902_jwx","a_1780612058269","a_1778617098869_eho","a_1778617162409_v40","a_1778617099326_rvq","a_1779323444008","a_1778617100150_flp","a_imp_101_dwt4","a_imp_40_61j1","a_imp_30_q9bq","a_1778617098935_nnu","a_1778617099643_ify","a_1779323522518","a_imp_6_ic4m","a_1779297344722","a_1778443280611_4x2","a_1778443279925_42i","a_1778617100086_3kn","a_1778443319200_ed8","a_1778443319404_825","a_1779837025015","a_1778443319866_dld","a_1778443319937_kl7","a_1779837002464","a_1778443320280_ode","a_1778443321283_p1l","a_1778459547038_4iw","a_1778459545141_1n5","a_1778459546562_gnv","a_1778458751407_fhf","a_1778459545744_ovb","a_1779147457946","a_1778459546018_c0z","a_1778459547372_oy6","a_1778459547439_cm9","a_1778459545679_ye8","a_1778443398040_c39","a_1778443398178_ydt","a_1778443397972_9bd","a_1778443398244_sgv","a_1778443398314_b0s","a_1778443399141_nkq","a_1778443398798_3us","a_1778459610702_bv1","a_1778459610569_77v","a_1778459610176_xqt","a_1778459610308_ndi","a_1778459610902_8kr","a_1778446682387_d7v","a_1778446683502_h9r","a_1778446682454_f98","a_1778446682809_8s2","a_1778446682957_vju","a_1778446683370_dih","a_1778446682597_i4a","a_1778460586804_8ei","a_1778460585730_0vm","a_1778460586937_vzp","a_1778446814629_fnv","a_1778446813964_cw8","a_1778461784690_obp","a_1778446814694_0lm","a_1778446814500_j3e","a_1778617098803_hhs","a_1778443398453_o40","a_1778443320424_ijy"];
    const { calcularPuntaje } = require('./db');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (periodo) {
      const updNota = db.prepare('UPDATE notas SET director_pts=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
      let alumnosAfectados = 0, notasAfectadas = 0;
      alumnosDesfile2026.forEach(aid => {
        const notas = db.prepare('SELECT n.* FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id WHERE n.alumno_id=? AND a.periodo_id=?').all(aid, periodo.id);
        if (!notas.length) return;
        alumnosAfectados++;
        notas.forEach(n => {
          const nuevoDir = (n.director_pts||0) + 5;
          const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,nuevoDir);
          updNota.run(nuevoDir, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
          notasAfectadas++;
        });
      });
      db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('bonus_desfile_2026_aplicado','1','Bonus +5pts Desfile Estudiantil 2026 ya aplicado')").run();
      console.log(`[Migración] Bonus Desfile Estudiantil: +5pts aplicado a ${alumnosAfectados} alumnos (${notasAfectadas} notas) ✓`);
    }
  }
} catch(e) { console.warn('[Migración] Bonus Desfile Estudiantil:', e.message); }

// ── MIGRACIÓN: Bonus +5 puntos — nuevos registros Desfile Estudiantil (planilla 2) ──
// Segunda planilla "Nuevos_Alumnos_Desfile.xlsx" (20 filas, ninguna duplicada dentro
// de la propia planilla). Cruce por nombre contra snapshot fresco de producción:
// coincidencia exacta o por solapamiento de palabras + carrera/año consistente para
// las 20. Igual que el bonus anterior: se suma (no pisa) sobre cualquier director_pts
// previo -- varios de estos alumnos ya tenían +5 del bonus anterior y quedan en 10 -- ,
// se aplica a TODAS las materias que cursa en el período activo, y se recalcula
// puntaje/nota/estado con la misma fórmula que usa el endpoint de notas.
try {
  const YA_APLICADO = db.prepare("SELECT valor FROM configuracion WHERE clave='bonus_desfile_2026_nuevos_aplicado'").get();
  if (!YA_APLICADO) {
    const alumnosDesfileNuevos2026 = ["a_1778443319486_ejq","a_imp_103_0klo","a_1778443282335_g10","a_1778458751341_g61","a_1778458751204_apl","a_1778545299094","a_1779834475495","a_1778458751141_6ue","a_1778458752457_bhp","a_1778458752853_ue0","a_1778458751602_gg6","a_1779834471242","a_1778458752721_kbn","a_1778458752523_ast","a_1778458751006_376","a_1778458752261_jo3","a_1779834464558","a_1778458752131_ro1","a_1778458751800_y7v","a_1778458752653_17v"];
    const { calcularPuntaje } = require('./db');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (periodo) {
      const updNota = db.prepare('UPDATE notas SET director_pts=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
      let alumnosAfectados = 0, notasAfectadas = 0;
      alumnosDesfileNuevos2026.forEach(aid => {
        const notas = db.prepare('SELECT n.* FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id WHERE n.alumno_id=? AND a.periodo_id=?').all(aid, periodo.id);
        if (!notas.length) return;
        alumnosAfectados++;
        notas.forEach(n => {
          const nuevoDir = (n.director_pts||0) + 5;
          const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,nuevoDir);
          updNota.run(nuevoDir, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
          notasAfectadas++;
        });
      });
      db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('bonus_desfile_2026_nuevos_aplicado','1','Bonus +5pts Desfile Estudiantil (planilla nuevos registros) ya aplicado')").run();
      console.log(`[Migración] Bonus Desfile Estudiantil (nuevos): +5pts aplicado a ${alumnosAfectados} alumnos (${notasAfectadas} notas) ✓`);
    }
  }
} catch(e) { console.warn('[Migración] Bonus Desfile Estudiantil (nuevos):', e.message); }

// ── MIGRACIÓN: Bonus +5 puntos por participación en Event Registration ───────
// Segunda planilla de participación (277 registros originales, 78 ya marcados
// duplicados por la propia planilla). Cruce por nombre contra la base real:
// 144 coincidencias exactas, 48 resueltas por nombre parecido (descartado 1
// falso positivo), 2 fusionadas como duplicados reales de la misma alumna
// (con conflicto de notas, resuelto con el puntaje mas alto de las dos), y 3
// sin resolver (se excluyen del bonus, a pedido del director). Total: 190
// alumnos unicos. Se suma +5 (no pisa) sobre cualquier director_pts previo,
// con tope duro de 10 (45 de estos alumnos ya tenian +5 del Desfile Estudiantil
// y quedan exactamente en 10). Guardado en `configuracion` para no reaplicarse.
try {
  const YA_APLICADO2 = db.prepare("SELECT valor FROM configuracion WHERE clave='bonus_event_registration_2026_aplicado'").get();
  if (!YA_APLICADO2) {
    const alumnosEventReg2026 = ["a_1778452926661_9xy","a_1778452926795_z3w","a_1778452927866_dr9","a_1778452926931_2aj","a_1778443223309_f35","a_1778452927734_p6r","a_1778443222745_o3m","a_1778443222962_y9s","a_1779406623599","a_1778458689045_4kr","a_1778458688300_76g","a_1778458688577_zar","a_1778443279992_n67","a_imp_0_a4l6","a_imp_2_nqpz","a_imp_93_gjw1","a_1778617162219_wwp","a_1778617162728_962","a_imp_6_ic4m","a_1778617162663_s5h","a_1778617100086_3kn","a_1778617099579_vew","a_1778617161839_00i","a_imp_65_xcbc","a_1778443280195_291","a_1778617098735_1k6","a_1778617162791_8yy","a_imp_9_twnl","a_imp_12_c9rl","a_1779148835323","a_1778628627552","a_imp_18_0yrl","a_imp_20_wtsk","a_1778460585465_8vz","a_1778617162283_w4f","a_imp_62_fbgf","a_imp_121_wfdu","a_1780612058269","a_1778617098594_gkd","a_1778617099326_rvq","a_1778617162918_ha9","a_1778617100150_flp","a_imp_30_q9bq","a_1779297439905","a_1778617098935_nnu","a_1778617099643_ify","a_imp_48_yhxs","a_1778443281726_7uc","a_imp_37_ruxu","a_1778617099133_d07","a_imp_53_8f5f","a_1778617161775_gsp","a_1779149063617","a_1778443280544_tp1","a_1778443280748_b0q","a_1781047343332","a_1778443282198_ay0","a_1778443281379_7ti","a_1778458752721_kbn","a_1778443320730_85x","a_1779834464558","a_1778443319591_2q3","a_1778458752261_jo3","a_1778458751341_g61","a_1778443319937_kl7","a_1778458751602_gg6","a_1778443320003_gfv","a_1778458752653_17v","a_1778443320932_hxw","a_1778443321420_a8c","a_1778458752457_bhp","a_1778458752063_gz5","a_1778458752131_ro1","a_1778545299094","a_1778443319338_2c4","a_1778443319486_ejq","a_1778443319866_dld","a_1779837002464","a_1778443320143_lvk","a_1778443320280_ode","a_1778459547239_e8h","a_1778459545076_ffw","a_1778459548244_t3f","a_1778459546562_gnv","a_1780447201734","a_1778459548176_wdf","a_1778459545679_ye8","a_1778443397972_9bd","a_1778459545744_ovb","a_1778459547707_gi5","a_1778459548110_607","a_1778459546632_xuz","a_1778459545882_e8q","a_1778459546358_fne","a_1778459546290_bzt","a_1780447195052","a_1778459547372_oy6","a_1778459610308_ndi","a_1778459547439_cm9","a_1778459610504_mrv","a_1778459547774_3w0","a_1778443399074_6u4","a_1778458688773_bnp","a_1778459547505_av5","a_1778443398178_ydt","a_1778443398314_b0s","a_1778443398798_3us","a_1778459611103_bu3","a_1778459609780_f4n","a_1778459609911_gb5","a_1778459609978_dgo","a_1778459610638_ar1","a_1778459610702_bv1","a_1778460281546_j83","a_1778459610569_77v","a_1778459610243_gpv","a_1778459610902_8kr","a_1778446682597_i4a","a_1778446788139_4aq","a_1778460587396_kh0","a_1778446787067_5jp","a_1778460586804_8ei","a_1778446788006_ass","a_1778460586407_3nh","a_1778446787342_g7b","a_1779150367342","a_1778446787940_ycb","a_1778446787001_nei","a_1778446788208_zoj","a_1778459544942_x25","a_1778446813360_jr6","a_1778446813565_mwp","a_1778461784625_m8j","a_1778446814694_0lm","a_1778446813833_scy","a_1778461784690_obp","a_1778896860362","a_1779840722704","a_1778446814167_1hw","a_1778446814500_j3e","a_1778446814828_0ue","a_1778896866597","a_1778630286039","a_1778617099959_ycf","a_1778617099706_lb1","a_1778443280680_a6r","a_imp_110_7wyz","a_1778617162346_ikw","a_imp_56_l7qi","a_imp_15_r4nw","a_1778617161902_jwx","a_imp_26_fu8e","a_imp_101_dwt4","a_imp_40_61j1","a_imp_35_k46t","a_imp_136_t2sp","a_imp_129_jxb5","a_1778617162536_foq","a_1778443281243_8en","a_1778617161518_mid","a_1778628770151","a_1778443280337_0bh","a_1779297405103","a_1778458751141_6ue","a_1779837025015","a_1779400841764","a_1778443320576_eke","a_1778459547038_4iw","a_1778459545009_rra","a_1778443397698_x6c","a_1780447993090","a_1778459546018_c0z","a_1778443397769_pbs","a_1780358785664","a_1778443399007_13q","a_1778459610440_yhs","a_1778459610176_xqt","a_1778459611039_cqc","a_1778446787137_7de","a_1778460586474_5fg","a_1778460586937_vzp","a_1778446787544_uhz","a_1778446813631_1tj","a_1778896864098","a_1778461784287_1id","a_1778461783548_vpu","a_1778446813964_cw8","a_1778446814761_ep1","a_1778617099895_3cr","a_1778617162473_ger"];
    const { calcularPuntaje } = require('./db');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (periodo) {
      const updNota = db.prepare('UPDATE notas SET director_pts=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
      let alumnosAfectados2 = 0, notasAfectadas2 = 0;
      alumnosEventReg2026.forEach(aid => {
        const notas = db.prepare('SELECT n.* FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id WHERE n.alumno_id=? AND a.periodo_id=?').all(aid, periodo.id);
        if (!notas.length) return;
        alumnosAfectados2++;
        notas.forEach(n => {
          let nuevoDir = (n.director_pts||0) + 5;
          if (nuevoDir > 10) nuevoDir = 10;
          const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,nuevoDir);
          updNota.run(nuevoDir, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
          notasAfectadas2++;
        });
      });
      db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('bonus_event_registration_2026_aplicado','1','Bonus +5pts Event Registration 2026 ya aplicado')").run();
      console.log(`[Migración] Bonus Event Registration: +5pts aplicado a ${alumnosAfectados2} alumnos (${notasAfectadas2} notas) ✓`);
    }
  }
} catch(e) { console.warn('[Migración] Bonus Event Registration:', e.message); }

// ── MIGRACIÓN: Bonus general +2 puntos de dirección para todos los alumnos ───
// Pedido del director: a todo alumno Activo que aún no tenga el tope de 10
// director_pts en una materia (del período activo), sumarle +2 (no pisa el
// valor previo — varios ya tienen 5 o 10 de los bonus de Desfile/Event
// Registration y sencillamente no reciben más si ya están en 10). Tope duro
// en 10. Se aplica a todas las materias que cursa cada alumno en el período
// activo. Guardado en `configuracion` para no reaplicarse en cada reinicio.
try {
  const YA_APLICADO3 = db.prepare("SELECT valor FROM configuracion WHERE clave='bonus_dir_pts_general_2_2026_07_aplicado'").get();
  if (!YA_APLICADO3) {
    const { calcularPuntaje } = require('./db');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (periodo) {
      const notasPendientes = db.prepare(`
        SELECT n.* FROM notas n
        JOIN asignaciones a ON n.asignacion_id = a.id
        JOIN alumnos al ON n.alumno_id = al.id
        WHERE a.periodo_id = ? AND al.estado = 'Activo' AND COALESCE(n.director_pts,0) < 10
      `).all(periodo.id);
      const updNota = db.prepare('UPDATE notas SET director_pts=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
      const alumnosAfectados3 = new Set();
      notasPendientes.forEach(n => {
        let nuevoDir = (n.director_pts||0) + 2;
        if (nuevoDir > 10) nuevoDir = 10;
        const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,nuevoDir);
        updNota.run(nuevoDir, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
        alumnosAfectados3.add(n.alumno_id);
      });
      db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('bonus_dir_pts_general_2_2026_07_aplicado','1','Bonus general +2pts dirección (todos los alumnos activos bajo el tope de 10) ya aplicado')").run();
      console.log(`[Migración] Bonus general +2pts dirección: aplicado a ${alumnosAfectados3.size} alumnos (${notasPendientes.length} notas) ✓`);
    }
  }
} catch(e) { console.warn('[Migración] Bonus general +2pts dirección:', e.message); }

// ── MIGRACIÓN: Bonus +5 puntos — Andreia Micheli Ozuna Sanches (Instrumentación Quirúrgica 2°) ──
// Pedido puntual del director. Se busca por nombre (normalizado, sin acentos)
// dentro de la carrera Instrumentación Quirúrgica ('instr'), curso 2° año, para
// no depender de un id hardcodeado. Se suma (no pisa) sobre cualquier
// director_pts previo, tope duro en 10, aplicado a todas las materias que
// cursa en el período activo.
try {
  const YA_APLICADO4 = db.prepare("SELECT valor FROM configuracion WHERE clave='bonus_dir_pts_ozuna_sanches_5_2026_07_aplicado'").get();
  if (!YA_APLICADO4) {
    const norm = s => (s||'').toString().normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
    const objetivoTokens = norm('Andreia Micheli Ozuna Sanches').split(/\s+/).filter(Boolean);
    const candidatas = db.prepare(`
      SELECT al.id, al.nombre, al.apellido FROM alumnos al
      JOIN cursos cu ON al.curso_id = cu.id
      WHERE al.carrera_id='instr' AND cu.anio=2
    `).all();
    const match = candidatas.find(al => {
      const tokensAl = norm(`${al.nombre||''} ${al.apellido||''}`).split(/\s+/).filter(Boolean);
      return objetivoTokens.every(t => tokensAl.includes(t));
    });
    if (match) {
      const { calcularPuntaje } = require('./db');
      const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
      if (periodo) {
        const notas = db.prepare('SELECT n.* FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id WHERE n.alumno_id=? AND a.periodo_id=?').all(match.id, periodo.id);
        const updNota = db.prepare('UPDATE notas SET director_pts=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
        notas.forEach(n => {
          let nuevoDir = (n.director_pts||0) + 5;
          if (nuevoDir > 10) nuevoDir = 10;
          const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,nuevoDir);
          updNota.run(nuevoDir, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
        });
        db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('bonus_dir_pts_ozuna_sanches_5_2026_07_aplicado','1','Bonus +5pts dirección — Andreia Micheli Ozuna Sanches (Instrumentación Quirúrgica 2°) ya aplicado')").run();
        console.log(`[Migración] Bonus +5pts dirección: aplicado a ${match.apellido}, ${match.nombre} (${notas.length} notas) ✓`);
      }
    } else {
      console.warn('[Migración] Bonus +5pts Ozuna Sanches: no se encontró alumna con ese nombre en Instrumentación Quirúrgica 2° año — revisar manualmente');
    }
  }
} catch(e) { console.warn('[Migración] Bonus +5pts Ozuna Sanches:', e.message); }

// ── MIGRACIÓN: Corregir escala de notas (tabla de referencia) ────────────────
// La tabla `escala_notas` (solo de referencia/visualización — el cálculo real
// de la nota ya usa estos cortes en calcularPuntaje(), ver db.js) tenía valores
// por defecto desactualizados (60-69.99=2, 70-79.99=3, etc.) que no coincidían
// con la lógica real. El director confirmó la escala correcta: 1=0-69
// Reprobado, 2=70-77, 3=78-85, 4=86-93, 5=94-100.
try {
  const YA_APLICADA_ESC = db.prepare("SELECT valor FROM configuracion WHERE clave='escala_notas_corregida_2026_07'").get();
  if (!YA_APLICADA_ESC) {
    const updEsc = db.prepare('UPDATE escala_notas SET puntaje_min=?, puntaje_max=? WHERE nota=?');
    updEsc.run(0,  69.99, 1);
    updEsc.run(70, 77.99, 2);
    updEsc.run(78, 85.99, 3);
    updEsc.run(86, 93.99, 4);
    updEsc.run(94, 100,   5);
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('escala_notas_corregida_2026_07','1','Escala de notas corregida para coincidir con calcularPuntaje(): 1=0-69, 2=70-77, 3=78-85, 4=86-93, 5=94-100')").run();
    console.log('[Migración] Escala de notas corregida (1:0-69 / 2:70-77 / 3:78-85 / 4:86-93 / 5:94-100) ✓');
  }
} catch(e) { console.warn('[Migración] Escala de notas:', e.message); }

// ── MIGRACIÓN: Restaurar nota perdida — Dermatología Básica (bug #3, oninput) ──
// Detectado por el aviso "Posible pérdida de nota" del 2026-07-17 20:42:46 —
// el docente Carballo tenía cargado final_ord=4 y quedó vacío. Confirmado
// contra snapshot que sigue en NULL en producción (no se autocorrigió como los
// demás casos del mismo día). Se restaura solo si sigue en NULL (no pisa un
// valor real distinto que el docente haya cargado después).
try {
  const YA_APLICADA_REST1 = db.prepare("SELECT valor FROM configuracion WHERE clave='restaura_nota_dermato_azrt_2026_07_17'").get();
  if (!YA_APLICADA_REST1) {
    const { calcularPuntaje } = require('./db');
    const n = db.prepare("SELECT * FROM notas WHERE alumno_id='a_imp_22_azrt' AND asignacion_id='asig_cos107_1b'").get();
    if (n && n.final_ord === null) {
      const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,4,n.final_recuperatorio,n.complementario,n.extraordinario,n.director_pts);
      db.prepare('UPDATE notas SET final_ord=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?')
        .run(4, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
      console.log('[Migración] Restaurada nota perdida — Dermatología Básica (final_ord=4) ✓');
    }
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('restaura_nota_dermato_azrt_2026_07_17','1','Restauración puntual final_ord=4 perdido el 2026-07-17')").run();
  }
} catch(e) { console.warn('[Migración] Restaurar nota Dermatología:', e.message); }

// ── MIGRACIÓN: Restaurar 10 "parcial" perdidos por el bug #2 (barrido incompleto) ──
// El primer barrido (commit 85dac0b, 66 casos) no cubrió estos 10: reconstruidos
// cruzando TODO el historial de auditoría (UPDATE_NOTA) contra el estado actual —
// se toma el último valor real de "parcial" que existía justo antes de un guardado
// que lo omitió (el patrón exacto del bug #2), y se confirma que sigue en NULL
// ahora mismo (si alguien lo volvió a cargar con un valor real después, no se toca).
// 6 de los 10 son de Anatomía y Fisiología Humana (Enfermería 1°, docente Higuchi) —
// coincide con el reporte de alumnos de esa materia el 2026-07-17.
try {
  const YA_APLICADA_REST2 = db.prepare("SELECT valor FROM configuracion WHERE clave='restaura_parcial_barrido2_2026_07_17'").get();
  if (!YA_APLICADA_REST2) {
    const { calcularPuntaje } = require('./db');
    const casos = [
      ['a_imp_121_wfdu', 'asig_doc_higuchi_COS_101_cosA_1b', 10],
      ['a_1778617162473_ger', 'asig_doc_higuchi_COS_101_cosA_1b', 17],
      ['a_imp_12_c9rl', 'asig_doc_higuchi_COS_101_cosA_1b', 20],
      ['a_1778443281792_aby', 'asig_doc_carballo_COS_205_cosA_2u', 19],
      ['a_1778458688773_bnp', 'asig_doc_higuchi_ENF_101_enf_1u', 13],
      ['a_1778459545141_1n5', 'asig_doc_higuchi_ENF_101_enf_1u', 20],
      ['a_1778459545406_7nv', 'asig_doc_higuchi_ENF_101_enf_1u', 10],
      ['a_1778459545608_tac', 'asig_doc_higuchi_ENF_101_enf_1u', 9],
      ['a_1778459545744_ovb', 'asig_doc_higuchi_ENF_101_enf_1u', 16],
      ['a_1778459545076_ffw', 'asig_doc_higuchi_ENF_101_enf_1u', 19],
    ];
    const updNota = db.prepare('UPDATE notas SET parcial=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
    let restaurados = 0;
    casos.forEach(([alumnoId, asigId, valor]) => {
      const n = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(alumnoId, asigId);
      if (n && n.parcial === null) {
        const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,valor,n.parcial_recuperatorio,n.final_ord,n.final_recuperatorio,n.complementario,n.extraordinario,n.director_pts);
        updNota.run(valor, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
        restaurados++;
      }
    });
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('restaura_parcial_barrido2_2026_07_17','1','Segundo barrido: 10 valores de parcial perdidos por bug #2 que el primer barrido no cubrió')").run();
    console.log(`[Migración] Segundo barrido bug #2: ${restaurados}/10 valores de parcial restaurados ✓`);
  }
} catch(e) { console.warn('[Migración] Segundo barrido bug #2:', e.message); }

// ── MIGRACIÓN: Restaurar 2 final_ord perdidos — Anatomía y Fisiología Humana ──
// Detectados por los avisos "Posible pérdida de nota" del 2026-07-20 21:55.
// Confirmado contra snapshot que ambos siguen en NULL (los otros dos avisos del
// mismo lote — Romero Cortaza y Arroquia Martinez Rosa — ya se autocorrigieron
// solos, no necesitan restauración). La materia real es la de Farmacia
// (asig_doc_rojas_FAR_101_farm_1u) — hay varias asignaciones distintas con el
// mismo nombre "Anatomía y Fisiología Humana" en otras carreras.
try {
  const YA_APLICADA_REST3 = db.prepare("SELECT valor FROM configuracion WHERE clave='restaura_final_ord_anatomia_farm_2026_07_20'").get();
  if (!YA_APLICADA_REST3) {
    const { calcularPuntaje } = require('./db');
    const casos = [
      ['a_1779150423136',    'asig_doc_rojas_FAR_101_farm_1u', 50],
      ['a_1778459610107_f7p','asig_doc_rojas_FAR_101_farm_1u', 50],
    ];
    const updNota = db.prepare('UPDATE notas SET final_ord=?, tp_total=?, puntaje_total=?, nota_final=?, estado=?, parcial_efectivo=?, final_efectivo=? WHERE id=?');
    let restaurados3 = 0;
    casos.forEach(([alumnoId, asigId, valor]) => {
      const n = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(alumnoId, asigId);
      if (n && n.final_ord === null) {
        const r = calcularPuntaje(n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.parcial,n.parcial_recuperatorio,valor,n.final_recuperatorio,n.complementario,n.extraordinario,n.director_pts);
        updNota.run(valor, r.tp_total, r.puntaje, r.nota, r.estado, r.parcial_ef, r.final_ef, n.id);
        restaurados3++;
      }
    });
    db.prepare("INSERT INTO configuracion (clave,valor,descripcion) VALUES ('restaura_final_ord_anatomia_farm_2026_07_20','1','Restaura 2 final_ord=50 perdidos en Anatomía y Fisiología Humana (Farmacia, Rojas)')").run();
    console.log(`[Migración] Restaurados ${restaurados3}/2 final_ord — Anatomía y Fisiología Humana (Farmacia) ✓`);
  }
} catch(e) { console.warn('[Migración] Restaurar final_ord Anatomía Farmacia:', e.message); }

// ── MIGRACIÓN: Mover examen de Primeros Auxilios (Micheli Romero) al 15/07 ────
// Pedido puntual del director. Respeta el día de clase real (miércoles).
try {
  const upd = db.prepare("UPDATE examenes SET fecha='2026-07-15' WHERE id=?");
  let n = 0;
  ['ex_ford_asig_doc_romero_ENF_103_enf_1u','ex_ford_asig_doc_romero_RAD_103_rad_1u'].forEach(id => { const r = upd.run(id); if (r.changes) n++; });
  if (n) console.log(`[Migración] Primeros Auxilios (Romero) movido al 15/07 ✓ (${n} registros)`);
} catch(e) { console.warn('[Migración] Mover Primeros Auxilios Romero:', e.message); }

// ── MIGRACIÓN: Limpiar avisos de "Chequeo de integridad" ya generados ─────────
// El chequeo nocturno de integridad dejó de crear avisos visibles en el inicio
// (pedido del director, pantalla muy cargada — sigue registrado en auditoría).
// Esto borra los avisos de ese tipo que ya se habían generado en noches previas
// y que seguían apareciendo en Inicio y en Avisos aunque el código ya no los cree.
try {
  const r = db.prepare("DELETE FROM avisos WHERE id LIKE 'av_integ_%' OR titulo LIKE '🔍 Chequeo de integridad%'").run();
  if (r.changes) console.log(`[Migración] ${r.changes} aviso(s) de chequeo de integridad eliminado(s) ✓`);
} catch(e) { console.warn('[Migración] Limpiar avisos de integridad:', e.message); }

// ── MIGRACIÓN: Mover examen de Física Radiológica (Paulo Higuchi) al 15/07 ────
// Pedido puntual del director, EXCEPCIÓN explícita a la regla de día-de-clase:
// la materia se cursa los lunes, pero el 13/07 (lunes más cercano) Higuchi ya
// tenía 2 exámenes a las 19:00 (Anatomía y Fisiología Humana, Enfermería y
// Radiología) y el director prefirió el miércoles 15/07 antes que esperar al
// lunes 27/07. Verificado sin choque de aula/docente a esa hora (los únicos
// otros exámenes del 15/07 19:00 son de Romero, materia y año distintos).
try {
  const r = db.prepare("UPDATE examenes SET fecha='2026-07-15' WHERE id='ex_ford_asig_doc_higuchi_RAD_202_rad_2u'").run();
  if (r.changes) console.log('[Migración] Física Radiológica (Higuchi) movido al 15/07 — excepción día de clase ✓');
} catch(e) { console.warn('[Migración] Mover Física Radiológica Higuchi:', e.message); }

// ── MIGRACIÓN (CORREGIDA): Fusionar ficha duplicada de Sindy Recalde Pereira ──
// Diagnóstico real: existen DOS fichas de la misma alumna.
//   a_1778458688706_zbr (CON-2026-007, CI 6690171) — la ficha "vieja": tiene las
//     5 habilitaciones de Parcial Recuperatorio y los 9 pagos, pero estaba marcada
//     Inactivo y sus notas están vacías (nunca se cargó nada ahí).
//   a_1781566133474 (CON-2026-014, sin CI) — ficha duplicada creada después:
//     Activa, y es la que los docentes vienen usando de hecho (tiene notas reales
//     cargadas y asistencia), pero no tiene ninguna habilitación ni pago.
// Un intento anterior de este mismo fix reactivó por error la ficha vieja (vacía),
// lo que la hizo aparecer como una segunda fila en blanco junto a la ficha real
// — de ahí el reporte de "se borraron las notas" (no se borró nada, era la ficha
// vieja duplicada que se volvió visible). Este fix mueve habilitaciones y pagos
// a la ficha activa real y vuelve a ocultar la duplicada.
try {
  const oldId = 'a_1778458688706_zbr';
  const newId = 'a_1781566133474';
  const oldEx = db.prepare('SELECT id FROM alumnos WHERE id=?').get(oldId);
  const newEx = db.prepare('SELECT id FROM alumnos WHERE id=?').get(newId);
  if (oldEx && newEx) {
    const hMoved = db.prepare('UPDATE habilitaciones_examen SET alumno_id=? WHERE alumno_id=?').run(newId, oldId).changes;
    const pMoved = db.prepare('UPDATE pagos SET alumno_id=? WHERE alumno_id=?').run(newId, oldId).changes;
    db.prepare("UPDATE alumnos SET ci=? WHERE id=? AND (ci IS NULL OR ci='')").run('6690171', newId);
    db.prepare("UPDATE alumnos SET estado='Inactivo' WHERE id=?").run(oldId);
    console.log(`[Migración] Fusión ficha duplicada Sindy Recalde Pereira: ${hMoved} habilitaciones + ${pMoved} pagos movidos a la ficha activa ✓`);
  }
} catch(e) { console.warn('[Migración] Fusión duplicado Sindy:', e.message); }

// ── MIGRACIÓN: Unificar duplicados detectados en "Limpieza > Duplicados" ─────
// Casos SIN conflicto de datos (mismo curso, o sin notas/materias solapadas):
//   Roman Barreto, Luz Dahiana (RAD-2026-037 vs ALU-2026-002, mismo pago cargado 2 veces)
//   Fretes, Mabel Ibarra (IQ-2026-050 con pago vs RAD-2026-031 vacía, CI con 1 dígito faltante)
//   Mancuello Villalba, Lidia Rosa (COS-2026-036 vs COS-2026-109, CI con typo de 1 dígito,
//     mismo curso, notas en materias distintas sin solapar — no hay pérdida de datos)
// Usa la misma lógica que POST /api/alumnos/unificar (mueve pagos/notas/asistencia/becas/
// habilitaciones/constancias, fusiona campos vacíos, y guarda la eliminada en papelera 10 días
// por si hay que revertir). Casos con conflicto real de datos (notas distintas en la misma
// materia, o carreras/cursos distintos con datos en ambas) NO se tocan — quedan para que el
// director decida manualmente desde el panel.
try {
  function unificarAlumnos(conservar_id, eliminar_id, etiqueta) {
    const conservar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(conservar_id);
    const eliminar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(eliminar_id);
    if (!conservar || !eliminar) return;
    db.pragma('foreign_keys = OFF');
    const unif = db.transaction(() => {
      db.prepare('SELECT id FROM pagos WHERE alumno_id=?').all(eliminar_id).forEach(p => {
        db.prepare('UPDATE pagos SET alumno_id=? WHERE id=?').run(conservar_id, p.id);
      });
      db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(eliminar_id).forEach(ne => {
        const exist = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(conservar_id, ne.asignacion_id);
        if (!exist) {
          db.prepare('UPDATE notas SET alumno_id=? WHERE id=?').run(conservar_id, ne.id);
        } else {
          const campos = ['tp1','tp2','tp3','tp4','tp5','tp_total','parcial','parcial_recuperatorio','parcial_efectivo','final_ord','final_recuperatorio','complementario','extraordinario','final_efectivo','puntaje_total','nota_final','director_pts'];
          const sets = campos.filter(c => (exist[c]==null||exist[c]==='') && ne[c]!=null && ne[c]!=='').map(c => `${c}=${ne[c]}`);
          if (sets.length) db.prepare(`UPDATE notas SET ${sets.join(',')} WHERE id=?`).run(exist.id);
          db.prepare('DELETE FROM notas WHERE id=?').run(ne.id);
        }
      });
      db.prepare('SELECT id, asignacion_id, fecha FROM asistencia WHERE alumno_id=?').all(eliminar_id).forEach(as => {
        const existeAsist = db.prepare('SELECT id FROM asistencia WHERE alumno_id=? AND asignacion_id=? AND fecha=?').get(conservar_id, as.asignacion_id, as.fecha);
        if (existeAsist) db.prepare('DELETE FROM asistencia WHERE id=?').run(as.id);
        else db.prepare('UPDATE asistencia SET alumno_id=? WHERE id=?').run(conservar_id, as.id);
      });
      db.prepare('UPDATE becas SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE habilitaciones_examen SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE constancias SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE qr_cambios SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      ['telefono','ci','matricula'].forEach(c => {
        if ((!conservar[c] || conservar[c]==='') && eliminar[c]) db.prepare(`UPDATE alumnos SET ${c}=? WHERE id=?`).run(eliminar[c], conservar_id);
      });
      const pid = 'pap_'+Date.now()+'_dup_'+Math.random().toString(36).slice(2,6);
      const expira = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      db.prepare('INSERT OR IGNORE INTO papelera (id,tipo,nombre_display,datos_json,eliminado_por,expira_en) VALUES (?,?,?,?,?,?)')
        .run(pid, 'alumno_duplicado', `${eliminar.apellido||''}, ${eliminar.nombre||''} (duplicado unificado — ${etiqueta})`,
          JSON.stringify({ alumno: eliminar, motivo: 'unificacion_duplicados_migracion', conservar_id }), null, expira);
      db.prepare('DELETE FROM alumnos WHERE id=?').run(eliminar_id);
      if (eliminar.usuario_id && eliminar.usuario_id !== conservar.usuario_id) {
        db.prepare('DELETE FROM usuarios WHERE id=?').run(eliminar.usuario_id);
      }
    });
    unif();
    db.pragma('foreign_keys = ON');
    console.log(`[Migración] Duplicado unificado (${etiqueta}): conservado ${conservar_id}, eliminado ${eliminar_id} ✓`);
  }
  unificarAlumnos('a_1778461783884_hi9', 'a_1778628769891', 'Roman Barreto, Luz Dahiana');
  unificarAlumnos('a_1778460587065_ofo', 'a_1778461783463_wz3', 'Fretes, Mabel Ibarra');
  unificarAlumnos('a_1778443282198_ay0', 'a_1781047048561', 'Mancuello Villalba, Lidia Rosa');
} catch(e) { console.warn('[Migración] Unificar duplicados:', e.message); }

// ── MIGRACIÓN: Unificar duplicados restantes (decisión del director) ─────────
//   Cano Mora, Camili Mariel: conservar RAD-2026-041 (4 materias con nota vs 3,
//     y ya tiene la nota más alta de "Salud Pública" (19 vs 10) — la fusión no
//     sobreescribe valores existentes, así que el 19 queda intacto).
//   Vergara Vega, Helen Diana: conservar la ficha de Cosmiatría (6 materias con
//     nota); se mueven también los 3 pagos que estaban en la ficha de
//     Instrumentación Quirúrgica.
//   Martinez Ribas, Rene Matias: conservar Farmacia 1° (5 materias con nota vs 0);
//     se mueven también los pagos de la ficha de Farmacia 2°.
try {
  function unificarAlumnos2(conservar_id, eliminar_id, etiqueta) {
    const conservar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(conservar_id);
    const eliminar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(eliminar_id);
    if (!conservar || !eliminar) return;
    db.pragma('foreign_keys = OFF');
    const unif = db.transaction(() => {
      db.prepare('SELECT id FROM pagos WHERE alumno_id=?').all(eliminar_id).forEach(p => {
        db.prepare('UPDATE pagos SET alumno_id=? WHERE id=?').run(conservar_id, p.id);
      });
      db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(eliminar_id).forEach(ne => {
        const exist = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(conservar_id, ne.asignacion_id);
        if (!exist) {
          db.prepare('UPDATE notas SET alumno_id=? WHERE id=?').run(conservar_id, ne.id);
        } else {
          const campos = ['tp1','tp2','tp3','tp4','tp5','tp_total','parcial','parcial_recuperatorio','parcial_efectivo','final_ord','final_recuperatorio','complementario','extraordinario','final_efectivo','puntaje_total','nota_final','director_pts'];
          const sets = campos.filter(c => (exist[c]==null||exist[c]==='') && ne[c]!=null && ne[c]!=='').map(c => `${c}=${ne[c]}`);
          if (sets.length) db.prepare(`UPDATE notas SET ${sets.join(',')} WHERE id=?`).run(exist.id);
          db.prepare('DELETE FROM notas WHERE id=?').run(ne.id);
        }
      });
      db.prepare('SELECT id, asignacion_id, fecha FROM asistencia WHERE alumno_id=?').all(eliminar_id).forEach(as => {
        const existeAsist = db.prepare('SELECT id FROM asistencia WHERE alumno_id=? AND asignacion_id=? AND fecha=?').get(conservar_id, as.asignacion_id, as.fecha);
        if (existeAsist) db.prepare('DELETE FROM asistencia WHERE id=?').run(as.id);
        else db.prepare('UPDATE asistencia SET alumno_id=? WHERE id=?').run(conservar_id, as.id);
      });
      db.prepare('UPDATE becas SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE habilitaciones_examen SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE constancias SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE qr_cambios SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      ['telefono','ci','matricula'].forEach(c => {
        if ((!conservar[c] || conservar[c]==='') && eliminar[c]) db.prepare(`UPDATE alumnos SET ${c}=? WHERE id=?`).run(eliminar[c], conservar_id);
      });
      const pid = 'pap_'+Date.now()+'_dup_'+Math.random().toString(36).slice(2,6);
      const expira = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      db.prepare('INSERT OR IGNORE INTO papelera (id,tipo,nombre_display,datos_json,eliminado_por,expira_en) VALUES (?,?,?,?,?,?)')
        .run(pid, 'alumno_duplicado', `${eliminar.apellido||''}, ${eliminar.nombre||''} (duplicado unificado — ${etiqueta})`,
          JSON.stringify({ alumno: eliminar, motivo: 'unificacion_duplicados_migracion', conservar_id }), null, expira);
      db.prepare('DELETE FROM alumnos WHERE id=?').run(eliminar_id);
      if (eliminar.usuario_id && eliminar.usuario_id !== conservar.usuario_id) {
        db.prepare('DELETE FROM usuarios WHERE id=?').run(eliminar.usuario_id);
      }
    });
    unif();
    db.pragma('foreign_keys = ON');
    console.log(`[Migración] Duplicado unificado (${etiqueta}): conservado ${conservar_id}, eliminado ${eliminar_id} ✓`);
  }
  unificarAlumnos2('a_1778461784149_tmq', 'a_1780357984195', 'Cano Mora, Camili Mariel');
  unificarAlumnos2('a_1778628627552', 'a_1778460585399_9nh', 'Vergara Vega, Helen Diana (conservada en Cosmiatría)');
  unificarAlumnos2('a_1778460281546_zyf', 'a_1778446683848_4as', 'Martinez Ribas, Rene Matias (conservado en Farmacia 1°)');
} catch(e) { console.warn('[Migración] Unificar duplicados (decisión director):', e.message); }

// ── MIGRACIÓN: Nuevas materias Electricidad Industrial — Instalación y Seguridad ──
try {
  const insMateria = db.prepare(`INSERT OR IGNORE INTO materias
    (id, carrera_id, nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final, docente_id)
    VALUES (?, 'elec', ?, ?, 4, 2, 25, 25, 50, 'doc_mareco')`);
  insMateria.run('m_elc_206', 'Instalación Eléctrica', 'ELC-206');
  insMateria.run('m_elc_207', 'Seguridad Eléctrica',   'ELC-207');
  console.log('[Migración] Materias Instalación y Seguridad Eléctrica creadas ✓');
} catch(e) { console.warn('[Migración] Materias Electricidad nuevas:', e.message); }

// ── MIGRACIÓN: sistema de sedes ───────────────────────────────────────────────
try {
  db.exec(`CREATE TABLE IF NOT EXISTS sedes (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    ciudad TEXT,
    activa INTEGER DEFAULT 1
  )`);
  db.prepare("INSERT OR IGNORE INTO sedes VALUES ('pjc','Pedro Juan Caballero','Pedro Juan Caballero',1)").run();
  db.prepare("INSERT OR IGNORE INTO sedes VALUES ('cc','Cerro Corá','Cerro Corá',1)").run();
} catch(e) { console.warn('[Migración] sedes tabla:', e.message); }

try { db.prepare("ALTER TABLE carreras ADD COLUMN sede_id TEXT DEFAULT 'pjc'").run(); } catch {}
try { db.prepare("UPDATE carreras SET sede_id='pjc' WHERE sede_id IS NULL").run(); } catch {}
try { db.prepare("ALTER TABLE docentes ADD COLUMN sede_id TEXT DEFAULT 'pjc'").run(); } catch {}
try { db.prepare('ALTER TABLE docentes ADD COLUMN wa_recordatorios_activo INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare("UPDATE docentes SET sede_id='pjc' WHERE sede_id IS NULL").run(); } catch {}
try { db.prepare("ALTER TABLE avisos ADD COLUMN sede_id TEXT DEFAULT 'pjc'").run(); } catch {}
try { db.prepare("UPDATE avisos SET sede_id='pjc' WHERE sede_id IS NULL").run(); } catch {}
// ── Avisos académicos vs. del sistema (pedido del director, para mejor organización) ──
// 'academico': exámenes, notas, reemplazos, comunicados — todo lo que ya existía.
// 'sistema': solo los avisos técnicos/infraestructura (hoy, únicamente el watchdog de
// WhatsApp — conexión caída/restablecida). Clasificación retroactiva por prefijo de id.
try { db.prepare("ALTER TABLE avisos ADD COLUMN categoria TEXT NOT NULL DEFAULT 'academico'").run(); } catch {}
try { db.prepare("UPDATE avisos SET categoria='sistema' WHERE id LIKE 'av\\_wa\\_%' ESCAPE '\\'").run(); } catch {}
try { db.prepare("ALTER TABLE solicitudes_registro ADD COLUMN sede_id TEXT DEFAULT 'pjc'").run(); } catch {}
try { db.prepare("UPDATE solicitudes_registro SET sede_id='pjc' WHERE sede_id IS NULL").run(); } catch {}

try {
  const carrerasPJC = db.prepare("SELECT * FROM carreras WHERE sede_id='pjc'").all();
  const copiarCC = db.transaction(() => {
    for (const c of carrerasPJC) {
      const ccId = 'cc_' + c.id;
      if (!db.prepare("SELECT id FROM carreras WHERE id=?").get(ccId)) {
        db.prepare("INSERT INTO carreras (id,nombre,codigo,turno,semestres,activa,sede_id) VALUES (?,?,?,?,?,1,'cc')")
          .run(ccId, c.nombre, c.codigo, c.turno, c.semestres);
        const mats = db.prepare("SELECT * FROM materias WHERE carrera_id=?").all(c.id);
        for (const m of mats) {
          db.prepare("INSERT OR IGNORE INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)")
            .run('cc_'+m.id, ccId, m.nombre, m.codigo, m.horas_semanales, m.anio, m.peso_tp||25, m.peso_parcial||25, m.peso_final||50);
        }
      }
    }
  });
  copiarCC();
  console.log('[Sedes] ✔ Estructura Cerro Corá lista (carreras + materias vacías)');
} catch(e) { console.warn('[Sedes] Error copiando carreras CC:', e.message); }

// Backup a GitHub — SOLO por el cron de las 23:00 (ver más abajo), cada 48hs.
// Antes también se disparaba 15s después de cada arranque del servidor, lo cual
// subía la base entera (~200MB, ~266MB en base64) en CADA deploy — con varios
// deploys por día durante desarrollo activo, eso solo multiplicaba el tráfico de
// red facturado por Railway sin aportar ningún resguardo real adicional.
const { cloudBackupDrive } = require('./cloud-backup');


// ── HORA DEL SISTEMA (con offset manual) ─────────────────────────────────────
let _timeOffsetMs = 0;
try {
  const row = db.prepare("SELECT valor FROM configuracion WHERE clave='time_offset_ms'").get();
  if (row) _timeOffsetMs = parseInt(row.valor, 10) || 0;
} catch {}
function nowSys() { return new Date(Date.now() + _timeOffsetMs); }
function nowStr() { return nowSys().toISOString().replace('T',' ').slice(0,19); }
function nowDate() { return nowSys().toISOString().split('T')[0]; }

// ── AUDITORÍA ─────────────────────────────────────────────────────────────────
function audit(usuario_id, accion, tabla, registro_id, detalle = null) {
  try {
    db.prepare('INSERT INTO auditoria (id,usuario_id,accion,tabla,registro_id,detalle,fecha) VALUES (?,?,?,?,?,?,?)').run(
      'aud_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),
      usuario_id, accion, tabla, String(registro_id||''), detalle ? JSON.stringify(detalle) : null, nowStr()
    );
  } catch(e) { console.error('Audit error:', e.message); }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function auth(roles = []) {
  return (req, res, next) => {
    // Aceptar token por header Authorization O por query param ?token= (para descargas directas)
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!token) return res.status(401).json({ error: 'Sin autorización' });
    try {
      const u = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(u.rol)) return res.status(403).json({ error: 'Acceso denegado' });
      req.user = u;
      next();
    } catch { res.status(401).json({ error: 'Token inválido' }); }
  };
}
const ADM = ['director'];
const ADM_SEC = ['director'];

// ── DESCARGA DE BASE DE DATOS (solo director) ─────────────────────────────────
app.get('/api/admin/descargar-db', auth(ADM), (req, res) => {
  const { DB_PATH } = require('./db');
  const fs = require('fs');
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ error: 'DB no encontrada' });
  const fecha = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Disposition', `attachment; filename="its_${fecha}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(DB_PATH);
});

// ── ENDPOINT DE EMERGENCIA: recrear director si no existe ─────────────────────
app.get('/api/setup', (req, res) => {
  try {
    const existe = db.prepare("SELECT id FROM usuarios WHERE email='director@its.edu.py'").get();
    if (!existe) {
      db.prepare('INSERT INTO usuarios (id,nombre,apellido,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,1)')
        .run('u_director','Director','Sistema','director@its.edu.py',bcrypt.hashSync('director123',10),'director');
      res.json({ ok: true, mensaje: 'Director creado. Email: director@its.edu.py / Pass: director123' });
    } else {
      // Resetear contraseña por si acaso
      db.prepare("UPDATE usuarios SET password_hash=?, activo=1 WHERE email='director@its.edu.py'")
        .run(bcrypt.hashSync('director123', 10));
      res.json({ ok: true, mensaje: 'Contraseña del director reseteada a: director123' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  // Buscar por email, por CI, o por email generado desde CI (ci@its.edu.py)
  const ciEmail = `${email}@its.edu.py`;
  const u = db.prepare('SELECT * FROM usuarios WHERE (email=? OR ci=? OR email=?) AND activo=1').get(email, email, ciEmail);
  if (!u) return res.status(401).json({ error: 'Credenciales incorrectas' });

  let autenticado = bcrypt.compareSync(password, u.password_hash);

  // Alumnos: aceptar tanto la CI completa como los últimos 3 dígitos.
  // Si el alumno ingresa cualquiera de las dos y el hash no coincide
  // (passwords viejos), se autentica igual y el hash se actualiza a CI completa.
  if (!autenticado && u.rol === 'alumno' && u.ci) {
    const ciLimpia = String(u.ci).replace(/[^0-9]/g, '');
    const ultimos3 = ciLimpia.slice(-3);
    if (password === ciLimpia || password === ultimos3) {
      db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(bcrypt.hashSync(ciLimpia, 10), u.id);
      autenticado = true;
    }
  }

  if (!autenticado) return res.status(401).json({ error: 'Credenciales incorrectas' });
  let docenteId = null, alumnoId = null;
  if (u.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(u.id);
    docenteId = doc?.id || null;
  }
  if (u.rol === 'alumno') alumnoId = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(u.id)?.id;
  const sede = u.rol === 'director' ? 'pjc' : (u.rol === 'docente' ? (db.prepare('SELECT sede_id FROM docentes WHERE usuario_id=?').get(u.id)?.sede_id || 'pjc') : 'pjc');
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId, alumnoId, sede }, JWT_SECRET, { expiresIn: '8h' });
  audit(u.id, 'LOGIN', 'usuarios', u.id, { email: u.email });
  res.json({ token, user: { id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId, alumnoId, sede } });
});

// ── SEDES ─────────────────────────────────────────────────────────────────────
app.get('/api/sedes', auth(ADM), (req, res) => {
  res.json(db.prepare("SELECT * FROM sedes WHERE activa=1 ORDER BY nombre").all());
});
app.post('/api/cambiar-sede', auth(ADM), (req, res) => {
  const { sede_id } = req.body;
  const sede = db.prepare("SELECT * FROM sedes WHERE id=? AND activa=1").get(sede_id);
  if (!sede) return res.status(400).json({ error: 'Sede no válida' });
  const u = req.user;
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId: u.docenteId, alumnoId: u.alumnoId, sede: sede_id }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, sede });
});

// ── USUARIOS ──────────────────────────────────────────────────────────────────
app.get('/api/usuarios/directores', auth(['director']), (req, res) => {
  res.json(db.prepare("SELECT id,nombre,apellido,email,ci,activo,rol FROM usuarios WHERE rol IN ('director','docente','alumno') ORDER BY rol,nombre").all());
});
app.post('/api/usuarios/directores', auth(['director']), (req, res) => {
  const { nombre, apellido, email, password, ci, rol } = req.body;
  if (!nombre || !email || !password) return res.status(400).json({ error: 'Completar nombre, email y contraseña' });
  const existe = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email);
  if (existe) return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
  const id = 'u_' + Date.now();
  db.prepare('INSERT INTO usuarios (id,nombre,apellido,email,ci,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(id, nombre, apellido||'', email, ci||'', bcrypt.hashSync(password, 10), rol||'director');
  res.json({ id });
});
app.put('/api/usuarios/directores/:id', auth(['director']), (req, res) => {
  const { nombre, apellido, email, ci, rol, activo } = req.body;
  db.prepare('UPDATE usuarios SET nombre=?,apellido=?,email=?,ci=?,rol=?,activo=? WHERE id=?').run(nombre, apellido||'', email, ci||'', rol||'director', activo?1:0, req.params.id);
  res.json({ ok: true });
});
app.put('/api/docentes/vincular', auth(ADM), (req, res) => {
  const { docente_id, usuario_id } = req.body;
  db.prepare('UPDATE docentes SET usuario_id=? WHERE id=?').run(usuario_id, docente_id);
  res.json({ ok: true });
});
app.put('/api/usuarios/directores/:id/password', auth(['director']), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Contraseña muy corta' });
  db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/usuarios/directores/:id', auth(['director']), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
  db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── MI PERFIL ─────────────────────────────────────────────────────────────────
app.get('/api/mi-perfil', auth(), (req, res) => {
  const u = db.prepare('SELECT id,nombre,apellido,email,ci,rol FROM usuarios WHERE id=?').get(req.user.id);
  if (u?.rol === 'docente') {
    const d = db.prepare('SELECT id,telefono,titulo,especialidad FROM docentes WHERE usuario_id=?').get(req.user.id);
    return res.json({ ...u, telefono: d?.telefono||null, docente_id: d?.id||null, titulo: d?.titulo||null });
  }
  res.json(u);
});
app.put('/api/mi-perfil/telefono', auth(['docente']), (req, res) => {
  const { telefono } = req.body;
  db.prepare('UPDATE docentes SET telefono=? WHERE usuario_id=?').run(telefono||null, req.user.id);
  res.json({ ok: true });
});
app.put('/api/mi-perfil/password', auth(), (req, res) => {
  const { actual, nueva } = req.body;
  const u = db.prepare('SELECT password_hash FROM usuarios WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(actual, u.password_hash)) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
  if (!nueva || nueva.length < 4) return res.status(400).json({ error: 'La nueva contraseña es muy corta' });
  db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(bcrypt.hashSync(nueva, 10), req.user.id);
  res.json({ ok: true });
});

// ── ESCALA ────────────────────────────────────────────────────────────────────
app.get('/api/escala', auth(), (req, res) => res.json(db.prepare('SELECT * FROM escala_notas ORDER BY nota').all()));
app.put('/api/escala', auth(ADM), (req, res) => {
  const { escala } = req.body;
  const upd = db.prepare('UPDATE escala_notas SET nota=?,puntaje_min=?,puntaje_max=?,descripcion=? WHERE id=?');
  db.transaction(() => escala.forEach(e => upd.run(e.nota, e.puntaje_min, e.puntaje_max, e.descripcion, e.id)))();
  res.json({ ok: true });
});

// ── INSTITUCIÓN ───────────────────────────────────────────────────────────────
// Endpoint público: solo devuelve el logo (para la pantalla de login)
app.get('/api/logo', (req, res) => {
  const inst = db.prepare('SELECT logo_base64 FROM institucion WHERE id=1').get();
  res.json({ logo: inst?.logo_base64 || null });
});
app.get('/api/institucion', auth(), (req, res) => {
  const cached = cacheGet('institucion');
  if (cached) return res.json(cached);
  const data = db.prepare('SELECT * FROM institucion WHERE id=1').get();
  cacheSet('institucion', data);
  res.json(data);
});
app.put('/api/institucion', auth(ADM), (req, res) => {
  const { nombre, telefono, email, direccion, mision } = req.body;
  db.prepare('UPDATE institucion SET nombre=?,telefono=?,email=?,direccion=?,mision=? WHERE id=1').run(nombre,telefono||'',email||'',direccion||'',mision||'');
  cacheInvalidate('institucion');
  res.json({ ok: true });
});
app.post('/api/institucion/logo', auth(ADM), upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  db.prepare('UPDATE institucion SET logo_base64=? WHERE id=1').run(b64);
  cacheInvalidate('institucion');
  res.json({ ok: true, logo_base64: b64 });
});

// ── PERÍODOS ──────────────────────────────────────────────────────────────────
app.get('/api/periodos', auth(), (req, res) => {
  const cached = cacheGet('periodos');
  if (cached) return res.json(cached);
  const data = db.prepare('SELECT * FROM periodos ORDER BY anio DESC').all();
  cacheSet('periodos', data);
  res.json(data);
});
app.post('/api/periodos', auth(ADM), (req, res) => {
  const { nombre, anio, semestre, fecha_inicio, fecha_fin } = req.body;
  const id = db.prepare('INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin) VALUES (?,?,?,?,?)').run(nombre,anio,semestre,fecha_inicio,fecha_fin).lastInsertRowid;
  cacheInvalidate('periodos');
  res.json({ id });
});
app.put('/api/periodos/:id/activar', auth(ADM), (req, res) => {
  db.prepare('UPDATE periodos SET activo=0').run();
  db.prepare('UPDATE periodos SET activo=1 WHERE id=?').run(req.params.id);
  cacheInvalidate('periodos');
  res.json({ ok: true });
});
app.delete('/api/periodos/:id', auth(ADM), (req, res) => {
  db.prepare('DELETE FROM periodos WHERE id=?').run(req.params.id);
  cacheInvalidate('periodos');
  res.json({ ok: true });
});

// ── CARRERAS ──────────────────────────────────────────────────────────────────
app.get('/api/carreras', auth(), (req, res) => {
  const sede = req.user.sede || 'pjc';
  const cacheKey = 'carreras_' + sede;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(DISTINCT CASE WHEN a.estado='Activo' THEN a.id END) as total_alumnos,
      COUNT(DISTINCT m.id) as total_materias
    FROM carreras c
    LEFT JOIN alumnos a ON c.id=a.carrera_id
    LEFT JOIN materias m ON c.id=m.carrera_id
    WHERE c.sede_id=?
    GROUP BY c.id ORDER BY c.nombre`).all(sede);
  const cursosPorCarrera = db.prepare('SELECT cu.* FROM cursos cu JOIN carreras ca ON cu.carrera_id=ca.id WHERE ca.sede_id=? ORDER BY cu.carrera_id,cu.anio,cu.division').all(sede);
  rows.forEach(c => { c.cursos = cursosPorCarrera.filter(cu => cu.carrera_id === c.id); });
  cacheSet(cacheKey, rows);
  res.json(rows);
});
app.post('/api/carreras', auth(ADM), (req, res) => {
  const { nombre, codigo, turno, semestres } = req.body;
  const sede = req.user.sede || 'pjc';
  const prefix = sede === 'pjc' ? '' : sede + '_';
  const id = prefix + codigo.toLowerCase().replace(/\s/g,'_') + '_' + Date.now()%1000;
  db.prepare('INSERT INTO carreras (id,nombre,codigo,turno,semestres,activa,sede_id) VALUES (?,?,?,?,?,1,?)').run(id,nombre,codigo,turno,semestres||4,sede);
  cacheInvalidate('carreras_pjc','carreras_cc','cursos_pjc','cursos_cc');
  res.json({ id });
});
app.put('/api/carreras/:id', auth(ADM), (req, res) => {
  const { nombre, codigo, turno, semestres, activa } = req.body;
  db.prepare('UPDATE carreras SET nombre=?,codigo=?,turno=?,semestres=?,activa=? WHERE id=?').run(nombre,codigo,turno,semestres,activa?1:0,req.params.id);
  cacheInvalidate('carreras_pjc','carreras_cc','cursos_pjc','cursos_cc');
  res.json({ ok: true });
});
app.delete('/api/carreras/:id', auth(ADM), (req, res) => {
  db.prepare('DELETE FROM carreras WHERE id=?').run(req.params.id);
  cacheInvalidate('carreras_pjc','carreras_cc','cursos_pjc','cursos_cc');
  res.json({ ok: true });
});

// ── CURSOS ────────────────────────────────────────────────────────────────────
app.get('/api/cursos', auth(), (req, res) => {
  const sede = req.user.sede || 'pjc';
  const { carrera_id } = req.query;
  if (carrera_id) {
    const q = `SELECT cu.*,ca.nombre as carrera_nombre,ca.codigo as carrera_codigo,
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=cu.id AND estado='Activo') as total_alumnos
      FROM cursos cu JOIN carreras ca ON cu.carrera_id=ca.id
      WHERE cu.carrera_id=? AND ca.sede_id=? ORDER BY ca.nombre,cu.anio,cu.division`;
    return res.json(db.prepare(q).all(carrera_id, sede));
  }
  const cacheKey = 'cursos_' + sede;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);
  const q = `SELECT cu.*,ca.nombre as carrera_nombre,ca.codigo as carrera_codigo,
    (SELECT COUNT(*) FROM alumnos WHERE curso_id=cu.id AND estado='Activo') as total_alumnos
    FROM cursos cu JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE ca.sede_id=? ORDER BY ca.nombre,cu.anio,cu.division`;
  const data = db.prepare(q).all(sede);
  cacheSet(cacheKey, data);
  res.json(data);
});
app.post('/api/cursos', auth(ADM), (req, res) => {
  const { carrera_id, anio, division, turno } = req.body;
  const id = `${carrera_id}_${anio}${(division||'u').toLowerCase()}`;
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division,turno) VALUES (?,?,?,?,?)').run(id,carrera_id,anio,division||'U',turno||'');
  cacheInvalidate('carreras_pjc','carreras_cc','cursos_pjc','cursos_cc');
  res.json({ id });
});
app.delete('/api/cursos/:id', auth(ADM), (req, res) => {
  db.prepare('DELETE FROM cursos WHERE id=?').run(req.params.id);
  cacheInvalidate('carreras_pjc','carreras_cc','cursos_pjc','cursos_cc');
  res.json({ ok: true });
});

// ── MATERIAS ──────────────────────────────────────────────────────────────────
app.get('/api/materias', auth(), (req, res) => {
  const sede = req.user.sede || 'pjc';
  const { carrera_id } = req.query;
  if (carrera_id) {
    const q = `SELECT m.*,c.nombre as carrera_nombre,cu.division as curso_division,cu.anio as curso_anio_cu
      FROM materias m JOIN carreras c ON m.carrera_id=c.id LEFT JOIN cursos cu ON m.curso_id=cu.id
      WHERE m.carrera_id=? AND c.sede_id=? ORDER BY c.nombre,m.anio,cu.division,m.nombre`;
    return res.json(db.prepare(q).all(carrera_id, sede));
  }
  const q = `SELECT m.*,c.nombre as carrera_nombre,cu.division as curso_division,cu.anio as curso_anio_cu
    FROM materias m JOIN carreras c ON m.carrera_id=c.id LEFT JOIN cursos cu ON m.curso_id=cu.id
    WHERE c.sede_id=? ORDER BY c.nombre,m.anio,cu.division,m.nombre`;
  res.json(db.prepare(q).all(sede));
});
app.post('/api/materias', auth(ADM), (req, res) => {
  const { carrera_id, nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final, dia, turno, curso_id, docente_id } = req.body;
  const pt = parseInt(peso_tp)||25, pp = parseInt(peso_parcial)||25, pf = parseInt(peso_final)||50;
  const id = 'm_' + Date.now();
  db.prepare('INSERT INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final,dia,turno,curso_id,docente_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,carrera_id,nombre,codigo||'',horas_semanales||4,anio||1,pt,pp,pf,dia||null,turno||null,curso_id||null,docente_id||null);
  res.json({ id });
});
app.put('/api/materias/:id', auth(ADM), (req, res) => {
  const { nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final, dia, turno, curso_id, docente_id, carrera_id } = req.body;
  const pt = parseInt(peso_tp)||25, pp = parseInt(peso_parcial)||25, pf = parseInt(peso_final)||50;
  db.prepare('UPDATE materias SET nombre=?,codigo=?,horas_semanales=?,anio=?,peso_tp=?,peso_parcial=?,peso_final=?,dia=?,turno=?,curso_id=?,docente_id=? WHERE id=?').run(nombre,codigo,horas_semanales,anio,pt,pp,pf,dia||null,turno||null,curso_id||null,docente_id||null,req.params.id);
  // Propagar cambio de docente a todas las asignaciones de esta materia
  if (docente_id) {
    db.prepare('UPDATE asignaciones SET docente_id=? WHERE materia_id=?').run(docente_id, req.params.id);
  }
  res.json({ ok: true });
});
app.patch('/api/materias/:id/nombre', auth(ADM), (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  db.prepare('UPDATE materias SET nombre=? WHERE id=?').run(nombre, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/materias/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM materias WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ── DOCENTES ──────────────────────────────────────────────────────────────────
app.get('/api/docentes', auth(), (req, res) => {
  const sede = req.user.sede || 'pjc';
  res.json(db.prepare(`SELECT u.id,u.nombre,u.apellido,u.ci,u.email,u.activo,
    d.id as docente_id,d.especialidad,d.titulo,d.telefono,d.sede_id,
    COALESCE(d.wa_recordatorios_activo,1) as wa_recordatorios_activo
    FROM usuarios u JOIN docentes d ON u.id=d.usuario_id WHERE u.rol='docente' AND d.sede_id=? ORDER BY u.apellido`).all(sede));
});
app.put('/api/docentes/:docente_id/wa-recordatorios', auth(ADM), (req, res) => {
  const { activo } = req.body;
  const r = db.prepare('UPDATE docentes SET wa_recordatorios_activo=? WHERE id=?').run(activo ? 1 : 0, req.params.docente_id);
  if (!r.changes) return res.status(404).json({ error: 'Docente no encontrado' });
  audit(req.user.id, 'WA_RECORDATORIOS_TOGGLE', 'docentes', req.params.docente_id, { activo: !!activo });
  res.json({ ok: true });
});
app.post('/api/docentes', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, email, password, especialidad, titulo, telefono } = req.body;
  const sede = req.user.sede || 'pjc';
  const uid = 'u_'+Date.now(), did = 'd_'+Date.now();
  const ciDoc = ci && ci.trim() && ci.trim() !== '0.000.000' ? ci.trim() : null;
  db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid,nombre,apellido,ciDoc,email,bcrypt.hashSync(password||'123456',10),'docente');
  db.prepare('INSERT INTO docentes (id,usuario_id,especialidad,titulo,telefono,sede_id) VALUES (?,?,?,?,?,?)').run(did,uid,especialidad,titulo,telefono,sede);
  res.json({ id: uid, docente_id: did });
});
app.put('/api/docentes/:uid', auth(ADM), (req, res) => {
  try {
    const { nombre, apellido, ci, email, especialidad, titulo, telefono } = req.body;
    const uid = req.params.uid;
    // Actualizar nombre/apellido/email — NUNCA tocar ci en esta query para evitar UNIQUE conflict
    db.prepare('UPDATE usuarios SET nombre=?,apellido=?,email=? WHERE id=?').run(nombre, apellido||'', email, uid);
    // Actualizar CI solo si viene un valor explícito distinto al actual
    const ciNueva = ci && String(ci).trim() && String(ci).trim() !== '0.000.000' ? String(ci).trim() : null;
    if (ciNueva) {
      const ciActual = db.prepare('SELECT ci FROM usuarios WHERE id=?').get(uid)?.ci;
      if (ciNueva !== ciActual) {
        const dup = db.prepare('SELECT id FROM usuarios WHERE ci=? AND id!=?').get(ciNueva, uid);
        if (dup) return res.status(400).json({ error: 'Ya existe otro usuario con esa C.I.' });
        db.prepare('UPDATE usuarios SET ci=? WHERE id=?').run(ciNueva, uid);
      }
    }
    db.prepare('UPDATE docentes SET especialidad=?,titulo=?,telefono=? WHERE usuario_id=?').run(especialidad||null, titulo||null, telefono||null, uid);
    res.json({ ok: true });
  } catch(e) {
    console.error('[PUT /api/docentes/:uid] error:', e.message, '| body:', JSON.stringify(req.body), '| uid:', req.params.uid);
    res.status(500).json({ error: 'Error al actualizar docente: ' + e.message });
  }
});
app.put('/api/docentes/:uid/password', auth(ADM), (req, res) => {
  db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password,10),req.params.uid);
  res.json({ ok: true });
});
app.delete('/api/docentes/:uid', auth(ADM), (req, res) => {
  try {
    const docente = db.prepare('SELECT * FROM docentes WHERE usuario_id=?').get(req.params.uid);
    const usuario = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.uid);
    if (docente || usuario) {
      const nombre = usuario ? `${usuario.nombre||''} ${usuario.apellido||''}`.trim() : req.params.uid;
      guardarEnPapelera('docente', nombre, { docente, usuario }, req.user?.id);
    }
    db.prepare('DELETE FROM docentes WHERE usuario_id=?').run(req.params.uid);
    db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.uid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALUMNOS ───────────────────────────────────────────────────────────────────
app.get('/api/alumnos', auth(), (req, res) => {
  const { ci, carrera_id, curso_id, busqueda } = req.query;
  const sede = req.user.sede || 'pjc';
  if (req.user.rol === 'alumno' && !ci) return res.status(403).json({ error: 'Sin acceso' });
  let where = req.user.rol==='director' ? 'WHERE (c.sede_id=? OR al.carrera_id IS NULL)' : "WHERE al.estado NOT IN ('Inactivo','Retirado') AND (c.sede_id=? OR al.carrera_id IS NULL)";
  const params = [sede];
  if (ci)         { where += ' AND (al.ci LIKE ? OR u.ci LIKE ?)'; params.push('%'+ci+'%','%'+ci+'%'); }
  if (carrera_id === 'SIN_ASIGNAR') { where += ' AND al.carrera_id IS NULL'; }
  else if (carrera_id) { where += ' AND al.carrera_id=?'; params.push(carrera_id); }
  if (curso_id)   { where += ' AND al.curso_id=?';   params.push(curso_id); }
  if (busqueda) {
    const b = '%'+busqueda+'%';
    where += ' AND (al.nombre LIKE ? OR al.apellido LIKE ? OR al.ci LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ? OR u.ci LIKE ?)';
    params.push(b,b,b,b,b,b);
  }
  res.json(db.prepare(`
    SELECT al.*,
      c.nombre as carrera_nombre, c.codigo as carrera_codigo,
      cu.anio as curso_anio, cu.division as curso_division,
      COALESCE(al.nombre,u.nombre) as display_nombre,
      COALESCE(al.apellido,u.apellido) as display_apellido,
      COALESCE(al.ci,u.ci) as display_ci,
      u.email
    FROM alumnos al
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    ${where} ORDER BY COALESCE(al.apellido,u.apellido) LIMIT 2000`).all(...params));
});

// ── BUSCAR CONFLICTO ANTES DE CREAR ALUMNO ─────────────────────────────────
app.get('/api/alumnos/buscar-conflicto', auth(ADM), (req, res) => {
  const { ci, nombre, apellido } = req.query;
  const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const ciRaw = String(ci||'').replace(/[^0-9]/g,'');
  const resultados = [];

  const fullSelect = `SELECT al.id, al.matricula, al.estado, al.carrera_id, al.curso_id,
    COALESCE(al.nombre,u.nombre,'') as nombre, COALESCE(al.apellido,u.apellido,'') as apellido,
    COALESCE(al.ci,u.ci,'') as ci, u.email,
    c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id`;

  // 1. Por CI exacto (busca en ambas tablas, incluye todos los estados)
  if (ciRaw) {
    const porCI = db.prepare(`${fullSelect} WHERE al.ci=? OR u.ci=? LIMIT 5`).all(ciRaw, ciRaw);
    for (const r of porCI) if (!resultados.find(x=>x.id===r.id)) resultados.push({ ...r, match_por:'ci' });
  }

  // 2. Por apellido en memoria — trae todos los activos y filtra
  if (apellido && apellido.length >= 2) {
    const aNorm = normStr(apellido);
    const nNorm = nombre ? normStr(nombre) : null;
    const todos = db.prepare(`${fullSelect} WHERE al.estado NOT IN ('Inactivo','Retirado','Egresado') LIMIT 600`).all();
    for (const r of todos) {
      if (resultados.find(x=>x.id===r.id)) continue;
      const rApNorm = normStr(r.apellido);
      // Apellido: coincidencia amplia (contiene)
      if (!rApNorm.includes(aNorm) && !aNorm.includes(rApNorm)) continue;
      // Nombre: si se proveyó, también debe coincidir
      if (nNorm) {
        const rNomNorm = normStr(r.nombre);
        if (!rNomNorm.includes(nNorm) && !nNorm.includes(rNomNorm)) continue;
      }
      resultados.push({ ...r, match_por:'nombre' });
    }
  }

  res.json({ conflictos: resultados, total: resultados.length });
});

app.post('/api/alumnos', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, telefono, carrera_id, curso_id, fecha_ingreso, estado, email } = req.body;
  const id = 'a_' + Date.now();
  const ciRaw = String(ci||'').replace(/[^0-9]/g,'');
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const carr = carrera_id ? db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carrera_id) : null;
  const yr = nowSys().getFullYear();
  const prefix = `${carr?.codigo||'ALU'}-${yr}-`;
  // Para alumnos sin carrera usar IS NULL para encontrar sus matrículas existentes
  const existingMats = carrera_id
    ? db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carrera_id, prefix+'%')
    : db.prepare('SELECT matricula FROM alumnos WHERE carrera_id IS NULL AND matricula LIKE ?').all(prefix+'%');
  const maxNum = existingMats.reduce((mx, r) => { const n = parseInt((r.matricula||'').slice(prefix.length))||0; return Math.max(mx,n); }, 0);
  const matricula = `${prefix}${String(maxNum+1).padStart(3,'0')}`;
  let emailAuto = email || (norm(nombre).slice(0,1)+norm(apellido)+'@its.edu.py');
  if (!email && db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailAuto))
    emailAuto = norm(nombre).slice(0,1)+norm(apellido)+'.'+(ciRaw.slice(-3)||Date.now()%1000)+'@its.edu.py';
  const uid = 'u_'+id;
  try {
    db.transaction(() => {
      let userId = null;
      if (ciRaw) {
        // Si ya existe un usuario con esa CI, reusar su cuenta
        const usuExiste = db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw);
        if (usuExiste) {
          userId = usuExiste.id;
          // Asegurar que el email sea el generado si no tiene uno aún
          db.prepare("UPDATE usuarios SET nombre=?,apellido=?,email=COALESCE(NULLIF(email,''),?),activo=1 WHERE id=?").run(nombre,apellido,emailAuto,usuExiste.id);
        } else {
          const passHash = bcrypt.hashSync(ciRaw, 10);
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid,nombre,apellido,ciRaw,emailAuto,passHash,'alumno');
          userId = uid;
        }
      } else {
        // Sin CI: crear cuenta con contraseña temporal "123456"
        const emailExiste = db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailAuto);
        if (emailExiste) {
          userId = emailExiste.id;
        } else {
          const passHash = bcrypt.hashSync('123456', 10);
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid,nombre,apellido,null,emailAuto,passHash,'alumno');
          userId = uid;
        }
      }
      db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido,telefono) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,matricula,carrera_id||null,curso_id||null,fecha_ingreso||nowDate(),estado||'Activo',ciRaw||null,nombre,apellido,telefono||null);
      // Crear registros de notas para cada asignación del curso CON periodo_id
      if (curso_id) {
        const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
        const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(curso_id, periodo?.id||null);
        asigs.forEach(asig => {
          try { db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),id,asig.id,'Pendiente'); } catch {}
        });
      }
    })();
    audit(req.user.id,'CREATE','alumnos',id,{nombre,apellido,carrera_id});
    const credencial = { email: emailAuto, password: ciRaw || '123456' };
    res.json({ id, matricula, credencial });
  } catch(e) { res.status(500).json({ error: 'Error al crear alumno: '+e.message }); }
});
// ── ALUMNOS FALTANTES ────────────────────────────────────────────────────────
app.get('/api/alumnos-faltantes', auth(ADM), (req, res) => {
  const rows = db.prepare(`
    SELECT af.*, c.nombre as carrera_nombre
    FROM alumnos_faltantes af
    LEFT JOIN carreras c ON af.carrera_id = c.id
    ORDER BY af.fecha_registro DESC
  `).all();
  res.json(rows);
});
app.post('/api/alumnos-faltantes', auth(ADM), (req, res) => {
  const { nombre, apellido, carrera_id, ci } = req.body;
  if (!nombre || !apellido || !carrera_id) return res.status(400).json({ error: 'nombre, apellido y carrera son requeridos' });
  const id = 'af_' + Date.now();
  const ciLimpio = ci ? String(ci).replace(/[^0-9]/g, '') : null;
  db.prepare('INSERT INTO alumnos_faltantes (id,nombre,apellido,carrera_id,ci,registrado_por) VALUES (?,?,?,?,?,?)').run(id, nombre.trim(), apellido.trim(), carrera_id, ciLimpio || null, req.user.id);
  res.json({ id, ok: true });
});
app.delete('/api/alumnos-faltantes/:id', auth(ADM), (req, res) => {
  db.prepare('DELETE FROM alumnos_faltantes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.put('/api/alumnos/:id', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, telefono, direccion, estado, carrera_id, curso_id, usuario_id } = req.body;
  if (usuario_id !== undefined) {
    // Solo actualizar el usuario_id (vinculación)
    db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(usuario_id, req.params.id);
    return res.json({ ok: true });
  }
  // Obtener valores actuales para no pisar campos con undefined
  const actual = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
  if (!actual) return res.status(404).json({ error: 'Alumno no encontrado' });
  db.prepare('UPDATE alumnos SET nombre=?,apellido=?,ci=?,telefono=?,direccion=?,estado=?,carrera_id=?,curso_id=? WHERE id=?').run(
    nombre     !== undefined ? nombre     : actual.nombre,
    apellido   !== undefined ? apellido   : actual.apellido,
    ci         !== undefined ? ci         : actual.ci,
    telefono   !== undefined ? telefono   : actual.telefono,
    direccion  !== undefined ? direccion  : actual.direccion,
    estado     !== undefined ? estado     : actual.estado,
    carrera_id !== undefined ? carrera_id : actual.carrera_id,
    curso_id   !== undefined ? (curso_id||null) : actual.curso_id,
    req.params.id
  );
  // Si cambió nombre o apellido, sincronizar en usuarios (nombre, apellido y email)
  if (actual.usuario_id && (nombre !== undefined || apellido !== undefined)) {
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const nuevoNombre   = nombre   !== undefined ? nombre   : actual.nombre;
    const nuevoApellido = apellido !== undefined ? apellido : actual.apellido;
    if (nombre   !== undefined) db.prepare('UPDATE usuarios SET nombre=?   WHERE id=?').run(nombre,   actual.usuario_id);
    if (apellido !== undefined) db.prepare('UPDATE usuarios SET apellido=? WHERE id=?').run(apellido, actual.usuario_id);
    const ciRaw = String(ci !== undefined ? ci : actual.ci || '').replace(/[^0-9]/g,'');
    let nuevoEmail = norm(nuevoNombre).slice(0,1) + norm(nuevoApellido) + '@its.edu.py';
    const conflicto = db.prepare('SELECT id FROM usuarios WHERE email=? AND id!=?').get(nuevoEmail, actual.usuario_id);
    if (conflicto) nuevoEmail = norm(nuevoNombre).slice(0,1) + norm(nuevoApellido) + '.' + (ciRaw.slice(-3) || String(Date.now()%1000)) + '@its.edu.py';
    db.prepare('UPDATE usuarios SET email=? WHERE id=?').run(nuevoEmail, actual.usuario_id);
  }
  res.json({ ok: true });
});
// ── CREAR/ACTUALIZAR ACCESOS MASIVOS ─────────────────────────────────────────
app.post('/api/alumnos/crear-accesos', auth(ADM), (req, res) => {
  const sinAcceso = db.prepare(`
    SELECT al.id, COALESCE(al.nombre,u2.nombre) as nombre,
      COALESCE(al.apellido,u2.apellido) as apellido,
      COALESCE(al.ci,u2.ci) as ci, al.usuario_id
    FROM alumnos al
    LEFT JOIN usuarios u2 ON al.usuario_id=u2.id
    WHERE al.estado NOT IN ('Inactivo','Retirado')`).all();
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  let creados=0, actualizados=0, errores=[];
  sinAcceso.forEach(al => {
    const ciRaw = String(al.ci||'').replace(/[^0-9]/g,'');
    if (!ciRaw) return;
    try {
      let emailFinal = norm(al.nombre).slice(0,1)+norm(al.apellido)+'@its.edu.py';
      const conflicto = db.prepare('SELECT id FROM usuarios WHERE email=? AND id!=?').get(emailFinal, al.usuario_id||'');
      if (conflicto) emailFinal = norm(al.nombre).slice(0,1)+norm(al.apellido)+'.'+ciRaw.slice(-3)+'@its.edu.py';
      if (!al.usuario_id) {
        // Crear usuario nuevo
        const uid = 'u_a_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
        db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
          .run(uid, al.nombre, al.apellido, ciRaw, emailFinal, bcrypt.hashSync(ciRaw||'123456', 10), 'alumno');
        db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(uid, al.id);
        creados++;
      } else {
        // Actualizar contraseña al CI actual (por si cambió)
        db.prepare('UPDATE usuarios SET email=?,password_hash=?,ci=? WHERE id=?')
          .run(emailFinal, bcrypt.hashSync(ciRaw||'123456', 10), ciRaw, al.usuario_id);
        actualizados++;
      }
    } catch(e) { errores.push(al.nombre+': '+e.message); }
  });
  res.json({ creados, actualizados, errores: errores.slice(0,5) });
});

// ── ALUMNOS SIN ACCESO (sin usuario/contraseña) — cruza con envío de bienvenida QR y auditoría ──
app.get('/api/alumnos/sin-acceso', auth(ADM), (req, res) => {
  const sinAcceso = db.prepare(`
    SELECT al.id, al.nombre, al.apellido, al.ci, al.telefono, al.matricula, al.estado,
      c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
    FROM alumnos al
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    WHERE al.usuario_id IS NULL
    ORDER BY al.apellido, al.nombre`).all();
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  const resultado = sinAcceso.map(al => {
    const nombreCompleto = norm(al.nombre)+norm(al.apellido);
    // Cruce con WhatsApp de bienvenida: ¿ya se le mandó el QR con credenciales alguna vez?
    const wa = db.prepare(`SELECT estado, fecha FROM wa_mensajes WHERE tipo='bienvenida' AND
        (destinatario_telefono=? OR replace(replace(lower(destinatario_nombre),' ',''),'.','')=?)
        ORDER BY fecha DESC LIMIT 1`).get(al.telefono||'', nombreCompleto);
    // Cruce con auditoría: última acción relacionada a este alumno (alta, solicitud, etc.)
    const aud = db.prepare(`SELECT accion, fecha FROM auditoria WHERE registro_id=? OR registro_id LIKE ?
        ORDER BY fecha DESC LIMIT 1`).get(al.id, al.id+'\_%');
    return {
      ...al,
      wa_bienvenida_enviada: wa ? { estado: wa.estado, fecha: wa.fecha } : null,
      ultima_auditoria: aud ? { accion: aud.accion, fecha: aud.fecha } : null,
    };
  });
  res.json(resultado);
});

// ── Buscar UN alumno puntual (por nombre/apellido/CI) y ver si tiene acceso ────
// Complementa a /api/alumnos/sin-acceso: esa lista se arma automáticamente, pero
// el director puede necesitar confirmar el estado de un alumno específico que no
// esté seguro si aparece ahí (por eso busca en TODA la tabla alumnos, sin filtrar
// por sede/carrera/estado como hace el resto del sistema, y sin tocar `usuarios`).
app.get('/api/alumnos/buscar-acceso', auth(ADM), (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = '%' + q + '%';
  const rows = db.prepare(`
    SELECT al.id, al.nombre, al.apellido, al.ci, al.telefono, al.matricula, al.estado,
      al.usuario_id, u.email as usuario_email, u.activo as usuario_activo,
      c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
    FROM alumnos al
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE al.nombre LIKE ? OR al.apellido LIKE ? OR al.ci LIKE ?
    ORDER BY al.apellido, al.nombre LIMIT 30`).all(like, like, like);
  res.json(rows.map(al => ({ ...al, tiene_acceso: !!al.usuario_id })));
});

// ── Crear acceso (usuario/contraseña) para UN alumno puntual ──────────────────
app.post('/api/alumnos/:id/crear-acceso', auth(ADM), (req, res) => {
  const al = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  if (al.usuario_id) return res.status(400).json({ error: 'Este alumno ya tiene usuario' });
  const ciRaw = String(al.ci||'').replace(/[^0-9]/g,'');
  if (!ciRaw) return res.status(400).json({ error: 'El alumno no tiene CI cargado — no se puede crear la contraseña inicial' });
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  let email = norm(al.nombre).slice(0,1)+norm(al.apellido)+'@its.edu.py';
  if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(email))
    email = norm(al.nombre).slice(0,1)+norm(al.apellido)+'.'+ciRaw.slice(-3)+'@its.edu.py';
  const uid = 'u_a_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
  try {
    db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
      .run(uid, al.nombre, al.apellido, ciRaw, email, bcrypt.hashSync(ciRaw, 10), 'alumno');
    db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(uid, al.id);
    audit(req.user.id, 'CREAR_ACCESO', 'usuarios', uid, { alumno_id: al.id, nombre: al.nombre+' '+al.apellido, email });
    if (al.telefono) enviarBienvenidaQR(al.telefono, (al.nombre+' '+al.apellido).trim(), email, ciRaw);
    res.json({ ok: true, email, ci: ciRaw, wa_enviado: !!al.telefono });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PREVISUALIZAR cuántos alumnos tiene un grupo (ANTES de :id para evitar conflicto de rutas) ──
app.get('/api/alumnos/grupo/count', auth(ADM), (req, res) => {
  try {
    const { carrera_id, curso_id } = req.query;
    if (!carrera_id) return res.status(400).json({ error: 'Debe especificar carrera_id' });
    let row;
    if (curso_id) {
      row = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=? AND curso_id=?').get(carrera_id, curso_id);
    } else {
      row = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id);
    }
    res.json({ count: row.n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ELIMINAR GRUPO COMPLETO (ANTES de :id para evitar conflicto de rutas) ──
app.delete('/api/alumnos/grupo', auth(ADM), (req, res) => {
  try {
    const { carrera_id, curso_id } = req.query;
    if (!carrera_id) return res.status(400).json({ error: 'Debe especificar carrera_id' });
    let alumnos;
    if (curso_id) {
      alumnos = db.prepare('SELECT id,usuario_id FROM alumnos WHERE carrera_id=? AND curso_id=?').all(carrera_id, curso_id);
    } else {
      alumnos = db.prepare('SELECT id,usuario_id FROM alumnos WHERE carrera_id=?').all(carrera_id);
    }
    if (!alumnos.length) return res.json({ ok: true, eliminados: 0 });
    db.transaction(() => {
      alumnos.forEach(a => {
        db.prepare('DELETE FROM notas WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM asistencia WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM pagos WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM constancias WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM becas WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM habilitaciones_examen WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM deudas_cuotas WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM solicitudes_egreso WHERE alumno_id=?').run(a.id);
        db.prepare('DELETE FROM alumnos WHERE id=?').run(a.id);
        if (a.usuario_id) db.prepare("DELETE FROM usuarios WHERE id=? AND rol='alumno'").run(a.usuario_id);
      });
    })();
    audit(req.user.id,'DELETE','alumnos_grupo',carrera_id,{ curso_id, eliminados: alumnos.length });
    res.json({ ok: true, eliminados: alumnos.length });
  } catch(e) { res.status(500).json({ error: 'Error al eliminar grupo: '+e.message }); }
});

// Eliminación completa desde Pagos (incluye solicitudes y cuenta de usuario)
app.delete('/api/alumnos/:id/completo', auth(ADM), (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alumno no encontrado' });
    // Snapshot para papelera ANTES de eliminar
    const usuario    = a.usuario_id ? db.prepare('SELECT * FROM usuarios WHERE id=?').get(a.usuario_id) : null;
    const notas      = db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(a.id);
    const pagos      = db.prepare('SELECT * FROM pagos WHERE alumno_id=?').all(a.id);
    const asistencia = db.prepare('SELECT * FROM asistencia WHERE alumno_id=?').all(a.id);
    const becas      = db.prepare('SELECT * FROM becas WHERE alumno_id=?').all(a.id);
    const habilitaciones = db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=?').all(a.id);
    guardarEnPapelera('alumno_completo',
      `${a.nombre||''} ${a.apellido||''}`.trim() + (a.ci ? ` (CI: ${a.ci})` : ''),
      { alumno: a, usuario, notas, pagos, asistencia, becas, habilitaciones },
      req.user?.id
    );
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        const tablas = db.prepare(`
          SELECT m.name FROM sqlite_master m
          WHERE m.type='table'
            AND m.sql LIKE '%alumno_id%'
            AND m.name NOT IN ('alumnos')
        `).all().map(r => r.name);
        tablas.forEach(t => {
          try { db.prepare(`DELETE FROM ${t} WHERE alumno_id=?`).run(a.id); } catch {}
        });
        if (a.usuario_id) {
          try { db.prepare('DELETE FROM solicitudes_alumno WHERE registrado_por=?').run(a.usuario_id); } catch {}
        }
        db.prepare('DELETE FROM alumnos WHERE id=?').run(a.id);
        if (a.usuario_id) db.prepare("DELETE FROM usuarios WHERE id=? AND rol='alumno'").run(a.usuario_id);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    audit(req.user.id,'DELETE_COMPLETO','alumnos',a.id,{ nombre: a.nombre, apellido: a.apellido, ci: a.ci });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error al eliminar: '+e.message }); }
});

app.delete('/api/alumnos/:id', auth(ADM), (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alumno no encontrado' });
    // Snapshot para papelera ANTES de eliminar
    const usuario    = a.usuario_id ? db.prepare('SELECT * FROM usuarios WHERE id=?').get(a.usuario_id) : null;
    const notas      = db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(a.id);
    const pagos      = db.prepare('SELECT * FROM pagos WHERE alumno_id=?').all(a.id);
    const asistencia = db.prepare('SELECT * FROM asistencia WHERE alumno_id=?').all(a.id);
    const becas      = db.prepare('SELECT * FROM becas WHERE alumno_id=?').all(a.id);
    const habilitaciones = db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=?').all(a.id);
    guardarEnPapelera('alumno',
      `${a.nombre||''} ${a.apellido||''}`.trim() + (a.ci ? ` (CI: ${a.ci})` : ''),
      { alumno: a, usuario, notas, pagos, asistencia, becas, habilitaciones },
      req.user?.id
    );
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        const tablas = db.prepare(`
          SELECT m.name FROM sqlite_master m
          WHERE m.type='table' AND m.sql LIKE '%alumno_id%' AND m.name NOT IN ('alumnos')
        `).all().map(r => r.name);
        tablas.forEach(t => { try { db.prepare(`DELETE FROM ${t} WHERE alumno_id=?`).run(a.id); } catch {} });
        if (a.usuario_id) {
          try { db.prepare('DELETE FROM solicitudes_alumno WHERE registrado_por=?').run(a.usuario_id); } catch {}
        }
        db.prepare('DELETE FROM alumnos WHERE id=?').run(a.id);
        if (a.usuario_id) db.prepare("DELETE FROM usuarios WHERE id=? AND rol='alumno'").run(a.usuario_id);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    audit(req.user.id,'DELETE','alumnos',a.id,{});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error al eliminar: '+e.message }); }
});

app.post('/api/alumnos/importar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });

    // Detectar fila de encabezados buscando "NOMBRE COMPLETO" o "nombre"
    let headerRow = -1, nameCol = -1, ciCol = -1;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const r = rows[i];
      for (let j = 0; j < r.length; j++) {
        const v = String(r[j] || '').toUpperCase().trim();
        if (v.includes('NOMBRE COMPLETO') || v === 'NOMBRE') { nameCol = j; headerRow = i; }
        if (v.includes('CÉDULA') || v.includes('CEDULA') || v === 'CI') { ciCol = j; headerRow = i; }
      }
      if (nameCol >= 0 && ciCol >= 0) break;
    }

    // Fallback a estructura nombre/apellido/ci separados
    let modoSeparado = false;
    let apellidoCol = -1;
    if (nameCol < 0) {
      for (let i = 0; i < Math.min(15, rows.length); i++) {
        const r = rows[i];
        for (let j = 0; j < r.length; j++) {
          const v = String(r[j] || '').toLowerCase().trim();
          if (v === 'nombre') { nameCol = j; headerRow = i; }
          if (v === 'apellido') { apellidoCol = j; headerRow = i; }
          if (v === 'ci' || v === 'cédula' || v === 'cedula') { ciCol = j; headerRow = i; }
        }
        if (nameCol >= 0 && ciCol >= 0) break;
      }
      if (apellidoCol >= 0) modoSeparado = true;
    }

    if (headerRow < 0 || ciCol < 0) return res.status(400).json({ error: 'No se encontraron las columnas NOMBRE COMPLETO y N° CÉDULA. Verificar el formato del archivo.' });

    const { carrera_id, curso_id } = req.body;
    if (!carrera_id) return res.status(400).json({ error: 'Seleccionar carrera antes de importar' });
    const carr = db.prepare('SELECT id,codigo,nombre FROM carreras WHERE id=?').get(carrera_id);
    if (!carr) return res.status(400).json({ error: 'Carrera no encontrada' });

    const results = { ok: 0, actualizados: 0, errores: [], sinCedula: [], carrera: carr.nombre, curso: curso_id || '' };
    const dataRows = rows.slice(headerRow + 1);

    db.transaction(() => {
      dataRows.forEach((row, idx) => {
        const ciRaw = String(row[ciCol] || '').trim().replace(/[^0-9]/g, '');
        let nombreCompleto = String(row[nameCol] || '').trim();
        if (!nombreCompleto) return; // fila vacía → saltar

        // Si es modo separado, construir nombre completo
        if (modoSeparado && apellidoCol >= 0) {
          const ap = String(row[apellidoCol] || '').trim();
          nombreCompleto = (ap ? ap + ' ' : '') + nombreCompleto;
        }

        // Parsear nombre
        const partes = nombreCompleto.split(/\s+/).filter(Boolean);
        let nombre = nombreCompleto, apellido = '';
        if (partes.length >= 3) {
          nombre = partes.slice(0, Math.ceil(partes.length / 2)).join(' ');
          apellido = partes.slice(Math.ceil(partes.length / 2)).join(' ');
        } else if (partes.length === 2) {
          nombre = partes[0]; apellido = partes[1];
        }

        // Sin CI válida → importar igual pero sin usuario y marcar como Pendiente
        if (!ciRaw || ciRaw.length < 5) {
          try {
            const _yr1 = nowSys().getFullYear(); const _pfx1 = `${carr.codigo}-${_yr1}-`;
            const _mats1 = db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carrera_id, _pfx1+'%');
            const _max1 = _mats1.reduce((mx,r)=>{const n=parseInt((r.matricula||'').slice(_pfx1.length))||0;return Math.max(mx,n);},0);
            const matricula = `${_pfx1}${String(_max1+1).padStart(3,'0')}`;
            const aid = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
            db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid, null, matricula, carrera_id, curso_id||null, nowDate(), 'Activo', null, nombre, apellido);
            if (curso_id) {
              const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
              const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(curso_id, periodo?.id||null);
              asigs.forEach(asig => { try { db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), aid, asig.id, 'Pendiente'); } catch {} });
            }
            results.sinCedula.push(`${apellido ? apellido+', '+nombre : nombre} (fila ${idx + 2})`);
            results.ok++;
          } catch(e) { results.errores.push(`Fila ${idx + 2} (sin CI): ${e.message}`); }
          return;
        }

        try {
          const existente = db.prepare('SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE ci=?').get(ciRaw);
          const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
          let emailAuto = norm(nombre).slice(0,1)+norm(apellido)+'@its.edu.py';
          if (db.prepare('SELECT id FROM usuarios WHERE email=? AND ci!=?').get(emailAuto, ciRaw))
            emailAuto = norm(nombre).slice(0,1)+norm(apellido)+'.'+ciRaw.slice(-3)+'@its.edu.py';

          if (existente) {
            db.prepare('UPDATE alumnos SET carrera_id=?,curso_id=?,nombre=?,apellido=? WHERE ci=?').run(carrera_id, curso_id||null, nombre, apellido, ciRaw);
            // Crear notas faltantes para el curso asignado
            if (curso_id) {
              const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
              const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=?'+(periodo?.id ? ' AND periodo_id=?' : '')).all(curso_id, ...(periodo?.id ? [periodo.id] : []));
              asigs.forEach(asig => {
                try { db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), existente.id, asig.id, 'Pendiente'); } catch {}
              });
            }
            // Actualizar/crear usuario si no tiene
            if (!existente.usuario_id) {
              const uid2='u_e_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
              try{
                db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid2,nombre,apellido,ciRaw,emailAuto,bcrypt.hashSync(ciRaw||'123456',10),'alumno');
                db.prepare('UPDATE alumnos SET usuario_id=? WHERE ci=?').run(uid2,ciRaw);
              }catch{}
            }
            results.actualizados++;
          } else {
            const _yr2 = nowSys().getFullYear(); const _pfx2 = `${carr.codigo}-${_yr2}-`;
            const _mats2 = db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carrera_id, _pfx2+'%');
            const _max2 = _mats2.reduce((mx,r)=>{const n=parseInt((r.matricula||'').slice(_pfx2.length))||0;return Math.max(mx,n);},0);
            const matricula = `${_pfx2}${String(_max2+1).padStart(3,'0')}`;
            const aid = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
            // Usuario: nombre.apellido@its.edu.py · Contraseña: CI completo
            let uid = null;
            const usuExiste = db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw);
            if (!usuExiste) {
              uid = 'u_e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
              try {
                db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid, nombre, apellido, ciRaw, emailAuto, bcrypt.hashSync(ciRaw||'123456', 10), 'alumno');
              } catch { uid = null; }
            } else { uid = usuExiste.id; }
            db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid, uid, matricula, carrera_id, curso_id||null, nowDate(), 'Activo', ciRaw, nombre, apellido);
            // Crear registros de notas para cada asignación del curso CON periodo_id
            if (curso_id) {
              const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
              const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(curso_id, periodo?.id||null);
              asigs.forEach(asig => {
                try {
                  db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), aid, asig.id, 'Pendiente');
                } catch {}
              });
            }
            results.ok++;
          }
        } catch(e) { results.errores.push(`Fila ${idx + 2}: ${e.message}`); }
      });
    })();

    audit(req.user.id, 'IMPORTAR', 'alumnos', 'bulk', { ok: results.ok, actualizados: results.actualizados, carrera: carr.nombre });
    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando archivo: ' + e.message }); }
});
// Crear/actualizar accesos para todos los alumnos sin usuario
app.post('/api/alumnos/crear-accesos', auth(ADM), (req, res) => {
  const alSinUsuario = db.prepare("SELECT * FROM alumnos WHERE usuario_id IS NULL AND ci IS NOT NULL AND ci!=''").all();
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  let creados=0, errores=[];
  alSinUsuario.forEach(al => {
    const ciRaw = String(al.ci||'').replace(/[^0-9]/g,'');
    if(!ciRaw) return;
    let email = norm(al.nombre).slice(0,1)+norm(al.apellido)+'@its.edu.py';
    if(db.prepare('SELECT id FROM usuarios WHERE email=?').get(email))
      email = norm(al.nombre).slice(0,1)+norm(al.apellido)+'.'+ciRaw.slice(-3)+'@its.edu.py';
    const uid='u_acc_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
    try{
      db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
        .run(uid,al.nombre,al.apellido,ciRaw,email,bcrypt.hashSync(ciRaw||'123456',10),'alumno');
      db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(uid,al.id);
      creados++;
    }catch(e){errores.push(al.nombre+': '+e.message);}
  });
  audit(req.user.id,'CREAR_ACCESOS','usuarios','bulk',{creados});
  res.json({creados,errores:errores.slice(0,10),mensaje:`Se crearon ${creados} accesos nuevos`});
});

app.get('/api/alumnos/plantilla', auth(ADM), (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { nombre:'Ana',apellido:'García',ci:'3.456.789',telefono:'0981-111-001',carrera:'CRM',anio:1,division:'A' },
    { nombre:'Luis',apellido:'Pérez',ci:'4.567.890',telefono:'0982-222-002',carrera:'FAR',anio:1,division:'B' },
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Alumnos');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename="plantilla_alumnos_ITS.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── ASIGNACIONES ──────────────────────────────────────────────────────────────
// Verificar conflicto de horario para un docente
app.get('/api/asignaciones/conflicto', auth(ADM), (req, res) => {
  const { docente_id, dia, turno, exclude_id } = req.query;
  if (!docente_id || !dia || !turno) return res.json({ tiene_conflicto: false });
  const q = exclude_id
    ? `SELECT a.id, m.nombre as materia FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.docente_id=? AND m.dia=? AND m.turno=? AND a.id!=? LIMIT 1`
    : `SELECT a.id, m.nombre as materia FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.docente_id=? AND m.dia=? AND m.turno=? LIMIT 1`;
  const params = exclude_id ? [docente_id, dia, parseInt(turno), exclude_id] : [docente_id, dia, parseInt(turno)];
  const conflicto = db.prepare(q).get(...params);
  res.json({ tiene_conflicto: !!conflicto, materia: conflicto?.materia || null });
});

app.get('/api/asignaciones', auth(), (req, res) => {
  const { docente_id, curso_id, periodo_id, materia_id } = req.query;
  const sede = req.user.sede || 'pjc';
  let where = 'WHERE ca.sede_id=?'; const params = [sede];
  if (docente_id) { where += ' AND a.docente_id=?'; params.push(docente_id); }
  if (curso_id)   { where += ' AND a.curso_id=?';   params.push(curso_id); }
  if (periodo_id) { where += ' AND a.periodo_id=?'; params.push(periodo_id); }
  if (materia_id) { where += ' AND a.materia_id=?'; params.push(materia_id); }
  res.json(db.prepare(`
    SELECT a.*,
      m.nombre as materia_nombre,m.codigo as materia_codigo,m.anio as materia_anio,
      m.peso_tp,m.peso_parcial,m.peso_final,
      cu.anio as curso_anio,cu.division as curso_division,
      ca.id as carrera_id,
      ca.nombre as carrera_nombre,
      u.nombre as docente_nombre,u.apellido as docente_apellido,
      p.nombre as periodo_nombre,
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND n.puntaje_total IS NOT NULL) as notas_cargadas
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes d ON a.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    JOIN periodos p ON a.periodo_id=p.id
    ${where} ORDER BY ca.nombre,cu.anio,cu.division,m.nombre`).all(...params));
});
app.post('/api/asignaciones', auth(ADM), (req, res) => {
  const { docente_id, materia_id, curso_id, periodo_id, dia, turno, hora_inicio, hora_fin, aula } = req.body;
  try {
    const id = 'asig_'+Date.now();
    db.transaction(() => {
      // Insertar la asignación con datos de horario
      db.prepare('INSERT INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,dia,turno,hora_inicio,hora_fin,aula) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,docente_id,materia_id,curso_id,periodo_id,dia||null,turno||1,hora_inicio||'19:00',hora_fin||'20:20',aula||null);

      // Crear espacio de notas vacías para todos los alumnos activos del curso
      const alumnos = db.prepare("SELECT id FROM alumnos WHERE curso_id=? AND estado='Activo'").all(curso_id);
      alumnos.forEach(al => {
        try {
          db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, id, 'Pendiente');
        } catch {}
      });

      // Registrar en horarios si tiene día asignado
      if (dia) {
        // Detectar conflicto: ¿ya existe otro docente en ese día/turno/curso?
        const conflicto = db.prepare(`
          SELECT a.id, u.nombre, u.apellido, m.nombre as mat FROM asignaciones a
          JOIN docentes d ON a.docente_id=d.id JOIN usuarios u ON d.usuario_id=u.id
          JOIN materias m ON a.materia_id=m.id
          WHERE a.curso_id=? AND a.dia=? AND a.turno=? AND a.id!=? AND a.periodo_id=?`).get(curso_id, dia, turno||1, id, periodo_id);
        if (conflicto) {
          const avisoId = 'av_conf_'+Date.now();
          const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
          if (periodo) {
            try {
              db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,usuario_id) VALUES (?,?,?,?,?,?)').run(
                avisoId,
                `⚠ Conflicto de horario detectado`,
                `Se creó una asignación en ${dia} turno ${turno||1} que coincide con ${conflicto.nombre} ${conflicto.apellido} (${conflicto.mat}) en el mismo curso/turno. Revisar asignaciones.`,
                'urgente', 1, 'u_director'
              );
            } catch {}
          }
        }
        db.prepare('INSERT OR IGNORE INTO horarios (asignacion_id,dia,turno,hora_inicio,hora_fin,aula) VALUES (?,?,?,?,?,?)').run(id, dia, turno||1, hora_inicio||'19:00', hora_fin||'20:20', aula||null);
      }
    })();
    res.json({ id, notas_creadas: true });
  } catch(e) { res.status(400).json({ error: 'Esta asignación ya existe o hubo un error: '+e.message }); }
});
app.put('/api/asignaciones/:id', auth(ADM), (req, res) => {
  const { dia, turno, hora_inicio, hora_fin, aula } = req.body;
  db.prepare('UPDATE asignaciones SET dia=?,turno=?,hora_inicio=?,hora_fin=?,aula=? WHERE id=?').run(dia||null,turno||1,hora_inicio||'19:00',hora_fin||'20:20',aula||null,req.params.id);
  db.prepare('UPDATE horarios SET dia=?,turno=?,hora_inicio=?,hora_fin=?,aula=? WHERE asignacion_id=?').run(dia||null,turno||1,hora_inicio||'19:00',hora_fin||'20:20',aula||null,req.params.id);
  res.json({ ok: true });
});
app.put('/api/asignaciones/:id/docente', auth(ADM), (req, res) => {
  const { docente_id } = req.body;
  if (!docente_id) return res.status(400).json({ error: 'docente_id requerido' });
  db.prepare('UPDATE asignaciones SET docente_id=? WHERE id=?').run(docente_id, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/asignaciones/:id', auth(ADM), (req, res) => {
  const id = req.params.id;
  const del = db.transaction(() => {
    db.prepare('DELETE FROM notas WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM asistencia WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM horarios WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM honorarios WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM actas_examen WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM habilitaciones_examen WHERE asignacion_id=?').run(id);
    const exams = db.prepare('SELECT id FROM examenes WHERE asignacion_id=?').all(id);
    exams.forEach(e => {
      db.prepare('DELETE FROM wa_recordatorios_examen WHERE examen_id=?').run(e.id);
      db.prepare('DELETE FROM notif_wa_enviadas WHERE examen_id=?').run(e.id);
    });
    db.prepare('DELETE FROM examenes WHERE asignacion_id=?').run(id);
    db.prepare('DELETE FROM asignaciones WHERE id=?').run(id);
  });
  del();
  res.json({ ok: true });
});

// Asignaciones por docente — para vista director con estado de carga
app.get('/api/asignaciones/docente/:docente_id', auth(ADM), (req, res) => {
  res.json(db.prepare(`
    SELECT a.id,m.nombre as materia_nombre,m.codigo as materia_codigo,
      ca.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_division,
      p.nombre as periodo_nombre,
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND n.puntaje_total IS NOT NULL) as notas_cargadas,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND n.parcial IS NOT NULL) as parciales_cargados,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND n.final_ord IS NOT NULL) as finales_cargados
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN periodos p ON a.periodo_id=p.id
    WHERE a.docente_id=? ORDER BY ca.nombre,cu.anio,m.nombre`).all(req.params.docente_id));
});

// ── NOTAS ─────────────────────────────────────────────────────────────────────
app.get('/api/notas/asignacion/:asig_id', auth(), (req, res) => {
  const asig = db.prepare('SELECT a.*,m.nombre as materia_nombre FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id=?').get(req.params.asig_id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

  // Obtener carrera_id del curso para el fallback
  const curso = asig.curso_id ? db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asig.curso_id) : null;
  const carrera_id = curso?.carrera_id || null;

  // Query unificada: incluye alumnos con curso_id exacto + alumnos con misma carrera sin curso asignado
  const alumnos = db.prepare(`
    SELECT al.id, al.matricula, al.curso_id as al_curso_id,
      COALESCE(al.ci,u.ci) as alumno_ci,
      COALESCE(al.nombre,u.nombre) as alumno_nombre,
      COALESCE(al.apellido,u.apellido) as alumno_apellido,
      n.id as nota_id,
      n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.tp_total,
      n.parcial,n.parcial_recuperatorio,n.parcial_efectivo,
      n.final_ord,n.final_recuperatorio,n.complementario,n.final_efectivo,
      n.extraordinario,n.ausente,n.director_pts,
      n.puntaje_total,n.nota_final,n.estado as nota_estado,
      CASE WHEN al.habilitado_pago_pendiente=1 OR EXISTS(
        SELECT 1 FROM habilitaciones_examen h
        WHERE h.alumno_id=al.id AND h.asignacion_id=? AND h.habilitado=1
          AND (h.habilitado_recuperatorio=1 OR h.tipo_examen='parcial_recuperatorio')
      ) THEN 1 ELSE 0 END as hab_recuperatorio
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.estado='Activo'
      AND (
        al.curso_id=?
        OR (? IS NOT NULL AND al.carrera_id=? AND al.curso_id IS NULL)
      )
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, req.params.asig_id, asig.curso_id, carrera_id, carrera_id);

  // Auto-asignar curso_id y crear registros de notas para alumnos que no los tienen
  alumnos.forEach(al => {
    try {
      if (!al.al_curso_id && asig.curso_id) {
        db.prepare('UPDATE alumnos SET curso_id=? WHERE id=?').run(asig.curso_id, al.id);
      }
      if (!al.nota_id) {
        db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run(
          'n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, req.params.asig_id, 'Pendiente');
      }
    } catch {}
  });

  res.json({ alumnos, parcial_bloqueado: asig.parcial_bloqueado ? 1 : 0 });
});

app.put('/api/notas/:alumno_id/:asig_id', auth(['director','docente']), (req, res) => {
  try {
    const asig = db.prepare('SELECT docente_id FROM asignaciones WHERE id=?').get(req.params.asig_id);
    // Docente solo puede editar notas de sus materias
    if (req.user.rol === 'docente') {
      const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
      if (!doc || doc.id !== asig?.docente_id) return res.status(403).json({ error: 'Solo podés cargar notas de tus propias materias' });
    }
    // Verificar si el campo que se intenta modificar pertenece a un acta cerrada
    if (req.user.rol === 'docente') {
      const body = req.body;
      const tipoMap = {
        parcial:'Parcial', parcial_recuperatorio:'Recuperatorio',
        final_ord:'Final', final_recuperatorio:'Final Recuperatorio',
        complementario:'Complementario', extraordinario:'Extraordinario'
      };
      for (const [campo, tipo] of Object.entries(tipoMap)) {
        if (body[campo] !== undefined && body[campo] !== '' && body[campo] !== null) {
          const actaCerrada = db.prepare("SELECT id FROM actas_examen WHERE asignacion_id=? AND tipo_examen=? AND estado='cerrada'").get(req.params.asig_id, tipo);
          if (actaCerrada) return res.status(403).json({ error: `El acta de ${tipo} ya fue cerrada. Solo el director puede desbloquearla para modificaciones.` });
        }
      }
    }
    // Docente no puede modificar el parcial ordinario si la asignación lo tiene bloqueado manualmente
    if (req.user.rol === 'docente') {
      const vParcial = req.body.parcial;
      if (vParcial !== undefined && vParcial !== '' && vParcial !== null) {
        const asigInfo = db.prepare('SELECT parcial_bloqueado FROM asignaciones WHERE id=?').get(req.params.asig_id);
        if (asigInfo?.parcial_bloqueado) {
          return res.status(403).json({ error: 'El parcial ordinario está bloqueado para esta materia. Solo el director puede desbloquearlo.' });
        }
      }
    }
    const campos = ['tp1','tp2','tp3','tp4','tp5','parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario','ausente','director_pts'];
    // Validar que todos los valores sean enteros (sin comas ni decimales)
    for (const c of campos) {
      const v = req.body[c];
      if (v === '' || v === undefined || v === null) continue;
      const n = Number(String(v).replace(',', '.'));
      if (!isNaN(n) && !Number.isInteger(n)) {
        return res.status(400).json({ error: `La nota "${c}" tiene valor decimal (${v}). Solo se permiten números enteros.` });
      }
    }
    // Traer el estado actual ANTES de calcular vals: si un campo no vino en este
    // guardado (ej. "parcial" se omite a propósito para docentes), hay que conservar
    // su valor existente en vez de tratarlo como vacío -- de lo contrario cada guardado
    // de CUALQUIER otro campo borra silenciosamente los campos ausentes del payload
    // (esto pasó de verdad: guardar "final_ord" como docente borraba el "parcial" ya
    // cargado, porque el payload del docente nunca incluye ese campo).
    const antes = db.prepare(`SELECT ${campos.join(',')} FROM notas WHERE alumno_id=? AND asignacion_id=?`).get(req.params.alumno_id, req.params.asig_id) || {};
    const { mergeCamposNota } = require('./db');
    const vals = mergeCamposNota(campos, antes, req.body);
    // Validar que la suma de TPs (tp1+tp2+tp3+tp4) no supere 20 puntos
    const tpSum = [vals[0],vals[1],vals[2],vals[3]].reduce((s,v)=>s+(v??0),0);
    if (tpSum > 20) {
      return res.status(400).json({ error: `La suma de TPs (${tpSum}pts) supera el máximo permitido de 20 puntos. Corrija los valores.` });
    }
    // NOTA: el docente ya no queda bloqueado por falta de pago del alumno (cuotas o
    // arancel de examen) -- la grilla de carga de notas está siempre desbloqueada.
    // La habilitación por pago sigue existiendo igual que antes (habilitaciones_examen,
    // compromisos_pago, etc.) pero ahora solo controla si el ALUMNO puede VER su nota
    // (ver GET /api/notas/alumno/:alumno_id), no si el docente puede cargarla.
    const { calcularPuntaje } = require('./db');
    // vals[0..10] = tp1..extraordinario, vals[12] = director_pts
    const nota = calcularPuntaje(...vals.slice(0,11), vals[12]);
    const campos_q = campos.map(c=>`${c}=?`).join(',');
    const extra = ',tp_total=?,puntaje_total=?,nota_final=?,estado=?,parcial_efectivo=?,final_efectivo=?';
    db.prepare(`UPDATE notas SET ${campos_q}${extra} WHERE alumno_id=? AND asignacion_id=?`).run(...vals, nota.tp_total, nota.puntaje, nota.nota, nota.estado, nota.parcial_ef, nota.final_ef, req.params.alumno_id, req.params.asig_id);
    audit(req.user.id,'UPDATE_NOTA','notas',`${req.params.alumno_id}_${req.params.asig_id}`,{antes,campos:req.body});
    // Detección en tiempo real de posible pérdida de datos: si algún campo tenía valor y ahora
    // se guarda vacío, dejar un registro aparte en Auditoría para poder encontrarlo al toque en
    // vez de tener que reconstruirlo del historial completo como pasó con Villar/Natalia (costó
    // 66 notas perdidas y 2 meses sin que nadie se enterara). Además: aviso no-banner para el
    // director (queda en Avisos, no interrumpe Inicio) y WhatsApp al profesor Gabriel Sharp,
    // pedido explícito del director para no depender de que alguien revise auditoría a mano.
    const perdidos = campos.filter(c => {
      if (!(c in req.body)) return false; // campo ni siquiera formaba parte de este guardado (ej. "ausente" o "parcial" para un docente) -- no es perdida
      const teniaAntes = antes[c] !== undefined && antes[c] !== null && antes[c] !== '';
      const vNuevo = req.body[c];
      const quedaVacio = vNuevo === '' || vNuevo === undefined || vNuevo === null;
      return teniaAntes && quedaVacio;
    });
    if (perdidos.length) {
      audit(req.user.id,'POSIBLE_PERDIDA_NOTA','notas',`${req.params.alumno_id}_${req.params.asig_id}`,
        { campos_perdidos: perdidos, valores_perdidos: Object.fromEntries(perdidos.map(c=>[c,antes[c]])) });
      try {
        const al = db.prepare('SELECT nombre,apellido FROM alumnos WHERE id=?').get(req.params.alumno_id);
        const asigInfo = db.prepare('SELECT m.nombre as materia FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id=?').get(req.params.asig_id);
        const detalle = perdidos.map(c => `${c}: tenía ${antes[c]}, quedó vacío`).join('; ');
        const alumnoTxt = al ? `${al.apellido}, ${al.nombre}` : req.params.alumno_id;
        const materiaTxt = asigInfo?.materia || req.params.asig_id;
        const director = db.prepare("SELECT id FROM usuarios WHERE rol='director' AND activo=1 LIMIT 1").get();
        if (director) {
          db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)')
            .run('av_perdnota_' + Date.now(), '⚠️ Posible pérdida de nota', `Alumno: <strong>${alumnoTxt}</strong> — Materia: <strong>${materiaTxt}</strong><br>${detalle}`, 'info', 0, 'director', director.id);
        }
        const docSharp = db.prepare("SELECT telefono FROM docentes WHERE id='doc_sharp'").get();
        if (docSharp?.telefono) {
          const msg = `⚠️ Posible pérdida de nota detectada\nAlumno: ${alumnoTxt}\nMateria: ${materiaTxt}\n${detalle}`;
          sendWhatsApp(docSharp.telefono, msg).catch(()=>{});
        }
      } catch(e) { console.warn('[POSIBLE_PERDIDA_NOTA] Error al avisar:', e.message); }
    }
    res.json({ puntaje: nota.puntaje, nota: nota.nota, estado: nota.estado, tp_total: nota.tp_total, parcial_efectivo: nota.parcial_ef, final_efectivo: nota.final_ef });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MORA: cantidad de meses de mensualidad (cuota) vencidos y no pagados ──────
// Cuota 1=marzo ... Cuota 10=diciembre, Cuota 11=enero, Cuota 12=febrero (año
// escolar paraguayo). La cuota de CADA mes vence el día 10 de ese mismo mes:
// hasta el 10 inclusive hay margen para pagarla, desde el 11 ya bloquea si sigue
// impaga. Ej.: la cuota de julio vence el 10 de julio — recién bloquea desde el
// 11 de julio si para esa fecha no se pagó.
const MES_A_CUOTA_NUM = { 3:1, 4:2, 5:3, 6:4, 7:5, 8:6, 9:7, 10:8, 11:9, 12:10, 1:11, 2:12 };
function cuotaLimiteVencida() {
  const hoy = pyNow();
  const cuotaMesActual = MES_A_CUOTA_NUM[hoy.getMonth() + 1] || 1;
  // Del 1 al 10 del mes: todavía no se exige la cuota de este mes (margen normal).
  // Del 11 en adelante: la cuota de este mes ya entra a la cuenta de vencidas.
  const limite = hoy.getDate() > 10 ? cuotaMesActual : cuotaMesActual - 1;
  return Math.max(0, limite);
}
function tieneBecaTotal(alumno_id) {
  const hoy = nowDate();
  return !!db.prepare(
    `SELECT 1 FROM becas WHERE alumno_id=? AND tipo='Beca Total' AND activa=1
       AND fecha_inicio<=? AND (fecha_fin IS NULL OR fecha_fin>=?) LIMIT 1`
  ).get(alumno_id, hoy, hoy);
}
function calcularMesesDeuda(alumno_id) {
  // Beca Total: exonerada de la mensualidad — nunca "debe" cuotas, aunque no las
  // pague. Sigue sujeta al arancel de examen (regla aparte, sin cambios).
  if (tieneBecaTotal(alumno_id)) return { meses_deuda: 0, cuotas_faltantes: [], becado_total: true };
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return { meses_deuda: 0, cuotas_faltantes: [] };
  const cuotaLimite = cuotaLimiteVencida();
  // Solo exigir cuotas desde el mes de ingreso del alumno: un alumno que ingresó
  // en mayo no puede deber la cuota de marzo. Sin esto, cualquier alumno inscripto
  // después de marzo queda bloqueado aunque esté al día desde su primer mes.
  const al = db.prepare('SELECT fecha_ingreso FROM alumnos WHERE id=?').get(alumno_id);
  let cuotaInicio = 1;
  if (al?.fecha_ingreso) {
    const mesIngreso = new Date(al.fecha_ingreso + 'T00:00:00').getMonth() + 1;
    // Semestre 1 (mar–jul): desde cuota 1. Semestre 2 (ago–dic): desde cuota 6.
    // No importa el mes exacto dentro del semestre — siempre desde el inicio del semestre.
    cuotaInicio = mesIngreso >= 8 ? 6 : 1;
  }
  const cuotasVencidas = Array.from({ length: cuotaLimite }, (_, i) => 'Cuota ' + (i + 1))
    .filter(c => parseInt(c.split(' ')[1]) >= cuotaInicio);
  const conceptosPagados = db.prepare(
    `SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'`
  ).all(alumno_id, periodo.id).map(p => p.concepto);
  const cuotas_faltantes = cuotasVencidas.filter(c => !conceptosPagados.includes(c));
  return { meses_deuda: cuotas_faltantes.length, cuotas_faltantes };
}
const UMBRAL_BLOQUEO_NOTAS = 1; // meses de mensualidad adeudados para ocultar puntajes al alumno
const MSG_MORA_NOTAS = 'Estimado/a alumno/a: para poder acceder a su proceso y a los puntajes de sus materias debe ponerse al día con sus cuotas mensuales. Diríjase a Dirección para regularizar su situación.';
const LIBERAR_NOTAS_HORAS = 48; // la liberación manual del director vence sola a las 48hs
function notasLiberadasHasta(alumno_id) {
  return db.prepare('SELECT notas_liberadas_hasta FROM alumnos WHERE id=?').get(alumno_id)?.notas_liberadas_hasta || null;
}
function notasLiberadas(alumno_id) {
  const hasta = notasLiberadasHasta(alumno_id);
  return !!hasta && new Date(hasta.replace(' ', 'T') + 'Z') > nowSys();
}

// ── VERIFICAR ESTADO DE MORA — para mostrar el aviso antes de cargar notas ────
app.get('/api/alumnos/:id/estado-mora', auth(), (req, res) => {
  if (req.user.rol === 'alumno' && req.user.alumnoId !== req.params.id) return res.status(403).json({ error: 'Sin acceso' });
  const { meses_deuda, cuotas_faltantes } = calcularMesesDeuda(req.params.id);
  const liberado = notasLiberadas(req.params.id);
  res.json({
    meses_deuda, cuotas_faltantes, liberado,
    liberado_hasta: liberado ? notasLiberadasHasta(req.params.id) : null,
    bloqueado: !liberado && meses_deuda >= UMBRAL_BLOQUEO_NOTAS,
    mensaje: MSG_MORA_NOTAS,
  });
});

// ── LIBERAR (por 48hs) / RE-BLOQUEAR manualmente el acceso a notas de UN alumno (solo director) ──
app.put('/api/alumnos/:id/liberar-notas', auth(ADM), (req, res) => {
  const al = db.prepare('SELECT id FROM alumnos WHERE id=?').get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const liberar = !!req.body.liberar;
  const hastaStr = liberar ? new Date(nowSys().getTime() + LIBERAR_NOTAS_HORAS * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : null;
  db.prepare('UPDATE alumnos SET notas_liberadas_hasta=? WHERE id=?').run(hastaStr, req.params.id);
  audit(req.user.id, liberar ? 'LIBERAR_NOTAS' : 'BLOQUEAR_NOTAS', 'alumnos', req.params.id, { liberar, hasta: hastaStr });
  res.json({ ok: true, liberado: liberar, liberado_hasta: hastaStr });
});

app.get('/api/notas/alumno/:alumno_id', auth(), (req, res) => {
  // Si el propio alumno tiene mensualidades sin pagar (y el director no liberó el
  // acceso manualmente), NO se bloquea toda la pantalla — solo se oculta la nota
  // final/calificación de cada materia (TP y Parcial siguen visibles). Se resuelve
  // más abajo, junto con el ocultamiento ya existente por arancel de examen impago.
  const alumnoEnMoraMensualidad = req.user.rol === 'alumno' && !notasLiberadas(req.params.alumno_id)
    && calcularMesesDeuda(req.params.alumno_id).meses_deuda >= UMBRAL_BLOQUEO_NOTAS;
  const rows = db.prepare(`
    SELECT a.id as asignacion_id, m.nombre as materia_nombre, m.peso_tp, m.peso_parcial, m.peso_final,
      p.nombre as periodo_nombre, ca.nombre as carrera_nombre, cu.anio as curso_anio,
      n.tp1, n.tp2, n.tp3, n.tp4, n.tp5, n.tp_total, n.parcial, n.parcial_recuperatorio,
      n.final_ord, n.final_recuperatorio, n.complementario, n.extraordinario, n.ausente,
      n.puntaje_total, n.nota_final, n.estado, n.parcial_efectivo, n.final_efectivo, n.director_pts
    FROM alumnos al
    JOIN cursos cu ON al.curso_id = cu.id
    JOIN carreras ca ON cu.carrera_id = ca.id
    JOIN asignaciones a ON a.curso_id = al.curso_id
    JOIN materias m ON a.materia_id = m.id
    JOIN periodos p ON a.periodo_id = p.id
    LEFT JOIN notas n ON n.asignacion_id = a.id AND n.alumno_id = al.id
    WHERE al.id = ? ORDER BY m.nombre`).all(req.params.alumno_id);

  // Ocultar el puntaje del examen final si el alumno está en mora de cuotas y no pagó
  // el arancel de ESA materia específica (misma regla que /api/alumnos/habilitaciones-bulk:
  // cuotas 1-5 al día = habilitado para todo; en mora = requiere habilitación por asignación).
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  let cuotasAlDia = true;
  if (periodo) {
    const cuotasRequeridas = ['Cuota 1', 'Cuota 2', 'Cuota 3', 'Cuota 4', 'Cuota 5'];
    const conceptos = db.prepare(`SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'`)
      .all(req.params.alumno_id, periodo.id).map(p => p.concepto);
    cuotasAlDia = cuotasRequeridas.every(c => conceptos.includes(c));
  }
  const FINAL_CAMPOS = ['final_ord', 'final_recuperatorio', 'complementario', 'extraordinario'];
  let habSet = null;
  if (!cuotasAlDia) {
    habSet = new Set(
      db.prepare(`SELECT asignacion_id, tipo_examen FROM habilitaciones_examen WHERE alumno_id=? AND habilitado=1`)
        .all(req.params.alumno_id).map(h => h.asignacion_id + '|' + h.tipo_examen)
    );
  }
  const out = rows.map(r => {
    let row = r;
    if (!cuotasAlDia) {
      const campoConValor = FINAL_CAMPOS.find(c => row[c] !== null && row[c] !== undefined);
      if (campoConValor && !habSet.has(row.asignacion_id + '|' + campoConValor)) {
        row = { ...row, final_ord: null, final_recuperatorio: null, complementario: null, extraordinario: null,
          puntaje_total: null, nota_final: null, estado: 'Pendiente de pago', pago_final_pendiente: true };
      }
    }
    // Mora de mensualidad (1+ meses): oculta la nota final igual, con mensaje propio,
    // salvo que ya esté oculta por el motivo de arriba (arancel de examen impago).
    if (alumnoEnMoraMensualidad && !row.pago_final_pendiente) {
      const campoConValor = FINAL_CAMPOS.find(c => row[c] !== null && row[c] !== undefined);
      if (campoConValor) {
        row = { ...row, final_ord: null, final_recuperatorio: null, complementario: null, extraordinario: null,
          puntaje_total: null, nota_final: null, estado: 'Pendiente de pago', mora_mensualidad_pendiente: true };
      }
    }
    // Recuperatorio de parcial: el docente ya puede cargarlo sin habilitación, pero el
    // alumno solo lo ve si pagó el arancel del recuperatorio (misma condición que antes
    // bloqueaba al docente, ahora se aplica del lado de la visualización).
    if (row.parcial_recuperatorio !== null && row.parcial_recuperatorio !== undefined) {
      const habRec = db.prepare(`SELECT 1 FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND habilitado=1 AND (habilitado_recuperatorio=1 OR tipo_examen='parcial_recuperatorio') LIMIT 1`).get(req.params.alumno_id, row.asignacion_id);
      if (!habRec) {
        row = { ...row, parcial_recuperatorio: null, parcial_efectivo: null, puntaje_total: null, nota_final: null, estado: 'Pendiente de pago', pago_recuperatorio_pendiente: true };
      }
    }
    return row;
  });
  res.json(out);
});

// Acta de calificaciones por asignación (para imprimir)
app.get('/api/notas/acta/:asig_id', auth(), (req, res) => {
  const asig = db.prepare(`
    SELECT a.*,m.nombre as materia_nombre,m.codigo as materia_codigo,m.peso_tp,m.peso_parcial,m.peso_final,
      ca.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_division,
      u.nombre as docente_nombre,u.apellido as docente_apellido,u2.titulo as docente_titulo,
      p.nombre as periodo_nombre,p.anio as periodo_anio
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes u2 ON a.docente_id=u2.id
    JOIN usuarios u ON u2.usuario_id=u.id
    JOIN periodos p ON a.periodo_id=p.id
    WHERE a.id=?`).get(req.params.asig_id);
  if (!asig) return res.status(404).json({ error: 'No encontrado' });
  const carrera_id_acta = asig.curso_id ? db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asig.curso_id)?.carrera_id : null;
  const alumnos = db.prepare(`
    SELECT al.matricula,
      COALESCE(al.ci,u.ci) as ci,
      COALESCE(al.nombre,u.nombre) as nombre,
      COALESCE(al.apellido,u.apellido) as apellido,
      n.tp1,n.tp2,n.tp3,n.tp4,n.tp5,n.tp_total,
      n.parcial,n.parcial_recuperatorio,n.parcial_efectivo,
      n.final_ord,n.final_recuperatorio,n.complementario,n.final_efectivo,
      n.extraordinario,n.ausente,n.puntaje_total,n.nota_final,n.estado
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.estado='Activo'
      AND (al.curso_id=? OR (? IS NOT NULL AND al.carrera_id=? AND al.curso_id IS NULL))
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, asig.curso_id, carrera_id_acta, carrera_id_acta);
  res.json({ asig, alumnos, inst: db.prepare('SELECT * FROM institucion WHERE id=1').get() });
});

// ── ACTAS DE EXAMEN ───────────────────────────────────────────────────────────
// Listar actas (director ve todas, docente ve las suyas)
app.get('/api/actas-examen', auth(['director','docente']), (req, res) => {
  try {
    const doc = req.user.rol === 'docente' ? db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id) : null;
    let q = `SELECT ae.*,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      p.nombre as periodo_nombre
      FROM actas_examen ae
      JOIN asignaciones a ON ae.asignacion_id=a.id
      JOIN materias m ON a.materia_id=m.id
      JOIN cursos cu ON a.curso_id=cu.id
      JOIN carreras ca ON cu.carrera_id=ca.id
      JOIN docentes d ON ae.docente_id=d.id
      JOIN usuarios u ON d.usuario_id=u.id
      JOIN periodos p ON a.periodo_id=p.id`;
    const params = [];
    if (doc) { q += ' WHERE ae.docente_id=?'; params.push(doc.id); }
    q += ' ORDER BY ae.fecha_cierre DESC';
    res.json(db.prepare(q).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verificar si ya existe acta cerrada para (asignacion, tipo)
app.get('/api/actas-examen/check', auth(['director','docente']), (req, res) => {
  try {
    const { asignacion_id, tipo_examen } = req.query;
    const acta = db.prepare("SELECT id,estado FROM actas_examen WHERE asignacion_id=? AND tipo_examen=?").get(asignacion_id, tipo_examen);
    res.json({ acta: acta || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear y cerrar acta de examen
app.post('/api/actas-examen', auth(['director','docente']), (req, res) => {
  try {
    const { asignacion_id, tipo_examen, alumnos_faltantes, observacion } = req.body;
    if (!asignacion_id || !tipo_examen) return res.status(400).json({ error: 'Faltan datos' });
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    const docId = doc?.id || req.body.docente_id;
    if (!docId && req.user.rol !== 'director') return res.status(400).json({ error: 'No se identificó al docente' });
    // Verificar que no exista ya
    const existe = db.prepare("SELECT id FROM actas_examen WHERE asignacion_id=? AND tipo_examen=?").get(asignacion_id, tipo_examen);
    if (existe) return res.status(409).json({ error: 'Ya existe un acta cerrada para este examen. Solo el director puede desbloquearla.' });
    const asig = db.prepare('SELECT periodo_id FROM asignaciones WHERE id=?').get(asignacion_id);
    const id = 'acta_' + Date.now();
    db.prepare(`INSERT INTO actas_examen (id,asignacion_id,tipo_examen,docente_id,estado,alumnos_faltantes,observacion,periodo_id,fecha_cierre)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(id, asignacion_id, tipo_examen, docId || req.user.id, 'cerrada',
        alumnos_faltantes ? JSON.stringify(alumnos_faltantes) : null, observacion || null, asig?.periodo_id || null);
    audit(req.user.id, 'CERRAR_ACTA', 'actas_examen', id, { asignacion_id, tipo_examen });
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Director desbloquea acta
app.put('/api/actas-examen/:id/desbloquear', auth(ADM), (req, res) => {
  try {
    const { motivo } = req.body;
    if (!motivo) return res.status(400).json({ error: 'Se requiere motivo para desbloquear' });
    db.prepare("UPDATE actas_examen SET estado='desbloqueada', desbloqueada_por=?, motivo_desbloqueo=?, fecha_desbloqueo=datetime('now') WHERE id=?")
      .run(req.user.id, motivo, req.params.id);
    audit(req.user.id, 'DESBLOQUEAR_ACTA', 'actas_examen', req.params.id, { motivo });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Director bloquea/desbloquea parcial ordinario de una asignación
app.put('/api/asignaciones/:id/parcial-bloqueo', auth(ADM), (req, res) => {
  const { bloquear } = req.body; // true = bloquear, false = desbloquear
  const asig = db.prepare('SELECT id, parcial_bloqueado FROM asignaciones WHERE id=?').get(req.params.id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
  const nuevoEstado = bloquear ? 1 : 0;
  db.prepare('UPDATE asignaciones SET parcial_bloqueado=? WHERE id=?').run(nuevoEstado, req.params.id);
  audit(req.user.id, nuevoEstado ? 'BLOQUEAR_PARCIAL' : 'DESBLOQUEAR_PARCIAL', 'asignaciones', req.params.id, {});
  res.json({ ok: true, parcial_bloqueado: nuevoEstado });
});

// ── ASISTENCIA ────────────────────────────────────────────────────────────────
app.get('/api/asistencia/asignacion/:asig_id', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT as2.*,COALESCE(al.nombre,u.nombre) as alumno_nombre,COALESCE(al.apellido,u.apellido) as alumno_apellido
    FROM asistencia as2 JOIN alumnos al ON as2.alumno_id=al.id LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE as2.asignacion_id=? ORDER BY as2.fecha,COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id));
});
// Modificar un registro individual de asistencia
app.put('/api/asistencia/:id', auth(['director','docente']), (req, res) => {
  const { estado, observacion } = req.body;
  db.prepare('UPDATE asistencia SET estado=?,observacion=? WHERE id=?').run(estado, observacion||null, req.params.id);
  res.json({ ok: true });
});
// Eliminar un registro individual de asistencia
app.delete('/api/asistencia/:id', auth(['director','docente']), (req, res) => {
  db.prepare('DELETE FROM asistencia WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Consulta de asistencia por alumno — resumen consolidado
// Detalle de asistencia del alumno (lista de fechas)
// Detalle de asistencia del alumno (lista de fechas)
app.get('/api/asistencia/detalle-alumno/:alumno_id', auth(), (req, res) => {
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (!al || al.id !== req.params.alumno_id) return res.status(403).json({ error: 'Sin acceso' });
  }
  const rows = db.prepare(`
    SELECT a.fecha, a.estado, a.observacion,
      m.nombre as materia, ca.nombre as carrera, cu.anio
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN materias m ON asig.materia_id=m.id
    JOIN cursos cu ON asig.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE a.alumno_id=?
    ORDER BY a.fecha DESC, m.nombre`).all(req.params.alumno_id);
  res.json(rows);
});

app.get('/api/asistencia/resumen-alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT id,usuario_id,curso_id FROM alumnos WHERE id=?').get(req.params.alumno_id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  if (req.user.rol === 'alumno' && al.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });

  const mes = req.query.mes || null; // formato 'YYYY-MM'

  // Resumen por materia (filtrado por mes si se indica)
  const mesFilter = mes ? ' AND strftime(\'%Y-%m\', a.fecha) = ?' : '';
  const mesParam  = mes ? [req.params.alumno_id, mes] : [req.params.alumno_id];
  const registros = db.prepare(`
    SELECT a.estado, m.nombre as materia, COUNT(*) as total
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN materias m ON asig.materia_id=m.id
    WHERE a.alumno_id=?${mesFilter}
    GROUP BY a.asignacion_id, a.estado
    ORDER BY m.nombre`).all(...mesParam);

  const todasMaterias = al.curso_id ? db.prepare(`
    SELECT DISTINCT m.nombre as materia
    FROM asignaciones asig JOIN materias m ON asig.materia_id=m.id
    WHERE asig.curso_id=? ORDER BY m.nombre`).all(al.curso_id) : [];

  const porMateria = {};
  todasMaterias.forEach(m => { porMateria[m.materia] = { materia: m.materia, P: 0, A: 0, T: 0, J: 0 }; });
  registros.forEach(r => {
    if (!porMateria[r.materia]) porMateria[r.materia] = { materia: r.materia, P: 0, A: 0, T: 0, J: 0 };
    porMateria[r.materia][r.estado] = (porMateria[r.materia][r.estado] || 0) + r.total;
  });
  const resumen = Object.values(porMateria).map(m => ({
    ...m, total: m.P+m.A+m.T+m.J,
    pct: m.P+m.A+m.T+m.J > 0 ? Math.round(m.P/(m.P+m.A+m.T+m.J)*100) : 0
  }));

  // Meses disponibles (para mostrar tabs)
  const meses = db.prepare(`
    SELECT strftime('%Y-%m', a.fecha) as mes, COUNT(*) as clases,
      SUM(CASE WHEN a.estado='P' THEN 1 ELSE 0 END) as presentes,
      SUM(CASE WHEN a.estado='A' THEN 1 ELSE 0 END) as ausentes,
      SUM(CASE WHEN a.estado='J' THEN 1 ELSE 0 END) as justificados
    FROM asistencia a
    WHERE a.alumno_id=?
    GROUP BY mes ORDER BY mes DESC`).all(req.params.alumno_id)
    .map(m => ({ ...m, pct: m.clases > 0 ? Math.round(m.presentes/m.clases*100) : 0 }));

  res.json({ resumen, meses });
});
app.post('/api/asistencia/bulk', auth(['director','docente']), (req, res) => {
  const { asignacion_id, fecha, registros } = req.body;
  if (!asignacion_id || !fecha || !registros?.length) return res.status(400).json({ error: 'Datos incompletos' });

  // Verificar feriado
  const feriado = db.prepare("SELECT id FROM feriados WHERE fecha=? AND activo=1").get(fecha);
  if (feriado) return res.status(400).json({ error: 'No se puede registrar asistencia en un día feriado' });

  // Verificar que el docente solo registre en sus propias materias (o sea director)
  const asig = db.prepare('SELECT * FROM asignaciones WHERE id=?').get(asignacion_id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    if (!doc || doc.id !== asig.docente_id) {
      return res.status(403).json({ error: 'Solo podés registrar asistencia en tus propias materias. Usá la función de Reemplazo si estás supliendo a un colega.' });
    }
  }

  db.transaction(() => {
    registros.forEach(r => {
      db.prepare('INSERT OR REPLACE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado,observacion) VALUES (?,?,?,?,?,?)')
        .run('as_'+Date.now()+'_'+Math.random().toString(36).slice(2,4), r.alumno_id, asignacion_id, fecha, r.estado, r.observacion||null);
    });

    // ── GENERAR HONORARIO AUTOMÁTICAMENTE ────────────────────────────────────
    // Solo se genera si hay al menos 1 alumno presente
    const hayPresentes = registros.some(r => r.estado === 'P');
    if (hayPresentes && asig.docente_id) {
      const turno = asig.turno || 1;
      const horId = 'hon_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
      // Evitar duplicado para el mismo docente/asignación/fecha
      const existe = db.prepare("SELECT id FROM honorarios WHERE docente_id=? AND asignacion_id=? AND fecha=? AND tipo='clase'").get(asig.docente_id, asignacion_id, fecha);
      if (!existe) {
        db.prepare('INSERT INTO honorarios (id,docente_id,asignacion_id,fecha,turno,monto,estado,tipo) VALUES (?,?,?,?,?,?,?,?)')
          .run(horId, asig.docente_id, asignacion_id, fecha, turno, 80000, 'generado', 'clase');
      }
    }
  })();
  // Obtener info de la asignación para auditoría detallada
  try {
    const asigInfo = db.prepare(`
      SELECT m.nombre as materia, ca.nombre as carrera, cu.anio, cu.division,
             u.nombre as doc_nombre, u.apellido as doc_apellido
      FROM asignaciones a
      JOIN materias m ON a.materia_id=m.id
      JOIN cursos cu ON a.curso_id=cu.id
      JOIN carreras ca ON cu.carrera_id=ca.id
      JOIN docentes d ON a.docente_id=d.id
      JOIN usuarios u ON d.usuario_id=u.id
      WHERE a.id=?`).get(asignacion_id);
    const presentes = registros.filter(r=>r.estado==='P').length;
    const ausentes  = registros.filter(r=>r.estado==='A').length;
    audit(req.user.id, 'UPDATE_ASISTENCIA', 'asistencia', asignacion_id, {
      fecha, total: registros.length, presentes, ausentes,
      materia: asigInfo?.materia,
      carrera: asigInfo?.carrera,
      anio: asigInfo?.anio ? asigInfo.anio+'° año' : null,
      seccion: asigInfo?.division && asigInfo.division!=='U' ? 'Sección '+asigInfo.division : 'Única',
      docente: asigInfo ? `${asigInfo.doc_nombre} ${asigInfo.doc_apellido}` : null
    });
  } catch { audit(req.user.id, 'UPDATE_ASISTENCIA', 'asistencia', asignacion_id, { fecha, total: registros.length }); }
  res.json({ ok: true });
});
app.get('/api/honorarios', auth(ADM), (req, res) => {
  const { docente_id, mes, anio, estado } = req.query;
  const sede = req.user.sede || 'pjc';
  let where = 'WHERE d.sede_id=?'; const params = [sede];
  if (docente_id)    { where += ' AND h.docente_id=?';  params.push(docente_id); }
  if (estado) { where += ' AND h.estado=?';       params.push(estado); }
  if (anio && mes) {
    const desde = `${anio}-${String(mes).padStart(2,'0')}-01`;
    const hasta = `${anio}-${String(mes).padStart(2,'0')}-${new Date(parseInt(anio),parseInt(mes),0).getDate()}`;
    where += ' AND h.fecha>=? AND h.fecha<=?'; params.push(desde, hasta);
  } else if (anio) {
    where += ' AND strftime("%Y",h.fecha)=?'; params.push(String(anio));
  }
  res.json(db.prepare(`
    SELECT h.*,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      a.turno as asig_turno, a.hora_inicio, a.hora_fin
    FROM honorarios h
    JOIN docentes d ON h.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    LEFT JOIN asignaciones a ON h.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    ${where} ORDER BY h.fecha DESC, h.turno`).all(...params));
});

app.put('/api/honorarios/:id', auth(ADM), (req, res) => {
  const { estado, observacion } = req.body;
  db.prepare('UPDATE honorarios SET estado=?,observacion=? WHERE id=?').run(estado, observacion||null, req.params.id);
  res.json({ ok: true });
});

// ── REEMPLAZOS ────────────────────────────────────────────────────────────────
app.get('/api/reemplazos', auth(['director','docente']), (req, res) => {
  const { estado } = req.query;
  let dId = null;
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    dId = doc?.id;
  }
  let where = 'WHERE 1=1'; const params = [];
  if (dId) { where += ' AND (r.docente_titular_id=? OR r.docente_reemplazante_id=?)'; params.push(dId,dId); }
  if (estado) { where += ' AND r.estado=?'; params.push(estado); }
  res.json(db.prepare(`
    SELECT r.*,
      ut.nombre as titular_nombre, ut.apellido as titular_apellido,
      ur.nombre as reemplazante_nombre, ur.apellido as reemplazante_apellido,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, a.turno as asig_turno,
      ub.nombre as registrado_nombre, ub.apellido as registrado_apellido
    FROM reemplazos r
    JOIN docentes dt ON r.docente_titular_id=dt.id JOIN usuarios ut ON dt.usuario_id=ut.id
    JOIN docentes dr ON r.docente_reemplazante_id=dr.id JOIN usuarios ur ON dr.usuario_id=ur.id
    JOIN asignaciones a ON r.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN usuarios ub ON r.registrado_por=ub.id
    ${where} ORDER BY r.fecha DESC`).all(...params));
});

app.post('/api/reemplazos', auth(['director','docente']), (req, res) => {
  const { asignacion_id, docente_reemplazante_id, fecha, motivo } = req.body;
  if (!asignacion_id || !docente_reemplazante_id || !fecha) return res.status(400).json({ error: 'Datos incompletos' });
  const asig = db.prepare('SELECT * FROM asignaciones WHERE id=?').get(asignacion_id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
  // Verificar que quien registra es el director o el titular
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    if (!doc || doc.id !== asig.docente_id) return res.status(403).json({ error: 'La materia seleccionada no coincide con la carrera o no está asignada a este docente' });
  }
  // El reemplazante no puede ser el mismo titular
  if (docente_reemplazante_id === asig.docente_id) return res.status(400).json({ error: 'El reemplazante no puede ser el mismo docente titular' });
  const id = 'rep_'+Date.now();
  db.prepare('INSERT INTO reemplazos (id,asignacion_id,docente_titular_id,docente_reemplazante_id,fecha,turno,motivo,estado,registrado_por) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, asignacion_id, asig.docente_id, docente_reemplazante_id, fecha, asig.turno||1, motivo||null, 'pendiente', req.user.id);
  // Notificar mediante aviso automático
  try {
    const docReemplazante = db.prepare('SELECT u.nombre,u.apellido FROM docentes d JOIN usuarios u ON d.usuario_id=u.id WHERE d.id=?').get(docente_reemplazante_id);
    const mat = db.prepare('SELECT m.nombre FROM materias m JOIN asignaciones a ON a.materia_id=m.id WHERE a.id=?').get(asignacion_id);
    db.prepare("INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)").run(
      'av_rep_'+Date.now(),
      '🔄 Reemplazo pendiente de aprobación',
      `Se registró un reemplazo para la fecha ${fecha}. Reemplazante: ${docReemplazante?.nombre||''} ${docReemplazante?.apellido||''}. Materia: ${mat?.nombre||''}. Pendiente de aprobación del Director.`,
      'urgente', 1, 'docentes', req.user.id
    );
  } catch {}
  res.json({ id, estado: 'pendiente' });
});

app.put('/api/reemplazos/:id/aprobar', auth(ADM), (req, res) => {
  const rep = db.prepare('SELECT * FROM reemplazos WHERE id=?').get(req.params.id);
  if (!rep) return res.status(404).json({ error: 'Reemplazo no encontrado' });
  const { accion } = req.body; // 'aprobar' o 'rechazar'
  if (accion === 'aprobar') {
    db.transaction(() => {
      db.prepare("UPDATE reemplazos SET estado='aprobado',aprobado_por=?,fecha_aprobacion=date('now') WHERE id=?").run(req.user.id, rep.id);
      // Generar honorario para el reemplazante
      const horId = 'hon_rep_'+Date.now();
      db.prepare('INSERT OR IGNORE INTO honorarios (id,docente_id,asignacion_id,fecha,turno,monto,estado,tipo,reemplazo_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(horId, rep.docente_reemplazante_id, rep.asignacion_id, rep.fecha, rep.turno, 80000, 'generado', 'reemplazo', rep.id);
      // Anular honorario del titular si existía
      db.prepare("UPDATE honorarios SET estado='anulado',observacion='Reemplazado' WHERE docente_id=? AND asignacion_id=? AND fecha=? AND tipo='clase'")
        .run(rep.docente_titular_id, rep.asignacion_id, rep.fecha);
      // Aviso de aprobación al reemplazante
      try {
        const docRep = db.prepare('SELECT u.nombre,u.apellido,d.usuario_id FROM docentes d JOIN usuarios u ON d.usuario_id=u.id WHERE d.id=?').get(rep.docente_reemplazante_id);
        db.prepare("INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)").run(
          'av_aprep_'+Date.now(),'✅ Reemplazo aprobado',
          `Tu reemplazo del ${rep.fecha} fue aprobado por el Director. Se acreditaron Gs. 80.000 en tu perfil de honorarios.`,
          'info',0,'docentes',req.user.id);
      } catch {}
    })();
  } else {
    db.prepare("UPDATE reemplazos SET estado='rechazado',aprobado_por=?,fecha_aprobacion=date('now') WHERE id=?").run(req.user.id, rep.id);
  }
  res.json({ ok: true });
});

// ── FERIADOS ──────────────────────────────────────────────────────────────────
app.get('/api/feriados', auth(), (req, res) => {
  res.json(db.prepare("SELECT * FROM feriados WHERE activo=1 ORDER BY fecha").all());
});
app.post('/api/feriados', auth(ADM), (req, res) => {
  const { fecha, nombre, tipo } = req.body;
  if (!fecha || !nombre) return res.status(400).json({ error: 'Fecha y nombre requeridos' });
  const id = 'fer_'+Date.now();
  db.prepare('INSERT OR IGNORE INTO feriados (id,fecha,nombre,tipo) VALUES (?,?,?,?)').run(id, fecha, nombre, tipo||'institucional');
  // Detectar exámenes programados en esa fecha
  const examenes_conflicto = db.prepare(`
    SELECT e.id, e.tipo, e.fecha, e.hora, e.aula,
      m.nombre as materia, ca.nombre as carrera, cu.anio as anio_curso,
      u.nombre as docente_nombre, u.apellido as docente_apellido
    FROM examenes e
    JOIN asignaciones a ON e.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes d ON a.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    WHERE e.fecha=?
    ORDER BY e.hora
  `).all(fecha);
  res.json({ id, examenes_conflicto });
});
app.post('/api/feriados/:id/reprogramar-examenes', auth(ADM), (req, res) => {
  const cambios = req.body; // [{examen_id, nueva_fecha}]
  if (!Array.isArray(cambios) || !cambios.length) return res.status(400).json({ error: 'Se requiere array [{examen_id, nueva_fecha}]' });
  const stmt = db.prepare('UPDATE examenes SET fecha=? WHERE id=?');
  const tx = db.transaction(() => {
    cambios.forEach(c => {
      if (c.examen_id && c.nueva_fecha) {
        stmt.run(c.nueva_fecha, c.examen_id);
        audit(req.user.id, 'REPROGRAMAR_EXAMEN', 'examenes', c.examen_id, { nueva_fecha: c.nueva_fecha, motivo: 'feriado_'+req.params.id });
      }
    });
  });
  tx();
  res.json({ ok: true, actualizados: cambios.length });
});
app.delete('/api/feriados/:id', auth(ADM), (req, res) => {
  db.prepare('UPDATE feriados SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── RESUMEN HONORARIOS POR DOCENTE/MES ────────────────────────────────────────
// Anular asistencia de una fecha completa
app.delete('/api/asistencia/anular', auth(ADM), (req, res) => {
  const { asignacion_id, fecha } = req.body;
  if (!asignacion_id || !fecha) return res.status(400).json({ error: 'asignacion_id y fecha requeridos' });
  if (req.user.rol === 'docente') {
    const asig = db.prepare('SELECT a.id FROM asignaciones a JOIN docentes d ON a.docente_id=d.id WHERE a.id=? AND d.usuario_id=?').get(asignacion_id, req.user.id);
    if (!asig) return res.status(403).json({ error: 'Solo podés anular asistencia de tus materias' });
  }
  const del = db.prepare('DELETE FROM asistencia WHERE asignacion_id=? AND fecha=?').run(asignacion_id, fecha);
  db.prepare("UPDATE honorarios SET estado='anulado' WHERE asignacion_id=? AND fecha=? AND tipo='clase'").run(asignacion_id, fecha);
  audit(req.user.id, 'ANULAR_ASISTENCIA', 'asistencia', asignacion_id, { fecha, eliminados: del.changes });
  res.json({ ok: true, eliminados: del.changes });
});

app.get('/api/honorarios/resumen', auth(ADM), (req, res) => {
  const { docente_id, mes, anio } = req.query;
  if (!docente_id || !mes || !anio) return res.status(400).json({ error: 'docente_id, mes y anio requeridos' });
  const desde = `${anio}-${String(mes).padStart(2,'0')}-01`;
  const hasta = `${anio}-${String(mes).padStart(2,'0')}-${new Date(parseInt(anio),parseInt(mes),0).getDate()}`;

  // Feriados del mes
  const feriadosRows = db.prepare("SELECT fecha, nombre FROM feriados WHERE fecha>=? AND fecha<=? AND activo=1").all(desde, hasta);
  const feriados = new Set(feriadosRows.map(f=>f.fecha));
  const feriadoMap = {};
  feriadosRows.forEach(f => feriadoMap[f.fecha] = f.nombre);

  // Días donde el docente fue reemplazado (titular ausente → no cobra)
  const diasReemplazado = new Set(db.prepare(`
    SELECT DISTINCT r.fecha FROM reemplazos r
    WHERE r.docente_titular_id=? AND r.fecha>=? AND r.fecha<=? AND r.estado='aprobado'
  `).all(docente_id, desde, hasta).map(r=>r.fecha));

  // Días hábiles del mes (L-V, sin feriados)
  const diasHabiles = [];
  const cur = new Date(desde+'T12:00:00');
  const finDate = new Date(hasta+'T12:00:00');
  while (cur <= finDate) {
    const d = cur.getDay();
    if (d >= 1 && d <= 5 && !feriados.has(cur.toISOString().split('T')[0])) diasHabiles.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate()+1);
  }

  // Honorarios generados (clases + reemplazos realizados), excluyendo anulados
  const hons = db.prepare(`
    SELECT h.*, m.nombre as materia_nombre, ca.nombre as carrera_nombre, cu.anio as curso_anio,
      COALESCE(a.turno, h.turno) as turno, a.hora_inicio, a.hora_fin
    FROM honorarios h
    LEFT JOIN asignaciones a ON h.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE h.docente_id=? AND h.fecha>=? AND h.fecha<=? AND h.estado!='anulado'
    ORDER BY h.fecha, h.turno`).all(docente_id, desde, hasta);

  // Asignaciones del docente
  const asigs = db.prepare(`
    SELECT a.*, m.nombre as materia, m.dia, ca.nombre as carrera, cu.anio as anio_curso
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE a.docente_id=?`).all(docente_id);

  // Reemplazos que involucran al docente ese mes
  const reemplazos = db.prepare(`
    SELECT r.*, m.nombre as materia, ca.nombre as carrera, cu.anio as anio_curso,
      ut.nombre as titular_nombre, ut.apellido as titular_apellido,
      ur.nombre as rep_nombre, ur.apellido as rep_apellido
    FROM reemplazos r
    JOIN asignaciones a ON r.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes dt ON r.docente_titular_id=dt.id JOIN usuarios ut ON dt.usuario_id=ut.id
    JOIN docentes dr ON r.docente_reemplazante_id=dr.id JOIN usuarios ur ON dr.usuario_id=ur.id
    WHERE (r.docente_titular_id=? OR r.docente_reemplazante_id=?) AND r.fecha>=? AND r.fecha<=? AND r.estado='aprobado'
  `).all(docente_id, docente_id, desde, hasta);

  const docInfo = db.prepare('SELECT u.nombre,u.apellido,d.titulo FROM docentes d JOIN usuarios u ON d.usuario_id=u.id WHERE d.id=?').get(docente_id);
  const totalGanado = hons.reduce((s,h)=>s+h.monto, 0);

  // Calcular clases esperadas del mes (días hábiles × asignaciones activas, excluyendo feriados y reemplazos)
  const diasNum = {Lunes:1,Martes:2,'Miércoles':3,Jueves:4,Viernes:5};
  let clasesEsperadas = 0;
  let clasesReemplazadas = 0;
  let clasesFeriado = 0;
  asigs.forEach(a => {
    const numDia = diasNum[a.dia] || 0;
    if (!numDia) return;
    diasHabiles.forEach(fecha => {
      const f = new Date(fecha+'T12:00:00');
      if (f.getDay() === numDia) {
        clasesEsperadas++;
        if (diasReemplazado.has(fecha)) clasesReemplazadas++;
      }
    });
    // Contar feriados en días de clase
    feriados.forEach(fFecha => {
      const fF = new Date(fFecha+'T12:00:00');
      if (fF.getDay() === numDia) clasesFeriado++;
    });
  });

  res.json({
    docente: docInfo, diasHabiles, honorarios: hons, asignaciones: asigs,
    reemplazos, totalGanado, desde, hasta, mes, anio, feriadoMap,
    resumen: { clasesEsperadas, clasesReemplazadas, clasesFeriado, clasesEfectivas: clasesEsperadas - clasesReemplazadas }
  });
});

// ── EXÁMENES ──────────────────────────────────────────────────────────────────
app.get('/api/examenes', auth(), (req, res) => {
  const { periodo_id, carrera_id, tipo, desde, hasta } = req.query;
  const sede = req.user.sede || 'pjc';
  let where = 'WHERE ca.sede_id=?'; const params = [sede];
  if (periodo_id) { where += ' AND e.periodo_id=?'; params.push(periodo_id); }
  if (carrera_id) { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (tipo) { where += ' AND e.tipo=?'; params.push(tipo); }
  if (desde) { where += ' AND e.fecha>=?'; params.push(desde); }
  if (hasta) { where += ' AND e.fecha<=?'; params.push(hasta); }
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    if (doc) { where += ' AND a.docente_id=?'; params.push(doc.id); }
    where += " AND e.tipo NOT IN ('Recuperatorio','final_recuperatorio','Final Recuperatorio')";
  }
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id, curso_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (al?.carrera_id) { where += ' AND ca.id=?'; params.push(al.carrera_id); }
    if (al?.curso_id)   { where += ' AND cu.id=?';  params.push(al.curso_id); }
  }
  try {
    res.json(db.prepare(`
      SELECT e.id, e.asignacion_id, e.tipo, e.fecha, e.hora, e.aula, e.periodo_id,
        e.observacion, e.puntos_max, e.archivo_nombre, e.archivo_tipo,
        (e.archivo_data IS NOT NULL) as tiene_archivo,
        m.nombre as materia_nombre, m.codigo as materia_codigo,
        ca.id as carrera_id, ca.nombre as carrera_nombre,
        cu.id as curso_id, cu.anio as curso_anio, cu.division as curso_division,
        d.id as docente_id,
        u.nombre as docente_nombre, u.apellido as docente_apellido,
        p.nombre as periodo_nombre,
        a.id as asignacion_id, a.turno as asig_turno,
        COALESCE(nc.cnt, 0)  as notas_cargadas,
        COALESCE(ac.cnt, 0)  as total_alumnos
      FROM examenes e
      LEFT JOIN asignaciones a  ON e.asignacion_id=a.id
      LEFT JOIN materias m      ON a.materia_id=m.id
      LEFT JOIN cursos cu       ON a.curso_id=cu.id
      LEFT JOIN carreras ca     ON cu.carrera_id=ca.id
      LEFT JOIN docentes d      ON a.docente_id=d.id
      LEFT JOIN usuarios u      ON d.usuario_id=u.id
      LEFT JOIN periodos p      ON e.periodo_id=p.id
      LEFT JOIN (SELECT asignacion_id, COUNT(*) as cnt FROM notas GROUP BY asignacion_id) nc
             ON nc.asignacion_id=a.id
      LEFT JOIN (SELECT curso_id, COUNT(*) as cnt FROM alumnos WHERE estado='Activo' GROUP BY curso_id) ac
             ON ac.curso_id=cu.id
      ${where} ORDER BY e.fecha ASC, e.hora, ca.nombre`).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXÁMENES PENDIENTES DE CARGA DE PUNTAJES ──────────────────────────────────
// Mapeo tipo de examen → columna en tabla notas
const EXAMEN_NOTA_COL = {
  'Parcial':             'parcial',
  'Recuperatorio':       'parcial_recuperatorio',
  'Final':               'final_ord',      // legado
  'Final Recuperatorio': 'final_recuperatorio', // legado
  'Complementario':      'complementario', // legado
  'Extraordinario':      'extraordinario', // legado
  'final_ord':           'final_ord',
  'final_recuperatorio': 'final_recuperatorio',
  'complementario':      'complementario',
  'extraordinario':      'extraordinario',
};

app.get('/api/examenes/pendientes-notas', auth(['director','docente']), (req, res) => {
  const hoy = new Date().toISOString().split('T')[0];
  const sede = req.user.sede || 'pjc';
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - 8);
  const flStr = fechaLimite.toISOString().split('T')[0];

  let docente_id = null;
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    docente_id = doc?.id;
    if (!docente_id) return res.json([]);
  }

  let sql = `
    SELECT e.id, e.tipo, e.fecha, e.asignacion_id, e.hora,
      m.nombre as materia_nombre, m.id as materia_id,
      ca.nombre as carrera_nombre, ca.id as carrera_id,
      cu.anio as curso_anio, cu.division as curso_division, cu.id as curso_id,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      d.id as docente_id, d.titulo as docente_titulo
    FROM examenes e
    JOIN asignaciones a ON e.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes d ON a.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    WHERE e.fecha <= ? AND ca.sede_id=?`;
  const params = [flStr, sede];
  if (docente_id) { sql += ' AND a.docente_id=?'; params.push(docente_id); }
  sql += ' ORDER BY ca.nombre, cu.anio, m.nombre, e.fecha';

  const exams = db.prepare(sql).all(...params);
  const pendientes = [];

  for (const ex of exams) {
    const col = EXAMEN_NOTA_COL[ex.tipo];
    if (!col) continue;
    const total = db.prepare(`SELECT COUNT(*) as n FROM alumnos WHERE curso_id=? AND estado='Activo'`).get(ex.curso_id)?.n || 0;
    // Pendiente solo si no se cargó ninguna nota (cargados === 0)
    const cargados = db.prepare(`SELECT COUNT(*) as n FROM notas n2 WHERE n2.asignacion_id=? AND n2.${col} IS NOT NULL`).get(ex.asignacion_id)?.n || 0;
    if (cargados === 0) {
      const dias = Math.floor((new Date(hoy) - new Date(ex.fecha)) / (1000*60*60*24));
      pendientes.push({ ...ex, col_nota: col, total_alumnos: total, cargados: 0, dias_vencido: dias });
    }
  }
  res.json(pendientes);
});

app.post('/api/examenes', auth(ADM), (req, res) => {
  const { asignacion_id, asignaciones_unif, tipo, fecha, hora, aula, periodo_id, observacion, puntos_max } = req.body;
  if (!asignacion_id) return res.status(400).json({ error: 'Asignación requerida' });
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

  // Verificar duplicado: mismo tipo ya programado para esta asignación (independientemente de fecha)
  const yaExiste = db.prepare('SELECT id, fecha FROM examenes WHERE asignacion_id=? AND tipo=?').get(asignacion_id, tipo);
  if (yaExiste) return res.status(409).json({ error: `Ya existe un examen de tipo "${tipo}" programado para esta materia (fecha: ${yaExiste.fecha}). No se puede volver a programar.`, duplicado: true, examen_id: yaExiste.id });

  // Verificar conflicto de docente (mismo docente, misma fecha, mismo turno, distinta materia)
  const asig = db.prepare('SELECT a.docente_id, a.turno FROM asignaciones a WHERE a.id=?').get(asignacion_id);
  const conflictoDocente = asig ? db.prepare(`
    SELECT e.id, m.nombre as materia FROM examenes e
    JOIN asignaciones a2 ON e.asignacion_id=a2.id
    JOIN materias m ON a2.materia_id=m.id
    WHERE a2.docente_id=? AND e.fecha=? AND a2.turno=? AND e.asignacion_id!=?`
  ).get(asig.docente_id, fecha, asig.turno, asignacion_id) : null;

  try {
    const id = 'ex_' + Date.now();
    const ptsDefault = tipo==='Parcial'||tipo==='Recuperatorio' ? 20 : tipo==='Extraordinario'||tipo==='extraordinario' ? 100 : 50;
    db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion,puntos_max) VALUES (?,?,?,?,?,?,?,?,?)').run(id, asignacion_id, tipo, fecha, hora||null, aula||null, periodo_id||null, observacion||null, puntos_max||ptsDefault);

    // Procesar unificaciones: crear el mismo examen para otras asignaciones
    const unif_creados = [];
    if (Array.isArray(asignaciones_unif) && asignaciones_unif.length > 0) {
      asignaciones_unif.forEach((asig2_id, idx) => {
        if (typeof asig2_id !== 'string' || asig2_id === asignacion_id) return;
        // Verificar si ya tiene un examen del mismo tipo (sin importar fecha)
        const yaEx2 = db.prepare('SELECT id FROM examenes WHERE asignacion_id=? AND tipo=?').get(asig2_id, tipo);
        if (!yaEx2) {
          // ID único garantizado usando timestamp + índice
          const id2 = 'ex_' + (Date.now() + idx + 1) + '_u' + idx;
          db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion,puntos_max) VALUES (?,?,?,?,?,?,?,?,?)').run(id2, asig2_id, tipo, fecha, hora||null, aula||null, periodo_id||null, observacion||null, puntos_max||25);
          unif_creados.push(id2);
        }
      });
    }
    audit(req.user.id, 'CREATE', 'examenes', id, { tipo, fecha, asignacion_id, unificados: unif_creados.length });

    // Generar aviso automático para el docente
    try {
      const info = db.prepare(`
        SELECT d.id as docente_id, u.nombre, u.apellido, m.nombre as materia, ca.nombre as carrera, cu.anio
        FROM asignaciones a
        JOIN docentes d ON a.docente_id=d.id JOIN usuarios u ON d.usuario_id=u.id
        JOIN materias m ON a.materia_id=m.id
        JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id
        WHERE a.id=?`).get(asignacion_id);
      if (info) {
        const tipoLabel = { parcial:'Parcial', parcial_recuperatorio:'Parcial Recuperatorio', final_ord:'Final Ordinario', final_recuperatorio:'Final Recuperatorio', complementario:'Complementario', extraordinario:'Extraordinario' }[tipo] || tipo;
        const avId = 'av_' + (Date.now() + 1);
        db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(
          avId,
          `📋 Examen programado: ${tipoLabel} — ${info.materia}`,
          `Se ha programado el examen de <strong>${tipoLabel}</strong> para la materia <strong>${info.materia}</strong> (${info.carrera} ${info.anio}°) el día <strong>${fecha}</strong>${hora ? ' a las ' + hora : ''}${aula ? ' en aula ' + aula : ''}. Por favor, verificá los detalles en la sección Exámenes.`,
          'info', 0, 'docentes', req.user.id
        );
      }
    } catch(avErr) { console.error('Error creando aviso de examen:', avErr.message); }

    res.json({ id, unif_creados, advertencia: conflictoDocente ? `El docente ya tiene examen "${conflictoDocente.materia}" ese día/turno` : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/examenes/:id', auth(ADM), (req, res) => {
  const { asignacion_id, tipo, fecha, hora, aula, periodo_id, observacion, puntos_max } = req.body;
  try {
    db.prepare('UPDATE examenes SET asignacion_id=?,tipo=?,fecha=?,hora=?,aula=?,periodo_id=?,observacion=?,puntos_max=? WHERE id=?').run(asignacion_id,tipo,fecha,hora||null,aula||null,periodo_id,observacion||null,puntos_max||50,req.params.id);
    audit(req.user.id,'UPDATE','examenes',req.params.id,{tipo,fecha});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/examenes/:id', auth(ADM), (req, res) => {
  try {
    const ex = db.prepare(`
      SELECT e.*, m.nombre as materia_nombre, c.anio, c.division,
             ca.nombre as carrera_nombre
      FROM examenes e
      LEFT JOIN asignaciones a ON e.asignacion_id=a.id
      LEFT JOIN materias m ON a.materia_id=m.id
      LEFT JOIN cursos c ON a.curso_id=c.id
      LEFT JOIN carreras ca ON c.carrera_id=ca.id
      WHERE e.id=?`).get(req.params.id);
    if (ex) {
      const nombre = `${ex.tipo||'Examen'} — ${ex.materia_nombre||ex.asignacion_id} (${ex.fecha||'sin fecha'})`;
      guardarEnPapelera('examen', nombre, ex, req.user?.id);
    }
    db.prepare('DELETE FROM examenes WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECUPERATORIOS PARCIALES — Preview automático ────────────────────────────
app.get('/api/examenes/preview-recuperatorios-parciales', auth(ADM), (req, res) => {
  try {
    console.log('[RECUP-PREVIEW] Iniciando generación...');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (!periodo) return res.status(400).json({ error: 'No hay período activo' });

    // Normalización consistente con el resto del sistema
    const normDia = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
    const DIA_DOW = { lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6 };

    // Todas las asignaciones del período con día asignado
    const asigs = db.prepare(`
      SELECT a.id, a.docente_id, a.curso_id, a.turno, a.dia,
        m.nombre as materia_nombre,
        cu.anio as curso_anio, cu.division as curso_division,
        ca.nombre as carrera_nombre,
        u.nombre as doc_nombre, u.apellido as doc_apellido
      FROM asignaciones a
      JOIN materias m  ON a.materia_id=m.id
      JOIN cursos  cu  ON a.curso_id=cu.id
      JOIN carreras ca ON cu.carrera_id=ca.id
      JOIN docentes d  ON a.docente_id=d.id
      JOIN usuarios u  ON d.usuario_id=u.id
      WHERE a.periodo_id=? AND a.dia IS NOT NULL AND a.dia!=''
    `).all(periodo.id);

    // Asignaciones que YA tienen Recuperatorio programado
    const yaRecup = new Set(
      db.prepare("SELECT asignacion_id FROM examenes WHERE tipo='Recuperatorio'")
        .all().map(r => r.asignacion_id)
    );

    // Alumnos activos por curso
    const alumnosCurso = {};
    [...new Set(asigs.map(a => a.curso_id))].forEach(cid => {
      alumnosCurso[cid] = db.prepare(
        "SELECT id FROM alumnos WHERE curso_id=? AND estado='Activo'"
      ).all(cid).map(r => r.id);
    });

    // Fechas disponibles dentro de 3 semanas desde el 10/06/2026
    const INICIO = new Date('2026-06-10T00:00:00');
    const FIN    = new Date('2026-07-01T00:00:00');
    const getFechas = (diaStr) => {
      const dow = DIA_DOW[normDia(diaStr)];
      if (dow === undefined) return [];
      const fechas = [];
      const d = new Date(INICIO);
      while (d <= FIN) {
        if (d.getDay() === dow) fechas.push(d.toISOString().slice(0,10));
        d.setDate(d.getDate()+1);
      }
      return fechas;
    };

    // Agrupar unificados: mismo docente + mismo día + mismo turno
    const grupos = {};
    asigs.forEach(a => {
      if (yaRecup.has(a.id)) return;
      const key = `${a.docente_id}|${normDia(a.dia)}|${a.turno}`;
      if (!grupos[key]) grupos[key] = [];
      grupos[key].push(a);
    });

    // Estado de programación
    const alumnoFechas   = {}; // alumno_id  → Set<date>
    const docenteTurnos  = {}; // docente_id → { date → Set<turno> }

    const resultado = [];
    const sinFecha  = [];

    // Ordenar: grupos con más alumnos primero (más restringidos)
    Object.values(grupos)
      .sort((a, b) => {
        const nA = [...new Set(a.flatMap(g => alumnosCurso[g.curso_id]||[]))].length;
        const nB = [...new Set(b.flatMap(g => alumnosCurso[g.curso_id]||[]))].length;
        return nB - nA;
      })
      .forEach(grupo => {
        const a0      = grupo[0];
        const opciones = getFechas(a0.dia);
        const alumnosG = [...new Set(grupo.flatMap(a => alumnosCurso[a.curso_id]||[]))];
        const docId    = a0.docente_id;
        const turno    = a0.turno;

        let fechaOk = null;
        let motivo  = null;

        for (const fecha of opciones) {
          if (alumnosG.some(alId => alumnoFechas[alId]?.has(fecha))) {
            motivo = `Conflicto de alumno el ${fecha}`; continue;
          }
          const turnosDoc = docenteTurnos[docId]?.[fecha] || new Set();
          if (turnosDoc.has(turno))    { motivo = `Docente ya tiene ese turno el ${fecha}`; continue; }
          if (turnosDoc.size >= 2)     { motivo = `Docente ya tiene 2 exámenes el ${fecha}`; continue; }
          fechaOk = fecha; break;
        }

        if (fechaOk) {
          alumnosG.forEach(alId => {
            if (!alumnoFechas[alId]) alumnoFechas[alId] = new Set();
            alumnoFechas[alId].add(fechaOk);
          });
          if (!docenteTurnos[docId]) docenteTurnos[docId] = {};
          if (!docenteTurnos[docId][fechaOk]) docenteTurnos[docId][fechaOk] = new Set();
          docenteTurnos[docId][fechaOk].add(turno);

          const hora = turno === 2 ? '20:40' : '19:00';
          grupo.forEach(a => resultado.push({
            asignacion_id: a.id,
            materia:  a.materia_nombre,
            carrera:  a.carrera_nombre,
            anio:     a.curso_anio,
            division: a.curso_division,
            docente:  `${a.doc_apellido||''}, ${a.doc_nombre||''}`,
            dia:      a.dia,
            turno:    a.turno,
            fecha:    fechaOk,
            hora,
            unificado: grupo.length > 1,
            unif_ids:  grupo.map(g => g.id)
          }));
        } else {
          grupo.forEach(a => sinFecha.push({
            asignacion_id: a.id,
            materia:  a.materia_nombre,
            carrera:  a.carrera_nombre,
            anio:     a.curso_anio,
            dia:      a.dia,
            motivo:   motivo || 'Sin fechas disponibles en el período',
            opciones
          }));
        }
      });

    resultado.sort((a,b) => a.fecha.localeCompare(b.fecha) || a.carrera.localeCompare(b.carrera));

    // Guardar en memoria para confirmación
    req.app.locals._prevRecupParcial = resultado;

    console.log(`[RECUP-PREVIEW] OK — ${resultado.length} asignados, ${sinFecha.length} sin fecha`);
    res.json({ resultado, sinFecha, periodo_inicio:'2026-06-10', periodo_fin:'2026-07-01' });
  } catch(e) {
    console.error('[RECUP-PREVIEW] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/examenes/crear-recuperatorios-parciales', auth(ADM), (req, res) => {
  try {
    const pendientes = req.app.locals._prevRecupParcial;
    if (!pendientes?.length) return res.status(400).json({ error: 'No hay preview generado. Usá el botón "Generar" primero.' });

    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    let creados = 0;
    const errores = [];
    const docentesAvisados = new Set(); // evitar avisos duplicados por docente+fecha

    const fmtFecha = f => {
      const [y,m,d] = (f||'').split('-');
      return `${d}/${m}/${y}`;
    };

    pendientes.forEach((p, i) => {
      const ya = db.prepare("SELECT id FROM examenes WHERE asignacion_id=? AND tipo='Recuperatorio'").get(p.asignacion_id);
      if (ya) { errores.push(`${p.materia}: ya existe`); return; }

      const id = 'ex_' + (Date.now() + i) + '_rp';
      db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,periodo_id,puntos_max) VALUES (?,?,?,?,?,?,?)')
        .run(id, p.asignacion_id, 'Recuperatorio', p.fecha, p.hora||null, periodo?.id||null, 20);
      creados++;

      // Aviso solo al docente de esa materia (usa su usuario_id para que solo él lo vea)
      try {
        const docKey = `${p.asignacion_id}|${p.fecha}`;
        if (!docentesAvisados.has(docKey)) {
          docentesAvisados.add(docKey);
          const info = db.prepare(`
            SELECT u.id as doc_uid, u.nombre, u.apellido, ca.nombre as carrera, cu.anio
            FROM asignaciones a
            JOIN docentes d  ON a.docente_id=d.id
            JOIN usuarios u  ON d.usuario_id=u.id
            JOIN cursos cu   ON a.curso_id=cu.id
            JOIN carreras ca ON cu.carrera_id=ca.id
            WHERE a.id=?`).get(p.asignacion_id);
          if (info) {
            const avId = 'av_rp_' + (Date.now() + i);
            db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(
              avId,
              `📋 Recuperatorio Parcial — ${p.materia}`,
              `Se programó el Recuperatorio Parcial de <strong>${p.materia}</strong> (${info.carrera} ${info.anio}°) para el <strong>${fmtFecha(p.fecha)}</strong> a las <strong>${p.hora}</strong>.`,
              'info', 0, 'docentes', info.doc_uid
            );
          }
        }
      } catch(avErr) { console.error('Aviso docente error:', avErr.message); }
    });

    audit(req.user.id, 'CREAR_RECUPERATORIOS_PARCIALES', 'examenes', 'bulk', { creados, errores: errores.length });
    req.app.locals._prevRecupParcial = null;
    res.json({ ok: true, creados, errores });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECUPERATORIOS FINALES — Preview automático ──────────────────────────────
// Excepción total al cronograma normal: acá SÍ se ignora el día de clase real
// de cada asignación (a diferencia de los recuperatorios parciales) porque el
// director pidió que cada alumno rinda 1 materia por día hasta terminar, sin
// importar qué día de la semana le tocaría esa materia.
// El director pidió que el calendario se arme para TODAS las materias del
// período activo, sin importar si el final ordinario ya se cargó o siquiera
// se rindió todavía — la fecha se publica igual (el pago/habilitación sigue
// siendo requisito aparte para que el docente pueda cargar la nota de cada
// alumno puntual, pero no condiciona si la fecha existe). Se toman todos los
// alumnos Activos de cada curso (no solo los que ya tienen nota) para armar
// el grafo de conflictos (dos materias no pueden coincidir el mismo día si
// comparten al menos un alumno) y se colorea en la menor cantidad de días
// posible a partir de fecha_inicio, saltando sábados y domingos.
app.get('/api/examenes/preview-recuperatorios-finales', auth(ADM), (req, res) => {
  try {
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (!periodo) return res.status(400).json({ error: 'No hay período activo' });

    let fechaInicio = (req.query.fecha_inicio || '2026-08-03').slice(0, 10);
    // Si cae sábado/domingo, correr al lunes siguiente
    {
      const d = new Date(fechaInicio + 'T12:00:00');
      if (d.getDay() === 6) d.setDate(d.getDate() + 2);
      else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      fechaInicio = d.toISOString().slice(0, 10);
    }

    const yaRecup = new Set(
      db.prepare("SELECT asignacion_id FROM examenes WHERE tipo='final_recuperatorio'").all().map(r => r.asignacion_id)
    );

    const asigs = db.prepare(`
      SELECT a.id as asignacion_id, a.docente_id, a.curso_id,
        m.nombre as materia_nombre,
        cu.anio as curso_anio, cu.division as curso_division,
        ca.nombre as carrera_nombre,
        u.nombre as doc_nombre, u.apellido as doc_apellido
      FROM asignaciones a
      JOIN materias m  ON a.materia_id  = m.id
      JOIN cursos cu   ON a.curso_id    = cu.id
      JOIN carreras ca ON cu.carrera_id = ca.id
      JOIN docentes d  ON a.docente_id  = d.id
      JOIN usuarios u  ON d.usuario_id  = u.id
      WHERE a.periodo_id = ?
    `).all(periodo.id);

    const alumnosCurso = {};
    [...new Set(asigs.map(a => a.curso_id))].forEach(cid => {
      alumnosCurso[cid] = db.prepare("SELECT id, nombre, apellido FROM alumnos WHERE curso_id=? AND estado='Activo'").all(cid);
    });

    const grupos = {};   // asignacion_id -> { info, alumnos: [{id,nombre}] }
    const yaProgramadas = new Set();
    asigs.forEach(a => {
      if (yaRecup.has(a.asignacion_id)) { yaProgramadas.add(a.asignacion_id); return; }
      const alumnos = alumnosCurso[a.curso_id] || [];
      if (!alumnos.length) return; // curso sin alumnos activos — nada que programar
      grupos[a.asignacion_id] = {
        asignacion_id: a.asignacion_id,
        materia: a.materia_nombre,
        carrera: a.carrera_nombre,
        anio: a.curso_anio,
        division: a.curso_division,
        docente_id: a.docente_id,
        docente: `${a.doc_apellido||''}, ${a.doc_nombre||''}`,
        alumnos: alumnos.map(al => ({ id: al.id, nombre: `${al.apellido||''}, ${al.nombre||''}` }))
      };
    });

    const ids = Object.keys(grupos);

    // Grafo de conflictos: dos asignaciones "chocan" si comparten un alumno
    const adj = {};
    ids.forEach(id => adj[id] = new Set());
    const porAlumno = {};
    ids.forEach(id => grupos[id].alumnos.forEach(al => {
      (porAlumno[al.id] = porAlumno[al.id] || []).push(id);
    }));
    Object.values(porAlumno).forEach(idsAl => {
      for (let i = 0; i < idsAl.length; i++)
        for (let j = i + 1; j < idsAl.length; j++) {
          adj[idsAl[i]].add(idsAl[j]);
          adj[idsAl[j]].add(idsAl[i]);
        }
    });

    // Coloreo greedy (Welsh–Powell): más conflictivos primero → menos días usados
    const orden = ids.slice().sort((a, b) => adj[b].size - adj[a].size);
    const color = {};
    orden.forEach(id => {
      const usados = new Set([...adj[id]].map(n => color[n]).filter(c => c !== undefined));
      let c = 0;
      while (usados.has(c)) c++;
      color[id] = c;
    });
    const diasUtilizados = ids.length ? Math.max(...Object.values(color)) + 1 : 0;

    const fechaDelDia = offset => {
      let d = new Date(fechaInicio + 'T12:00:00');
      let restante = offset;
      while (restante > 0) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) restante--;
      }
      return d.toISOString().slice(0, 10);
    };
    const addMin = (hhmm, mins) => {
      const [h, m] = hhmm.split(':').map(Number);
      const total = (h * 60 + m + mins) % (24 * 60);
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
    };

    // Staggerar hora si el mismo docente cae más de una vez el mismo día
    const docenteDiaCount = {};
    const resultado = ids.map(id => {
      const g = grupos[id];
      const fecha = fechaDelDia(color[id]);
      const key = `${g.docente_id}|${fecha}`;
      const n = docenteDiaCount[key] || 0;
      docenteDiaCount[key] = n + 1;
      return {
        asignacion_id: g.asignacion_id,
        materia: g.materia,
        carrera: g.carrera,
        anio: g.anio,
        division: g.division,
        docente: g.docente,
        fecha,
        hora: addMin('19:00', n * 90),
        alumnos: g.alumnos,
        cantidad_alumnos: g.alumnos.length,
        dia_indice: color[id] + 1
      };
    }).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.carrera.localeCompare(b.carrera));

    req.app.locals._prevRecupFinal = resultado;

    res.json({
      resultado,
      fecha_inicio: fechaInicio,
      dias_utilizados: diasUtilizados,
      total_examenes: ids.length,
      total_alumnos: Object.keys(porAlumno).length,
      ya_programadas: yaProgramadas.size
    });
  } catch(e) {
    console.error('[RECUP-FINAL-PREVIEW] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/examenes/crear-recuperatorios-finales', auth(ADM), (req, res) => {
  try {
    const pendientes = req.app.locals._prevRecupFinal;
    if (!pendientes?.length) return res.status(400).json({ error: 'No hay preview generado. Usá "Generar" primero.' });

    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    let creados = 0;
    const errores = [];

    pendientes.forEach((p, i) => {
      const ya = db.prepare("SELECT id FROM examenes WHERE asignacion_id=? AND tipo='final_recuperatorio'").get(p.asignacion_id);
      if (ya) { errores.push(`${p.materia}: ya existe`); return; }

      const id = 'ex_' + (Date.now() + i) + '_frp';
      db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,periodo_id,puntos_max) VALUES (?,?,?,?,?,?,?)')
        .run(id, p.asignacion_id, 'final_recuperatorio', p.fecha, p.hora || null, periodo?.id || null, 50);
      creados++;

      try {
        const info = db.prepare(`
          SELECT u.id as doc_uid FROM asignaciones a
          JOIN docentes d ON a.docente_id=d.id JOIN usuarios u ON d.usuario_id=u.id
          WHERE a.id=?`).get(p.asignacion_id);
        if (info) {
          const avId = 'av_frp_' + (Date.now() + i);
          db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(
            avId,
            `📋 Final Recuperatorio — ${p.materia}`,
            `Se programó el Final Recuperatorio de <strong>${p.materia}</strong> (${p.carrera} ${p.anio}°) para el <strong>${p.fecha}</strong> a las <strong>${p.hora}</strong>. Alumnos: ${p.cantidad_alumnos} (recordá que solo pueden rendir los que hayan pagado y estén habilitados).`,
            'info', 0, 'docentes', info.doc_uid
          );
        }
      } catch(avErr) { console.error('Aviso docente final recuperatorio error:', avErr.message); }
    });

    audit(req.user.id, 'CREAR_RECUPERATORIOS_FINALES', 'examenes', 'bulk', { creados, errores: errores.length });
    req.app.locals._prevRecupFinal = null;
    res.json({ ok: true, creados, errores });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Limpiar todos los exámenes de un tipo (para reset del cronograma)
app.delete('/api/examenes/bulk/tipo', auth(ADM), (req, res) => {
  const { tipo } = req.body;
  if (!tipo) return res.status(400).json({ error: 'Indicar tipo' });
  const n = db.prepare('DELETE FROM examenes WHERE tipo=?').run(tipo);
  audit(req.user.id, 'DELETE_BULK', 'examenes', tipo, { eliminados: n.changes });
  res.json({ ok: true, eliminados: n.changes });
});

// Exámenes del día / semana para el calendario
app.get('/api/examenes/calendario', auth(), (req, res) => {
  const { desde, hasta, docente_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (desde) { where += ' AND e.fecha>=?'; params.push(desde); }
  if (hasta) { where += ' AND e.fecha<=?'; params.push(hasta); }
  if (docente_id) { where += ' AND a.docente_id=?'; params.push(docente_id); }
  // Alumno: solo ve exámenes de su carrera Y su propio año/curso
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id, curso_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (al?.carrera_id) { where += ' AND ca.id=?'; params.push(al.carrera_id); }
    if (al?.curso_id)   { where += ' AND cu.id=?';  params.push(al.curso_id); }
  }
  // Docente: forzar filtro por sus propias asignaciones (seguridad server-side)
  if (req.user.rol === 'docente' && !docente_id) {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    if (doc) { where += ' AND a.docente_id=?'; params.push(doc.id); }
    where += " AND e.tipo NOT IN ('Recuperatorio','final_recuperatorio','Final Recuperatorio')";
  }
  res.json(db.prepare(`
    SELECT e.*,
      m.nombre as materia_nombre,
      ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      d.id as docente_id,
      a.id as asignacion_id,
      a.turno as asig_turno,
      COALESCE(ac.cnt, 0) as total_alumnos
    FROM examenes e
    LEFT JOIN asignaciones a  ON e.asignacion_id=a.id
    LEFT JOIN materias m      ON a.materia_id=m.id
    LEFT JOIN cursos cu       ON a.curso_id=cu.id
    LEFT JOIN carreras ca     ON cu.carrera_id=ca.id
    LEFT JOIN docentes d      ON a.docente_id=d.id
    LEFT JOIN usuarios u      ON d.usuario_id=u.id
    LEFT JOIN (SELECT curso_id, COUNT(*) as cnt FROM alumnos WHERE estado='Activo' GROUP BY curso_id) ac ON ac.curso_id=cu.id
    ${where} ORDER BY e.fecha, e.hora`).all(...params));
});

// ── AVISOS ────────────────────────────────────────────────────────────────────
app.get('/api/avisos', auth(), (req, res) => {
  const rol = req.user.rol;
  const uid = req.user.id;
  const sede = req.user.sede || 'pjc';
  let whereDestino = `AND av.sede_id=?`;
  const params = [sede];
  if (rol === 'alumno') {
    whereDestino += " AND (av.destinatario='todos' OR av.destinatario='alumnos')";
  } else if (rol === 'docente') {
    whereDestino += ` AND (av.usuario_id='${uid}' OR (u.rol='director' AND av.destinatario IN ('todos','docentes')))`;
  } else if (rol === 'director') {
    whereDestino += ` AND (av.destinatario != 'docentes' OR av.usuario_id='${uid}')`;
  }
  res.json(db.prepare(`SELECT av.*,u.nombre as autor_nombre,u.apellido as autor_apellido,u.rol as autor_rol
    FROM avisos av JOIN usuarios u ON av.usuario_id=u.id
    WHERE av.activo=1 ${whereDestino} ORDER BY av.fijado DESC,av.fecha_creacion DESC LIMIT 100`).all(...params));
});
app.post('/api/avisos', auth(['director','docente']), (req, res) => {
  const { titulo, contenido, tipo, fijado, destinatario, categoria } = req.body;
  const sede = req.user.sede || 'pjc';
  const destMap = {
    'todos':'todos', 'docentes':'docentes', 'alumnos':'alumnos',
    'mis-alumnos':'alumnos', 'director':'todos', 'director-secretaria':'todos'
  };
  const destDB = destMap[destinatario] || 'todos';
  const catDB = categoria === 'sistema' ? 'sistema' : 'academico';
  const id = 'av_' + Date.now();
  db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id,sede_id,categoria) VALUES (?,?,?,?,?,?,?,?,?)').run(id,titulo,contenido,tipo||'info',fijado?1:0,destDB,req.user.id,sede,catDB);
  audit(req.user.id,'AVISO','avisos',id,{titulo,destinatario,destDB,categoria:catDB});
  res.json({ id });
});
app.put('/api/avisos/:id', auth(ADM), (req, res) => {
  const { titulo, contenido, tipo, fijado, activo, destinatario } = req.body;
  db.prepare('UPDATE avisos SET titulo=?,contenido=?,tipo=?,fijado=?,activo=?,destinatario=? WHERE id=?').run(titulo,contenido,tipo||'info',fijado?1:0,activo?1:0,destinatario||'todos',req.params.id);
  res.json({ ok: true });
});
app.delete('/api/avisos/:id', auth(ADM), (req, res) => {
  db.prepare('UPDATE avisos SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// Borrar múltiples avisos a la vez (para "limpiar leídos")
app.delete('/api/avisos', auth(ADM), (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requeridos' });
  const placeholders = ids.map(() => '?').join(',');
  const r = db.prepare(`UPDATE avisos SET activo=0 WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, eliminados: r.changes });
});

// ── PAGOS ─────────────────────────────────────────────────────────────────────
app.get('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, carrera_id, curso_id } = req.query;
  const sede = req.user.sede || 'pjc';
  let where = 'WHERE c.sede_id=?'; const params = [sede];
  if (alumno_id)  { where += ' AND p.alumno_id=?';    params.push(alumno_id); }
  if (carrera_id) { where += ' AND al.carrera_id=?';  params.push(carrera_id); }
  if (curso_id)   { where += ' AND al.curso_id=?';    params.push(curso_id); }
  res.json(db.prepare(`
    SELECT p.*,
      COALESCE(al.nombre,u.nombre) as nombre,
      COALESCE(al.apellido,u.apellido) as apellido,
      COALESCE(al.ci,u.ci) as ci,
      c.nombre as carrera,
      cu.anio as curso_anio,
      cu.division as curso_division
    FROM pagos p
    JOIN alumnos al ON p.alumno_id=al.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    ${where} ORDER BY p.fecha_pago DESC LIMIT 500`).all(...params));
});
// Resumen kanban: totales por alumno (matrícula, cuotas pagadas, total Gs.)
app.get('/api/pagos/resumen-kanban', auth(ADM), (req, res) => {
  const { carrera_id, curso_id, busqueda } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (carrera_id === 'SIN_ASIGNAR') { where += ' AND al.carrera_id IS NULL'; }
  else if (carrera_id) { where += ' AND al.carrera_id=?'; params.push(carrera_id); }
  if (curso_id) { where += ' AND al.curso_id=?'; params.push(curso_id); }
  if (busqueda) {
    const b = '%' + busqueda + '%';
    where += ' AND (al.nombre LIKE ? OR al.apellido LIKE ? OR al.ci LIKE ?)';
    params.push(b, b, b);
  }
  const filas = db.prepare(`
    SELECT
      al.id                                                                          AS alumno_id,
      COALESCE(SUM(p.monto), 0)                                                     AS total_pagado,
      MAX(CASE WHEN p.concepto LIKE 'Matrícula%' OR p.concepto='Matricula' THEN 1 ELSE 0 END) AS tiene_matricula,
      COUNT(CASE WHEN p.concepto LIKE 'Cuota %' THEN 1 ELSE NULL END)              AS cuotas_pagadas,
      COUNT(p.id)                                                                   AS total_pagos
    FROM alumnos al
    LEFT JOIN pagos p ON p.alumno_id = al.id
    ${where}
    GROUP BY al.id
  `).all(...params);
  const map = {};
  filas.forEach(f => { map[f.alumno_id] = f; });
  res.json(map);
});
app.get('/api/pagos/stats', auth(ADM), (req, res) => {
  const total   = db.prepare(`SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo'`).get().n;
  const conMat  = db.prepare(`SELECT COUNT(DISTINCT al.id) as n FROM alumnos al JOIN pagos p ON p.alumno_id=al.id WHERE al.estado='Activo' AND p.estado='Pagado' AND (p.concepto LIKE 'Matr%' OR p.concepto='Matricula')`).get().n;
  const mora    = db.prepare(`SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo' AND habilitado_pago_pendiente=1`).get().n;
  res.json({ total, conMat, sinMat: total - conMat, mora });
});

// Perfil financiero de un alumno (consulta para rol alumno)
app.get('/api/pagos/alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT a.*, c.nombre as carrera_nombre, cu.anio as curso_anio FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?').get(req.params.alumno_id);
  // Alumno solo puede ver su propio perfil
  if (req.user.rol === 'alumno' && al?.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
  const pagos = db.prepare(`SELECT p.*,c.nombre as carrera,m.nombre as materia_nombre FROM pagos p JOIN alumnos al ON p.alumno_id=al.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN asignaciones asig ON p.asignacion_id=asig.id LEFT JOIN materias m ON asig.materia_id=m.id WHERE p.alumno_id=? ORDER BY p.fecha_pago DESC`).all(req.params.alumno_id);
  const totalPagado = pagos.reduce((s,p)=>s+p.monto,0);
  res.json({ pagos, totalPagado, alumno: al });
});
app.post('/api/pagos/lote', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto_unitario, asignacion_ids, fecha_pago, medio_pago, comprobante } = req.body;
  if (!Array.isArray(asignacion_ids) || asignacion_ids.length === 0)
    return res.status(400).json({ error: 'Seleccioná al menos una materia' });
  const ARANCEL_TIPO_MAP = {
    'Examen Parcial Recuperatorio': 'parcial_recuperatorio',
    'Examen Final Ordinario':       'final_ord',
    'Examen Final Recuperatorio':   'final_recuperatorio',
    'Examen Final Complementario':  'complementario',
    'Examen Final Extraordinario':  'extraordinario',
  };
  const tipoExamen = ARANCEL_TIPO_MAP[concepto];
  if (!tipoExamen) return res.status(400).json({ error: 'Concepto no válido para pago por lote' });
  try {
    const alNom = db.prepare('SELECT nombre, apellido FROM alumnos WHERE id=?').get(alumno_id);
    const fechaHoy = nowDate();
    const esRecup = tipoExamen === 'parcial_recuperatorio' ? 1 : 0;
    const montoUnit = parseFloat(monto_unitario) || 0;
    let registros = 0;
    const idsHabilitados = [];
    const insertLote = db.transaction(() => {
      asignacion_ids.forEach((asig_id, i) => {
        const dup = db.prepare('SELECT id FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND tipo_examen=?').get(alumno_id, asig_id, tipoExamen);
        if (dup) return;
        const pid = 'pg_' + (Date.now() + i) + '_' + i;
        db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,medio_pago,asignacion_id,mora_exonerada,mora_monto) VALUES (?,?,?,?,?,?,?,?,?,?,0,0)')
          .run(pid, alumno_id, periodo_id, concepto, montoUnit, fecha_pago || fechaHoy, 'Pagado', comprobante || null, medio_pago || 'Efectivo', asig_id);
        const habId = 'hab_' + (Date.now() + i) + '_' + i;
        db.prepare('INSERT OR IGNORE INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado,habilitado_por,fecha,motivo,habilitado_recuperatorio) VALUES (?,?,?,?,1,?,?,?,?)')
          .run(habId, alumno_id, asig_id, tipoExamen, req.user.id, fechaHoy, `Habilitado por pago de ${concepto} (lote)`, esRecup);
        audit(req.user.id, 'PAGO_LOTE', 'pagos', pid, { alumno_id, alumno: alNom ? `${alNom.apellido}, ${alNom.nombre}` : alumno_id, concepto, monto: montoUnit, asignacion_id: asig_id });
        registros++;
        idsHabilitados.push(asig_id);
      });
    });
    insertLote();

    // Enviar UNA constancia por WhatsApp consolidando todas las materias del lote —
    // antes este endpoint (usado cuando se habilita mas de una materia a la vez, el
    // caso mas comun) nunca avisaba nada al alumno, a diferencia del pago individual.
    if (registros > 0) {
      const alFull = db.prepare('SELECT nombre, apellido, telefono FROM alumnos WHERE id=?').get(alumno_id);
      if (alFull?.telefono) {
        const phs = idsHabilitados.map(() => '?').join(',');
        const materias = db.prepare(`SELECT m.nombre FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id IN (${phs})`).all(...idsHabilitados);
        const listaMaterias = materias.map(m => m.nombre).join(', ');
        const APP_URL = process.env.APP_URL || 'https://its-sistema-production.up.railway.app/';
        const fechaFmt = (fecha_pago || fechaHoy).split('-').reverse().join('/');
        const montoTotalFmt = 'Gs. ' + Number(montoUnit * registros).toLocaleString('es-PY');
        const nombreCompleto = `${alFull.nombre || ''} ${alFull.apellido || ''}`.trim();
        const waMsg = getWASistemaTpl('constancia_pago')
          .replace(/\{nombre\}/g, nombreCompleto)
          .replace(/\{concepto\}/g, concepto)
          .replace(/\{materia\}/g, `\n• Materias habilitadas (${registros}): ${listaMaterias}`)
          .replace(/\{monto\}/g, montoTotalFmt)
          .replace(/\{fecha\}/g, fechaFmt)
          .replace(/\{url\}/g, APP_URL);
        sendWhatsApp(alFull.telefono, waMsg).catch(() => {});
      }
    }

    res.json({ ok: true, registros });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Registra un pago y, si corresponde (concepto de examen con arancel + asignacion_id),
// crea automáticamente la habilitación de esa materia puntual y envía la constancia por
// WhatsApp. Compartida entre el registro manual de pagos (POST /api/pagos) y la aprobación
// de comprobantes recibidos por WhatsApp (POST /api/pagos/pendientes-wa/:id/aprobar) —
// antes ese segundo flujo duplicaba solo el INSERT en "pagos" sin esta lógica, así que un
// pago de arancel aprobado desde un comprobante de WhatsApp NUNCA generaba la habilitación
// ni aparecía para el docente, aunque el alumno sí hubiera pagado.
function registrarPagoConHabilitacion(usuarioId, datos) {
  const { alumno_id, periodo_id, concepto, monto, fecha_pago, comprobante, descuento, beca, medio_pago, asignacion_id, mora_exonerada } = datos;
  const esCuotaMensual = /^cuota\s+\d+/i.test(concepto || '');
  // Mora solo si el vencimiento de ESA cuota ya pasó (día 10 del mes correspondiente)
  // Cuota 1=Marzo(3), Cuota 2=Abril(4), ..., Cuota N → mes N+2
  const cuotaNum = esCuotaMensual ? parseInt((concepto||'').match(/\d+/)?.[0]||'0') : 0;
  const cuotaMes = cuotaNum + 2; // mes del año (1-12) al que corresponde la cuota
  const hoy = new Date();
  const mesActual = hoy.getMonth() + 1;
  const diaActual = hoy.getDate();
  const vencioMora = esCuotaMensual && (cuotaMes < mesActual || (cuotaMes === mesActual && diaActual >= 11));
  const moraMonto = vencioMora ? 50000 : 0;
  // Mapa: concepto exacto → tipo_examen (solo para los 5 exámenes con arancel)
  const ARANCEL_TIPO_MAP = {
    'Examen Parcial Recuperatorio': 'parcial_recuperatorio',
    'Examen Final Ordinario':       'final_ord',
    'Examen Final Recuperatorio':   'final_recuperatorio',
    'Examen Final Complementario':  'complementario',
    'Examen Final Extraordinario':  'extraordinario',
  };
  const tipoExamen = ARANCEL_TIPO_MAP[concepto] || null;
  // Validar duplicado: mismo alumno + asignacion + tipo_examen
  if (tipoExamen && asignacion_id) {
    const dup = db.prepare('SELECT id FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND tipo_examen=?').get(alumno_id, asignacion_id, tipoExamen);
    if (dup) { const e = new Error(`El alumno ya tiene habilitación registrada para ${concepto} en esta materia. No se puede pagar dos veces el mismo examen en la misma materia.`); e.status = 400; throw e; }
  }
  const id = 'pg_'+Date.now();
  // Buscar el arancel correspondiente al concepto para validar el monto
  const al = db.prepare('SELECT carrera_id FROM alumnos WHERE id=?').get(alumno_id);
  const tipoMap = {
    'matricula': ['matrícula','matricula'],
    'cuota': ['cuota'],
    'parcial': ['parcial ordinario','parcial recuperatorio','examen parcial'],
    'final': ['final ordinario','final recuperatorio','final complementario','complementario','examen final'],
    'extraordinario': ['extraordinario'],
    'certificado': ['certificado']
  };
  let arancelEsperado = null;
  if (al) {
    const concepto_lower = (concepto||'').toLowerCase();
    for (const [tipo, keywords] of Object.entries(tipoMap)) {
      if (keywords.some(k => concepto_lower.includes(k))) {
        arancelEsperado = db.prepare(
          "SELECT monto FROM aranceles WHERE tipo=? AND activo=1 AND (carrera_id=? OR carrera_id IS NULL) ORDER BY carrera_id DESC LIMIT 1"
        ).get(tipo, al.carrera_id);
        break;
      }
    }
  }
  const montoPagado = parseFloat(monto)||0;
  const montoEsperado = arancelEsperado ? arancelEsperado.monto : null;
  const montoPendiente = montoEsperado && montoPagado < montoEsperado ? montoEsperado - montoPagado : 0;
  db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,descuento,beca,medio_pago,asignacion_id,mora_exonerada,mora_monto) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,alumno_id,periodo_id||null,concepto,montoPagado,fecha_pago||nowDate(),'Pagado',comprobante||null,descuento||0,beca||null,medio_pago||'Efectivo',asignacion_id||null,mora_exonerada?1:0,moraMonto);
  const alNom = db.prepare('SELECT nombre, apellido FROM alumnos WHERE id=?').get(alumno_id);
  audit(usuarioId,'PAGO','pagos',id,{alumno_id, alumno: alNom?`${alNom.apellido}, ${alNom.nombre}`:alumno_id, concepto, monto:montoPagado, medio_pago, mora_exonerada:mora_exonerada?1:0, mora_monto:moraMonto});

  // Auto-crear habilitación por pago de examen con arancel (para la materia específica)
  let habilitadoExamen = false;
  if (tipoExamen && asignacion_id) {
    const fechaHoy = nowDate();
    const habId = 'hab_' + Date.now() + '_' + alumno_id;
    const esRecup = tipoExamen === 'parcial_recuperatorio' ? 1 : 0;
    db.prepare('INSERT OR IGNORE INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado,habilitado_por,fecha,motivo,habilitado_recuperatorio) VALUES (?,?,?,?,1,?,?,?,?)')
      .run(habId, alumno_id, asignacion_id, tipoExamen, usuarioId, fechaHoy, 'Habilitado por pago de '+concepto, esRecup);
    habilitadoExamen = true;
    audit(usuarioId, 'HABILITAR_PAGO_EXAMEN', 'habilitaciones_examen', alumno_id, { concepto, tipo_examen: tipoExamen, asignacion_id });
  }

  // Enviar constancia de pago por WhatsApp
  const alFull = db.prepare('SELECT a.nombre, a.apellido, a.telefono FROM alumnos a WHERE a.id=?').get(alumno_id);
  if (alFull?.telefono) {
    const APP_URL = process.env.APP_URL || 'https://its-sistema-production.up.railway.app/';
    const fechaFmt = (fecha_pago||nowDate()).split('-').reverse().join('/');
    const montoFmt = 'Gs. '+Number(montoPagado).toLocaleString('es-PY');
    const nombreCompleto = `${alFull.nombre} ${alFull.apellido}`.trim();
    // Reemplazar "Cuota N" por nombre del mes completo
    const MESES_CUOTA = ['','Marzo','Abril','Mayo','Junio','Julio','Agosto','Setiembre','Octubre','Noviembre','Diciembre'];
    const conceptoDisplay = concepto.replace(/^Cuota (\d+)$/i, (_, n) => {
      const mes = MESES_CUOTA[parseInt(n)];
      return mes ? `Cuota ${n} — ${mes}` : concepto;
    });
    let lineaMateria = '';
    if (asignacion_id) {
      const asig = db.prepare('SELECT m.nombre as materia_nombre FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id=?').get(asignacion_id);
      if (asig?.materia_nombre) lineaMateria = `\n• Materia: ${asig.materia_nombre}`;
      // Agregar fecha del examen si existe programado
      if (tipoExamen) {
        const tipoExDB = {
          parcial_recuperatorio: 'Recuperatorio',
          final_ord:             'Final',
          final_recuperatorio:   'Final Recuperatorio',
          complementario:        'Complementario',
          extraordinario:        'Extraordinario'
        }[tipoExamen];
        if (tipoExDB) {
          const examen = db.prepare("SELECT fecha FROM examenes WHERE asignacion_id=? AND tipo=? LIMIT 1").get(asignacion_id, tipoExDB);
          if (examen?.fecha) {
            const [ey,em,ed] = examen.fecha.split('-');
            lineaMateria += `\n• Fecha del examen: ${ed}/${em}/${ey}`;
          }
        }
      }
    }
    const pagoTpl = getWASistemaTpl('constancia_pago');
    const waMsg = pagoTpl
      .replace(/\{nombre\}/g, nombreCompleto)
      .replace(/\{concepto\}/g, conceptoDisplay)
      .replace(/\{materia\}/g, lineaMateria)
      .replace(/\{monto\}/g, montoFmt)
      .replace(/\{fecha\}/g, fechaFmt)
      .replace(/\{url\}/g, APP_URL);
    sendWhatsApp(alFull.telefono, waMsg).catch(()=>{});
  }

  return { ok: true, id, monto_esperado: montoEsperado, monto_pagado: montoPagado, monto_pendiente: montoPendiente, habilitado_examen: habilitadoExamen, tipo_examen: tipoExamen };
}
app.post('/api/pagos', auth(ADM), (req, res) => {
  try {
    const result = registrarPagoConHabilitacion(req.user.id, req.body);
    res.json(result);
  } catch(e) { res.status(e.status||500).json({ error: e.message }); }
});
// ── PAGOS PENDIENTES POR WHATSAPP (comprobantes de transferencia) ────────────
app.get('/api/pagos/pendientes-wa', auth(ADM), (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, a.nombre as alumno_nombre, a.apellido as alumno_apellido
    FROM pagos_pendientes_wa p LEFT JOIN alumnos a ON p.alumno_id=a.id
    WHERE p.estado='Pendiente' ORDER BY p.fecha DESC
  `).all();
  res.json(rows);
});
// Pre-carga con IA: lee monto/fecha del comprobante (el director SIEMPRE debe verificar contra su cuenta bancaria)
app.post('/api/pagos/pendientes-wa/:id/leer-ia', auth(ADM), async (req, res) => {
  try {
    const pend = db.prepare("SELECT imagen_data, imagen_mime FROM pagos_pendientes_wa WHERE id=?").get(req.params.id);
    if (!pend) return res.status(404).json({ error: 'No encontrado' });
    const datos = await geminiLeerComprobante(pend.imagen_data, pend.imagen_mime);
    res.json(datos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pagos/leer-comprobante', auth(ADM), upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
    const base64 = req.file.buffer.toString('base64');
    const datos = await geminiLeerComprobante(base64, req.file.mimetype);
    res.json(datos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pagos/pendientes-wa/:id/aprobar', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto, medio_pago, descuento, fecha_pago, asignacion_id } = req.body;
  if (!alumno_id || !concepto || monto === undefined) return res.status(400).json({ error: 'alumno_id, concepto y monto son obligatorios' });
  try {
    const pend = db.prepare("SELECT * FROM pagos_pendientes_wa WHERE id=? AND estado='Pendiente'").get(req.params.id);
    if (!pend) return res.status(404).json({ error: 'No encontrado o ya resuelto' });

    // Misma logica que el registro manual de pagos: si el concepto es un examen con arancel
    // y se indico la materia (asignacion_id), habilita automaticamente esa materia puntual.
    const result = registrarPagoConHabilitacion(req.user.id, {
      alumno_id, periodo_id, concepto, monto, fecha_pago,
      comprobante: 'Transferencia (comprobante WhatsApp)',
      descuento, medio_pago: medio_pago||'Transferencia', asignacion_id
    });

    db.prepare("UPDATE pagos_pendientes_wa SET estado='Aprobado', pago_id=?, resuelto_por=?, fecha_resolucion=? WHERE id=?")
      .run(result.id, req.user.id, nowStr(), req.params.id);

    audit(req.user.id, 'APROBAR_PAGO_WA', 'pagos_pendientes_wa', req.params.id, { alumno_id, concepto, monto: parseFloat(monto)||0, asignacion_id: asignacion_id||null });

    // Si quien mandó el comprobante por WA usa un número distinto al registrado en la
    // ficha del alumno, avisarle igual ahí (la constancia detallada ya se envió al
    // teléfono de la ficha desde registrarPagoConHabilitacion).
    const alTel = db.prepare('SELECT telefono FROM alumnos WHERE id=?').get(alumno_id)?.telefono;
    if (pend.numero && normalizarTelefono(pend.numero) !== normalizarTelefono(alTel||'')) {
      const montoFmt = 'Gs. '+Number(parseFloat(monto)||0).toLocaleString('es-PY');
      enviarWA(pend.numero, `¡Buenas noticias! ✅ Su pago de *${concepto}* por *${montoFmt}* fue verificado y registrado correctamente. Gracias por su transferencia.`, 'pago_aprobado').catch(()=>{});
    }

    res.json({ ok: true, id: result.id, habilitado_examen: result.habilitado_examen, tipo_examen: result.tipo_examen });
  } catch(e) { res.status(e.status||500).json({ error: e.message }); }
});
app.post('/api/pagos/pendientes-wa/:id/rechazar', auth(ADM), (req, res) => {
  const { motivo } = req.body;
  try {
    const pend = db.prepare("SELECT * FROM pagos_pendientes_wa WHERE id=? AND estado='Pendiente'").get(req.params.id);
    if (!pend) return res.status(404).json({ error: 'No encontrado o ya resuelto' });

    db.prepare("UPDATE pagos_pendientes_wa SET estado='Rechazado', resuelto_por=?, fecha_resolucion=? WHERE id=?")
      .run(req.user.id, nowStr(), req.params.id);
    audit(req.user.id, 'RECHAZAR_PAGO_WA', 'pagos_pendientes_wa', req.params.id, { motivo });

    enviarWA(pend.numero, `No pudimos verificar su comprobante de transferencia. 🙏${motivo ? '\nMotivo: '+motivo : ''}\n\nPor favor, comuníquese con el Instituto o envíe nuevamente una imagen clara del comprobante.`, 'pago_rechazado').catch(()=>{});

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pagos/:id', auth(ADM), (req, res) => {
  try {
    const { concepto, monto, fecha_pago, medio_pago, comprobante } = req.body;
    const p = db.prepare('SELECT * FROM pagos WHERE id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pago no encontrado' });
    db.prepare('UPDATE pagos SET concepto=?,monto=?,fecha_pago=?,medio_pago=?,comprobante=? WHERE id=?')
      .run(concepto||p.concepto, parseFloat(monto)||p.monto, fecha_pago||p.fecha_pago, medio_pago||p.medio_pago, comprobante||null, req.params.id);
    audit(req.user.id,'EDIT','pagos',req.params.id,{antes:{concepto:p.concepto,monto:p.monto},despues:{concepto,monto,fecha_pago}});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/pagos/:id', auth(ADM), (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM pagos WHERE id=?').get(req.params.id);
    if (p) {
      // Enriquecer con nombre del alumno para el display
      const al = p.alumno_id ? db.prepare('SELECT nombre, apellido FROM alumnos WHERE id=?').get(p.alumno_id) : null;
      const nombreAl = al ? `${al.nombre||''} ${al.apellido||''}`.trim() : p.alumno_id;
      guardarEnPapelera('pago',
        `${p.concepto||'Pago'} — ${nombreAl} — Gs. ${(p.monto||0).toLocaleString()} (${p.fecha_pago||'sin fecha'})`,
        p, req.user?.id
      );
    }
    db.prepare('DELETE FROM pagos WHERE id=?').run(req.params.id);
    // Si el pago era de un examen con arancel vinculado a una materia, eliminar la habilitación creada por ese pago
    if (p?.asignacion_id && p?.alumno_id) {
      const ARANCEL_TIPO_MAP = {
        'Examen Parcial Recuperatorio': 'parcial_recuperatorio',
        'Examen Final Ordinario':       'final_ord',
        'Examen Final Recuperatorio':   'final_recuperatorio',
        'Examen Final Complementario':  'complementario',
        'Examen Final Extraordinario':  'extraordinario',
      };
      const tipoExamen = ARANCEL_TIPO_MAP[p.concepto] || null;
      if (tipoExamen) {
        db.prepare("DELETE FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND tipo_examen=? AND motivo LIKE 'Habilitado por pago de%'")
          .run(p.alumno_id, p.asignacion_id, tipoExamen);
      }
    }
    audit(req.user.id,'DELETE','pagos',req.params.id,{concepto:p?.concepto,monto:p?.monto});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESUMEN FINANCIERO MENSUAL ───────────────────────────────────────────────
app.get('/api/finanzas/resumen', auth(ADM), (req, res) => {
  try {
    const { mes, anio, carrera_id, medio_pago } = req.query;
    const hoy = nowSys();
    const m = parseInt(mes) || (hoy.getMonth() + 1);
    const a = parseInt(anio) || hoy.getFullYear();
    const desde = `${a}-${String(m).padStart(2,'0')}-01`;
    const hasta = `${a}-${String(m).padStart(2,'0')}-${new Date(a, m, 0).getDate()}`;

    // ── INGRESOS: pagos del mes ──────────────────────────────────────────────
    let pagosWhere = "WHERE p.estado='Pagado' AND p.fecha_pago>=? AND p.fecha_pago<=?";
    const pagosParams = [desde, hasta];
    if (carrera_id) { pagosWhere += ' AND al.carrera_id=?'; pagosParams.push(carrera_id); }
    if (medio_pago) { pagosWhere += ' AND p.medio_pago=?'; pagosParams.push(medio_pago); }

    const pagos = db.prepare(`
      SELECT p.id, p.fecha_pago as fecha, p.concepto, p.monto, p.medio_pago,
        al.nombre as alumno_nombre, al.apellido as alumno_apellido,
        c.nombre as carrera_nombre
      FROM pagos p
      LEFT JOIN alumnos al ON p.alumno_id = al.id
      LEFT JOIN carreras c ON al.carrera_id = c.id
      ${pagosWhere}
      ORDER BY p.fecha_pago DESC
    `).all(...pagosParams);

    const totalIngresos = pagos.reduce((s, p) => s + (p.monto || 0), 0);

    // ── EGRESOS: honorarios del mes ──────────────────────────────────────────
    const honorarios = db.prepare(`
      SELECT h.id, h.fecha, h.monto, h.tipo, h.estado,
        u.nombre as docente_nombre, u.apellido as docente_apellido,
        m.nombre as materia_nombre, ca.nombre as carrera_nombre
      FROM honorarios h
      LEFT JOIN docentes d ON h.docente_id = d.id
      LEFT JOIN usuarios u ON d.usuario_id = u.id
      LEFT JOIN asignaciones a ON h.asignacion_id = a.id
      LEFT JOIN materias m ON a.materia_id = m.id
      LEFT JOIN cursos cu ON a.curso_id = cu.id
      LEFT JOIN carreras ca ON cu.carrera_id = ca.id
      WHERE h.fecha>=? AND h.fecha<=? AND h.estado!='anulado'
      ORDER BY h.fecha DESC
    `).all(desde, hasta);

    const totalEgresos = honorarios.reduce((s, h) => s + (h.monto || 0), 0);

    // ── HONORARIOS ACUMULADOS: clases reales donde el docente pasó asistencia ──
    // Cuenta fechas DISTINTAS de asistencia por asignación en el mes consultado
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    let estimadoHonorarios = 0;
    let clasesEstimadas = [];
    if (periodo) {
      const filas = db.prepare(`
        SELECT a.id as asig_id,
          u.nombre as docente_nombre, u.apellido as docente_apellido,
          m.nombre as materia_nombre,
          COUNT(DISTINCT at2.fecha) as clases,
          COALESCE(ar.monto, 80000) as monto_por_clase
        FROM asignaciones a
        LEFT JOIN docentes d ON a.docente_id = d.id
        LEFT JOIN usuarios u ON d.usuario_id = u.id
        LEFT JOIN materias m ON a.materia_id = m.id
        LEFT JOIN aranceles ar ON ar.tipo='honorario' AND ar.activo=1
        LEFT JOIN asistencia at2 ON at2.asignacion_id = a.id
          AND at2.fecha >= ? AND at2.fecha <= ?
        WHERE a.periodo_id=?
        GROUP BY a.id
        HAVING clases > 0
      `).all(desde, hasta, periodo.id);

      filas.forEach(fila => {
        const monto = fila.clases * (fila.monto_por_clase || 80000);
        estimadoHonorarios += monto;
        clasesEstimadas.push({
          docente: `${fila.docente_apellido||''}, ${fila.docente_nombre||''}`,
          materia: fila.materia_nombre,
          dia: '—',
          clases: fila.clases,
          monto_por_clase: fila.monto_por_clase || 80000,
          total: monto
        });
      });
    }

    // ── MEDIOS DE PAGO disponibles ───────────────────────────────────────────
    const medios = db.prepare("SELECT DISTINCT medio_pago FROM pagos WHERE medio_pago IS NOT NULL ORDER BY medio_pago").all().map(r => r.medio_pago);

    // ── MOVIMIENTOS EXTRA del mes ─────────────────────────────────────────────
    const movExtras = db.prepare(`
      SELECT * FROM movimientos_extra
      WHERE fecha >= ? AND fecha <= ?
      ORDER BY fecha DESC
    `).all(desde, hasta);
    const totalIngresosExtra = movExtras.filter(r=>r.tipo==='ingreso').reduce((s,r)=>s+(r.monto||0),0);
    const totalEgresosExtra  = movExtras.filter(r=>r.tipo==='egreso').reduce((s,r)=>s+(r.monto||0),0);
    const totalIngresosTotal = totalIngresos + totalIngresosExtra;
    const totalEgresosTotal  = totalEgresos  + totalEgresosExtra;

    res.json({
      mes: m, anio: a, desde, hasta,
      ingresos: { total: totalIngresosTotal, detalle: pagos },
      egresos: { total: totalEgresosTotal, detalle: honorarios },
      estimado_honorarios: { total: estimadoHonorarios, detalle: clasesEstimadas },
      movimientos_extra: movExtras,
      ingresos_extra: totalIngresosExtra,
      egresos_extra: totalEgresosExtra,
      balance: totalIngresosTotal - totalEgresosTotal,
      balance_estimado: totalIngresosTotal - estimadoHonorarios,
      alerta_egresos: totalEgresosTotal > totalIngresosTotal * 0.8,
      medios_disponibles: medios
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOVIMIENTOS EXTRA (ingresos/costos adicionales) ──────────────────────────
app.get('/api/movimientos-extra', auth(ADM), (req, res) => {
  try {
    const { desde, hasta, tipo } = req.query;
    let where = '1=1';
    const params = [];
    if (desde) { where += ' AND fecha >= ?'; params.push(desde); }
    if (hasta) { where += ' AND fecha <= ?'; params.push(hasta); }
    if (tipo)  { where += ' AND tipo = ?';   params.push(tipo);  }
    res.json(db.prepare(`SELECT * FROM movimientos_extra WHERE ${where} ORDER BY fecha DESC, created_at DESC`).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/movimientos-extra', auth(ADM), (req, res) => {
  try {
    const { tipo, monto, descripcion, fecha, categoria, referencia, observacion } = req.body;
    if (!tipo || !['ingreso','egreso'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
    if (!monto || isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'monto inválido' });
    if (!descripcion?.trim()) return res.status(400).json({ error: 'descripcion requerida' });
    if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
    const id = 'mx_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
    db.prepare(`INSERT INTO movimientos_extra (id,tipo,monto,descripcion,fecha,categoria,referencia,observacion,registrado_por)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, tipo, parseFloat(monto), descripcion.trim(), fecha, categoria||'Otro', referencia||null, observacion||null, req.user?.id||null);
    audit(req.user?.id, 'crear_movimiento_extra', 'movimientos_extra', id, `${tipo}: Gs. ${monto} — ${descripcion}`);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/movimientos-extra/:id', auth(ADM), (req, res) => {
  try {
    db.prepare('DELETE FROM movimientos_extra WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Deudores — alumnos sin pago de matrícula o cuotas en el período activo
app.get('/api/pagos/deudores', auth(ADM), (req, res) => {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.json([]);
  const { concepto } = req.query;
  const conc = concepto || 'Matrícula';
  res.json(db.prepare(`
    SELECT al.id,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,
      COALESCE(al.ci,u.ci) as ci,al.telefono,c.nombre as carrera_nombre
    FROM alumnos al
    JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE al.estado='Activo'
      AND al.id NOT IN (
        SELECT alumno_id FROM pagos WHERE periodo_id=? AND concepto LIKE ?
      )
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(periodo.id, `%${conc}%`));
});

// Becas y descuentos
app.get('/api/becas', auth(['director','docente']), (req, res) => {
  const { alumno_id } = req.query;
  let where = ''; const params = [];
  if (alumno_id) { where = ' WHERE b.alumno_id=?'; params.push(alumno_id); }
  res.json(db.prepare(`
    SELECT b.*,COALESCE(al.nombre,u.nombre) as alumno_nombre,COALESCE(al.apellido,u.apellido) as alumno_apellido,
      COALESCE(al.ci,u.ci) as alumno_ci,
      c.nombre as carrera_nombre, cu.anio as curso_anio
    FROM becas b
    JOIN alumnos al ON b.alumno_id=al.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    ${where} ORDER BY b.fecha_inicio DESC`).all(...params));
});
app.post('/api/becas', auth(ADM), (req, res) => {
  const { alumno_id, tipo, porcentaje, monto_fijo, descripcion, fecha_inicio, fecha_fin } = req.body;
  const id = 'bc_' + Date.now();
  db.prepare('INSERT INTO becas (id,alumno_id,tipo,porcentaje,monto_fijo,descripcion,fecha_inicio,fecha_fin,activa) VALUES (?,?,?,?,?,?,?,?,1)').run(id,alumno_id,tipo,porcentaje||null,monto_fijo||null,descripcion,fecha_inicio,fecha_fin||null);
  res.json({ id });
});
app.put('/api/becas/:id', auth(ADM), (req, res) => {
  const { tipo, porcentaje, monto_fijo, descripcion, fecha_inicio, fecha_fin, activa } = req.body;
  db.prepare('UPDATE becas SET tipo=?,porcentaje=?,monto_fijo=?,descripcion=?,fecha_inicio=?,fecha_fin=?,activa=? WHERE id=?').run(tipo,porcentaje||null,monto_fijo||null,descripcion,fecha_inicio,fecha_fin||null,activa?1:0,req.params.id);
  res.json({ ok: true });
});
app.delete('/api/becas/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM becas WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth(), (req, res) => {
  const hoy = nowDate();
  const sede = req.user.sede || 'pjc';
  const data = db.transaction(() => {
    const periodo = db.prepare('SELECT id,nombre FROM periodos WHERE activo=1').get();
    return {
      total_alumnos:  db.prepare("SELECT COUNT(*) as n FROM alumnos al LEFT JOIN carreras c ON al.carrera_id=c.id WHERE al.estado='Activo' AND (c.sede_id=? OR al.carrera_id IS NULL)").get(sede).n,
      total_docentes: db.prepare("SELECT COUNT(*) as n FROM usuarios u JOIN docentes d ON u.id=d.usuario_id WHERE u.rol='docente' AND u.activo=1 AND d.sede_id=?").get(sede).n,
      total_pagos_mes: db.prepare("SELECT COUNT(*) as n FROM pagos p JOIN alumnos al ON p.alumno_id=al.id LEFT JOIN carreras c ON al.carrera_id=c.id WHERE strftime('%Y-%m',p.fecha_pago)=strftime('%Y-%m','now') AND p.estado='Pagado' AND (c.sede_id=? OR al.carrera_id IS NULL)").get(sede).n,
      total_carreras: db.prepare("SELECT COUNT(*) as n FROM carreras WHERE activa=1 AND sede_id=?").get(sede).n,
      total_cursos:   db.prepare("SELECT COUNT(*) as n FROM cursos cu JOIN carreras ca ON cu.carrera_id=ca.id WHERE cu.activo=1 AND ca.sede_id=?").get(sede).n,
      periodo_activo: periodo?.nombre || 'Sin período activo',
      aprobados:      db.prepare("SELECT COUNT(*) as n FROM notas n JOIN alumnos al ON n.alumno_id=al.id LEFT JOIN carreras c ON al.carrera_id=c.id WHERE n.estado='Aprobado' AND (c.sede_id=? OR al.carrera_id IS NULL)").get(sede).n,
      reprobados:     db.prepare("SELECT COUNT(*) as n FROM notas n JOIN alumnos al ON n.alumno_id=al.id LEFT JOIN carreras c ON al.carrera_id=c.id WHERE n.estado='Reprobado' AND (c.sede_id=? OR al.carrera_id IS NULL)").get(sede).n,
      examenes_hoy:   periodo ? db.prepare("SELECT COUNT(*) as n FROM examenes e JOIN asignaciones a ON e.asignacion_id=a.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id WHERE e.fecha=? AND e.periodo_id=? AND ca.sede_id=?").get(hoy, periodo.id, sede).n : 0,
      deudores:       periodo ? db.prepare("SELECT COUNT(*) as n FROM alumnos al LEFT JOIN carreras c ON al.carrera_id=c.id WHERE al.estado='Activo' AND (c.sede_id=? OR al.carrera_id IS NULL) AND al.id NOT IN (SELECT alumno_id FROM pagos WHERE periodo_id=? AND concepto LIKE '%Matrícula%')").get(sede, periodo.id).n : 0,
      por_carrera:    db.prepare("SELECT c.nombre,COUNT(a.id) as total FROM carreras c LEFT JOIN alumnos a ON c.id=a.carrera_id AND a.estado='Activo' WHERE c.activa=1 AND c.sede_id=? GROUP BY c.id ORDER BY total DESC").all(sede),
      avisos:         db.prepare("SELECT id,titulo,contenido,tipo,fijado,fecha_creacion,categoria,destinatario FROM avisos WHERE activo=1 AND sede_id=? ORDER BY fijado DESC,fecha_creacion DESC LIMIT 5").all(sede),
      proximos_examenes: periodo ? db.prepare(`
        SELECT e.fecha,e.hora,e.tipo,m.nombre as materia,ca.nombre as carrera,cu.anio,cu.division
        FROM examenes e JOIN asignaciones a ON e.asignacion_id=a.id
        JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id
        JOIN carreras ca ON cu.carrera_id=ca.id
        WHERE e.fecha>=? AND e.periodo_id=? AND ca.sede_id=? ORDER BY e.fecha,e.hora LIMIT 5`).all(hoy, periodo.id, sede) : []
    };
  })();
  res.json(data);
});

// ── EXPORT EXCEL GENÉRICO ─────────────────────────────────────────────────────
app.get('/api/export/:tabla', auth(ADM), (req, res) => {
  const tablas = {
    alumnos: `SELECT COALESCE(al.apellido,u.apellido) as Apellido,COALESCE(al.nombre,u.nombre) as Nombre,
      COALESCE(al.ci,u.ci) as CI,al.matricula as Matricula,c.nombre as Carrera,
      cu.anio as Año,cu.division as Division,al.estado as Estado,al.telefono as Telefono,al.fecha_ingreso as Ingreso
      FROM alumnos al JOIN carreras c ON al.carrera_id=c.id
      LEFT JOIN cursos cu ON al.curso_id=cu.id LEFT JOIN usuarios u ON al.usuario_id=u.id
      ORDER BY c.nombre,COALESCE(al.apellido,u.apellido)`,
    docentes: `SELECT u.apellido as Apellido,u.nombre as Nombre,d.titulo as Titulo,
      d.especialidad as Especialidad,u.email as Email,u.ci as CI,d.telefono as Telefono
      FROM docentes d JOIN usuarios u ON d.usuario_id=u.id ORDER BY u.apellido`,
    pagos: `SELECT COALESCE(al.apellido,u.apellido) as Apellido,COALESCE(al.nombre,u.nombre) as Nombre,
      c.nombre as Carrera,p.concepto as Concepto,p.monto as Monto,p.fecha_pago as Fecha,
      p.estado as Estado,p.comprobante as Comprobante
      FROM pagos p JOIN alumnos al ON p.alumno_id=al.id JOIN carreras c ON al.carrera_id=c.id
      LEFT JOIN usuarios u ON al.usuario_id=u.id ORDER BY p.fecha_pago DESC`,
    notas: `SELECT COALESCE(al.apellido,u.apellido) as Apellido,COALESCE(al.nombre,u.nombre) as Nombre,
      ca.nombre as Carrera,m.nombre as Materia,
      n.tp1 as TP1,n.tp2 as TP2,n.tp3 as TP3,n.tp4 as TP4,n.tp5 as TP5,n.tp_total as TotalTPs,
      n.parcial as Parcial,n.parcial_recuperatorio as ParcialRecup,
      n.final_ord as FinalOrd,n.final_recuperatorio as FinalRecup,n.complementario as Complementario,
      n.extraordinario as Extraordinario,
      n.puntaje_total as Puntaje,n.nota_final as Nota,n.estado as Estado
      FROM notas n JOIN alumnos al ON n.alumno_id=al.id JOIN asignaciones a ON n.asignacion_id=a.id
      JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN usuarios u ON al.usuario_id=u.id ORDER BY ca.nombre,m.nombre,COALESCE(al.apellido,u.apellido)`,
    deudores: `SELECT COALESCE(al.apellido,u.apellido) as Apellido,COALESCE(al.nombre,u.nombre) as Nombre,
      COALESCE(al.ci,u.ci) as CI,al.telefono as Telefono,c.nombre as Carrera
      FROM alumnos al JOIN carreras c ON al.carrera_id=c.id LEFT JOIN usuarios u ON al.usuario_id=u.id
      WHERE al.estado='Activo' AND al.id NOT IN (SELECT alumno_id FROM pagos WHERE periodo_id=(SELECT id FROM periodos WHERE activo=1) AND concepto LIKE '%Matrícula%')
      ORDER BY c.nombre,COALESCE(al.apellido,u.apellido)`,
  };
  const sql = tablas[req.params.tabla];
  if (!sql) return res.status(404).json({ error: 'Tabla no disponible' });
  try {
    const rows = db.prepare(sql).all();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), req.params.tabla);
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="ITS_${req.params.tabla}_${nowDate()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Plantilla Excel para importar exámenes
app.get('/api/examenes/plantilla', auth(ADM), (req, res) => {
  const asigs = db.prepare(`
    SELECT a.id as asignacion_id, m.nombre as materia, m.codigo,
      ca.nombre as carrera, cu.anio, cu.division
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    ORDER BY ca.nombre, cu.anio, m.nombre LIMIT 5`).all();
  const wb = XLSX.utils.book_new();
  const rows = asigs.map(a => ({
    asignacion_id: a.asignacion_id,
    materia: a.materia,
    carrera: a.carrera,
    anio: a.anio,
    division: a.division,
    tipo: 'Parcial',
    fecha: nowDate(),
    hora: '19:00',
    aula: '',
    observacion: ''
  }));
  if (!rows.length) rows.push({ asignacion_id:'PEGAR_ID_ASIGNACION', materia:'Ejemplo', carrera:'', anio:1, division:'U', tipo:'Parcial', fecha:'2026-05-10', hora:'19:00', aula:'Aula 1', observacion:'' });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Examenes');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename="plantilla_examenes_ITS.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Obtener un examen por ID — debe ir DESPUÉS de todas las rutas estáticas /api/examenes/algo
app.get('/api/examenes/:id', auth(), (req, res) => {
  try {
    const e = db.prepare(`
      SELECT e.id, e.asignacion_id, e.tipo, e.fecha, e.hora, e.aula, e.periodo_id,
        e.observacion, e.puntos_max, e.archivo_nombre, e.archivo_tipo,
        (e.archivo_data IS NOT NULL) as tiene_archivo,
        m.nombre as materia_nombre, m.codigo as materia_codigo,
        ca.id as carrera_id, ca.nombre as carrera_nombre,
        cu.id as curso_id, cu.anio as curso_anio, cu.division as curso_division,
        d.id as docente_id,
        u.nombre as docente_nombre, u.apellido as docente_apellido,
        p.nombre as periodo_nombre,
        a.id as asignacion_id, a.turno as asig_turno,
        COALESCE(nc.cnt, 0) as notas_cargadas,
        COALESCE(ac.cnt, 0) as total_alumnos
      FROM examenes e
      LEFT JOIN asignaciones a  ON e.asignacion_id=a.id
      LEFT JOIN materias m      ON a.materia_id=m.id
      LEFT JOIN cursos cu       ON a.curso_id=cu.id
      LEFT JOIN carreras ca     ON cu.carrera_id=ca.id
      LEFT JOIN docentes d      ON a.docente_id=d.id
      LEFT JOIN usuarios u      ON d.usuario_id=u.id
      LEFT JOIN periodos p      ON e.periodo_id=p.id
      LEFT JOIN (SELECT asignacion_id, COUNT(*) as cnt FROM notas GROUP BY asignacion_id) nc
             ON nc.asignacion_id=a.id
      LEFT JOIN (SELECT curso_id, COUNT(*) as cnt FROM alumnos WHERE estado='Activo' GROUP BY curso_id) ac
             ON ac.curso_id=cu.id
      WHERE e.id=?`).get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Examen no encontrado' });
    if (req.user.rol === 'docente') {
      const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
      if (doc && e.docente_id !== doc.id) return res.status(403).json({ error: 'Sin acceso' });
    }
    if (req.user.rol === 'alumno') {
      const al = db.prepare('SELECT carrera_id, curso_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
      if ((al?.carrera_id && e.carrera_id !== al.carrera_id) || (al?.curso_id && e.curso_id !== al.curso_id))
        return res.status(403).json({ error: 'Sin acceso' });
    }
    res.json(e);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Importar exámenes desde Excel — devuelve preview para confirmar
app.post('/api/examenes/importar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const preview = [], pendientes = [];
    const TIPOS_OK = ['Parcial','Recuperatorio','Final','Final Recuperatorio','Complementario','Extraordinario'];

    // Para detectar unificaciones: agrupar por fecha+tipo+docente+turno
    const grupoUnif = {}; // key → [asig_ids]

    rows.forEach((row, i) => {
      let asig_id = String(row.asignacion_id||'').trim();
      const tipo = String(row.tipo||'Parcial').trim();
      const fecha = String(row.fecha||row.Fecha||'').trim();
      const hora_col = String(row.hora||row.Hora||'').trim();
      const aula_col = String(row.aula||row.Aula||'').trim();
      const obs_col  = String(row.observacion||row.Observacion||'').trim();

      // Buscar asignación por docente+materia+carrera+año si no hay asig_id
      if (!asig_id) {
        const docNombre = String(row.profesor||row.docente||row.Docente||'').trim();
        const matNombre = String(row.materia||row.materia_nombre||row.Materia||'').trim();
        const carrNombre = String(row.carrera||row.Carrera||'').trim();
        const anioVal   = String(row.anio||row.año||row.Año||'').trim();
        const secVal    = String(row.seccion||row.sección||row.division||'').trim();
        const turnoVal  = String(row.turno||'').trim();
        if (matNombre) {
          const q = db.prepare(`
            SELECT a.id FROM asignaciones a
            JOIN materias m  ON a.materia_id=m.id
            JOIN cursos cu   ON a.curso_id=cu.id
            JOIN carreras ca ON cu.carrera_id=ca.id
            JOIN docentes d  ON a.docente_id=d.id
            JOIN usuarios u  ON d.usuario_id=u.id
            WHERE m.nombre LIKE ?
            ${carrNombre ? `AND ca.nombre LIKE '%${carrNombre.replace(/'/g,"''")}%'` : ''}
            ${anioVal    ? `AND cu.anio=${parseInt(anioVal)||0}` : ''}
            ${secVal     ? `AND cu.division LIKE '%${secVal.replace(/'/g,"''")}%'` : ''}
            ${docNombre  ? `AND (u.apellido LIKE '%${docNombre.replace(/'/g,"''")}%' OR u.nombre LIKE '%${docNombre.replace(/'/g,"''")}%')` : ''}
            ${turnoVal   ? `AND a.turno=${parseInt(turnoVal)||0}` : ''}
            LIMIT 1`).get('%'+matNombre+'%');
          if (q) asig_id = q.id;
        }
      }

      if (!fecha) { preview.push({...row, error:`Fila ${i+2}: fecha obligatoria`}); return; }
      if (!TIPOS_OK.includes(tipo)) { preview.push({...row, error:`Tipo "${tipo}" inválido`}); return; }
      if (!asig_id) { preview.push({...row, error:`Fila ${i+2}: asignación no encontrada`, materia_nombre:row.materia, carrera:row.carrera, tipo, fecha}); return; }

      const asig = db.prepare(`
        SELECT a.*, m.nombre as materia_nombre, ca.nombre as carrera_nombre,
          cu.anio, cu.division, a.turno,
          d.id as docente_id, u.nombre as doc_nombre, u.apellido as doc_apellido
        FROM asignaciones a
        JOIN materias m  ON a.materia_id=m.id
        JOIN cursos cu   ON a.curso_id=cu.id
        JOIN carreras ca ON cu.carrera_id=ca.id
        JOIN docentes d  ON a.docente_id=d.id
        JOIN usuarios u  ON d.usuario_id=u.id
        WHERE a.id=?`).get(asig_id);

      if (!asig) { preview.push({...row, error:`Fila ${i+2}: asignación no encontrada`, tipo, fecha}); return; }

      // Detectar duplicado exacto (misma asignación+tipo+fecha ya existe en BD)
      const yaExiste = db.prepare('SELECT id FROM examenes WHERE asignacion_id=? AND tipo=? AND fecha=?').get(asig_id, tipo, fecha);
      // Detectar conflicto de docente (mismo docente, fecha, turno, distinta asig)
      const conflictoDoc = db.prepare(`
        SELECT e.id, m2.nombre as materia FROM examenes e
        JOIN asignaciones a2 ON e.asignacion_id=a2.id
        JOIN materias m2 ON a2.materia_id=m2.id
        WHERE a2.docente_id=? AND e.fecha=? AND a2.turno=? AND e.asignacion_id!=?
      `).get(asig.docente_id, fecha, asig.turno, asig_id);

      // Detectar unificación: mismo docente+fecha+turno dentro del MISMO archivo
      const unifKey = `${asig.docente_id}|${fecha}|${asig.turno}|${tipo}`;
      if (!grupoUnif[unifKey]) grupoUnif[unifKey] = [];
      grupoUnif[unifKey].push(asig_id);

      const pMax = tipo === 'Extraordinario' ? 100 : (tipo === 'Parcial'||tipo === 'Recuperatorio') ? 25 : 50;
      const id = 'ex_imp_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);

      pendientes.push({
        id, asig_id, tipo, fecha,
        hora: hora_col||null, aula: aula_col||null,
        periodo_id: periodo?.id||null, observacion: obs_col||null, puntos_max: parseInt(row.puntos_max)||pMax,
        ya_existe: !!yaExiste, unif_key: unifKey
      });
      preview.push({
        id, materia_nombre: asig.materia_nombre, carrera: asig.carrera_nombre,
        anio: asig.anio, seccion: asig.division, turno: asig.turno,
        tipo, fecha, hora: hora_col||null,
        docente: (asig.doc_apellido||'')+', '+(asig.doc_nombre||''),
        duplicado: yaExiste ? `Ya existe este examen en la BD` : null,
        conflicto: conflictoDoc ? `Docente ya tiene "${conflictoDoc.materia}" ese día/turno` : null,
      });
    });

    // Marcar unificaciones detectadas en el preview
    Object.entries(grupoUnif).forEach(([key, asig_ids]) => {
      if (asig_ids.length > 1) {
        preview.forEach(p => {
          const pend = pendientes.find(x => x.id === p.id);
          if (pend?.unif_key === key) {
            p.unificada = `Unificada con ${asig_ids.length - 1} materia(s) más`;
          }
        });
      }
    });

    req.app.locals._importPendiente = pendientes;
    res.json({ preview, ids: pendientes.map(p=>p.id) });
  } catch(e) { res.status(400).json({ error:'Error procesando archivo: '+e.message }); }
});

app.post('/api/examenes/confirmar-importar', auth(ADM), (req, res) => {
  try {
    const pendientes = req.app.locals._importPendiente || [];
    if (!pendientes.length) return res.status(400).json({ error: 'No hay importación pendiente' });
    const { ids } = req.body;
    const aImportar = ids ? pendientes.filter(p => ids.includes(p.id)) : pendientes;
    let importados = 0, omitidos = 0;
    aImportar.forEach(p => {
      if (p.ya_existe) { omitidos++; return; } // no duplicar
      try {
        db.prepare('INSERT OR IGNORE INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion,puntos_max) VALUES (?,?,?,?,?,?,?,?,?)').run(p.id, p.asig_id, p.tipo, p.fecha, p.hora, p.aula, p.periodo_id, p.observacion, p.puntos_max||25);
        importados++;
      } catch { omitidos++; }
    });
    req.app.locals._importPendiente = [];
    audit(req.user.id, 'IMPORTAR', 'examenes', 'bulk', { importados, omitidos });
    res.json({ ok: true, importados, omitidos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HORARIOS ──────────────────────────────────────────────────────────────────
app.get('/api/horarios', auth(), (req, res) => {
  const { asignacion_id, dia, docente_id, docente_usuario_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (asignacion_id)      { where += ' AND h.asignacion_id=?'; params.push(asignacion_id); }
  if (dia)                { where += ' AND h.dia=?';           params.push(dia); }
  if (docente_id)         { where += ' AND a.docente_id=?';    params.push(docente_id); }
  if (docente_usuario_id) { where += ' AND u.id=?';            params.push(docente_usuario_id); }
  res.json(db.prepare(`
    SELECT h.*,
      a.docente_id,
      m.nombre as materia_nombre, m.dia as materia_dia, m.turno as materia_turno,
      ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido, u.id as docente_usuario_id,
      d.titulo as docente_titulo
    FROM horarios h
    LEFT JOIN asignaciones a ON h.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    LEFT JOIN docentes d ON a.docente_id=d.id
    LEFT JOIN usuarios u ON d.usuario_id=u.id
    ${where} ORDER BY h.dia, h.turno, ca.nombre`).all(...params));
});

// ── NOTAS FILTRADAS POR CARRERA/CURSO ─────────────────────────────────────────
app.get('/api/notas/carrera/:carrera_id/curso/:curso_id', auth(), (req, res) => {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.json([]);
  const asigs = db.prepare(`
    SELECT a.id,m.nombre as materia_nombre
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    WHERE a.curso_id=? AND a.periodo_id=?
    ORDER BY m.nombre`).all(req.params.curso_id, periodo.id);
  const alumnos = db.prepare(`
    SELECT al.id, COALESCE(al.nombre,u.nombre) as nombre, COALESCE(al.apellido,u.apellido) as apellido,
      COALESCE(al.ci,u.ci) as ci, al.matricula
    FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE al.curso_id=? AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.curso_id);
  const notasMap = {};
  asigs.forEach(asig => {
    const notas = db.prepare('SELECT * FROM notas WHERE asignacion_id=?').all(asig.id);
    notas.forEach(n => {
      if (!notasMap[n.alumno_id]) notasMap[n.alumno_id] = {};
      notasMap[n.alumno_id][asig.id] = n;
    });
  });
  res.json({ asignaciones: asigs, alumnos, notas: notasMap });
});

// ── GENERACIÓN AUTOMÁTICA DE ASISTENCIAS (desde horarios, desde fecha_inicio) ─
app.post('/api/asistencia/generar', auth(ADM), (req, res) => {
  const { fecha_inicio, fecha_fin } = req.body;
  if (!fecha_inicio) return res.status(400).json({ error: 'fecha_inicio requerida' });
  const horarios = db.prepare('SELECT * FROM horarios WHERE asignacion_id IS NOT NULL').all();
  if (!horarios.length) return res.status(400).json({ error: 'No hay horarios configurados' });

  // Pre-cargar mapa curso_id → [alumno_ids] para evitar N+1 dentro del bucle
  const alumnosPorCurso = {};
  const asigCursoMap = {};
  horarios.forEach(h => {
    const asig = db.prepare('SELECT curso_id FROM asignaciones WHERE id=?').get(h.asignacion_id);
    if (asig) asigCursoMap[h.asignacion_id] = asig.curso_id;
  });
  const cursoIds = [...new Set(Object.values(asigCursoMap))];
  cursoIds.forEach(cid => {
    alumnosPorCurso[cid] = db.prepare("SELECT id FROM alumnos WHERE curso_id=? AND estado='Activo'").all(cid).map(a => a.id);
  });

  const inicio = new Date(fecha_inicio + 'T12:00:00');
  const fin = fecha_fin ? new Date(fecha_fin + 'T12:00:00') : new Date(inicio.getFullYear(), 11, 31, 12);
  const diaNames = ['','Lunes','Martes','Miércoles','Jueves','Viernes'];
  let totalGeneradas = 0;
  const insAs = db.prepare('INSERT OR IGNORE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    const cur = new Date(inicio);
    while (cur <= fin) {
      const diaN = cur.getDay();
      if (diaN >= 1 && diaN <= 5) {
        const diaName = diaNames[diaN];
        const fechaStr = cur.toISOString().split('T')[0];
        horarios.filter(h => h.dia === diaName).forEach(h => {
          const cursoId = asigCursoMap[h.asignacion_id];
          const alumnos = cursoId ? (alumnosPorCurso[cursoId] || []) : [];
          alumnos.forEach(alId => {
            insAs.run('as_' + fechaStr + '_' + h.asignacion_id + '_' + alId, alId, h.asignacion_id, fechaStr, 'P');
            totalGeneradas++;
          });
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
  })();
  res.json({ ok: true, generadas: totalGeneradas });
});

// ── PROMOCIÓN DE ALUMNOS A NUEVO PERIODO ──────────────────────────────────────
app.post('/api/periodos/:id/promover', auth(ADM), (req, res) => {
  const { modo, carrera_id, curso_origen_id, curso_destino_id } = req.body;
  const nuevoPeriodo = db.prepare('SELECT * FROM periodos WHERE id=?').get(req.params.id);
  if (!nuevoPeriodo) return res.status(404).json({ error: 'Período no encontrado' });

  if (modo === 'continuidad') {
    // Copiar todas las asignaciones del período anterior activo al nuevo
    const periodoAnterior = db.prepare('SELECT id FROM periodos WHERE id != ? ORDER BY id DESC LIMIT 1').get(req.params.id);
    if (!periodoAnterior) return res.status(400).json({ error: 'No hay período anterior' });
    const asigs = db.prepare('SELECT * FROM asignaciones WHERE periodo_id=?').all(periodoAnterior.id);
    let copiadas = 0;
    const ins = db.prepare('INSERT OR IGNORE INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)');
    db.transaction(() => {
      asigs.forEach(a => {
        ins.run('asig_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), a.docente_id, a.materia_id, a.curso_id, req.params.id);
        copiadas++;
      });
    })();
    return res.json({ ok: true, copiadas, modo: 'continuidad' });
  }

  if (modo === 'promocion') {
    // Mover alumnos del curso origen al curso destino
    if (!curso_origen_id || !curso_destino_id) return res.status(400).json({ error: 'Indicar curso origen y destino' });
    const alumnos = db.prepare("SELECT id FROM alumnos WHERE curso_id=? AND estado='Activo'").all(curso_origen_id);
    db.transaction(() => {
      alumnos.forEach(al => {
        db.prepare('UPDATE alumnos SET curso_id=? WHERE id=?').run(curso_destino_id, al.id);
      });
    })();
    return res.json({ ok: true, promovidos: alumnos.length, modo: 'promocion' });
  }

  res.status(400).json({ error: 'Modo no reconocido (continuidad|promocion)' });
});

// ── HABILITACIÓN ESPECIAL DE ALUMNO (ignorar bloqueo de mora) ─────────────────
app.put('/api/alumnos/:id/habilitar-recuperatorio', auth(ADM), (req, res) => {
  const { asignacion_id } = req.body;
  const hab = db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=?').get(req.params.id, asignacion_id);
  const fechaHoy = nowDate();
  if (hab) {
    db.prepare('UPDATE habilitaciones_examen SET habilitado_recuperatorio=1,habilitado_por=?,fecha=? WHERE alumno_id=? AND asignacion_id=?').run(req.user.id, fechaHoy, req.params.id, asignacion_id);
  } else {
    db.prepare('INSERT OR IGNORE INTO habilitaciones_examen (alumno_id,asignacion_id,habilitado,habilitado_por,fecha,habilitado_recuperatorio) VALUES (?,?,1,?,?,1)').run(req.params.id, asignacion_id, req.user.id, fechaHoy);
  }
  audit(req.user.id,'HABILITAR_RECUPERATORIO','habilitaciones_examen',req.params.id,{asignacion_id});
  res.json({ ok: true });
});

app.put('/api/alumnos/:id/habilitar-pago', auth(ADM), (req, res) => {
  const { habilitado, asignacion_id, tipo_examen, motivo } = req.body;
  const fechaHoy = nowDate();
  const TIPOS = ['parcial','parcial_recuperatorio','final','final_ord','final_recuperatorio','complementario','extraordinario'];
  const tipoDb = TIPOS.includes(tipo_examen) ? tipo_examen : 'final';
  const hab = asignacion_id
    ? db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND tipo_examen=?').get(req.params.id, asignacion_id, tipoDb)
    : db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=? AND tipo_examen=?').get(req.params.id, tipoDb);
  if (hab) {
    db.prepare('UPDATE habilitaciones_examen SET habilitado=?,habilitado_por=?,fecha=?,motivo=? WHERE id=?').run(habilitado?1:0, req.user.id, fechaHoy, motivo||'Habilitado por Dirección', hab.id);
  } else {
    const id = 'hab_'+Date.now();
    try {
      db.prepare('INSERT INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado,habilitado_por,fecha,motivo) VALUES (?,?,?,?,?,?,?,?)').run(id,req.params.id,asignacion_id||null,tipoDb,habilitado?1:0,req.user.id,fechaHoy,motivo||'Habilitado por Dirección');
    } catch {
      db.prepare('INSERT INTO habilitaciones_examen (id,alumno_id,tipo_examen,habilitado,habilitado_por,fecha) VALUES (?,?,?,?,?,?)').run(id,req.params.id,tipoDb,habilitado?1:0,req.user.id,fechaHoy);
    }
  }
  // Sincronizar flag rápido en alumnos para que habilitaciones-bulk lo detecte
  db.prepare('UPDATE alumnos SET habilitado_pago_pendiente=? WHERE id=?').run(habilitado?1:0, req.params.id);
  audit(req.user.id,'HABILITAR_ALUMNO','habilitaciones_examen',req.params.id,{habilitado,tipo_examen:tipoDb,motivo,asignacion_id});
  res.json({ ok: true });
});

// ── VERIFICAR ESTADO DE HABILITACIÓN PARA EXAMEN ─────────────────────────────
app.get('/api/alumnos/:id/habilitacion', auth(), (req, res) => {
  const al = db.prepare('SELECT id,nombre,apellido,habilitado_pago_pendiente FROM alumnos WHERE id=?').get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });

  // Habilitación especial del director — sobreescribe todo
  if (al.habilitado_pago_pendiente) {
    return res.json({ habilitado: true, razon: 'habilitacion_especial', cuotas_faltantes: [] });
  }

  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.json({ habilitado: true, razon: 'sin_periodo_activo', cuotas_faltantes: [] });

  // Regla exacta: cuotas 1, 2, 3, 4 y 5 deben estar pagadas
  // Cuota 1 = marzo, Cuota 2 = abril, Cuota 3 = mayo, Cuota 4 = junio, Cuota 5 = julio
  const cuotasRequeridas = ['Cuota 1', 'Cuota 2', 'Cuota 3', 'Cuota 4', 'Cuota 5'];
  const pagosPeriodo = db.prepare(`
    SELECT concepto FROM pagos
    WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'`).all(req.params.id, periodo.id);

  const conceptosPagados = pagosPeriodo.map(p => p.concepto);

  // Verificar cada cuota requerida — comparación EXACTA para evitar que
  // 'Cuota 10'.includes('Cuota 1') dé falsos positivos
  const cuotasFaltantes = cuotasRequeridas.filter(cuota =>
    !conceptosPagados.some(c => c === cuota)
  );

  if (cuotasFaltantes.length === 0) {
    return res.json({ habilitado: true, razon: 'pago_al_dia', cuotas_faltantes: [] });
  }

  // Sin ninguna cuota ni matrícula → mora total
  return res.json({
    habilitado: false,
    razon: 'mora_de_pago',
    alumno: `${al.apellido}, ${al.nombre}`,
    cuotas_faltantes: cuotasFaltantes,
    detalle: `Faltan: ${cuotasFaltantes.join(', ')}`
  });
});

// ── MOVER ALUMNO A OTRA CARRERA/SECCIÓN ──────────────────────────────────────
app.put('/api/alumnos/:id/asignar', auth(ADM), (req, res) => {
  const { carrera_id, curso_id } = req.body;
  const al = db.prepare('SELECT id,nombre,apellido,carrera_id,curso_id FROM alumnos WHERE id=?').get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const anterior = { carrera_id: al.carrera_id, curso_id: al.curso_id };
  db.prepare('UPDATE alumnos SET carrera_id=?,curso_id=? WHERE id=?').run(carrera_id||null, curso_id||null, al.id);
  // Si hay nueva sección, crear registros de notas pendientes
  if (curso_id) {
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (periodo) {
      const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(curso_id, periodo.id);
      const stmtNota = db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)');
      asigs.forEach(asig => {
        try { stmtNota.run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, asig.id, 'Pendiente'); } catch {}
      });
    }
  }
  const nuevaCarr = carrera_id ? db.prepare('SELECT nombre FROM carreras WHERE id=?').get(carrera_id) : null;
  const nuevoCurso = curso_id ? db.prepare('SELECT anio,division FROM cursos WHERE id=?').get(curso_id) : null;
  audit(req.user.id, 'ASIGNAR', 'alumnos', req.params.id, {
    alumno: `${al.apellido||''}, ${al.nombre||''}`,
    anterior,
    carrera_nombre: nuevaCarr?.nombre || null,
    curso_desc: nuevoCurso ? `${nuevoCurso.anio}°${nuevoCurso.division && nuevoCurso.division!=='U'?' '+nuevoCurso.division:''}` : null
  });
  res.json({ ok: true });
});

// ── PREVISUALIZAR SIN ASIGNAR ─────────────────────────────────────────────────
app.post('/api/pagos/previsualizar-sin-asignar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', header: 1, raw: true });
    if (!rawRows.length) return res.status(400).json({ error: 'Archivo vacío' });
    function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rawRows.length, 6); i++) {
      if (rawRows[i].some(c => /cedula|c\.i\.|^ci$/i.test(norm(c)))) { headerRowIdx = i; break; }
    }
    if (headerRowIdx < 0) return res.status(400).json({ error: 'No se encontró columna "Cédula" o "CI"' });
    const headers = rawRows[headerRowIdx].map(h => norm(h));
    const origHeaders = rawRows[headerRowIdx].map(h => String(h||'').trim());
    const dataRows = rawRows.slice(headerRowIdx + 1);
    const ciIdx = headers.findIndex(h => /cedula|c\.i\.|^ci$/.test(h));
    const nombreIdx = headers.findIndex(h => /\bnombre\b|alumno/i.test(h));
    const apellidoIdx = headers.findIndex(h => /apellido/i.test(h));
    const pagoStart = Math.max(ciIdx, nombreIdx, apellidoIdx) + 1;
    const pagoIdxs = headers.reduce((acc, h, idx) => { if (idx >= pagoStart) acc.push({ idx, h: origHeaders[idx] }); return acc; }, []);
    const mesMap = {
      marzo:'Cuota 1',abril:'Cuota 2',mayo:'Cuota 3',junio:'Cuota 4',
      julio:'Cuota 5',agosto:'Cuota 6',septiembre:'Cuota 7',setiembre:'Cuota 7',
      octubre:'Cuota 8',noviembre:'Cuota 9',diciembre:'Cuota 10',
      enero:'Cuota 11',febrero:'Cuota 12',
      'cuota 1':'Cuota 1','cuota 2':'Cuota 2','cuota 3':'Cuota 3','cuota 4':'Cuota 4',
      'cuota 5':'Cuota 5','cuota 6':'Cuota 6','cuota 7':'Cuota 7','cuota 8':'Cuota 8',
      'cuota 9':'Cuota 9','cuota 10':'Cuota 10','cuota 11':'Cuota 11','cuota 12':'Cuota 12',
    };
    const stmtCI = db.prepare(`SELECT al.id,COALESCE(al.nombre,u.nombre) as nom,COALESCE(al.apellido,u.apellido) as ape,c.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_div FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN cursos cu ON al.curso_id=cu.id WHERE COALESCE(al.ci,u.ci)=?`);
    const stmtNom = db.prepare(`SELECT al.id,COALESCE(al.nombre,u.nombre) as nom,COALESCE(al.apellido,u.apellido) as ape,c.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_div FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN cursos cu ON al.curso_id=cu.id WHERE LOWER(TRIM(COALESCE(al.nombre,u.nombre)||' '||COALESCE(al.apellido,u.apellido)))=? OR LOWER(TRIM(COALESCE(al.apellido,u.apellido)||' '||COALESCE(al.nombre,u.nombre)))=? LIMIT 1`);
    const stmtPagosAl = db.prepare(`SELECT concepto, monto, fecha_pago, estado FROM pagos WHERE alumno_id=? ORDER BY fecha_pago`);
    const filas = [];
    dataRows.forEach(row => {
      const ciRaw = ciIdx >= 0 ? row[ciIdx] : '';
      const ci = typeof ciRaw === 'number' ? String(Math.round(ciRaw)) : String(ciRaw||'').replace(/[^0-9]/g,'');
      if (!ci || ci.length < 5) return;
      const nombreRaw = nombreIdx >= 0 ? String(row[nombreIdx]||'').trim() : '';
      const apellidoRaw = apellidoIdx >= 0 ? String(row[apellidoIdx]||'').trim() : '';
      let nombre = nombreRaw, apellido = apellidoRaw;
      if (!apellido && nombreRaw) { const p=nombreRaw.split(/\s+/).filter(Boolean); if(p.length>=2){nombre=p[0];apellido=p.slice(1).join(' ');} }
      let existente = stmtCI.get(ci);
      let matchTipo = existente ? 'ci' : null;
      if (!existente && (nombre||apellido)) {
        const q = norm(nombre+' '+apellido);
        const q2 = norm(apellido+' '+nombre);
        existente = stmtNom.get(q, q2);
        if (existente) matchTipo = 'nombre';
      }
      const pagos = pagoIdxs.map(({ idx, h }) => {
        const v = row[idx];
        let monto = typeof v==='number' ? Math.round(v) : Math.round(parseFloat(String(v||'').replace(/[^0-9,\.]/g,'').replace(',','.'))||0);
        const normH = norm(h);
        const concepto = mesMap[normH] || (normH.includes('matricula')?'Matrícula':h.charAt(0).toUpperCase()+h.slice(1));
        return { col: h, concepto, monto: monto||0 };
      });
      // Para alumnos existentes, traer sus pagos actuales del sistema
      let pagosActuales = [];
      if (existente) {
        pagosActuales = stmtPagosAl.all(existente.id).map(p => ({ concepto: p.concepto, monto: p.monto, fecha: p.fecha_pago, estado: p.estado }));
      }
      filas.push({ ci, nombre, apellido, esNuevo: !existente, matchTipo,
        existente: existente ? { id:existente.id, nombre:existente.nom, apellido:existente.ape, carrera_nombre:existente.carrera_nombre||null, curso_anio:existente.curso_anio||null, curso_div:existente.curso_div||null, pagosActuales } : null,
        pagos });
    });
    res.json({ filas, columnas: pagoIdxs.map(p => p.h) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORTAR PAGOS SIN ASIGNAR CARRERA/SECCIÓN ───────────────────────────────
app.post('/api/pagos/importar-sin-asignar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', header: 1, raw: true });
    if (!rawRows.length) return res.status(400).json({ error: 'Archivo vacío' });

    // Detectar fila de encabezados
    function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rawRows.length, 6); i++) {
      const row = rawRows[i];
      if (row.some(c => /cedula|c\.i\.|^ci$/i.test(norm(c)))) { headerRowIdx = i; break; }
    }
    if (headerRowIdx < 0) return res.status(400).json({ error: 'No se encontró fila de encabezados (necesita columna "Cédula" o "CI")' });

    const headers   = rawRows[headerRowIdx].map(h => norm(h));
    const dataRows  = rawRows.slice(headerRowIdx + 1);
    const ciIdx     = headers.findIndex(h => /cedula|c\.i\.|^ci$/.test(h));
    const nombreIdx = headers.findIndex(h => /nombre|alumno/i.test(h));
    const apellidoIdx = headers.findIndex(h => /apellido/i.test(h));

    // Columnas de pago
    const pagoStart = Math.max(ciIdx, nombreIdx, apellidoIdx) + 1;
    const pagoIdxs  = headers.reduce((acc, h, idx) => { if (idx >= pagoStart) acc.push({ idx, h }); return acc; }, []);

    const mesMap = {
      marzo:'Cuota 1',  abril:'Cuota 2',  mayo:'Cuota 3',   junio:'Cuota 4',
      julio:'Cuota 5',  agosto:'Cuota 6', septiembre:'Cuota 7', setiembre:'Cuota 7',
      octubre:'Cuota 8',noviembre:'Cuota 9',diciembre:'Cuota 10',
      enero:'Cuota 11', febrero:'Cuota 12',
      'cuota 1':'Cuota 1','cuota 2':'Cuota 2','cuota 3':'Cuota 3','cuota 4':'Cuota 4',
      'cuota 5':'Cuota 5','cuota 6':'Cuota 6','cuota 7':'Cuota 7','cuota 8':'Cuota 8',
      'cuota 9':'Cuota 9','cuota 10':'Cuota 10','cuota 11':'Cuota 11','cuota 12':'Cuota 12',
    };

    function normId(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,''); }

    // Decisiones por CI: 'sin_asignar' = quitar carrera | 'mantener' = no tocar carrera
    let decisiones = {};
    try { decisiones = JSON.parse(req.body.decisiones || '{}'); } catch {}
    // Normalizar claves
    const decisionesNorm = {};
    Object.entries(decisiones).forEach(([ci, dec]) => { decisionesNorm[ci.replace(/[^0-9]/g,'')] = dec; });

    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const stmtBuscarCI   = db.prepare('SELECT id FROM alumnos WHERE ci=?');
    const stmtUsuExiste  = db.prepare('SELECT id FROM usuarios WHERE ci=?');
    const stmtCheckEmail = db.prepare("SELECT id FROM usuarios WHERE email=? AND COALESCE(ci,'')!=?");
    const stmtInsertUsu  = db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)');
    const stmtInsertAl   = db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const stmtCheckPago  = db.prepare('SELECT id FROM pagos WHERE alumno_id=? AND concepto=? AND periodo_id=?');
    const stmtInsertPago = db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,medio_pago) VALUES (?,?,?,?,?,?,?,?)');
    const stmtSinAsignar = db.prepare('UPDATE alumnos SET carrera_id=NULL, curso_id=NULL WHERE id=?');

    const results = { ok: 0, errores: [], alumnos_creados: 0, columnas: pagoIdxs.map(p => p.h) };
    const hoy = nowDate();
    let seq = 0; // contador para IDs únicos

    const auditDetalle = { alumnos_nuevos: [], pagos_registrados: [], movidos_sin_asignar: [], errores_ci: [] };

    db.transaction(() => {
      dataRows.forEach(row => {
        const ciRaw = ciIdx >= 0 ? row[ciIdx] : '';
        const ci = typeof ciRaw === 'number' ? String(Math.round(ciRaw)) : String(ciRaw||'').replace(/[^0-9]/g,'');
        if (!ci || ci.length < 5) return;

        const nombreRaw = nombreIdx >= 0 ? String(row[nombreIdx]||'').trim() : '';
        const apellidoRaw = apellidoIdx >= 0 ? String(row[apellidoIdx]||'').trim() : '';
        let nombre = nombreRaw, apellido = apellidoRaw;
        if (!apellido && nombreRaw) {
          const partes = nombreRaw.split(/\s+/).filter(Boolean);
          if (partes.length >= 2) { nombre = partes[0]; apellido = partes.slice(1).join(' '); }
        }

        try {
          let al = stmtBuscarCI.get(ci);
          if (!al) {
            // Crear alumno NUEVO sin carrera ni curso
            const nPart = normId(nombre.split(' ')[0]);
            const aPart = normId(apellido.split(' ').pop()).slice(0,4);
            let emailBase = nPart && aPart ? `${nPart}.${aPart}` : (nPart || `alumno.${ci}`);
            let emailAuto = `${emailBase}@its.edu.py`;
            if (stmtCheckEmail.get(emailAuto, ci)) emailAuto = `${emailBase}.${ci.slice(-3)}@its.edu.py`;
            const aid = `a_imp_${seq++}_${Math.random().toString(36).slice(2,6)}`;
            let uid = null;
            const usuExiste = stmtUsuExiste.get(ci);
            if (!usuExiste) {
              uid = `u_imp_${seq++}_${Math.random().toString(36).slice(2,5)}`;
              try { stmtInsertUsu.run(uid, nombre, apellido, ci, emailAuto, bcrypt.hashSync(ci,10), 'alumno'); } catch { uid = null; }
            } else { uid = usuExiste.id; }
            stmtInsertAl.run(aid, uid, null, null, null, hoy, 'Activo', ci, nombre, apellido);
            al = { id: aid };
            results.alumnos_creados++;
            auditDetalle.alumnos_nuevos.push({ ci, nombre: `${apellido}, ${nombre}`, alumno_id: aid });
          } else {
            // Alumno existente: aplicar decisión de carrera si corresponde
            if (decisionesNorm[ci] === 'sin_asignar') {
              stmtSinAsignar.run(al.id);
              auditDetalle.movidos_sin_asignar.push({ ci, alumno_id: al.id });
            }
          }

          // Registrar pagos (solo los que no existen aún)
          const periodoId = periodo?.id || null;
          pagoIdxs.forEach(({ idx, h }) => {
            const cellVal = row[idx];
            let monto = typeof cellVal === 'number' ? Math.round(cellVal)
              : Math.round(parseFloat(String(cellVal||'').replace(/[^0-9,\.]/g,'').replace(',','.'))||0);
            if (!monto || monto <= 0) return;
            const normH = norm(h);
            const concepto = mesMap[normH] || (normH.includes('matricula') ? 'Matrícula' : h.charAt(0).toUpperCase()+h.slice(1));
            if (stmtCheckPago.get(al.id, concepto, periodoId)) return;
            const pgId = `pg_imp_${seq++}_${Math.random().toString(36).slice(2,5)}`;
            stmtInsertPago.run(pgId, al.id, periodoId, concepto, monto, hoy, 'Pagado', 'Importado');
            results.ok++;
            auditDetalle.pagos_registrados.push({ ci, concepto, monto, alumno_id: al.id });
          });
        } catch(e) {
          results.errores.push(`CI ${ci}: ${e.message}`);
          auditDetalle.errores_ci.push(`CI ${ci}: ${e.message}`);
        }
      });
    })();

    // Registrar en auditoría
    audit(req.user.id, 'IMPORTAR_SIN_ASIGNAR', 'pagos', 'importacion', {
      archivo: req.file?.originalname || 'planilla',
      pagos_registrados: results.ok,
      alumnos_creados: results.alumnos_creados,
      movidos_sin_asignar: auditDetalle.movidos_sin_asignar.length,
      errores: results.errores.length,
      detalle_alumnos_nuevos: auditDetalle.alumnos_nuevos,
      detalle_movidos: auditDetalle.movidos_sin_asignar,
      detalle_pagos: auditDetalle.pagos_registrados,
      detalle_errores: auditDetalle.errores_ci.slice(0, 10)
    });

    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORTACIÓN MASIVA DE PAGOS DESDE EXCEL ───────────────────────────────────
app.post('/api/pagos/importar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const results = { ok: 0, conflictos: [], errores: [] };
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();

    rows.forEach((row, i) => {
      try {
        const ci = String(row['Cédula de Identidad'] || row['CI'] || row['ci'] || row['cedula'] || '').trim().replace(/[^0-9]/g,'');
        const nombre = String(row['Nombre'] || row['nombre'] || row['Apellido y Nombre'] || '').trim();
        const concepto = String(row['Concepto'] || row['concepto'] || 'Cuota').trim();
        const monto = parseFloat(row['Monto'] || row['monto'] || 0);
        const fecha = String(row['Fecha'] || row['fecha'] || nowDate()).trim();
        if (!ci || ci.length < 5) return;

        const al = db.prepare('SELECT id,nombre,apellido,carrera_id FROM alumnos WHERE ci=?').get(ci);
        if (!al) { results.errores.push(`Fila ${i+2}: CI ${ci} no encontrada`); return; }

        const carr = db.prepare('SELECT nombre FROM carreras WHERE id=?').get(al.carrera_id);
        const pagoExistente = db.prepare('SELECT id FROM pagos WHERE alumno_id=? AND concepto=? AND periodo_id=?').get(al.id, concepto, periodo?.id||null);

        if (pagoExistente) {
          results.conflictos.push({
            fila: i+2, alumno_id: al.id,
            nombre: `${al.apellido}, ${al.nombre}`,
            ci, concepto, monto, fecha,
            carrera: carr?.nombre || '',
            pago_id: pagoExistente.id
          });
        } else {
          db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,medio_pago) VALUES (?,?,?,?,?,?,?,?)').run('pg_'+Date.now()+'_'+Math.random().toString(36).slice(2,4), al.id, periodo?.id||null, concepto, monto, fecha, 'Pagado', 'Transferencia');
          results.ok++;
        }
      } catch(e) { results.errores.push(`Fila ${i+2}: ${e.message}`); }
    });
    audit(req.user.id, 'IMPORTAR_PAGOS', 'pagos', 'importacion', {
      archivo: req.file?.originalname || 'planilla',
      pagos_registrados: results.ok,
      conflictos: results.conflictos.length,
      errores: results.errores.length
    });
    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando archivo: '+e.message }); }
});

// ── HELPER COMPARTIDO: parsear planilla Excel → JSON (sin guardar en DB) ─────
function parsearPlanillaXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw:true → celdas numéricas devuelven números reales; garantiza mapeo estricto por posición
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, header: 1 });
  if (!rawRows.length) throw new Error('Sin datos en el archivo');

  const norm = h => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/^["']|["']$/g,'').trim();
  // Año escolar paraguayo: Cuota 1 = Marzo, Cuota 2 = Abril, ..., Cuota 10 = Diciembre
  // Cuota 11 = Enero, Cuota 12 = Febrero (meses restantes inicio/fin de año)
  const mesMap = {
    marzo:'Cuota 1',  abril:'Cuota 2',      mayo:'Cuota 3',      junio:'Cuota 4',
    julio:'Cuota 5',  agosto:'Cuota 6',      septiembre:'Cuota 7',setiembre:'Cuota 7',
    octubre:'Cuota 8',noviembre:'Cuota 9',   diciembre:'Cuota 10',
    enero:'Cuota 11', febrero:'Cuota 12',
    'cuota 1':'Cuota 1','cuota 2':'Cuota 2','cuota 3':'Cuota 3','cuota 4':'Cuota 4',
    'cuota 5':'Cuota 5','cuota 6':'Cuota 6','cuota 7':'Cuota 7','cuota 8':'Cuota 8',
    'cuota 9':'Cuota 9','cuota 10':'Cuota 10','cuota 11':'Cuota 11','cuota 12':'Cuota 12',
  };

  // Fila de cabeceras: buscar la primera fila que tenga "cedula" o "ci"
  let headerRowIdx = -1, headers = [];
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    if (rawRows[i].some(c => /cedula|c\.i\.|^ci$/.test(norm(String(c))))) {
      headerRowIdx = i;
      headers = rawRows[i].map(c => (c === '' || c == null) ? '' : String(c));
      break;
    }
  }
  if (headerRowIdx < 0) throw new Error('No se encontró columna "Cédula" o "CI" en el archivo');

  const dataRows  = rawRows.slice(headerRowIdx + 1);
  const ciIdx     = headers.findIndex(h => /cedula|c\.i\.|^ci$/.test(norm(h)));
  const nombreIdx = headers.findIndex(h => /nombre|alumno/i.test(norm(h)));
  const matIdx    = headers.findIndex(h => /matricula/i.test(norm(h)));
  const pagoStart = matIdx >= 0 ? matIdx : (ciIdx >= 0 ? ciIdx + 1 : 2);
  const pagoIdxs  = headers.reduce((acc, h, idx) => { if (idx >= pagoStart) acc.push({ idx, h: h.trim() }); return acc; }, []);

  // Concepto detectado para cada columna de pago
  const conceptos = pagoIdxs.map(({ h }) => {
    const hN = norm(h);
    if (/matricula/.test(hN)) return 'Matrícula';
    return mesMap[hN] || h.trim();
  });

  // Cache de alumnos sin CI para búsqueda por nombre
  const normNombre = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  const alumnosSinCI = db.prepare("SELECT id, COALESCE(nombre,'') as nombre, COALESCE(apellido,'') as apellido FROM alumnos WHERE ci IS NULL OR ci=''").all();

  const filas = [];
  dataRows.forEach(row => {
    const ciRaw = ciIdx >= 0 ? row[ciIdx] : '';
    const ci = typeof ciRaw === 'number' ? String(Math.round(ciRaw)) : String(ciRaw||'').replace(/[^0-9]/g,'');

    const nombreCompleto = nombreIdx >= 0 ? String(row[nombreIdx]||'').trim() : '';
    const partes = nombreCompleto.split(/\s+/).filter(Boolean);
    let nombre = nombreCompleto, apellido = '';
    if (partes.length >= 3) { nombre = partes.slice(0,Math.ceil(partes.length/2)).join(' '); apellido = partes.slice(Math.ceil(partes.length/2)).join(' '); }
    else if (partes.length === 2) { nombre = partes[0]; apellido = partes[1]; }

    // Saltar filas completamente vacías (sin CI ni nombre)
    if ((!ci || ci.length < 5) && !nombreCompleto) return;

    // Montos: mapeo ESTRICTO por índice de columna — nunca por valor
    const montos = pagoIdxs.map(({ idx }) => {
      const cv = row[idx];
      if (typeof cv === 'number') return cv > 0 ? cv : 0;
      const s = String(cv||'').trim();
      if (!s) return 0;
      const m = parseFloat(s.replace(/[^0-9.]/g,'').replace(/\./g,''));
      return (!isNaN(m) && m > 0) ? m : 0;
    });

    // Buscar alumno:
    // 1) Si la fila TIENE CI → buscar SOLO por CI exacta. Si no coincide = alumno nuevo (no caer al nombre).
    // 2) Si la fila NO tiene CI → buscar SOLO por nombre+apellido exacto contra alumnos sin CI en el sistema.
    let existente = null;
    let alumno_id = null;
    let match_tipo = null;
    const tieneCI = ci && ci.length >= 5;
    if (tieneCI) {
      existente = db.prepare('SELECT a.id, a.ci as ci_sistema, a.nombre as nombre_sistema, a.apellido as apellido_sistema, a.carrera_id, c.nombre as carrera_nombre FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id WHERE a.ci=?').get(ci);
      if (existente) {
        alumno_id = existente.id;
        // Verificar si el nombre también coincide exactamente
        const normSis = normNombre((existente.nombre_sistema||'') + ' ' + (existente.apellido_sistema||''));
        const normSisInv = normNombre((existente.apellido_sistema||'') + ' ' + (existente.nombre_sistema||''));
        const normPlan = normNombre(nombreCompleto);
        const nombreCoincide = nombreCompleto && (normSis === normPlan || normSisInv === normPlan);
        match_tipo = nombreCoincide ? 'ci_nombre' : 'ci';
      }
      // SI tiene CI pero no coincide con nadie → es alumno nuevo, NO buscar por nombre
    } else if (nombreCompleto) {
      // Solo buscar por nombre cuando la fila no tiene CI
      const normTarget = normNombre(nombreCompleto);
      const match = alumnosSinCI.find(al => {
        const nombreAp = normNombre((al.nombre||'') + ' ' + (al.apellido||''));
        const apNombre = normNombre((al.apellido||'') + ' ' + (al.nombre||''));
        return nombreAp === normTarget || apNombre === normTarget;
      });
      if (match) {
        alumno_id = match.id;
        existente = db.prepare('SELECT a.id, a.ci as ci_sistema, a.nombre as nombre_sistema, a.apellido as apellido_sistema, a.carrera_id, c.nombre as carrera_nombre FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id WHERE a.id=?').get(match.id) || match;
        match_tipo = 'nombre';
      }
    }

    let carrera_anterior = null;
    let tiene_pagos = false;
    let nombre_sistema = null;
    if (existente) {
      const pc = db.prepare('SELECT COUNT(*) as n FROM pagos WHERE alumno_id=?').get(existente.id);
      tiene_pagos = pc.n > 0;
      if (existente.carrera_id) carrera_anterior = { id: existente.carrera_id, nombre: existente.carrera_nombre || existente.carrera_id };
      nombre_sistema = ((existente.nombre_sistema||'') + ' ' + (existente.apellido_sistema||'')).trim() || null;
    }

    filas.push({ ci, nombre, apellido, nombreCompleto, alumno_existente: !!existente, alumno_id: alumno_id||null, montos, carrera_anterior: carrera_anterior||null, tiene_pagos, match_tipo, nombre_sistema });
  });

  return { columnas: pagoIdxs.map(p => p.h), conceptos, filas };
}

// ── PASO 1: PREVISUALIZAR planilla (parse sin guardar, para revisión manual) ─
app.post('/api/pagos/previsualizar-planilla', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const { carrera_id, curso_id } = req.body;
    const parsed = parsearPlanillaXLSX(req.file.buffer);
    res.json({ carrera_id, curso_id, ...parsed });
  } catch(e) { res.status(400).json({ error: 'Error al leer planilla: '+e.message }); }
});

// ── PASO 2: CONFIRMAR importación (recibe JSON revisado por usuario, guarda en DB) ─
app.post('/api/pagos/importar-planilla-confirmada', auth(ADM), (req, res) => {
  try {
    const { carrera_id, curso_id, conceptos, filas } = req.body;
    if (!Array.isArray(conceptos) || !Array.isArray(filas)) return res.status(400).json({ error: 'Datos inválidos' });

    const normId = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const carr = carrera_id ? db.prepare('SELECT id,codigo,nombre FROM carreras WHERE id=?').get(carrera_id) : null;

    const stmtCI      = db.prepare('SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE ci=?');
    const stmtChkMail = db.prepare('SELECT id FROM usuarios WHERE email=? AND COALESCE(ci,\'\')!=?');
    const stmtUsuEx   = db.prepare('SELECT id FROM usuarios WHERE ci=?');
    const stmtInsUsu  = db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)');
    const stmtCnt     = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?');
    const stmtInsAl   = db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const stmtUpdAl   = db.prepare('UPDATE alumnos SET carrera_id=?,curso_id=? WHERE id=?');
    const stmtAsigs   = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?');
    const stmtInsNota = db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)');
    const stmtChkPago = db.prepare('SELECT id FROM pagos WHERE alumno_id=? AND concepto=? AND periodo_id=?');
    const stmtInsPago = db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,medio_pago) VALUES (?,?,?,?,?,?,?,?)');

    const results = { ok: 0, errores: [], alumnos_creados: 0, alumnos_actualizados: 0, credenciales: [] };

    const stmtByID = db.prepare('SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE id=?');
    db.transaction(() => {
      filas.forEach(({ ci, nombre, apellido, nombreCompleto, montos, alumno_id, reasignar }) => {
        // Saltar solo filas completamente vacías (sin nombre ni alumno_id)
        if (!nombreCompleto && !nombre && !alumno_id) return;
        const ciValida = ci && ci.length >= 5;
        try {
          let al = alumno_id ? stmtByID.get(alumno_id) : null;
          if (!al && ciValida) al = stmtCI.get(ci);

          if (!al && carrera_id) {
            const _yrI1 = nowSys().getFullYear(); const _pfxI1 = carr ? `${carr.codigo}-${_yrI1}-` : null;
            const _matsI1 = _pfxI1 ? db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carrera_id, _pfxI1+'%') : [];
            const _maxI1 = _matsI1.reduce((mx,r)=>{const n=parseInt((r.matricula||'').slice((_pfxI1||'').length))||0;return Math.max(mx,n);},0);
            const matricula = carr ? `${_pfxI1}${String(_maxI1+1).padStart(3,'0')}` : null;
            const aid = 'a_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
            let uid = null;
            if (ciValida) {
              // Con CI: crear cuenta de usuario
              const nPart = normId((nombre||'').split(' ')[0]);
              const aPart = normId((apellido||'').split(' ').pop()).slice(0,4);
              let emailBase = nPart && aPart ? `${nPart}.${aPart}` : (nPart || `alumno.${ci}`);
              let emailAuto = `${emailBase}@its.edu.py`;
              if (stmtChkMail.get(emailAuto, ci)) emailAuto = `${emailBase}.${ci.slice(-3)}@its.edu.py`;
              const usuEx = stmtUsuEx.get(ci);
              if (!usuEx) {
                uid = 'u_e_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
                try { stmtInsUsu.run(uid, nombre, apellido, ci, emailAuto, bcrypt.hashSync(ci,10), 'alumno'); } catch { uid = null; }
              } else { uid = usuEx.id; }
              stmtInsAl.run(aid, uid, matricula, carrera_id, curso_id||null, nowDate(), 'Activo', ci, nombre, apellido);
              results.credenciales.push({ nombre: nombreCompleto||`${nombre} ${apellido}`, usuario: emailAuto, password: ci });
            } else {
              // Sin CI: estado Activo (CI nula es el indicador de que falta la cédula)
              stmtInsAl.run(aid, null, matricula, carrera_id, curso_id||null, nowDate(), 'Activo', null, nombre, apellido);
            }
            if (curso_id) stmtAsigs.all(curso_id, periodo?.id||null).forEach(a => { try { stmtInsNota.run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), aid, a.id, 'Pendiente'); } catch {} });
            al = { id: aid };
            results.alumnos_creados++;
          } else if (al && carrera_id) {
            // Respetar la elección del admin: reasignar=true → mover, reasignar=false → mantener
            if (reasignar !== false) {
              const cN = curso_id || al.curso_id;
              if (al.carrera_id !== carrera_id || al.curso_id !== cN) {
                stmtUpdAl.run(carrera_id, cN, al.id);
                if (cN && cN !== al.curso_id) stmtAsigs.all(cN, periodo?.id||null).forEach(a => { try { stmtInsNota.run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, a.id, 'Pendiente'); } catch {} });
                results.alumnos_actualizados++;
              }
            }
            // reasignar=false → solo importar pagos, sin cambiar carrera
          }

          if (!al) return;
          (montos||[]).forEach((monto, j) => {
            const m = parseFloat(monto)||0;
            if (m <= 0) return;
            const concepto = conceptos[j];
            if (!concepto) return;
            if (stmtChkPago.get(al.id, concepto, periodo?.id||null)) return;
            stmtInsPago.run('pg_'+Date.now()+'_'+Math.random().toString(36).slice(2,4), al.id, periodo?.id||null, concepto, m, nowDate(), 'Pagado', 'Transferencia');
            results.ok++;
          });
        } catch(e) { results.errores.push(`CI ${ci}: ${e.message}`); }
      });
    })();

    audit(req.user.id,'CREATE','pagos_importacion',carrera_id||'?',{ ok: results.ok, creados: results.alumnos_creados });
    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error al importar: '+e.message }); }
});

// ── IMPORTACIÓN PLANILLA DE PAGOS (formato: Nombre | CI | Matrícula | mes1 | mes2...) ─
app.post('/api/pagos/importar-planilla', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const { carrera_id, curso_id } = req.body;

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:true → celdas numéricas devuelven números reales (no strings formateados)
    // Esto garantiza mapeo estricto: la posición de la columna define el mes, nunca el valor
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true, header: 1 });
    if (!rawRows.length) return res.status(400).json({ error: 'Sin datos en el archivo' });

    const norm = h => String(h).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/^["']|["']$/g,'').trim();
    const normId = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');

    // Encontrar fila de cabeceras buscando "cedula"/"ci" en las primeras 10 filas
    // Con raw:true, las celdas de texto siguen siendo strings; convertir todo a string para búsqueda
    let headerRowIdx = -1, headers = [];
    for (let i = 0; i < Math.min(10, rawRows.length); i++) {
      const row = rawRows[i];
      if (row.some(cell => /cedula|c\.i\.|^ci$/.test(norm(String(cell))))) {
        headerRowIdx = i;
        // Convertir a string preservando texto (números en cabecera → string)
        headers = row.map(c => (c === '' || c === null || c === undefined) ? '' : String(c));
        break;
      }
    }
    if (headerRowIdx < 0) return res.status(400).json({ error: 'No se encontró fila de encabezados (debe tener columna "Cédula" o "CI")' });

    const dataRows = rawRows.slice(headerRowIdx + 1);
    const ciIdx        = headers.findIndex(h => /cedula|c\.i\.|^ci$/.test(norm(h)));
    const nombreIdx    = headers.findIndex(h => /nombre|alumno/i.test(norm(h)));
    const matriculaIdx = headers.findIndex(h => /matricula/i.test(norm(h)));

    // Columnas de pago: desde Matrícula en adelante (o desde CI+1 si no hay Matrícula)
    const pagoStart = matriculaIdx >= 0 ? matriculaIdx : (ciIdx >= 0 ? ciIdx + 1 : 2);
    const pagoIdxs = headers.reduce((acc, h, idx) => { if (idx >= pagoStart) acc.push({ idx, h }); return acc; }, []);

    const mesMap = {
      marzo:'Cuota 1',  abril:'Cuota 2',      mayo:'Cuota 3',      junio:'Cuota 4',
      julio:'Cuota 5',  agosto:'Cuota 6',      septiembre:'Cuota 7',setiembre:'Cuota 7',
      octubre:'Cuota 8',noviembre:'Cuota 9',   diciembre:'Cuota 10',
      enero:'Cuota 11', febrero:'Cuota 12',
      'cuota 1':'Cuota 1','cuota 2':'Cuota 2','cuota 3':'Cuota 3','cuota 4':'Cuota 4',
      'cuota 5':'Cuota 5','cuota 6':'Cuota 6','cuota 7':'Cuota 7','cuota 8':'Cuota 8',
      'cuota 9':'Cuota 9','cuota 10':'Cuota 10','cuota 11':'Cuota 11','cuota 12':'Cuota 12',
    };

    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const carr = carrera_id ? db.prepare('SELECT id,codigo,nombre FROM carreras WHERE id=?').get(carrera_id) : null;

    // Pre-compilar statements (error rápido si falta alguna columna)
    const stmtBuscarCI   = db.prepare('SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE ci=?');
    const stmtBuscarNom  = db.prepare("SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE LOWER(COALESCE(nombre,'')||' '||COALESCE(apellido,'')) LIKE ? OR LOWER(COALESCE(apellido,'')||' '||COALESCE(nombre,'')) LIKE ?");
    const stmtCheckEmail = db.prepare('SELECT id FROM usuarios WHERE email=? AND COALESCE(ci,\'\')!=?');
    const stmtUsuExiste  = db.prepare('SELECT id FROM usuarios WHERE ci=?');
    const stmtInsertUsu  = db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)');
    const stmtCntAlumnos = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?');
    const stmtInsertAl   = db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const stmtUpdateAl   = db.prepare('UPDATE alumnos SET carrera_id=?,curso_id=? WHERE id=?');
    const stmtAsigs      = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?');
    const stmtInsertNota = db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)');
    const stmtCheckPago  = db.prepare('SELECT id FROM pagos WHERE alumno_id=? AND concepto=? AND periodo_id=?');
    const stmtInsertPago = db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,medio_pago) VALUES (?,?,?,?,?,?,?,?)');

    const results = { ok: 0, conflictos: [], errores: [], sin_alumno: [], alumnos_creados: 0, alumnos_actualizados: 0, credenciales: [], columnas: pagoIdxs.map(p => p.h) };

    db.transaction(() => {
      dataRows.forEach((row, i) => {
        // raw:true → CI puede ser número o string; normalizar a string limpio
        const ciRaw = ciIdx >= 0 ? row[ciIdx] : '';
        const ci = typeof ciRaw === 'number' ? String(Math.round(ciRaw)) : String(ciRaw||'').replace(/[^0-9]/g,'');
        if (!ci || ci.length < 5) return;

        // Parsear nombre completo → nombre + apellido
        const nombreCompleto = nombreIdx >= 0 ? String(row[nombreIdx]||'').trim() : '';
        const partes = nombreCompleto.split(/\s+/).filter(Boolean);
        let nombre = nombreCompleto, apellido = '';
        if (partes.length >= 3) {
          nombre = partes.slice(0, Math.ceil(partes.length / 2)).join(' ');
          apellido = partes.slice(Math.ceil(partes.length / 2)).join(' ');
        } else if (partes.length === 2) { nombre = partes[0]; apellido = partes[1]; }

        try {
          let al = stmtBuscarCI.get(ci);

          if (!al && carrera_id) {
            // ── CREAR alumno nuevo ──
            // Usuario: nombre + primeras 3 letras del apellido (ej: alexandro.fig)
            const nPart = normId(nombre.split(' ')[0]);  // solo primer nombre
            const aPart = normId(apellido.split(' ').pop()).slice(0,4); // primeras 4 del último apellido
            let emailBase = nPart && aPart ? `${nPart}.${aPart}` : (nPart || `alumno.${ci}`);
            let emailAuto = `${emailBase}@its.edu.py`;
            if (stmtCheckEmail.get(emailAuto, ci)) emailAuto = `${emailBase}.${ci.slice(-3)}@its.edu.py`;

            const _yrI2 = nowSys().getFullYear(); const _pfxI2 = carr ? `${carr.codigo}-${_yrI2}-` : null;
            const _matsI2 = _pfxI2 ? db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carrera_id, _pfxI2+'%') : [];
            const _maxI2 = _matsI2.reduce((mx,r)=>{const n=parseInt((r.matricula||'').slice((_pfxI2||'').length))||0;return Math.max(mx,n);},0);
            const matricula = carr ? `${_pfxI2}${String(_maxI2+1).padStart(3,'0')}` : null;
            const aid = 'a_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);

            let uid = null;
            const usuExiste = stmtUsuExiste.get(ci);
            if (!usuExiste) {
              uid = 'u_e_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
              try { stmtInsertUsu.run(uid, nombre, apellido, ci, emailAuto, bcrypt.hashSync(ci,10), 'alumno'); }
              catch { uid = null; }
            } else { uid = usuExiste.id; }

            stmtInsertAl.run(aid, uid, matricula, carrera_id, curso_id||null, nowDate(), 'Activo', ci, nombre, apellido);

            if (curso_id) {
              stmtAsigs.all(curso_id, periodo?.id||null).forEach(asig => {
                try { stmtInsertNota.run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), aid, asig.id, 'Pendiente'); } catch {}
              });
            }
            // Guardar credenciales para mostrar al director
            results.credenciales.push({ nombre: nombreCompleto, usuario: emailAuto, password: ci });
            al = { id: aid };
            results.alumnos_creados++;

          } else if (al && carrera_id) {
            // ── ACTUALIZAR curso si cambió ──
            const cursoNuevo = curso_id || al.curso_id;
            if (al.carrera_id !== carrera_id || al.curso_id !== cursoNuevo) {
              stmtUpdateAl.run(carrera_id, cursoNuevo, al.id);
              if (cursoNuevo && cursoNuevo !== al.curso_id) {
                stmtAsigs.all(cursoNuevo, periodo?.id||null).forEach(asig => {
                  try { stmtInsertNota.run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, asig.id, 'Pendiente'); } catch {}
                });
              }
              results.alumnos_actualizados++;
            }
          }

          // Si no existe y no hay carrera, buscar por nombre
          if (!al && nombreCompleto.length > 3) {
            al = stmtBuscarNom.get('%'+nombreCompleto.toLowerCase()+'%','%'+nombreCompleto.toLowerCase()+'%');
          }

          if (!al) { results.sin_alumno.push(`CI ${ci} — ${nombreCompleto||'sin nombre'}`); return; }

          // ── REGISTRAR PAGOS ──
          // Mapeo ESTRICTO por posición de columna (idx), nunca por valor ni fila
          pagoIdxs.forEach(({ idx, h }) => {
            const cellVal = row[idx];
            let monto;
            if (typeof cellVal === 'number') {
              // Celda numérica real (raw:true) → usar directamente
              monto = cellVal;
            } else {
              // Celda texto: "225.000Gs.", "350,000", etc. → limpiar separadores
              const s = String(cellVal||'').trim();
              if (!s) return;
              // Remover todo excepto dígitos y puntos, luego remover puntos (sep. de miles en Guaraní)
              const cleaned = s.replace(/[^0-9.]/g,'').replace(/\./g,'');
              monto = parseFloat(cleaned);
            }
            if (!monto || isNaN(monto) || monto <= 0) return;

            const hN = norm(h);
            let concepto;
            if (/matricula/.test(hN)) concepto = 'Matrícula';
            else concepto = mesMap[hN] || h.replace(/^["']|["']$/g,'').trim();

            const existing = stmtCheckPago.get(al.id, concepto, periodo?.id||null);
            if (existing) { results.conflictos.push({ ci, concepto, monto, pago_id: existing.id }); return; }

            stmtInsertPago.run('pg_'+Date.now()+'_'+Math.random().toString(36).slice(2,4), al.id, periodo?.id||null, concepto, monto, nowDate(), 'Pagado', 'Transferencia');
            results.ok++;
          });
        } catch(e) { results.errores.push(`CI ${ci}: ${e.message}`); }
      });
    })();

    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando planilla: '+e.message }); }
});

// Confirmar reemplazo de pago en conflicto
app.put('/api/pagos/:id/reemplazar', auth(ADM), (req, res) => {
  const { concepto, monto, fecha_pago, medio_pago } = req.body;
  db.prepare('UPDATE pagos SET concepto=?,monto=?,fecha_pago=?,medio_pago=?,estado=? WHERE id=?').run(concepto,monto,fecha_pago,medio_pago||'Transferencia','Pagado',req.params.id);
  res.json({ ok: true });
});

// ── PROPAGACIÓN AUTOMÁTICA: nuevo alumno al curso → registrar en notas/asistencia
app.post('/api/alumnos/:id/sincronizar', auth(ADM), (req, res) => {
  const al = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
  if (!al || !al.curso_id) return res.json({ ok: true, notas: 0 });
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.json({ ok: true, notas: 0 });
  const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(al.curso_id, periodo.id);
  let cnt = 0;
  db.transaction(() => {
    asigs.forEach(a => {
      try {
        db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, a.id, 'Pendiente');
        cnt++;
      } catch {}
    });
  })();
  res.json({ ok: true, notas_creadas: cnt });
});

// ── SINCRONIZACIÓN MASIVA: crear registros de notas faltantes para todos los alumnos activos
app.post('/api/alumnos/sincronizar-todos', auth(ADM), (req, res) => {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.json({ ok: true, sincronizados: 0, mensaje: 'Sin período activo' });
  
  const alumnos = db.prepare("SELECT id, curso_id FROM alumnos WHERE estado='Activo' AND curso_id IS NOT NULL").all();
  let totalCreados = 0;
  
  db.transaction(() => {
    alumnos.forEach(al => {
      const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(al.curso_id, periodo.id);
      asigs.forEach(asig => {
        const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(al.id, asig.id);
        if (!existe) {
          try {
            db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), al.id, asig.id, 'Pendiente');
            totalCreados++;
          } catch {}
        }
      });
    });
  })();
  
  audit(req.user.id, 'SINCRONIZAR_TODOS', 'alumnos', 'bulk', { registros_creados: totalCreados });
  res.json({ ok: true, sincronizados: totalCreados, alumnos_procesados: alumnos.length });
});

// ── CALENDARIO 2026: generar desde 01-mayo hasta 31-julio ─────────────────────
app.post('/api/asistencia/generar-2026', auth(ADM), (req, res) => {
  req.body = { ...req.body, fecha_inicio: '2026-05-01', fecha_fin: '2026-07-31' };
  // Reutilizar la lógica del endpoint generar
  const horarios = db.prepare('SELECT * FROM horarios WHERE asignacion_id IS NOT NULL').all();
  if (!horarios.length) return res.status(400).json({ error: 'No hay horarios configurados' });
  const asigCursoMap = {};
  const alumnosPorCurso = {};
  horarios.forEach(h => {
    const asig = db.prepare('SELECT curso_id FROM asignaciones WHERE id=?').get(h.asignacion_id);
    if (asig) asigCursoMap[h.asignacion_id] = asig.curso_id;
  });
  [...new Set(Object.values(asigCursoMap))].forEach(cid => {
    alumnosPorCurso[cid] = db.prepare("SELECT id FROM alumnos WHERE curso_id=? AND estado='Activo'").all(cid).map(a=>a.id);
  });
  const inicio = new Date('2026-05-01T12:00:00');
  const fin = new Date('2026-07-31T12:00:00');
  const diaNames = ['','Lunes','Martes','Miércoles','Jueves','Viernes'];
  let totalGeneradas = 0;
  const insAs = db.prepare('INSERT OR IGNORE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    const cur = new Date(inicio);
    while (cur <= fin) {
      const diaN = cur.getDay();
      if (diaN >= 1 && diaN <= 5) {
        const diaName = diaNames[diaN];
        const fechaStr = cur.toISOString().split('T')[0];
        horarios.filter(h=>h.dia===diaName).forEach(h=>{
          const cursoId = asigCursoMap[h.asignacion_id];
          const alumnos = cursoId ? (alumnosPorCurso[cursoId]||[]) : [];
          alumnos.forEach(alId=>{
            insAs.run('as_'+fechaStr+'_'+h.asignacion_id+'_'+alId, alId, h.asignacion_id, fechaStr, 'P');
            totalGeneradas++;
          });
        });
      }
      cur.setDate(cur.getDate()+1);
    }
  })();
  res.json({ ok: true, generadas: totalGeneradas, desde: '2026-05-01', hasta: '2026-07-31' });
});

// ── ASISTENCIA POR ALUMNO (para vista personal del alumno) ─────────────────────
app.get('/api/asistencia/alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT id,usuario_id FROM alumnos WHERE id=?').get(req.params.alumno_id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  if (req.user.rol === 'alumno' && al.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
  res.json(db.prepare(`
    SELECT a.*, m.nombre as materia_nombre
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN materias m ON asig.materia_id=m.id
    WHERE a.alumno_id=?
    ORDER BY a.fecha DESC LIMIT 500`).all(req.params.alumno_id));
});
// ── RESUMEN MENSUAL DE ASISTENCIA ─────────────────────────────────────────────
app.get('/api/asistencia/resumen', auth(['director','docente']), (req, res) => {
  const { asignacion_id, anio, mes } = req.query;
  if (!asignacion_id || !anio || !mes) return res.status(400).json({ error: 'asignacion_id, anio y mes son requeridos' });
  const desde = `${anio}-${String(mes).padStart(2,'0')}-01`;
  const hasta = `${anio}-${String(mes).padStart(2,'0')}-${new Date(parseInt(anio), parseInt(mes), 0).getDate()}`;
  const registros = db.prepare(`
    SELECT a.fecha, a.estado, a.alumno_id,
      COALESCE(al.nombre, u.nombre) as nombre,
      COALESCE(al.apellido, u.apellido) as apellido
    FROM asistencia a
    JOIN alumnos al ON a.alumno_id=al.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE a.asignacion_id=? AND a.fecha>=? AND a.fecha<=?
    ORDER BY COALESCE(al.apellido,u.apellido), a.fecha`).all(asignacion_id, desde, hasta);
  // Construir estructura: alumno → fecha → estado
  const alumnos = {};
  const fechas = new Set();
  registros.forEach(r => {
    fechas.add(r.fecha);
    if (!alumnos[r.alumno_id]) alumnos[r.alumno_id] = { nombre: r.nombre, apellido: r.apellido, dias: {} };
    alumnos[r.alumno_id].dias[r.fecha] = r.estado;
  });
  const fechasArr = [...fechas].sort();
  res.json({ alumnos: Object.entries(alumnos).map(([id,a])=>({id,...a})), fechas: fechasArr, desde, hasta });
});

// ── ELIMINAR REGISTROS DE ASISTENCIA POR RANGO ────────────────────────────────
app.delete('/api/asistencia/rango', auth(ADM), (req, res) => {
  const { desde, hasta } = req.body;
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos' });
  const result = db.prepare('DELETE FROM asistencia WHERE fecha>=? AND fecha<=?').run(desde, hasta);
  res.json({ ok: true, eliminados: result.changes });
});

// ── ARANCELES (costos) ────────────────────────────────────────────────────────
app.get('/api/aranceles', auth(), (req, res) => {
  const { tipo, carrera_id } = req.query;
  let where = 'WHERE a.activo=1'; const params = [];
  if (tipo) { where += ' AND a.tipo=?'; params.push(tipo); }
  if (carrera_id) { where += ' AND (a.carrera_id=? OR a.carrera_id IS NULL)'; params.push(carrera_id); }
  res.json(db.prepare(`SELECT a.*,c.nombre as carrera_nombre FROM aranceles a
    LEFT JOIN carreras c ON a.carrera_id=c.id ${where} ORDER BY a.tipo,a.concepto`).all(...params));
});
app.post('/api/aranceles', auth(ADM), (req, res) => {
  const { concepto, monto, tipo, carrera_id, descripcion, anio } = req.body;
  const id = 'ar_'+Date.now();
  db.prepare('INSERT INTO aranceles (id,concepto,monto,tipo,carrera_id,descripcion,anio) VALUES (?,?,?,?,?,?,?)').run(id,concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null,anio||null);
  res.json({ id });
});
app.put('/api/aranceles/:id', auth(ADM), (req, res) => {
  const { concepto, monto, tipo, carrera_id, descripcion, activo, anio } = req.body;
  db.prepare("UPDATE aranceles SET concepto=?,monto=?,tipo=?,carrera_id=?,descripcion=?,activo=?,anio=?,fecha_actualizacion=date('now') WHERE id=?").run(concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null,activo?1:0,anio||null,req.params.id);
  res.json({ ok: true });
});
app.delete('/api/aranceles/:id', auth(ADM), (req, res) => {
  db.prepare('UPDATE aranceles SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── HABILITACIÓN DE EXAMEN (por alumno/tipo) ──────────────────────────────────
app.post('/api/habilitaciones', auth(ADM), (req, res) => {
  const { alumno_id, tipo_examen, asignacion_id, habilitado, motivo } = req.body;
  const id = 'hab_'+Date.now();
  // Upsert: si ya existe, actualizar
  const existente = db.prepare('SELECT id FROM habilitaciones_examen WHERE alumno_id=? AND tipo_examen=? AND (asignacion_id=? OR asignacion_id IS NULL)').get(alumno_id, tipo_examen, asignacion_id||null);
  if (existente) {
    db.prepare("UPDATE habilitaciones_examen SET habilitado=?,habilitado_por=?,motivo=?,fecha=date('now') WHERE id=?").run(habilitado?1:0, req.user.id, motivo||null, existente.id);
    return res.json({ id: existente.id, updated: true });
  }
  db.prepare('INSERT INTO habilitaciones_examen (id,alumno_id,tipo_examen,asignacion_id,habilitado,habilitado_por,motivo) VALUES (?,?,?,?,?,?,?)').run(id,alumno_id,tipo_examen,asignacion_id||null,habilitado?1:0,req.user.id,motivo||null);
  res.json({ id });
});
app.get('/api/habilitaciones/:alumno_id', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT h.*, m.nombre as materia_nombre
    FROM habilitaciones_examen h
    LEFT JOIN asignaciones a ON h.asignacion_id = a.id
    LEFT JOIN materias m ON a.materia_id = m.id
    WHERE h.alumno_id=?`).all(req.params.alumno_id));
});
app.delete('/api/habilitaciones/:id', auth(['director']), (req, res) => {
  try {
    const h = db.prepare('SELECT * FROM habilitaciones_examen WHERE id=?').get(req.params.id);
    if (!h) return res.status(404).json({ error: 'Habilitación no encontrada' });
    db.prepare('DELETE FROM habilitaciones_examen WHERE id=?').run(req.params.id);
    audit(req.user.id, 'DELETE_HABILITACION', 'habilitaciones_examen', req.params.id, { alumno_id: h.alumno_id, tipo_examen: h.tipo_examen, asignacion_id: h.asignacion_id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RE-SEED DOCENTES (para Railway donde la BD ya existía) ────────────────────
app.post('/api/admin/reseed-docentes', auth(ADM), (req, res) => {
  try {
    const { seedDatos } = require('./db');
    // Crear usuarios para docentes que no tienen usuario vinculado
    const docsSinUser = db.prepare("SELECT d.id,d.especialidad,d.titulo,u2.nombre,u2.apellido,u2.email FROM docentes d JOIN usuarios u2 ON d.usuario_id=u2.id WHERE d.usuario_id IS NULL OR d.usuario_id=''").all();
    // Alternativa: buscar docentes cuyo usuario no existe
    const allDocs = db.prepare('SELECT * FROM docentes').all();
    const insU = db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,email,password_hash,rol) VALUES (?,?,?,?,?,?)');
    const passDoc = bcrypt.hashSync('docente123', 10);
    let created = 0;
    allDocs.forEach(d => {
      const uid = 'u_' + d.id;
      const userExists = db.prepare('SELECT id FROM usuarios WHERE id=?').get(uid);
      if (!userExists) {
        // Nombre legible para el docente: nombre.apellido@its.edu.py
        const nombre = (d.nombre||d.especialidad||'Docente').toLowerCase().replace(/\s+/g,'').slice(0,15);
        const emailDoc = `${d.id}@its.edu.py`;
        insU.run(uid, d.especialidad||'Docente', '', emailDoc, passDoc, 'docente');
        db.prepare('UPDATE docentes SET usuario_id=? WHERE id=?').run(uid, d.id);
        created++;
      }
    });
    res.json({ ok: true, created, total: allDocs.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ACTIVIDADES DEL CALENDARIO ACADÉMICO ─────────────────────────────────────
app.get('/api/actividades', auth(), (req, res) => {
  const { desde, hasta, carrera_id } = req.query;
  let where = 'WHERE a.activo=1'; const params = [];
  if (desde) { where += ' AND a.fecha>=?'; params.push(desde); }
  if (hasta) { where += ' AND a.fecha<=?'; params.push(hasta); }
  if (carrera_id) { where += ' AND (a.carrera_id=? OR a.carrera_id IS NULL)'; params.push(carrera_id); }
  res.json(db.prepare(`
    SELECT a.*,
      c.nombre as carrera_nombre,
      m.nombre as materia_nombre,
      u.nombre as autor_nombre, u.apellido as autor_apellido
    FROM actividades a
    LEFT JOIN carreras c ON a.carrera_id=c.id
    LEFT JOIN materias m ON a.materia_id=m.id
    JOIN usuarios u ON a.usuario_id=u.id
    ${where} ORDER BY a.fecha DESC`).all(...params));
});
app.post('/api/actividades', auth(ADM), (req, res) => {
  const { titulo, descripcion, fecha, tipo, carrera_id, materia_id } = req.body;
  if (!titulo || !fecha) return res.status(400).json({ error: 'Título y fecha son obligatorios' });
  const id = 'act_' + Date.now();
  db.prepare('INSERT INTO actividades (id,titulo,descripcion,fecha,tipo,carrera_id,materia_id,usuario_id) VALUES (?,?,?,?,?,?,?,?)').run(id, titulo, descripcion||null, fecha, tipo||'otros', carrera_id||null, materia_id||null, req.user.id);
  res.json({ id });
});
app.put('/api/actividades/:id', auth(ADM), (req, res) => {
  const { titulo, descripcion, fecha, tipo, carrera_id, materia_id } = req.body;
  db.prepare('UPDATE actividades SET titulo=?,descripcion=?,fecha=?,tipo=?,carrera_id=?,materia_id=? WHERE id=?').run(titulo,descripcion||null,fecha,tipo||'otros',carrera_id||null,materia_id||null,req.params.id);
  res.json({ ok: true });
});
app.delete('/api/actividades/:id', auth(ADM), (req, res) => {
  db.prepare('UPDATE actividades SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── HABILITACIONES EN BULK (evita N+1 en loadNotas) ──────────────────────────
app.post('/api/alumnos/habilitaciones-bulk', auth(['director','docente']), (req, res) => {
  const { alumno_ids, asignacion_id } = req.body;
  if (!Array.isArray(alumno_ids) || !alumno_ids.length) return res.json({});
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) {
    const result = {};
    alumno_ids.forEach(id => { result[id] = { habilitado: true, razon: 'sin_periodo_activo', tipos_habilitados: [], cuotas_faltantes: [] }; });
    return res.json(result);
  }
  const cuotasRequeridas = ['Cuota 1', 'Cuota 2', 'Cuota 3', 'Cuota 4', 'Cuota 5'];
  const placeholders = alumno_ids.map(() => '?').join(',');
  const pagos = db.prepare(`SELECT alumno_id, concepto FROM pagos WHERE alumno_id IN (${placeholders}) AND periodo_id=? AND estado='Pagado'`).all(...alumno_ids, periodo.id);
  const alumnos = db.prepare(`SELECT id,nombre,apellido,habilitado_pago_pendiente FROM alumnos WHERE id IN (${placeholders})`).all(...alumno_ids);
  // Recopilar tipos habilitados por alumno
  const habEspeciales = {};
  if (asignacion_id) {
    // Modo por-asignación: verificar habilitaciones específicas para esta materia (todos los alumnos)
    db.prepare(`SELECT alumno_id, tipo_examen FROM habilitaciones_examen WHERE alumno_id IN (${placeholders}) AND asignacion_id=? AND habilitado=1`)
      .all(...alumno_ids, asignacion_id)
      .forEach(h => {
        if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
        if (h.tipo_examen && !habEspeciales[h.alumno_id].includes(h.tipo_examen)) habEspeciales[h.alumno_id].push(h.tipo_examen);
      });
    // Incluir habilitado_recuperatorio de esta asignación
    db.prepare(`SELECT alumno_id FROM habilitaciones_examen WHERE alumno_id IN (${placeholders}) AND asignacion_id=? AND habilitado_recuperatorio=1`)
      .all(...alumno_ids, asignacion_id)
      .forEach(h => {
        if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
        if (!habEspeciales[h.alumno_id].includes('parcial_recuperatorio')) habEspeciales[h.alumno_id].push('parcial_recuperatorio');
      });
    // FIX: la habilitación especial global del director (habilitado_pago_pendiente) también
    // debe desbloquear en modo por-asignación — antes solo se aplicaba en modo global, así que
    // un alumno habilitado por esta vía quedaba con la casilla bloqueada en la grilla de notas.
    const TIPOS_TODOS_EX = ['parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario'];
    alumnos.filter(al => al.habilitado_pago_pendiente).forEach(al => {
      if (!habEspeciales[al.id]) habEspeciales[al.id] = [];
      TIPOS_TODOS_EX.forEach(t => { if (!habEspeciales[al.id].includes(t)) habEspeciales[al.id].push(t); });
    });
  } else {
    // Modo global: habilitaciones especiales solo para alumnos con flag de mora
    const habWithFlag = alumnos.filter(al => al.habilitado_pago_pendiente).map(al => al.id);
    if (habWithFlag.length) {
      const habPh = habWithFlag.map(() => '?').join(',');
      db.prepare(`SELECT alumno_id, tipo_examen FROM habilitaciones_examen WHERE alumno_id IN (${habPh}) AND habilitado=1 ORDER BY fecha DESC`).all(...habWithFlag)
        .forEach(h => {
          if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
          if (!habEspeciales[h.alumno_id].includes(h.tipo_examen)) habEspeciales[h.alumno_id].push(h.tipo_examen);
        });
      db.prepare(`SELECT alumno_id FROM habilitaciones_examen WHERE alumno_id IN (${habPh}) AND habilitado_recuperatorio=1`).all(...habWithFlag)
        .forEach(h => {
          if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
          if (!habEspeciales[h.alumno_id].includes('parcial_recuperatorio')) habEspeciales[h.alumno_id].push('parcial_recuperatorio');
        });
    }
  }
  const pagosPorAlumno = {};
  pagos.forEach(p => {
    if (!pagosPorAlumno[p.alumno_id]) pagosPorAlumno[p.alumno_id] = [];
    pagosPorAlumno[p.alumno_id].push(p.concepto);
  });
  const recuperatorioMap = {};
  db.prepare(`SELECT DISTINCT alumno_id FROM habilitaciones_examen WHERE alumno_id IN (${placeholders}) AND habilitado_recuperatorio=1`).all(...alumno_ids)
    .forEach(h => { recuperatorioMap[h.alumno_id] = true; });
  const result = {};
  alumnos.forEach(al => {
    const conceptos = pagosPorAlumno[al.id] || [];
    const faltantes = cuotasRequeridas.filter(c => !conceptos.some(p => p === c));
    const tiposHab = habEspeciales[al.id] || [];
    if (faltantes.length === 0) {
      // Cuotas al día: no bloqueado, pero tipos_habilitados refleja lo pagado por esta asignacion
      result[al.id] = { habilitado: true, razon: 'pago_al_dia', tipos_habilitados: asignacion_id ? tiposHab : [], cuotas_faltantes: [], habilitado_recuperatorio: !!recuperatorioMap[al.id] };
      return;
    }
    result[al.id] = {
      habilitado: asignacion_id ? tiposHab.length > 0 : false,
      razon: tiposHab.length ? 'habilitacion_especial' : 'mora_de_pago',
      tipos_habilitados: tiposHab,
      cuotas_faltantes: faltantes,
      habilitado_recuperatorio: !!recuperatorioMap[al.id],
      alumno: `${al.apellido}, ${al.nombre}`
    };
  });
  res.json(result);
});

// ── BACKUP DE BASE DE DATOS ───────────────────────────────────────────────────
// ── BACKUP AUTOMÁTICO CADA 48 HORAS ──────────────────────────────────────────
// Guardar backups DENTRO del volumen Railway para que persistan entre deploys
const BACKUP_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'backups')
  : path.join(__dirname, '../backups');
if (!fs.existsSync(BACKUP_DIR)) { try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {} }

// Backup cada 48hs (no diario): se guarda la fecha del último backup exitoso en
// `configuracion` y el cron (que sigue corriendo todos los días a las 23:00) se
// fija con eso si ya pasaron 48hs o no, en vez de depender de que el cron mismo
// corra cada dos días — más robusto ante reinicios del servidor.
function yaPasaron48hsDesdeUltimoBackup() {
  const row = db.prepare("SELECT valor FROM configuracion WHERE clave='ultimo_backup_automatico'").get();
  if (!row?.valor) return true;
  const ultimo = new Date(row.valor).getTime();
  return (Date.now() - ultimo) >= 48 * 60 * 60 * 1000;
}
async function hacerBackupAutomatico() {
  try {
    const fecha = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destino = path.join(BACKUP_DIR, `ITS_auto_${fecha}.db`);
    // VACUUM antes de copiar: compacta la BD y recupera espacio de BLOBs borrados
    try { db.prepare('VACUUM').run(); } catch {}
    fs.copyFileSync(DB_PATH, destino);
    // Mantener solo los últimos 3 backups en el Volume (ahorra espacio en Railway)
    const archivos = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('ITS_auto_'))
      .sort().reverse();
    archivos.slice(3).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    });
    console.log(`✅ Backup local: ${destino}`);
    // Subir también a GitHub (capa externa de seguridad)
    await cloudBackupDrive(DB_PATH);
    db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES ('ultimo_backup_automatico',?,'Fecha del último backup automático (cada 48hs)')").run(new Date().toISOString());
    return destino;
  } catch(e) {
    console.error('Error en backup automático:', e.message);
    return null;
  }
}

// El cron corre todos los días a las 23:00, pero el backup real (con la subida a
// GitHub) solo se ejecuta si ya pasaron 48hs desde el último — reduce a la mitad
// el tráfico de red que generaba el backup diario.
cron.schedule('0 23 * * *', () => {
  if (!yaPasaron48hsDesdeUltimoBackup()) {
    console.log('[BACKUP] Todavía no pasaron 48hs desde el último — se salta hoy.');
    return;
  }
  console.log('[BACKUP] Ejecutando backup (cada 48hs) 23:00 PY...');
  hacerBackupAutomatico();
}, { timezone: 'America/Asuncion' });

// ── CRON: Purga papelera expirada (diario 03:00) ─────────────────────────────
cron.schedule('0 3 * * *', () => {
  try {
    const r = db.prepare("DELETE FROM papelera WHERE expira_en <= datetime('now','localtime')").run();
    if (r.changes > 0) console.log(`[PAPELERA] Purgados ${r.changes} registros expirados`);
  } catch(e) { console.error('[PAPELERA PURGE]', e.message); }
}, { timezone: 'America/Asuncion' });

// ── CRON: Chequeo nocturno de integridad de datos (diario 02:30, antes de la purga) ──
// Detecta anomalías que en el pasado causaron reportes de "el alumno desapareció con
// sus notas y pagos" sin que nadie se enterara hasta semanas después: registros
// huérfanos (apuntan a un alumno/asignación que ya no existe), alumnos activos que no
// pueden iniciar sesión, y alumnos en Papelera a punto de purgarse para siempre.
// Avisa al director en el sistema, igual que el watchdog de WhatsApp.
cron.schedule('30 2 * * *', () => {
  try {
    const problemas = [];

    const sinUsuario = db.prepare(`
      SELECT nombre, apellido FROM alumnos
      WHERE estado='Activo' AND (usuario_id IS NULL OR NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id=alumnos.usuario_id))
    `).all();
    if (sinUsuario.length) problemas.push(`👤 <strong>${sinUsuario.length} alumno(s) activo(s) sin usuario vinculado</strong> (no pueden iniciar sesión): ${sinUsuario.slice(0,5).map(a=>a.apellido+', '+a.nombre).join('; ')}${sinUsuario.length>5?'…':''}`);

    const pagosHuerfanos = db.prepare(`SELECT COUNT(*) n FROM pagos p WHERE NOT EXISTS (SELECT 1 FROM alumnos a WHERE a.id=p.alumno_id)`).get().n;
    if (pagosHuerfanos) problemas.push(`💳 <strong>${pagosHuerfanos} pago(s) huérfano(s)</strong> (apuntan a un alumno que ya no existe en el sistema)`);

    const notasHuerfanas = db.prepare(`SELECT COUNT(*) n FROM notas nt WHERE NOT EXISTS (SELECT 1 FROM alumnos a WHERE a.id=nt.alumno_id)`).get().n;
    if (notasHuerfanas) problemas.push(`✏️ <strong>${notasHuerfanas} nota(s) huérfana(s)</strong> (alumno inexistente)`);

    const habsHuerfanasAlumno = db.prepare(`SELECT COUNT(*) n FROM habilitaciones_examen h WHERE NOT EXISTS (SELECT 1 FROM alumnos a WHERE a.id=h.alumno_id)`).get().n;
    if (habsHuerfanasAlumno) problemas.push(`🔓 <strong>${habsHuerfanasAlumno} habilitación(es) huérfana(s)</strong> (alumno inexistente)`);

    const habsAsigHuerfana = db.prepare(`SELECT COUNT(*) n FROM habilitaciones_examen h WHERE h.asignacion_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM asignaciones a WHERE a.id=h.asignacion_id)`).get().n;
    if (habsAsigHuerfana) problemas.push(`🔗 <strong>${habsAsigHuerfana} habilitación(es) con materia eliminada</strong> (la materia/asignación ya no existe)`);

    const porVencer = db.prepare(`SELECT nombre_display FROM papelera WHERE tipo IN ('alumno','alumno_completo') AND expira_en <= datetime('now','+3 days')`).all();
    if (porVencer.length) problemas.push(`🗑️ <strong>${porVencer.length} alumno(s) en Papelera se eliminan definitivamente en menos de 3 días</strong>: ${porVencer.slice(0,5).map(p=>p.nombre_display).join('; ')}${porVencer.length>5?'…':''}. Restaurá desde Limpieza → Papelera si fue un error.`);

    const sinCarreraCurso = db.prepare(`SELECT COUNT(*) n FROM alumnos WHERE estado='Activo' AND (carrera_id IS NULL OR curso_id IS NULL)`).get().n;
    if (sinCarreraCurso) problemas.push(`🎓 <strong>${sinCarreraCurso} alumno(s) activo(s) sin carrera o curso asignado</strong>`);

    if (problemas.length) {
      const director = db.prepare("SELECT id FROM usuarios WHERE rol='director' AND activo=1 LIMIT 1").get();
      const contenido = 'El chequeo nocturno de integridad de datos encontró lo siguiente:<br><ul style="margin:6px 0 0;padding-left:18px">'
        + problemas.map(p => `<li style="margin-bottom:4px">${p}</li>`).join('') + '</ul>';
      // Ya no se crea un aviso visible en la pantalla de inicio (pedido del director,
      // la pantalla estaba muy cargada). Queda registrado en auditoría para consulta.
      audit(director?director.id:null, 'CHEQUEO_INTEGRIDAD', 'sistema', null, { problemas, contenido });
      console.log(`[Integridad] ${problemas.length} problema(s) detectado(s), registrado en auditoría`);
    } else {
      console.log('[Integridad] Sin problemas detectados');
    }
  } catch(e) { console.error('[Integridad] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

console.log('⏰ Backup programado: todos los días a las 23:00 (hora Paraguay) → Volume + GitHub');

// Backup inmediato al iniciar (5s de gracia para que la DB esté lista)
setTimeout(() => hacerBackupAutomatico(), 5000);

// ── DIAGNÓSTICO Y LIMPIEZA DE DISCO ─────────────────────────────────────────
app.get('/api/admin/disco', auth(ADM), (req, res) => {
  try {
    const sizeOf = p => { try { return fs.statSync(p).size; } catch { return 0; } };
    const dbSize = sizeOf(DB_PATH);

    // Backups en el Volume
    let backups = [];
    try {
      backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.db'))
        .map(f => ({ nombre: f, bytes: sizeOf(path.join(BACKUP_DIR, f)) }))
        .sort((a, b) => b.nombre.localeCompare(a.nombre));
    } catch {}
    const backupTotal = backups.reduce((s, b) => s + b.bytes, 0);

    // BLOBs de archivos en la BD (exámenes adjuntos)
    const blobInfo = db.prepare(`
      SELECT COUNT(*) as cantidad,
             COALESCE(SUM(LENGTH(archivo_data)),0) as bytes_total
      FROM examenes WHERE archivo_data IS NOT NULL`).get();

    // Auditoría: registros más viejos
    const audCount = db.prepare('SELECT COUNT(*) as n FROM auditoria').get();
    const audOld   = db.prepare("SELECT MIN(fecha) as mas_vieja FROM auditoria").get();

    // Memoria del proceso Node.js
    const mem = process.memoryUsage();
    const uptimeSeg = Math.floor(process.uptime());
    const horas = Math.floor(uptimeSeg / 3600);
    const minutos = Math.floor((uptimeSeg % 3600) / 60);
    const segundos = uptimeSeg % 60;

    // Conteo de registros principales
    const totalAlumnos = db.prepare('SELECT COUNT(*) as n FROM alumnos').get().n;
    const totalDocentes = db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE rol='docente'").get().n;
    const totalExamenes = db.prepare('SELECT COUNT(*) as n FROM examenes').get().n;

    res.json({
      db_bytes: dbSize,
      db_mb: (dbSize / 1048576).toFixed(2),
      backups_en_volume: backups,
      backups_total_mb: (backupTotal / 1048576).toFixed(2),
      archivos_adjuntos: {
        cantidad: blobInfo.cantidad,
        bytes: blobInfo.bytes_total,
        mb: (blobInfo.bytes_total / 1048576).toFixed(2)
      },
      auditoria: {
        total_registros: audCount.n,
        mas_vieja: audOld.mas_vieja
      },
      total_estimado_mb: ((dbSize + backupTotal) / 1048576).toFixed(2),
      memoria: {
        rss_mb: (mem.rss / 1048576).toFixed(1),
        heap_usado_mb: (mem.heapUsed / 1048576).toFixed(1),
        heap_total_mb: (mem.heapTotal / 1048576).toFixed(1),
        externo_mb: (mem.external / 1048576).toFixed(1)
      },
      uptime: { horas, minutos, segundos, texto: `${horas}h ${minutos}m ${segundos}s` },
      registros: { alumnos: totalAlumnos, docentes: totalDocentes, examenes: totalExamenes }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Limpiar disco: borrar backups viejos PRIMERO (no necesita espacio libre), luego VACUUM
app.post('/api/admin/disco/limpiar', auth(ADM), (req, res) => {
  const log = [];
  try {
    // 1. Borrar backups viejos PRIMERO — libera espacio sin necesitar espacio extra
    let liberadoBytes = 0;
    try {
      const archs = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('ITS_auto_'))
        .sort().reverse();
      const aEliminar = archs.slice(3);
      aEliminar.forEach(f => {
        try {
          const filePath = path.join(BACKUP_DIR, f);
          const size = fs.statSync(filePath).size;
          fs.unlinkSync(filePath);
          liberadoBytes += size;
          log.push(`🗑 Backup eliminado: ${f} (${(size/1048576).toFixed(1)} MB)`);
        } catch {}
      });
      if (!aEliminar.length) log.push('ℹ Solo hay ≤3 backups locales, nada que eliminar');
      else log.push(`✅ Espacio liberado por backups: ${(liberadoBytes/1048576).toFixed(1)} MB`);
    } catch(e) { log.push('⚠ Error limpiando backups: ' + e.message); }

    // 2. VACUUM de SQLite — ahora hay espacio disponible
    try {
      db.prepare('VACUUM').run();
      log.push('✅ VACUUM ejecutado — base de datos compactada');
    } catch(e) {
      log.push(`⚠ VACUUM no pudo ejecutarse: ${e.message} (el espacio liberado ya fue aplicado)`);
    }

    // Nota: archivos adjuntos de exámenes NUNCA se eliminan automáticamente.
    audit(req.user.id, 'LIMPIAR_DISCO', 'sistema', 'disco', { log });
    res.json({ ok: true, log });
  } catch(e) { res.status(500).json({ error: e.message, log }); }
});

app.get('/api/admin/backup', auth(ADM), (req, res) => {
  const fecha = nowDate();
  const dbPath = DB_PATH || path.join(__dirname, '..', 'data', 'its.db');
  res.setHeader('Content-Disposition', `attachment; filename="ITS_backup_${fecha}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  audit(req.user.id, 'BACKUP', 'sistema', 'backup', { fecha });
  res.sendFile(dbPath);
});

// Probar backup a GitHub manualmente desde el panel
app.post('/api/admin/backup/github-test', auth(ADM), async (req, res) => {
  const token  = process.env.GITHUB_BACKUP_TOKEN;
  const repo   = process.env.GITHUB_BACKUP_REPO;
  if (!token || !repo) {
    return res.json({ ok: false, error: 'Variables GITHUB_BACKUP_TOKEN o GITHUB_BACKUP_REPO no configuradas en Railway' });
  }
  try {
    const fecha    = new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
    const nombre   = `its_test_${fecha}.db`;
    const contenido = fs.readFileSync(DB_PATH).toString('base64');
    const url = `https://api.github.com/repos/${repo}/contents/backups/${nombre}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Test backup manual ${fecha}`, content: contenido })
    });
    if (resp.ok) {
      const data = await resp.json();
      audit(req.user.id, 'BACKUP', 'sistema', 'github-test', { repo, archivo: nombre });
      res.json({ ok: true, repo, archivo: nombre, url: data.content?.html_url || `https://github.com/${repo}` });
    } else {
      const err = await resp.json().catch(() => ({}));
      res.json({ ok: false, error: `GitHub respondió ${resp.status}: ${err.message || 'error desconocido'}` });
    }
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── AUDITORÍA ─────────────────────────────────────────────────────────────────
// ── AUDITORÍA COMPLETA ────────────────────────────────────────────────────────
// ── REGISTRO DE HABILITADOS ────────────────────────────────────────────────────
app.get('/api/admin/habilitados', auth(ADM), (req, res) => {
  const { carrera_id, anio, tipo_examen, division, asignacion_id } = req.query;
  let where = "WHERE h.habilitado=1";
  const params = [];
  if (tipo_examen)   { where += ' AND h.tipo_examen=?'; params.push(tipo_examen); }
  if (carrera_id)    { where += ' AND COALESCE(ca.id, al_ca.id, al_carr.id)=?'; params.push(carrera_id); }
  if (anio)          { where += ' AND COALESCE(cu.anio, al_cu.anio)=?'; params.push(parseInt(anio)); }
  if (division)      { where += ' AND COALESCE(cu.division, al_cu.division)=?'; params.push(division); }
  if (asignacion_id) { where += ' AND h.asignacion_id=?'; params.push(asignacion_id); }
  try {
    const rows = db.prepare(`
      SELECT h.id, h.tipo_examen, h.fecha, h.motivo, h.asignacion_id,
        al.nombre as alumno_nombre, al.apellido as alumno_apellido, al.ci as alumno_ci,
        COALESCE(ca.nombre, al_ca.nombre, al_carr.nombre) as carrera_nombre,
        COALESCE(cu.anio, al_cu.anio) as anio,
        COALESCE(cu.division, al_cu.division) as division,
        m.nombre as materia_nombre,
        uh.nombre as habilitado_por_nombre, uh.apellido as habilitado_por_apellido
      FROM habilitaciones_examen h
      LEFT JOIN alumnos al ON h.alumno_id=al.id
      LEFT JOIN asignaciones asig ON h.asignacion_id=asig.id
      LEFT JOIN materias m ON asig.materia_id=m.id
      LEFT JOIN cursos cu ON asig.curso_id=cu.id
      LEFT JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN cursos al_cu ON al.curso_id=al_cu.id
      LEFT JOIN carreras al_ca ON al_cu.carrera_id=al_ca.id
      LEFT JOIN carreras al_carr ON al.carrera_id=al_carr.id
      LEFT JOIN usuarios uh ON h.habilitado_por=uh.id
      ${where}
      ORDER BY h.fecha DESC`).all(...params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HABILITADOS SIN NOTA CARGADA: pagó/se habilitó para rendir, pero el docente ──
// todavía no cargó la nota de ese examen puntual. Pedido del director para la
// sección Gestión de Alumnos → tarjeta "Pagó, falta nota", agrupada por
// carrera → año → materia. h.tipo_examen coincide 1:1 con el nombre de la
// columna en `notas` (final_ord, final_recuperatorio, parcial_recuperatorio,
// complementario, extraordinario), así que se puede leer directo con COALESCE.
app.get('/api/admin/habilitados-sin-nota', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT h.id as hab_id, h.tipo_examen, h.fecha as fecha_habilitacion, h.asignacion_id,
        al.id as alumno_id, al.nombre as alumno_nombre, al.apellido as alumno_apellido, al.ci as alumno_ci,
        ca.id as carrera_id, ca.nombre as carrera_nombre,
        cu.anio as anio, cu.division as division,
        m.nombre as materia_nombre,
        ud.nombre as doc_nombre, ud.apellido as doc_apellido,
        e.fecha as fecha_examen, e.hora as hora_examen,
        n.parcial, n.parcial_recuperatorio, n.final_ord, n.final_recuperatorio, n.complementario, n.extraordinario
      FROM habilitaciones_examen h
      JOIN alumnos al   ON h.alumno_id=al.id
      JOIN asignaciones a ON h.asignacion_id=a.id
      JOIN materias m   ON a.materia_id=m.id
      JOIN cursos cu    ON a.curso_id=cu.id
      JOIN carreras ca  ON cu.carrera_id=ca.id
      LEFT JOIN docentes d ON a.docente_id=d.id
      LEFT JOIN usuarios ud ON d.usuario_id=ud.id
      LEFT JOIN notas n ON n.alumno_id=h.alumno_id AND n.asignacion_id=h.asignacion_id
      LEFT JOIN examenes e ON e.asignacion_id=h.asignacion_id AND e.tipo=h.tipo_examen
      WHERE h.habilitado=1 AND al.estado='Activo'
      ORDER BY ca.nombre, cu.anio, m.nombre, al.apellido
    `).all();
    const pendientes = rows
      .filter(r => r[r.tipo_examen] === null || r[r.tipo_examen] === undefined)
      .map(r => ({
        hab_id: r.hab_id, alumno_id: r.alumno_id,
        alumno_nombre: `${r.alumno_apellido||''}, ${r.alumno_nombre||''}`, alumno_ci: r.alumno_ci,
        carrera_id: r.carrera_id, carrera_nombre: r.carrera_nombre,
        anio: r.anio, division: r.division,
        materia_nombre: r.materia_nombre, asignacion_id: r.asignacion_id,
        docente_nombre: r.doc_apellido ? `${r.doc_apellido}, ${r.doc_nombre||''}` : null,
        tipo_examen: r.tipo_examen, fecha_habilitacion: r.fecha_habilitacion,
        fecha_examen: r.fecha_examen, hora_examen: r.hora_examen,
      }));
    res.json(pendientes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HABILITADOS DE MIS MATERIAS (para el docente, ej. desde el celular) ──────
// IMPORTANTE: usar LEFT JOIN (no JOIN) con asignaciones. Habilitaciones viejas o
// creadas como excepción "global" (sin materia específica, asignacion_id NULL o
// apuntando a una asignación que ya no existe) deben seguir siendo visibles para
// el docente que le da clase a ese alumno — antes un JOIN estricto las hacía
// desaparecer silenciosamente aunque el panel del director sí las mostraba.
app.get('/api/docente/habilitados', auth(['docente']), (req, res) => {
  if (!req.user.docenteId) return res.json([]);
  try {
    const rows = db.prepare(`
      SELECT h.id, h.tipo_examen, h.fecha, h.motivo, h.asignacion_id,
        al.nombre as alumno_nombre, al.apellido as alumno_apellido, al.ci as alumno_ci,
        COALESCE(ca.nombre, al_ca.nombre, al_carr.nombre) as carrera_nombre,
        COALESCE(cu.anio, al_cu.anio) as anio,
        COALESCE(cu.division, al_cu.division) as division,
        m.nombre as materia_nombre
      FROM habilitaciones_examen h
      LEFT JOIN asignaciones asig ON h.asignacion_id=asig.id
      LEFT JOIN alumnos al ON h.alumno_id=al.id
      LEFT JOIN materias m ON asig.materia_id=m.id
      LEFT JOIN cursos cu ON asig.curso_id=cu.id
      LEFT JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN cursos al_cu ON al.curso_id=al_cu.id
      LEFT JOIN carreras al_ca ON al_cu.carrera_id=al_ca.id
      LEFT JOIN carreras al_carr ON al.carrera_id=al_carr.id
      WHERE h.habilitado=1 AND (
        asig.docente_id=?
        OR (
          h.asignacion_id IS NULL
          AND EXISTS (SELECT 1 FROM asignaciones a2 WHERE a2.curso_id=al.curso_id AND a2.docente_id=?)
        )
      )
      ORDER BY h.fecha DESC`).all(req.user.docenteId, req.user.docenteId);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ASIGNACIONES ACTIVAS DEL ALUMNO (para selector de materia en pagos/habilitaciones) ──
app.get('/api/alumnos/:id/asignaciones-activas', auth(ADM), (req, res) => {
  try {
    const al = db.prepare('SELECT curso_id FROM alumnos WHERE id=?').get(req.params.id);
    if (!al?.curso_id) return res.json([]);
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (!periodo) return res.json([]);
    const asigs = db.prepare(`
      SELECT a.id, m.nombre as materia_nombre, cu.anio, cu.division,
        u.nombre as docente_nombre, u.apellido as docente_apellido
      FROM asignaciones a
      JOIN materias m ON a.materia_id = m.id
      JOIN cursos cu ON a.curso_id = cu.id
      LEFT JOIN usuarios u ON a.docente_id = u.id
      WHERE a.curso_id = ? AND a.periodo_id = ?
      ORDER BY m.nombre`).all(al.curso_id, periodo.id);
    res.json(asigs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/auditoria', auth(ADM), (req, res) => {
  const { tabla, accion, usuario_id, rol, desde, hasta, limite } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (tabla)      { where += ' AND a.tabla=?';       params.push(tabla); }
  if (accion)     { where += ' AND (a.accion=? OR a.accion LIKE ?)'; params.push(accion, accion+'%'); }
  if (usuario_id) { where += ' AND a.usuario_id=?';  params.push(usuario_id); }
  if (rol)        { where += ' AND u.rol=?';         params.push(rol); }
  if (desde)      { where += ' AND a.fecha>=?';      params.push(desde); }
  if (hasta)      { where += " AND a.fecha<=?";      params.push(hasta+' 23:59:59'); }
  const lim = Math.min(parseInt(limite)||1000, 9999);
  const rows = db.prepare(`
    SELECT a.*, u.nombre as user_nombre, u.apellido as user_apellido, u.rol
    FROM auditoria a
    LEFT JOIN usuarios u ON a.usuario_id=u.id
    ${where} ORDER BY a.fecha DESC LIMIT ?`).all(...params, lim);
  // Estadísticas para el panel
  const stats = db.prepare(`
    SELECT accion, COUNT(*) as total FROM auditoria
    WHERE fecha>=date('now','-30 days') GROUP BY accion ORDER BY total DESC`).all();
  const usuarios_activos = db.prepare(`
    SELECT a.usuario_id, u.nombre, u.apellido, u.rol, COUNT(*) as acciones
    FROM auditoria a JOIN usuarios u ON a.usuario_id=u.id
    WHERE a.fecha>=date('now','-7 days') GROUP BY a.usuario_id ORDER BY acciones DESC LIMIT 10`).all();
  res.json({ registros: rows, stats, usuarios_activos, total: rows.length });
});

app.get('/api/admin/hora-sistema', auth(ADM), (req, res) => {
  const ahora = new Date();
  const ajustada = nowSys();
  res.json({
    iso: ahora.toISOString(),
    local: ahora.toLocaleString('es-PY', { timeZone: 'America/Asuncion' }),
    utc: ahora.toUTCString(),
    tz_env: process.env.TZ || '(no configurada)',
    offset_min: ahora.getTimezoneOffset(),
    server_now: ahora.toString(),
    time_offset_ms: _timeOffsetMs,
    hora_sistema: ajustada.toLocaleString('es-PY', { timeZone: 'America/Asuncion' }),
    hora_sistema_iso: ajustada.toISOString(),
  });
});

app.post('/api/admin/hora-manual', auth(ADM), (req, res) => {
  const { fecha, hora } = req.body; // "2026-05-21" y "21:52"
  if (!fecha || !hora) return res.status(400).json({ error: 'Requiere fecha y hora' });
  // Construir la fecha deseada en la zona horaria del servidor (America/Asuncion)
  // Como el servidor ya tiene TZ=America/Asuncion, new Date(fecha+'T'+hora+':00') es hora local
  const deseada = new Date(`${fecha}T${hora}:00`);
  if (isNaN(deseada.getTime())) return res.status(400).json({ error: 'Fecha u hora inválida' });
  const offset = deseada.getTime() - Date.now();
  _timeOffsetMs = offset;
  try {
    db.prepare("INSERT OR REPLACE INTO configuracion (clave, valor, descripcion) VALUES ('time_offset_ms', ?, 'Offset manual de hora del sistema en milisegundos')").run(String(offset));
  } catch(e) { console.error('Error guardando offset:', e.message); }
  audit(req.user.id, 'SET_HORA_MANUAL', 'sistema', 'hora', { fecha, hora, offset_ms: offset });
  res.json({ ok: true, hora_sistema: nowSys().toLocaleString('es-PY', { timeZone: 'America/Asuncion' }), offset_ms: offset });
});

app.post('/api/admin/hora-reset', auth(ADM), (req, res) => {
  _timeOffsetMs = 0;
  try { db.prepare("DELETE FROM configuracion WHERE clave='time_offset_ms'").run(); } catch {}
  audit(req.user.id, 'RESET_HORA', 'sistema', 'hora', { msg: 'Offset reiniciado a 0' });
  res.json({ ok: true, msg: 'Hora del servidor restaurada (sin offset)' });
});

// GET /api/actividad-reciente — feed de actividad para el director
app.get('/api/actividad-reciente', auth(ADM), (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.accion, a.tabla, a.registro_id, a.detalle, a.fecha,
      u.nombre as user_nombre, u.apellido as user_apellido, u.rol as user_rol
    FROM auditoria a
    LEFT JOIN usuarios u ON a.usuario_id=u.id
    WHERE a.accion NOT IN ('LOGIN','LOGIN_FAIL','LOGIN_OK')
    ORDER BY a.fecha DESC LIMIT 40
  `).all();
  res.json(rows);
});

app.delete('/api/admin/auditoria', auth(ADM), (req, res) => {
  // Permite limpiar auditoría anterior a N días (mínimo 30)
  const { dias } = req.body;
  const d = Math.max(parseInt(dias)||90, 30);
  const result = db.prepare(`DELETE FROM auditoria WHERE fecha<date('now','-${d} days')`).run();
  audit(req.user.id, 'PURGE_AUDIT', 'auditoria', null, { dias: d, eliminados: result.changes });
  res.json({ ok: true, eliminados: result.changes });
});

// ── REPARAR NOTAS FALTANTES (alumnos con curso pero sin notas) ───────────────
app.post('/api/admin/reparar-notas', auth(ADM), (req, res) => {
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  if (!periodo) return res.status(400).json({ error: 'No hay periodo activo' });

  const alumnos = db.prepare(`
    SELECT al.id, al.curso_id,
      COALESCE(al.nombre,u.nombre) as nombre,
      COALESCE(al.apellido,u.apellido) as apellido
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE al.curso_id IS NOT NULL AND al.estado='Activo'
  `).all();

  let reparados = 0, notasCreadas = 0;
  db.transaction(() => {
    alumnos.forEach(al => {
      const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(al.curso_id, periodo.id);
      let creoPara = 0;
      asigs.forEach((asig, i) => {
        const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(al.id, asig.id);
        if (!existe) {
          try {
            db.prepare('INSERT INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)')
              .run('n_rep_'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,5), al.id, asig.id, 'Pendiente');
            creoPara++;
            notasCreadas++;
          } catch(e) {}
        }
      });
      if (creoPara > 0) reparados++;
    });
  })();

  audit(req.user.id, 'REPARAR_NOTAS', 'notas', 'bulk', { alumnos_reparados: reparados, notas_creadas: notasCreadas });
  res.json({ ok: true, alumnos_reparados: reparados, notas_creadas: notasCreadas });
});

// ── ENDPOINT TEMPORAL ────────────────────────────────────────────────────────
app.post('/api/admin/dbq', auth(ADM), (req, res) => {
  try {
    const { sql, params } = req.body;
    if (!sql) return res.status(400).json({ error: 'sql requerido' });
    const stmt = db.prepare(sql);
    const result = sql.trim().toUpperCase().startsWith('SELECT')
      ? stmt.all(...(params||[]))
      : stmt.run(...(params||[]));
    res.json({ ok: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/sendwa', auth(ADM), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone y message requeridos' });
    const result = await sendWhatsApp(phone, message);
    res.json({ ok: true, result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/wa-status', auth(ADM), async (req, res) => {
  try {
    const EVO_URL = process.env.EVOLUTION_URL;
    const EVO_KEY = process.env.EVOLUTION_KEY;
    const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
    if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.json({ error: 'Variables no configuradas', EVO_URL, EVO_INSTANCE });
    const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
    const d = await r.json();
    res.json({ ok: true, status: d, EVO_URL, EVO_INSTANCE });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── FIN ENDPOINT TEMPORAL ─────────────────────────────────────────────────────

// ── DIAGNÓSTICO COMPLETO DEL SISTEMA ────────────────────────────────────────

app.get('/api/admin/diagnostico', auth(ADM), (req, res) => {
  const problemas = [];
  const push = (obj) => problemas.push({ historial:[], accion_disponible:'informativo', nombre:'', apellido:'', ci:'', ...obj });
  const audTrail = (id) => db.prepare("SELECT a.fecha,a.accion,u.nombre as user_nombre,u.apellido as user_apellido,a.detalle FROM auditoria a LEFT JOIN usuarios u ON a.usuario_id=u.id WHERE a.registro_id=? ORDER BY a.fecha ASC").all(id);
  const asigInfo = (id) => db.prepare("SELECT a.*,m.nombre as materia_nombre,ca.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_division,u.nombre as docente_nombre,u.apellido as docente_apellido FROM asignaciones a JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id LEFT JOIN docentes d ON a.docente_id=d.id LEFT JOIN usuarios u ON d.usuario_id=u.id WHERE a.id=?").get(id);
  const alumnoInfo = (ci) => ci ? db.prepare("SELECT al.*,c.nombre as carrera_nombre,cu.anio as curso_anio,cu.division as curso_division FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN cursos cu ON al.curso_id=cu.id WHERE al.ci=? OR u.ci=? LIMIT 1").get(ci,ci) : null;

  // ── BLOQUE 1: SOLICITUDES DE INCORPORACIÓN ─────────────────────────────────
  const solsAprobadas = db.prepare("SELECT * FROM solicitudes_alumno WHERE estado='aprobado'").all();
  for (const sol of solsAprobadas) {
    const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
    const alumno = alumnoInfo(ciRaw);
    const asig = asigInfo(sol.asignacion_id);
    const docente = db.prepare("SELECT u.nombre,u.apellido FROM usuarios u JOIN docentes d ON d.usuario_id=u.id WHERE d.id=?").get(sol.docente_id);
    const hist = audTrail(sol.id);
    const base = { sol_id:sol.id, nombre:sol.nombre, apellido:sol.apellido, ci:sol.ci, asignacion_id:sol.asignacion_id, materia:asig?.materia_nombre||'?', carrera_asig:asig?.carrera_nombre||'?', curso_asig_anio:asig?.curso_anio, curso_asig_division:asig?.curso_division, docente_solicitante:docente?(docente.nombre+' '+docente.apellido):sol.docente_id, fecha_solicitud:sol.fecha, historial:hist };
    if (!alumno) {
      push({ ...base, tipo:'alumno_faltante', gravedad:'critico', mensaje:'Solicitud aprobada pero el alumno NO fue creado en el sistema', accion_disponible:'revertir_y_reaprobar' });
    } else {
      const nota = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(alumno.id, sol.asignacion_id);
      const añoDistinto = alumno.curso_anio && asig?.curso_anio && alumno.curso_anio !== asig.curso_anio;
      const extra = { alumno_id:alumno.id, matricula:alumno.matricula, carrera_alumno:alumno.carrera_nombre, curso_alumno_anio:alumno.curso_anio, curso_alumno_division:alumno.curso_division, pagos:db.prepare("SELECT concepto,monto,fecha_pago,estado FROM pagos WHERE alumno_id=? LIMIT 6").all(alumno.id) };
      if (!nota) push({ ...base, ...extra, tipo:'nota_faltante', gravedad:añoDistinto?'advertencia':'critico', mensaje:añoDistinto?`Alumno en ${alumno.curso_anio}° año vinculado a materia de ${asig.curso_anio}° año — falta nota`:'Alumno creado pero falta registro de nota en la materia', accion_disponible:'crear_nota' });
      else if (añoDistinto) push({ ...base, ...extra, tipo:'anio_incorrecto', gravedad:'advertencia', mensaje:`Alumno en ${alumno.curso_anio}° año inscripto en materia de ${asig.curso_anio}° año`, accion_disponible:'informativo' });
    }
  }

  // ── BLOQUE 2: DUPLICADOS ────────────────────────────────────────────────────
  // CI duplicados en usuarios
  const ciDupUsu = db.prepare("SELECT ci, COUNT(*) as n, GROUP_CONCAT(id) as ids, GROUP_CONCAT(nombre||' '||apellido) as nombres FROM usuarios WHERE ci IS NOT NULL AND ci!='' GROUP BY ci HAVING n>1").all();
  for (const d of ciDupUsu) push({ tipo:'ci_duplicado_usuario', gravedad:'critico', mensaje:`CI ${d.ci} aparece ${d.n} veces en usuarios`, ci:d.ci, nombre:d.nombres, extra_ids:d.ids, accion_disponible:'informativo' });

  // CI duplicados en alumnos
  const ciDupAlu = db.prepare("SELECT al.ci, COUNT(*) as n, GROUP_CONCAT(al.id) as ids, GROUP_CONCAT(COALESCE(al.nombre,u.nombre,'')||' '||COALESCE(al.apellido,u.apellido,'')) as nombres, GROUP_CONCAT(al.matricula) as matriculas, GROUP_CONCAT(al.carrera_id) as carreras FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id WHERE al.ci IS NOT NULL AND al.ci!='' AND al.estado='Activo' GROUP BY al.ci HAVING n>1").all();
  for (const d of ciDupAlu) {
    const ids = (d.ids||'').split(',');
    const noms = (d.nombres||'').split(',');
    const mats = (d.matriculas||'').split(',');
    // Build per-alumno detail for deactivation choices
    const duplicados_detalle = ids.map((id,i)=>({ id:id.trim(), nombre:(noms[i]||'').trim(), matricula:(mats[i]||'').trim() }));
    push({ tipo:'ci_duplicado_alumno', gravedad:'critico', mensaje:`CI ${d.ci} aparece ${d.n} veces en alumnos activos — ${mats}`, ci:d.ci, nombre:d.nombres, matricula:d.matriculas, extra_ids:d.ids, duplicados_detalle, accion_disponible:'desactivar_duplicado' });
  }

  // Email duplicados en usuarios
  const emailDup = db.prepare("SELECT email, COUNT(*) as n, GROUP_CONCAT(nombre||' '||apellido) as nombres FROM usuarios WHERE email IS NOT NULL GROUP BY email HAVING n>1").all();
  for (const d of emailDup) push({ tipo:'email_duplicado', gravedad:'advertencia', mensaje:`Email ${d.email} asignado a ${d.n} usuarios`, nombre:d.nombres, accion_disponible:'informativo' });

  // Matrículas duplicadas
  const matDup = db.prepare("SELECT matricula, COUNT(*) as n, GROUP_CONCAT(id) as ids, GROUP_CONCAT(COALESCE(nombre,'')||' '||COALESCE(apellido,'')) as nombres FROM alumnos WHERE matricula IS NOT NULL AND estado='Activo' GROUP BY matricula HAVING n>1").all();
  for (const d of matDup) push({ tipo:'matricula_duplicada', gravedad:'critico', mensaje:`Matrícula ${d.matricula} asignada a ${d.n} alumnos`, nombre:d.nombres, extra_ids:d.ids, accion_disponible:'informativo' });

  // ── BLOQUE 3: DATOS VACÍOS / INCOMPLETOS ──────────────────────────────────
  // Alumnos sin CI
  const sinCI = db.prepare("SELECT al.id,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,al.matricula,c.nombre as carrera_nombre FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id WHERE (al.ci IS NULL OR al.ci='') AND (u.ci IS NULL OR u.ci='') AND al.estado='Activo' LIMIT 20").all();
  for (const a of sinCI) push({ tipo:'alumno_sin_ci', gravedad:'advertencia', nombre:a.nombre||'', apellido:a.apellido||'', matricula:a.matricula, carrera_alumno:a.carrera_nombre, alumno_id:a.id, mensaje:'Alumno activo sin número de CI registrado', accion_disponible:'informativo' });

  // Alumnos sin carrera asignada
  const sinCarrera = db.prepare("SELECT al.id,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,al.ci,al.matricula FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id WHERE al.carrera_id IS NULL AND al.estado='Activo' LIMIT 20").all();
  for (const a of sinCarrera) push({ tipo:'alumno_sin_carrera', gravedad:'advertencia', nombre:a.nombre||'', apellido:a.apellido||'', ci:a.ci||'', matricula:a.matricula, alumno_id:a.id, mensaje:'Alumno activo sin carrera asignada', accion_disponible:'informativo' });

  // Alumnos sin curso asignado
  const sinCurso = db.prepare("SELECT al.id,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,al.ci,al.matricula,c.nombre as carrera_nombre FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id WHERE al.curso_id IS NULL AND al.estado='Activo' LIMIT 20").all();
  for (const a of sinCurso) push({ tipo:'alumno_sin_curso', gravedad:'advertencia', nombre:a.nombre||'', apellido:a.apellido||'', ci:a.ci||'', matricula:a.matricula, carrera_alumno:a.carrera_nombre, alumno_id:a.id, mensaje:'Alumno activo sin año/curso asignado', accion_disponible:'informativo' });

  // Alumnos sin usuario vinculado
  const sinUsuario = db.prepare("SELECT al.id,al.nombre,al.apellido,al.ci,al.matricula,c.nombre as carrera_nombre,cu.anio FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN cursos cu ON al.curso_id=cu.id WHERE u.id IS NULL AND al.estado='Activo' LIMIT 20").all();
  for (const a of sinUsuario) push({ tipo:'usuario_faltante', gravedad:'critico', nombre:a.nombre||'', apellido:a.apellido||'', ci:a.ci||'', matricula:a.matricula, carrera_alumno:a.carrera_nombre, curso_alumno_anio:a.anio, alumno_id:a.id, mensaje:'Alumno activo sin cuenta de usuario (no puede ingresar al sistema)', accion_disponible:'crear_cuenta' });

  // Docentes sin usuario vinculado
  const docentesSinUsu = db.prepare("SELECT d.id,d.especialidad FROM docentes d LEFT JOIN usuarios u ON d.usuario_id=u.id WHERE u.id IS NULL LIMIT 10").all();
  for (const d of docentesSinUsu) push({ tipo:'docente_sin_usuario', gravedad:'critico', nombre:'Docente '+d.id, mensaje:'Docente registrado sin cuenta de usuario vinculada', accion_disponible:'informativo' });

  // Asignaciones sin docente
  const asigSinDoc = db.prepare("SELECT a.id,m.nombre as materia,ca.nombre as carrera,cu.anio FROM asignaciones a JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id WHERE a.docente_id IS NULL LIMIT 10").all();
  for (const a of asigSinDoc) push({ tipo:'asignacion_sin_docente', gravedad:'advertencia', materia:a.materia, carrera_asig:a.carrera, curso_asig_anio:a.anio, mensaje:`Asignación de ${a.materia} (${a.carrera} ${a.anio}°) sin docente asignado`, accion_disponible:'informativo' });

  // ── BLOQUE 4: INTEGRIDAD DE NOTAS ─────────────────────────────────────────
  // Notas con alumno_id que no existe en alumnos
  const notasHuerfanas = db.prepare("SELECT n.id,n.alumno_id,n.asignacion_id FROM notas n LEFT JOIN alumnos al ON n.alumno_id=al.id WHERE al.id IS NULL LIMIT 20").all();
  for (const n of notasHuerfanas) push({ tipo:'nota_huerfana', gravedad:'critico', mensaje:`Nota ${n.id} referencia a alumno_id inexistente (${n.alumno_id})`, accion_disponible:'informativo' });

  // Notas con asignacion_id que no existe
  const notasAsigInval = db.prepare("SELECT n.id,n.alumno_id,n.asignacion_id FROM notas n LEFT JOIN asignaciones a ON n.asignacion_id=a.id WHERE a.id IS NULL LIMIT 20").all();
  for (const n of notasAsigInval) push({ tipo:'nota_asig_invalida', gravedad:'critico', mensaje:`Nota ${n.id} referencia a asignacion_id inexistente (${n.asignacion_id})`, accion_disponible:'informativo' });

  // alumno_sin_notas: movido a Gestión de Alumnos (bloque 4 — sin asignar)

  // ── BLOQUE 5: PAGOS ────────────────────────────────────────────────────────
  // Pagos con alumno_id que no existe
  const pagosSinAlumno = db.prepare("SELECT p.id,p.alumno_id,p.concepto,p.monto,p.fecha_pago FROM pagos p LEFT JOIN alumnos al ON p.alumno_id=al.id WHERE al.id IS NULL LIMIT 10").all();
  for (const p of pagosSinAlumno) push({ tipo:'pago_sin_alumno', gravedad:'critico', mensaje:`Pago ${p.concepto} (${p.fecha_pago}) referencia alumno_id inexistente`, accion_disponible:'informativo' });

  // ── BLOQUE 6: ASISTENCIA ───────────────────────────────────────────────────
  // Asistencia con alumno inexistente
  const asistSinAlumno = db.prepare("SELECT COUNT(*) as n FROM asistencia a LEFT JOIN alumnos al ON a.alumno_id=al.id WHERE al.id IS NULL").get();
  if (asistSinAlumno?.n > 0) push({ tipo:'asistencia_huerfana', gravedad:'advertencia', mensaje:`${asistSinAlumno.n} registro(s) de asistencia con alumno_id inexistente`, accion_disponible:'informativo' });

  // ── BLOQUE 7: USUARIOS Y ACCESO ────────────────────────────────────────────
  // Usuarios inactivos con accesos recientes (últimos 7 días)
  const inactivosActivos = db.prepare("SELECT u.id,u.nombre,u.apellido,u.ci,u.rol,MAX(a.fecha) as ultimo_acceso FROM usuarios u JOIN auditoria a ON a.usuario_id=u.id WHERE u.activo=0 AND a.fecha>=datetime('now','-7 days') GROUP BY u.id LIMIT 10").all();
  for (const u of inactivosActivos) push({ tipo:'usuario_inactivo_activo', gravedad:'advertencia', nombre:u.nombre, apellido:u.apellido, ci:u.ci, mensaje:`Usuario INACTIVO con actividad reciente (${u.ultimo_acceso?.slice(0,16)})`, accion_disponible:'informativo' });

  // Múltiples sesiones del mismo usuario en ventana corta (posible uso compartido)
  const sesionesMultiples = db.prepare("SELECT u.nombre,u.apellido,u.ci,COUNT(*) as logins,MIN(a.fecha) as desde,MAX(a.fecha) as hasta FROM auditoria a JOIN usuarios u ON a.usuario_id=u.id WHERE a.accion='LOGIN' AND a.fecha>=datetime('now','-1 days') GROUP BY a.usuario_id HAVING logins>=5").all();
  for (const s of sesionesMultiples) push({ tipo:'logins_excesivos', gravedad:'info', nombre:s.nombre, apellido:s.apellido, ci:s.ci, mensaje:`${s.logins} inicios de sesión en las últimas 24h (${s.desde?.slice(0,16)} → ${s.hasta?.slice(0,16)})`, accion_disponible:'informativo' });

  // ── BLOQUE 8: EXÁMENES ─────────────────────────────────────────────────────
  // Exámenes sin asignación válida
  const examSinAsig = db.prepare("SELECT e.id,e.tipo,e.fecha FROM examenes e LEFT JOIN asignaciones a ON e.asignacion_id=a.id WHERE a.id IS NULL LIMIT 10").all();
  for (const e of examSinAsig) push({ tipo:'examen_sin_asignacion', gravedad:'advertencia', mensaje:`Examen de tipo "${e.tipo}" (${e.fecha}) sin asignación válida`, accion_disponible:'informativo' });

  // ── BLOQUE 9: PERÍODO ACTIVO ───────────────────────────────────────────────
  const periodos = db.prepare("SELECT * FROM periodos WHERE activo=1").all();
  if (periodos.length===0) push({ tipo:'sin_periodo_activo', gravedad:'critico', mensaje:'No hay período lectivo activo — el sistema no puede registrar notas ni pagos correctamente', accion_disponible:'informativo' });
  if (periodos.length>1)  push({ tipo:'multiples_periodos_activos', gravedad:'critico', mensaje:`Hay ${periodos.length} períodos marcados como activos simultáneamente`, accion_disponible:'informativo' });

  // ── BLOQUE 10: ERRORES RECIENTES ───────────────────────────────────────────
  const erroresRecientes = db.prepare("SELECT * FROM auditoria WHERE accion='ERROR' AND fecha>=datetime('now','-48 hours') ORDER BY fecha DESC LIMIT 15").all();
  for (const err of erroresRecientes) {
    let det={};try{det=JSON.parse(err.detalle||'{}');}catch{}
    push({ tipo:'error_sistema', gravedad:'info', mensaje:`[${err.fecha?.slice(0,16)}] ${err.tabla||'?'} — ${det.error||det.mensaje||'Error sin descripción'}`, fecha:err.fecha, detalle_raw:err.detalle });
  }

  const resumen = {
    total:problemas.length,
    criticos:problemas.filter(p=>p.gravedad==='critico').length,
    advertencias:problemas.filter(p=>p.gravedad==='advertencia').length,
    info:problemas.filter(p=>p.gravedad==='info').length,
    ok:problemas.filter(p=>['critico','advertencia'].includes(p.gravedad)).length===0,
    // Estadísticas generales del sistema
    stats: {
      total_alumnos: db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo'").get()?.n||0,
      total_docentes: db.prepare("SELECT COUNT(*) as n FROM docentes").get()?.n||0,
      total_notas: db.prepare("SELECT COUNT(*) as n FROM notas").get()?.n||0,
      total_pagos: db.prepare("SELECT COUNT(*) as n FROM pagos WHERE estado='Pagado'").get()?.n||0,
      solicitudes_pendientes: db.prepare("SELECT COUNT(*) as n FROM solicitudes_alumno WHERE estado='pendiente'").get()?.n||0,
      errores_hoy: db.prepare("SELECT COUNT(*) as n FROM auditoria WHERE accion='ERROR' AND fecha>=date('now')").get()?.n||0,
      periodo_activo: db.prepare("SELECT nombre,anio FROM periodos WHERE activo=1").get()||null,
    }
  };
  res.json({ resumen, problemas });
});

// ── REPARAR SOLICITUDES APROBADAS ──────────────────────────────────────────
app.post('/api/admin/reparar-solicitudes', auth(ADM), (req, res) => {
  const { sol_id, accion } = req.body; // accion: 'crear_nota'
  const sol = db.prepare('SELECT * FROM solicitudes_alumno WHERE id=?').get(sol_id);
  if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (sol.estado !== 'aprobado') return res.status(400).json({ error: 'Solicitud no está aprobada' });
  const asig = db.prepare('SELECT * FROM asignaciones WHERE id=?').get(sol.asignacion_id);
  if (!asig) return res.status(400).json({ error: 'Asignación no encontrada' });
  const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
  const alumno = ciRaw ? db.prepare("SELECT al.* FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id WHERE al.ci=? OR u.ci=? LIMIT 1").get(ciRaw,ciRaw) : null;
  if (!alumno) return res.status(400).json({ error: 'Alumno no encontrado en el sistema. Revertir y re-aprobar la solicitud.' });
  if (accion === 'crear_nota') {
    const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(alumno.id, asig.id);
    if (existe) return res.json({ ok:true, mensaje:'La nota ya existía', nota_id:existe.id });
    const nid = 'n_rep_'+Date.now();
    db.prepare("INSERT INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)").run(nid, alumno.id, asig.id, 'Pendiente');
    audit(req.user.id,'REPARAR','notas',nid,{ sol_id, alumno_id:alumno.id, asignacion_id:asig.id, ci:sol.ci, nombre:sol.nombre+' '+sol.apellido });
    return res.json({ ok:true, mensaje:'Nota creada correctamente', nota_id:nid, alumno_id:alumno.id });
  }
  if (accion === 'revertir') {
    db.prepare("UPDATE solicitudes_alumno SET estado='pendiente' WHERE id=?").run(sol_id);
    audit(req.user.id,'REPARAR','solicitudes_alumno',sol_id,{ accion:'revertir_a_pendiente', motivo:'corrección manual' });
    return res.json({ ok:true, mensaje:'Solicitud revertida a pendiente. Ya puede re-aprobarla.' });
  }
  res.status(400).json({ error: 'Acción no reconocida' });
});

// ── REPARAR ALUMNO SIN USUARIO ─────────────────────────────────────────────────
app.post('/api/admin/reparar-alumno', auth(ADM), (req, res) => {
  const { alumno_id, accion } = req.body;
  if (!alumno_id) return res.status(400).json({ error: 'alumno_id requerido' });
  const alumno = db.prepare('SELECT * FROM alumnos WHERE id=?').get(alumno_id);
  if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado' });
  if (accion === 'desactivar') {
    if (alumno.estado === 'Inactivo') return res.json({ ok:true, mensaje:'El alumno ya estaba inactivo' });
    db.prepare("UPDATE alumnos SET estado='Inactivo' WHERE id=?").run(alumno_id);
    audit(req.user.id,'REPARAR','alumnos',alumno_id,{ accion:'desactivar_duplicado', alumno_id, ci:alumno.ci, matricula:alumno.matricula, nombre:(alumno.nombre||'')+(alumno.apellido?' '+alumno.apellido:'') });
    return res.json({ ok:true, mensaje:`Alumno ${alumno.matricula||alumno_id} marcado como Inactivo (duplicado desactivado)`, alumno_id });
  }
  if (accion === 'crear_cuenta') {
    // Verificar que realmente no tiene usuario
    const yaTieneUsu = alumno.usuario_id ? db.prepare('SELECT id FROM usuarios WHERE id=?').get(alumno.usuario_id) : null;
    if (yaTieneUsu) return res.json({ ok:true, mensaje:'El alumno ya tiene cuenta de usuario', usuario_id:yaTieneUsu.id });
    const normStr = (s) => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const nNorm = normStr(alumno.nombre);
    const aNorm = normStr(alumno.apellido);
    const ciRaw = String(alumno.ci||'').replace(/[^0-9]/g,'');
    // Check by CI or name
    let finalUid = null;
    if (ciRaw) {
      const exCi = db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw);
      if (exCi) finalUid = exCi.id;
    }
    if (!finalUid && nNorm && aNorm) {
      const exNombre = db.prepare("SELECT id FROM usuarios WHERE lower(nombre)=? AND lower(apellido)=? LIMIT 1").get(nNorm, aNorm);
      if (exNombre) finalUid = exNombre.id;
    }
    if (!finalUid) {
      // Crear nuevo usuario
      let emailBase = (nNorm||'alumno')+'.'+(aNorm||alumno_id.slice(-4))+'@its.edu.py';
      if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailBase)) {
        emailBase = (nNorm||'alumno')+'.'+(aNorm||alumno_id.slice(-4))+'.'+(ciRaw.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
      }
      const bcrypt = require('bcryptjs');
      const pwHash = bcrypt.hashSync('alumno123', 10);
      finalUid = 'u_a_rep_'+Date.now();
      db.prepare("INSERT INTO usuarios (id,nombre,apellido,email,password_hash,rol,ci,activo) VALUES (?,?,?,?,?,'alumno',?,1)")
        .run(finalUid, alumno.nombre||'', alumno.apellido||'', emailBase, pwHash, ciRaw||null);
    }
    // Vincular alumno → usuario
    db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(finalUid, alumno_id);
    const usu = db.prepare('SELECT email FROM usuarios WHERE id=?').get(finalUid);
    audit(req.user.id,'REPARAR','alumnos',alumno_id,{ accion:'crear_cuenta_usuario', alumno_id, usuario_id:finalUid, ci:alumno.ci, nombre:alumno.nombre+' '+alumno.apellido, email:usu?.email });
    return res.json({ ok:true, mensaje:`Cuenta creada y vinculada — email: ${usu?.email||finalUid}`, usuario_id:finalUid, email:usu?.email });
  }
  res.status(400).json({ error: 'Acción no reconocida' });
});

// ── ACTA DE EXAMEN (datos para impresión) ─────────────────────────────────────
app.get('/api/examenes/:id/acta', auth(['director','docente']), (req, res) => {
  const ex = db.prepare(`
    SELECT e.*, m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      p.nombre as periodo_nombre
    FROM examenes e
    LEFT JOIN asignaciones a ON e.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    LEFT JOIN docentes d ON a.docente_id=d.id
    LEFT JOIN usuarios u ON d.usuario_id=u.id
    LEFT JOIN periodos p ON e.periodo_id=p.id
    WHERE e.id=?`).get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Examen no encontrado' });

  // Tipos de examen FINAL (aplica filtro de habilitación)
  const esFinal = ['Final','Final Recuperatorio','Complementario','Extraordinario'].includes(ex.tipo);

  const asigInfoAct = ex.asignacion_id ? db.prepare('SELECT curso_id FROM asignaciones WHERE id=?').get(ex.asignacion_id) : null;
  const carrera_id_act = asigInfoAct?.curso_id ? db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asigInfoAct.curso_id)?.carrera_id : null;

  const todosAlumnos = ex.asignacion_id ? db.prepare(`
    SELECT al.id, al.matricula, al.habilitado_pago_pendiente,
      COALESCE(al.ci,u2.ci) as ci,
      COALESCE(al.nombre,u2.nombre) as nombre, COALESCE(al.apellido,u2.apellido) as apellido,
      n.puntaje_total, n.nota_final, n.estado, n.ausente,
      CASE ?
        WHEN 'Parcial' THEN n.parcial
        WHEN 'Recuperatorio' THEN n.parcial_recuperatorio
        WHEN 'Final' THEN n.final_ord
        WHEN 'Final Recuperatorio' THEN n.final_recuperatorio
        WHEN 'Complementario' THEN n.complementario
        WHEN 'Extraordinario' THEN n.extraordinario
        ELSE n.puntaje_total
      END as puntaje_examen
    FROM alumnos al
    LEFT JOIN usuarios u2 ON al.usuario_id=u2.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.estado='Activo'
      AND (al.curso_id=(SELECT curso_id FROM asignaciones WHERE id=?)
           OR (? IS NOT NULL AND al.carrera_id=? AND al.curso_id IS NULL))
    ORDER BY COALESCE(al.apellido,u2.apellido)`).all(ex.tipo, ex.asignacion_id, ex.asignacion_id, carrera_id_act, carrera_id_act) : [];

  let alumnos = todosAlumnos;
  let excluidos = 0;

  if (esFinal) {
    // Para finales: solo incluir alumnos habilitados
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const cuotasReq = ['Cuota 1','Cuota 2','Cuota 3','Cuota 4','Cuota 5'];
    const filtrados = [];
    for (const al of todosAlumnos) {
      if (al.habilitado_pago_pendiente) { filtrados.push(al); continue; }
      if (periodo) {
        const pagos = db.prepare("SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'").all(al.id, periodo.id);
        const conceptos = pagos.map(p=>p.concepto);
        const faltantes = cuotasReq.filter(c=>!conceptos.some(p=>p===c||p.includes(c)));
        if (faltantes.length === 0) filtrados.push(al);
        else excluidos++;
      } else {
        filtrados.push(al); // Sin período activo: no bloquear
      }
    }
    alumnos = filtrados;
  }

  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ examen: ex, alumnos, institucion: inst, excluidos, esFinal });
});

// ── ACTA DE TPS (trabajos prácticos) ─────────────────────────────────────────
app.get('/api/asignaciones/:id/acta-tp', auth(['director','docente']), (req, res) => {
  const asig = db.prepare(`
    SELECT a.*, m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido,
      p.nombre as periodo_nombre
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    LEFT JOIN docentes d ON a.docente_id=d.id
    LEFT JOIN usuarios u ON d.usuario_id=u.id
    JOIN periodos p ON a.periodo_id=p.id
    WHERE a.id=?`).get(req.params.id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
  const carrera_id_tp = asig.curso_id ? db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asig.curso_id)?.carrera_id : null;
  const alumnos = db.prepare(`
    SELECT al.matricula, COALESCE(al.ci,u2.ci) as ci,
      COALESCE(al.nombre,u2.nombre) as nombre, COALESCE(al.apellido,u2.apellido) as apellido,
      n.tp1, n.tp2, n.tp3, n.tp4, n.tp5, n.tp_total
    FROM alumnos al
    LEFT JOIN usuarios u2 ON al.usuario_id=u2.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.estado='Activo'
      AND (al.curso_id=? OR (? IS NOT NULL AND al.carrera_id=? AND al.curso_id IS NULL))
    ORDER BY COALESCE(al.apellido,u2.apellido)`).all(req.params.id, asig.curso_id, carrera_id_tp, carrera_id_tp);
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ asignacion: asig, alumnos, institucion: inst });
});

// ── HELPERS: Variables de examen ──────────────────────────────────────────────
function examenVars(ex) {
  const curso = `${ex.anio||''}°${ex.division && ex.division!=='U' ? ' Sec.'+ex.division : ''}`;
  return {
    docente:  `${ex.doc_apellido||''} ${ex.doc_nombre||''}`.trim(),
    materia:  ex.materia || '',
    carrera:  ex.carrera || '',
    curso,
    tipo:     ex.tipo || '',
    fecha:    ex.fecha ? new Date(ex.fecha+'T12:00:00').toLocaleDateString('es-PY',{weekday:'long',day:'numeric',month:'long'}) : '',
    hora:     ex.hora || 'A confirmar',
    aula:     ex.aula || 'A confirmar',
  };
}

// ── WHATSAPP — Evolution API ──────────────────────────────────────────────────
function normalizarTelefono(tel) {
  let t = String(tel || '').replace(/\D/g, '');
  if (!t || t.length < 7) return null;
  if (t.startsWith('0')) t = '595' + t.slice(1);
  if (!t.startsWith('595')) t = '595' + t;
  return t;
}
// ── ANTI-SPAM: límite diario y variación de texto ────────────────────────────
const WA_LIMITE_DIARIO = 150; // máximo mensajes por día (50 alumnos + 20 docentes + margen)

function waMensajesHoy() {
  const hoy = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
  // SQLite guarda CURRENT_TIMESTAMP como 'YYYY-MM-DD HH:MM:SS' (espacio, no T)
  // Usar DATE(fecha) para comparar independientemente del formato
  const r = db.prepare("SELECT COUNT(*) as n FROM wa_mensajes WHERE estado='enviado' AND DATE(fecha)=?")
    .get(hoy);
  return r?.n || 0;
}

// Variaciones de apertura y cierre para que cada mensaje sea ligeramente distinto
const WA_APERTURAS = ['', '', '', '¡Hola! ', 'Buen día. ', ''];
const WA_CIERRES   = ['', '\n\n_Atentamente, ITS._', '', '\n\n_Sistema ITS._', '', '\n\n_Saludos._'];

function waVariarTexto(mensaje) {
  const ap = WA_APERTURAS[Math.floor(Math.random() * WA_APERTURAS.length)];
  const ci = WA_CIERRES[Math.floor(Math.random() * WA_CIERRES.length)];
  return ap + mensaje + ci;
}

// Twilio (API oficial de WhatsApp Business) — reemplaza a Evolution API, que quedó
// restringida por Meta para envío automatizado (ver memoria del proyecto, 2026-07-20).
// Si TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_FROM están configurados se
// usa Twilio; si no, cae al camino viejo de Evolution API (por si hace falta volver
// atrás momentáneamente). TWILIO_WHATSAPP_FROM va con el prefijo completo, ej:
// 'whatsapp:+14155238886' (sandbox) o 'whatsapp:+595XXXXXXXXX' (número de producción).
async function _sendWhatsAppTwilio(numero, texto, sid, token, from) {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const body = new URLSearchParams({ From: from, To: `whatsapp:+${numero}`, Body: texto });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      console.log(`[WA-Twilio] ✅ Enviado a ${numero} → sid:${data.sid}`);
      return { ok: true, numero };
    }
    console.warn(`[WA-Twilio] Falló: ${resp.status} → ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: false, error: `Twilio: ${data.message || resp.status}`, numero };
  } catch(e) {
    console.error('[WA-Twilio] Error fetch:', e.message);
    return { ok: false, error: e.message, numero };
  }
}
async function sendWhatsApp(phone, message) {
  const numero = normalizarTelefono(phone);
  if (!numero) {
    console.warn('[WA] Teléfono inválido:', phone);
    return { ok: false, error: `Teléfono inválido: "${phone}"` };
  }
  // Límite diario anti-spam
  const enviados = waMensajesHoy();
  if (enviados >= WA_LIMITE_DIARIO) {
    console.warn(`[WA] Límite diario alcanzado (${enviados}/${WA_LIMITE_DIARIO}). Mensaje no enviado.`);
    return { ok: false, error: `Límite diario de ${WA_LIMITE_DIARIO} mensajes alcanzado` };
  }
  const mensajeVariado = waVariarTexto(message);

  // WA_PROVIDER fuerza cuál usar sin tener que borrar/reponer credenciales en Railway
  // cada vez que se quiere probar el otro camino. Valores: 'twilio' | 'evolution'.
  // Si no está seteada, se usa Twilio por defecto en cuanto sus variables existen.
  const WA_PROVIDER = (process.env.WA_PROVIDER || '').toLowerCase();
  const TW_SID  = process.env.TWILIO_ACCOUNT_SID;
  const TW_TOK  = process.env.TWILIO_AUTH_TOKEN;
  const TW_FROM = process.env.TWILIO_WHATSAPP_FROM;
  if (WA_PROVIDER !== 'evolution' && TW_SID && TW_TOK && TW_FROM) {
    console.log(`[WA-Twilio] Enviando a ${numero} (${enviados+1}/${WA_LIMITE_DIARIO} hoy)`);
    return await _sendWhatsAppTwilio(numero, mensajeVariado, TW_SID, TW_TOK, TW_FROM);
  }

  // ── Camino viejo: Evolution API (fallback si Twilio no está configurado) ──────
  const EVO_URL      = process.env.EVOLUTION_URL;
  const EVO_KEY      = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) {
    console.warn('[WA] Ni Twilio ni Evolution API están configurados');
    return { ok: false, error: 'WhatsApp no configurado (faltan variables de entorno)' };
  }
  const headers = { 'Content-Type': 'application/json', 'apikey': EVO_KEY };
  const baseUrl = EVO_URL.replace(/\/+$/, '');
  const url = `${baseUrl}/message/sendText/${EVO_INSTANCE}`;
  console.log(`[WA] Enviando a ${numero} (${enviados+1}/${WA_LIMITE_DIARIO} hoy)`);
  const payloads = [
    { number: numero, textMessage: { text: mensajeVariado } },
    { number: numero, text: mensajeVariado },
    { number: numero, options: { delay: 1200, presence: 'composing' }, textMessage: { text: mensajeVariado } },
  ];
  let lastErr = '';
  for (const body of payloads) {
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const rawText = await resp.text();
      let data = {};
      try { data = JSON.parse(rawText); } catch {}
      if (resp.ok) {
        console.log(`[WA] ✅ Enviado a ${numero} → key:${data?.key?.id||'ok'}`);
        return { ok: true, numero };
      }
      lastErr = rawText.slice(0, 300);
      console.warn(`[WA] Falló payload ${JSON.stringify(Object.keys(body))}: ${resp.status} → ${lastErr}`);
    } catch(e) {
      lastErr = e.message;
      console.error('[WA] Error fetch:', e.message);
    }
  }
  return { ok: false, error: `Evolution API: ${lastErr}`, numero };
}
// ── HELPER: mensaje de bienvenida QR ──────────────────────────────────────────
async function enviarBienvenidaQR(telefono, nombre, email, ci) {
  if (!telefono) return;
  const APP_URL = process.env.APP_URL || 'https://its-sistema-production.up.railway.app/';
  const tpl = getWASistemaTpl('bienvenida_qr');
  const msg = tpl
    .replace(/\{nombre\}/g, nombre||'')
    .replace(/\{email\}/g, email||'')
    .replace(/\{ci\}/g, ci||'(tu número de cédula)')
    .replace(/\{url\}/g, APP_URL);
  try {
    const { ok } = await sendWhatsApp(telefono, msg);
    const wid = 'wam_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?)`)
      .run(wid, 'bienvenida', 'alumno', nombre||'', telefono, msg, ok ? 'enviado' : 'fallido', 'sistema_auto');
    // Pausa 10–20 segundos para evitar detección de ráfaga por Meta
    await new Promise(r => setTimeout(r, 10000 + Math.random() * 10000));
  } catch(e) { console.error('[WA] enviarBienvenidaQR error:', e.message); }
}
// ── HELPER: hora actual en Paraguay (DST-aware) ───────────────────────────────
function pyNow() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' });
  return new Date(s);
}
// ── HELPER: verificar horario permitido (08:00 – 20:00 Paraguay, lunes a viernes) ─────────
function enHoraPermitida() {
  const py = pyNow();
  const h   = py.getHours();
  const dia = py.getDay(); // 0=domingo, 6=sábado
  if (dia === 0 || dia === 6) return false; // prohibido sábado y domingo
  return h >= 8 && h < 20;                 // sólo 08:00–19:59
}

function buildWaMsg(tplKey, vars) {
  const key = tplKey.replace('wa_tpl_', '');
  const tpl = db.prepare('SELECT valor FROM configuracion WHERE clave=?').get(tplKey)?.valor
    || WA_TPL_DEFAULTS[key]
    || '📋 *ITS Santísima Trinidad*\nRecordatorio: {tipo} de *{materia}*\n{carrera} {curso}\n📅 {fecha} 🕐 {hora}';
  return tpl
    .replace(/\{docente\}/g,    vars.docente    || '')
    .replace(/\{materia\}/g,    vars.materia    || '')
    .replace(/\{tipo\}/g,       vars.tipo       || '')
    .replace(/\{carrera\}/g,    vars.carrera    || '')
    .replace(/\{curso\}/g,      vars.curso      || '')
    .replace(/\{fecha\}/g,      vars.fecha      || '')
    .replace(/\{hora\}/g,       vars.hora       || '')
    .replace(/\{aula\}/g,       vars.aula       || '')
    .replace(/\{horas_rest\}/g, vars.horas_rest || '');
}

// ── HELPER: query de exámenes sin archivo ─────────────────────────────────────
const qExamenes = `
  SELECT e.id, e.tipo, e.fecha, e.hora, e.aula,
    m.nombre as materia, ca.nombre as carrera,
    cu.anio, cu.division,
    u.nombre as doc_nombre, u.apellido as doc_apellido,
    d.id as docente_id, d.telefono as doc_telefono
  FROM examenes e
  LEFT JOIN asignaciones a ON e.asignacion_id=a.id
  LEFT JOIN materias m ON a.materia_id=m.id
  LEFT JOIN cursos cu ON a.curso_id=cu.id
  LEFT JOIN carreras ca ON cu.carrera_id=ca.id
  LEFT JOIN docentes d ON a.docente_id=d.id
  LEFT JOIN usuarios u ON d.usuario_id=u.id
  WHERE e.fecha=?
    AND (e.archivo_nombre IS NULL OR e.archivo_nombre='')
    AND (d.wa_recordatorios_activo IS NULL OR d.wa_recordatorios_activo=1)`;

async function procesarIntervalos(intervalos, usarHora = false) {
  const hoy = new Date();
  let total = 0;
  for (const { horas, label } of intervalos) {
    const reglaRow = db.prepare("SELECT valor FROM configuracion WHERE clave=?").get(`wa_regla_${label}_activa`);
    if (reglaRow?.valor === '0') { console.log(`[WA] Regla ${label} desactivada — omitida`); continue; }
    const target = new Date(hoy.getTime() + horas * 60 * 60 * 1000);
    const fechaTarget = target.toISOString().split('T')[0];
    const examenes = db.prepare(qExamenes).all(fechaTarget);
    for (const ex of examenes) {
      // Para intervalos cortos verificar ventana de ±30 min con la hora del examen
      if (usarHora) {
        const horaEx = ex.hora || '19:00';
        const [hh, mm] = horaEx.split(':').map(Number);
        const exDateTime = new Date(`${fechaTarget}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`);
        const diffMin = (exDateTime.getTime() - hoy.getTime()) / 60000;
        const limInf = horas * 60 - 30;
        const limSup = horas * 60 + 30;
        if (diffMin < limInf || diffMin > limSup) continue;
      }
      const yaEnviado = db.prepare('SELECT 1 FROM notif_wa_enviadas WHERE examen_id=? AND intervalo=?').get(ex.id, label);
      if (yaEnviado) continue;
      if (!ex.doc_telefono) continue;
      const vars = examenVars(ex);
      const msg  = buildWaMsg(`wa_tpl_${label}`, vars);
      const {ok} = await sendWhatsApp(ex.doc_telefono, msg);
      const dest = `${ex.doc_apellido||''} ${ex.doc_nombre||''}`.trim();
      const wid  = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(wid, 'programado', 'docente', ex.docente_id||'', dest, ex.doc_telefono, msg, ok?'enviado':'fallido', 'sistema_auto');
      if (ok) {
        db.prepare('INSERT OR IGNORE INTO notif_wa_enviadas (examen_id,intervalo) VALUES (?,?)').run(ex.id, label);
        audit('sistema', 'NOTIFICACION_WA', 'examenes', ex.id, { intervalo: label, tel: ex.doc_telefono });
        total++;
      }
      // Delay anti-spam entre notificaciones automáticas
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    }
  }
  return total;
}

// ⏸ Pausado el 2026-07-20 — el número quedó restringido por WhatsApp/Meta para
// envío automatizado (mensajes se "envían" con key válida pero no se entregan;
// confirmado que el envío manual desde el mismo número sí funciona normal).
// Cambiar a false para reactivar todos los crons automáticos de WA a docentes,
// pero solo después de resolver la restricción (ver memoria del proyecto).
const WA_AUTO_PAUSADO = true;

// ── MIGRACIÓN: activar recordatorios de examen (48h/24h/12h/6h/4h/3h) y ──────
// desactivar los avisos de "archivo sin cargar" (aviso24/urgente) y "puntajes
// sin cargar" — Gabriel pidió solo los recordatorios de examen por ahora.
try {
  const yaAplicada = db.prepare("SELECT valor FROM configuracion WHERE clave='migracion_wa_reglas_examen_2026_07'").get();
  if (!yaAplicada) {
    const setRegla = db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)");
    ['48h','24h','12h','6h','4h','3h'].forEach(k => setRegla.run(`wa_regla_${k}_activa`, '1', `Regla WA ${k}`));
    ['aviso24','urgente','puntajes'].forEach(k => setRegla.run(`wa_regla_${k}_activa`, '0', `Regla WA ${k}`));
    setRegla.run('migracion_wa_reglas_examen_2026_07', '1', 'Migración: activar recordatorios de examen, desactivar avisos de carga/puntajes');
    console.log('[Migración] Reglas WA de examen activadas (48h/24h/12h/6h/4h/3h); avisos de carga/puntajes desactivados');
  }
} catch(e) { console.warn('[Migración] Reglas WA examen:', e.message); }

// ── CRON: Recordatorios 48h / 24h — corre a las 8:00 AM lunes a viernes ─────
cron.schedule('0 8 * * 1-5', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return;
  try {
    const total = await procesarIntervalos([
      { horas: 48, label: '48h' },
      { horas: 24, label: '24h' },
    ]);
    console.log(`✓ Cron WA 48h/24h: ${total} mensajes enviados`);
  } catch(e) { console.error('Cron 48/24h error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── CRON: Recordatorios 12h / 6h / 4h / 3h — corre cada hora ─────────────────
// Usa ventana ±30 min sobre la hora del examen para no perder ninguno.
// La tabla notif_wa_enviadas previene duplicados aunque el cron corra varias veces.
cron.schedule('0 * * * 1-5', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return;
  try {
    const total = await procesarIntervalos([
      { horas: 12, label: '12h' },
      { horas: 6,  label: '6h'  },
      { horas: 4,  label: '4h'  },
      { horas: 3,  label: '3h'  },
    ], true);
    if (total > 0) console.log(`✓ Cron WA 12h/6h/4h/3h: ${total} mensajes enviados`);
  } catch(e) { console.error('Cron 12/6/4/3h error:', e.message); }
}, { timezone: 'America/Asuncion' });


// ── CRON: Aviso 24h — carga de examen pendiente (7:00 AM diario) ─────────────
// Busca exámenes de MAÑANA sin archivo cargado, excluye doc_mareco, envía aviso.
const stmtExamSinArch = db.prepare(`
  SELECT e.id, e.fecha, e.hora, e.tipo as tipo_examen,
    m.nombre as materia_nombre,
    cu.anio as curso_anio, cu.division as curso_division,
    ca.nombre as carrera_nombre,
    d.id as docente_id, d.telefono,
    u.nombre as doc_nombre, u.apellido as doc_apellido
  FROM examenes e
  JOIN asignaciones a ON e.asignacion_id = a.id
  JOIN materias m ON a.materia_id = m.id
  JOIN cursos cu ON a.curso_id = cu.id
  JOIN carreras ca ON cu.carrera_id = ca.id
  JOIN docentes d ON a.docente_id = d.id
  JOIN usuarios u ON d.usuario_id = u.id
  WHERE e.fecha = ?
    AND (e.archivo_nombre IS NULL OR trim(e.archivo_nombre) = '')
    AND d.id != 'doc_mareco'
    AND u.activo = 1
    AND d.telefono IS NOT NULL AND trim(d.telefono) != ''
    AND (d.wa_recordatorios_activo IS NULL OR d.wa_recordatorios_activo = 1)
`);

cron.schedule('0 8 * * *', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return;
  const reglaAviso = db.prepare("SELECT valor FROM configuracion WHERE clave='wa_regla_aviso24_activa'").get();
  if (reglaAviso?.valor === '0') return;
  try {
    // Fecha de mañana en hora Paraguay (DST-aware)
    const pyHoy = pyNow();
    const manana = new Date(pyHoy.getTime() + 24 * 60 * 60 * 1000);
    const fechaManana = `${manana.getFullYear()}-${String(manana.getMonth()+1).padStart(2,'0')}-${String(manana.getDate()).padStart(2,'0')}`;
    const examenes = stmtExamSinArch.all(fechaManana);
    let enviados = 0;
    for (const ex of examenes) {
      // Evitar duplicado: solo un aviso '24h' por examen
      const ya = db.prepare(`SELECT id FROM wa_recordatorios_examen WHERE examen_id=? AND tipo='24h'`).get(ex.id);
      if (ya) continue;
      const curso = `${ex.curso_anio}° ${ex.curso_division === 'U' ? '' : ex.curso_division}`.trim();
      const vars24 = {
        docente:    `${ex.doc_apellido||''} ${ex.doc_nombre||''}`.trim(),
        materia:    ex.materia_nombre || '',
        tipo:       ex.tipo_examen    || '',
        carrera:    ex.carrera_nombre || '',
        curso,
        fecha:      '',
        hora:       ex.hora || 'a confirmar',
        aula:       '',
        horas_rest: '',
      };
      const msg = buildWaMsg('wa_tpl_aviso24', vars24);
      const {ok} = await sendWhatsApp(ex.telefono, msg);
      const rid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_recordatorios_examen (id,examen_id,docente_id,tipo,estado) VALUES (?,?,?,?,?)`).run(rid, ex.id, ex.docente_id, '24h', ok?'enviado':'fallido');
      const wid = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`).run(wid,'programado','docente',ex.docente_id,`${ex.doc_apellido}, ${ex.doc_nombre}`,ex.telefono,msg,ok?'enviado':'fallido','sistema_auto');
      if (ok) enviados++;
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    }
    if (enviados > 0) console.log(`[CRON 7AM] Avisos carga examen: ${enviados} enviados`);
  } catch(e) { console.error('[CRON 7AM] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── CRON: Recordatorio horario — carga pendiente ≤7h antes del examen ─────────
// Corre cada hora. Si el examen es hoy, en ≤7h, sin archivo → manda recordatorio.
// Sigue enviando hora a hora hasta que el docente cargue el archivo.
// Watchdog WhatsApp: reconecta automáticamente si se cae, y avisa al director en el
// sistema (no por WhatsApp, porque justamente eso es lo que puede estar caído) — antes
// esto era completamente silencioso (solo un console.log) y nadie se enteraba de una
// caída hasta que un mensaje fallaba o alguien entraba a revisar el panel a mano.
let _waWatchdogDownSince = null;
function _avisarDirectorWA(titulo, contenido, urgente) {
  try {
    const director = db.prepare("SELECT id FROM usuarios WHERE rol='director' AND activo=1 LIMIT 1").get();
    if (!director) return;
    const id = 'av_wa_' + Date.now();
    db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id,categoria) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, titulo, contenido, urgente ? 'urgente' : 'info', urgente ? 1 : 0, 'director', director.id, 'sistema');
  } catch(e) { console.error('[WA] Watchdog: error creando aviso:', e.message); }
}
cron.schedule('*/15 * * * *', async () => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return;
  try {
    const r = await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
    const d = await r.json().catch(() => ({}));
    const state = d?.instance?.state || d?.state || '';
    const caido = !!state && state !== 'open';
    if (caido) {
      console.log('[WA] Watchdog: estado', state, '— reconectando...');
      await fetch(`${EVO_URL}/instance/connect/${EVO_INSTANCE}`, { method: 'GET', headers: { apikey: EVO_KEY } });
      const ahora = Date.now();
      // Avisar UNA sola vez por caída (no repetir cada 2h) — el estado en vivo lo
      // muestra el indicador fijo con borde animado en la barra superior mientras
      // dure la desconexión, así no se acumulan avisos repetidos en la bandeja.
      if (!_waWatchdogDownSince) {
        _waWatchdogDownSince = ahora;
        _avisarDirectorWA(
          '⚠️ WhatsApp desconectado',
          `El sistema detectó que la conexión de WhatsApp está caída (estado: "${state}"). Se intentó reconectar automáticamente. Si sigue sin funcionar, entrá al panel de WhatsApp y volvé a escanear el código QR.`,
          true
        );
      }
    } else if (_waWatchdogDownSince) {
      // Se recuperó sola tras haber estado caída
      const minCaido = Math.round((Date.now() - _waWatchdogDownSince) / 60000);
      _avisarDirectorWA('✅ WhatsApp reconectado', `La conexión de WhatsApp se restableció automáticamente (estuvo caída ~${minCaido} min).`, false);
      _waWatchdogDownSince = null;
    }
  } catch(e) { /* silencioso */ }
});

// ── Estado en vivo del watchdog (liviano, no golpea la API de Evolution) ─────
// Lo usa el indicador fijo con borde animado en la barra superior — se puede
// consultar cada 60s sin generar carga externa, a diferencia de /whatsapp/estado.
app.get('/api/whatsapp/watchdog-estado', auth(ADM), (req, res) => {
  res.json({
    caido: !!_waWatchdogDownSince,
    desde: _waWatchdogDownSince ? new Date(_waWatchdogDownSince).toISOString() : null,
  });
});

cron.schedule('0 * * * *', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return;
  const reglaUrg = db.prepare("SELECT valor FROM configuracion WHERE clave='wa_regla_urgente_activa'").get();
  if (reglaUrg?.valor === '0') return;
  try {
    const ahora = new Date();
    // Hora actual en Paraguay (DST-aware)
    const py = pyNow();
    const yy = py.getFullYear();
    const mo = String(py.getMonth()+1).padStart(2,'0');
    const dd = String(py.getDate()).padStart(2,'0');
    const hoy = `${yy}-${mo}-${dd}`;
    const examenes = stmtExamSinArch.all(hoy);
    let enviados = 0;
    for (const ex of examenes) {
      if (!ex.hora) continue;
      const [hh, mm] = ex.hora.split(':').map(Number);
      // Diferencia en horas usando minutos Paraguay puros
      const examMin = hh * 60 + (mm || 0);
      const nowMin  = py.getHours() * 60 + py.getMinutes();
      const diffH   = (examMin - nowMin) / 60;
      if (diffH <= 0 || diffH > 3) continue; // Solo si faltan ≤3 h y no pasó
      // Evitar enviar más de una vez por hora para el mismo examen
      const hace70min = new Date(ahora.getTime() - 70 * 60 * 1000).toISOString().replace('T',' ').slice(0,19);
      const yaEnviadoHora = db.prepare(`SELECT id FROM wa_recordatorios_examen WHERE examen_id=? AND tipo='horario' AND fecha>=?`).get(ex.id, hace70min);
      if (yaEnviadoHora) continue;
      const hRest = Math.ceil(diffH);
      const curso = `${ex.curso_anio}° ${ex.curso_division === 'U' ? '' : ex.curso_division}`.trim();
      const vars = {
        docente:    `${ex.doc_apellido||''} ${ex.doc_nombre||''}`.trim(),
        materia:    ex.materia_nombre || '',
        tipo:       ex.tipo_examen    || '',
        carrera:    ex.carrera_nombre || '',
        curso,
        fecha:      ex.fecha ? new Date(ex.fecha+'T12:00:00').toLocaleDateString('es-PY',{weekday:'long',day:'numeric',month:'long'}) : '',
        hora:       ex.hora  || '',
        aula:       '',
        horas_rest: `${hRest} hora${hRest !== 1 ? 's' : ''}`,
      };
      const msg = buildWaMsg('wa_tpl_urgente', vars);
      const {ok} = await sendWhatsApp(ex.telefono, msg);
      const rid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_recordatorios_examen (id,examen_id,docente_id,tipo,estado) VALUES (?,?,?,?,?)`).run(rid, ex.id, ex.docente_id, 'horario', ok?'enviado':'fallido');
      const wid = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`).run(wid,'programado','docente',ex.docente_id,`${ex.doc_apellido}, ${ex.doc_nombre}`,ex.telefono,msg,ok?'enviado':'fallido','sistema_auto');
      if (ok) enviados++;
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    }
    if (enviados > 0) console.log(`[CRON HORARIO] Recordatorios carga: ${enviados} enviados`);
  } catch(e) { console.error('[CRON HORARIO] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── Función compartida: enviar avisos de puntajes pendientes ──────────────────
async function enviarAvisosPuntajesPendientes(forzar = false) {
  const py  = pyNow();
  const hoy = `${py.getFullYear()}-${String(py.getMonth()+1).padStart(2,'0')}-${String(py.getDate()).padStart(2,'0')}`;
  const limite = new Date(py.getTime() - 8 * 24 * 60 * 60 * 1000);
  const flStr  = `${limite.getFullYear()}-${String(limite.getMonth()+1).padStart(2,'0')}-${String(limite.getDate()).padStart(2,'0')}`;

  const exams = db.prepare(`
    SELECT e.id, e.tipo, e.fecha, e.asignacion_id,
      m.nombre  AS materia_nombre,
      ca.nombre AS carrera_nombre,
      cu.anio   AS curso_anio, cu.division AS curso_division, cu.id AS curso_id,
      u.nombre  AS doc_nombre, u.apellido AS doc_apellido,
      d.id      AS docente_id, d.telefono
    FROM examenes e
    JOIN asignaciones a ON e.asignacion_id = a.id
    JOIN materias m     ON a.materia_id    = m.id
    JOIN cursos cu      ON a.curso_id      = cu.id
    JOIN carreras ca    ON cu.carrera_id   = ca.id
    JOIN docentes d     ON a.docente_id    = d.id
    JOIN usuarios u     ON d.usuario_id    = u.id
    WHERE e.fecha <= ?
      AND u.activo = 1
      AND d.id != 'doc_mareco'
      AND d.telefono IS NOT NULL AND trim(d.telefono) != ''
      AND (d.wa_recordatorios_activo IS NULL OR d.wa_recordatorios_activo = 1)
    ORDER BY d.id, ca.nombre, cu.anio, m.nombre
  `).all(flStr);

  const porDocente = {};
  for (const ex of exams) {
    const col = EXAMEN_NOTA_COL[ex.tipo];
    if (!col) continue;
    const cargados = db.prepare(`SELECT COUNT(*) as n FROM notas n2 WHERE n2.asignacion_id=? AND n2.${col} IS NOT NULL`).get(ex.asignacion_id)?.n || 0;
    if (cargados > 0) continue;
    if (!porDocente[ex.docente_id]) porDocente[ex.docente_id] = { info: ex, materias: [] };
    const dias = Math.floor((new Date(hoy) - new Date(ex.fecha)) / (1000 * 60 * 60 * 24));
    const curso = `${ex.curso_anio}° ${ex.curso_division === 'U' ? '' : ex.curso_division}`.trim();
    porDocente[ex.docente_id].materias.push({ materia: ex.materia_nombre, tipo: ex.tipo, carrera: ex.carrera_nombre, curso, dias, examen_id: ex.id });
  }

  let enviados = 0; let omitidos = 0;
  for (const [docente_id, { info, materias }] of Object.entries(porDocente)) {
    if (!forzar) {
      const yaHoy = db.prepare(`SELECT id FROM wa_recordatorios_examen WHERE docente_id=? AND tipo='puntajes' AND substr(fecha,1,10)=?`).get(docente_id, hoy);
      if (yaHoy) { omitidos++; continue; }
    }
    const docNombre = `${info.doc_apellido || ''} ${info.doc_nombre || ''}`.trim();
    const listaMaterias = materias.map((m, i) =>
      `${i + 1}. *${m.materia}* (${m.tipo}) — ${m.carrera} ${m.curso} _(hace ${m.dias} días)_`
    ).join('\n');
    let msg;
    if (materias.length === 1) {
      const m = materias[0];
      msg = `⚠️ *Aviso Institucional — Carga de Puntajes Pendiente*\n\nProf. ${docNombre}:\n\nEl *${m.tipo}* de *${m.materia}* (${m.carrera} — ${m.curso}) se realizó hace *${m.dias} días* y a la fecha *no figura ningún puntaje registrado* en el sistema.\n\nLa institución requiere que los puntajes sean cargados con la mayor brevedad posible. Los alumnos no pueden acceder a sus calificaciones hasta que esto sea completado.\n\n*Ingrese al portal institucional y regularice la situación a la brevedad.*\n\n_Dirección Académica — ITS Santísima Trinidad._`;
    } else {
      msg = `⚠️ *Aviso Institucional — Carga de Puntajes Pendiente*\n\nProf. ${docNombre}:\n\nSe registran *${materias.length} materias* con puntajes sin cargar en el sistema:\n\n${listaMaterias}\n\nLa institución requiere que todos los puntajes sean cargados con la mayor brevedad posible. Los alumnos no pueden acceder a sus calificaciones hasta que esto sea completado.\n\n*Ingrese al portal institucional y regularice la situación a la brevedad.*\n\n_Dirección Académica — ITS Santísima Trinidad._`;
    }
    const { ok } = await sendWhatsApp(info.telefono, msg);
    for (const m of materias) {
      const rid = 'war_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
      db.prepare(`INSERT INTO wa_recordatorios_examen (id,examen_id,docente_id,tipo,estado) VALUES (?,?,?,?,?)`).run(rid, m.examen_id, docente_id, 'puntajes', ok ? 'enviado' : 'fallido');
    }
    const wid = 'wam_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(wid, 'programado', 'docente', docente_id, `${info.doc_apellido}, ${info.doc_nombre}`, info.telefono, msg, ok ? 'enviado' : 'fallido', 'sistema_auto');
    if (ok) enviados++;
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
  }
  return { enviados, omitidos, total: Object.keys(porDocente).length };
}

// ── CRON: Aviso diario — puntajes sin cargar ≥8 días (9:00 AM lun-vie) ───────
cron.schedule('0 9 * * 1-5', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return;
  const regla = db.prepare("SELECT valor FROM configuracion WHERE clave='wa_regla_puntajes_activa'").get();
  if (regla?.valor === '0') return;
  try {
    const r = await enviarAvisosPuntajesPendientes();
    console.log(`[CRON 9AM PUNTAJES] Enviados: ${r.enviados}, omitidos: ${r.omitidos}`);
  } catch (e) { console.error('[CRON 9AM PUNTAJES] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── Endpoint: disparar avisos puntajes manualmente ────────────────────────────
app.post('/api/whatsapp/avisos-puntajes', auth(ADM), async (req, res) => {
  try {
    const result = await enviarAvisosPuntajesPendientes();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── WHATSAPP: envío manual para un examen ─────────────────────────────────────
app.post('/api/examenes/:id/whatsapp', auth(ADM), async (req, res) => {
  const ex = db.prepare(`
    SELECT e.id, e.tipo, e.fecha, e.hora, e.aula,
      m.nombre as materia, ca.nombre as carrera,
      cu.anio, cu.division,
      u.nombre as doc_nombre, u.apellido as doc_apellido,
      d.telefono as doc_telefono
    FROM examenes e
    LEFT JOIN asignaciones a ON e.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    LEFT JOIN docentes d ON a.docente_id=d.id
    LEFT JOIN usuarios u ON d.usuario_id=u.id
    WHERE e.id=?`).get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Examen no encontrado' });
  if (!ex.doc_telefono) return res.status(400).json({ error: 'El docente no tiene teléfono registrado' });
  const vars = examenVars(ex);
  const msg  = buildWaMsg('wa_tpl_24h', vars);
  const {ok} = await sendWhatsApp(ex.doc_telefono, msg);
  if (!ok) return res.status(500).json({ error: 'No se pudo enviar. WhatsApp no está conectado — vinculá el dispositivo en la sección WhatsApp.' });
  audit(req.user.id, 'WHATSAPP_MANUAL', 'examenes', ex.id, { tel: ex.doc_telefono });
  res.json({ ok: true, tel: normalizarTelefono(ex.doc_telefono) });
});

// ── WHATSAPP: reglas automáticas (listar / editar / activar-desactivar) ────────
const WA_REGLAS_DEF = [
  { key:'72h',     label:'72 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'48h',     label:'48 horas antes del examen',   cron:'8:00 AM — lun a vie', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'36h',     label:'36 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'24h',     label:'24 horas antes del examen',   cron:'8:00 AM — lun a vie', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'12h',     label:'12 horas antes del examen',   cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'6h',      label:'6 horas antes del examen',    cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'4h',      label:'4 horas antes del examen',    cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'3h',      label:'3 horas antes del examen',    cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'aviso24',   label:'Aviso: archivo pendiente 24h',  cron:'7:00 AM — diario',   tipo:'carga',        defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'urgente',   label:'Urgente: sin archivo ≤7h',      cron:'Cada hora',           tipo:'carga',        defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora} {horas_rest}' },
  { key:'puntajes',  label:'Aviso: puntajes sin cargar ≥8d',cron:'9:00 AM — lun a vie', tipo:'notas',        defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {dias}' },
];
const WA_TPL_DEFAULTS = {
  '72h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '48h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '36h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '24h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '12h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue lo antes posible desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '6h':     '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '4h':     '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '3h':     '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias por su comprensión!\n_Administración — ITS Santísima Trinidad._',
  'aviso24':'📋 *Aviso Institucional — Carga de Examen Pendiente*\n\nEstimado/a Prof. {docente}, le informamos que *mañana* tiene examen programado:\n\n📚 *{materia}* ({tipo})\n🎓 {carrera} — {curso}\n🕐 Hora: {hora}\n\nLa institución solicita la carga del archivo del examen con *24 horas de anticipación*.\n\nPor favor, *cargue el archivo lo más pronto posible* ingresando al sistema.\n\n¡Muchas gracias!\n\n_Mensaje automático — Sistema de Gestión ITS._',
  'urgente':  '⏰ *Recordatorio Urgente — Archivo de Examen Sin Cargar*\n\nEstimado/a Prof. {docente}:\n\nSu examen de *{materia}* ({tipo}) está programado en *{horas_rest}* y aún no se registra el archivo.\n\n🎓 {carrera} — {curso}\n🕐 Hora programada: {hora}\n\nPor favor, *cargue el archivo lo más pronto posible*.\n\n¡Muchas gracias!\n\n_Mensaje automático — Sistema de Gestión ITS._',
  'puntajes': '📊 *Aviso — Puntajes Sin Cargar*\n\nEstimado/a Prof. {docente}, le informamos que el *{tipo}* de *{materia}* ({carrera} — {curso}) fue evaluado hace *{dias} días* y aún *no se registró ningún puntaje* en el sistema.\n\nLos alumnos están a la espera de visualizar sus resultados a través del sistema académico institucional.\n\nPor favor, ingrese al portal y cargue los puntajes a la brevedad para que los estudiantes puedan acceder a sus calificaciones.\n\n¡Muchas gracias por su colaboración!\n\n_Mensaje automático — Sistema de Gestión ITS Santísima Trinidad._',
};
// ── PLANTILLAS DEL SISTEMA (bienvenida QR, constancia pago) ───────────────
const WA_SISTEMA_DEFAULTS = {
  bienvenida_qr: `🎓 *Instituto Técnico Superior Santísima Trinidad*\n\n¡Bienvenido/a, *{nombre}*! 🙌\n\nNos alegra tenerte como alumno/a y que seas parte de esta nueva etapa de evolución digital de nuestra institución. Esta innovación fue pensada para tu comodidad, para que puedas acceder a tu información académica en cualquier momento y desde cualquier lugar.\n\nA partir de ahora podés consultar tus notas, asistencia y estado de cuenta cuando lo necesites.\n\n📋 *Tus datos de acceso:*\n• Usuario: {email}\n• Contraseña: {ci}\n\n🔗 *Acceder al sistema:*\n{url}\n\n💡 _Te recomendamos guardar este mensaje para futuras consultas._\n\n— *Dirección Académica · ITS Santísima Trinidad*`,
  constancia_pago: `🎓 *Instituto Técnico Superior Santísima Trinidad*\n\n📄 *Constancia de Pago*\n\nHola, *{nombre}*. Te confirmamos que recibimos tu pago exitosamente.\n\n💳 *Detalle:*\n• Concepto: {concepto}{materia}\n• Monto: {monto}\n• Fecha: {fecha}\n\n✅ Tu pago quedó registrado en el sistema. Podés verificarlo ingresando a tu cuenta.\n\n🔗 {url}\n\n— *Administración · ITS Santísima Trinidad*`,
};
function getWASistemaTpl(clave) {
  const row = db.prepare("SELECT valor FROM configuracion WHERE clave=?").get('wa_sis_'+clave);
  return row?.valor || WA_SISTEMA_DEFAULTS[clave] || '';
}
app.get('/api/whatsapp/reglas', auth(ADM), (req, res) => {
  const reglas = WA_REGLAS_DEF.map(r => {
    const actRow = db.prepare("SELECT valor FROM configuracion WHERE clave=?").get(`wa_regla_${r.key}_activa`);
    const tplRow = db.prepare("SELECT valor FROM configuracion WHERE clave=?").get(`wa_tpl_${r.key}`);
    return { ...r, activa: actRow ? actRow.valor !== '0' : (r.defaultActiva !== false), template: tplRow?.valor || WA_TPL_DEFAULTS[r.key] || '' };
  });
  res.json(reglas);
});
app.post('/api/whatsapp/reglas/:key', auth(ADM), (req, res) => {
  const { key } = req.params;
  const { activa, template } = req.body;
  if (!WA_REGLAS_DEF.find(r => r.key === key)) return res.status(400).json({ error: 'Regla inválida' });
  if (activa !== undefined)
    db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)").run(`wa_regla_${key}_activa`, activa ? '1' : '0', `Regla WA ${key}`);
  if (template !== undefined)
    db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)").run(`wa_tpl_${key}`, template, `Plantilla WA ${key}`);
  audit(req.user.id, 'EDIT_WA_REGLA', 'configuracion', key, { activa, tpl_len: template?.length });
  res.json({ ok: true });
});
// ── WHATSAPP: plantillas legacy ────────────────────────────────────────────────
app.get('/api/whatsapp/plantillas', auth(ADM), (req, res) => {
  const claves = ['wa_tpl_72h','wa_tpl_48h','wa_tpl_24h','wa_tpl_12h','wa_tpl_6h','wa_tpl_3h'];
  const rows = claves.map(c => db.prepare('SELECT clave,valor,descripcion FROM configuracion WHERE clave=?').get(c)).filter(Boolean);
  res.json(rows);
});
app.put('/api/whatsapp/plantillas/:clave', auth(ADM), (req, res) => {
  const { valor } = req.body;
  if (!valor) return res.status(400).json({ error: 'Falta el texto de la plantilla' });
  db.prepare('UPDATE configuracion SET valor=? WHERE clave=?').run(valor, req.params.clave);
  res.json({ ok: true });
});
// ── WHATSAPP: plantillas del sistema (bienvenida QR, constancia pago) ──────
app.get('/api/whatsapp/plantillas-sistema', auth(ADM), (req, res) => {
  const claves = ['bienvenida_qr','constancia_pago'];
  const result = claves.map(c => ({
    clave: c,
    valor: getWASistemaTpl(c),
    default: WA_SISTEMA_DEFAULTS[c] || '',
  }));
  res.json(result);
});
app.put('/api/whatsapp/plantillas-sistema/:clave', auth(ADM), (req, res) => {
  const { clave } = req.params;
  const { valor } = req.body;
  if (!['bienvenida_qr','constancia_pago'].includes(clave)) return res.status(400).json({ error: 'Plantilla inválida' });
  if (!valor) return res.status(400).json({ error: 'Falta el texto' });
  if (valor === '__default__') {
    db.prepare("DELETE FROM configuracion WHERE clave=?").run('wa_sis_'+clave);
  } else {
    db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES (?,?,?)").run('wa_sis_'+clave, valor, 'Plantilla sistema WA '+clave);
  }
  audit(req.user.id,'EDIT_WA_PLANTILLA','configuracion',clave,{len:valor.length});
  res.json({ ok: true });
});

// ── DIAGNÓSTICO Y RECONFIGURACIÓN DEL WEBHOOK ────────────────────────────────
app.get('/api/whatsapp/webhook-diagnostico', auth(ADM), async (req, res) => {
  const EVO_URL  = process.env.EVOLUTION_URL;
  const EVO_KEY  = process.env.EVOLUTION_KEY;
  const EVO_INST = process.env.EVOLUTION_INSTANCE;
  const APP_URL  = process.env.APP_URL || 'https://its-sistema-production.up.railway.app';
  const webhookUrl = `${APP_URL}/webhook/whatsapp`;

  const resultado = { webhookUrl, configEnv: { EVO_URL: !!EVO_URL, EVO_KEY: !!EVO_KEY, EVO_INST: !!EVO_INST, APP_URL } };

  if (!EVO_URL || !EVO_KEY || !EVO_INST) {
    return res.json({ ...resultado, error: 'Variables de entorno faltantes' });
  }

  // 1. Ver config actual del webhook en Evolution API
  try {
    const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/webhook/find/${EVO_INST}`, {
      headers: { apikey: EVO_KEY }, signal: AbortSignal.timeout(6000)
    });
    resultado.webhookActual = await r.json();
  } catch(e) { resultado.webhookActual = { error: e.message }; }

  // 2. Reconfigurar webhook (si se pasa ?reconfigurar=1)
  if (req.query.reconfigurar === '1') {
    const body = { url: webhookUrl, webhook_by_events: false, webhook_base64: true, events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','MESSAGES_DELETE','SEND_MESSAGE','CONNECTION_UPDATE','CONTACTS_UPSERT'] };
    // Intentar con POST primero, luego PUT si falla
    for (const method of ['POST','PUT']) {
      try {
        const r2 = await fetch(`${EVO_URL.replace(/\/+$/,'')}/webhook/set/${EVO_INST}`, {
          method,
          headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000)
        });
        const txt = await r2.text();
        let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
        resultado.reconfiguracion = { method, status: r2.status, ok: r2.ok, response: json };
        if (r2.ok) break; // si salió bien, no hace falta intentar el otro método
      } catch(e) { resultado.reconfiguracion = { method, error: e.message }; }
    }
  }

  // 3. Últimos mensajes recibidos en wa_recibidos
  resultado.ultimosRecibidos = db.prepare('SELECT numero,nombre_contacto,mensaje,fecha FROM wa_recibidos ORDER BY fecha DESC LIMIT 5').all();
  resultado.totalRecibidos   = db.prepare('SELECT COUNT(*) as n FROM wa_recibidos').get().n;

  res.json(resultado);
});

// Endpoint de prueba: simula recibir un mensaje (para testear el bot sin WhatsApp)
// Si numero contiene @ se usa tal cual como remoteJid; si no, se le agrega @s.whatsapp.net
app.post('/api/whatsapp/webhook-test', auth(ADM), (req, res) => {
  const { numero, texto, nombre } = req.body;
  if (!numero || !texto) return res.status(400).json({ error: 'numero y texto requeridos' });
  const remoteJid = numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
  const fakeReq = { body: { event: 'messages.upsert', data: { key: { remoteJid, fromMe: false }, message: { conversation: texto }, pushName: nombre||'Test' } } };
  const fakeRes = { json: ()=>{} };
  manejarWebhookWA(fakeReq, fakeRes);
  res.json({ ok: true, mensaje: `Procesado: "${texto}" de ${remoteJid}` });
});

// Endpoint: ver últimos mensajes enviados por el bot
app.get('/api/whatsapp/mensajes-bot', auth(ADM), (req, res) => {
  const msgs = db.prepare('SELECT * FROM wa_mensajes ORDER BY fecha DESC LIMIT 20').all();
  res.json(msgs);
});
// Endpoint: log del bot (flujo completo de procesamiento)
app.get('/api/whatsapp/bot-log', auth(ADM), (req, res) => {
  const { numero, limit: lim = 300 } = req.query;
  if (numero) {
    // Buscar en múltiples formatos: con 595, sin 595, con 0, @lid parcial
    const n = String(numero).replace(/\D/g,'');
    const sin595 = n.replace(/^595/,'');
    const con595 = '595' + sin595;
    const con0   = '0'   + sin595;
    const rows = db.prepare(`
      SELECT * FROM wa_bot_log
      WHERE numero LIKE ? OR numero LIKE ? OR numero LIKE ? OR numero LIKE ?
      ORDER BY fecha DESC LIMIT ?
    `).all('%'+n+'%', '%'+sin595+'%', '%'+con595+'%', '%'+con0+'%', parseInt(lim)||300);
    return res.json(rows);
  }
  const rows = db.prepare('SELECT * FROM wa_bot_log ORDER BY fecha DESC LIMIT ?').all(parseInt(lim)||300);
  res.json(rows);
});
app.get('/api/whatsapp/analisis-errores', auth(ADM), (req, res) => {
  const MSG_ERR = '%no podemos procesar%';
  const afectados = db.prepare(`
    SELECT destinatario_telefono as numero, destinatario_nombre as nombre,
           MIN(fecha) as primer_error, MAX(fecha) as ultimo_error, COUNT(*) as errores
    FROM wa_mensajes WHERE mensaje LIKE ? GROUP BY destinatario_telefono ORDER BY ultimo_error DESC
  `).all(MSG_ERR);
  const mensajesAfectados = db.prepare(`SELECT COUNT(*) as n FROM wa_mensajes WHERE mensaje LIKE ?`).get(MSG_ERR).n;

  // Para cada número afectado, buscar sus mensajes en el bot log (recibidos + errores)
  for (const a of afectados) {
    a.log = db.prepare(`
      SELECT evento, detalle, fecha FROM wa_bot_log
      WHERE numero=? ORDER BY fecha ASC
    `).all(a.numero);
    // Verificar si volvió a escribir DESPUÉS del último error
    const msgDespues = db.prepare(`
      SELECT detalle, fecha FROM wa_bot_log
      WHERE numero=? AND evento='recibido' AND fecha > ?
      ORDER BY fecha ASC LIMIT 5
    `).all(a.numero, a.ultimo_error);
    a.volvio_a_escribir = msgDespues.length > 0;
    a.mensajes_post_error = msgDespues;
  }
  res.json({ afectados, mensajesAfectados });
});
app.delete('/api/whatsapp/bot-log', auth(ADM), (req, res) => {
  db.prepare('DELETE FROM wa_bot_log').run();
  res.json({ ok: true });
});
app.post('/api/whatsapp/enviar-test', auth(ADM), async (req, res) => {
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ error: 'numero y texto requeridos' });
  try {
    await enviarWA(numero, texto, 'bot');
    const ultimo = db.prepare("SELECT * FROM wa_mensajes ORDER BY fecha DESC LIMIT 1").get();
    res.json({ ok: true, ultimo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Estado del bot
app.get('/api/whatsapp/bot/estado', auth(ADM), (req, res) => {
  const hace24h = new Date(Date.now() - 24*60*60*1000).toISOString().replace('T',' ').slice(0,19);
  const recibidos24h   = db.prepare("SELECT COUNT(*) as n FROM wa_recibidos WHERE fecha >= ?").get(hace24h)?.n || 0;
  const respondidos24h = db.prepare("SELECT COUNT(DISTINCT destinatario_telefono) as n FROM wa_mensajes WHERE estado='enviado' AND fecha >= ?").get(hace24h)?.n || 0;
  const fallidos24h    = db.prepare("SELECT COUNT(*) as n FROM wa_mensajes WHERE estado='fallido' AND fecha >= ?").get(hace24h)?.n || 0;
  const ultimoError    = db.prepare("SELECT detalle, fecha FROM wa_bot_log WHERE evento IN ('gemini_error','envio_fallido','envio_error') ORDER BY fecha DESC LIMIT 1").get();
  res.json({
    pausado: _botPausado,
    geminiConfigurado: !!process.env.GEMINI_API_KEY,
    evolutionConfigurado: !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_KEY && process.env.EVOLUTION_INSTANCE),
    recibidos24h, respondidos24h, fallidos24h,
    ultimoError: ultimoError || null
  });
});

// Limpiar registros de bot (bot_log y wa_mensajes/recibidos antiguos)
app.delete('/api/whatsapp/limpiar', auth(ADM), (req, res) => {
  const { dias = 30 } = req.query;
  const corte = new Date(Date.now() - parseInt(dias)*24*60*60*1000).toISOString().replace('T',' ').slice(0,19);
  try {
    const log    = db.prepare("DELETE FROM wa_bot_log WHERE fecha < ?").run(corte);
    const msgs   = db.prepare("DELETE FROM wa_mensajes WHERE fecha < ? AND tipo='individual'").run(corte);
    const recib  = db.prepare("DELETE FROM wa_recibidos WHERE fecha < ?").run(corte);
    audit(req.user.id,'WA_LIMPIAR','sistema','limpiar',{dias,log:log.changes,msgs:msgs.changes,recib:recib.changes});
    res.json({ ok: true, log: log.changes, msgs: msgs.changes, recib: recib.changes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/whatsapp/bot/pausar', auth(ADM), (req, res) => {
  _botPausado = true;
  try { db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES ('bot_pausado','1','Bot de WhatsApp pausado')").run(); } catch {}
  audit(req.user.id, 'BOT_PAUSAR', 'sistema', 'bot', {});
  res.json({ ok: true, pausado: true });
});
app.post('/api/whatsapp/bot/reanudar', auth(ADM), (req, res) => {
  _botPausado = false;
  try { db.prepare("INSERT OR REPLACE INTO configuracion (clave,valor,descripcion) VALUES ('bot_pausado','0','Bot de WhatsApp pausado')").run(); } catch {}
  audit(req.user.id, 'BOT_REANUDAR', 'sistema', 'bot', {});
  res.json({ ok: true, pausado: false });
});

// Endpoint: test directo de Gemini (verifica que la API key funciona)
app.post('/api/whatsapp/bot/test-completo', auth(ADM), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.json({ ok: false, error: 'GEMINI_API_KEY no configurada' });
  const sp = _botSystemPrompt(null);
  // Conversación 1: interesado nuevo — flujo completo de admisiones
  const conv1 = [
    { id: 'saludo',        msg: 'Buen día, quería saber información sobre las carreras que tienen' },
    { id: 'carrera',       msg: 'Me interesa Cosmiatra, cuánto sale por mes y qué documentos necesito?' },
    { id: 'horarios',      msg: 'Y en qué horarios son las clases? puedo inscribirme ahora o tengo que esperar?' },
    { id: 'nombre_link',   msg: 'Soy María López, me pueden mandar el link para inscribirme?' },
    { id: 'matricula',     msg: 'La matrícula tiene costo extra o está incluida en la cuota?' },
  ];
  // Conversación 2: nueva conversación independiente — otros escenarios
  const conv2 = [
    { id: 'es_bot',        msg: 'Sos una persona real o un bot?' },
    { id: 'precio_2anio',  msg: 'Cuánto cuesta el 2do año de Enfermería?' },
    { id: 'duracion',      msg: 'Cuántos años dura la carrera de Técnico en Contabilidad?' },
    { id: 'msg_corto',     msg: 'hola' },
    { id: 'alumno_activo', msg: 'Buen día, soy alumno del instituto y no puedo entrar a la plataforma, mi CI es 4567890' },
  ];
  const casos = [...conv1, ...conv2];
  const SEPARADORES = { saludo: 'conv1', es_bot: 'conv2' };
  const resultados = [];
  let historial = [];
  for (const c of casos) {
    if (SEPARADORES[c.id]) historial = []; // nueva conversación independiente
    const t0 = Date.now();
    try {
      const resp = await geminiChat(sp, historial, c.msg);
      const ms = Date.now() - t0;
      const { limpio, interesado } = _botExtraerEtiquetas(resp);
      resultados.push({
        id: c.id, msg: c.msg, respuesta: limpio, ms, ok: true,
        largo: limpio.length,
        conv: SEPARADORES[c.id] || null,
        interesado_detectado: !!interesado
      });
      historial.push({ role: 'user', texto: c.msg }, { role: 'model', texto: limpio });
      if (historial.length > 16) historial = historial.slice(-16);
    } catch(e) {
      resultados.push({ id: c.id, msg: c.msg, error: e.message, ms: Date.now()-t0, ok: false, conv: SEPARADORES[c.id]||null });
    }
  }
  res.json({ ok: resultados.filter(r=>!r.ok).length === 0, resultados });
});
app.post('/api/whatsapp/bot/test-gemini', auth(ADM), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.json({ ok: false, error: 'GEMINI_API_KEY no está configurada en las variables de entorno de Railway.' });
  try {
    const respuesta = await geminiChat(
      'Eres un asistente de prueba. Respondé siempre con exactamente: "✅ Gemini funcionando correctamente."',
      [],
      'ping'
    );
    res.json({ ok: true, respuesta });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Endpoint: test de envío directo del bot (mismo código que enviar() interno)
app.post('/api/whatsapp/bot-send-test', auth(ADM), async (req, res) => {
  const { numero, mensaje } = req.body;
  const EVO_URL  = process.env.EVOLUTION_URL;
  const EVO_KEY  = process.env.EVOLUTION_KEY;
  const EVO_INST = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INST) return res.json({ ok: false, error: 'Faltan variables EVOLUTION_URL / EVOLUTION_KEY / EVOLUTION_INSTANCE' });
  if (!numero || !mensaje) return res.status(400).json({ error: 'numero y mensaje requeridos' });
  const numNormalizado = normalizarTelefono(numero) || numero;
  try {
    const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/message/sendText/${EVO_INST}`, {
      method: 'POST',
      headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: numNormalizado, textMessage: { text: mensaje } }),
      signal: AbortSignal.timeout(8000)
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    res.json({ ok: r.ok, status: r.status, response: json, numero_original: numero, numero_usado: numNormalizado, instancia: EVO_INST });
  } catch(e) {
    res.json({ ok: false, error: e.message, numero_usado: numero, instancia: EVO_INST });
  }
});

// ── WHATSAPP GESTIÓN: estado de conexión ──────────────────────────────────────
app.get('/api/whatsapp/estado', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.json({ configurado: false, estado: 'no_configurado' });
  try {
    const r = await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
    const d = await r.json().catch(()=>({}));
    const enviados_hoy = waMensajesHoy();
    res.json({
      configurado: true,
      estado: d?.instance?.state || d?.state || 'desconocido',
      raw: d,
      enviados_hoy,
      limite_diario: WA_LIMITE_DIARIO,
    });
  } catch(e) { res.json({ configurado: true, estado: 'error', mensaje: e.message }); }
});

// ── WHATSAPP: listar grupos disponibles ───────────────────────────────────────
app.get('/api/whatsapp/grupos', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.status(500).json({ error: 'Evolution API no configurada' });
  try {
    const r = await fetch(`${EVO_URL}/group/fetchAllGroups/${EVO_INSTANCE}?getParticipants=false`, { headers: { apikey: EVO_KEY } });
    const data = await r.json().catch(()=>[]);
    res.json({ raw: data, http_status: r.status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP DIAGNÓSTICO: prueba de envío con detalle de error ────────────────
app.post('/api/whatsapp/test-envio', auth(ADM), async (req, res) => {
  const { telefono } = req.body;
  const EVO_URL      = process.env.EVOLUTION_URL;
  const EVO_KEY      = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  const numero = normalizarTelefono(telefono || '0991000000');
  const info = { EVO_URL: EVO_URL||'(no configurado)', EVO_INSTANCE: EVO_INSTANCE||'(no configurado)', numero_normalizado: numero };
  try {
    const resp = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify({ number: numero, textMessage: { text: '✅ Prueba de conexión ITS' } }),
    });
    const data = await resp.json().catch(()=>({}));
    res.json({ ...info, http_status: resp.status, ok: resp.ok, response: data });
  } catch(e) {
    res.json({ ...info, error: e.message });
  }
});

// ── WHATSAPP GESTIÓN: reset completo (borrar y recrear instancia) ─────────────
app.post('/api/whatsapp/reset', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.status(400).json({ error: 'Evolution API no configurada' });
  const base = EVO_URL.replace(/\/+$/, '');
  const h = { 'Content-Type': 'application/json', apikey: EVO_KEY };
  try {
    // 1. Borrar instancia existente
    await fetch(`${base}/instance/delete/${EVO_INSTANCE}`, { method: 'DELETE', headers: h }).catch(()=>{});
    await new Promise(r => setTimeout(r, 2000));
    // 2. Crear instancia nueva con el mismo nombre
    const createResp = await fetch(`${base}/instance/create`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ instanceName: EVO_INSTANCE, qrcode: true, integration: 'WHATSAPP-BAILEYS' })
    });
    const createData = await createResp.json().catch(()=>({}));
    console.log('[WA] Instancia recreada:', JSON.stringify(createData).slice(0,200));
    await new Promise(r => setTimeout(r, 2000));
    // 3. Obtener QR
    const qrResp = await fetch(`${base}/instance/connect/${EVO_INSTANCE}`, { headers: h });
    const qrData = await qrResp.json().catch(()=>({}));
    const qr   = qrData?.base64 || qrData?.qrcode?.base64 || createData?.qrcode?.base64 || null;
    const code  = qrData?.code   || qrData?.qrcode?.code   || null;
    console.log('[WA] Reset completo — QR disponible:', !!qr);
    res.json({ ok: true, qr, code, raw: qrData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP GESTIÓN: desconectar (logout forzado) ───────────────────────────
app.post('/api/whatsapp/desconectar', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.status(400).json({ error: 'Evolution API no configurada' });
  const base = EVO_URL.replace(/\/+$/, '');
  const h = { apikey: EVO_KEY };
  try {
    await fetch(`${base}/instance/logout/${EVO_INSTANCE}`, { method: 'DELETE', headers: h }).catch(()=>{});
    await fetch(`${base}/instance/logout/${EVO_INSTANCE}`, { method: 'POST',   headers: h }).catch(()=>{});
    console.log('[WA] Desconexión forzada por director');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Helper: extraer QR de la respuesta de Evolution API (varios formatos)
function _evoExtractQR(d) {
  const qr   = d?.base64 || d?.qrcode?.base64 || d?.qr?.base64 || null;
  const code = d?.code   || d?.qrcode?.code   || d?.qr?.code   || null;
  return { qr, code };
}

// ── WHATSAPP GESTIÓN: reconectar + obtener QR ────────────────────────────────
app.post('/api/whatsapp/reconectar', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.status(400).json({ error: 'Evolution API no configurada' });
  const base = EVO_URL.replace(/\/+$/, '');
  const h = { apikey: EVO_KEY };
  try {
    // 1. Verificar estado actual
    const stR = await fetch(`${base}/instance/connectionState/${EVO_INSTANCE}`, { headers: h }).catch(()=>null);
    const stD = stR ? await stR.json().catch(()=>({})) : {};
    const state = stD?.instance?.state || stD?.state || '';
    console.log('[WA] Estado actual:', state);

    // 2. Solo hacer logout si no está ya desconectado
    if (state === 'open' || state === 'connecting') {
      await fetch(`${base}/instance/logout/${EVO_INSTANCE}`, { method: 'DELETE', headers: h }).catch(()=>{});
      await new Promise(r => setTimeout(r, 1500));
    }

    // 3. Llamar connect para generar QR
    const connR = await fetch(`${base}/instance/connect/${EVO_INSTANCE}`, { headers: h });
    const connD = await connR.json().catch(()=>({}));
    console.log('[WA] Connect response keys:', Object.keys(connD).join(','));
    let { qr, code } = _evoExtractQR(connD);

    // 4. Si no hay QR todavía, reintentar hasta 4 veces con delay
    if (!qr && !code) {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 2500));
        const retR = await fetch(`${base}/instance/connect/${EVO_INSTANCE}`, { headers: h }).catch(()=>null);
        const retD = retR ? await retR.json().catch(()=>({})) : {};
        const extracted = _evoExtractQR(retD);
        console.log(`[WA] Reintento ${i+1} — QR: ${!!extracted.qr} keys: ${Object.keys(retD).join(',')}`);
        if (extracted.qr || extracted.code) { qr = extracted.qr; code = extracted.code; break; }
      }
    }

    console.log('[WA] Reconexión — QR disponible:', !!qr, 'code:', !!code);
    res.json({ ok: true, qr, code });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/qr', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.status(400).json({ error: 'Evolution API no configurada' });
  try {
    const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/instance/connect/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
    const d = await r.json().catch(()=>({}));
    const { qr, code } = _evoExtractQR(d);
    // También exponer el estado actual
    const stR = await fetch(`${EVO_URL.replace(/\/+$/,'')}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } }).catch(()=>null);
    const stD = stR ? await stR.json().catch(()=>({})) : {};
    const state = stD?.instance?.state || stD?.state || '';
    res.json({ qr, code, state, raw: d });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP GESTIÓN: envío individual ───────────────────────────────────────
app.post('/api/whatsapp/enviar', auth(ADM), async (req, res) => {
  const { telefono, mensaje, destinatario_tipo, destinatario_id, destinatario_nombre } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Teléfono y mensaje requeridos' });
  const waRes = await sendWhatsApp(telefono, mensaje);
  const ok = waRes.ok;
  const id = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
  db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id,'individual',destinatario_tipo||'custom',destinatario_id||null,destinatario_nombre||null,telefono,mensaje,ok?'enviado':'fallido',req.user.id);
  audit(req.user.id,'WA_INDIVIDUAL','wa_mensajes',id,{ tel: telefono, ok });
  if (!ok) return res.status(500).json({ error: waRes.error || 'No se pudo enviar. Verificá la conexión WhatsApp.' });
  res.json({ ok: true, id });
});

// ── WHATSAPP GESTIÓN: reenviar usuario y contraseña a un alumno ──────────────
// Reutiliza la plantilla "bienvenida_qr" (editable por el director) para que un
// alumno reciba de nuevo su usuario (email) y contraseña (CI) por WhatsApp con un
// solo click, sin tener que ir a buscar los datos manualmente en la ficha. La
// contraseña que se informa (CI completo) siempre es válida para iniciar sesión,
// ya que /api/login acepta el CI completo o sus últimos 3 dígitos como atajo
// permanente para alumnos, sin importar si después cambiaron la contraseña.
app.post('/api/whatsapp/enviar-credenciales/:alumno_id', auth(ADM), async (req, res) => {
  try {
    const al = db.prepare(`
      SELECT a.nombre, a.apellido, a.ci, a.telefono, u.email
      FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
      WHERE a.id=?`).get(req.params.alumno_id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (!al.telefono) return res.status(400).json({ error: 'El alumno no tiene teléfono registrado en su ficha' });
    if (!al.email) return res.status(400).json({ error: 'El alumno no tiene un usuario del sistema vinculado' });
    const APP_URL = process.env.APP_URL || 'https://its-sistema-production.up.railway.app/';
    const nombreCompleto = `${al.nombre||''} ${al.apellido||''}`.trim();
    const msg = getWASistemaTpl('bienvenida_qr')
      .replace(/\{nombre\}/g, nombreCompleto)
      .replace(/\{email\}/g, al.email||'')
      .replace(/\{ci\}/g, al.ci||'(tu número de cédula)')
      .replace(/\{url\}/g, APP_URL);
    const waRes = await sendWhatsApp(al.telefono, msg);
    const id = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
    db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id,'individual','alumno',req.params.alumno_id,nombreCompleto,al.telefono,msg,waRes.ok?'enviado':'fallido',req.user.id);
    audit(req.user.id,'WA_ENVIAR_CREDENCIALES','alumnos',req.params.alumno_id,{ telefono: al.telefono, ok: waRes.ok });
    if (!waRes.ok) return res.status(500).json({ error: waRes.error || 'No se pudo enviar. Verificá la conexión WhatsApp.' });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP GESTIÓN: envío masivo ────────────────────────────────────────────
app.post('/api/whatsapp/masivo', auth(ADM), async (req, res) => {
  const { mensaje, filtro } = req.body; // filtro: 'todos'|'con_telefono'
  if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
  res.json({ ok: true, estado: 'procesando' }); // responder inmediatamente
  setImmediate(async () => {
    const docentes = db.prepare(`SELECT d.id,d.telefono,u.nombre,u.apellido FROM docentes d
      JOIN usuarios u ON d.usuario_id=u.id WHERE u.activo=1
      AND d.telefono IS NOT NULL AND d.telefono!=''`).all();
    let enviados=0, fallidos=0;
    for (const doc of docentes) {
      const {ok} = await sendWhatsApp(doc.telefono, mensaje);
      const id = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id,'masivo','docente',doc.id,`${doc.apellido}, ${doc.nombre}`,doc.telefono,mensaje,ok?'enviado':'fallido',req.user.id);
      if (ok) enviados++; else fallidos++;
      // Delay anti-spam: 4-7 segundos aleatorios entre mensajes
      await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
    }
    audit(req.user.id,'WA_MASIVO','wa_mensajes','masivo',{ enviados, fallidos, total: docentes.length });
  });
});

// ── WHATSAPP GESTIÓN: historial ───────────────────────────────────────────────
app.get('/api/whatsapp/historial', auth(ADM), (req, res) => {
  const { tipo, estado, desde, hasta, limit: lim } = req.query;
  let where = 'WHERE 1=1'; const p = [];
  if (tipo)   { where += ' AND tipo=?';   p.push(tipo);   }
  if (estado) { where += ' AND estado=?'; p.push(estado); }
  if (desde)  { where += ' AND fecha>=?'; p.push(desde);  }
  if (hasta)  { where += ' AND fecha<=?'; p.push(hasta+'T23:59:59'); }
  const rows = db.prepare(`SELECT w.*,u.nombre as enviado_nombre,u.apellido as enviado_apellido
    FROM wa_mensajes w LEFT JOIN usuarios u ON w.enviado_por=u.id
    ${where} ORDER BY w.fecha DESC LIMIT ${parseInt(lim)||200}`).all(...p);
  const resumen = db.prepare(`SELECT tipo,estado,COUNT(*) as total FROM wa_mensajes GROUP BY tipo,estado`).all();
  res.json({ mensajes: rows, resumen });
});

// ── WHATSAPP GESTIÓN: programados (crear / listar / cancelar) ─────────────────
app.get('/api/whatsapp/programados', auth(ADM), (req, res) => {
  res.json(db.prepare(`SELECT wp.*,u.nombre as creado_nombre,u.apellido as creado_apellido
    FROM wa_programados wp LEFT JOIN usuarios u ON wp.creado_por=u.id
    ORDER BY wp.fecha_envio ASC`).all());
});
app.post('/api/whatsapp/programar', auth(ADM), (req, res) => {
  const { titulo, destinatario_tipo, destinatario_id, destinatario_nombre, destinatario_telefono, mensaje, fecha_envio } = req.body;
  if (!mensaje || !fecha_envio) return res.status(400).json({ error: 'Mensaje y fecha requeridos' });
  if (destinatario_tipo === 'individual' && !destinatario_telefono) return res.status(400).json({ error: 'Teléfono requerido para envío individual' });
  const id = 'wap_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
  db.prepare(`INSERT INTO wa_programados (id,titulo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,fecha_envio,estado,creado_por)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, titulo||null, destinatario_tipo||'masivo', destinatario_id||null, destinatario_nombre||null, destinatario_telefono||null, mensaje, fecha_envio, 'pendiente', req.user.id);
  res.json({ id });
});
app.delete('/api/whatsapp/programados/:id', auth(ADM), (req, res) => {
  db.prepare("UPDATE wa_programados SET estado='cancelado' WHERE id=? AND estado='pendiente'").run(req.params.id);
  res.json({ ok: true });
});

// ── WHATSAPP: webhook para recibir mensajes (ambas rutas) ────────────────────
// Analiza automáticamente un comprobante recién recibido y precarga los datos (el director igual debe verificar).
async function analizarComprobanteWA(ppid, imgB64, mime) {
  let datos;
  try {
    datos = await geminiLeerComprobante(imgB64, mime);
  } catch(e) {
    db.prepare("UPDATE pagos_pendientes_wa SET ia_estado='error' WHERE id=?").run(ppid);
    return;
  }
  // Intentar resolver alumno por nombre detectado, si todavía no se identificó por teléfono
  let alumnoIdPorNombre = null;
  if (datos.nombre_remitente) {
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z\s]/g,'').trim();
    const objetivo = norm(datos.nombre_remitente);
    if (objetivo.length >= 4) {
      const candidatos = db.prepare("SELECT id, nombre, apellido FROM alumnos WHERE estado='Activo'").all();
      const match = candidatos.find(a => {
        const completo = norm(`${a.nombre} ${a.apellido}`);
        const inverso  = norm(`${a.apellido} ${a.nombre}`);
        return completo === objetivo || inverso === objetivo || objetivo.includes(completo) || completo.includes(objetivo);
      });
      if (match) alumnoIdPorNombre = match.id;
    }
  }
  db.prepare(`UPDATE pagos_pendientes_wa SET
    monto_sugerido=?, fecha_sugerida=?, nombre_detectado=?, banco_detectado=?, referencia_detectada=?,
    ia_estado=?, estado_transferencia_ia=?, alumno_id=COALESCE(alumno_id,?)
    WHERE id=?`)
    .run(datos.monto||null, datos.fecha||null, datos.nombre_remitente||null, datos.banco||null, datos.referencia||null,
      datos.es_comprobante===false?'no_es_comprobante':'ok', datos.estado_transferencia||null, alumnoIdPorNombre, ppid);
}

function manejarWebhookWA(req, res) {
  res.json({ ok: true }); // responder rápido
  try {
    const body = req.body;
    if (!body) return;
    const eventos = Array.isArray(body) ? body : [body];
    for (const ev of eventos) {
      const event = (ev.event || ev.type || '').toLowerCase();

      // Evento de contactos: Evolution API envía @lid → JID real cuando conoce un contacto nuevo.
      // Cacheamos el mapeo para poder responder a contactos no guardados (números desconocidos).
      if (event.includes('contact')) {
        const cData = ev.data || ev;
        const contacts = Array.isArray(cData) ? cData : (Array.isArray(cData?.contacts) ? cData.contacts : [cData]);
        for (const c of contacts) {
          const jid = c.id || c.jid || c.remoteJid;
          const lid = c.lid || c.lidJid;
          if (jid && lid && String(lid).endsWith('@lid') && (String(jid).endsWith('@s.whatsapp.net') || String(jid).endsWith('@c.us'))) {
            const lidStr = String(lid);
            const jidStr = String(jid);
            _lidJidMap.set(lidStr, jidStr);
            // Actualizar registros que usaron el @lid como número temporal mientras no conocíamos el JID real.
            // Esto garantiza que interesados_bot.telefono tenga el número real para poder contactarlos.
            try {
              const realNum = _normTelPY(jidStr.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, ''));
              db.prepare("UPDATE interesados_bot SET telefono=? WHERE telefono=?").run(realNum, lidStr);
              db.prepare("UPDATE wa_recibidos SET numero=? WHERE numero=?").run(realNum, lidStr);
              db.prepare("UPDATE wa_mensajes SET destinatario_telefono=? WHERE destinatario_telefono=?").run(realNum, lidStr);
            } catch(e) { console.error('[CONTACTS_UPSERT] actualizar BD:', e.message); }
          }
        }
        continue;
      }

      if (!event.includes('message')) continue;
      const data = ev.data || ev;
      // Soportar tanto data.key directo como data.messages[0]
      const msgObj = (data.key && data.message) ? data : data?.messages?.[0] || null;
      if (!msgObj) continue;
      const key = msgObj.key || {};
      if (key.fromMe) continue;
      let remoteJid = key.remoteJid || '';
      // Ignorar grupos, broadcast, newsletter, status
      if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter')) continue;
      // Mensajes @lid: identidad de privacidad de WhatsApp (el ID no es un número de teléfono).
      // 1) Caché poblado por CONTACTS_UPSERT. 2) Campos alternativos del payload.
      if (remoteJid.endsWith('@lid')) {
        const isRealJid = s => s && (s.endsWith('@s.whatsapp.net') || s.endsWith('@c.us'));
        const lidOriginal = remoteJid;
        // Primero: caché de contactos (poblado por eventos CONTACTS_UPSERT)
        const cached = _lidJidMap.get(lidOriginal);
        if (cached) {
          remoteJid = cached;
        } else {
          // Segundo: buscar en campos del payload actual
          const candidates = [
            key.remoteJidAlt, msgObj.remoteJidAlt, data.remoteJidAlt,
            ev.sender, data.sender, msgObj.sender,
            key.participant, msgObj.key?.participant,
            data.participant, data.chatId,
          ];
          const real = candidates.find(isRealJid);
          if (real) {
            remoteJid = real;
            _lidJidMap.set(lidOriginal, real); // guardar en caché
          } else {
            console.warn('[WEBHOOK @lid] Sin JID alternativo. Campos:', JSON.stringify({
              lid: lidOriginal, sender: ev.sender||data.sender,
              participant: key.participant, dataParticipant: data.participant,
            }));
          }
        }
      }
      const numero = remoteJid.endsWith('@lid') ? remoteJid : remoteJid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
      if (!numero) continue;
      const msg = msgObj.message || {};
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || '';
      const nombre = msgObj.pushName || data.pushName || '';

      // Imagen recibida (posible comprobante de transferencia) → guardar como pago pendiente
      if (msg.imageMessage) {
        const imgB64 = msgObj.base64 || msg.base64 || data.base64 || null;
        if (imgB64) {
          try {
            const numSin0 = numero.replace(/\D/g,'').replace(/^595/,'');
            const alumno = db.prepare(`
              SELECT id FROM alumnos WHERE (telefono LIKE ? OR telefono LIKE ?) AND estado='Activo' LIMIT 1
            `).get('%'+numSin0, '%0'+numSin0);
            const ppid = 'ppw_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
            const mime = msg.imageMessage.mimetype||'image/jpeg';
            db.prepare(`INSERT INTO pagos_pendientes_wa (id,numero,nombre_contacto,alumno_id,imagen_data,imagen_mime,mensaje_texto)
              VALUES (?,?,?,?,?,?,?)`)
              .run(ppid, numero, nombre, alumno?.id||null, imgB64, mime, texto.trim()||null);
            enviarWA(numero, 'Recibimos su comprobante de transferencia. ✅ Será revisado por el Instituto y le confirmaremos en breve. ¡Gracias!')
              .catch(e=>console.error('[WEBHOOK WA] ack comprobante:', e.message));
            // Análisis automático con IA (no bloquea la respuesta del webhook)
            analizarComprobanteWA(ppid, imgB64, mime).catch(e=>console.error('[WEBHOOK WA] análisis IA:', e.message));
          } catch(e) { console.error('[WEBHOOK WA] guardar comprobante:', e.message); }
        }
      }

      if (!texto.trim()) continue;
      // Guardar en wa_recibidos
      try {
        const wrid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
        db.prepare('INSERT INTO wa_recibidos (id,numero,nombre_contacto,mensaje,fecha,leido) VALUES (?,?,?,?,?,0)')
          .run(wrid, numero, nombre, texto.trim(), nowStr());
      } catch(e) {}
      // Procesar bot (async, no esperar)
      procesarMensajeBot(numero, texto.trim()).catch(e=>console.error('[BOT]', e.message));
    }
  } catch(e) { console.error('[WEBHOOK WA]', e.message); }
}
app.post('/api/whatsapp/webhook', manejarWebhookWA);
app.post('/webhook/whatsapp', manejarWebhookWA);

// ── WHATSAPP: mensajes recibidos ──────────────────────────────────────────────
app.get('/api/whatsapp/recibidos', auth(ADM), (req, res) => {
  const { fecha } = req.query; // filtro por fecha YYYY-MM-DD (compara con prefijo UTC)
  let rows, noLeidos;
  if (fecha) {
    // Buscar en formato UTC (nowStr) y formato localtime (datetime('now','localtime'))
    rows = db.prepare(`SELECT * FROM wa_recibidos WHERE fecha LIKE ? OR fecha LIKE ? ORDER BY fecha DESC LIMIT 500`)
      .all(fecha+'%', (fecha+'T')+'%');
    noLeidos = db.prepare(`SELECT COUNT(*) as n FROM wa_recibidos WHERE leido=0 AND (fecha LIKE ? OR fecha LIKE ?)`).get(fecha+'%',(fecha+'T')+'%').n;
  } else {
    rows = db.prepare('SELECT * FROM wa_recibidos ORDER BY fecha DESC LIMIT 200').all();
    noLeidos = db.prepare('SELECT COUNT(*) as n FROM wa_recibidos WHERE leido=0').get().n;
  }
  // Enriquecer con info de si recibieron respuesta del bot en el mismo día
  const numerosRespondidos = new Set(
    db.prepare(`SELECT DISTINCT destinatario_telefono FROM wa_mensajes WHERE estado='enviado'${fecha?` AND fecha LIKE '${fecha}%'`:''}`).all()
      .map(r => (r.destinatario_telefono||'').replace(/^595/,''))
  );
  const mensajes = rows.map(m => ({
    ...m,
    respondido: numerosRespondidos.has((m.numero||'').replace(/^595/,''))
  }));
  res.json({ mensajes, no_leidos: noLeidos });
});
app.put('/api/whatsapp/recibidos/leer-todos', auth(ADM), (req, res) => {
  db.prepare('UPDATE wa_recibidos SET leido=1').run();
  res.json({ ok: true });
});

app.get('/api/whatsapp/conversaciones', auth(ADM), (req, res) => {
  const { numero: numFiltro, desde, hasta, limite = 60 } = req.query;
  const lim = Math.min(parseInt(limite) || 60, 500);

  let envWhere = `tipo='individual' AND destinatario_telefono IS NOT NULL`;
  let recWhere = `1=1`;
  const params = [];
  const params2 = [];

  if (numFiltro) {
    envWhere += ` AND destinatario_telefono LIKE ?`;
    recWhere += ` AND numero LIKE ?`;
    params.push('%' + numFiltro + '%');
    params2.push('%' + numFiltro + '%');
  }
  if (desde) {
    envWhere += ` AND fecha >= ?`;
    recWhere += ` AND fecha >= ?`;
    params.push(desde);
    params2.push(desde);
  }
  if (hasta) {
    envWhere += ` AND fecha <= ?`;
    recWhere += ` AND fecha <= ?`;
    params.push(hasta + ' 23:59:59');
    params2.push(hasta + ' 23:59:59');
  }

  const enviados = db.prepare(`
    SELECT 'enviado' as direccion, destinatario_telefono as numero,
           destinatario_nombre as nombre_contacto, mensaje, fecha, estado
    FROM wa_mensajes WHERE ${envWhere}
    ORDER BY fecha DESC LIMIT 2000
  `).all(...params);
  const recibidos = db.prepare(`
    SELECT 'recibido' as direccion, numero, nombre_contacto, mensaje, fecha, '' as estado
    FROM wa_recibidos WHERE ${recWhere}
    ORDER BY fecha DESC LIMIT 2000
  `).all(...params2);

  const todos = [...enviados, ...recibidos].sort((a,b)=> a.fecha < b.fecha ? -1 : 1);
  const grupos = {};
  for (const m of todos) {
    let key = (m.numero||'').trim();
    key = key.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
    if (key.endsWith('@lid') && _lidJidMap.has(key)) {
      const jid = _lidJidMap.get(key);
      key = jid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
    }
    if (!key) continue;
    if (!grupos[key]) grupos[key] = { numero: key, nombre: m.nombre_contacto||null, mensajes: [], total: 0 };
    if (!grupos[key].nombre && m.nombre_contacto) grupos[key].nombre = m.nombre_contacto;
    grupos[key].total++;
    grupos[key].mensajes.push(m);
  }
  // Retornar solo últimos `lim` mensajes por conversación, pero informar el total real
  const lista = Object.values(grupos)
    .map(g => ({
      numero: g.numero,
      nombre: g.nombre,
      total: g.total,
      mensajes: g.mensajes.slice(-lim),
      ultimo: g.mensajes[g.mensajes.length-1]?.fecha||''
    }))
    .sort((a,b)=> a.ultimo < b.ultimo ? 1 : -1);
  res.json(lista);
});

// ── WHATSAPP CHAT: todos los mensajes de un número específico ─────────────────
app.get('/api/whatsapp/conversaciones/:numero/mensajes', auth(ADM), (req, res) => {
  const num = decodeURIComponent(req.params.numero);
  const numVariantes = [num, num + '@s.whatsapp.net', num + '@c.us'];
  const placeholders = numVariantes.map(() => '?').join(',');
  const enviados = db.prepare(`
    SELECT 'enviado' as direccion, destinatario_telefono as numero,
           destinatario_nombre as nombre_contacto, mensaje, fecha, estado
    FROM wa_mensajes
    WHERE tipo='individual' AND destinatario_telefono IN (${placeholders})
    ORDER BY fecha ASC
  `).all(...numVariantes);
  const recibidos = db.prepare(`
    SELECT 'recibido' as direccion, numero, nombre_contacto, mensaje, fecha, '' as estado
    FROM wa_recibidos
    WHERE numero IN (${placeholders})
    ORDER BY fecha ASC
  `).all(...numVariantes);
  const mensajes = [...enviados, ...recibidos].sort((a,b)=> a.fecha < b.fecha ? -1 : 1);
  res.json({ mensajes, total: mensajes.length });
});

// ── WHATSAPP CHAT: helper enriquecer número ───────────────────────────────────
function wacEnriquecerNumero(rawNum) {
  const numSin0 = rawNum.replace(/^595/,'').replace(/^0/,'');
  const alumno = db.prepare(`
    SELECT a.nombre, a.apellido, c.nombre as carrera_nombre
    FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id
    WHERE (a.telefono LIKE ? OR a.telefono LIKE ? OR a.telefono LIKE ?)
      AND a.estado='Activo' LIMIT 1
  `).get('%'+numSin0, '%0'+numSin0, rawNum);
  const pendientes = db.prepare("SELECT COUNT(*) as n FROM wa_consultas WHERE numero LIKE ? AND estado='pendiente'").get('%'+numSin0)?.n || 0;
  return { alumno: alumno||null, consultas_pendientes: pendientes };
}

// ── WHATSAPP CHAT: lista de conversaciones ────────────────────────────────────
app.get('/api/whatsapp/chats', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INST = process.env.EVOLUTION_INSTANCE;

  let chats = [];

  // 1) Intentar obtener chats desde Evolution API
  if (EVO_URL && EVO_KEY && EVO_INST) {
    try {
      const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/chat/findChats/${EVO_INST}`, {
        headers: { apikey: EVO_KEY }, signal: AbortSignal.timeout(6000)
      });
      let raw = await r.json();
      let evoChats = Array.isArray(raw) ? raw : (raw?.chats || raw?.data || []);
      evoChats = evoChats.filter(c => {
        const id = (c.id || c.remoteJid || '');
        return id.includes('@s.whatsapp.net') && !id.includes('-');
      });
      chats = evoChats.map(c => {
        const rawNum = (c.id || c.remoteJid || '').split('@')[0];
        const extra  = wacEnriquecerNumero(rawNum);
        const lastTs = c.updatedAt || c.lastMsgTimestamp || c.lastMessageTimestamp || 0;
        const lastMsg = c.lastMessage?.message?.conversation
                     || c.lastMessage?.message?.extendedTextMessage?.text || '';
        return { numero: rawNum, nombre: c.name||c.pushName||null, lastMsg, _ts: lastTs, ...extra };
      });
    } catch(e) { /* fallback a DB */ }
  }

  // 2) Fallback: construir lista desde wa_recibidos + wa_mensajes enviados
  if (chats.length === 0) {
    const recibidos = db.prepare(`
      SELECT numero, nombre_contacto as nombre, mensaje as lastMsg,
             MAX(fecha) as ultima_fecha
      FROM wa_recibidos GROUP BY numero ORDER BY ultima_fecha DESC LIMIT 100
    `).all();
    const enviados = db.prepare(`
      SELECT destinatario_telefono as numero, NULL as nombre, mensaje as lastMsg,
             MAX(fecha) as ultima_fecha
      FROM wa_mensajes WHERE destinatario_telefono IS NOT NULL
      GROUP BY destinatario_telefono ORDER BY ultima_fecha DESC LIMIT 100
    `).all();
    // Merge: números únicos ordenados por última actividad
    const map = new Map();
    [...recibidos, ...enviados].forEach(r => {
      const existing = map.get(r.numero);
      if (!existing || r.ultima_fecha > existing.ultima_fecha) map.set(r.numero, r);
    });
    chats = [...map.values()].sort((a,b) => b.ultima_fecha > a.ultima_fecha ? 1 : -1).map(r => {
      const extra = wacEnriquecerNumero(r.numero);
      return { numero: r.numero, nombre: r.nombre||null, lastMsg: r.lastMsg||'', _ts: r.ultima_fecha, ...extra };
    });
  }

  // 3) Enriquecer con conteo de mensajes no leídos por número
  try {
    const noLeidos = db.prepare(`
      SELECT numero, COUNT(*) as n FROM wa_recibidos WHERE leido=0 GROUP BY numero
    `).all();
    const unreadMap = {};
    noLeidos.forEach(r => { unreadMap[r.numero] = r.n; });
    // También intentar con número sin 595 (por si hay variación en cómo se guardó)
    chats = chats.map(c => {
      const numSin = String(c.numero||'').replace(/^595/,'');
      const unread = (unreadMap[c.numero] || 0) + (unreadMap['0'+numSin] || 0) + (unreadMap[numSin] || 0);
      return { ...c, unread: unread > 0 ? unread : 0 };
    });
  } catch(e) { /* no afecta el resto */ }

  res.json(chats);
});

// ── WHATSAPP CHAT: marcar conversación como leída ─────────────────────────────
app.post('/api/whatsapp/chats/:numero/marcar-leido', auth(ADM), (req, res) => {
  const numero = req.params.numero;
  // El número puede estar guardado con o sin 595, con o sin 0 inicial
  const numSin = String(numero).replace(/^595/,'');
  const variantes = [numero, numSin, '0'+numSin, '595'+numSin].filter(Boolean);
  try {
    const placeholders = variantes.map(()=>'?').join(',');
    const r = db.prepare(`UPDATE wa_recibidos SET leido=1 WHERE numero IN (${placeholders}) AND leido=0`).run(...variantes);
    res.json({ ok: true, actualizados: r.changes });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WHATSAPP CHAT: mensajes de una conversación ───────────────────────────────
app.get('/api/whatsapp/chats/:numero/mensajes', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INST = process.env.EVOLUTION_INSTANCE;
  const numero   = req.params.numero;
  const numSin0  = numero.replace(/^595/,'').replace(/^0/,'');

  let msgs = [];

  // 1) Intentar Evolution API
  if (EVO_URL && EVO_KEY && EVO_INST) {
    try {
      const jid = `${numero}@s.whatsapp.net`;
      const r = await fetch(`${EVO_URL.replace(/\/+$/,'')}/chat/findMessages/${EVO_INST}`, {
        method: 'POST',
        headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ where: { key: { remoteJid: jid } }, limit: 60 }),
        signal: AbortSignal.timeout(6000)
      });
      const data = await r.json();
      let raw = [];
      if (Array.isArray(data))                        raw = data;
      else if (Array.isArray(data?.messages))          raw = data.messages;
      else if (Array.isArray(data?.messages?.records)) raw = data.messages.records;
      else if (Array.isArray(data?.records))           raw = data.records;
      // Filtrar estrictamente por remoteJid del número pedido (la API a veces devuelve todo)
      msgs = raw.filter(m => {
        const rjid = m?.key?.remoteJid || '';
        return rjid === jid || rjid.startsWith(numero+'@');
      });
    } catch(e) { /* fallback */ }
  }

  // 2) Fallback: construir mensajes desde wa_recibidos + wa_mensajes
  if (msgs.length === 0) {
    // Buscar coincidencia exacta primero; si no, por sufijo del número sin 0
    const recibidos = db.prepare(`
      SELECT id, numero, mensaje, fecha, 0 as fromMe, nombre_contacto as pushName
      FROM wa_recibidos
      WHERE numero = ? OR numero = ? OR numero = ?
      ORDER BY fecha ASC LIMIT 60
    `).all(numero, '0'+numSin0, numSin0);
    const enviados = db.prepare(`
      SELECT id, destinatario_telefono as numero, mensaje, fecha, 1 as fromMe, NULL as pushName
      FROM wa_mensajes
      WHERE destinatario_telefono = ? OR destinatario_telefono = ? OR destinatario_telefono = ?
      ORDER BY fecha ASC LIMIT 60
    `).all(numero, '0'+numSin0, numSin0);
    // Combinar y ordenar cronológicamente
    msgs = [...recibidos, ...enviados]
      .sort((a,b) => a.fecha > b.fecha ? 1 : -1)
      .map(m => ({
        key: { fromMe: !!m.fromMe, remoteJid: numero+'@s.whatsapp.net' },
        message: { conversation: m.mensaje },
        messageTimestamp: Math.floor(new Date(m.fecha).getTime()/1000),
        pushName: m.pushName
      }));
  } else {
    msgs.sort((a,b) => ((a.messageTimestamp||0) - (b.messageTimestamp||0)));
  }

  // Datos del alumno y consultas
  const alumno = db.prepare(`
    SELECT a.nombre, a.apellido, a.ci, c.nombre as carrera_nombre, a.telefono
    FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id
    WHERE (a.telefono LIKE ? OR a.telefono LIKE ?) AND a.estado='Activo' LIMIT 1
  `).get('%'+numSin0, '%0'+numSin0);
  const consultas = db.prepare("SELECT * FROM wa_consultas WHERE numero LIKE ? ORDER BY fecha DESC LIMIT 10").all('%'+numSin0);

  res.json({ mensajes: msgs, alumno, consultas });
});

// ── WHATSAPP CHAT: enviar mensaje desde el chat interno ───────────────────────
app.post('/api/whatsapp/chats/:numero/enviar', auth(ADM), async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  try {
    const result = await sendWhatsApp(req.params.numero, mensaje.trim());
    if (!result.ok) return res.status(500).json({ error: result.error || 'Error al enviar' });
    // Guardar en historial local
    try {
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_telefono,mensaje,estado,fecha)
        VALUES (?,?,?,?,?,?)`)
        .run('wam_'+Date.now(),'manual',req.params.numero,mensaje.trim(),'enviado',nowStr());
    } catch {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CRON: mensajes programados (corre cada minuto) ────────────────────────────
cron.schedule('* * * * *', async () => {
  if (WA_AUTO_PAUSADO) return; // ⏸ PAUSADO
  if (!enHoraPermitida()) return; // prohibido sábado, domingo y fuera de 07:00–22:00
  try {
    const ahora = new Date().toISOString().replace('T',' ').slice(0,16);
    const pendientes = db.prepare("SELECT * FROM wa_programados WHERE estado='pendiente' AND substr(fecha_envio,1,16)<=?").all(ahora);
    for (const prog of pendientes) {
      if (prog.destinatario_tipo === 'masivo') {
        const docentes = db.prepare(`SELECT d.id,d.telefono,u.nombre,u.apellido FROM docentes d
          JOIN usuarios u ON d.usuario_id=u.id WHERE u.activo=1
          AND d.telefono IS NOT NULL AND d.telefono!=''`).all();
        let env=0;
        for (const doc of docentes) {
          const {ok} = await sendWhatsApp(doc.telefono, prog.mensaje);
          if (ok) {
            env++;
            db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
              VALUES (?,?,?,?,?,?,?,?,?)`)
              .run('wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),'programado','docente',doc.id,`${doc.apellido}, ${doc.nombre}`,doc.telefono,prog.mensaje,'enviado',prog.creado_por);
          }
          await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
        }
        db.prepare("UPDATE wa_programados SET estado='enviado' WHERE id=?").run(prog.id);
        console.log(`[Programado WA] masivo ${prog.id}: ${env}/${docentes.length} enviados`);
      } else {
        const {ok} = await sendWhatsApp(prog.destinatario_telefono, prog.mensaje);
        db.prepare("UPDATE wa_programados SET estado=? WHERE id=?").run(ok?'enviado':'cancelado', prog.id);
        if (ok) {
          db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run('wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),'programado',prog.destinatario_tipo||'custom',prog.destinatario_id||null,prog.destinatario_nombre||null,prog.destinatario_telefono,prog.mensaje,'enviado',prog.creado_por);
        }
      }
    }
  } catch(e) { console.error('[Cron WA programados]', e.message); }
});

// ── CRON: COMPROMISOS DE PAGO ─────────────────────────────────────────────────
// Diariamente a las 7:00 AM: vence compromisos expirados y envía recordatorios WA
cron.schedule('0 7 * * *', async () => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    // Vencer compromisos expirados
    db.prepare("UPDATE compromisos_pago SET estado='vencido' WHERE estado='pendiente' AND fecha_limite<?").run(hoy);
    // Recordatorios 3 días antes
    const en3dias = new Date(); en3dias.setDate(en3dias.getDate() + 3);
    const fecha3 = en3dias.toISOString().slice(0, 10);
    // Recordatorios 1 día antes
    const en1dia = new Date(); en1dia.setDate(en1dia.getDate() + 1);
    const fecha1 = en1dia.toISOString().slice(0, 10);
    const pendientes = db.prepare(`
      SELECT cp.*, a.nombre, a.apellido, a.telefono
      FROM compromisos_pago cp JOIN alumnos a ON cp.alumno_id=a.id
      WHERE cp.estado='pendiente' AND (cp.fecha_limite=? OR cp.fecha_limite=?)
    `).all(fecha3, fecha1);
    for (const comp of pendientes) {
      if (!comp.telefono) continue;
      const diasRestantes = comp.fecha_limite === fecha3 ? 3 : 1;
      const msg = `Estimado/a *${comp.apellido}, ${comp.nombre}*:\n\nLe recordamos que tiene un *compromiso de pago* pendiente con el Instituto por *Gs. ${Number(comp.monto_total).toLocaleString()}*.\n\nFecha límite: *${comp.fecha_limite}* (${diasRestantes === 1 ? 'mañana' : 'en 3 días'}).\n\nPor favor acérquese a secretaría para regularizar su situación. Si ya realizó el pago, puede ignorar este mensaje.`;
      await sendWhatsApp(comp.telefono, msg).catch(() => {});
    }
    console.log(`[Cron Compromisos] Procesados ${pendientes.length} recordatorios`);
  } catch(e) { console.error('[Cron Compromisos]', e.message); }
});

// ── BOLETÍN DE CALIFICACIONES ─────────────────────────────────────────────────
app.get('/api/alumnos/:id/boletin', auth(['director']), (req, res) => {
  const al = db.prepare(`
    SELECT a.*, COALESCE(a.nombre,u.nombre) as disp_nombre, COALESCE(a.apellido,u.apellido) as disp_apellido,
      COALESCE(a.ci,u.ci) as disp_ci, c.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division, p.nombre as periodo_nombre
    FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
    LEFT JOIN carreras c ON a.carrera_id=c.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN periodos p ON p.activo=1
    WHERE a.id=?`).get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const notas = db.prepare(`
    SELECT n.*, m.nombre as materia_nombre, m.codigo as materia_codigo,
      COALESCE(ud.nombre,'') as doc_nombre, COALESCE(ud.apellido,'') as doc_apellido
    FROM notas n
    JOIN asignaciones asig ON n.asignacion_id=asig.id
    JOIN materias m ON asig.materia_id=m.id
    JOIN periodos p ON asig.periodo_id=p.id
    LEFT JOIN docentes d ON asig.docente_id=d.id
    LEFT JOIN usuarios ud ON d.usuario_id=ud.id
    WHERE n.alumno_id=? AND p.activo=1
    ORDER BY m.nombre`).all(req.params.id);
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ alumno: al, notas, institucion: inst });
});

// Cargar puntos de dirección en TODAS las materias del alumno de una sola vez
// (desde el buscador de "Registro de notas"). Misma regla de siempre: suma sobre
// el valor existente, nunca lo pisa, y respeta el tope de 10 puntos por materia.
app.post('/api/alumnos/:id/director-pts-bulk', auth(['director']), (req, res) => {
  try {
    const puntos = Number(req.body.puntos);
    if (!Number.isFinite(puntos) || puntos === 0) return res.status(400).json({ error: 'Puntos inválido' });
    const al = db.prepare('SELECT id, curso_id, carrera_id FROM alumnos WHERE id=?').get(req.params.id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });

    const asigs = db.prepare(`
      SELECT a.id FROM asignaciones a
      JOIN periodos p ON a.periodo_id=p.id
      WHERE p.activo=1 AND (
        a.curso_id=?
        OR (? IS NOT NULL AND ? IS NULL AND a.curso_id IN (SELECT id FROM cursos WHERE carrera_id=?))
      )`).all(al.curso_id, al.carrera_id, al.curso_id, al.carrera_id);

    const { calcularPuntaje } = require('./db');
    let actualizadas = 0;
    const tx = db.transaction(() => {
      for (const { id: asigId } of asigs) {
        db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)')
          .run('n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), al.id, asigId, 'Pendiente');
        const fila = db.prepare('SELECT tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario,director_pts FROM notas WHERE alumno_id=? AND asignacion_id=?').get(al.id, asigId);
        const antes = fila.director_pts;
        const nuevo = Math.max(0, Math.min(10, (antes || 0) + puntos));
        if (nuevo === antes) continue; // ya está en el tope o no cambia -- no tocar
        db.prepare('UPDATE notas SET director_pts=? WHERE alumno_id=? AND asignacion_id=?').run(nuevo, al.id, asigId);
        const calc = calcularPuntaje(fila.tp1, fila.tp2, fila.tp3, fila.tp4, fila.tp5, fila.parcial, fila.parcial_recuperatorio, fila.final_ord, fila.final_recuperatorio, fila.complementario, fila.extraordinario, nuevo);
        db.prepare('UPDATE notas SET tp_total=?,puntaje_total=?,nota_final=?,estado=?,parcial_efectivo=?,final_efectivo=? WHERE alumno_id=? AND asignacion_id=?')
          .run(calc.tp_total, calc.puntaje, calc.nota, calc.estado, calc.parcial_ef, calc.final_ef, al.id, asigId);
        audit(req.user.id, 'UPDATE_NOTA', 'notas', `${al.id}_${asigId}`, { antes: { director_pts: antes }, campos: { director_pts: nuevo }, origen: 'director_pts_bulk' });
        actualizadas++;
      }
    });
    tx();
    res.json({ ok: true, materias_actualizadas: actualizadas, materias_totales: asigs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verificar si existe pago de constancia
app.get('/api/constancias/pago/:alumno_id', auth(ADM), (req, res) => {
  const pago = db.prepare("SELECT id FROM pagos WHERE alumno_id=? AND concepto='Constancia de estudios' ORDER BY fecha_pago DESC LIMIT 1").get(req.params.alumno_id);
  const arancel = db.prepare("SELECT monto FROM aranceles WHERE concepto LIKE '%constancia%' AND activo=1 LIMIT 1").get();
  res.json({ pagado: !!pago, pago_id: pago?.id||null, arancel: arancel?.monto||30000 });
});

// ── CONSTANCIA DE ESTUDIOS ────────────────────────────────────────────────────
app.get('/api/alumnos/:id/constancia', auth(['director']), (req, res) => {
  const al = db.prepare(`
    SELECT a.*, COALESCE(a.nombre,u.nombre) as disp_nombre, COALESCE(a.apellido,u.apellido) as disp_apellido,
      COALESCE(a.ci,u.ci) as disp_ci, c.nombre as carrera_nombre,
      cu.anio as curso_anio, p.nombre as periodo_nombre, p.anio as periodo_anio
    FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
    LEFT JOIN carreras c ON a.carrera_id=c.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN periodos p ON p.activo=1
    WHERE a.id=?`).get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  // Registrar emisión
  const cid = 'const_'+Date.now();
  const fechaHoy = nowDate();
  db.prepare('INSERT INTO constancias (id,alumno_id,tipo,fecha,emitido_por) VALUES (?,?,?,?,?)').run(cid, req.params.id, 'estudios', fechaHoy, req.user.id);
  audit(req.user.id,'CONSTANCIA','constancias',cid,{alumno_id:req.params.id});
  res.json({ alumno: al, institucion: inst, constancia_id: cid, fecha: fechaHoy });
});

// ── HELPERS DE CUOTAS ────────────────────────────────────────────────────────
function cuotaBaseAlumno(al, cuotaNum) {
  const anio = Number(al.curso_anio) || 1;
  if (anio === 1) return 300000;
  if (anio >= 3) return 400000;
  // 2do año: excepción Cosmiatría — cuotas 1-5 (Marzo-Julio) = 300k, 6-10 (Agosto-Dic) = 400k
  const esCosmiatria = /cosmiatr/i.test(al.carrera_nombre || '');
  if (esCosmiatria) return cuotaNum <= 5 ? 300000 : 400000;
  return 400000;
}

// Estado de las 10 cuotas del alumno (pagadas, pendientes, deuda)
function calcCuotasEstado(al) {
  const pagos = db.prepare("SELECT concepto,monto,mora_monto,fecha_pago FROM pagos WHERE alumno_id=? AND estado='Pagado' ORDER BY fecha_pago ASC").all(al.id);
  const cuotas = [];
  for (let n = 1; n <= 10; n++) {
    const base = cuotaBaseAlumno(al, n);
    const concepto = `Cuota ${n}`;
    const mes = n + 2; // Cuota 1 = Marzo (mes 3), etc.
    const pagoCuota = pagos.filter(p => p.concepto === concepto);
    const totalPagado = pagoCuota.reduce((s, p) => s + Number(p.monto || 0), 0);
    const mora = pagoCuota.reduce((s, p) => s + Number(p.mora_monto || 0), 0);
    const esperado = base + mora;
    const diferencia = Math.max(0, esperado - totalPagado);
    const pagada = totalPagado >= base;
    cuotas.push({ n, concepto, mes, base, mora, esperado, totalPagado, diferencia, pagada, fecha: pagoCuota[0]?.fecha_pago || null });
  }
  return cuotas;
}

// ── DEUDA ACUMULADA POR CUOTAS INCOMPLETAS ────────────────────────────────────
app.get('/api/alumnos/:id/deuda', auth(), (req, res) => {
  try {
    const al = db.prepare(`SELECT a.*, c.nombre as carrera_nombre, cu.anio as curso_anio FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?`).get(req.params.id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (req.user.rol === 'alumno') {
      const alCheck = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(req.user.id);
      if (!alCheck || alCheck.id !== req.params.id) return res.status(403).json({ error: 'Sin acceso' });
    }
    const cuotasPagosAll = db.prepare("SELECT id,concepto,monto,fecha_pago,mora_monto FROM pagos WHERE alumno_id=? AND estado='Pagado' ORDER BY fecha_pago ASC").all(req.params.id)
      .filter(p => /^Cuota \d+$/.test(p.concepto || ''));
    let deudaBruta = 0;
    const detalle = cuotasPagosAll.map(p => {
      const cuotaNum = parseInt((p.concepto || '').match(/\d+/)?.[0] || '0');
      const base = cuotaBaseAlumno(al, cuotaNum);
      const esperado = base + Number(p.mora_monto || 0);
      const pagado = Number(p.monto || 0);
      const diferencia = Math.max(0, esperado - pagado);
      deudaBruta += diferencia;
      return { concepto: p.concepto, base, esperado, pagado, diferencia, fecha: p.fecha_pago };
    });
    const exoneraciones = db.prepare("SELECT * FROM deuda_exoneraciones WHERE alumno_id=? ORDER BY fecha DESC").all(req.params.id);
    const totalExonerado = exoneraciones.reduce((s, e) => s + Number(e.monto || 0), 0);
    const deudaNeta = Math.max(0, deudaBruta - totalExonerado);
    res.json({ deudaBruta, totalExonerado, deudaNeta, detalle, exoneraciones });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumnos/:id/exonerar-deuda', auth(ADM), (req, res) => {
  try {
    const { monto, motivo } = req.body;
    const montoNum = Number(monto || 0);
    if (!montoNum || montoNum <= 0) return res.status(400).json({ error: 'Monto inválido' });
    const al = db.prepare('SELECT id, nombre, apellido FROM alumnos WHERE id=?').get(req.params.id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
    const id = 'de_' + Date.now();
    db.prepare('INSERT INTO deuda_exoneraciones (id,alumno_id,monto,motivo,director_id) VALUES (?,?,?,?,?)').run(id, req.params.id, montoNum, motivo || null, req.user.id);
    audit(req.user.id, 'EXONERACION_DEUDA', 'deuda_exoneraciones', id, { alumno_id: req.params.id, alumno: `${al.apellido}, ${al.nombre}`, monto: montoNum, motivo });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alumnos/:id/exonerar-deuda/:exonId', auth(ADM), (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM deuda_exoneraciones WHERE id=? AND alumno_id=?').get(req.params.exonId, req.params.id);
    if (!ex) return res.status(404).json({ error: 'Exoneración no encontrada' });
    db.prepare('DELETE FROM deuda_exoneraciones WHERE id=?').run(req.params.exonId);
    audit(req.user.id, 'DELETE_EXONERACION_DEUDA', 'deuda_exoneraciones', req.params.exonId, { alumno_id: req.params.id, monto: ex.monto });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADO DE LAS 10 CUOTAS ────────────────────────────────────────────────────
app.get('/api/alumnos/:id/cuotas-estado', auth(), (req, res) => {
  try {
    const al = db.prepare(`SELECT a.*, c.nombre as carrera_nombre, cu.anio as curso_anio FROM alumnos a LEFT JOIN carreras c ON a.carrera_id=c.id LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?`).get(req.params.id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (req.user.rol === 'alumno') {
      const alCheck = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(req.user.id);
      if (!alCheck || alCheck.id !== req.params.id) return res.status(403).json({ error: 'Sin acceso' });
    }
    const cuotas = calcCuotasEstado(al);
    const todasPagadas = cuotas.every(c => c.pagada);
    const compromiso = db.prepare("SELECT * FROM compromisos_pago WHERE alumno_id=? ORDER BY fecha_creacion DESC LIMIT 1").get(req.params.id);
    res.json({ cuotas, todasPagadas, compromiso: compromiso || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── COMPROMISOS DE PAGO ────────────────────────────────────────────────────────
app.get('/api/alumnos/:id/compromiso-pago', auth(), (req, res) => {
  try {
    if (req.user.rol === 'alumno') {
      const alCheck = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(req.user.id);
      if (!alCheck || alCheck.id !== req.params.id) return res.status(403).json({ error: 'Sin acceso' });
    }
    const compromisos = db.prepare("SELECT cp.*, u.nombre as director_nombre, u.apellido as director_apellido FROM compromisos_pago cp LEFT JOIN usuarios u ON cp.director_id=u.id WHERE cp.alumno_id=? ORDER BY cp.fecha_creacion DESC").all(req.params.id);
    res.json(compromisos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumnos/:id/compromiso-pago', auth(ADM), (req, res) => {
  try {
    const { fecha_limite, monto_total, concepto } = req.body;
    if (!fecha_limite) return res.status(400).json({ error: 'Fecha límite requerida' });
    const al = db.prepare('SELECT id, nombre, apellido FROM alumnos WHERE id=?').get(req.params.id);
    if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
    // Cancelar compromiso pendiente previo
    db.prepare("UPDATE compromisos_pago SET estado='cancelado' WHERE alumno_id=? AND estado='pendiente'").run(req.params.id);
    const id = 'cp_' + Date.now();
    db.prepare('INSERT INTO compromisos_pago (id,alumno_id,director_id,fecha_limite,monto_total,concepto,estado) VALUES (?,?,?,?,?,?,?)').run(
      id, req.params.id, req.user.id, fecha_limite, Number(monto_total || 0), concepto || 'Cuotas pendientes', 'pendiente'
    );
    audit(req.user.id, 'COMPROMISO_PAGO', 'compromisos_pago', id, { alumno_id: req.params.id, alumno: `${al.apellido}, ${al.nombre}`, fecha_limite, monto_total });
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alumnos/:id/compromiso-pago/:compId', auth(ADM), (req, res) => {
  try {
    const comp = db.prepare('SELECT * FROM compromisos_pago WHERE id=? AND alumno_id=?').get(req.params.compId, req.params.id);
    if (!comp) return res.status(404).json({ error: 'Compromiso no encontrado' });
    db.prepare('DELETE FROM compromisos_pago WHERE id=?').run(req.params.compId);
    audit(req.user.id, 'DELETE_COMPROMISO_PAGO', 'compromisos_pago', req.params.compId, { alumno_id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADO DE CUENTA CON DEUDAS ACUMULADAS ────────────────────────────────────
app.get('/api/alumnos/:id/estado-cuenta', auth(['director','alumno']), (req, res) => {
  // Alumno solo puede ver el suyo
  if (req.user.rol === 'alumno') {
    const alCheck = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (!alCheck || alCheck.id !== req.params.id) return res.status(403).json({ error: 'Sin acceso' });
  }
  const al = db.prepare(`
    SELECT a.*, COALESCE(a.nombre,u.nombre) as disp_nombre, COALESCE(a.apellido,u.apellido) as disp_apellido,
      COALESCE(a.ci,u.ci) as disp_ci, c.nombre as carrera_nombre, cu.anio as curso_anio
    FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
    LEFT JOIN carreras c ON a.carrera_id=c.id LEFT JOIN cursos cu ON a.curso_id=cu.id
    WHERE a.id=?`).get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const periodo = db.prepare('SELECT * FROM periodos WHERE activo=1').get();
  const pagos = db.prepare(`
    SELECT * FROM pagos WHERE alumno_id=? ${periodo?'AND periodo_id=?':''} ORDER BY fecha_pago DESC`).all(...(periodo?[req.params.id,periodo.id]:[req.params.id]));
  const aranceles = db.prepare(`SELECT * FROM aranceles WHERE activo=1`).all();
  // Calcular deudas por cuota
  const cuotasOblig = ['Matrícula','Cuota 1','Cuota 2','Cuota 3','Cuota 4','Cuota 5'];
  const resumenCuotas = cuotasOblig.map(nombre => {
    const arancel = aranceles.find(a => a.concepto?.includes(nombre) || nombre.includes(a.tipo||''));
    const montoEsperado = arancel?.monto || 0;
    // Comparación exacta para cuotas (evita que 'Cuota 10'.includes('Cuota 1') dé falso positivo)
    // Para Matrícula, aceptar también 'Matrícula 2025', 'Matrícula 2026', etc.
    const pagado = pagos.filter(p => {
      if(nombre==='Matrícula') return /^Matr[ií]cula/.test(p.concepto||'');
      return p.concepto===nombre;
    }).reduce((s,p)=>s+Number(p.monto||0),0);
    const deuda = Math.max(0, montoEsperado - pagado);
    return { concepto: nombre, monto_esperado: montoEsperado, pagado, deuda, estado: pagado>=montoEsperado&&montoEsperado>0?'pagado':pagado>0?'parcial':'pendiente' };
  });
  // Agregar constancias como ítem adicional si hay pagos
  const pagosConst = pagos.filter(p=>p.concepto==='Constancia de estudios');
  if(pagosConst.length) resumenCuotas.push({ concepto:'Constancias de estudios', monto_esperado:0, pagado:pagosConst.reduce((s,p)=>s+Number(p.monto||0),0), deuda:0, estado:'pagado' });
  const totalPagado = pagos.reduce((s,p)=>s+Number(p.monto||0),0);
  const totalDeuda = resumenCuotas.reduce((s,c)=>s+c.deuda,0);
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ alumno: al, pagos, resumenCuotas, totalPagado, totalDeuda, periodo, institucion: inst });
});

// ── DASHBOARD ANALÍTICO ───────────────────────────────────────────────────────
app.get('/api/dashboard/analitico', auth(ADM), (req, res) => {
  const { carrera_id, periodo_id } = req.query;
  const periodo = periodo_id
    ? db.prepare('SELECT * FROM periodos WHERE id=?').get(periodo_id)
    : db.prepare('SELECT * FROM periodos WHERE activo=1').get();
  const periodos = db.prepare('SELECT * FROM periodos ORDER BY anio DESC, id DESC').all();
  const carreras = db.prepare('SELECT * FROM carreras ORDER BY nombre').all();
  // Filtros
  let filtCurso = ''; const fp = [];
  if (carrera_id) { filtCurso = ' AND cu.carrera_id=?'; fp.push(carrera_id); }
  if (periodo?.id) { filtCurso += ' AND asig.periodo_id=?'; fp.push(periodo.id); }
  // Aprobados/reprobados por carrera
  const notasPorCarrera = db.prepare(`
    SELECT ca.nombre as carrera, ca.id as carrera_id,
      COUNT(DISTINCT n.alumno_id) as total,
      SUM(CASE WHEN n.estado='Aprobado' THEN 1 ELSE 0 END) as aprobados,
      SUM(CASE WHEN n.estado='Reprobado' THEN 1 ELSE 0 END) as reprobados,
      SUM(CASE WHEN n.estado='Pendiente' OR n.estado IS NULL THEN 1 ELSE 0 END) as pendientes,
      ROUND(AVG(CASE WHEN n.nota_final IS NOT NULL THEN n.nota_final END),2) as promedio
    FROM notas n
    JOIN asignaciones asig ON n.asignacion_id=asig.id
    JOIN cursos cu ON asig.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE 1=1 ${filtCurso}
    GROUP BY ca.id ORDER BY ca.nombre`).all(...fp);
  // Asistencia promedio por docente
  const asistDocente = db.prepare(`
    SELECT u.nombre||' '||u.apellido as docente, d.id as docente_id,
      COUNT(*) as total_registros,
      SUM(CASE WHEN a.estado='P' THEN 1 ELSE 0 END) as presentes,
      ROUND(SUM(CASE WHEN a.estado='P' THEN 1.0 ELSE 0 END)*100/COUNT(*),1) as pct_asistencia
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN docentes d ON asig.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    WHERE 1=1 ${carrera_id?' AND cu.carrera_id=?':''} ${periodo?.id?' AND asig.periodo_id=?':''}
    GROUP BY d.id ORDER BY pct_asistencia DESC LIMIT 15`).all(...fp);
  // Ingresos mensuales
  const ingresosMes = db.prepare(`
    SELECT strftime('%Y-%m',fecha_pago) as mes,
      SUM(monto) as total, COUNT(*) as cantidad
    FROM pagos WHERE estado='Pagado'
    GROUP BY mes ORDER BY mes DESC LIMIT 12`).all().reverse();
  // Alumnos en riesgo (asistencia < 75%)
  const enRiesgo = db.prepare(`
    SELECT al.id, COALESCE(al.apellido,u.nombre) as apellido, COALESCE(al.nombre,u.nombre) as nombre,
      ca.nombre as carrera, cu.anio,
      COUNT(*) as total_clases,
      SUM(CASE WHEN a.estado='P' THEN 1 ELSE 0 END) as presentes,
      ROUND(SUM(CASE WHEN a.estado='P' THEN 1.0 ELSE 0 END)*100/COUNT(*),1) as pct
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN alumnos al ON a.alumno_id=al.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    JOIN cursos cu ON asig.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE al.estado='Activo' ${carrera_id?' AND ca.id=?':''} ${periodo?.id?' AND asig.periodo_id=?':''}
    GROUP BY al.id HAVING pct < 75 AND total_clases >= 5
    ORDER BY pct ASC LIMIT 20`).all(...fp);
  // Pagos pendientes por mes (deudores)
  const deudoresPorCarrera = db.prepare(`
    SELECT ca.nombre as carrera, COUNT(DISTINCT al.id) as sin_pago
    FROM alumnos al
    JOIN carreras ca ON al.carrera_id=ca.id
    WHERE al.estado='Activo' ${carrera_id?' AND ca.id=?':''}
    AND al.id NOT IN (
      SELECT DISTINCT alumno_id FROM pagos WHERE estado='Pagado' ${periodo?.id?' AND periodo_id=?':''}
    )
    GROUP BY ca.id ORDER BY sin_pago DESC`).all(...(carrera_id?[carrera_id,...(periodo?.id?[periodo.id]:[])]:periodo?.id?[periodo.id]:[]));
  // Exámenes por tipo en el período
  const exsPorTipo = db.prepare(`
    SELECT e.tipo, COUNT(*) as total
    FROM examenes e
    ${periodo?.id?'WHERE e.periodo_id=?':'WHERE 1=1'}
    GROUP BY e.tipo ORDER BY total DESC`).all(...(periodo?.id?[periodo.id]:[]));
  // Honorarios mensuales
  const honorariosMes = db.prepare(`
    SELECT strftime('%Y-%m',fecha) as mes, SUM(monto) as total, COUNT(*) as clases
    FROM honorarios WHERE estado!='anulado'
    GROUP BY mes ORDER BY mes DESC LIMIT 6`).all().reverse();
  res.json({ notasPorCarrera, asistDocente, ingresosMes, enRiesgo, deudoresPorCarrera, exsPorTipo, honorariosMes, periodos, carreras, periodo_activo: periodo?.nombre });
});

// ── CELULAR DOCENTE ───────────────────────────────────────────────────────────
app.put('/api/docentes/:uid/celular', auth(ADM), (req, res) => {
  db.prepare('UPDATE docentes SET celular=? WHERE id=?').run(req.body.celular||null, req.params.uid);
  res.json({ ok: true });
});

// ── CONSTANCIA: registrar en pagos ───────────────────────────────────────────
app.post('/api/constancias/registrar-pago', auth(ADM), (req, res) => {
  const { alumno_id, monto, comprobante } = req.body;
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  const pid = 'pg_const_'+Date.now();
  const fechaHoy = nowDate();
  db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,medio_pago) VALUES (?,?,?,?,?,?,?,?,?)').run(pid,alumno_id,periodo?.id||1,'Constancia de estudios',monto||0,fechaHoy,'Pagado',comprobante||null,'Efectivo');
  audit(req.user.id,'PAGO','pagos',pid,{concepto:'Constancia de estudios',alumno_id});
  res.json({ ok: true, pago_id: pid });
});
// Importar asignaciones para 2do semestre desde Excel
app.post('/api/periodos/importar-asignaciones', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
    const { periodo_id } = req.body;
    if (!periodo_id) return res.status(400).json({ error: 'periodo_id requerido' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    let creadas = 0, errores = [];
    rows.forEach((row, i) => {
      try {
        const docente_id = String(row.docente_id||'').trim();
        const materia_id = String(row.materia_id||'').trim();
        const curso_id = String(row.curso_id||'').trim();
        if (!docente_id||!materia_id||!curso_id) { errores.push(`Fila ${i+2}: faltan docente_id, materia_id o curso_id`); return; }
        const existe = db.prepare('SELECT id FROM asignaciones WHERE docente_id=? AND materia_id=? AND curso_id=? AND periodo_id=?').get(docente_id,materia_id,curso_id,parseInt(periodo_id));
        if (!existe) {
          db.prepare('INSERT INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id,turno,hora_inicio,hora_fin) VALUES (?,?,?,?,?,?,?,?)').run('asig_'+Date.now()+'_'+Math.random().toString(36).slice(2,4),docente_id,materia_id,curso_id,parseInt(periodo_id),row.turno||1,row.hora_inicio||'19:00',row.hora_fin||'20:20');
          creadas++;
        }
      } catch(e) { errores.push(`Fila ${i+2}: ${e.message}`); }
    });
    audit(req.user.id,'IMPORTAR','asignaciones','2do_semestre',{creadas,periodo_id});
    res.json({ ok: true, creadas, errores });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/solicitudes-alumno', auth(ADM), (req, res) => {
  const sede = req.user.sede || 'pjc';
  res.json(db.prepare(`SELECT s.*, u.nombre as docente_nombre, u.apellido as docente_apellido,
    m.nombre as materia, ca.nombre as carrera
    FROM solicitudes_alumno s
    LEFT JOIN docentes d ON s.docente_id=d.id LEFT JOIN usuarios u ON d.usuario_id=u.id
    LEFT JOIN asignaciones a ON s.asignacion_id=a.id LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE (ca.sede_id=? OR ca.id IS NULL)
    ORDER BY s.fecha DESC`).all(sede));
});
// ── VERIFICAR alumno antes de solicitar ─────────────────────────────────────
app.post('/api/solicitudes-alumno/verificar', auth(['director','docente']), (req, res) => {
  try {
    const { nombre, apellido, ci, asignacion_id } = req.body;
    if (!nombre || !asignacion_id) return res.status(400).json({ error: 'Faltan datos' });
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const ciRaw = String(ci||'').replace(/[^0-9]/g,'');

    // 1. ¿Ya hay solicitud pendiente para este alumno en esta asignación?
    let solPend = null;
    if (ciRaw) {
      solPend = db.prepare(`SELECT id FROM solicitudes_alumno WHERE asignacion_id=? AND estado='pendiente' AND ci=?`).get(asignacion_id, ciRaw);
    }
    if (!solPend) {
      solPend = db.prepare(`SELECT id FROM solicitudes_alumno WHERE asignacion_id=? AND estado='pendiente' AND lower(nombre)=? AND lower(apellido)=?`).get(asignacion_id, norm(nombre), norm(apellido));
    }
    if (solPend) {
      return res.json({ status: 'pendiente', mensaje: 'Ya existe una solicitud pendiente para este alumno en esta materia.' });
    }

    // 2. Buscar alumno en DB por CI o nombre+apellido
    const qAlumno = `SELECT a.id, COALESCE(a.nombre,u.nombre) as nombre, COALESCE(a.apellido,u.apellido) as apellido,
      COALESCE(a.ci,u.ci) as ci, a.matricula, ca.nombre as carrera_nombre, cu.anio, cu.division,
      a.carrera_id, a.curso_id, a.estado
      FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
      LEFT JOIN cursos cu ON a.curso_id=cu.id LEFT JOIN carreras ca ON cu.carrera_id=ca.id`;
    let alumno = ciRaw ? db.prepare(qAlumno+` WHERE COALESCE(a.ci,u.ci)=?`).get(ciRaw) : null;
    if (!alumno) {
      alumno = db.prepare(qAlumno+` WHERE lower(COALESCE(a.nombre,u.nombre))=? AND lower(COALESCE(a.apellido,u.apellido))=? LIMIT 1`).get(norm(nombre), norm(apellido));
    }

    if (!alumno) {
      return res.json({ status: 'no_existe', mensaje: 'El alumno no existe en la base de datos del sistema.' });
    }

    // 3. Alumno existe — ¿misma carrera que la asignación?
    const asig = db.prepare(`SELECT a.*, cu.carrera_id FROM asignaciones a JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?`).get(asignacion_id);
    if (alumno.carrera_id && asig?.carrera_id && alumno.carrera_id === asig.carrera_id) {
      return res.json({ status: 'existe_misma_carrera', alumno, mensaje: 'Alumno encontrado en el sistema.' });
    } else {
      return res.json({ status: 'existe_otra_carrera', alumno, mensaje: 'Alumno encontrado pero registrado en otra carrera.' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/solicitudes-alumno', auth(['director','docente']), (req, res) => {
  const { nombre, apellido, ci, asignacion_id, observacion } = req.body;
  if (!nombre || !asignacion_id) return res.status(400).json({ error: 'Nombre y asignación requeridos' });
  const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
  const docId = doc?.id || req.body.docente_id;
  if (!docId) return res.status(400).json({ error: 'No se pudo identificar al docente' });
  const id = 'sal_'+Date.now();
  db.prepare('INSERT INTO solicitudes_alumno (id,nombre,apellido,ci,asignacion_id,docente_id,registrado_por,observacion) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, nombre, apellido||'', ci||'', asignacion_id, docId, req.user.id, observacion||null);
  audit(req.user.id,'SOLICITUD_ALUMNO','solicitudes_alumno',id,{nombre,ci});
  res.json({ id, estado: 'pendiente' });
});
app.put('/api/solicitudes-alumno/:id/resolver', auth(ADM), (req, res) => {
  const { accion } = req.body;
  const sol = db.prepare('SELECT * FROM solicitudes_alumno WHERE id=?').get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
  try {
    if (accion === 'aprobar') {
      const asig = db.prepare('SELECT * FROM asignaciones WHERE id=?').get(sol.asignacion_id);
      if (!asig) return res.status(400).json({ error: 'La asignación referenciada no existe' });
      const curso = db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asig.curso_id);
      const carreraId = curso?.carrera_id || null;
      const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carreraId);
      const _yr = nowSys().getFullYear();
      const _pfx = (carr?.codigo||'ALU')+'-'+_yr+'-';
      const _mats = db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(carreraId||'', _pfx+'%');
      const _max = _mats.reduce((mx,r)=>{ const n=parseInt((r.matricula||'').slice(_pfx.length))||0; return Math.max(mx,n); },0);
      const matricula = _pfx+String(_max+1).padStart(3,'0');
      const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
      const fechaHoy = nowDate();
      db.transaction(() => {
        const normNombre = norm(sol.nombre||'');
        const normApellido = norm(sol.apellido||'');
        let finalUid;
        const existPorCi = ciRaw ? db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw) : null;
        const existPorNombre = !existPorCi ? db.prepare("SELECT id FROM usuarios WHERE lower(nombre)=? AND lower(apellido)=? LIMIT 1").get(normNombre, normApellido) : null;
        if (existPorCi) {
          finalUid = existPorCi.id;
        } else if (existPorNombre) {
          finalUid = existPorNombre.id;
        } else {
          let emailFinal = normNombre+'.'+normApellido+'@its.edu.py';
          if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailFinal))
            emailFinal = normNombre+'.'+normApellido+'.'+(ciRaw.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
          finalUid = 'u_a_'+Date.now();
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(finalUid,sol.nombre,sol.apellido,ciRaw,emailFinal,require('bcryptjs').hashSync(ciRaw||'123456',10),'alumno');
        }
        const yaAlumno = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(finalUid);
        const aid = yaAlumno ? yaAlumno.id : 'a_'+Date.now();
        if (!yaAlumno) {
          db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid,finalUid,matricula,carreraId,asig.curso_id,fechaHoy,'Activo',ciRaw,sol.nombre,sol.apellido);
        }
        db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now(),aid,asig.id,'Pendiente');
        db.prepare("UPDATE solicitudes_alumno SET estado='aprobado' WHERE id=?").run(req.params.id);
      })();
    } else {
      db.prepare("UPDATE solicitudes_alumno SET estado='rechazado' WHERE id=?").run(req.params.id);
    }
    audit(req.user.id,'RESOLVER_ALUMNO','solicitudes_alumno',req.params.id,{accion});
    res.json({ ok: true });
  } catch(e) {
    console.error('Error resolviendo solicitud alumno:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── GESTIÓN DE ALUMNOS — Informes de docentes ─────────────────────────────────
app.post('/api/gestion-alumnos/informe', auth(['director','docente']), (req, res) => {
  try {
    const { alumno_id, asignacion_id, observacion } = req.body;
    if (!alumno_id || !asignacion_id) return res.status(400).json({ error: 'Faltan datos' });
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    const docId = doc?.id || req.body.docente_id;
    if (!docId) return res.status(400).json({ error: 'No se pudo identificar al docente' });
    const id = 'inf_' + Date.now();
    db.prepare('INSERT INTO informes_asistencia (id,alumno_id,asignacion_id,docente_id,observacion) VALUES (?,?,?,?,?)')
      .run(id, alumno_id, asignacion_id, docId, observacion || null);
    audit(req.user.id, 'INFORME_NO_VIENE', 'informes_asistencia', id, { alumno_id });
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gestion-alumnos/informes', auth(ADM), (req, res) => {
  try {
    const informes = db.prepare(`
      SELECT i.*,
        COALESCE(al.nombre, u_al.nombre) as alumno_nombre,
        COALESCE(al.apellido, u_al.apellido) as alumno_apellido,
        COALESCE(al.ci, u_al.ci) as alumno_ci,
        al.estado as alumno_estado,
        m.nombre as materia,
        ca.nombre as carrera, ca.id as carrera_id,
        cu.anio, cu.division,
        u_doc.nombre as docente_nombre, u_doc.apellido as docente_apellido
      FROM informes_asistencia i
      JOIN alumnos al ON i.alumno_id = al.id
      LEFT JOIN usuarios u_al ON al.usuario_id = u_al.id
      JOIN asignaciones a ON i.asignacion_id = a.id
      JOIN materias m ON a.materia_id = m.id
      JOIN cursos cu ON a.curso_id = cu.id
      JOIN carreras ca ON cu.carrera_id = ca.id
      JOIN docentes d ON i.docente_id = d.id
      JOIN usuarios u_doc ON d.usuario_id = u_doc.id
      ORDER BY i.fecha DESC
    `).all();
    res.json(informes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/gestion-alumnos/informe/:id', auth(ADM), (req, res) => {
  try {
    const { estado } = req.body;
    db.prepare('UPDATE informes_asistencia SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gestion-alumnos/ausencias-consecutivas', auth(ADM), (req, res) => {
  try {
    const { carrera_id, anio, division } = req.query;
    let q = `
      SELECT al.id, COALESCE(al.nombre, u.nombre) as nombre,
        COALESCE(al.apellido, u.apellido) as apellido,
        COALESCE(al.ci, u.ci) as ci,
        ca.nombre as carrera, ca.id as carrera_id,
        cu.anio, cu.division, cu.id as curso_id,
        m.nombre as materia, a.id as asignacion_id
      FROM alumnos al
      LEFT JOIN usuarios u ON al.usuario_id = u.id
      JOIN cursos cu ON al.curso_id = cu.id
      JOIN carreras ca ON cu.carrera_id = ca.id
      JOIN notas n ON n.alumno_id = al.id
      JOIN asignaciones a ON n.asignacion_id = a.id
      JOIN materias m ON a.materia_id = m.id
      WHERE al.estado = 'Activo'
    `;
    const params = [];
    if (carrera_id) { q += ' AND ca.id=?'; params.push(carrera_id); }
    if (anio) { q += ' AND cu.anio=?'; params.push(Number(anio)); }
    if (division) { q += ' AND cu.division=?'; params.push(division); }
    const combis = db.prepare(q).all(...params);
    const resultados = [];
    for (const c of combis) {
      const registros = db.prepare(
        `SELECT estado, fecha FROM asistencia WHERE alumno_id=? AND asignacion_id=? ORDER BY fecha DESC LIMIT 20`
      ).all(c.id, c.asignacion_id);
      if (registros.length < 5) continue;
      let consecutivas = 0;
      for (const r of registros) {
        if (r.estado === 'A') consecutivas++;
        else break;
      }
      if (consecutivas >= 5) {
        const ultimaPresente = registros.find(r => r.estado !== 'A');
        resultados.push({
          alumno_id: c.id,
          nombre: c.nombre,
          apellido: c.apellido,
          ci: c.ci,
          materia: c.materia,
          asignacion_id: c.asignacion_id,
          carrera: c.carrera,
          carrera_id: c.carrera_id,
          anio: c.anio,
          division: c.division,
          ausencias_consecutivas: consecutivas,
          ultima_asistencia: ultimaPresente?.fecha || null
        });
      }
    }
    res.json(resultados);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gestion-alumnos/sin-asignar', auth(ADM), (req, res) => {
  try {
    const periodo = db.prepare("SELECT id FROM periodos WHERE activo=1").get();
    if (!periodo) return res.json([]);
    const alumnos = db.prepare(`
      SELECT
        al.id, al.matricula, al.fecha_ingreso,
        COALESCE(al.nombre, u.nombre)     AS nombre,
        COALESCE(al.apellido, u.apellido) AS apellido,
        COALESCE(al.ci, u.ci)             AS ci,
        u.email,
        ca.nombre AS carrera, ca.id AS carrera_id,
        cu.anio,   cu.division
      FROM alumnos al
      LEFT JOIN usuarios u  ON al.usuario_id = u.id
      LEFT JOIN cursos cu   ON al.curso_id   = cu.id
      LEFT JOIN carreras ca ON cu.carrera_id  = ca.id
      WHERE al.estado = 'Activo'
        AND al.id NOT IN (
          SELECT DISTINCT n.alumno_id
          FROM notas n
          JOIN asignaciones a ON n.asignacion_id = a.id
          WHERE a.periodo_id = ?
        )
      ORDER BY ca.nombre, cu.anio, al.apellido NULLS LAST, al.nombre
    `).all(periodo.id);
    res.json(alumnos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gestion-alumnos/inactivos', auth(ADM), (req, res) => {
  try {
    const alumnos = db.prepare(`
      SELECT
        al.id, al.matricula, al.estado, al.fecha_ingreso,
        COALESCE(al.nombre, u.nombre)     AS nombre,
        COALESCE(al.apellido, u.apellido) AS apellido,
        COALESCE(al.ci, u.ci)             AS ci,
        u.email,
        COALESCE(ca_cu.nombre, ca_al.nombre) AS carrera,
        COALESCE(ca_cu.id,    ca_al.id)      AS carrera_id,
        cu.anio,
        cu.division,
        cu.seccion,
        (SELECT COUNT(*) FROM pagos p WHERE p.alumno_id = al.id)          AS total_pagos,
        (SELECT MAX(p.fecha_pago) FROM pagos p WHERE p.alumno_id = al.id) AS ultimo_pago,
        (SELECT COUNT(*) FROM asistencia ast WHERE ast.alumno_id = al.id AND ast.estado = 'A') AS total_ausencias,
        (SELECT COUNT(*) FROM asistencia ast WHERE ast.alumno_id = al.id) AS total_clases,
        (SELECT MAX(ast.fecha) FROM asistencia ast WHERE ast.alumno_id = al.id) AS ultima_clase
      FROM alumnos al
      LEFT JOIN usuarios u    ON al.usuario_id  = u.id
      LEFT JOIN cursos cu     ON al.curso_id     = cu.id
      LEFT JOIN carreras ca_cu ON cu.carrera_id  = ca_cu.id
      LEFT JOIN carreras ca_al ON al.carrera_id  = ca_al.id
      WHERE al.estado IN ('Inactivo','Retirado')
      ORDER BY al.estado, COALESCE(ca_cu.nombre, ca_al.nombre), cu.anio, al.apellido NULLS LAST, al.nombre
    `).all();
    res.json(alumnos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alumnos/candidatos-egreso', auth(ADM), (req, res) => {
  const periodo = db.prepare('SELECT * FROM periodos WHERE activo=1').get();
  const alumnos = db.prepare(`
    SELECT a.id, COALESCE(a.nombre,u.nombre) as nombre, COALESCE(a.apellido,u.apellido) as apellido,
      COALESCE(a.ci,u.ci) as ci, ca.nombre as carrera_nombre, cu.anio, cu.id as curso_id, a.estado
    FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id
    JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE a.estado='Activo' ORDER BY ca.nombre, cu.anio, apellido`).all();

  const resultado = alumnos.map(al => {
    const notas = periodo ? db.prepare("SELECT estado FROM notas n JOIN asignaciones asig ON n.asignacion_id=asig.id WHERE n.alumno_id=? AND asig.periodo_id=?").all(al.id, periodo.id) : [];
    const aprobadas = notas.filter(n=>n.estado==='Aprobado').length;
    const reprobadas = notas.filter(n=>n.estado==='Reprobado').length;
    const cuotasReq = ['Cuota 1','Cuota 2','Cuota 3','Cuota 4','Cuota 5'];
    const pagos = periodo ? db.prepare("SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'").all(al.id, periodo.id) : [];
    const pagosFalt = cuotasReq.filter(c=>!pagos.some(p=>p.concepto===c||p.concepto.includes(c)));
    const solicitud = db.prepare("SELECT * FROM solicitudes_egreso WHERE alumno_id=? ORDER BY fecha_solicitud DESC LIMIT 1").get(al.id);
    return { ...al, total_materias: notas.length, aprobadas, reprobadas, pagos_pendientes: pagosFalt, puede_egresar: reprobadas===0&&notas.length>0&&pagosFalt.length===0, solicitud };
  });
  res.json(resultado);
});

app.post('/api/alumnos/:id/solicitar-egreso', auth(ADM), (req, res) => {
  const al = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
  const notas = periodo ? db.prepare("SELECT estado FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id WHERE n.alumno_id=? AND a.periodo_id=?").all(al.id,periodo.id) : [];
  const aprobadas = notas.filter(n=>n.estado==='Aprobado').length;
  const cuotasReq = ['Cuota 1','Cuota 2','Cuota 3','Cuota 4','Cuota 5'];
  const pagos = periodo ? db.prepare("SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'").all(al.id,periodo.id) : [];
  const pagosOk = cuotasReq.every(c=>pagos.some(p=>p.concepto===c||p.concepto.includes(c)));
  const id = 'egr_'+Date.now();
  db.prepare('INSERT INTO solicitudes_egreso (id,alumno_id,estado,materias_aprobadas,materias_total,pagos_completos) VALUES (?,?,?,?,?,?)').run(id,al.id,'pendiente',aprobadas,notas.length,pagosOk?1:0);
  audit(req.user.id,'SOLICITUD_EGRESO','solicitudes_egreso',id,{alumno_id:al.id});
  res.json({ id, estado: 'pendiente' });
});

app.put('/api/alumnos/:id/resolver-egreso', auth(ADM), (req, res) => {
  const { accion, observacion } = req.body;
  const solicitud = db.prepare("SELECT * FROM solicitudes_egreso WHERE alumno_id=? AND estado='pendiente' ORDER BY fecha_solicitud DESC LIMIT 1").get(req.params.id);
  if (!solicitud) return res.status(404).json({ error: 'Sin solicitud pendiente' });
  const fechaHoy = nowDate();
  db.prepare("UPDATE solicitudes_egreso SET estado=?,aprobado_por=?,fecha_resolucion=?,observacion=? WHERE id=?").run(accion==='aprobar'?'aprobado':'rechazado',req.user.id,fechaHoy,observacion||null,solicitud.id);
  if (accion === 'aprobar') {
    db.prepare("UPDATE alumnos SET estado='Egresado' WHERE id=?").run(req.params.id);
    audit(req.user.id,'EGRESO','alumnos',req.params.id,{accion:'aprobado'});
  }
  res.json({ ok: true, estado: accion==='aprobar'?'aprobado':'rechazado' });
});

app.get('/api/alumnos/:id/acta-egreso', auth(ADM), (req, res) => {
  const al = db.prepare(`SELECT a.*, COALESCE(a.nombre,u.nombre) as disp_nombre, COALESCE(a.apellido,u.apellido) as disp_apellido, COALESCE(a.ci,u.ci) as disp_ci, ca.nombre as carrera_nombre, cu.anio as curso_anio FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id LEFT JOIN carreras ca ON a.carrera_id=ca.id LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?`).get(req.params.id);
  if (!al) return res.status(404).json({ error: 'Alumno no encontrado' });
  const solicitud = db.prepare("SELECT * FROM solicitudes_egreso WHERE alumno_id=? AND estado='aprobado' ORDER BY fecha_resolucion DESC LIMIT 1").get(req.params.id);
  if (!solicitud) return res.status(400).json({ error: 'El alumno no tiene solicitud de egreso aprobada por el Director' });
  const notas = db.prepare(`SELECT m.nombre as materia, n.puntaje_total, n.nota_final, n.estado FROM notas n JOIN asignaciones a ON n.asignacion_id=a.id JOIN materias m ON a.materia_id=m.id WHERE n.alumno_id=? AND n.estado='Aprobado' ORDER BY m.nombre`).all(req.params.id);
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ alumno: al, solicitud, notas, institucion: inst, fecha: solicitud.fecha_resolucion||nowDate() });
});

// ── EXAMENES: adjuntar archivo PDF/Word ───────────────────────────────────────
app.post('/api/examenes/:id/archivo', auth(['director','docente']), upload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const ok = ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf'];
  if (!ok.includes(req.file.mimetype)) return res.status(400).json({ error: 'Solo se permiten archivos Word (.doc, .docx) o PDF' });
  if (req.file.size > 10*1024*1024) return res.status(400).json({ error: 'El archivo no puede superar 10 MB' });
  try {
    db.prepare('UPDATE examenes SET archivo_nombre=?, archivo_data=?, archivo_tipo=? WHERE id=?').run(req.file.originalname, req.file.buffer, req.file.mimetype, req.params.id);
    audit(req.user.id,'UPLOAD_EXAMEN','examenes',req.params.id,{archivo:req.file.originalname});
    // ── Notificación automática al director ──────────────────────────────────
    if (req.user.rol === 'docente') {
      try {
        const ex = db.prepare(`SELECT e.tipo, e.fecha, e.hora, m.nombre as materia_nombre,
          ca.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
          FROM examenes e
          JOIN asignaciones a ON e.asignacion_id=a.id
          JOIN materias m ON a.materia_id=m.id
          JOIN carreras ca ON a.carrera_id=ca.id
          JOIN cursos cu ON a.curso_id=cu.id
          WHERE e.id=?`).get(req.params.id);
        const u = db.prepare('SELECT nombre, apellido FROM usuarios WHERE id=?').get(req.user.id);
        const nombre_doc = u ? `${u.apellido || ''} ${u.nombre || ''}`.trim() : 'Docente';
        const fecha_fmt = ex ? ex.fecha : '';
        const titulo = `📎 Archivo adjunto en examen — ${ex ? ex.materia_nombre : ''}`;
        const contenido = `El/La Prof. ${nombre_doc} adjuntó el archivo "${req.file.originalname}" al examen de ${ex ? ex.tipo : 'examen'} de ${ex ? ex.materia_nombre : ''} (${ex ? ex.carrera_nombre : ''} ${ex ? ex.curso_anio : ''}° año${ex && ex.curso_division ? ' Sec. '+ex.curso_division : ''}) programado para el ${fecha_fmt}. Ingrese al módulo de Exámenes para visualizarlo e imprimirlo.`;
        const aviso_id = 'av_' + Date.now();
        db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(aviso_id, titulo, contenido, 'info', 0, 'todos', req.user.id);
      } catch(ae) { console.error('[AVISO-AUTO]', ae.message); }
    }
    res.json({ ok: true, nombre: req.file.originalname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/examenes/:id/archivo', auth(['director','docente']), (req, res) => {
  const ex = db.prepare('SELECT archivo_data, archivo_nombre, archivo_tipo FROM examenes WHERE id=?').get(req.params.id);
  if (!ex || !ex.archivo_data) return res.status(404).json({ error: 'Sin archivo adjunto' });
  res.set('Content-Type', ex.archivo_tipo);
  res.set('Content-Disposition', `attachment; filename="${ex.archivo_nombre}"`);
  res.send(ex.archivo_data);
});

app.delete('/api/examenes/:id/archivo', auth(['director','docente']), (req, res) => {
  try {
    const ex = db.prepare(`
      SELECT e.archivo_nombre, a.docente_id
      FROM examenes e
      LEFT JOIN asignaciones a ON e.asignacion_id = a.id
      WHERE e.id=?`).get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Examen no encontrado' });
    if (req.user.rol !== 'director' && ex.docente_id !== req.user.docenteId)
      return res.status(403).json({ error: 'Sin permiso para borrar este archivo' });
    db.prepare('UPDATE examenes SET archivo_nombre=NULL, archivo_data=NULL, archivo_tipo=NULL WHERE id=?').run(req.params.id);
    audit(req.user.id, 'DELETE_ARCHIVO', 'examenes', req.params.id, { archivo: ex.archivo_nombre });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPOSITORIO DE ARCHIVOS ───────────────────────────────────────────────────
// Tabla repositorio: id, tipo (programa|contenido), materia_id, carrera_id, curso_id,
//   docente_id, nombre_archivo, datos, mime_tipo, subido_por, fecha, descripcion

// GET programas (director + docente)
app.get('/api/repositorio/programas', auth(['director','docente']), (req, res) => {
  const { carrera_id, curso_id, materia_id, anio } = req.query;
  let where = "WHERE r.tipo='programa'"; const params = [];
  if (carrera_id) { where += ' AND r.carrera_id=?'; params.push(carrera_id); }
  if (curso_id)   { where += ' AND r.curso_id=?';   params.push(curso_id); }
  if (materia_id) { where += ' AND r.materia_id=?'; params.push(materia_id); }
  if (anio)       { where += ' AND (cu.anio=? OR m.anio=?)'; params.push(parseInt(anio), parseInt(anio)); }
  const rows = db.prepare(`
    SELECT r.id, r.nombre_archivo, r.mime_tipo, r.descripcion, r.fecha,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre, cu.anio, cu.division,
      u.nombre as subido_por_nombre, u.apellido as subido_por_apellido
    FROM repositorio r
    LEFT JOIN materias m ON r.materia_id=m.id
    LEFT JOIN carreras ca ON r.carrera_id=ca.id
    LEFT JOIN cursos cu ON r.curso_id=cu.id
    LEFT JOIN usuarios u ON r.subido_por=u.id
    ${where} ORDER BY r.fecha DESC`).all(...params);
  res.json(rows);
});

// GET contenidos (director + docente + alumno)
app.get('/api/repositorio/contenidos', auth(), (req, res) => {
  const { carrera_id, materia_id } = req.query;
  let where = "WHERE r.tipo='contenido'"; const params = [];
  // Alumno: solo ve contenidos de su carrera
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (al?.carrera_id) { where += ' AND r.carrera_id=?'; params.push(al.carrera_id); }
    else return res.json([]);
  }
  if (carrera_id) { where += ' AND r.carrera_id=?'; params.push(carrera_id); }
  if (materia_id) { where += ' AND r.materia_id=?'; params.push(materia_id); }
  const rows = db.prepare(`
    SELECT r.id, r.nombre_archivo, r.mime_tipo, r.descripcion, r.fecha,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre, cu.anio, cu.division,
      u.nombre as subido_por_nombre, u.apellido as subido_por_apellido
    FROM repositorio r
    LEFT JOIN materias m ON r.materia_id=m.id
    LEFT JOIN carreras ca ON r.carrera_id=ca.id
    LEFT JOIN cursos cu ON r.curso_id=cu.id
    LEFT JOIN usuarios u ON r.subido_por=u.id
    ${where} ORDER BY r.fecha DESC`).all(...params);
  res.json(rows);
});

// POST: subir archivo al repositorio
app.post('/api/repositorio', auth(['director','docente']), upload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  const { tipo, materia_id, carrera_id, curso_id, descripcion } = req.body;
  if (!['programa','contenido'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  if (req.file.size > 20*1024*1024) return res.status(400).json({ error: 'El archivo no puede superar 20 MB' });
  const id = 'rep_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
  const fechaHoy = nowDate();
  db.prepare('INSERT INTO repositorio (id,tipo,materia_id,carrera_id,curso_id,nombre_archivo,datos,mime_tipo,subido_por,fecha,descripcion) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, tipo, materia_id||null, carrera_id||null, curso_id||null, req.file.originalname, req.file.buffer, req.file.mimetype, req.user.id, fechaHoy, descripcion||null);
  audit(req.user.id,'UPLOAD_REPOSITORIO','repositorio',id,{tipo,archivo:req.file.originalname});
  res.json({ ok: true, id });
});

// GET: descargar/ver archivo
app.get('/api/repositorio/:id/archivo', auth(), (req, res) => {
  const r = db.prepare('SELECT * FROM repositorio WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Archivo no encontrado' });
  // Alumno: verificar acceso por carrera o curso
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id, curso_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (!al) return res.status(403).json({ error: 'Sin acceso' });
    const matchCarrera = r.carrera_id && al.carrera_id && r.carrera_id === al.carrera_id;
    const matchCurso = r.curso_id && al.curso_id && r.curso_id === al.curso_id;
    const sinRestriccion = !r.carrera_id && !r.curso_id;
    if (!matchCarrera && !matchCurso && !sinRestriccion) return res.status(403).json({ error: 'Sin acceso' });
  }
  res.set('Content-Type', r.mime_tipo||'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${r.nombre_archivo}"`);
  res.send(Buffer.from(r.datos));
});

// DELETE: eliminación de archivos deshabilitada para proteger integridad de datos
app.delete('/api/repositorio/:id', auth(['director','docente']), (req, res) => {
  res.status(403).json({ error: 'La eliminación de archivos no está permitida' });
});

// ── DOCUMENTOS (repositorio institucional tipo Drive) ─────────────────────────
app.get('/api/documento-carpetas', auth(), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.nombre, c.fecha, (SELECT COUNT(*) FROM documentos d WHERE d.carpeta_id=c.id) as total_archivos
      FROM documento_carpetas c ORDER BY c.nombre
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/documento-carpetas', auth(ADM), (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre de carpeta requerido' });
  try {
    const id = 'carp_' + Date.now();
    db.prepare('INSERT INTO documento_carpetas (id,nombre,creado_por) VALUES (?,?,?)').run(id, nombre.trim(), req.user.id);
    audit(req.user.id, 'CREAR_CARPETA_DOCUMENTOS', 'documento_carpetas', id, { nombre });
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/documento-carpetas/:id', auth(ADM), (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const r = db.prepare('UPDATE documento_carpetas SET nombre=? WHERE id=?').run(nombre.trim(), req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Carpeta no encontrada' });
    audit(req.user.id, 'RENOMBRAR_CARPETA_DOCUMENTOS', 'documento_carpetas', req.params.id, { nombre });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Descargar carpeta completa como ZIP (Node built-in zlib, sin dependencias externas)
app.get('/api/documento-carpetas/:id/descargar', auth(), (req, res) => {
  try {
    const carpeta = db.prepare('SELECT * FROM documento_carpetas WHERE id=?').get(req.params.id);
    if (!carpeta) return res.status(404).json({ error: 'Carpeta no encontrada' });
    const docs = db.prepare('SELECT nombre_archivo, datos, mime_tipo FROM documentos WHERE carpeta_id=?').all(req.params.id);
    if (!docs.length) return res.status(404).json({ error: 'La carpeta está vacía' });

    const zlib = require('zlib');

    // Construir ZIP en memoria (formato PKZIP, deflate por archivo)
    const parts = [];
    const centralDir = [];
    let offset = 0;

    // Evitar nombres duplicados
    const usados = {};
    for (const doc of docs) {
      let nombre = doc.nombre_archivo || 'archivo';
      if (usados[nombre]) { const ext = nombre.lastIndexOf('.'); usados[nombre]++; nombre = ext>=0 ? nombre.slice(0,ext)+'_'+usados[nombre]+nombre.slice(ext) : nombre+'_'+usados[nombre]; } else usados[nombre] = 1;

      const data   = Buffer.isBuffer(doc.datos) ? doc.datos : Buffer.from(doc.datos);
      const compr  = zlib.deflateRawSync(data, { level: 6 });
      const useCompr = compr.length < data.length;
      const fileData = useCompr ? compr : data;
      const method   = useCompr ? 8 : 0;  // 8=deflate, 0=stored

      // CRC-32
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;

      const nameBytes = Buffer.from(nombre, 'utf8');
      const now = new Date();
      const dosDate = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
      const dosTime = (now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);

      // Local file header
      const localHeader = Buffer.alloc(30 + nameBytes.length);
      localHeader.writeUInt32LE(0x04034b50, 0);   // signature
      localHeader.writeUInt16LE(20, 4);             // version needed
      localHeader.writeUInt16LE(0x800, 6);          // flags (UTF-8)
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(fileData.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBytes.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBytes.copy(localHeader, 30);

      parts.push(localHeader, fileData);

      // Central directory entry
      const cdEntry = Buffer.alloc(46 + nameBytes.length);
      cdEntry.writeUInt32LE(0x02014b50, 0);  // signature
      cdEntry.writeUInt16LE(20, 4);           // version made by
      cdEntry.writeUInt16LE(20, 6);           // version needed
      cdEntry.writeUInt16LE(0x800, 8);        // flags
      cdEntry.writeUInt16LE(method, 10);
      cdEntry.writeUInt16LE(dosTime, 12);
      cdEntry.writeUInt16LE(dosDate, 14);
      cdEntry.writeUInt32LE(crc, 16);
      cdEntry.writeUInt32LE(fileData.length, 20);
      cdEntry.writeUInt32LE(data.length, 24);
      cdEntry.writeUInt16LE(nameBytes.length, 28);
      cdEntry.writeUInt16LE(0, 30);  // extra
      cdEntry.writeUInt16LE(0, 32);  // comment
      cdEntry.writeUInt16LE(0, 34);  // disk start
      cdEntry.writeUInt16LE(0, 36);  // int attrib
      cdEntry.writeUInt32LE(0, 38);  // ext attrib
      cdEntry.writeUInt32LE(offset, 42);  // local header offset
      nameBytes.copy(cdEntry, 46);
      centralDir.push(cdEntry);

      offset += localHeader.length + fileData.length;
    }

    const cdBuffer = Buffer.concat(centralDir);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centralDir.length, 8);
    eocd.writeUInt16LE(centralDir.length, 10);
    eocd.writeUInt32LE(cdBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    const zip = Buffer.concat([...parts, cdBuffer, eocd]);
    const nombreZip = (carpeta.nombre || 'carpeta').replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nombreZip)}.zip"`);
    audit(req.user.id, 'DESCARGAR_CARPETA_ZIP', 'documento_carpetas', req.params.id, { nombre: carpeta.nombre, archivos: docs.length });
    res.send(zip);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/documento-carpetas/:id', auth(ADM), (req, res) => {
  try {
    const docs = db.prepare('SELECT COUNT(*) n FROM documentos WHERE carpeta_id=?').get(req.params.id).n;
    db.prepare('DELETE FROM documentos WHERE carpeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM documento_carpetas WHERE id=?').run(req.params.id);
    audit(req.user.id, 'ELIMINAR_CARPETA_DOCUMENTOS', 'documento_carpetas', req.params.id, { archivos_eliminados: docs });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── DOCUMENTOS INSTITUCIONALES ────────────────────────────────────────────────
app.get('/api/doc-institucionales', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`SELECT id,tipo,numero,fecha_emision,asunto,institucion,nombre_archivo,mime_tipo,tamano,subido_por,creado_en FROM doc_institucionales ORDER BY fecha_emision DESC`).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/doc-institucionales', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const { tipo, numero, fecha_emision, asunto, institucion } = req.body;
    if (!tipo||!numero||!fecha_emision||!asunto||!institucion) return res.status(400).json({ error: 'Faltan campos obligatorios' });
    const id = uid();
    const archivo = req.file;
    db.prepare(`INSERT INTO doc_institucionales (id,tipo,numero,fecha_emision,asunto,institucion,nombre_archivo,datos,mime_tipo,tamano,subido_por) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tipo, numero, fecha_emision, asunto, institucion,
        archivo?.originalname||null, archivo?.buffer||null, archivo?.mimetype||null, archivo?.size||null, req.user.id);
    audit(req.user.id, 'CREAR_DOC_INSTITUCIONAL', 'doc_institucionales', id, { tipo, numero, asunto });
    res.json({ id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/doc-institucionales/:id/archivo', auth(ADM), (req, res) => {
  try {
    const d = db.prepare('SELECT nombre_archivo, datos, mime_tipo FROM doc_institucionales WHERE id=?').get(req.params.id);
    if (!d||!d.datos) return res.status(404).json({ error: 'Sin archivo' });
    res.setHeader('Content-Type', d.mime_tipo||'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.nombre_archivo||'documento')}"`);
    res.send(d.datos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/doc-institucionales/:id', auth(ADM), (req, res) => {
  try {
    const r = db.prepare('DELETE FROM doc_institucionales WHERE id=?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'No encontrado' });
    audit(req.user.id, 'ELIMINAR_DOC_INSTITUCIONAL', 'doc_institucionales', req.params.id, {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documentos', auth(), (req, res) => {
  try {
    const { carpeta_id } = req.query;
    let where = '';
    const params = [];
    if (carpeta_id) { where = 'WHERE d.carpeta_id=?'; params.push(carpeta_id); }
    const rows = db.prepare(`
      SELECT d.id, d.nombre_archivo, d.mime_tipo, d.tamano, d.categoria, d.descripcion, d.fecha, d.carpeta_id,
        u.nombre as subido_por_nombre, u.apellido as subido_por_apellido
      FROM documentos d LEFT JOIN usuarios u ON d.subido_por=u.id
      ${where}
      ORDER BY d.fecha DESC
    `).all(...params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/documentos', auth(ADM), upload.single('archivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
  try {
    const id = 'doc_' + Date.now();
    db.prepare('INSERT INTO documentos (id,nombre_archivo,datos,mime_tipo,tamano,categoria,descripcion,subido_por,carpeta_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, req.file.originalname, req.file.buffer, req.file.mimetype, req.file.size, req.body.categoria||null, req.body.descripcion||null, req.user.id, req.body.carpeta_id||null);
    audit(req.user.id, 'SUBIR_DOCUMENTO', 'documentos', id, { nombre: req.file.originalname });
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/documentos/:id/descargar', auth(), (req, res) => {
  const d = db.prepare('SELECT * FROM documentos WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  res.setHeader('Content-Type', d.mime_tipo || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.nombre_archivo)}"`);
  res.send(d.datos);
});
app.get('/api/documentos/:id/ver', auth(), (req, res) => {
  const d = db.prepare('SELECT id,nombre_archivo,datos,mime_tipo FROM documentos WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
  const mime = d.mime_tipo || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.nombre_archivo)}"`);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.send(d.datos);
});
app.put('/api/documentos/:id/mover', auth(ADM), (req, res) => {
  try {
    db.prepare('UPDATE documentos SET carpeta_id=? WHERE id=?').run(req.body.carpeta_id||null, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/documentos/:id', auth(ADM), (req, res) => {
  try {
    const d = db.prepare('SELECT nombre_archivo FROM documentos WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
    db.prepare('DELETE FROM documentos WHERE id=?').run(req.params.id);
    audit(req.user.id, 'ELIMINAR_DOCUMENTO', 'documentos', req.params.id, { nombre: d.nombre_archivo });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FORMULARIOS (tipo Google Forms) ───────────────────────────────────────────
app.get('/api/formularios', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT f.*, (SELECT COUNT(*) FROM formulario_respuestas r WHERE r.formulario_id=f.id) as total_respuestas
      FROM formularios f ORDER BY f.fecha_creacion DESC
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/formularios', auth(ADM), (req, res) => {
  const { titulo, descripcion } = req.body;
  if (!titulo) return res.status(400).json({ error: 'Título requerido' });
  try {
    const id = 'form_' + Date.now();
    db.prepare('INSERT INTO formularios (id,titulo,descripcion,creado_por) VALUES (?,?,?,?)').run(id, titulo, descripcion||null, req.user.id);
    audit(req.user.id, 'CREAR_FORMULARIO', 'formularios', id, { titulo });
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/formularios/:id', auth(ADM), (req, res) => {
  const f = db.prepare('SELECT * FROM formularios WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulario no encontrado' });
  const preguntas = db.prepare('SELECT * FROM formulario_preguntas WHERE formulario_id=? ORDER BY orden').all(req.params.id);
  res.json({ ...f, preguntas: preguntas.map(p => ({ ...p, opciones: p.opciones ? JSON.parse(p.opciones) : [] })) });
});
app.put('/api/formularios/:id', auth(ADM), (req, res) => {
  const { titulo, descripcion, activo } = req.body;
  const f = db.prepare('SELECT id FROM formularios WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulario no encontrado' });
  try {
    const sets = []; const vals = [];
    if (titulo !== undefined) { sets.push('titulo=?'); vals.push(titulo); }
    if (descripcion !== undefined) { sets.push('descripcion=?'); vals.push(descripcion); }
    if (activo !== undefined) { sets.push('activo=?'); vals.push(activo ? 1 : 0); }
    if (sets.length) { vals.push(req.params.id); db.prepare(`UPDATE formularios SET ${sets.join(',')} WHERE id=?`).run(...vals); }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/formularios/:id', auth(ADM), (req, res) => {
  try {
    const respIds = db.prepare('SELECT id FROM formulario_respuestas WHERE formulario_id=?').all(req.params.id).map(r=>r.id);
    respIds.forEach(rid => db.prepare('DELETE FROM formulario_respuesta_valores WHERE respuesta_id=?').run(rid));
    db.prepare('DELETE FROM formulario_respuestas WHERE formulario_id=?').run(req.params.id);
    db.prepare('DELETE FROM formulario_preguntas WHERE formulario_id=?').run(req.params.id);
    db.prepare('DELETE FROM formularios WHERE id=?').run(req.params.id);
    audit(req.user.id, 'ELIMINAR_FORMULARIO', 'formularios', req.params.id, {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/formularios/:id/preguntas', auth(ADM), (req, res) => {
  const { tipo, texto_pregunta, opciones, requerida } = req.body;
  if (!['texto','opcion_multiple'].includes(tipo)) return res.status(400).json({ error: 'Tipo de pregunta inválido' });
  if (!texto_pregunta) return res.status(400).json({ error: 'El texto de la pregunta es requerido' });
  if (tipo === 'opcion_multiple' && (!Array.isArray(opciones) || opciones.filter(o=>o&&o.trim()).length < 2)) {
    return res.status(400).json({ error: 'Opción múltiple requiere al menos 2 opciones' });
  }
  try {
    const maxOrden = db.prepare('SELECT COALESCE(MAX(orden),-1) m FROM formulario_preguntas WHERE formulario_id=?').get(req.params.id).m;
    const id = 'preg_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
    db.prepare('INSERT INTO formulario_preguntas (id,formulario_id,orden,tipo,texto_pregunta,opciones,requerida) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.params.id, maxOrden+1, tipo, texto_pregunta, tipo==='opcion_multiple'?JSON.stringify(opciones.filter(o=>o&&o.trim())):null, requerida?1:0);
    res.json({ id, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/formularios/:fid/preguntas/:pid', auth(ADM), (req, res) => {
  const { tipo, texto_pregunta, opciones, requerida } = req.body;
  try {
    db.prepare('UPDATE formulario_preguntas SET tipo=?,texto_pregunta=?,opciones=?,requerida=? WHERE id=? AND formulario_id=?')
      .run(tipo, texto_pregunta, tipo==='opcion_multiple'&&Array.isArray(opciones)?JSON.stringify(opciones.filter(o=>o&&o.trim())):null, requerida?1:0, req.params.pid, req.params.fid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/formularios/:fid/preguntas/:pid', auth(ADM), (req, res) => {
  try {
    db.prepare('DELETE FROM formulario_respuesta_valores WHERE pregunta_id=?').run(req.params.pid);
    db.prepare('DELETE FROM formulario_preguntas WHERE id=? AND formulario_id=?').run(req.params.pid, req.params.fid);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/formularios/:id/respuestas', auth(ADM), (req, res) => {
  try {
    const preguntas = db.prepare('SELECT id, texto_pregunta, orden FROM formulario_preguntas WHERE formulario_id=? ORDER BY orden').all(req.params.id);
    const respuestas = db.prepare('SELECT id, fecha FROM formulario_respuestas WHERE formulario_id=? ORDER BY fecha DESC').all(req.params.id);
    const valores = db.prepare(`
      SELECT v.respuesta_id, v.pregunta_id, v.valor FROM formulario_respuesta_valores v
      JOIN formulario_respuestas r ON v.respuesta_id=r.id WHERE r.formulario_id=?
    `).all(req.params.id);
    const porRespuesta = {};
    valores.forEach(v => { (porRespuesta[v.respuesta_id]=porRespuesta[v.respuesta_id]||{})[v.pregunta_id]=v.valor; });
    const filas = respuestas.map(r => ({ id: r.id, fecha: r.fecha, valores: porRespuesta[r.id]||{} }));
    res.json({ preguntas, respuestas: filas });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/formularios/:id/exportar-excel', auth(ADM), (req, res) => {
  try {
    const f = db.prepare('SELECT titulo FROM formularios WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'Formulario no encontrado' });
    const preguntas = db.prepare('SELECT id, texto_pregunta, orden FROM formulario_preguntas WHERE formulario_id=? ORDER BY orden').all(req.params.id);
    const respuestas = db.prepare('SELECT id, fecha FROM formulario_respuestas WHERE formulario_id=? ORDER BY fecha DESC').all(req.params.id);
    const valores = db.prepare(`
      SELECT v.respuesta_id, v.pregunta_id, v.valor FROM formulario_respuesta_valores v
      JOIN formulario_respuestas r ON v.respuesta_id=r.id WHERE r.formulario_id=?
    `).all(req.params.id);
    const porRespuesta = {};
    valores.forEach(v => { (porRespuesta[v.respuesta_id]=porRespuesta[v.respuesta_id]||{})[v.pregunta_id]=v.valor; });
    const header = ['Fecha', ...preguntas.map(p => p.texto_pregunta)];
    const rows = respuestas.map(r => [
      (r.fecha||'').slice(0,16),
      ...preguntas.map(p => porRespuesta[r.id]?.[p.id] || '')
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    // Ancho de columnas automático
    ws['!cols'] = header.map((h, i) => {
      const maxLen = Math.max(h.length, ...rows.map(r => String(r[i]||'').length));
      return { wch: Math.min(Math.max(maxLen + 2, 12), 50) };
    });
    // Colores: encabezado verde ITS, filas alternadas blanco/verde claro
    const HDR = { fgColor: { rgb: '166534' } };
    const ROW_ALT = { fgColor: { rgb: 'f0fdf4' } };
    const HDR_FONT = { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 };
    const DATA_FONT = { sz: 10 };
    const BORDER = { top:{style:'thin',color:{rgb:'d1d5db'}}, bottom:{style:'thin',color:{rgb:'d1d5db'}}, left:{style:'thin',color:{rgb:'d1d5db'}}, right:{style:'thin',color:{rgb:'d1d5db'}} };
    header.forEach((_, ci) => {
      const cell = XLSX.utils.encode_cell({ r: 0, c: ci });
      if (!ws[cell]) return;
      ws[cell].s = { fill: HDR, font: HDR_FONT, alignment: { wrapText: true, vertical: 'center' }, border: BORDER };
    });
    rows.forEach((_, ri) => {
      const isAlt = ri % 2 === 1;
      header.forEach((__, ci) => {
        const cell = XLSX.utils.encode_cell({ r: ri + 1, c: ci });
        if (!ws[cell]) ws[cell] = { t: 's', v: '' };
        ws[cell].s = { fill: isAlt ? ROW_ALT : { fgColor: { rgb: 'FFFFFF' } }, font: DATA_FONT, alignment: { vertical: 'center' }, border: BORDER };
      });
    });
    ws['!rows'] = [{ hpt: 28 }, ...rows.map(() => ({ hpt: 20 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Respuestas');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const nombre = (f.titulo||'formulario').replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]/g,'_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nombre)}_respuestas.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FORMULARIOS: acceso público (sin login) ───────────────────────────────────
app.get('/pub/formularios/:id', (req, res) => {
  const f = db.prepare('SELECT id, titulo, descripcion, activo FROM formularios WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulario no encontrado' });
  if (!f.activo) return res.status(403).json({ error: 'Este formulario ya no está aceptando respuestas' });
  const preguntas = db.prepare('SELECT id, orden, tipo, texto_pregunta, opciones, requerida FROM formulario_preguntas WHERE formulario_id=? ORDER BY orden').all(req.params.id);
  res.json({ ...f, preguntas: preguntas.map(p => ({ ...p, opciones: p.opciones ? JSON.parse(p.opciones) : [] })) });
});
app.post('/pub/formularios/:id/responder', (req, res) => {
  const f = db.prepare('SELECT id, activo FROM formularios WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Formulario no encontrado' });
  if (!f.activo) return res.status(403).json({ error: 'Este formulario ya no está aceptando respuestas' });
  const { respuestas } = req.body;
  if (!respuestas || typeof respuestas !== 'object') return res.status(400).json({ error: 'Respuestas inválidas' });
  try {
    const preguntas = db.prepare('SELECT id, requerida FROM formulario_preguntas WHERE formulario_id=?').all(req.params.id);
    for (const p of preguntas) {
      if (p.requerida && !String(respuestas[p.id]||'').trim()) {
        return res.status(400).json({ error: 'Faltan responder preguntas obligatorias' });
      }
    }
    const rid = 'resp_' + Date.now();
    db.prepare('INSERT INTO formulario_respuestas (id,formulario_id) VALUES (?,?)').run(rid, req.params.id);
    const insVal = db.prepare('INSERT INTO formulario_respuesta_valores (id,respuesta_id,pregunta_id,valor) VALUES (?,?,?,?)');
    Object.entries(respuestas).forEach(([pid, valor], i) => {
      if (String(valor||'').trim()) insVal.run('rv_'+Date.now()+'_'+i, rid, pid, String(valor));
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.use((err, req, res, next) => {
  console.error('Error no manejado:', err.message);
  try { audit('sistema', 'ERROR', req.path, null, { error: err.message, method: req.method }); } catch {}
  res.status(500).json({ error: 'Error interno del servidor: ' + err.message });
});

// ── ÍNDICES ADICIONALES PARA PERFORMANCE ────────────────────────────────────
// (se ejecutan al inicio, no destructivos)
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notas_asig_alumno ON notas(asignacion_id, alumno_id);
    CREATE INDEX IF NOT EXISTS idx_asistencia_fecha_asig ON asistencia(fecha, asignacion_id);
    CREATE INDEX IF NOT EXISTS idx_pagos_alumno_periodo ON pagos(alumno_id, periodo_id);
    CREATE INDEX IF NOT EXISTS idx_honorarios_docente_fecha ON honorarios(docente_id, fecha);
    CREATE INDEX IF NOT EXISTS idx_alumnos_carrera ON alumnos(carrera_id);
    CREATE INDEX IF NOT EXISTS idx_alumnos_curso ON alumnos(curso_id);
    CREATE INDEX IF NOT EXISTS idx_alumnos_estado ON alumnos(estado);
    CREATE INDEX IF NOT EXISTS idx_alumnos_apellido ON alumnos(apellido);
    CREATE INDEX IF NOT EXISTS idx_usuarios_ci ON usuarios(ci);
  `);
} catch {}


// ── REGISTRO PÚBLICO VÍA QR ──────────────────────────────────────────────────
const pubLimiter = rateLimit({ windowMs: 60*1000, max: 80 });
app.use('/pub', pubLimiter);

// ── REGISTRO DIRECTO QR — nuevo alumno (crea cuenta activa + WA) ──────────────
app.post('/pub/registro-directo', async (req, res) => {
  const { nombre, apellido, ci, telefono, carrera_id, anio, division } = req.body;
  if (!nombre?.trim() || !apellido?.trim()) return res.status(400).json({ error: 'Nombre y apellido son obligatorios' });
  if (!ci || String(ci).replace(/\D/g,'').length < 5) return res.status(400).json({ error: 'Ingresá tu número de cédula' });
  if (!telefono || String(telefono).replace(/\D/g,'').length < 7) return res.status(400).json({ error: 'El número de teléfono es obligatorio' });
  if (!carrera_id) return res.status(400).json({ error: 'Seleccioná tu carrera' });
  if (!anio) return res.status(400).json({ error: 'Seleccioná tu año' });
  const ciNorm = String(ci).replace(/\D/g,'');
  try {
    // Verificar CI duplicado
    const existCI = db.prepare('SELECT a.nombre, a.apellido FROM alumnos a WHERE a.ci=?').get(ciNorm);
    if (existCI) return res.status(409).json({ error: `Ya existe un alumno registrado con esa cédula: ${existCI.apellido}, ${existCI.nombre}. Si ya sos alumno/a usá la otra opción.`, duplicate: true });
    // Verificar nombre duplicado
    const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    const existNom = db.prepare('SELECT id FROM alumnos WHERE lower(nombre)=? AND lower(apellido)=? LIMIT 1').get(normStr(nombre.trim()), normStr(apellido.trim()));
    if (existNom) return res.status(409).json({ error: 'Ya existe un alumno con ese nombre. Si ya sos alumno/a usá la otra opción.', duplicate: true });
    const carrera = db.prepare('SELECT id, nombre FROM carreras WHERE id=?').get(carrera_id);
    if (!carrera) return res.status(400).json({ error: 'Carrera no válida' });
    // Buscar curso para el año indicado (con sección específica si viene)
    const curso = division
      ? db.prepare('SELECT id FROM cursos WHERE carrera_id=? AND anio=? AND division=? AND activo=1 LIMIT 1').get(carrera_id, parseInt(anio), division)
      : db.prepare('SELECT id FROM cursos WHERE carrera_id=? AND anio=? AND activo=1 ORDER BY division LIMIT 1').get(carrera_id, parseInt(anio));
    // Generar email/usuario
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    let email = norm(nombre.trim()).slice(0,1) + norm(apellido.trim()) + '@its.edu.py';
    const conflict = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email);
    if (conflict) email = norm(nombre.trim()).slice(0,1) + norm(apellido.trim()) + '.' + ciNorm.slice(-3) + '@its.edu.py';
    const uid2 = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
    const aid  = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2,5);
    const fechaHoy = new Date().toISOString().slice(0,10);
    // Crear usuario
    db.prepare('INSERT INTO usuarios (id,nombre,apellido,email,password_hash,ci,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
      .run(uid2, nombre.trim(), apellido.trim(), email, ciNorm, ciNorm, 'alumno');
    // Crear alumno activo
    db.prepare('INSERT INTO alumnos (id,nombre,apellido,ci,telefono,carrera_id,curso_id,estado,usuario_id,fecha_ingreso) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(aid, nombre.trim(), apellido.trim(), ciNorm, telefono, carrera_id, curso?.id||null, 'Activo', uid2, fechaHoy);
    // Crear notas vacías para materias del curso
    if (curso?.id) {
      const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
      const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND activo=1').all(curso.id);
      for (const asig of asigs) {
        try { db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,4), aid, asig.id, 'Pendiente'); } catch {}
      }
    }
    audit('sistema_publico', 'REGISTRO_DIRECTO_QR', 'alumnos', aid, { nombre: nombre.trim(), apellido: apellido.trim(), ci: ciNorm, carrera_id });
    // Enviar WhatsApp
    enviarBienvenidaQR(telefono, (nombre.trim()+' '+apellido.trim()), email, ciNorm);
    res.json({ ok: true, email, nombre: nombre.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/pub/carreras', (req, res) => {
  // Solo carreras con al menos una sección (curso) cargada — evita mostrar la
  // estructura "espejo" de una sede todavía sin operar (ej. Cerro Corá, sede 'cc',
  // que ya tiene carreras/materias precargadas pero cero secciones reales). Sin este
  // filtro, cada carrera aparecía duplicada en el selector del QR público y los
  // alumnos que elegían la copia vacía se quedaban sin poder avanzar en el formulario.
  const rows = db.prepare(`
    SELECT c.id, c.nombre, c.codigo FROM carreras c
    WHERE c.activa=1 AND EXISTS (SELECT 1 FROM cursos cu WHERE cu.carrera_id=c.id AND cu.activo=1)
    ORDER BY c.nombre`).all();
  res.json(rows);
});

app.get('/pub/carrera/:id', (req, res) => {
  const c = db.prepare('SELECT id, nombre, codigo FROM carreras WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Carrera no encontrada' });
  res.json(c);
});

app.get('/pub/carrera/:id/cursos', (req, res) => {
  const cursos = db.prepare(`
    SELECT id, anio, division, turno
    FROM cursos WHERE carrera_id=? AND activo=1
    ORDER BY anio, division
  `).all(req.params.id);
  res.json(cursos);
});

app.get('/pub/carrera/:id/alumnos', (req, res) => {
  const { curso_id } = req.query;
  // Si se filtra por curso, incluir también alumnos sin sección asignada (curso_id IS NULL)
  // de la misma carrera, para que aparezcan al buscar en cualquier sección
  const alumnos = curso_id
    ? db.prepare(`SELECT a.id, a.nombre, a.apellido, a.ci, a.telefono, a.curso_id FROM alumnos a WHERE a.carrera_id=? AND (a.curso_id=? OR a.curso_id IS NULL) AND a.estado='Activo' ORDER BY a.curso_id NULLS LAST, a.apellido, a.nombre`).all(req.params.id, curso_id)
    : db.prepare(`SELECT a.id, a.nombre, a.apellido, a.ci, a.telefono, a.curso_id FROM alumnos a WHERE a.carrera_id=? AND a.estado='Activo' ORDER BY a.apellido, a.nombre`).all(req.params.id);
  res.json(alumnos);
});

app.post('/pub/alumno/completar', (req, res) => {
  const { alumno_id, ci, telefono, carrera_id, nombre, apellido, curso_id } = req.body;
  if (!alumno_id || !carrera_id) return res.status(400).json({ error: 'Datos incompletos' });
  const alumno = db.prepare('SELECT * FROM alumnos WHERE id=?').get(alumno_id);
  if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado' });
  if (!db.prepare('SELECT id FROM carreras WHERE id=?').get(carrera_id)) {
    return res.status(400).json({ error: 'Carrera no válida' });
  }
  const logQR = (campo, anterior, nuevo) => {
    const a = String(anterior||'').trim(), n = String(nuevo||'').trim();
    if (a !== n && n !== '') {
      db.prepare('INSERT INTO qr_cambios (id,alumno_id,campo,valor_anterior,valor_nuevo) VALUES (?,?,?,?,?)')
        .run('qrc_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), alumno_id, campo, a, n);
    }
  };
  try {
    if (ci) {
      const ciNorm = String(ci).replace(/[^0-9]/g,'');
      if (ciNorm) {
        const dup = db.prepare('SELECT id FROM alumnos WHERE ci=? AND id!=?').get(ciNorm, alumno_id);
        if (dup) return res.status(400).json({ error: 'Ese número de cédula ya está registrado para otro alumno' });
        db.prepare('UPDATE alumnos SET ci=? WHERE id=?').run(ciNorm, alumno_id);
        if (alumno.usuario_id) db.prepare('UPDATE usuarios SET ci=? WHERE id=?').run(ciNorm, alumno.usuario_id);
        logQR('ci', alumno.ci, ciNorm);
      }
    }
    if (telefono) {
      db.prepare('UPDATE alumnos SET telefono=? WHERE id=?').run(telefono, alumno_id);
      logQR('telefono', alumno.telefono, telefono);
    }
    if (nombre && nombre.trim()) {
      db.prepare('UPDATE alumnos SET nombre=? WHERE id=?').run(nombre.trim(), alumno_id);
      if (alumno.usuario_id) db.prepare('UPDATE usuarios SET nombre=? WHERE id=?').run(nombre.trim(), alumno.usuario_id);
      logQR('nombre', alumno.nombre, nombre.trim());
    }
    if (apellido && apellido.trim()) {
      db.prepare('UPDATE alumnos SET apellido=? WHERE id=?').run(apellido.trim(), alumno_id);
      if (alumno.usuario_id) db.prepare('UPDATE usuarios SET apellido=? WHERE id=?').run(apellido.trim(), alumno.usuario_id);
      logQR('apellido', alumno.apellido, apellido.trim());
    }
    // Si cambió nombre o apellido, regenerar el email/usuario
    if (alumno.usuario_id && ((nombre && nombre.trim()) || (apellido && apellido.trim()))) {
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
      const nuevoNombre = (nombre && nombre.trim()) ? nombre.trim() : (alumno.nombre||'');
      const nuevoApellido = (apellido && apellido.trim()) ? apellido.trim() : (alumno.apellido||'');
      const ciNum = String(ci||alumno.ci||'').replace(/[^0-9]/g,'');
      let nuevoEmail = norm(nuevoNombre).slice(0,1)+norm(nuevoApellido)+"@its.edu.py";
      const conflicto = db.prepare('SELECT id FROM usuarios WHERE email=? AND id!=?').get(nuevoEmail, alumno.usuario_id);
      if (conflicto) nuevoEmail = norm(nuevoNombre).slice(0,1)+norm(nuevoApellido)+'.'+(ciNum.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
      const emailActual = db.prepare('SELECT email FROM usuarios WHERE id=?').get(alumno.usuario_id)?.email||'';
      if (nuevoEmail !== emailActual) {
        db.prepare('UPDATE usuarios SET email=? WHERE id=?').run(nuevoEmail, alumno.usuario_id);
        logQR('email', emailActual, nuevoEmail);
      }
    }
    if (curso_id && !alumno.curso_id) {
      const cursoValido = db.prepare('SELECT id FROM cursos WHERE id=? AND carrera_id=?').get(curso_id, carrera_id);
      if (cursoValido) db.prepare('UPDATE alumnos SET curso_id=? WHERE id=?').run(curso_id, alumno_id);
    }
    // Asignar carrera si el alumno no tenía ninguna (tipo sin_asignar)
    if (!alumno.carrera_id && carrera_id) {
      db.prepare('UPDATE alumnos SET carrera_id=? WHERE id=?').run(carrera_id, alumno_id);
      logQR('carrera_id', '', carrera_id);
    }
    // Enviar WhatsApp de bienvenida con credenciales
    const alumnoActual = db.prepare('SELECT a.*, u.email FROM alumnos a LEFT JOIN usuarios u ON a.usuario_id=u.id WHERE a.id=?').get(alumno_id);
    const telefonoFinal = telefono || alumno.telefono;
    const ciActual = String(ci||alumno.ci||'').replace(/[^0-9]/g,'');
    const nombreCompleto = (nombre||alumno.nombre||'')+(apellido||alumno.apellido?(' '+(apellido||alumno.apellido)):'');
    if (telefonoFinal && alumnoActual?.email) {
      enviarBienvenidaQR(telefonoFinal, nombreCompleto.trim(), alumnoActual.email, ciActual);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/pub/solicitud-registro', (req, res) => {
  const { nombre, apellido, ci, telefono, carrera_id, curso_id, alumno_id, tipo } = req.body;
  if (!nombre || !apellido || !carrera_id) return res.status(400).json({ error: 'Nombre, apellido y carrera son requeridos' });
  if (!telefono || String(telefono).replace(/\D/g,'').length < 7) return res.status(400).json({ error: 'El número de teléfono es obligatorio' });
  const carrera = db.prepare('SELECT id FROM carreras WHERE id=?').get(carrera_id);
  if (!carrera) return res.status(400).json({ error: 'Carrera no válida' });
  const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const esCambioCarrera = tipo === 'cambio_carrera' && alumno_id;

  if (!esCambioCarrera) {
    // Verificar duplicado por CI (LEFT JOIN incluye alumnos sin carrera asignada)
    if (ci) {
      const ciNorm = String(ci).replace(/[^0-9]/g,'');
      if (ciNorm) {
        const existCI = db.prepare(`
          SELECT a.apellido, a.nombre,
            COALESCE(c.nombre, 'Sin carrera asignada') as carrera,
            cu.anio, cu.division
          FROM alumnos a
          LEFT JOIN carreras c  ON a.carrera_id = c.id
          LEFT JOIN cursos   cu ON a.curso_id   = cu.id
          WHERE a.ci = ?`).get(ciNorm);
        if (existCI) {
          const sec = existCI.anio ? (' · ' + existCI.anio + '°' + (existCI.division && existCI.division !== 'U' ? ' Secc. ' + existCI.division : '')) : '';
          const detalle = existCI.apellido + ', ' + existCI.nombre + ' — ' + existCI.carrera + sec;
          return res.status(409).json({ error: 'Ya existe un alumno registrado con esa cédula: ' + detalle, duplicate: true });
        }
      }
    }
    // Verificar duplicado por nombre+apellido en CUALQUIER carrera/sección (incluye sin asignar)
    const existNombre = db.prepare(`
      SELECT a.id,
        COALESCE(c.nombre, 'Sin carrera asignada') as carrera,
        cu.anio, cu.division
      FROM alumnos a
      LEFT JOIN carreras c  ON a.carrera_id = c.id
      LEFT JOIN cursos   cu ON a.curso_id   = cu.id
      WHERE lower(a.nombre)=? AND lower(a.apellido)=?
      LIMIT 1`).get(normStr(nombre), normStr(apellido));
    if (existNombre) {
      const sec = existNombre.anio ? (' · ' + existNombre.anio + '°' + (existNombre.division && existNombre.division !== 'U' ? ' Secc. ' + existNombre.division : '')) : '';
      return res.status(409).json({ error: 'Ya existe un alumno con ese nombre: ' + existNombre.carrera + sec + '. Si ya estás registrado/a, buscá tu nombre en la lista.', duplicate: true });
    }
  }
  // Verificar solicitud pendiente duplicada en cualquier carrera
  const existSol = db.prepare(`SELECT id FROM solicitudes_registro WHERE estado='pendiente' AND ((ci!='' AND ci=?) OR (lower(nombre)=? AND lower(apellido)=?)) LIMIT 1`).get(ci||'__', normStr(nombre), normStr(apellido));
  if (existSol) return res.status(409).json({ error: 'Ya enviaste una solicitud de registro. El director la revisará pronto.', duplicate: true });
  const id = 'sreg_'+Date.now();
  db.prepare('INSERT INTO solicitudes_registro (id,nombre,apellido,ci,telefono,carrera_id,curso_id,alumno_id,tipo) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, nombre, apellido, ci||'', telefono, carrera_id, curso_id||null, alumno_id||null, tipo||'nuevo');
  // Avisar al director: hasta ahora estas solicitudes quedaban invisibles salvo que
  // entrara manualmente al widget de Inicio — no generaban ningún aviso ni notificación,
  // por lo que alumnos completaban el formulario del QR y "no llegaba" ninguna señal al director.
  try {
    const director = db.prepare("SELECT id FROM usuarios WHERE rol='director' AND activo=1 LIMIT 1").get();
    const carreraNom = db.prepare('SELECT nombre FROM carreras WHERE id=?').get(carrera_id)?.nombre || carrera_id;
    if (director) {
      db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)')
        .run('av_solreg_' + Date.now(), '📝 Nueva solicitud de registro (QR)', `Alumno: <strong>${apellido}, ${nombre}</strong> — Carrera: <strong>${carreraNom}</strong><br>CI: ${ci||'—'} · Tel: ${telefono}<br>Revisar y aprobar en Alumnos y Usuarios.`, 'info', 0, 'director', director.id);
    }
  } catch(e) { console.warn('[SOLICITUD_REGISTRO] Error al avisar:', e.message); }
  audit('sistema_publico', 'SOLICITUD_REGISTRO', 'solicitudes_registro', id, { nombre, apellido, ci, carrera_id });
  res.json({ id, ok: true });
});

// ── INCORPORACIÓN ACADÉMICA (público) ─────────────────────────────────────────
// Para alumnos que YA están en el instituto (ya tienen ficha en `alumnos`) pero
// todavía no tienen acceso al sistema (usuario_id vacío). Distinto de
// /pub/solicitud-registro, que es para gente que TODAVÍA no es alumna.
app.post('/pub/incorporacion-academica', (req, res) => {
  const { nombre, apellido, ci, telefono, carrera_id } = req.body;
  if (!nombre || !apellido) return res.status(400).json({ error: 'Nombre y apellido son requeridos' });
  const ciNorm = String(ci||'').replace(/\D/g,'');
  if (ciNorm.length < 5) return res.status(400).json({ error: 'Ingresá tu número de cédula' });
  if (!telefono || String(telefono).replace(/\D/g,'').length < 7) return res.status(400).json({ error: 'El número de teléfono es obligatorio' });
  if (!carrera_id) return res.status(400).json({ error: 'Seleccioná tu carrera' });
  const carrera = db.prepare('SELECT id FROM carreras WHERE id=?').get(carrera_id);
  if (!carrera) return res.status(400).json({ error: 'Carrera no válida' });
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');

  // Buscar alumno existente: primero por CI, si no aparece por nombre+apellido+carrera.
  // El fallback compara en JS (no en SQL) porque norm() saca espacios y tildes
  // (ej. "Delvalle Britez") y el lower() de SQLite no hace eso — comparar directo
  // en SQL no matchearía apellidos compuestos o con acentos.
  let alumno = db.prepare('SELECT * FROM alumnos WHERE ci=?').get(ciNorm);
  if (!alumno) {
    const candidatos = db.prepare('SELECT * FROM alumnos WHERE carrera_id=?').all(carrera_id);
    alumno = candidatos.find(a => norm(a.nombre) === norm(nombre) && norm(a.apellido) === norm(apellido)) || null;
  }
  if (!alumno) {
    return res.status(404).json({ error: 'No encontramos tu registro como alumno del instituto con esos datos. Verificá que estén bien escritos o comunicate con Dirección.', notfound: true });
  }
  if (alumno.usuario_id) {
    const u = db.prepare('SELECT activo FROM usuarios WHERE id=?').get(alumno.usuario_id);
    if (u && u.activo) {
      return res.status(409).json({ error: 'Ya tenés acceso al sistema. Si olvidaste tu contraseña, comunicate con Dirección.', duplicate: true });
    }
  }
  const existSol = db.prepare(`SELECT id FROM solicitudes_registro WHERE estado='pendiente' AND tipo='incorporacion_academica' AND alumno_id=?`).get(alumno.id);
  if (existSol) return res.status(409).json({ error: 'Ya enviaste una solicitud de acceso. Dirección la va a revisar pronto.', duplicate: true });

  const id = 'sreg_'+Date.now();
  db.prepare('INSERT INTO solicitudes_registro (id,nombre,apellido,ci,telefono,carrera_id,alumno_id,tipo) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, nombre, apellido, ciNorm, telefono, carrera_id, alumno.id, 'incorporacion_academica');
  res.json({ id, ok: true, alumno: { nombre: alumno.nombre, apellido: alumno.apellido } });
});

app.get('/api/qr-cambios', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT qc.*, a.nombre as al_nombre, a.apellido as al_apellido, a.ci as al_ci,
        c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
      FROM qr_cambios qc
      JOIN alumnos a ON qc.alumno_id=a.id
      JOIN carreras c ON a.carrera_id=c.id
      LEFT JOIN cursos cu ON a.curso_id=cu.id
      ORDER BY qc.fecha DESC
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEPURACIÓN DE ALUMNOS INACTIVOS ──────────────────────────────────────────
app.get('/api/alumnos/depuracion', auth(ADM), (req, res) => {
  try {
    const { carrera_id, curso_id } = req.query;
    // carrera_id es opcional: si no viene, se busca en TODAS las carreras a la vez.
    let q = `SELECT a.id, COALESCE(a.nombre,u.nombre,'') as nombre,
      COALESCE(a.apellido,u.apellido,'') as apellido,
      COALESCE(a.ci,u.ci,'') as ci, a.telefono, a.carrera_id, a.curso_id,
      c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division
      FROM alumnos a
      LEFT JOIN usuarios u ON a.usuario_id=u.id
      LEFT JOIN carreras c ON a.carrera_id=c.id
      LEFT JOIN cursos cu ON a.curso_id=cu.id
      WHERE a.estado='Activo'`;
    const params = [];
    if (carrera_id) { q += ' AND a.carrera_id=?'; params.push(carrera_id); }
    if (curso_id)   { q += ' AND a.curso_id=?';   params.push(curso_id); }
    const alumnos = db.prepare(q).all(...params);

    const resultado = [];
    for (const al of alumnos) {
      // Últimas N asistencias ordenadas más reciente primero
      const asistencias = db.prepare(
        `SELECT estado FROM asistencia WHERE alumno_id=? ORDER BY fecha DESC, id DESC LIMIT 20`
      ).all(al.id);

      if (asistencias.length < 12) continue; // no tiene suficientes registros

      // Contar racha de ausencias desde el más reciente
      let racha = 0;
      for (const r of asistencias) {
        if (r.estado === 'A') racha++;
        else break;
      }
      if (racha < 12) continue;

      // Pagos (no anulados)
      const { cnt_pagos } = db.prepare(
        `SELECT COUNT(*) as cnt_pagos FROM pagos WHERE alumno_id=? AND estado != 'Anulado'`
      ).get(al.id);

      // Puntaje cargado en alguna materia
      const { cnt_puntaje } = db.prepare(
        `SELECT COUNT(*) as cnt_puntaje FROM notas WHERE alumno_id=? AND puntaje_total > 0`
      ).get(al.id);

      const tienePagos   = cnt_pagos   > 0;
      const tienePuntaje = cnt_puntaje > 0;

      // Grupo: 1=eliminable, 2=tiene pagos, 3=tiene puntaje sin pagos
      let grupo;
      if (!tienePagos && !tienePuntaje) grupo = 1;
      else if (tienePagos)              grupo = 2;
      else                              grupo = 3;

      resultado.push({ ...al, racha_ausencias: racha, tienePagos, tienePuntaje, grupo });
    }

    // Ordenar: grupo 1 primero, luego por racha descendente
    resultado.sort((a, b) => a.grupo - b.grupo || b.racha_ausencias - a.racha_ausencias);
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /webhook/whatsapp ya está registrado arriba como alias de manejarWebhookWA

// ── PANEL DE INTERESADOS (admisiones bot) ────────────────────────────────────
app.get('/api/interesados', auth(ADM), (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM interesados_bot ORDER BY fecha DESC').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/interesados/:id/estado', auth(ADM), (req, res) => {
  try {
    const { estado } = req.body;
    if (!['nuevo','contactado','inscripto','descartado'].includes(estado))
      return res.status(400).json({ error: 'Estado inválido' });
    db.prepare('UPDATE interesados_bot SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/interesados/:id', auth(ADM), (req, res) => {
  try {
    db.prepare('DELETE FROM interesados_bot WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAPELERA DE RECICLAJE ─────────────────────────────────────────────────────
app.get('/api/papelera', auth(ADM), (req, res) => {
  try {
    res.json(db.prepare(
      'SELECT id,tipo,nombre_display,eliminado_por,fecha_eliminacion,expira_en FROM papelera ORDER BY fecha_eliminacion DESC'
    ).all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/papelera/:id/restaurar', auth(ADM), async (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM papelera WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'No encontrado en papelera' });
    const datos = JSON.parse(item.datos_json);

    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if (item.tipo === 'alumno_completo' || item.tipo === 'alumno') {
          // Restaurar usuario
          if (datos.usuario) {
            const u = datos.usuario;
            db.prepare(`INSERT OR IGNORE INTO usuarios
              (id,nombre,apellido,ci,email,password_hash,rol,activo)
              VALUES (?,?,?,?,?,?,?,?)`)
              .run(u.id,u.nombre,u.apellido,u.ci,u.email,u.password_hash,u.rol,u.activo??1);
          }
          // Restaurar alumno
          if (datos.alumno) {
            const a = datos.alumno;
            db.prepare(`INSERT OR IGNORE INTO alumnos
              (id,usuario_id,matricula,carrera_id,curso_id,estado,ci,nombre,apellido,telefono)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(a.id,a.usuario_id,a.matricula,a.carrera_id,a.curso_id,a.estado??'Activo',a.ci,a.nombre,a.apellido,a.telefono);
          }
          // Restaurar notas
          (datos.notas||[]).forEach(n => {
            try { db.prepare(`INSERT OR IGNORE INTO notas
              (id,alumno_id,asignacion_id,tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,
               final_ord,final_recuperatorio,complementario,extraordinario,puntaje_total,nota_final,estado,director_pts)
              VALUES (@id,@alumno_id,@asignacion_id,@tp1,@tp2,@tp3,@tp4,@tp5,@parcial,@parcial_recuperatorio,
               @final_ord,@final_recuperatorio,@complementario,@extraordinario,@puntaje_total,@nota_final,@estado,@director_pts)`)
              .run(n); } catch {}
          });
          // Restaurar pagos
          (datos.pagos||[]).forEach(p => {
            try { db.prepare(`INSERT OR IGNORE INTO pagos
              (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,descuento,medio_pago)
              VALUES (@id,@alumno_id,@periodo_id,@concepto,@monto,@fecha_pago,@estado,@descuento,@medio_pago)`)
              .run(p); } catch {}
          });
          // Restaurar asistencia
          (datos.asistencia||[]).forEach(a => {
            try { db.prepare(`INSERT OR IGNORE INTO asistencia
              (id,alumno_id,asignacion_id,fecha,estado,observacion)
              VALUES (@id,@alumno_id,@asignacion_id,@fecha,@estado,@observacion)`)
              .run(a); } catch {}
          });
          // Restaurar becas y habilitaciones
          (datos.becas||[]).forEach(b => {
            try { db.prepare(`INSERT OR IGNORE INTO becas
              (id,alumno_id,tipo,porcentaje,monto_fijo,fecha_inicio,fecha_fin,activa)
              VALUES (@id,@alumno_id,@tipo,@porcentaje,@monto_fijo,@fecha_inicio,@fecha_fin,@activa)`)
              .run(b); } catch {}
          });
          (datos.habilitaciones||[]).forEach(h => {
            try { db.prepare(`INSERT OR IGNORE INTO habilitaciones_examen
              (id,alumno_id,tipo_examen,asignacion_id,habilitado,habilitado_recuperatorio)
              VALUES (@id,@alumno_id,@tipo_examen,@asignacion_id,@habilitado,@habilitado_recuperatorio)`)
              .run(h); } catch {}
          });
        } else if (item.tipo === 'pago') {
          const p = datos;
          try { db.prepare(`INSERT OR IGNORE INTO pagos
            (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,descuento,medio_pago,asignacion_id)
            VALUES (@id,@alumno_id,@periodo_id,@concepto,@monto,@fecha_pago,@estado,@descuento,@medio_pago,@asignacion_id)`)
            .run(p); } catch(e2) { throw new Error('Error restaurar pago: '+e2.message); }
        } else if (item.tipo === 'examen') {
          const e = datos;
          try { db.prepare(`INSERT OR IGNORE INTO examenes
            (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,puntos_max)
            VALUES (@id,@asignacion_id,@tipo,@fecha,@hora,@aula,@periodo_id,@puntos_max)`)
            .run(e); } catch(e2) { throw new Error('Error restaurar examen: '+e2.message); }
        } else if (item.tipo === 'docente') {
          if (datos.usuario) {
            const u = datos.usuario;
            db.prepare(`INSERT OR IGNORE INTO usuarios
              (id,nombre,apellido,ci,email,password_hash,rol,activo)
              VALUES (?,?,?,?,?,?,?,?)`)
              .run(u.id,u.nombre,u.apellido,u.ci,u.email,u.password_hash,u.rol,u.activo??1);
          }
          if (datos.docente) {
            const d = datos.docente;
            try { db.prepare(`INSERT OR IGNORE INTO docentes
              (id,usuario_id,especialidad,titulo,telefono,celular)
              VALUES (@id,@usuario_id,@especialidad,@titulo,@telefono,@celular)`)
              .run(d); } catch {}
          }
        }
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.prepare('DELETE FROM papelera WHERE id=?').run(req.params.id);
    audit(req.user.id,'RESTAURAR','papelera',req.params.id,{ tipo: item.tipo, nombre: item.nombre_display });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error al restaurar: '+e.message }); }
});

app.delete('/api/papelera/:id', auth(ADM), (req, res) => {
  try {
    db.prepare('DELETE FROM papelera WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PANEL DE CONSULTAS BOT ────────────────────────────────────────────────────
app.get('/api/consultas', auth(ADM), (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM wa_consultas ORDER BY fecha DESC').all());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/consultas/:id/estado', auth(ADM), (req, res) => {
  try {
    const { estado } = req.body;
    if (!['pendiente','atendido'].includes(estado))
      return res.status(400).json({ error: 'Estado inválido' });
    db.prepare('UPDATE wa_consultas SET estado=? WHERE id=?').run(estado, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/consultas/:id', auth(ADM), (req, res) => {
  try {
    db.prepare('DELETE FROM wa_consultas WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DETECCIÓN DE ALUMNOS DUPLICADOS ──────────────────────────────────────────
app.get('/api/alumnos/duplicados', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, COALESCE(a.nombre,u.nombre,'') as nombre,
        COALESCE(a.apellido,u.apellido,'') as apellido,
        COALESCE(a.ci,u.ci,'') as ci,
        a.telefono, a.carrera_id, a.curso_id, a.estado, u.email,
        c.nombre as carrera_nombre, cu.anio as curso_anio, cu.division as curso_division,
        (SELECT COUNT(*) FROM pagos  WHERE alumno_id=a.id AND estado!='Anulado') as cnt_pagos,
        (SELECT COUNT(*) FROM notas  WHERE alumno_id=a.id AND puntaje_total>0)  as cnt_puntaje
      FROM alumnos a
      LEFT JOIN usuarios u  ON a.usuario_id = u.id
      LEFT JOIN carreras c  ON a.carrera_id  = c.id
      LEFT JOIN cursos   cu ON a.curso_id    = cu.id
      WHERE a.estado NOT IN ('Retirado','Inactivo')
      ORDER BY COALESCE(a.apellido,u.apellido), COALESCE(a.nombre,u.nombre)
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DETALLE PARA COMPARACIÓN DE DUPLICADOS ───────────────────────────────────
app.get('/api/alumnos/:id/detalle-dup', auth(ADM), (req, res) => {
  try {
    const { id } = req.params;
    // Pagos agrupados por mes+concepto
    const pagos = db.prepare(`
      SELECT p.id, p.concepto, p.monto, p.fecha_pago, p.estado, p.medio_pago,
        strftime('%Y-%m', p.fecha_pago) as mes_anio
      FROM pagos p WHERE p.alumno_id=? AND p.estado!='Anulado'
      ORDER BY p.fecha_pago DESC
    `).all(id);
    // Notas resumidas
    const notas = db.prepare(`
      SELECT n.id, n.asignacion_id, n.puntaje_total, n.nota_final, n.estado,
        m.nombre as materia, a.id as asig_id
      FROM notas n
      LEFT JOIN asignaciones a ON n.asignacion_id=a.id
      LEFT JOIN materias m ON a.materia_id=m.id
      WHERE n.alumno_id=?
    `).all(id);
    // Asistencia resumen
    const asist = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN estado='P' THEN 1 ELSE 0 END) as presentes,
        SUM(CASE WHEN estado='A' THEN 1 ELSE 0 END) as ausentes
      FROM asistencia WHERE alumno_id=?
    `).get(id);
    res.json({ pagos, notas, asistencia: asist });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── UNIFICACIÓN DE DUPLICADOS ─────────────────────────────────────────────────
app.post('/api/alumnos/unificar', auth(ADM), (req, res) => {
  const { conservar_id, eliminar_id } = req.body;
  if (!conservar_id || !eliminar_id || conservar_id === eliminar_id)
    return res.status(400).json({ error: 'IDs inválidos' });

  const conservar = db.prepare('SELECT * FROM alumnos WHERE id=?').get(conservar_id);
  const eliminar  = db.prepare('SELECT * FROM alumnos WHERE id=?').get(eliminar_id);
  if (!conservar || !eliminar)
    return res.status(404).json({ error: 'Alumno no encontrado' });

  try {
    db.pragma('foreign_keys = OFF');
    const unif = db.transaction(() => {
      const log = [];

      // 1. PAGOS — reasignar los del duplicado al conservado
      //    Si ya hay un pago del mismo mes+concepto en conservar, igual se mueve
      //    (mismo alumno, puede haber pagado 2 meses en el mismo nombre)
      const pagosElim = db.prepare(
        "SELECT id, concepto, fecha_pago, strftime('%Y-%m',fecha_pago) as mes_anio FROM pagos WHERE alumno_id=?"
      ).all(eliminar_id);

      pagosElim.forEach(p => {
        db.prepare('UPDATE pagos SET alumno_id=? WHERE id=?').run(conservar_id, p.id);
        log.push(`pago_movido: ${p.id} (${p.mes_anio} ${p.concepto})`);
      });

      // 2. NOTAS — por asignacion_id
      //    Si conservar ya tiene nota para esa asignacion, fusionar campos vacíos
      //    Si no, reasignar directamente
      const notasElim = db.prepare('SELECT * FROM notas WHERE alumno_id=?').all(eliminar_id);
      notasElim.forEach(ne => {
        const exist = db.prepare('SELECT * FROM notas WHERE alumno_id=? AND asignacion_id=?').get(conservar_id, ne.asignacion_id);
        if (!exist) {
          db.prepare('UPDATE notas SET alumno_id=? WHERE id=?').run(conservar_id, ne.id);
          log.push(`nota_movida: ${ne.id}`);
        } else {
          // Fusionar: llenar campos nulos en conservar con valores del duplicado
          // (incluye tp_total/puntaje_total/nota_final: son calculados, si no se copian
          // quedan en null aunque los puntajes individuales sí se hayan movido)
          const campos = ['tp1','tp2','tp3','tp4','tp5','tp_total','parcial','parcial_recuperatorio',
            'parcial_efectivo','final_ord','final_recuperatorio','complementario','extraordinario',
            'final_efectivo','puntaje_total','nota_final','director_pts'];
          const sets = campos.filter(c => (exist[c]==null||exist[c]==='') && ne[c]!=null && ne[c]!=='')
            .map(c => `${c}=${ne[c]}`);
          if (sets.length) {
            db.prepare(`UPDATE notas SET ${sets.join(',')} WHERE id=?`).run(exist.id);
            log.push(`nota_fusionada: ${exist.id} campos=[${sets.join(',')}]`);
          }
          db.prepare('DELETE FROM notas WHERE id=?').run(ne.id);
        }
      });

      // 3. ASISTENCIA — reasignar fila por fila (UNIQUE alumno_id+asignacion_id+fecha:
      //    si ambos ya tienen asistencia para la misma clase/fecha, se descarta la del
      //    duplicado y se conserva la del registro que queda, en vez de fallar el UPDATE masivo)
      const asistElim = db.prepare('SELECT id, asignacion_id, fecha FROM asistencia WHERE alumno_id=?').all(eliminar_id);
      let asistMovida = 0;
      asistElim.forEach(as => {
        const existeAsist = db.prepare('SELECT id FROM asistencia WHERE alumno_id=? AND asignacion_id=? AND fecha=?').get(conservar_id, as.asignacion_id, as.fecha);
        if (existeAsist) db.prepare('DELETE FROM asistencia WHERE id=?').run(as.id);
        else { db.prepare('UPDATE asistencia SET alumno_id=? WHERE id=?').run(conservar_id, as.id); asistMovida++; }
      });
      if (asistElim.length) log.push(`asistencia_movida: ${asistMovida}/${asistElim.length} registros (resto: fecha duplicada, descartado)`);

      // 4. BECAS, HABILITACIONES, CONSTANCIAS, QR_CAMBIOS
      db.prepare('UPDATE becas SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE habilitaciones_examen SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE constancias SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);
      db.prepare('UPDATE qr_cambios SET alumno_id=? WHERE alumno_id=?').run(conservar_id, eliminar_id);

      // 5. Completar datos faltantes en conservar con los del duplicado
      const a = conservar, b = eliminar;
      const campos2 = ['telefono','ci','matricula'];
      campos2.forEach(c => {
        if ((!a[c] || a[c]==='') && b[c]) {
          db.prepare(`UPDATE alumnos SET ${c}=? WHERE id=?`).run(b[c], conservar_id);
          log.push(`campo_completado: ${c}=${b[c]}`);
        }
      });

      // 6. Guardar en papelera y borrar duplicado
      const snapElim = { alumno: eliminar, motivo: 'unificacion_duplicados', conservar_id };
      const pid = 'pap_'+Date.now()+'_dup';
      const expira = new Date(Date.now()+30*24*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      db.prepare('INSERT OR IGNORE INTO papelera (id,tipo,nombre_display,datos_json,eliminado_por,expira_en) VALUES (?,?,?,?,?,?)')
        .run(pid,'alumno_duplicado',`${eliminar.apellido||''}, ${eliminar.nombre||''} (duplicado unificado)`,
          JSON.stringify(snapElim), req.user?.id||null, expira);

      db.prepare('DELETE FROM alumnos WHERE id=?').run(eliminar_id);
      // Eliminar usuario del duplicado si existe y no es el mismo usuario
      if (eliminar.usuario_id && eliminar.usuario_id !== conservar.usuario_id) {
        db.prepare('DELETE FROM usuarios WHERE id=?').run(eliminar.usuario_id);
      }

      log.push(`duplicado_eliminado: ${eliminar_id}`);
      audit(req.user?.id, 'UNIFICAR_DUPLICADOS', 'alumnos', conservar_id,
        { conservar: conservar_id, eliminado: eliminar_id, log });
      return { ok: true, log };
    });

    const result = unif();
    db.pragma('foreign_keys = ON');
    res.json(result);
  } catch(e) {
    db.pragma('foreign_keys = ON');
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/solicitudes-registro', auth(ADM), (req, res) => {
  try {
    const sede = req.user.sede || 'pjc';
    const rows = db.prepare(`
      SELECT sr.*, sr.tipo, sr.alumno_id, c.nombre as carrera_nombre,
        cu.anio as curso_anio, cu.division as curso_division,
        al.nombre as al_nombre, al.apellido as al_apellido, al.matricula as al_matricula,
        al.usuario_id as al_usuario_id, alc.nombre as al_carrera_nombre,
        alcu.anio as al_curso_anio, alcu.division as al_curso_division
      FROM solicitudes_registro sr
      JOIN carreras c ON sr.carrera_id=c.id
      LEFT JOIN cursos cu ON sr.curso_id=cu.id
      LEFT JOIN alumnos al ON sr.alumno_id=al.id
      LEFT JOIN carreras alc ON al.carrera_id=alc.id
      LEFT JOIN cursos alcu ON al.curso_id=alcu.id
      WHERE c.sede_id=?
      ORDER BY sr.fecha DESC
    `).all(sede);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/solicitudes-registro/:id/resolver', auth(ADM), (req, res) => {
  const { accion, motivo } = req.body;
  const sol = db.prepare('SELECT * FROM solicitudes_registro WHERE id=?').get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (accion === 'aprobar') {
      // Shortcut: cambio de carrera — solo mover al alumno existente
      if (sol.tipo === 'cambio_carrera' && sol.alumno_id) {
        try {
          const updFields = ['carrera_id=?']; const updVals = [sol.carrera_id];
          if (sol.curso_id) { updFields.push('curso_id=?'); updVals.push(sol.curso_id); }
          updFields.push("estado='Activo'");
          updVals.push(sol.alumno_id);
          db.prepare(`UPDATE alumnos SET ${updFields.join(',')} WHERE id=?`).run(...updVals);
          if (sol.curso_id) {
            const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
            if (periodo) {
              const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(sol.curso_id, periodo.id);
              asigs.forEach((asig, i) => {
                db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)')
                  .run('n_cc_'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,5), sol.alumno_id, asig.id, 'Pendiente');
              });
            }
          }
          db.prepare("UPDATE solicitudes_registro SET estado='aprobado' WHERE id=?").run(req.params.id);
          audit(req.user.id,'APROBAR_CAMBIO_CARRERA','solicitudes_registro',req.params.id,{alumno_id:sol.alumno_id,carrera_id:sol.carrera_id});
          return res.json({ ok: true, tipo: 'cambio_carrera' });
        } catch(e) { return res.status(500).json({ error: e.message }); }
      }
      // Shortcut: incorporación académica — el alumno ya existe, solo crear/activar su usuario
      if (sol.tipo === 'incorporacion_academica' && sol.alumno_id) {
        try {
          const alumno = db.prepare('SELECT * FROM alumnos WHERE id=?').get(sol.alumno_id);
          if (!alumno) return res.status(404).json({ error: 'El alumno ya no existe en el sistema' });
          const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
          let finalUid = alumno.usuario_id;
          if (!finalUid) {
            const ciRaw = String(alumno.ci||sol.ci||'').replace(/[^0-9]/g,'');
            // Reusar usuario existente por CI (evita choque con UNIQUE usuarios.ci si ya hay
            // un usuario huérfano con esa cédula, en vez de fallar la aprobación)
            const existPorCi = ciRaw ? db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw) : null;
            if (existPorCi) {
              finalUid = existPorCi.id;
              db.prepare('UPDATE usuarios SET activo=1 WHERE id=?').run(finalUid);
            } else {
              let emailFinal = norm(alumno.nombre).slice(0,1)+norm(alumno.apellido)+'@its.edu.py';
              if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailFinal))
                emailFinal = norm(alumno.nombre).slice(0,1)+norm(alumno.apellido)+'.'+(ciRaw.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
              finalUid = 'u_a_'+Date.now();
              db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
                .run(finalUid, alumno.nombre, alumno.apellido, ciRaw||null, emailFinal, require('bcryptjs').hashSync(ciRaw||'123456',10), 'alumno');
            }
            db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(finalUid, alumno.id);
          } else {
            db.prepare('UPDATE usuarios SET activo=1 WHERE id=?').run(finalUid);
          }
          db.prepare("UPDATE solicitudes_registro SET estado='aprobado' WHERE id=?").run(req.params.id);
          audit(req.user.id,'APROBAR_INCORPORACION_ACADEMICA','solicitudes_registro',req.params.id,{alumno_id:alumno.id});
          if (sol.telefono) {
            const usu = db.prepare('SELECT email FROM usuarios WHERE id=?').get(finalUid);
            const ciNum = String(alumno.ci||sol.ci||'').replace(/[^0-9]/g,'');
            enviarBienvenidaQR(sol.telefono, (alumno.nombre+' '+alumno.apellido).trim(), usu?.email||'(ver en el sistema)', ciNum);
          }
          return res.json({ ok: true, tipo: 'incorporacion_academica' });
        } catch(e) { return res.status(500).json({ error: e.message }); }
      }
    try {
      db.transaction(() => {
        const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
        const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');

        // ── 1. Encontrar o crear usuario ────────────────────────────────────
        const existPorCi = ciRaw ? db.prepare('SELECT id, rol FROM usuarios WHERE ci=?').get(ciRaw) : null;
        const existPorNombre = !existPorCi ? db.prepare("SELECT id, rol FROM usuarios WHERE lower(nombre)=? AND lower(apellido)=? LIMIT 1").get(norm(sol.nombre), norm(sol.apellido)) : null;
        let finalUid;
        if (existPorCi) {
          finalUid = existPorCi.id;
          if (existPorCi.rol === 'alumno') db.prepare('UPDATE usuarios SET activo=1 WHERE id=?').run(finalUid);
        } else if (existPorNombre) {
          finalUid = existPorNombre.id;
          if (existPorNombre.rol === 'alumno') db.prepare('UPDATE usuarios SET activo=1 WHERE id=?').run(finalUid);
        } else {
          let emailFinal = norm(sol.nombre).slice(0,1)+norm(sol.apellido)+'@its.edu.py';
          if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailFinal))
            emailFinal = norm(sol.nombre).slice(0,1)+norm(sol.apellido)+'.'+(ciRaw.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
          finalUid = 'u_a_'+Date.now();
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
            .run(finalUid, sol.nombre, sol.apellido, ciRaw, emailFinal, require('bcryptjs').hashSync(ciRaw||'123456',10), 'alumno');
        }

        // ── 2. Encontrar o crear alumno, siempre sincronizar datos ─────────
        const yaAlumno = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(finalUid);
        let aid;
        if (!yaAlumno) {
          const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(sol.carrera_id);
          const yr = nowSys().getFullYear();
          const prefix = `${carr?.codigo||'ALU'}-${yr}-`;
          const existingMats = db.prepare('SELECT matricula FROM alumnos WHERE carrera_id=? AND matricula LIKE ?').all(sol.carrera_id, prefix+'%');
          const maxNum = existingMats.reduce((mx,r)=>{ const n=parseInt((r.matricula||'').slice(prefix.length))||0; return Math.max(mx,n); },0);
          const matricula = `${prefix}${String(maxNum+1).padStart(3,'0')}`;
          aid = 'a_'+Date.now();
          db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido,telefono) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(aid, finalUid, matricula, sol.carrera_id, sol.curso_id||null, nowDate(), 'Activo', ciRaw, sol.nombre, sol.apellido, sol.telefono||'');
        } else {
          aid = yaAlumno.id;
          // Sincronizar: carrera, curso, estado, datos personales — igual que un alumno nuevo
          const upd = ['carrera_id=?', 'estado=\'Activo\'', 'nombre=?', 'apellido=?'];
          const upv = [sol.carrera_id, sol.nombre, sol.apellido];
          if (sol.curso_id) { upd.push('curso_id=?'); upv.push(sol.curso_id); }
          if (ciRaw)        { upd.push('ci=?');       upv.push(ciRaw); }
          if (sol.telefono) { upd.push('telefono=?');  upv.push(sol.telefono); }
          upv.push(aid);
          db.prepare(`UPDATE alumnos SET ${upd.join(',')} WHERE id=?`).run(...upv);
        }

        // ── 3. Crear notas para todas las asignaciones del periodo activo ──
        const cursoId = sol.curso_id;
        if (cursoId) {
          const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
          if (periodo) {
            const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(cursoId, periodo.id);
            asigs.forEach((asig, i) => {
              try { db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_qr_'+Date.now()+'_'+i+'_'+Math.random().toString(36).slice(2,5), aid, asig.id, 'Pendiente'); } catch {}
            });
          }
        }
        db.prepare("UPDATE solicitudes_registro SET estado='aprobado' WHERE id=?").run(req.params.id);
      })();
      audit(req.user.id,'APROBAR_REGISTRO','solicitudes_registro',req.params.id,{nombre:sol.nombre});
      // Enviar WhatsApp de bienvenida con credenciales al alumno aprobado
      if (sol.telefono) {
        const usuAprobado = db.prepare('SELECT u.email FROM alumnos a JOIN usuarios u ON a.usuario_id=u.id WHERE a.ci=? OR (a.nombre=? AND a.apellido=?) LIMIT 1')
          .get(String(sol.ci||'').replace(/[^0-9]/g,''), sol.nombre, sol.apellido);
        const ciNum = String(sol.ci||'').replace(/[^0-9]/g,'');
        const nombreCompleto = (sol.nombre||'')+' '+(sol.apellido||'');
        enviarBienvenidaQR(sol.telefono, nombreCompleto.trim(), usuAprobado?.email||'(ver en el sistema)', ciNum);
      }
    } catch(e) { return res.status(500).json({ error: e.message }); }
  } else {
    db.prepare("UPDATE solicitudes_registro SET estado='rechazado',motivo_rechazo=? WHERE id=?").run(motivo||'', req.params.id);
    audit(req.user.id,'RECHAZAR_REGISTRO','solicitudes_registro',req.params.id,{motivo});
  }
  res.json({ ok: true });
});

// ── BÚSQUEDA GLOBAL DE ALUMNOS (para registro QR) ────────────────────────────
app.get('/pub/buscar-alumno', (req, res) => {
  const { q, carrera_id, curso_id } = req.query;
  const ciParam = String(req.query.ci||'').replace(/[^0-9]/g,'');
  const qTrim = (q||'').trim();
  if (qTrim.length < 2 && ciParam.length < 4) return res.json([]);

  // Normalización segura con escape Unicode explícito (evita corrupción CRLF)
  const norm = s => (s||'').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes/acentos
    .replace(/[^a-z0-9 ]/g, '')        // solo letras, dígitos y espacio
    .replace(/\s+/g, ' ')
    .trim();

  const qNorm   = norm(qTrim);
  const palabras = qNorm.split(' ').filter(p => p.length >= 2);

  try {
    // JOIN con usuarios para capturar nombres que solo están en esa tabla
    const todos = db.prepare(`
      SELECT al.id, al.estado, al.curso_id, al.carrera_id, al.telefono,
        COALESCE(al.nombre,   u.nombre,   '') AS nombre,
        COALESCE(al.apellido, u.apellido, '') AS apellido,
        COALESCE(al.ci,       u.ci,       '') AS ci,
        c.nombre  AS carrera_nombre,
        cu.anio   AS curso_anio,
        cu.division AS curso_division
      FROM alumnos al
      LEFT JOIN usuarios  u  ON al.usuario_id  = u.id
      LEFT JOIN carreras  c  ON al.carrera_id  = c.id
      LEFT JOIN cursos    cu ON al.curso_id     = cu.id
      WHERE al.estado NOT IN ('Retirado','Inactivo')
      ORDER BY COALESCE(al.apellido, u.apellido), COALESCE(al.nombre, u.nombre)
    `).all();

    const filtrados = todos.filter(a => {
      const nom = norm(a.nombre);
      const ape = norm(a.apellido);
      // Partes individuales del nombre completo (para matching por inicio de palabra)
      const partes = (ape + ' ' + nom).split(' ').filter(Boolean);
      const aCi = String(a.ci||'').replace(/[^0-9]/g,'');

      // CI filter (if ci param provided, must match)
      if (ciParam.length >= 4) {
        if (!aCi || !aCi.includes(ciParam)) return false;
        // If no name query, CI alone is enough
        if (!palabras.length) return true;
      }

      // Name filter
      if (!palabras.length) return false;
      // Cada palabra buscada debe encontrarse al INICIO de alguna parte del nombre
      // Ej: "garc" → matchea "garcia" pero NO "angelica"
      return palabras.every(p => partes.some(parte => parte.startsWith(p)));
    });

    const resultado = filtrados.slice(0, 15).map(a => {
      const mismaCarrera = carrera_id && a.carrera_id === carrera_id;
      const mismoCurso   = curso_id   && a.curso_id   === curso_id;
      let match_tipo;
      if      (!a.carrera_id)                    match_tipo = 'sin_asignar';
      else if (mismaCarrera && mismoCurso)        match_tipo = 'perfecto';
      else if (mismaCarrera && !a.curso_id)       match_tipo = 'misma_carrera_sin_curso';
      else if (mismaCarrera)                      match_tipo = 'misma_carrera_otro_curso';
      else                                        match_tipo = 'otra_carrera';
      return { ...a, match_tipo };
    });
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OLVIDÉ MI CONTRASEÑA (público, autoservicio con verificación de identidad) ──
// Sin email/SMS configurado: se verifica identidad pidiendo varios datos que
// deben coincidir TODOS con la ficha real del alumno (nombre, CI, usuario,
// carrera, curso y teléfono). Si coinciden, se resetea la contraseña
// directamente a los últimos 3 dígitos de la cédula — es el mismo valor que
// /api/login ya acepta siempre como atajo para alumnos (server.js ~línea 1293),
// así que no tiene sentido dejar elegir una contraseña personalizada: quedaría
// pisada la próxima vez que alguien entre con esos 3 dígitos igual.
app.post('/pub/olvide-password/verificar', (req, res) => {
  const { nombre, apellido, ci, usuario, carrera_id, curso_id, telefono } = req.body;
  const norm = s => (s||'').toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!nombre || !apellido) return res.status(400).json({ error: 'Nombre y apellido son requeridos' });
  const ciNorm = String(ci||'').replace(/[^0-9]/g,'');
  if (ciNorm.length < 4) return res.status(400).json({ error: 'Ingresá tu número de cédula' });
  if (!usuario || !usuario.trim()) return res.status(400).json({ error: 'Ingresá tu usuario' });
  if (!carrera_id || !curso_id) return res.status(400).json({ error: 'Seleccioná tu carrera, año y sección' });
  const telNorm = String(telefono||'').replace(/[^0-9]/g,'');
  if (telNorm.length < 7) return res.status(400).json({ error: 'Ingresá tu número de teléfono' });

  const GENERICO = { error: 'Los datos ingresados no coinciden con ningún alumno registrado. Verificá que estén bien escritos.' };
  try {
    const alumno = db.prepare(`
      SELECT al.*, u.id as usuario_real_id, u.ci as usuario_ci, u.email as usuario_email, u.activo as usuario_activo
      FROM alumnos al LEFT JOIN usuarios u ON al.usuario_id=u.id
      WHERE al.ci=? AND al.estado='Activo'
    `).get(ciNorm);
    if (!alumno || !alumno.usuario_real_id) return res.status(404).json(GENERICO);
    if (norm(alumno.nombre) !== norm(nombre) || norm(alumno.apellido) !== norm(apellido)) return res.status(404).json(GENERICO);
    if (alumno.carrera_id !== carrera_id || alumno.curso_id !== curso_id) return res.status(404).json(GENERICO);
    if (String(alumno.telefono||'').replace(/[^0-9]/g,'') !== telNorm) return res.status(404).json(GENERICO);
    const usuarioIngresado = norm(usuario).replace(/[^a-z0-9@. ]/gi,'').trim();
    const matchUsuario = (alumno.usuario_ci && alumno.usuario_ci===ciNorm) || (alumno.usuario_email && norm(alumno.usuario_email)===norm(usuario)) || usuarioIngresado===ciNorm;
    if (!matchUsuario) return res.status(404).json(GENERICO);
    if (!alumno.usuario_activo) return res.status(403).json({ error: 'Tu usuario está inactivo. Comunicate con Dirección.' });

    const ultimos3 = ciNorm.slice(-3);
    const hash = require('bcryptjs').hashSync(ciNorm, 10);
    db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(hash, alumno.usuario_real_id);
    audit(alumno.usuario_real_id, 'RESET_PASSWORD_AUTOSERVICIO', 'usuarios', alumno.usuario_real_id, {});
    res.json({ ok: true, ultimos3 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/registro', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','registro.html')));
app.get('/inscripcion', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','inscripcion.html')));
app.get('/incorporacion-academica', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','incorporacion-academica.html')));
app.get('/formulario/:id', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','formulario-publico.html')));
// ── RSVP FIORELLA ─────────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS rsvp_fiorella (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    cantidad INTEGER DEFAULT 1,
    telefono TEXT,
    mensaje TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime'))
  )`).run();
} catch {}
app.post('/api/rsvp/fiorella', (req, res) => {
  const { nombre, cantidad, telefono, mensaje } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });
  db.prepare('INSERT INTO rsvp_fiorella (nombre, cantidad, telefono, mensaje) VALUES (?,?,?,?)')
    .run(nombre.trim(), parseInt(cantidad)||1, telefono||null, mensaje||null);
  res.json({ ok: true });
});
app.get('/api/rsvp/fiorella', auth(['director']), (req, res) => {
  const lista = db.prepare('SELECT * FROM rsvp_fiorella ORDER BY id DESC').all();
  res.json({ lista, total: lista.reduce((s,r)=>s+r.cantidad,0) });
});
app.get('/invitacion-fiorella', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','invitacion-fiorella.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','index.html')));
// ── SEMBRAR ARANCELES EXÁMENES CON COSTO ─────────────────────────────────────
try {
  const arancelesSeed = [
    { id: 'ar_parcial_rec',  tipo: 'parcial_recuperatorio', concepto: 'Examen Parcial Recuperatorio', monto: 30000  },
    { id: 'ar_final_ord',    tipo: 'final_ordinario',       concepto: 'Examen Final Ordinario',       monto: 50000  },
    { id: 'ar_final_rec',    tipo: 'final_recuperatorio',   concepto: 'Examen Final Recuperatorio',   monto: 80000  },
    { id: 'ar_complem',      tipo: 'complementario',        concepto: 'Examen Final Complementario',  monto: 120000 },
    { id: 'ar_extraord',     tipo: 'extraordinario',        concepto: 'Examen Final Extraordinario',  monto: 200000 },
    { id: 'ar_constancia',   tipo: 'constancia',            concepto: 'Constancia de estudios',       monto: 30000  },
  ];
  for (const ar of arancelesSeed) {
    const existing = db.prepare('SELECT id FROM aranceles WHERE tipo=? AND carrera_id IS NULL').get(ar.tipo);
    if (!existing) {
      try {
        db.prepare('INSERT INTO aranceles (id,concepto,monto,tipo,carrera_id,descripcion,anio,activo) VALUES (?,?,?,?,NULL,NULL,NULL,1)')
          .run(ar.id, ar.concepto, ar.monto, ar.tipo);
        console.log(`✓ Arancel sembrado: ${ar.concepto} — Gs. ${ar.monto}`);
      } catch(e2) { console.error('Arancel seed error:', ar.tipo, e2.message); }
    }
  }
} catch(e) { console.error('Aranceles seed error:', e.message); }

app.listen(PORT, () => {
  console.log(`✓ ITS v4 en http://localhost:${PORT}`);
  // Auto-reconectar WhatsApp al arranque si estaba conectado previamente
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (EVO_URL && EVO_KEY && EVO_INSTANCE) {
    setTimeout(async () => {
      try {
        const r = await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
        const d = await r.json().catch(() => ({}));
        const state = d?.instance?.state || d?.state || '';
        if (state !== 'open') {
          console.log('[WA] Estado al arranque:', state, '— intentando reconectar...');
          await fetch(`${EVO_URL}/instance/connect/${EVO_INSTANCE}`, { method: 'GET', headers: { apikey: EVO_KEY } });
          console.log('[WA] Reconexión iniciada.');
        } else {
          console.log('[WA] ✅ WhatsApp conectado al arranque.');
        }
      } catch(e) { console.warn('[WA] Auto-reconectar falló:', e.message); }
    }, 5000);
    // Configurar webhook para recibir mensajes entrantes (bot de admisiones)
    setTimeout(async () => {
      try {
        const APP_URL = process.env.APP_URL || 'https://its-sistema-production.up.railway.app';
        await fetch(`${EVO_URL.replace(/\/+$/,'')}/webhook/set/${EVO_INSTANCE}`, {
          method: 'POST',
          headers: { 'apikey': EVO_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook: { enabled: true, url: `${APP_URL}/webhook/whatsapp`, events: ['MESSAGES_UPSERT', 'CONTACTS_UPSERT'] } })
        });
        console.log('[BOT] ✅ Webhook Evolution configurado →', APP_URL+'/webhook/whatsapp');
      } catch(e) { console.warn('[BOT] Webhook config falló:', e.message); }
    }, 8000);
  }
});
