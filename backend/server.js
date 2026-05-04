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
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { db, init, calcularPuntaje, DB_PATH } = require('./db');

// ── EMAIL CONFIG ──────────────────────────────────────────────────────────────
const MAIL_USER = process.env.MAIL_USER || 'institutosantisimatrinidadpjc@gmail.com';
const MAIL_PASS = process.env.MAIL_PASS || 'gestionsantisimatrinidad';
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MAIL_USER, pass: MAIL_PASS }
});
async function sendMail(to, subject, html) {
  if (!to || !to.includes('@')) return false;
  try {
    await mailTransporter.sendMail({
      from: `"ITS Santísima Trinidad" <${MAIL_USER}>`, to, subject, html
    });
    return true;
  } catch(e) { console.error('Email error:', e.message); return false; }
}
function htmlEmail(titulo, cuerpo, pie='') {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:linear-gradient(135deg,#185FA5,#1D9E75);padding:20px;text-align:center">
      <h2 style="color:#fff;margin:0">Instituto Técnico Superior</h2>
      <p style="color:#e0f0ff;margin:4px 0;font-size:13px">Santísima Trinidad</p>
    </div>
    <div style="padding:24px;background:#fff;border:1px solid #e0e0e0">
      <h3 style="color:#1a2a4a">${titulo}</h3>
      ${cuerpo}
    </div>
    <div style="padding:12px;background:#f5f5f5;text-align:center;font-size:11px;color:#888">
      ${pie||'Sistema de Gestión Académica ITS — No responder este correo'}
    </div>
  </div>`;
}

const app = express();
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

// ── AUDITORÍA ─────────────────────────────────────────────────────────────────
function audit(usuario_id, accion, tabla, registro_id, detalle = null) {
  try {
    const fechaHora = new Date().toISOString().replace('T',' ').slice(0,19);
    db.prepare('INSERT INTO auditoria (id,usuario_id,accion,tabla,registro_id,detalle,fecha) VALUES (?,?,?,?,?,?,?)').run(
      'aud_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),
      usuario_id, accion, tabla, String(registro_id||''), detalle ? JSON.stringify(detalle) : null, fechaHora
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
const ADM_SEC = ['director','secretaria'];

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
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId }, JWT_SECRET, { expiresIn: '8h' });
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
  res.json(db.prepare('SELECT id,nombre,apellido,email,ci,rol FROM usuarios WHERE id=?').get(req.user.id));
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
  db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid,nombre,apellido,ci,email,bcrypt.hashSync(password||'123456',10),'docente');
  db.prepare('INSERT INTO docentes (id,usuario_id,especialidad,titulo,telefono) VALUES (?,?,?,?,?)').run(did,uid,especialidad,titulo,telefono);
  res.json({ id: uid, docente_id: did });
});
app.put('/api/docentes/:uid', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, email, especialidad, titulo, telefono } = req.body;
  db.prepare('UPDATE usuarios SET nombre=?,apellido=?,ci=?,email=? WHERE id=?').run(nombre,apellido,ci,email,req.params.uid);
  db.prepare('UPDATE docentes SET especialidad=?,titulo=?,telefono=? WHERE usuario_id=?').run(especialidad,titulo,telefono,req.params.uid);
  res.json({ ok: true });
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
  const { ci, carrera_id, curso_id } = req.query;
  // Alumnos solo pueden buscar por CI (su propio estado de cuenta)
  if (req.user.rol === 'alumno' && !ci) return res.status(403).json({ error: 'Sin acceso' });
  let where = req.user.rol==='director'||req.user.rol==='secretaria' ? 'WHERE 1=1' : "WHERE al.estado NOT IN ('Inactivo','Retirado')"; const params = [];
  if (ci)         { where += ' AND (al.ci LIKE ? OR u.ci LIKE ?)'; params.push('%'+ci+'%','%'+ci+'%'); }
  if (carrera_id) { where += ' AND al.carrera_id=?'; params.push(carrera_id); }
  if (curso_id)   { where += ' AND al.curso_id=?';   params.push(curso_id); }
  res.json(db.prepare(`
    SELECT al.*,
      c.nombre as carrera_nombre, c.codigo as carrera_codigo,
      cu.anio as curso_anio, cu.division as curso_division,
      COALESCE(al.nombre,u.nombre) as display_nombre,
      COALESCE(al.apellido,u.apellido) as display_apellido,
      COALESCE(al.ci,u.ci) as display_ci,
      u.email
    FROM alumnos al
    JOIN carreras c ON al.carrera_id=c.id
    LEFT JOIN cursos cu ON al.curso_id=cu.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    ${where} ORDER BY COALESCE(al.apellido,u.apellido) LIMIT 500`).all(...params));
});
app.post('/api/alumnos', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, telefono, carrera_id, curso_id, fecha_ingreso, estado, email } = req.body;
  const id = 'a_' + Date.now();
  const ciRaw = String(ci||'').replace(/[^0-9]/g,'');
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id||'').n;
  const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carrera_id||'');
  const matricula = `${carr?.codigo||'ALU'}-${new Date().getFullYear()}-${String(cnt+1).padStart(3,'0')}`;
  let emailAuto = email || `${norm(nombre)}.${norm(apellido)}@its.edu.py`;
  if (!email && db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailAuto))
    emailAuto = `${norm(nombre)}.${norm(apellido)}.${ciRaw.slice(-3)||Date.now()%1000}@its.edu.py`;
  const uid = 'u_'+id;
  try {
    db.transaction(() => {
      if (ciRaw) db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid,nombre,apellido,ciRaw,emailAuto,bcrypt.hashSync(ciRaw,10),'alumno');
      db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido,telefono) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,ciRaw?uid:null,matricula,carrera_id||null,curso_id||null,fecha_ingreso||new Date().toISOString().split('T')[0],estado||(!ciRaw?'Pendiente':'Activo'),ciRaw||null,nombre,apellido,telefono||null);
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
app.put('/api/alumnos/:id', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, telefono, direccion, estado, carrera_id, curso_id, usuario_id } = req.body;
  if (usuario_id !== undefined) {
    // Solo actualizar el usuario_id (vinculación)
    db.prepare('UPDATE alumnos SET usuario_id=? WHERE id=?').run(usuario_id, req.params.id);
    return res.json({ ok: true });
  }
  db.prepare('UPDATE alumnos SET nombre=?,apellido=?,ci=?,telefono=?,direccion=?,estado=?,carrera_id=?,curso_id=? WHERE id=?').run(nombre,apellido,ci,telefono,direccion,estado,carrera_id,curso_id||null,req.params.id);
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
      let emailFinal = `${norm(al.nombre)}.${norm(al.apellido)}@its.edu.py`;
      const conflicto = db.prepare('SELECT id FROM usuarios WHERE email=? AND id!=?').get(emailFinal, al.usuario_id||'');
      if (conflicto) emailFinal = `${norm(al.nombre)}.${norm(al.apellido)}.${ciRaw.slice(-3)}@its.edu.py`;
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

app.delete('/api/alumnos/:id', auth(ADM), (req, res) => {
  try {
    const a = db.prepare('SELECT usuario_id FROM alumnos WHERE id=?').get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Alumno no encontrado' });
    db.transaction(() => {
      // Eliminar dependencias primero
      db.prepare('DELETE FROM notas WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM asistencia WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM pagos WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM constancias WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM becas WHERE alumno_id=?').run(req.params.id);
      db.prepare('DELETE FROM habilitaciones_examen WHERE alumno_id=?').run(req.params.id);
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

    const results = { ok: 0, actualizados: 0, errores: [], carrera: carr.nombre, curso: curso_id || '' };
    const dataRows = rows.slice(headerRow + 1);

    db.transaction(() => {
      dataRows.forEach((row, idx) => {
        const ciRaw = String(row[ciCol] || '').trim().replace(/[^0-9]/g, '');
        let nombreCompleto = String(row[nameCol] || '').trim();
        if (!nombreCompleto || !ciRaw || ciRaw.length < 5) return; // fila vacía o sin CI válida

        // Si es modo separado, construir nombre completo
        if (modoSeparado && apellidoCol >= 0) {
          const ap = String(row[apellidoCol] || '').trim();
          nombreCompleto = (ap ? ap + ' ' : '') + nombreCompleto;
        }

        // Parsear nombre: último word = apellido o usar todo como nombre
        const partes = nombreCompleto.split(/\s+/).filter(Boolean);
        let nombre = nombreCompleto, apellido = '';
        if (partes.length >= 3) {
          // Convención: primeras dos palabras = nombre, resto = apellido (o según el Excel)
          nombre = partes.slice(0, Math.ceil(partes.length / 2)).join(' ');
          apellido = partes.slice(Math.ceil(partes.length / 2)).join(' ');
        } else if (partes.length === 2) {
          nombre = partes[0]; apellido = partes[1];
        }

        try {
          const existente = db.prepare('SELECT id,carrera_id,curso_id,usuario_id FROM alumnos WHERE ci=?').get(ciRaw);
          const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
          let emailAuto = `${norm(nombre)}.${norm(apellido)}@its.edu.py`;
          if (db.prepare('SELECT id FROM usuarios WHERE email=? AND ci!=?').get(emailAuto, ciRaw))
            emailAuto = `${norm(nombre)}.${norm(apellido)}.${ciRaw.slice(-3)}@its.edu.py`;

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
            const matricula = `${carr.codigo}-${new Date().getFullYear()}-${String(cnt + 1).padStart(3, '0')}`;
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
            db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid, uid, matricula, carrera_id, curso_id||null, new Date().toISOString().split('T')[0], 'Activo', ciRaw, nombre, apellido);
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
    let email = `${norm(al.nombre)}.${norm(al.apellido)}@its.edu.py`;
    if(db.prepare('SELECT id FROM usuarios WHERE email=?').get(email))
      email = `${norm(al.nombre)}.${norm(al.apellido)}.${ciRaw.slice(-3)}@its.edu.py`;
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
  const { docente_id, curso_id, periodo_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (docente_id) { where += ' AND a.docente_id=?'; params.push(docente_id); }
  if (curso_id)   { where += ' AND a.curso_id=?';   params.push(curso_id); }
  if (periodo_id) { where += ' AND a.periodo_id=?'; params.push(periodo_id); }
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
      n.extraordinario,n.ausente,
      n.puntaje_total,n.nota_final,n.estado as nota_estado
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.estado='Activo'
      AND (
        al.curso_id=?
        OR (? IS NOT NULL AND al.carrera_id=? AND al.curso_id IS NULL)
      )
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, asig.curso_id, carrera_id, carrera_id);

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
    const campos = ['tp1','tp2','tp3','tp4','tp5','parcial','parcial_recuperatorio','final_ord','final_recuperatorio','complementario','extraordinario','ausente'];
    const vals = campos.map(c => req.body[c]===''||req.body[c]===undefined||req.body[c]===null ? null : parseFloat(req.body[c]));
    const { calcularPuntaje } = require('./db');
    const nota = calcularPuntaje(...vals.slice(0,11));
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
  audit(req.user.id, 'UPDATE_ASISTENCIA', 'asistencia', asignacion_id, { fecha, total: registros.length });
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
  const { periodo_id, carrera_id, tipo } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (periodo_id) { where += ' AND e.periodo_id=?'; params.push(periodo_id); }
  if (carrera_id) { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (tipo) { where += ' AND e.tipo=?'; params.push(tipo); }
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
        (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id) as notas_cargadas,
        (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
      FROM examenes e
      LEFT JOIN asignaciones a  ON e.asignacion_id=a.id
      LEFT JOIN materias m      ON a.materia_id=m.id
      LEFT JOIN cursos cu       ON a.curso_id=cu.id
      LEFT JOIN carreras ca     ON cu.carrera_id=ca.id
      LEFT JOIN docentes d      ON a.docente_id=d.id
      LEFT JOIN usuarios u      ON d.usuario_id=u.id
      LEFT JOIN periodos p      ON e.periodo_id=p.id
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
    db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion,puntos_max) VALUES (?,?,?,?,?,?,?,?,?)').run(id, asignacion_id, tipo, fecha, hora||null, aula||null, periodo_id||null, observacion||null, puntos_max||25);

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

// Limpiar todos los exámenes de un tipo (para reset del cronograma)
app.delete('/api/examenes/bulk/tipo', auth(['director']), (req, res) => {
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
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
    FROM examenes e
    LEFT JOIN asignaciones a  ON e.asignacion_id=a.id
    LEFT JOIN materias m      ON a.materia_id=m.id
    LEFT JOIN cursos cu       ON a.curso_id=cu.id
    LEFT JOIN carreras ca     ON cu.carrera_id=ca.id
    LEFT JOIN docentes d      ON a.docente_id=d.id
    LEFT JOIN usuarios u      ON d.usuario_id=u.id
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
    // Docente SOLO ve: sus propios avisos + avisos de director/secretaria
    // NUNCA ve avisos de otros docentes
    whereDestino = `AND (av.usuario_id='${uid}' OR u.rol IN ('director','secretaria'))`;
  }
  // director/secretaria ven todos
  res.json(db.prepare(`SELECT av.*,u.nombre as autor_nombre,u.apellido as autor_apellido,u.rol as autor_rol
    FROM avisos av JOIN usuarios u ON av.usuario_id=u.id
    WHERE av.activo=1 ${whereDestino} ORDER BY av.fijado DESC,av.fecha_creacion DESC LIMIT 100`).all());
});
app.post('/api/avisos', auth(['director','docente','secretaria']), (req, res) => {
  const { titulo, contenido, tipo, fijado, destinatario } = req.body;
  // Mapear valores del frontend al CHECK constraint de SQLite
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
// Perfil financiero de un alumno (consulta para rol alumno)
app.get('/api/pagos/alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT * FROM alumnos WHERE id=?').get(req.params.alumno_id);
  // Alumno solo puede ver su propio perfil
  if (req.user.rol === 'alumno' && al?.usuario_id !== req.user.id) return res.status(403).json({ error: 'Sin acceso' });
  const pagos = db.prepare(`SELECT p.*,c.nombre as carrera FROM pagos p JOIN alumnos al ON p.alumno_id=al.id JOIN carreras c ON al.carrera_id=c.id WHERE p.alumno_id=? ORDER BY p.fecha_pago DESC`).all(req.params.alumno_id);
  const totalPagado = pagos.reduce((s,p)=>s+p.monto,0);
  res.json({ pagos, totalPagado, alumno: al });
});
app.post('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto, fecha_pago, comprobante, descuento, beca, medio_pago } = req.body;
  try {
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
    db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,descuento,beca,medio_pago) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,alumno_id,periodo_id,concepto,montoPagado,fecha_pago,'Pagado',comprobante||null,descuento||0,beca||null,medio_pago||'Efectivo');
    audit(req.user.id,'PAGO','pagos',id,{alumno_id,concepto,monto:montoPagado,medio_pago});
    res.json({ ok: true, id, monto_esperado: montoEsperado, monto_pagado: montoPagado, monto_pendiente: montoPendiente });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/pagos/:id', auth(ADM), (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM pagos WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM pagos WHERE id=?').run(req.params.id);
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
  const hoy = new Date().toISOString().split('T')[0];
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
    res.setHeader('Content-Disposition', `attachment; filename="ITS_${req.params.tabla}_${new Date().toISOString().split('T')[0]}.xlsx"`);
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
    fecha: new Date().toISOString().split('T')[0],
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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

  // Verificar cada cuota requerida
  const cuotasFaltantes = cuotasRequeridas.filter(cuota =>
    !conceptosPagados.some(c => c === cuota || c.includes(cuota))
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
        const fecha = String(row['Fecha'] || row['fecha'] || new Date().toISOString().split('T')[0]).trim();
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
    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando archivo: '+e.message }); }
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
  const { concepto, monto, tipo, carrera_id, descripcion } = req.body;
  const id = 'ar_'+Date.now();
  db.prepare('INSERT INTO aranceles (id,concepto,monto,tipo,carrera_id,descripcion) VALUES (?,?,?,?,?,?)').run(id,concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null);
  res.json({ id });
});
app.put('/api/aranceles/:id', auth(ADM), (req, res) => {
  const { concepto, monto, tipo, carrera_id, descripcion, activo } = req.body;
  db.prepare("UPDATE aranceles SET concepto=?,monto=?,tipo=?,carrera_id=?,descripcion=?,activo=?,fecha_actualizacion=date('now') WHERE id=?").run(concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null,activo?1:0,req.params.id);
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
  res.json(db.prepare('SELECT * FROM habilitaciones_examen WHERE alumno_id=?').all(req.params.alumno_id));
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
  const { alumno_ids } = req.body;
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
  // Recopilar TODOS los tipos habilitados por alumno (array, no solo el primero)
  const habEspeciales = {};
  const habWithFlag = alumnos.filter(al => al.habilitado_pago_pendiente).map(al => al.id);
  if (habWithFlag.length) {
    const habPh = habWithFlag.map(() => '?').join(',');
    db.prepare(`SELECT alumno_id, tipo_examen FROM habilitaciones_examen WHERE alumno_id IN (${habPh}) AND habilitado=1 ORDER BY fecha DESC`).all(...habWithFlag)
      .forEach(h => {
        if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
        if (!habEspeciales[h.alumno_id].includes(h.tipo_examen)) habEspeciales[h.alumno_id].push(h.tipo_examen);
      });
    // Incluir habilitado_recuperatorio como 'parcial_recuperatorio'
    db.prepare(`SELECT alumno_id FROM habilitaciones_examen WHERE alumno_id IN (${habPh}) AND habilitado_recuperatorio=1`).all(...habWithFlag)
      .forEach(h => {
        if (!habEspeciales[h.alumno_id]) habEspeciales[h.alumno_id] = [];
        if (!habEspeciales[h.alumno_id].includes('parcial_recuperatorio')) habEspeciales[h.alumno_id].push('parcial_recuperatorio');
      });
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
    const faltantes = cuotasRequeridas.filter(c => !conceptos.some(p => p === c || p.includes(c)));
    if (faltantes.length === 0) {
      result[al.id] = { habilitado: true, razon: 'pago_al_dia', tipos_habilitados: [], cuotas_faltantes: [], habilitado_recuperatorio: !!recuperatorioMap[al.id] };
      return;
    }
    const tiposHab = habEspeciales[al.id] || [];
    result[al.id] = {
      habilitado: false,
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
const BACKUP_DIR = path.join(__dirname, '../backups');
if (!fs.existsSync(BACKUP_DIR)) { try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {} }

function hacerBackupAutomatico() {
  try {
    const fecha = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destino = path.join(BACKUP_DIR, `ITS_auto_${fecha}.db`);
    fs.copyFileSync(DB_PATH, destino);
    // Mantener solo los últimos 10 backups automáticos
    const archivos = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('ITS_auto_'))
      .sort().reverse();
    archivos.slice(10).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    });
    console.log(`✅ Backup automático: ${destino}`);
    return destino;
  } catch(e) {
    console.error('Error en backup automático:', e.message);
    return null;
  }
}

// Ejecutar backup al iniciar y cada 48 horas
setTimeout(() => {
  hacerBackupAutomatico();
  setInterval(hacerBackupAutomatico, 48 * 60 * 60 * 1000);
}, 5000); // Esperar 5s para que la BD esté lista

app.get('/api/admin/backup', auth(ADM), (req, res) => {
  const fecha = new Date().toISOString().split('T')[0];
  const dbPath = DB_PATH || path.join(__dirname, '..', 'data', 'its.db');
  res.setHeader('Content-Disposition', `attachment; filename="ITS_backup_${fecha}.db"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  audit(req.user.id, 'BACKUP', 'sistema', 'backup', { fecha });
  res.sendFile(dbPath);
});

// ── AUDITORÍA ─────────────────────────────────────────────────────────────────
// ── AUDITORÍA COMPLETA ────────────────────────────────────────────────────────
// ── REGISTRO DE HABILITADOS ────────────────────────────────────────────────────
app.get('/api/admin/habilitados', auth(ADM), (req, res) => {
  const { carrera_id, anio, tipo_examen } = req.query;
  let where = "WHERE h.habilitado=1";
  const params = [];
  if (tipo_examen) { where += ' AND h.tipo_examen=?'; params.push(tipo_examen); }
  if (carrera_id)  { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (anio)        { where += ' AND cu.anio=?'; params.push(parseInt(anio)); }
  try {
    const rows = db.prepare(`
      SELECT h.id, h.tipo_examen, h.fecha, h.motivo,
        al.nombre as alumno_nombre, al.apellido as alumno_apellido, al.ci as alumno_ci,
        ca.nombre as carrera_nombre, cu.anio,
        m.nombre as materia_nombre,
        uh.nombre as habilitado_por_nombre, uh.apellido as habilitado_por_apellido
      FROM habilitaciones_examen h
      LEFT JOIN alumnos al ON h.alumno_id=al.id
      LEFT JOIN asignaciones asig ON h.asignacion_id=asig.id
      LEFT JOIN materias m ON asig.materia_id=m.id
      LEFT JOIN cursos cu ON asig.curso_id=cu.id
      LEFT JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN usuarios uh ON h.habilitado_por=uh.id
      ${where}
      ORDER BY h.fecha DESC`).all(...params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/auditoria', auth(ADM), (req, res) => {
  const { tabla, accion, usuario_id, desde, hasta, limite } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (tabla)      { where += ' AND a.tabla=?';       params.push(tabla); }
  if (accion)     { where += ' AND a.accion=?';      params.push(accion); }
  if (usuario_id) { where += ' AND a.usuario_id=?';  params.push(usuario_id); }
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

app.delete('/api/admin/auditoria', auth(ADM), (req, res) => {
  // Permite limpiar auditoría anterior a N días (mínimo 30)
  const { dias } = req.body;
  const d = Math.max(parseInt(dias)||90, 30);
  const result = db.prepare(`DELETE FROM auditoria WHERE fecha<date('now','-${d} days')`).run();
  audit(req.user.id, 'PURGE_AUDIT', 'auditoria', null, { dias: d, eliminados: result.changes });
  res.json({ ok: true, eliminados: result.changes });
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

// ── CRON: Recordatorio de exámenes 24hs antes (corre a las 9:00 AM diario) ──
cron.schedule('0 9 * * *', async () => {
  try {
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];
    const examenes = db.prepare(`
      SELECT e.*, m.nombre as materia, ca.nombre as carrera,
        cu.anio as anio, cu.division as division,
        u.nombre as doc_nombre, u.apellido as doc_apellido, u.email as doc_email
      FROM examenes e
      LEFT JOIN asignaciones a ON e.asignacion_id=a.id
      LEFT JOIN materias m ON a.materia_id=m.id
      LEFT JOIN cursos cu ON a.curso_id=cu.id
      LEFT JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN docentes d ON a.docente_id=d.id
      LEFT JOIN usuarios u ON d.usuario_id=u.id
      WHERE e.fecha=?`).all(fechaManana);
    for (const ex of examenes) {
      if (!ex.doc_email) continue;
      const html = htmlEmail(
        `📋 Recordatorio: Examen mañana ${fechaManana}`,
        `<p>Estimado/a <strong>${ex.doc_nombre} ${ex.doc_apellido}</strong>,</p>
        <p>Le recordamos que mañana tiene programado un examen:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="background:#f0f4f8"><td style="padding:8px;border:1px solid #ddd"><strong>Materia</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.materia}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Tipo</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.tipo}</td></tr>
          <tr style="background:#f0f4f8"><td style="padding:8px;border:1px solid #ddd"><strong>Carrera</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.carrera} ${ex.anio}°${ex.division==='U'?'':ex.division}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Hora</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.hora||'A confirmar'}</td></tr>
          <tr style="background:#f0f4f8"><td style="padding:8px;border:1px solid #ddd"><strong>Aula</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.aula||'A confirmar'}</td></tr>
        </table>
        <p style="margin-top:16px;color:#555">Por favor tenga lista el acta de examen y los materiales necesarios.</p>`
      );
      await sendMail(ex.doc_email, `📋 Recordatorio examen: ${ex.materia} — ${fechaManana}`, html);
      audit('sistema','NOTIFICACION_EMAIL','examenes',ex.id,{tipo:'recordatorio_24h',email:ex.doc_email});
    }
    console.log(`✓ Cron recordatorios: ${examenes.length} emails enviados`);
  } catch(e) { console.error('Cron error:', e.message); }
});

// ── ENDPOINT: Enviar recordatorio manual ─────────────────────────────────────
app.post('/api/examenes/:id/recordatorio', auth(ADM), async (req, res) => {
  const ex = db.prepare(`
    SELECT e.*, m.nombre as materia, ca.nombre as carrera, cu.anio,
      u.nombre as doc_nombre, u.apellido as doc_apellido, u.email as doc_email
    FROM examenes e
    LEFT JOIN asignaciones a ON e.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    LEFT JOIN docentes d ON a.docente_id=d.id
    LEFT JOIN usuarios u ON d.usuario_id=u.id
    WHERE e.id=?`).get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Examen no encontrado' });
  if (!ex.doc_email) return res.status(400).json({ error: 'El docente no tiene email registrado' });
  const html = htmlEmail(
    `📋 Recordatorio de examen — ${ex.fecha}`,
    `<p>Estimado/a <strong>${ex.doc_nombre} ${ex.doc_apellido}</strong>,</p>
    <p>El Director le envía este recordatorio sobre el examen programado:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f0f4f8"><td style="padding:8px;border:1px solid #ddd"><strong>Materia</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.materia}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Tipo</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.tipo}</td></tr>
      <tr style="background:#f0f4f8"><td style="padding:8px;border:1px solid #ddd"><strong>Fecha</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.fecha}</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd"><strong>Hora</strong></td><td style="padding:8px;border:1px solid #ddd">${ex.hora||'A confirmar'}</td></tr>
    </table>`
  );
  const ok = await sendMail(ex.doc_email, `📋 Recordatorio: ${ex.materia} — ${ex.fecha}`, html);
  if (ok) { audit(req.user.id,'NOTIFICACION_EMAIL','examenes',ex.id,{manual:true}); res.json({ ok: true }); }
  else res.status(500).json({ error: 'No se pudo enviar el email. Verificar configuración.' });
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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
    const pagado = pagos.filter(p => p.concepto===nombre || p.concepto?.includes(nombre)).reduce((s,p)=>s+Number(p.monto||0),0);
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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
app.post('/api/solicitudes-alumno', auth(['director','docente']), (req, res) => {
  const { nombre, apellido, ci, asignacion_id } = req.body;
  if (!nombre || !asignacion_id) return res.status(400).json({ error: 'Nombre y asignación requeridos' });
  const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
  const docId = doc?.id || req.body.docente_id;
  if (!docId) return res.status(400).json({ error: 'No se pudo identificar al docente' });
  const id = 'sal_'+Date.now();
  db.prepare('INSERT INTO solicitudes_alumno (id,nombre,apellido,ci,asignacion_id,docente_id,registrado_por) VALUES (?,?,?,?,?,?,?)')
    .run(id, nombre, apellido||'', ci||'', asignacion_id, docId, req.user.id);
  audit(req.user.id,'SOLICITUD_ALUMNO','solicitudes_alumno',id,{nombre,ci});
  res.json({ id, estado: 'pendiente' });
});
app.put('/api/solicitudes-alumno/:id/resolver', auth(ADM), (req, res) => {
  const { accion } = req.body;
  const sol = db.prepare('SELECT * FROM solicitudes_alumno WHERE id=?').get(req.params.id);
  if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
  db.prepare("UPDATE solicitudes_alumno SET estado=? WHERE id=?").run(accion==='aprobar'?'aprobado':'rechazado', req.params.id);
  if (accion === 'aprobar') {
    // Crear alumno real vinculado a la asignación
    const asig = db.prepare('SELECT * FROM asignaciones WHERE id=?').get(sol.asignacion_id);
    if (asig) {
      const curso = db.prepare('SELECT carrera_id FROM cursos WHERE id=?').get(asig.curso_id);
      const carreraId = curso?.carrera_id || null;
      const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carreraId);
      const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carreraId||'').n;
      const matricula = `${carr?.codigo||'ALU'}-${new Date().getFullYear()}-${String(cnt+1).padStart(3,'0')}`;
      const ciRaw = String(sol.ci||'').replace(/[^0-9]/g,'');
      const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
      let emailFinal = `${norm(sol.nombre)}.${norm(sol.apellido)}@its.edu.py`;
      if (db.prepare('SELECT id FROM usuarios WHERE email=?').get(emailFinal))
        emailFinal = `${norm(sol.nombre)}.${norm(sol.apellido)}.${ciRaw.slice(-3)||Date.now()%1000}@its.edu.py`;
      const uid = 'u_a_'+Date.now();
      const fechaHoy = new Date().toISOString().split('T')[0];
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol,activo) VALUES (?,?,?,?,?,?,?,1)').run(uid,sol.nombre,sol.apellido,ciRaw,emailFinal,require('bcryptjs').hashSync(ciRaw||'123',10),'alumno');
        const aid = 'a_'+Date.now();
        db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid,uid,matricula,carreraId,asig.curso_id,fechaHoy,'Activo',ciRaw,sol.nombre,sol.apellido);
        db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now(),aid,asig.id,'Pendiente');
      })();
    }
  }
  audit(req.user.id,'RESOLVER_ALUMNO','solicitudes_alumno',req.params.id,{accion});
  res.json({ ok: true });
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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
  res.json({ alumno: al, solicitud, notas, institucion: inst, fecha: solicitud.fecha_resolucion||new Date().toISOString().split('T')[0] });
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

app.delete('/api/examenes/:id/archivo', auth(ADM), (req, res) => {
  db.prepare('UPDATE examenes SET archivo_nombre=NULL, archivo_data=NULL, archivo_tipo=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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
  const fechaHoy = new Date().toISOString().split('T')[0];
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

// DELETE: eliminar archivo (solo director o el docente que lo subió)
app.delete('/api/repositorio/:id', auth(['director','docente']), (req, res) => {
  const r = db.prepare('SELECT * FROM repositorio WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  if (req.user.rol === 'docente' && r.subido_por !== req.user.id) return res.status(403).json({ error: 'Solo podés eliminar tus propios archivos' });
  db.prepare('DELETE FROM repositorio WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','index.html')));
app.listen(PORT, () => { console.log(`✓ ITS v4 en http://localhost:${PORT}`); });
