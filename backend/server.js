process.env.TZ = 'America/Asuncion';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { db, init, calcularPuntaje, DB_PATH } = require('./db');


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
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: { error: 'Demasiados intentos de login. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300,
  message: { error: 'Demasiadas solicitudes. Esperá un momento.' },
});

app.use(express.json());
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));
init();

// ── MIGRACIÓN: asignacion_id en pagos (para vincular pago con materia habilitada) ──
try {
  const cols = db.prepare("PRAGMA table_info(pagos)").all().map(c => c.name);
  if (!cols.includes('asignacion_id')) {
    db.prepare("ALTER TABLE pagos ADD COLUMN asignacion_id TEXT REFERENCES asignaciones(id)").run();
    console.log('[Migración] pagos.asignacion_id agregado');
  }
} catch(e) { console.warn('[Migración] pagos.asignacion_id:', e.message); }

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


// Backup a Google Drive (requiere GOOGLE_SERVICE_ACCOUNT_JSON y GOOGLE_DRIVE_FOLDER_ID en Railway)
const { cloudBackupDrive } = require('./cloud-backup');
setTimeout(() => cloudBackupDrive(DB_PATH), 15000);


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
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  let docenteId = null, alumnoId = null;
  if (u.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(u.id);
    docenteId = doc?.id || null;
  }
  if (u.rol === 'alumno') alumnoId = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(u.id)?.id;
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId, alumnoId }, JWT_SECRET, { expiresIn: '8h' });
  audit(u.id, 'LOGIN', 'usuarios', u.id, { email: u.email });
  res.json({ token, user: { id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId, alumnoId } });
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
app.get('/api/institucion', auth(), (req, res) => res.json(db.prepare('SELECT * FROM institucion WHERE id=1').get()));
app.put('/api/institucion', auth(ADM), (req, res) => {
  const { nombre, telefono, email, direccion, mision } = req.body;
  db.prepare('UPDATE institucion SET nombre=?,telefono=?,email=?,direccion=?,mision=? WHERE id=1').run(nombre,telefono||'',email||'',direccion||'',mision||'');
  res.json({ ok: true });
});
app.post('/api/institucion/logo', auth(ADM), upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  db.prepare('UPDATE institucion SET logo_base64=? WHERE id=1').run(b64);
  res.json({ ok: true, logo_base64: b64 });
});

// ── PERÍODOS ──────────────────────────────────────────────────────────────────
app.get('/api/periodos', auth(), (req, res) => res.json(db.prepare('SELECT * FROM periodos ORDER BY anio DESC').all()));
app.post('/api/periodos', auth(ADM), (req, res) => {
  const { nombre, anio, semestre, fecha_inicio, fecha_fin } = req.body;
  const id = db.prepare('INSERT INTO periodos (nombre,anio,semestre,fecha_inicio,fecha_fin) VALUES (?,?,?,?,?)').run(nombre,anio,semestre,fecha_inicio,fecha_fin).lastInsertRowid;
  res.json({ id });
});
app.put('/api/periodos/:id/activar', auth(ADM), (req, res) => {
  db.prepare('UPDATE periodos SET activo=0').run();
  db.prepare('UPDATE periodos SET activo=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/periodos/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM periodos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ── CARRERAS ──────────────────────────────────────────────────────────────────
app.get('/api/carreras', auth(), (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(DISTINCT CASE WHEN a.estado='Activo' THEN a.id END) as total_alumnos,
      COUNT(DISTINCT m.id) as total_materias
    FROM carreras c
    LEFT JOIN alumnos a ON c.id=a.carrera_id
    LEFT JOIN materias m ON c.id=m.carrera_id
    GROUP BY c.id ORDER BY c.nombre`).all();
  const cursosPorCarrera = db.prepare('SELECT * FROM cursos ORDER BY carrera_id,anio,division').all();
  rows.forEach(c => {
    c.cursos = cursosPorCarrera.filter(cu => cu.carrera_id === c.id);
  });
  res.json(rows);
});
app.post('/api/carreras', auth(ADM), (req, res) => {
  const { nombre, codigo, turno, semestres } = req.body;
  const id = codigo.toLowerCase().replace(/\s/g,'_') + '_' + Date.now()%1000;
  db.prepare('INSERT INTO carreras (id,nombre,codigo,turno,semestres,activa) VALUES (?,?,?,?,?,1)').run(id,nombre,codigo,turno,semestres||4);
  res.json({ id });
});
app.put('/api/carreras/:id', auth(ADM), (req, res) => {
  const { nombre, codigo, turno, semestres, activa } = req.body;
  db.prepare('UPDATE carreras SET nombre=?,codigo=?,turno=?,semestres=?,activa=? WHERE id=?').run(nombre,codigo,turno,semestres,activa?1:0,req.params.id);
  res.json({ ok: true });
});
app.delete('/api/carreras/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM carreras WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ── CURSOS ────────────────────────────────────────────────────────────────────
app.get('/api/cursos', auth(), (req, res) => {
  const { carrera_id } = req.query;
  const q = `SELECT cu.*,ca.nombre as carrera_nombre,ca.codigo as carrera_codigo,
    (SELECT COUNT(*) FROM alumnos WHERE curso_id=cu.id AND estado='Activo') as total_alumnos
    FROM cursos cu JOIN carreras ca ON cu.carrera_id=ca.id
    ${carrera_id?'WHERE cu.carrera_id=?':''} ORDER BY ca.nombre,cu.anio,cu.division`;
  res.json(carrera_id ? db.prepare(q).all(carrera_id) : db.prepare(q).all());
});
app.post('/api/cursos', auth(ADM), (req, res) => {
  const { carrera_id, anio, division, turno } = req.body;
  const id = `${carrera_id}_${anio}${(division||'u').toLowerCase()}`;
  db.prepare('INSERT OR IGNORE INTO cursos (id,carrera_id,anio,division,turno) VALUES (?,?,?,?,?)').run(id,carrera_id,anio,division||'U',turno||'');
  res.json({ id });
});
app.delete('/api/cursos/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM cursos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ── MATERIAS ──────────────────────────────────────────────────────────────────
app.get('/api/materias', auth(), (req, res) => {
  const { carrera_id } = req.query;
  const q = `SELECT m.*,c.nombre as carrera_nombre,cu.division as curso_division,cu.anio as curso_anio_cu
    FROM materias m
    JOIN carreras c ON m.carrera_id=c.id
    LEFT JOIN cursos cu ON m.curso_id=cu.id
    ${carrera_id?'WHERE m.carrera_id=?':''}
    ORDER BY c.nombre,m.anio,cu.division,m.nombre`;
  res.json(carrera_id ? db.prepare(q).all(carrera_id) : db.prepare(q).all());
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
  res.json(db.prepare(`SELECT u.id,u.nombre,u.apellido,u.ci,u.email,u.activo,
    d.id as docente_id,d.especialidad,d.titulo,d.telefono
    FROM usuarios u JOIN docentes d ON u.id=d.usuario_id WHERE u.rol='docente' ORDER BY u.apellido`).all());
});
app.post('/api/docentes', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, email, password, especialidad, titulo, telefono } = req.body;
  const uid = 'u_'+Date.now(), did = 'd_'+Date.now();
  const ciDoc = ci && ci.trim() && ci.trim() !== '0.000.000' ? ci.trim() : null;
  db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid,nombre,apellido,ciDoc,email,bcrypt.hashSync(password||'123456',10),'docente');
  db.prepare('INSERT INTO docentes (id,usuario_id,especialidad,titulo,telefono) VALUES (?,?,?,?,?)').run(did,uid,especialidad,titulo,telefono);
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
  db.prepare('DELETE FROM docentes WHERE usuario_id=?').run(req.params.uid);
  db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.uid);
  res.json({ ok: true });
});

// ── ALUMNOS ───────────────────────────────────────────────────────────────────
app.get('/api/alumnos', auth(), (req, res) => {
  const { ci, carrera_id, curso_id, busqueda } = req.query;
  // Alumnos solo pueden buscar por CI (su propio estado de cuenta)
  if (req.user.rol === 'alumno' && !ci) return res.status(403).json({ error: 'Sin acceso' });
  let where = req.user.rol==='director' ? 'WHERE 1=1' : "WHERE al.estado NOT IN ('Inactivo','Retirado')"; const params = [];
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
  const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
        // Si ya existe un usuario con esa CI, usar su ID en vez de crear uno nuevo
        const usuExiste = db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw);
        if (usuExiste) {
          userId = usuExiste.id;
        } else {
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid,nombre,apellido,ciRaw,emailAuto,bcrypt.hashSync(ciRaw,10),'alumno');
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
    const credencial = ciRaw ? { email: emailAuto, password: ciRaw } : null;
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
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
          .run(uid, al.nombre, al.apellido, ciRaw, emailFinal, bcrypt.hashSync(ciRaw, 10), 'alumno');
        db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(uid, al.id);
        creados++;
      } else {
        // Actualizar contraseña al CI actual (por si cambió)
        db.prepare('UPDATE usuarios SET email=?,password_hash=?,ci=? WHERE id=?')
          .run(emailFinal, bcrypt.hashSync(ciRaw, 10), ciRaw, al.usuario_id);
        actualizados++;
      }
    } catch(e) { errores.push(al.nombre+': '+e.message); }
  });
  res.json({ creados, actualizados, errores: errores.slice(0,5) });
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
    const a = db.prepare('SELECT id, usuario_id, nombre, apellido, ci FROM alumnos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alumno no encontrado' });
    db.transaction(() => {
      db.prepare('DELETE FROM notas WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM asistencia WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM pagos WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM constancias WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM becas WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM habilitaciones_examen WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM deudas_cuotas WHERE alumno_id=?').run(a.id);
      db.prepare('DELETE FROM solicitudes_egreso WHERE alumno_id=?').run(a.id);
      // Solicitudes de incorporación asociadas al usuario
      if (a.usuario_id) db.prepare('DELETE FROM solicitudes_alumno WHERE registrado_por=?').run(a.usuario_id);
      db.prepare('DELETE FROM alumnos WHERE id=?').run(a.id);
      if (a.usuario_id) db.prepare("DELETE FROM usuarios WHERE id=? AND rol='alumno'").run(a.usuario_id);
    })();
    audit(req.user.id,'DELETE_COMPLETO','alumnos',a.id,{ nombre: a.nombre, apellido: a.apellido, ci: a.ci });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Error al eliminar: '+e.message }); }
});

app.delete('/api/alumnos/:id', auth(ADM), (req, res) => {
  try {
    const a = db.prepare('SELECT usuario_id FROM alumnos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alumno no encontrado' });
    db.transaction(() => {
      db.prepare('DELETE FROM notas WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM asistencia WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM pagos WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM constancias WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM becas WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM habilitaciones_examen WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM deudas_cuotas WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM solicitudes_egreso WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM alumnos WHERE id=?').run(req.params.id);
      if (a.usuario_id) db.prepare('DELETE FROM usuarios WHERE id=?').run(a.usuario_id);
    })();
    audit(req.user.id,'DELETE','alumnos',req.params.id,{});
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
            const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id).n;
            const matricula = `${carr.codigo}-${nowSys().getFullYear()}-${String(cnt + 1).padStart(3, '0')}`;
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
                db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid2,nombre,apellido,ciRaw,emailAuto,bcrypt.hashSync(ciRaw,10),'alumno');
                db.prepare('UPDATE alumnos SET usuario_id=? WHERE ci=?').run(uid2,ciRaw);
              }catch{}
            }
            results.actualizados++;
          } else {
            const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id).n;
            const matricula = `${carr.codigo}-${nowSys().getFullYear()}-${String(cnt + 1).padStart(3, '0')}`;
            const aid = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
            // Usuario: nombre.apellido@its.edu.py · Contraseña: CI completo
            let uid = null;
            const usuExiste = db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw);
            if (!usuExiste) {
              uid = 'u_e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
              try {
                db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid, nombre, apellido, ciRaw, emailAuto, bcrypt.hashSync(ciRaw, 10), 'alumno');
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
        .run(uid,al.nombre,al.apellido,ciRaw,email,bcrypt.hashSync(ciRaw,10),'alumno');
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
  let where = 'WHERE 1=1'; const params = [];
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
app.delete('/api/asignaciones/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM asignaciones WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
      CASE WHEN EXISTS(
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

  res.json({ alumnos });
});

app.put('/api/notas/:alumno_id/:asig_id', auth(['director','docente']), (req, res) => {
  try {
    const asig = db.prepare('SELECT docente_id FROM asignaciones WHERE id=?').get(req.params.asig_id);
    // Docente solo puede editar notas de sus materias
    if (req.user.rol === 'docente') {
      const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
      if (!doc || doc.id !== asig?.docente_id) return res.status(403).json({ error: 'Solo podés cargar notas de tus propias materias' });
    }
    const campos = ['tp1','tp2','tp3','tp4','tp5','parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario','ausente','director_pts'];
    const vals = campos.map(c => req.body[c]===''||req.body[c]===undefined||req.body[c]===null ? null : parseFloat(req.body[c]));
    // Validar habilitación para recuperatorio (director puede siempre)
    if (req.user.rol !== 'director' && vals[6] !== null) {
      const hab = db.prepare(`SELECT 1 FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND habilitado=1 AND (habilitado_recuperatorio=1 OR tipo_examen='parcial_recuperatorio') LIMIT 1`).get(req.params.alumno_id, req.params.asig_id);
      if (!hab) return res.status(403).json({ error: 'El alumno no está habilitado para el recuperatorio en esta materia' });
    }
    const { calcularPuntaje } = require('./db');
    // vals[0..10] = tp1..extraordinario, vals[12] = director_pts
    const nota = calcularPuntaje(...vals.slice(0,11), vals[12]);
    const campos_q = campos.map(c=>`${c}=?`).join(',');
    const extra = ',puntaje_total=?,nota_final=?,estado=?,parcial_efectivo=?,final_efectivo=?';
    db.prepare(`UPDATE notas SET ${campos_q}${extra} WHERE alumno_id=? AND asignacion_id=?`).run(...vals, nota.puntaje, nota.nota, nota.estado, nota.parcial_efectivo, nota.final_efectivo, req.params.alumno_id, req.params.asig_id);
    audit(req.user.id,'UPDATE_NOTA','notas',`${req.params.alumno_id}_${req.params.asig_id}`,{campos:req.body});
    res.json({ puntaje: nota.puntaje, nota: nota.nota, estado: nota.estado, tp_total: nota.tp_total, parcial_efectivo: nota.parcial_efectivo, final_efectivo: nota.final_efectivo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notas/alumno/:alumno_id', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT a.id as asignacion_id, m.nombre as materia_nombre, m.peso_tp, m.peso_parcial, m.peso_final,
      p.nombre as periodo_nombre, ca.nombre as carrera_nombre, cu.anio as curso_anio,
      n.tp1, n.tp2, n.tp3, n.tp4, n.tp5, n.tp_total, n.parcial, n.parcial_recuperatorio,
      n.final_ord, n.final_recuperatorio, n.complementario, n.extraordinario, n.ausente,
      n.puntaje_total, n.nota_final, n.estado, n.parcial_efectivo, n.final_efectivo
    FROM alumnos al
    JOIN cursos cu ON al.curso_id = cu.id
    JOIN carreras ca ON cu.carrera_id = ca.id
    JOIN asignaciones a ON a.curso_id = al.curso_id
    JOIN materias m ON a.materia_id = m.id
    JOIN periodos p ON a.periodo_id = p.id
    LEFT JOIN notas n ON n.asignacion_id = a.id AND n.alumno_id = al.id
    WHERE al.id = ? ORDER BY m.nombre`).all(req.params.alumno_id));
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
  // Alumno solo puede ver su propio resumen
  if (req.user.rol === 'alumno' && al.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
  const registros = db.prepare(`
    SELECT a.estado, m.nombre as materia, COUNT(*) as total
    FROM asistencia a
    JOIN asignaciones asig ON a.asignacion_id=asig.id
    JOIN materias m ON asig.materia_id=m.id
    WHERE a.alumno_id=?
    GROUP BY a.asignacion_id, a.estado
    ORDER BY m.nombre`).all(req.params.alumno_id);
  const todasMaterias = al.curso_id ? db.prepare(`
    SELECT DISTINCT m.nombre as materia
    FROM asignaciones asig
    JOIN materias m ON asig.materia_id = m.id
    WHERE asig.curso_id = ?
    ORDER BY m.nombre`).all(al.curso_id) : [];
  const porMateria = {};
  todasMaterias.forEach(m => {
    porMateria[m.materia] = { materia: m.materia, P: 0, A: 0, T: 0, J: 0 };
  });
  registros.forEach(r => {
    if (!porMateria[r.materia]) porMateria[r.materia] = { materia: r.materia, P: 0, A: 0, T: 0, J: 0 };
    porMateria[r.materia][r.estado] = (porMateria[r.materia][r.estado] || 0) + r.total;
  });
  const resumen = Object.values(porMateria).map(m => ({
    ...m,
    total: m.P + m.A + m.T + m.J,
    pct: m.P + m.A + m.T + m.J > 0 ? Math.round(m.P / (m.P + m.A + m.T + m.J) * 100) : 0
  }));
  res.json(resumen);
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
  let where = 'WHERE 1=1'; const params = [];
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
  res.json({ id });
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
  const feriados = new Set(db.prepare("SELECT fecha FROM feriados WHERE fecha>=? AND fecha<=? AND activo=1").all(desde, hasta).map(f=>f.fecha));

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
    SELECT h.*, m.nombre as materia, ca.nombre as carrera, cu.anio as anio_curso,
      a.turno, a.hora_inicio, a.hora_fin
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
    reemplazos, totalGanado, desde, hasta, mes, anio,
    resumen: { clasesEsperadas, clasesReemplazadas, clasesFeriado, clasesEfectivas: clasesEsperadas - clasesReemplazadas }
  });
});

// ── EXÁMENES ──────────────────────────────────────────────────────────────────
app.get('/api/examenes', auth(), (req, res) => {
  const { periodo_id, carrera_id, tipo, desde, hasta } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (periodo_id) { where += ' AND e.periodo_id=?'; params.push(periodo_id); }
  if (carrera_id) { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (tipo) { where += ' AND e.tipo=?'; params.push(tipo); }
  if (desde) { where += ' AND e.fecha>=?'; params.push(desde); }
  if (hasta) { where += ' AND e.fecha<=?'; params.push(hasta); }
  // Docente: solo ve sus propios exámenes (filtrado en server, no en cliente)
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    if (doc) { where += ' AND a.docente_id=?'; params.push(doc.id); }
  }
  // Alumno: solo ve exámenes de su propia carrera
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (al?.carrera_id) { where += ' AND ca.id=?'; params.push(al.carrera_id); }
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
    const ptsDefault = tipo==='Parcial'||tipo==='Recuperatorio' ? 20 : tipo==='Extraordinario' ? 100 : 50;
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
  db.prepare('DELETE FROM examenes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── RECUPERATORIOS PARCIALES — Preview automático ────────────────────────────
app.get('/api/examenes/preview-recuperatorios-parciales', auth(ADM), (req, res) => {
  try {
    console.log('[RECUP-PREVIEW] Iniciando generación...');
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    if (!periodo) return res.status(400).json({ error: 'No hay período activo' });

    // Normalización consistente con el resto del sistema
    const normDia = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
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

      // Aviso al docente (uno por asignación — evita duplicar si es unificado el mismo docente+fecha)
      try {
        const docKey = `${p.asignacion_id}|${p.fecha}`;
        if (!docentesAvisados.has(docKey)) {
          docentesAvisados.add(docKey);
          const info = db.prepare(`
            SELECT u.nombre, u.apellido, ca.nombre as carrera, cu.anio
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
              `📋 Recuperatorio Parcial programado — ${p.materia}`,
              `Se programó el <strong>Recuperatorio Parcial</strong> de <strong>${p.materia}</strong> (${info.carrera} ${info.anio}°) para el día <strong>${fmtFecha(p.fecha)}</strong> a las <strong>${p.hora}</strong>. Revisá la sección Exámenes para más detalles.`,
              'info', 0, 'docentes', req.user.id
            );
          }
        }
      } catch(avErr) { console.error('Aviso docente error:', avErr.message); }
    });

    // Aviso general a todos los alumnos habilitados para parcial_recuperatorio
    try {
      const totalHab = db.prepare("SELECT COUNT(DISTINCT alumno_id) as n FROM habilitaciones_examen WHERE tipo_examen='parcial_recuperatorio' AND habilitado=1").get();
      if (totalHab?.n > 0) {
        const avAlId = 'av_rpal_' + Date.now();
        db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(
          avAlId,
          '📅 Cronograma de Recuperatorios Parciales publicado',
          `Se publicó el cronograma de <strong>Recuperatorios Parciales</strong> (período: 10 jun – 1 jul 2025). Si estás habilitado/a para rendir, ingresá a la sección <strong>Exámenes</strong> para ver tu fecha y horario.`,
          'info', 0, 'alumnos', req.user.id
        );
      }
    } catch(avErr) { console.error('Aviso alumnos error:', avErr.message); }

    audit(req.user.id, 'CREAR_RECUPERATORIOS_PARCIALES', 'examenes', 'bulk', { creados, errores: errores.length });
    req.app.locals._prevRecupParcial = null;
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
  // Alumno: solo ve exámenes de su carrera
  if (req.user.rol === 'alumno') {
    const al = db.prepare('SELECT carrera_id FROM alumnos WHERE usuario_id=?').get(req.user.id);
    if (al?.carrera_id) { where += ' AND ca.id=?'; params.push(al.carrera_id); }
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
  let whereDestino = '';
  if (rol === 'alumno') {
    whereDestino = "AND (av.destinatario='todos' OR av.destinatario='alumnos')";
  } else if (rol === 'docente') {
    // Docente SOLO ve: sus propios avisos + avisos del director
    // NUNCA ve avisos de otros docentes
    whereDestino = `AND (av.usuario_id='${uid}' OR u.rol='director')`;
  }
  // director ve todos
  res.json(db.prepare(`SELECT av.*,u.nombre as autor_nombre,u.apellido as autor_apellido,u.rol as autor_rol
    FROM avisos av JOIN usuarios u ON av.usuario_id=u.id
    WHERE av.activo=1 ${whereDestino} ORDER BY av.fijado DESC,av.fecha_creacion DESC LIMIT 100`).all());
});
app.post('/api/avisos', auth(['director','docente']), (req, res) => {
  const { titulo, contenido, tipo, fijado, destinatario } = req.body;
  const destMap = {
    'todos':'todos', 'docentes':'docentes', 'alumnos':'alumnos',
    'mis-alumnos':'alumnos', 'director':'todos', 'director-secretaria':'todos'
  };
  const destDB = destMap[destinatario] || 'todos';
  const id = 'av_' + Date.now();
  db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(id,titulo,contenido,tipo||'info',fijado?1:0,destDB,req.user.id);
  audit(req.user.id,'AVISO','avisos',id,{titulo,destinatario,destDB});
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

// ── PAGOS ─────────────────────────────────────────────────────────────────────
app.get('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, carrera_id, curso_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
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
// Perfil financiero de un alumno (consulta para rol alumno)
app.get('/api/pagos/alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT a.*, cu.anio as curso_anio FROM alumnos a LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.id=?').get(req.params.alumno_id);
  // Alumno solo puede ver su propio perfil
  if (req.user.rol === 'alumno' && al?.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
  const pagos = db.prepare(`SELECT p.*,c.nombre as carrera,m.nombre as materia_nombre FROM pagos p JOIN alumnos al ON p.alumno_id=al.id LEFT JOIN carreras c ON al.carrera_id=c.id LEFT JOIN asignaciones asig ON p.asignacion_id=asig.id LEFT JOIN materias m ON asig.materia_id=m.id WHERE p.alumno_id=? ORDER BY p.fecha_pago DESC`).all(req.params.alumno_id);
  const totalPagado = pagos.reduce((s,p)=>s+p.monto,0);
  res.json({ pagos, totalPagado, alumno: al });
});
app.post('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto, fecha_pago, comprobante, descuento, beca, medio_pago, asignacion_id } = req.body;
  // Mapa: concepto exacto → tipo_examen (solo para los 5 exámenes con arancel)
  const ARANCEL_TIPO_MAP = {
    'Examen Parcial Recuperatorio': 'parcial_recuperatorio',
    'Examen Final Ordinario':       'final_ord',
    'Examen Final Recuperatorio':   'final_recuperatorio',
    'Examen Final Complementario':  'complementario',
    'Examen Final Extraordinario':  'extraordinario',
  };
  const tipoExamen = ARANCEL_TIPO_MAP[concepto] || null;
  try {
    // Validar duplicado: mismo alumno + asignacion + tipo_examen
    if (tipoExamen && asignacion_id) {
      const dup = db.prepare('SELECT id FROM habilitaciones_examen WHERE alumno_id=? AND asignacion_id=? AND tipo_examen=?').get(alumno_id, asignacion_id, tipoExamen);
      if (dup) return res.status(400).json({ error: `El alumno ya tiene habilitación registrada para ${concepto} en esta materia. No se puede pagar dos veces el mismo examen en la misma materia.` });
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
    db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,descuento,beca,medio_pago,asignacion_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,alumno_id,periodo_id,concepto,montoPagado,fecha_pago,'Pagado',comprobante||null,descuento||0,beca||null,medio_pago||'Efectivo',asignacion_id||null);
    const alNom = db.prepare('SELECT nombre, apellido FROM alumnos WHERE id=?').get(alumno_id);
    audit(req.user.id,'PAGO','pagos',id,{alumno_id, alumno: alNom?`${alNom.apellido}, ${alNom.nombre}`:alumno_id, concepto, monto:montoPagado, medio_pago});

    // Auto-crear habilitación por pago de examen con arancel (para la materia específica)
    let habilitadoExamen = false;
    if (tipoExamen && asignacion_id) {
      const fechaHoy = nowDate();
      const habId = 'hab_' + Date.now() + '_' + alumno_id;
      const esRecup = tipoExamen === 'parcial_recuperatorio' ? 1 : 0;
      db.prepare('INSERT OR IGNORE INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado,habilitado_por,fecha,motivo,habilitado_recuperatorio) VALUES (?,?,?,?,1,?,?,?,?)')
        .run(habId, alumno_id, asignacion_id, tipoExamen, req.user.id, fechaHoy, 'Habilitado por pago de '+concepto, esRecup);
      habilitadoExamen = true;
      audit(req.user.id, 'HABILITAR_PAGO_EXAMEN', 'habilitaciones_examen', alumno_id, { concepto, tipo_examen: tipoExamen, asignacion_id });
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

    res.json({ ok: true, id, monto_esperado: montoEsperado, monto_pagado: montoPagado, monto_pendiente: montoPendiente, habilitado_examen: habilitadoExamen, tipo_examen: tipoExamen });
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
  const data = db.transaction(() => {
    const periodo = db.prepare('SELECT id,nombre FROM periodos WHERE activo=1').get();
    return {
      total_alumnos:  db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo'").get().n,
      total_docentes: db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE rol='docente' AND activo=1").get().n,
      total_carreras: db.prepare("SELECT COUNT(*) as n FROM carreras WHERE activa=1").get().n,
      total_cursos:   db.prepare("SELECT COUNT(*) as n FROM cursos WHERE activo=1").get().n,
      periodo_activo: periodo?.nombre || 'Sin período activo',
      aprobados:      db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Aprobado'").get().n,
      reprobados:     db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Reprobado'").get().n,
      examenes_hoy:   periodo ? db.prepare("SELECT COUNT(*) as n FROM examenes WHERE fecha=? AND periodo_id=?").get(hoy, periodo.id).n : 0,
      deudores:       periodo ? db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo' AND id NOT IN (SELECT alumno_id FROM pagos WHERE periodo_id=? AND concepto LIKE '%Matrícula%')").get(periodo.id).n : 0,
      por_carrera:    db.prepare("SELECT c.nombre,COUNT(a.id) as total FROM carreras c LEFT JOIN alumnos a ON c.id=a.carrera_id AND a.estado='Activo' WHERE c.activa=1 GROUP BY c.id ORDER BY total DESC").all(),
      avisos:         db.prepare("SELECT id,titulo,contenido,tipo,fijado,fecha_creacion FROM avisos WHERE activo=1 ORDER BY fijado DESC,fecha_creacion DESC LIMIT 5").all(),
      proximos_examenes: periodo ? db.prepare(`
        SELECT e.fecha,e.hora,e.tipo,m.nombre as materia,ca.nombre as carrera,cu.anio,cu.division
        FROM examenes e JOIN asignaciones a ON e.asignacion_id=a.id
        JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id
        JOIN carreras ca ON cu.carrera_id=ca.id
        WHERE e.fecha>=? AND e.periodo_id=? ORDER BY e.fecha,e.hora LIMIT 5`).all(hoy, periodo.id) : []
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
    function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }
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
    function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }
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

    function normId(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,''); }

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

  const norm = h => String(h).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/^["']|["']$/g,'').trim();
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
  const normNombre = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').trim();
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

    const normId = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
            const cnt = stmtCnt.get(carrera_id).n;
            const matricula = carr ? `${carr.codigo}-${nowSys().getFullYear()}-${String(cnt+1).padStart(3,'0')}` : null;
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

    const norm = h => String(h).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/^["']|["']$/g,'').trim();
    const normId = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');

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

            const cnt = stmtCntAlumnos.get(carrera_id).n;
            const matricula = carr ? `${carr.codigo}-${nowSys().getFullYear()}-${String(cnt+1).padStart(3,'0')}` : null;
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
    return destino;
  } catch(e) {
    console.error('Error en backup automático:', e.message);
    return null;
  }
}

// Backup automático diario a las 23:00 hora Paraguay (America/Asuncion)
cron.schedule('0 23 * * *', () => {
  console.log('[BACKUP] Ejecutando backup diario 23:00 PY...');
  hacerBackupAutomatico();
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
  if (accion)     { where += ' AND a.accion=?';      params.push(accion); }
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
    const normStr = (s) => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
async function sendWhatsApp(phone, message) {
  const EVO_URL      = process.env.EVOLUTION_URL;
  const EVO_KEY      = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) {
    console.warn('[WA] Variables EVOLUTION_URL / EVOLUTION_KEY / EVOLUTION_INSTANCE no configuradas');
    return false;
  }
  const numero = normalizarTelefono(phone);
  if (!numero) { console.warn('[WA] Teléfono inválido:', phone); return false; }
  try {
    const resp = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify({ number: numero, textMessage: { text: message } }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[WA] Error Evolution API:', resp.status, JSON.stringify(data));
      return false;
    }
    console.log(`[WA] Enviado a ${numero} → key:${data?.key?.id||'ok'}`);
    return true;
  } catch(e) {
    console.error('[WA] Error fetch:', e.message);
    return false;
  }
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
  sendWhatsApp(telefono, msg).catch(()=>{});
}
// ── HELPER: verificar horario permitido (07:00 – 22:00 Paraguay, lunes a viernes) ─────────
function enHoraPermitida() {
  const py = new Date(new Date().getTime() - 4 * 60 * 60 * 1000);
  const h = py.getUTCHours();
  const dia = py.getUTCDay(); // 0=domingo, 6=sábado
  if (dia === 0 || dia === 6) return false; // prohibido sábado y domingo
  return h >= 7 && h < 22;
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
    AND (e.archivo_nombre IS NULL OR e.archivo_nombre='')`;

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
      const ok   = await sendWhatsApp(ex.doc_telefono, msg);
      const dest = `${ex.doc_apellido||''} ${ex.doc_nombre||''}`.trim();
      const wid  = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(wid, 'programado', 'docente', ex.docente_id||'', dest, ex.doc_telefono, msg, ok?'enviado':'fallido', 'sistema_auto');
      if (ok) {
        db.prepare('INSERT OR IGNORE INTO notif_wa_enviadas (examen_id,intervalo) VALUES (?,?)').run(ex.id, label);
        audit('sistema', 'NOTIFICACION_WA', 'examenes', ex.id, { intervalo: label, tel: ex.doc_telefono });
        total++;
      }
    }
  }
  return total;
}

// ── CRON: Recordatorio 24h — corre a las 8:00 AM lunes a viernes ────────────
cron.schedule('0 8 * * 1-5', async () => {
  if (!enHoraPermitida()) return;
  try {
    const total = await procesarIntervalos([
      { horas: 24, label: '24h' },
    ]);
    console.log(`✓ Cron WA 24h: ${total} mensajes enviados`);
  } catch(e) { console.error('Cron 24h error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── CRON: Recordatorios 12h / 6h — corre cada hora ───────────────────────────
// Usa ventana ±30 min sobre la hora del examen para no perder ninguno.
// La tabla notif_wa_enviadas previene duplicados aunque el cron corra varias veces.
cron.schedule('0 * * * 1-5', async () => {
  if (!enHoraPermitida()) return;
  try {
    const total = await procesarIntervalos([
      { horas: 12, label: '12h' },
      { horas: 6,  label: '6h'  },
    ], true);
    if (total > 0) console.log(`✓ Cron WA 12h/6h: ${total} mensajes enviados`);
  } catch(e) { console.error('Cron 12/6h error:', e.message); }
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
`);

cron.schedule('0 7 * * *', async () => {
  if (!enHoraPermitida()) return;
  const reglaAviso = db.prepare("SELECT valor FROM configuracion WHERE clave='wa_regla_aviso24_activa'").get();
  if (reglaAviso?.valor === '0') return;
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];
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
      const ok = await sendWhatsApp(ex.telefono, msg);
      const rid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_recordatorios_examen (id,examen_id,docente_id,tipo,estado) VALUES (?,?,?,?,?)`).run(rid, ex.id, ex.docente_id, '24h', ok?'enviado':'fallido');
      const wid = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`).run(wid,'programado','docente',ex.docente_id,`${ex.doc_apellido}, ${ex.doc_nombre}`,ex.telefono,msg,ok?'enviado':'fallido','sistema_auto');
      if (ok) enviados++;
    }
    if (enviados > 0) console.log(`[CRON 7AM] Avisos carga examen: ${enviados} enviados`);
  } catch(e) { console.error('[CRON 7AM] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

// ── CRON: Recordatorio horario — carga pendiente ≤7h antes del examen ─────────
// Corre cada hora. Si el examen es hoy, en ≤7h, sin archivo → manda recordatorio.
// Sigue enviando hora a hora hasta que el docente cargue el archivo.
cron.schedule('0 * * * *', async () => {
  if (!enHoraPermitida()) return;
  const reglaUrg = db.prepare("SELECT valor FROM configuracion WHERE clave='wa_regla_urgente_activa'").get();
  if (reglaUrg?.valor === '0') return;
  try {
    const ahora = new Date();
    // Convertir a hora Paraguay (UTC-4)
    const py = new Date(ahora.getTime() - 4 * 60 * 60 * 1000);
    const hoy = py.toISOString().split('T')[0];
    const examenes = stmtExamSinArch.all(hoy);
    let enviados = 0;
    for (const ex of examenes) {
      if (!ex.hora) continue;
      const [hh, mm] = ex.hora.split(':').map(Number);
      // Hora del examen en Paraguay
      const examDate = new Date(py);
      examDate.setHours(hh, mm || 0, 0, 0);
      const diffMs = examDate - py;
      const diffH = diffMs / (1000 * 60 * 60);
      if (diffH <= 0 || diffH > 7) continue; // Solo si es en ≤7h y no pasó
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
      const ok = await sendWhatsApp(ex.telefono, msg);
      const rid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_recordatorios_examen (id,examen_id,docente_id,tipo,estado) VALUES (?,?,?,?,?)`).run(rid, ex.id, ex.docente_id, 'horario', ok?'enviado':'fallido');
      const wid = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,4);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por) VALUES (?,?,?,?,?,?,?,?,?)`).run(wid,'programado','docente',ex.docente_id,`${ex.doc_apellido}, ${ex.doc_nombre}`,ex.telefono,msg,ok?'enviado':'fallido','sistema_auto');
      if (ok) enviados++;
    }
    if (enviados > 0) console.log(`[CRON HORARIO] Recordatorios carga: ${enviados} enviados`);
  } catch(e) { console.error('[CRON HORARIO] Error:', e.message); }
}, { timezone: 'America/Asuncion' });

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
  const ok   = await sendWhatsApp(ex.doc_telefono, msg);
  if (!ok) return res.status(500).json({ error: 'No se pudo enviar. WhatsApp no está conectado — vinculá el dispositivo en la sección WhatsApp.' });
  audit(req.user.id, 'WHATSAPP_MANUAL', 'examenes', ex.id, { tel: ex.doc_telefono });
  res.json({ ok: true, tel: normalizarTelefono(ex.doc_telefono) });
});

// ── WHATSAPP: reglas automáticas (listar / editar / activar-desactivar) ────────
const WA_REGLAS_DEF = [
  { key:'72h',     label:'72 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'48h',     label:'48 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'36h',     label:'36 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'24h',     label:'24 horas antes del examen',   cron:'8:00 AM — lun a vie', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {fecha} {hora}' },
  { key:'12h',     label:'12 horas antes del examen',   cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'6h',      label:'6 horas antes del examen',    cron:'Cada hora (±30 min)', tipo:'recordatorio', defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'3h',      label:'3 horas antes (desactivado)',  cron:'—',                  tipo:'recordatorio', defaultActiva:false, vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'aviso24', label:'Aviso: archivo pendiente 24h',cron:'7:00 AM — diario',   tipo:'carga',        defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora}' },
  { key:'urgente', label:'Urgente: sin archivo ≤7h',    cron:'Cada hora',           tipo:'carga',        defaultActiva:true,  vars:'{docente} {materia} {tipo} {carrera} {curso} {hora} {horas_rest}' },
];
const WA_TPL_DEFAULTS = {
  '72h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '48h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '36h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '24h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '12h':    '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue lo antes posible desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '6h':     '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias!\n_Administración — ITS Santísima Trinidad._',
  '3h':     '📋 *ITS Santísima Trinidad*\n\nEstimado/a Prof. {docente}, le recordamos que tiene *{tipo}* de *{materia}* programado el *{fecha}* a las *{hora}* ({carrera} {curso}).\n\nAún no registramos el archivo del examen en el sistema. Le pedimos que lo cargue a la brevedad desde el portal institucional.\n\n¡Muchas gracias por su comprensión!\n_Administración — ITS Santísima Trinidad._',
  'aviso24':'📋 *Aviso Institucional — Carga de Examen Pendiente*\n\nEstimado/a Prof. {docente}, le informamos que *mañana* tiene examen programado:\n\n📚 *{materia}* ({tipo})\n🎓 {carrera} — {curso}\n🕐 Hora: {hora}\n\nLa institución solicita la carga del archivo del examen con *24 horas de anticipación*.\n\nPor favor, *cargue el archivo lo más pronto posible* ingresando al sistema.\n\n¡Muchas gracias!\n\n_Mensaje automático — Sistema de Gestión ITS._',
  'urgente':'⏰ *Recordatorio Urgente — Archivo de Examen Sin Cargar*\n\nEstimado/a Prof. {docente}:\n\nSu examen de *{materia}* ({tipo}) está programado en *{horas_rest}* y aún no se registra el archivo.\n\n🎓 {carrera} — {curso}\n🕐 Hora programada: {hora}\n\nPor favor, *cargue el archivo lo más pronto posible*.\n\n¡Muchas gracias!\n\n_Mensaje automático — Sistema de Gestión ITS._',
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

// ── WHATSAPP GESTIÓN: estado de conexión ──────────────────────────────────────
app.get('/api/whatsapp/estado', auth(ADM), async (req, res) => {
  const EVO_URL = process.env.EVOLUTION_URL;
  const EVO_KEY = process.env.EVOLUTION_KEY;
  const EVO_INSTANCE = process.env.EVOLUTION_INSTANCE;
  if (!EVO_URL || !EVO_KEY || !EVO_INSTANCE) return res.json({ configurado: false, estado: 'no_configurado' });
  try {
    const r = await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, { headers: { apikey: EVO_KEY } });
    const d = await r.json().catch(()=>({}));
    res.json({ configurado: true, estado: d?.instance?.state || d?.state || 'desconocido', raw: d });
  } catch(e) { res.json({ configurado: true, estado: 'error', mensaje: e.message }); }
});

// ── WHATSAPP GESTIÓN: envío individual ───────────────────────────────────────
app.post('/api/whatsapp/enviar', auth(ADM), async (req, res) => {
  const { telefono, mensaje, destinatario_tipo, destinatario_id, destinatario_nombre } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Teléfono y mensaje requeridos' });
  const ok = await sendWhatsApp(telefono, mensaje);
  const id = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
  db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id,'individual',destinatario_tipo||'custom',destinatario_id||null,destinatario_nombre||null,telefono,mensaje,ok?'enviado':'fallido',req.user.id);
  audit(req.user.id,'WA_INDIVIDUAL','wa_mensajes',id,{ tel: telefono, ok });
  if (!ok) return res.status(500).json({ error: 'No se pudo enviar. Verificá la conexión WhatsApp.' });
  res.json({ ok: true, id });
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
      const ok = await sendWhatsApp(doc.telefono, mensaje);
      const id = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
      db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id,'masivo','docente',doc.id,`${doc.apellido}, ${doc.nombre}`,doc.telefono,mensaje,ok?'enviado':'fallido',req.user.id);
      if (ok) enviados++; else fallidos++;
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

// ── WHATSAPP: webhook para recibir mensajes ───────────────────────────────────
app.post('/api/whatsapp/webhook', (req, res) => {
  try {
    const body = req.body;
    // Evolution API v2 format
    const event = body?.event || body?.type || '';
    const data = body?.data || body;
    if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
      const msg = data?.message || data?.messages?.[0];
      if (msg && !msg?.key?.fromMe) {
        const numero = (msg?.key?.remoteJid || '').replace('@s.whatsapp.net','').replace('@g.us','');
        const texto = msg?.message?.conversation
          || msg?.message?.extendedTextMessage?.text
          || msg?.message?.imageMessage?.caption
          || '';
        const nombre = msg?.pushName || null;
        if (numero && texto) {
          const wrid = 'war_'+Date.now()+'_'+Math.random().toString(36).slice(2,5);
          db.prepare('INSERT INTO wa_recibidos (id,numero,nombre_contacto,mensaje,fecha) VALUES (?,?,?,?,?)')
            .run(wrid, numero, nombre, texto, nowStr());
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── WHATSAPP: mensajes recibidos ──────────────────────────────────────────────
app.get('/api/whatsapp/recibidos', auth(ADM), (req, res) => {
  const rows = db.prepare('SELECT * FROM wa_recibidos ORDER BY fecha DESC LIMIT 100').all();
  const noLeidos = db.prepare('SELECT COUNT(*) as n FROM wa_recibidos WHERE leido=0').get().n;
  res.json({ mensajes: rows, no_leidos: noLeidos });
});
app.put('/api/whatsapp/recibidos/leer-todos', auth(ADM), (req, res) => {
  db.prepare('UPDATE wa_recibidos SET leido=1').run();
  res.json({ ok: true });
});

// ── CRON: mensajes programados (corre cada minuto) ────────────────────────────
cron.schedule('* * * * *', async () => {
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
          const ok = await sendWhatsApp(doc.telefono, prog.mensaje);
          if (ok) {
            env++;
            db.prepare(`INSERT INTO wa_mensajes (id,tipo,destinatario_tipo,destinatario_id,destinatario_nombre,destinatario_telefono,mensaje,estado,enviado_por)
              VALUES (?,?,?,?,?,?,?,?,?)`)
              .run('wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),'programado','docente',doc.id,`${doc.apellido}, ${doc.nombre}`,doc.telefono,prog.mensaje,'enviado',prog.creado_por);
          }
        }
        db.prepare("UPDATE wa_programados SET estado='enviado' WHERE id=?").run(prog.id);
        console.log(`[Programado WA] masivo ${prog.id}: ${env}/${docentes.length} enviados`);
      } else {
        const ok = await sendWhatsApp(prog.destinatario_telefono, prog.mensaje);
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
  res.json(db.prepare(`SELECT s.*, u.nombre as docente_nombre, u.apellido as docente_apellido,
    m.nombre as materia, ca.nombre as carrera
    FROM solicitudes_alumno s
    JOIN docentes d ON s.docente_id=d.id JOIN usuarios u ON d.usuario_id=u.id
    JOIN asignaciones a ON s.asignacion_id=a.id JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id JOIN carreras ca ON cu.carrera_id=ca.id
    ORDER BY s.fecha DESC`).all());
});
// ── VERIFICAR alumno antes de solicitar ─────────────────────────────────────
app.post('/api/solicitudes-alumno/verificar', auth(['director','docente']), (req, res) => {
  try {
    const { nombre, apellido, ci, asignacion_id } = req.body;
    if (!nombre || !asignacion_id) return res.status(400).json({ error: 'Faltan datos' });
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
      const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carreraId||'').n;
      const matricula = (carr?.codigo||'ALU')+'-'+nowSys().getFullYear()+'-'+String(cnt+1).padStart(3,'0');
      const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(finalUid,sol.nombre,sol.apellido,ciRaw,emailFinal,require('bcryptjs').hashSync(ciRaw||'123',10),'alumno');
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
  `);
} catch {}


// ── REGISTRO PÚBLICO VÍA QR ──────────────────────────────────────────────────
const pubLimiter = rateLimit({ windowMs: 60*1000, max: 80 });
app.use('/pub', pubLimiter);

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
  const alumno = db.prepare('SELECT * FROM alumnos WHERE id=? AND carrera_id=?').get(alumno_id, carrera_id);
  if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado en esta carrera' });
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
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
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
  const { nombre, apellido, ci, telefono, carrera_id, curso_id } = req.body;
  if (!nombre || !apellido || !carrera_id) return res.status(400).json({ error: 'Nombre, apellido y carrera son requeridos' });
  const carrera = db.prepare('SELECT id FROM carreras WHERE id=?').get(carrera_id);
  if (!carrera) return res.status(400).json({ error: 'Carrera no válida' });
  const normStr = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  // Verificar duplicado por CI en alumnos
  if (ci) {
    const ciNorm = String(ci).replace(/[^0-9]/g,'');
    if (ciNorm) {
      const existCI = db.prepare(`SELECT a.apellido,a.nombre,c.nombre as carrera,cu.anio FROM alumnos a JOIN carreras c ON a.carrera_id=c.id LEFT JOIN cursos cu ON a.curso_id=cu.id WHERE a.ci=?`).get(ciNorm);
      if (existCI) {
        const detalle = `${existCI.apellido}, ${existCI.nombre} — ${existCI.carrera}${existCI.anio?' · '+existCI.anio+'° año':''}`;
        return res.status(409).json({ error:`Ya existe un alumno registrado con esa cédula: ${detalle}`, duplicate:true });
      }
    }
  }
  // Verificar duplicado por nombre+apellido en la misma carrera
  const existNombre = db.prepare(`SELECT id FROM alumnos WHERE lower(nombre)=? AND lower(apellido)=? AND carrera_id=? LIMIT 1`).get(normStr(nombre), normStr(apellido), carrera_id);
  if (existNombre) return res.status(409).json({ error:`Ya existe un alumno con ese nombre en esta carrera. Si ya estás registrado/a, buscá tu nombre en la lista principal.`, duplicate:true });
  // Verificar solicitud pendiente duplicada
  const existSol = db.prepare(`SELECT id FROM solicitudes_registro WHERE carrera_id=? AND estado='pendiente' AND ((ci!='' AND ci=?) OR (lower(nombre)=? AND lower(apellido)=?)) LIMIT 1`).get(carrera_id, ci||'__', normStr(nombre), normStr(apellido));
  if (existSol) return res.status(409).json({ error:`Ya enviaste una solicitud para esta carrera. El director la revisará pronto.`, duplicate:true });
  const id = 'sreg_'+Date.now();
  db.prepare('INSERT INTO solicitudes_registro (id,nombre,apellido,ci,telefono,carrera_id,curso_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, nombre, apellido, ci||'', telefono||'', carrera_id, curso_id||null);
  res.json({ id, ok: true });
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

app.get('/api/solicitudes-registro', auth(ADM), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sr.*, c.nombre as carrera_nombre,
        cu.anio as curso_anio, cu.division as curso_division
      FROM solicitudes_registro sr
      JOIN carreras c ON sr.carrera_id=c.id
      LEFT JOIN cursos cu ON sr.curso_id=cu.id
      ORDER BY sr.fecha DESC
    `).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/solicitudes-registro/:id/resolver', auth(ADM), (req, res) => {
  const { accion, motivo } = req.body;
  const sol = db.prepare('SELECT * FROM solicitudes_registro WHERE id=?').get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (accion === 'aprobar') {
    try {
      db.transaction(() => {
        const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
        const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
        const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(sol.carrera_id);
        const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(sol.carrera_id).n;
        const matricula = (carr?.codigo||'ALU')+'-'+nowSys().getFullYear()+'-'+String(cnt+1).padStart(3,'0');
        const existPorCi = ciRaw ? db.prepare('SELECT id FROM usuarios WHERE ci=?').get(ciRaw) : null;
        const existPorNombre = !existPorCi ? db.prepare("SELECT id FROM usuarios WHERE lower(nombre)=? AND lower(apellido)=? LIMIT 1").get(norm(sol.nombre), norm(sol.apellido)) : null;
        let finalUid;
        if (existPorCi) {
          finalUid = existPorCi.id;
        } else if (existPorNombre) {
          finalUid = existPorNombre.id;
        } else {
          let emailFinal = norm(sol.nombre).slice(0,1)+norm(sol.apellido)+'@its.edu.py';
          if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailFinal))
            emailFinal = norm(sol.nombre).slice(0,1)+norm(sol.apellido)+'.'+(ciRaw.slice(-3)||String(Date.now()%1000))+'@its.edu.py';
          finalUid = 'u_a_'+Date.now();
          db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)')
            .run(finalUid, sol.nombre, sol.apellido, ciRaw, emailFinal, require('bcryptjs').hashSync(ciRaw||'123456',10), 'alumno');
        }
        const yaAlumno = db.prepare('SELECT id FROM alumnos WHERE usuario_id=?').get(finalUid);
        const aid = yaAlumno ? yaAlumno.id : 'a_'+Date.now();
        if (!yaAlumno) {
          db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,fecha_ingreso,estado,ci,nombre,apellido,telefono) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(aid, finalUid, matricula, sol.carrera_id, nowDate(), 'Activo', ciRaw, sol.nombre, sol.apellido, sol.telefono||'');
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

app.get('/registro', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','registro.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','index.html')));
// ── SEMBRAR ARANCELES EXÁMENES CON COSTO ─────────────────────────────────────
try {
  const arancelesSeed = [
    { id: 'ar_parcial_rec',  tipo: 'parcial_recuperatorio', concepto: 'Examen Parcial Recuperatorio', monto: 30000  },
    { id: 'ar_final_ord',    tipo: 'final_ordinario',       concepto: 'Examen Final Ordinario',       monto: 50000  },
    { id: 'ar_final_rec',    tipo: 'final_recuperatorio',   concepto: 'Examen Final Recuperatorio',   monto: 80000  },
    { id: 'ar_complem',      tipo: 'complementario',        concepto: 'Examen Final Complementario',  monto: 120000 },
    { id: 'ar_extraord',     tipo: 'extraordinario',        concepto: 'Examen Final Extraordinario',  monto: 200000 },
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

app.listen(PORT, () => { console.log(`✓ ITS v4 en http://localhost:${PORT}`); });
