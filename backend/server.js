require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const { db, init, calcularPuntaje, DB_PATH } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'its_secret_2026_cambiar_en_produccion';
const upload = multer({ storage: multer.memoryStorage() });

// ── SEGURIDAD: CORS restringido ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
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
    db.prepare('INSERT INTO auditoria (id,usuario_id,accion,tabla,registro_id,detalle,fecha) VALUES (?,?,?,?,?,?,datetime("now"))').run(
      'aud_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),
      usuario_id, accion, tabla, registro_id, detalle ? JSON.stringify(detalle) : null
    );
  } catch {} // nunca romper la app por un log fallido
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function auth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
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

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const u = db.prepare('SELECT * FROM usuarios WHERE (email=? OR ci=?) AND activo=1').get(email, email);
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email }, JWT_SECRET, { expiresIn: '8h' });
  let docenteId = null, alumnoId = null;
  if (u.rol === 'docente') docenteId = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(u.id)?.id;
  if (u.rol === 'alumno')  alumnoId  = db.prepare('SELECT id FROM alumnos  WHERE usuario_id=?').get(u.id)?.id;
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
  const q = `SELECT m.*,c.nombre as carrera_nombre FROM materias m JOIN carreras c ON m.carrera_id=c.id ${carrera_id?'WHERE m.carrera_id=?':''} ORDER BY c.nombre,m.anio,m.nombre`;
  res.json(carrera_id ? db.prepare(q).all(carrera_id) : db.prepare(q).all());
});
app.post('/api/materias', auth(ADM), (req, res) => {
  const { carrera_id, nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final } = req.body;
  const pt = parseInt(peso_tp)||25, pp = parseInt(peso_parcial)||25, pf = parseInt(peso_final)||50;
  if (pt+pp+pf !== 100) return res.status(400).json({ error: 'Los pesos deben sumar 100' });
  const id = 'm_' + Date.now();
  db.prepare('INSERT INTO materias (id,carrera_id,nombre,codigo,horas_semanales,anio,peso_tp,peso_parcial,peso_final) VALUES (?,?,?,?,?,?,?,?,?)').run(id,carrera_id,nombre,codigo||'',horas_semanales||4,anio||1,pt,pp,pf);
  res.json({ id });
});
app.put('/api/materias/:id', auth(ADM), (req, res) => {
  const { nombre, codigo, horas_semanales, anio, peso_tp, peso_parcial, peso_final } = req.body;
  const pt = parseInt(peso_tp)||25, pp = parseInt(peso_parcial)||25, pf = parseInt(peso_final)||50;
  if (pt+pp+pf !== 100) return res.status(400).json({ error: 'Los pesos deben sumar 100' });
  db.prepare('UPDATE materias SET nombre=?,codigo=?,horas_semanales=?,anio=?,peso_tp=?,peso_parcial=?,peso_final=? WHERE id=?').run(nombre,codigo,horas_semanales,anio,pt,pp,pf,req.params.id);
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
  let where = "WHERE al.estado='Activo'"; const params = [];
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
  const { nombre, apellido, ci, email, password, carrera_id, curso_id, telefono, direccion, fecha_ingreso } = req.body;
  if (!nombre || !apellido || !ci) return res.status(400).json({ error: 'Nombre, apellido y CI son obligatorios' });
  const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carrera_id);
  if (!carr) return res.status(400).json({ error: 'Carrera no encontrada' });
  const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id).n;
  const matricula = `${carr.codigo}-${new Date().getFullYear()}-${String(cnt+1).padStart(3,'0')}`;
  const aid = 'a_'+Date.now();
  db.transaction(() => {
    let uid = null;
    if (email) {
      uid = 'u_a_'+Date.now();
      const ciRaw = String(ci).replace(/[^0-9]/g,'');
      try {
        db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid,nombre,apellido,ci,email,bcrypt.hashSync(password||ciRaw.slice(-3)||ci,10),'alumno');
      } catch { uid = null; }
    }
    db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,telefono,direccion,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(aid,uid,matricula,carrera_id,curso_id||null,fecha_ingreso||new Date().toISOString().split('T')[0],'Activo',telefono||null,direccion||null,ci,nombre,apellido);
    // Propagación automática: crear notas vacías en todas las asignaciones del curso
    if (curso_id) {
      const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
      if (periodo) {
        const asigs = db.prepare('SELECT id FROM asignaciones WHERE curso_id=? AND periodo_id=?').all(curso_id, periodo.id);
        asigs.forEach(a => {
          try {
            db.prepare('INSERT OR IGNORE INTO notas (id,alumno_id,asignacion_id,estado) VALUES (?,?,?,?)').run('n_'+Date.now()+'_'+Math.random().toString(36).slice(2,5), aid, a.id, 'Pendiente');
          } catch {}
        });
      }
    }
  })();
  res.json({ id: aid, matricula });
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
app.delete('/api/alumnos/:id', auth(ADM), (req, res) => {
  const a = db.prepare('SELECT usuario_id FROM alumnos WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM alumnos WHERE id=?').run(req.params.id);
  if (a?.usuario_id) db.prepare('DELETE FROM usuarios WHERE id=?').run(a.usuario_id);
  res.json({ ok: true });
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
          if (existente) {
            db.prepare('UPDATE alumnos SET carrera_id=?,curso_id=?,nombre=?,apellido=? WHERE ci=?').run(carrera_id, curso_id||null, nombre, apellido, ciRaw);
            results.actualizados++;
          } else {
            const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id).n;
            const matricula = `${carr.codigo}-${new Date().getFullYear()}-${String(cnt + 1).padStart(3, '0')}`;
            const aid = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
            // Generar credenciales automáticas: usuario=CI, contraseña=últimos 3 dígitos CI
            let uid = null;
            const passRaw = ciRaw.slice(-3);
            const emailAuto = `${ciRaw}@its.edu.py`;
            const usuExiste = db.prepare('SELECT id FROM usuarios WHERE ci=? OR email=?').get(ciRaw, emailAuto);
            if (!usuExiste) {
              uid = 'u_e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 4);
              try {
                db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid, nombre, apellido, ciRaw, emailAuto, bcrypt.hashSync(passRaw, 10), 'alumno');
              } catch { uid = null; }
            } else { uid = usuExiste.id; }
            db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run(aid, uid, matricula, carrera_id, curso_id||null, new Date().toISOString().split('T')[0], 'Activo', ciRaw, nombre, apellido);
            results.ok++;
          }
        } catch(e) { results.errores.push(`Fila ${idx + 2}: ${e.message}`); }
      });
    })();

    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando archivo: ' + e.message }); }
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
  const alumnos = db.prepare(`
    SELECT al.id,al.matricula,COALESCE(al.ci,u.ci) as alumno_ci,
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
    WHERE al.curso_id=? AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, asig.curso_id);
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
    SELECT n.*,m.nombre as materia_nombre,m.peso_tp,m.peso_parcial,m.peso_final,
      p.nombre as periodo_nombre
    FROM notas n
    JOIN asignaciones a ON n.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN periodos p ON a.periodo_id=p.id
    WHERE n.alumno_id=? ORDER BY m.nombre`).all(req.params.alumno_id));
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
    WHERE al.curso_id=? AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, asig.curso_id);
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
app.get('/api/asistencia/resumen-alumno/:alumno_id', auth(), (req, res) => {
  const al = db.prepare('SELECT id,usuario_id FROM alumnos WHERE id=?').get(req.params.alumno_id);
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
  // Consolidar por materia
  const porMateria = {};
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
  res.json({ ok: true });
});

// ── HONORARIOS: endpoints ──────────────────────────────────────────────────────
app.get('/api/honorarios', auth(['director','docente']), (req, res) => {
  const { docente_id, mes, anio, estado } = req.query;
  // Docente solo ve los suyos
  let dId = docente_id;
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    dId = doc?.id;
    if (!dId) return res.json([]);
  }
  let where = 'WHERE 1=1'; const params = [];
  if (dId)    { where += ' AND h.docente_id=?';  params.push(dId); }
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
    if (!doc || doc.id !== asig.docente_id) return res.status(403).json({ error: 'Solo el titular o el director pueden registrar un reemplazo' });
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

// ── RESUMEN HONORARIOS POR DOCENTE/MES (para informe) ─────────────────────────
app.get('/api/honorarios/resumen', auth(['director','docente']), (req, res) => {
  const { docente_id, mes, anio } = req.query;
  let dId = docente_id;
  if (req.user.rol === 'docente') {
    const doc = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(req.user.id);
    dId = doc?.id;
  }
  if (!dId || !mes || !anio) return res.status(400).json({ error: 'docente_id, mes y anio requeridos' });
  const desde = `${anio}-${String(mes).padStart(2,'0')}-01`;
  const hasta = `${anio}-${String(mes).padStart(2,'0')}-${new Date(parseInt(anio),parseInt(mes),0).getDate()}`;

  // Todos los días hábiles del mes (L-V sin feriados)
  const feriados = new Set(db.prepare("SELECT fecha FROM feriados WHERE fecha>=? AND fecha<=? AND activo=1").all(desde, hasta).map(f=>f.fecha));
  const diasHabiles = [];
  const cur = new Date(desde+'T12:00:00');
  const finDate = new Date(hasta+'T12:00:00');
  while (cur <= finDate) {
    const d = cur.getDay();
    if (d >= 1 && d <= 5 && !feriados.has(cur.toISOString().split('T')[0])) diasHabiles.push(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate()+1);
  }

  // Honorarios del docente en ese mes
  const hons = db.prepare(`
    SELECT h.*, m.nombre as materia, ca.nombre as carrera, cu.anio as anio_curso,
      a.turno, a.hora_inicio, a.hora_fin
    FROM honorarios h
    LEFT JOIN asignaciones a ON h.asignacion_id=a.id
    LEFT JOIN materias m ON a.materia_id=m.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE h.docente_id=? AND h.fecha>=? AND h.fecha<=? AND h.estado!='anulado'
    ORDER BY h.fecha, h.turno`).all(dId, desde, hasta);

  // Asignaciones del docente en el mes
  const asigs = db.prepare(`
    SELECT a.*, m.nombre as materia, ca.nombre as carrera, cu.anio as anio_curso
    FROM asignaciones a
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    WHERE a.docente_id=?`).all(dId);
  const horarios = db.prepare('SELECT * FROM horarios WHERE asignacion_id IN ('+asigs.map(()=>'?').join(',')+')').all(...asigs.map(a=>a.id));

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
    WHERE (r.docente_titular_id=? OR r.docente_reemplazante_id=?) AND r.fecha>=? AND r.fecha<=? AND r.estado='aprobado'`).all(dId, dId, desde, hasta);

  const docInfo = db.prepare('SELECT u.nombre,u.apellido,d.titulo FROM docentes d JOIN usuarios u ON d.usuario_id=u.id WHERE d.id=?').get(dId);
  const totalGanado = hons.reduce((s,h)=>s+h.monto, 0);

  res.json({ docente: docInfo, diasHabiles, honorarios: hons, asignaciones: asigs, reemplazos, totalGanado, desde, hasta, mes, anio });
});

// ── EXÁMENES ──────────────────────────────────────────────────────────────────
app.get('/api/examenes', auth(), (req, res) => {
  const { periodo_id, carrera_id, tipo } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (periodo_id) { where += ' AND e.periodo_id=?'; params.push(periodo_id); }
  if (carrera_id) { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (tipo) { where += ' AND e.tipo=?'; params.push(tipo); }
  try {
    res.json(db.prepare(`
      SELECT e.*,
        m.nombre as materia_nombre, m.codigo as materia_codigo,
        ca.id as carrera_id, ca.nombre as carrera_nombre,
        cu.id as curso_id, cu.anio as curso_anio, cu.division as curso_division, cu.turno as curso_turno,
        u.nombre as docente_nombre, u.apellido as docente_apellido,
        p.nombre as periodo_nombre,
        a.id as asignacion_id,
        (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id) as notas_cargadas,
        (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
      FROM examenes e
      LEFT JOIN asignaciones a ON e.asignacion_id=a.id
      LEFT JOIN materias m ON a.materia_id=m.id
      LEFT JOIN cursos cu ON a.curso_id=cu.id
      LEFT JOIN carreras ca ON cu.carrera_id=ca.id
      LEFT JOIN docentes d ON a.docente_id=d.id
      LEFT JOIN usuarios u ON d.usuario_id=u.id
      LEFT JOIN periodos p ON e.periodo_id=p.id
      ${where} ORDER BY e.fecha DESC, e.hora, ca.nombre`).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/examenes', auth(ADM), (req, res) => {
  const { asignacion_id, tipo, fecha, hora, aula, periodo_id, observacion, puntos_max } = req.body;
  const id = 'ex_' + Date.now();
  db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion,puntos_max) VALUES (?,?,?,?,?,?,?,?,?)').run(id,asignacion_id,tipo,fecha,hora||null,aula||null,periodo_id,observacion||null,puntos_max||50);
  res.json({ id });
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

// Exámenes del día / semana para el calendario
app.get('/api/examenes/calendario', auth(), (req, res) => {
  const { desde, hasta, docente_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (desde) { where += ' AND e.fecha>=?'; params.push(desde); }
  if (hasta) { where += ' AND e.fecha<=?'; params.push(hasta); }
  if (docente_id) { where += ' AND a.docente_id=?'; params.push(docente_id); }
  res.json(db.prepare(`
    SELECT e.*,
      m.nombre as materia_nombre,
      ca.nombre as carrera_nombre,
      cu.anio as curso_anio,cu.division as curso_division,
      u.nombre as docente_nombre,u.apellido as docente_apellido,
      a.id as asignacion_id,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND
        CASE e.tipo WHEN 'Parcial' THEN n.parcial IS NOT NULL
                    WHEN 'Final' THEN n.final_ord IS NOT NULL
                    ELSE 0 END) as notas_cargadas,
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
    FROM examenes e
    JOIN asignaciones a ON e.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes d ON a.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    ${where} ORDER BY e.fecha,e.hora`).all(...params));
});

// ── AVISOS ────────────────────────────────────────────────────────────────────
app.get('/api/avisos', auth(), (req, res) => {
  // Filtrar por destinatario según rol
  const rol = req.user.rol;
  let whereDestino = '';
  if (rol === 'alumno') whereDestino = "AND (av.destinatario='todos' OR av.destinatario='alumnos')";
  else if (rol === 'docente') whereDestino = "AND (av.destinatario='todos' OR av.destinatario='docentes')";
  // director ve todos
  res.json(db.prepare(`SELECT av.*,u.nombre as autor_nombre,u.apellido as autor_apellido
    FROM avisos av JOIN usuarios u ON av.usuario_id=u.id
    WHERE av.activo=1 ${whereDestino} ORDER BY av.fijado DESC,av.fecha_creacion DESC LIMIT 50`).all());
});
app.post('/api/avisos', auth(ADM), (req, res) => {
  const { titulo, contenido, tipo, fijado, destinatario } = req.body;
  const id = 'av_' + Date.now();
  db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,destinatario,usuario_id) VALUES (?,?,?,?,?,?,?)').run(id,titulo,contenido,tipo||'info',fijado?1:0,destinatario||'todos',req.user.id);
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
    db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,descuento,beca,medio_pago) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,alumno_id,periodo_id,concepto,monto,fecha_pago,'Pagado',comprobante||null,descuento||0,beca||null,medio_pago||'Efectivo');
    audit(req.user.id,'PAGO','pagos',id,{alumno_id,concepto,monto,medio_pago});
    res.json({ ok: true, id });
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

// Importar exámenes desde Excel
app.post('/api/examenes/importar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
    const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
    const results = { ok:0, errores:[] };
    rows.forEach((row, i) => {
      try {
        const asig_id = String(row.asignacion_id||'').trim();
        const tipo = String(row.tipo||'Parcial').trim();
        const fecha = String(row.fecha||'').trim();
        if (!asig_id || !fecha) { results.errores.push(`Fila ${i+2}: asignacion_id y fecha son obligatorios`); return; }
        const asig = db.prepare('SELECT id FROM asignaciones WHERE id=?').get(asig_id);
        if (!asig) { results.errores.push(`Fila ${i+2}: asignacion_id no encontrado "${asig_id}"`); return; }
        if (!['Parcial','Final','Recuperatorio','Extraordinario'].includes(tipo)) { results.errores.push(`Fila ${i+2}: tipo inválido "${tipo}"`); return; }
        const pid = periodo?.id || null;
        db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion) VALUES (?,?,?,?,?,?,?,?)').run('ex_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),asig_id,tipo,fecha,row.hora||null,row.aula||null,pid,row.observacion||null);
        results.ok++;
      } catch(e) { results.errores.push(`Fila ${i+2}: ${e.message}`); }
    });
    res.json(results);
  } catch(e) { res.status(400).json({ error:'Error procesando archivo: '+e.message }); }
});

// ── HORARIOS ──────────────────────────────────────────────────────────────────
app.get('/api/horarios', auth(), (req, res) => {
  const { asignacion_id, dia } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (asignacion_id) { where += ' AND h.asignacion_id=?'; params.push(asignacion_id); }
  if (dia) { where += ' AND h.dia=?'; params.push(dia); }
  res.json(db.prepare(`
    SELECT h.*,
      m.nombre as materia_nombre, ca.nombre as carrera_nombre,
      cu.anio as curso_anio, cu.division as curso_division,
      u.nombre as docente_nombre, u.apellido as docente_apellido
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
app.put('/api/alumnos/:id/habilitar-pago', auth(ADM), (req, res) => {
  const { habilitado } = req.body;
  const al = db.prepare('SELECT nombre,apellido FROM alumnos WHERE id=?').get(req.params.id);
  db.prepare('UPDATE alumnos SET habilitado_pago_pendiente=? WHERE id=?').run(habilitado?1:0, req.params.id);
  audit(req.user.id,'HABILITAR','alumnos',req.params.id,{habilitado,alumno:`${al?.apellido||''} ${al?.nombre||''}`,tipo:'excepcion_pago_mora'});
  res.json({ ok: true, habilitado: !!habilitado });
});

// ── VERIFICAR ESTADO DE HABILITACIÓN PARA EXAMEN (regla Julio) ───────────────
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
  res.json(db.prepare(`SELECT a.*,c.nombre as carrera_nombre FROM aranceles a
    LEFT JOIN carreras c ON a.carrera_id=c.id WHERE a.activo=1 ORDER BY a.tipo,a.concepto`).all());
});
app.post('/api/aranceles', auth(ADM), (req, res) => {
  const { concepto, monto, tipo, carrera_id, descripcion } = req.body;
  const id = 'ar_'+Date.now();
  db.prepare('INSERT INTO aranceles (id,concepto,monto,tipo,carrera_id,descripcion) VALUES (?,?,?,?,?,?)').run(id,concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null);
  res.json({ id });
});
app.put('/api/aranceles/:id', auth(ADM), (req, res) => {
  const { concepto, monto, tipo, carrera_id, descripcion, activo } = req.body;
  db.prepare('UPDATE aranceles SET concepto=?,monto=?,tipo=?,carrera_id=?,descripcion=?,activo=?,fecha_actualizacion=date("now") WHERE id=?').run(concepto,monto||0,tipo||'cuota',carrera_id||null,descripcion||null,activo?1:0,req.params.id);
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
    db.prepare('UPDATE habilitaciones_examen SET habilitado=?,habilitado_por=?,motivo=?,fecha=date("now") WHERE id=?').run(habilitado?1:0, req.user.id, motivo||null, existente.id);
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
        // Buscar datos del docente en el seed original
        const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(uid);
        if (!u) {
          insU.run(uid, d.especialidad||'Docente', '', `${d.id}@its.edu.py`, passDoc, 'docente');
          db.prepare('UPDATE docentes SET usuario_id=? WHERE id=?').run(uid, d.id);
          created++;
        }
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
    alumno_ids.forEach(id => { result[id] = { habilitado: true, razon: 'sin_periodo_activo', cuotas_faltantes: [] }; });
    return res.json(result);
  }
  const cuotasRequeridas = ['Cuota 1', 'Cuota 2', 'Cuota 3', 'Cuota 4', 'Cuota 5'];
  // Una sola query para todos los pagos de todos los alumnos del período
  const placeholders = alumno_ids.map(() => '?').join(',');
  const pagos = db.prepare(`SELECT alumno_id, concepto FROM pagos WHERE alumno_id IN (${placeholders}) AND periodo_id=? AND estado='Pagado'`).all(...alumno_ids, periodo.id);
  const alumnos = db.prepare(`SELECT id,nombre,apellido,habilitado_pago_pendiente FROM alumnos WHERE id IN (${placeholders})`).all(...alumno_ids);
  const pagosPorAlumno = {};
  pagos.forEach(p => {
    if (!pagosPorAlumno[p.alumno_id]) pagosPorAlumno[p.alumno_id] = [];
    pagosPorAlumno[p.alumno_id].push(p.concepto);
  });
  const result = {};
  alumnos.forEach(al => {
    if (al.habilitado_pago_pendiente) {
      result[al.id] = { habilitado: true, razon: 'habilitacion_especial', cuotas_faltantes: [] };
      return;
    }
    const conceptos = pagosPorAlumno[al.id] || [];
    const faltantes = cuotasRequeridas.filter(c => !conceptos.some(p => p === c || p.includes(c)));
    result[al.id] = faltantes.length === 0
      ? { habilitado: true, razon: 'pago_al_dia', cuotas_faltantes: [] }
      : { habilitado: false, razon: 'mora_de_pago', cuotas_faltantes: faltantes, alumno: `${al.apellido}, ${al.nombre}` };
  });
  res.json(result);
});

// ── BACKUP DE BASE DE DATOS ───────────────────────────────────────────────────
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
app.get('/api/admin/auditoria', auth(ADM), (req, res) => {
  const { tabla, accion, usuario_id, desde, hasta, limite } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (tabla)      { where += ' AND a.tabla=?';       params.push(tabla); }
  if (accion)     { where += ' AND a.accion=?';      params.push(accion); }
  if (usuario_id) { where += ' AND a.usuario_id=?';  params.push(usuario_id); }
  if (desde)      { where += ' AND a.fecha>=?';      params.push(desde); }
  if (hasta)      { where += " AND a.fecha<=?";      params.push(hasta+' 23:59:59'); }
  const lim = Math.min(parseInt(limite)||200, 1000);
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
    WHERE al.curso_id=(SELECT curso_id FROM asignaciones WHERE id=?) AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u2.apellido)`, ex.tipo).all(ex.tipo, ex.asignacion_id, ex.asignacion_id) : [];

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
  const alumnos = db.prepare(`
    SELECT al.matricula, COALESCE(al.ci,u2.ci) as ci,
      COALESCE(al.nombre,u2.nombre) as nombre, COALESCE(al.apellido,u2.apellido) as apellido,
      n.tp1, n.tp2, n.tp3, n.tp4, n.tp5, n.tp_total
    FROM alumnos al
    LEFT JOIN usuarios u2 ON al.usuario_id=u2.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.curso_id=? AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u2.apellido)`).all(req.params.id, asig.curso_id);
  const inst = db.prepare('SELECT * FROM institucion WHERE id=1').get() || {};
  res.json({ asignacion: asig, alumnos, institucion: inst });
});

// ── MIDDLEWARE GLOBAL DE ERRORES (captura cualquier crash) ──────────────────
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
