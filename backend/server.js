require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, init, calcularPuntaje } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'its_secret_2026';
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));
init();

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
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE (email=? OR ci=?) AND activo=1').get(email, email);
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email }, JWT_SECRET, { expiresIn: '10h' });
  let docenteId = null, alumnoId = null;
  if (u.rol === 'docente') docenteId = db.prepare('SELECT id FROM docentes WHERE usuario_id=?').get(u.id)?.id;
  if (u.rol === 'alumno')  alumnoId  = db.prepare('SELECT id FROM alumnos  WHERE usuario_id=?').get(u.id)?.id;
  res.json({ token, user: { id: u.id, nombre: u.nombre, apellido: u.apellido, rol: u.rol, email: u.email, docenteId, alumnoId } });
});

// ── USUARIOS ──────────────────────────────────────────────────────────────────
app.get('/api/usuarios/directores', auth(['director']), (req, res) => {
  res.json(db.prepare("SELECT id,nombre,apellido,email,ci,activo,rol FROM usuarios WHERE rol IN ('director') ORDER BY nombre").all());
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
  const { nombre, direccion, telefono, email, mision } = req.body;
  db.prepare('UPDATE institucion SET nombre=?,direccion=?,telefono=?,email=?,mision=? WHERE id=1').run(nombre,direccion,telefono,email,mision);
  res.json({ ok: true });
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
  const rows = db.prepare('SELECT * FROM carreras ORDER BY nombre').all();
  rows.forEach(c => {
    c.total_alumnos = db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=? AND estado='Activo'").get(c.id).n;
    c.total_materias = db.prepare('SELECT COUNT(*) as n FROM materias WHERE carrera_id=?').get(c.id).n;
    c.cursos = db.prepare('SELECT * FROM cursos WHERE carrera_id=? ORDER BY anio,division').all(c.id);
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
  const { carrera_id, curso_id } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (carrera_id) { where += ' AND a.carrera_id=?'; params.push(carrera_id); }
  if (curso_id)   { where += ' AND a.curso_id=?';   params.push(curso_id); }
  res.json(db.prepare(`
    SELECT a.*,c.nombre as carrera_nombre,c.codigo as carrera_codigo,
      cu.anio,cu.division,
      COALESCE(a.nombre,u.nombre) as display_nombre,
      COALESCE(a.apellido,u.apellido) as display_apellido,
      COALESCE(a.ci,u.ci) as display_ci, u.email
    FROM alumnos a JOIN carreras c ON a.carrera_id=c.id
    LEFT JOIN cursos cu ON a.curso_id=cu.id
    LEFT JOIN usuarios u ON a.usuario_id=u.id
    ${where} ORDER BY COALESCE(a.apellido,u.apellido)`).all(...params));
});
app.post('/api/alumnos', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, email, password, carrera_id, curso_id, telefono, direccion, fecha_ingreso } = req.body;
  const carr = db.prepare('SELECT codigo FROM carreras WHERE id=?').get(carrera_id);
  const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera_id).n;
  const matricula = `${carr.codigo}-${new Date().getFullYear()}-${String(cnt+1).padStart(3,'0')}`;
  const aid = 'a_'+Date.now();
  let uid = null;
  if (email) {
    uid = 'u_a_'+Date.now();
    db.prepare('INSERT INTO usuarios (id,nombre,apellido,ci,email,password_hash,rol) VALUES (?,?,?,?,?,?,?)').run(uid,nombre,apellido,ci,email,bcrypt.hashSync(password||ci,10),'alumno');
  }
  db.prepare('INSERT INTO alumnos (id,usuario_id,matricula,carrera_id,curso_id,fecha_ingreso,estado,telefono,direccion,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(aid,uid,matricula,carrera_id,curso_id||null,fecha_ingreso||new Date().toISOString().split('T')[0],'Activo',telefono||null,direccion||null,ci,nombre,apellido);
  res.json({ id: aid, matricula });
});
app.put('/api/alumnos/:id', auth(ADM), (req, res) => {
  const { nombre, apellido, ci, telefono, direccion, estado, carrera_id, curso_id } = req.body;
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
  const { docente_id, materia_id, curso_id, periodo_id } = req.body;
  try {
    const id = 'asig_'+Date.now();
    db.prepare('INSERT INTO asignaciones (id,docente_id,materia_id,curso_id,periodo_id) VALUES (?,?,?,?,?)').run(id,docente_id,materia_id,curso_id,periodo_id);
    res.json({ id });
  } catch { res.status(400).json({ error: 'Esta asignación ya existe' }); }
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
  const { tp1,tp2,tp3,tp4,tp5,parcial,parcial_recuperatorio,final_ord,final_recuperatorio,complementario,extraordinario,ausente } = req.body;
  const n = f => (f !== '' && f != null) ? parseFloat(f) : null;
  if (ausente) {
    const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(req.params.alumno_id, req.params.asig_id);
    if (existe) db.prepare('UPDATE notas SET ausente=1,puntaje_total=NULL,nota_final=NULL,estado=? WHERE alumno_id=? AND asignacion_id=?').run('Ausente',req.params.alumno_id,req.params.asig_id);
    else db.prepare('INSERT INTO notas (id,alumno_id,asignacion_id,ausente,estado) VALUES (?,?,?,1,?)').run('n_'+Date.now(),req.params.alumno_id,req.params.asig_id,'Ausente');
    return res.json({ puntaje: null, nota: null, estado: 'Ausente' });
  }
  const calc = calcularPuntaje(n(tp1),n(tp2),n(tp3),n(tp4),n(tp5),n(parcial),n(parcial_recuperatorio),n(final_ord),n(final_recuperatorio),n(complementario),n(extraordinario));
  const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(req.params.alumno_id, req.params.asig_id);
  const fields = { tp1:n(tp1),tp2:n(tp2),tp3:n(tp3),tp4:n(tp4),tp5:n(tp5),tp_total:calc.tp_total??null,
    parcial:n(parcial),parcial_recuperatorio:n(parcial_recuperatorio),parcial_efectivo:calc.parcial_ef??null,
    final_ord:n(final_ord),final_recuperatorio:n(final_recuperatorio),complementario:n(complementario),final_efectivo:calc.final_ef??null,
    extraordinario:n(extraordinario),ausente:0,puntaje_total:calc.puntaje??null,nota_final:calc.nota??null,estado:calc.estado };
  if (existe) {
    db.prepare(`UPDATE notas SET tp1=?,tp2=?,tp3=?,tp4=?,tp5=?,tp_total=?,parcial=?,parcial_recuperatorio=?,parcial_efectivo=?,final_ord=?,final_recuperatorio=?,complementario=?,final_efectivo=?,extraordinario=?,ausente=0,puntaje_total=?,nota_final=?,estado=? WHERE alumno_id=? AND asignacion_id=?`).run(fields.tp1,fields.tp2,fields.tp3,fields.tp4,fields.tp5,fields.tp_total,fields.parcial,fields.parcial_recuperatorio,fields.parcial_efectivo,fields.final_ord,fields.final_recuperatorio,fields.complementario,fields.final_efectivo,fields.extraordinario,fields.puntaje_total,fields.nota_final,fields.estado,req.params.alumno_id,req.params.asig_id);
  } else {
    db.prepare(`INSERT INTO notas (id,alumno_id,asignacion_id,tp1,tp2,tp3,tp4,tp5,tp_total,parcial,parcial_recuperatorio,parcial_efectivo,final_ord,final_recuperatorio,complementario,final_efectivo,extraordinario,ausente,puntaje_total,nota_final,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`).run('n_'+Date.now(),req.params.alumno_id,req.params.asig_id,fields.tp1,fields.tp2,fields.tp3,fields.tp4,fields.tp5,fields.tp_total,fields.parcial,fields.parcial_recuperatorio,fields.parcial_efectivo,fields.final_ord,fields.final_recuperatorio,fields.complementario,fields.final_efectivo,fields.extraordinario,fields.puntaje_total,fields.nota_final,fields.estado);
  }
  res.json({ puntaje: calc.puntaje, nota: calc.nota, tp_total: calc.tp_total, parcial_ef: calc.parcial_ef, final_ef: calc.final_ef, estado: calc.estado });
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
app.post('/api/asistencia/bulk', auth(['director','docente']), (req, res) => {
  const { asignacion_id, fecha, registros } = req.body;
  db.transaction(() => {
    registros.forEach(r => {
      db.prepare('INSERT OR REPLACE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado,observacion) VALUES (?,?,?,?,?,?)').run('as_'+Date.now()+'_'+Math.random().toString(36).slice(2,4),r.alumno_id,asignacion_id,fecha,r.estado,r.observacion||null);
    });
  })();
  res.json({ ok: true });
});

// ── EXÁMENES ──────────────────────────────────────────────────────────────────
app.get('/api/examenes', auth(), (req, res) => {
  const { periodo_id, carrera_id, tipo } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (periodo_id) { where += ' AND e.periodo_id=?'; params.push(periodo_id); }
  if (carrera_id) { where += ' AND ca.id=?'; params.push(carrera_id); }
  if (tipo) { where += ' AND e.tipo=?'; params.push(tipo); }
  res.json(db.prepare(`
    SELECT e.*,
      m.nombre as materia_nombre,m.codigo as materia_codigo,
      ca.nombre as carrera_nombre,
      cu.anio as curso_anio,cu.division as curso_division,
      u.nombre as docente_nombre,u.apellido as docente_apellido,
      p.nombre as periodo_nombre,
      a.id as asignacion_id,
      (SELECT COUNT(*) FROM notas n WHERE n.asignacion_id=a.id AND
        CASE e.tipo WHEN 'Parcial' THEN n.parcial IS NOT NULL WHEN 'Final' THEN n.final_ord IS NOT NULL ELSE 0 END
      ) as notas_cargadas,
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
    FROM examenes e
    JOIN asignaciones a ON e.asignacion_id=a.id
    JOIN materias m ON a.materia_id=m.id
    JOIN cursos cu ON a.curso_id=cu.id
    JOIN carreras ca ON cu.carrera_id=ca.id
    JOIN docentes d ON a.docente_id=d.id
    JOIN usuarios u ON d.usuario_id=u.id
    JOIN periodos p ON e.periodo_id=p.id
    ${where} ORDER BY e.fecha,e.hora,ca.nombre`).all(...params));
});

app.post('/api/examenes', auth(ADM), (req, res) => {
  const { asignacion_id, tipo, fecha, hora, aula, periodo_id, observacion } = req.body;
  const id = 'ex_' + Date.now();
  db.prepare('INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,aula,periodo_id,observacion) VALUES (?,?,?,?,?,?,?,?)').run(id,asignacion_id,tipo,fecha,hora||null,aula||null,periodo_id,observacion||null);
  res.json({ id });
});

app.put('/api/examenes/:id', auth(ADM), (req, res) => {
  const { tipo, fecha, hora, aula, observacion } = req.body;
  db.prepare('UPDATE examenes SET tipo=?,fecha=?,hora=?,aula=?,observacion=? WHERE id=?').run(tipo,fecha,hora||null,aula||null,observacion||null,req.params.id);
  res.json({ ok: true });
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
  res.json(db.prepare(`SELECT av.*,u.nombre as autor_nombre,u.apellido as autor_apellido
    FROM avisos av JOIN usuarios u ON av.usuario_id=u.id
    WHERE av.activo=1 ORDER BY av.fijado DESC,av.fecha_creacion DESC LIMIT 50`).all());
});
app.post('/api/avisos', auth(ADM), (req, res) => {
  const { titulo, contenido, tipo, fijado } = req.body;
  const id = 'av_' + Date.now();
  db.prepare('INSERT INTO avisos (id,titulo,contenido,tipo,fijado,usuario_id) VALUES (?,?,?,?,?,?)').run(id,titulo,contenido,tipo||'info',fijado?1:0,req.user.id);
  res.json({ id });
});
app.put('/api/avisos/:id', auth(ADM), (req, res) => {
  const { titulo, contenido, tipo, fijado, activo } = req.body;
  db.prepare('UPDATE avisos SET titulo=?,contenido=?,tipo=?,fijado=?,activo=? WHERE id=?').run(titulo,contenido,tipo||'info',fijado?1:0,activo?1:0,req.params.id);
  res.json({ ok: true });
});
app.delete('/api/avisos/:id', auth(ADM), (req, res) => {
  db.prepare('UPDATE avisos SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── PAGOS ─────────────────────────────────────────────────────────────────────
app.get('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id } = req.query;
  const where = alumno_id ? 'WHERE p.alumno_id=?' : '';
  res.json(db.prepare(`SELECT p.*,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,c.nombre as carrera
    FROM pagos p JOIN alumnos al ON p.alumno_id=al.id LEFT JOIN usuarios u ON al.usuario_id=u.id JOIN carreras c ON al.carrera_id=c.id
    ${where} ORDER BY p.fecha_pago DESC LIMIT 500`).all(...(alumno_id?[alumno_id]:[])));
});
app.post('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto, fecha_pago, comprobante, descuento, beca, medio_pago } = req.body;
  db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante,descuento,beca,medio_pago) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('pg_'+Date.now(),alumno_id,periodo_id,concepto,monto,fecha_pago,'Pagado',comprobante||null,descuento||0,beca||null,medio_pago||'Efectivo');
  res.json({ ok: true });
});
app.delete('/api/pagos/:id', auth(ADM), (req, res) => { db.prepare('DELETE FROM pagos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
app.get('/api/becas', auth(ADM), (req, res) => {
  res.json(db.prepare(`
    SELECT b.*,COALESCE(al.nombre,u.nombre) as alumno_nombre,COALESCE(al.apellido,u.apellido) as alumno_apellido,
      c.nombre as carrera_nombre
    FROM becas b
    JOIN alumnos al ON b.alumno_id=al.id
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    JOIN carreras c ON al.carrera_id=c.id
    ORDER BY b.fecha_inicio DESC`).all());
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
  const periodo = db.prepare('SELECT id,nombre FROM periodos WHERE activo=1').get();
  const hoy = new Date().toISOString().split('T')[0];
  res.json({
    total_alumnos: db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo'").get().n,
    total_docentes: db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE rol='docente' AND activo=1").get().n,
    total_carreras: db.prepare("SELECT COUNT(*) as n FROM carreras WHERE activa=1").get().n,
    total_cursos: db.prepare("SELECT COUNT(*) as n FROM cursos WHERE activo=1").get().n,
    periodo_activo: periodo?.nombre || 'Sin período activo',
    aprobados: db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Aprobado'").get().n,
    reprobados: db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Reprobado'").get().n,
    examenes_hoy: periodo ? db.prepare("SELECT COUNT(*) as n FROM examenes WHERE fecha=? AND periodo_id=?").get(hoy, periodo.id).n : 0,
    deudores: periodo ? db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo' AND id NOT IN (SELECT alumno_id FROM pagos WHERE periodo_id=? AND concepto LIKE '%Matrícula%')").get(periodo.id).n : 0,
    por_carrera: db.prepare("SELECT c.nombre,COUNT(a.id) as total FROM carreras c LEFT JOIN alumnos a ON c.id=a.carrera_id AND a.estado='Activo' WHERE c.activa=1 GROUP BY c.id ORDER BY total DESC").all(),
    avisos: db.prepare("SELECT id,titulo,contenido,tipo,fijado,fecha_creacion FROM avisos WHERE activo=1 ORDER BY fijado DESC,fecha_creacion DESC LIMIT 5").all(),
    proximos_examenes: periodo ? db.prepare(`
      SELECT e.fecha,e.hora,e.tipo,m.nombre as materia,ca.nombre as carrera,cu.anio,cu.division
      FROM examenes e JOIN asignaciones a ON e.asignacion_id=a.id
      JOIN materias m ON a.materia_id=m.id JOIN cursos cu ON a.curso_id=cu.id
      JOIN carreras ca ON cu.carrera_id=ca.id
      WHERE e.fecha>=? AND e.periodo_id=? ORDER BY e.fecha,e.hora LIMIT 5`).all(hoy, periodo.id) : []
  });
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
  const diasSemana = { 'Lunes':1,'Martes':2,'Miércoles':3,'Jueves':4,'Viernes':5 };
  const horarios = db.prepare('SELECT * FROM horarios WHERE asignacion_id IS NOT NULL').all();
  if (!horarios.length) return res.status(400).json({ error: 'No hay horarios configurados' });

  const inicio = new Date(fecha_inicio + 'T12:00:00');
  const fin = fecha_fin ? new Date(fecha_fin + 'T12:00:00') : new Date(inicio.getFullYear(), 11, 31, 12);

  let totalGeneradas = 0;
  const insAs = db.prepare('INSERT OR IGNORE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    const cur = new Date(inicio);
    while (cur <= fin) {
      const diaN = cur.getDay(); // 0=Dom,1=Lun,...,5=Vie
      if (diaN >= 1 && diaN <= 5) {
        const diaName = ['','Lunes','Martes','Miércoles','Jueves','Viernes'][diaN];
        const fechaStr = cur.toISOString().split('T')[0];
        const horariosDelDia = horarios.filter(h => h.dia === diaName);
        horariosDelDia.forEach(h => {
          const alumnos = db.prepare(`SELECT id FROM alumnos WHERE curso_id=(SELECT curso_id FROM asignaciones WHERE id=?) AND estado='Activo'`).all(h.asignacion_id);
          alumnos.forEach(al => {
            const id = 'as_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
            insAs.run(id, al.id, h.asignacion_id, fechaStr, 'P');
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','index.html')));
app.listen(PORT, () => { console.log(`✓ ITS v4 en http://localhost:${PORT}`); });
