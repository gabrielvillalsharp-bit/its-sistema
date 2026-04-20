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
const ADM = ['director','admin','secretaria'];

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

// ── ESCALA DE NOTAS ───────────────────────────────────────────────────────────
app.get('/api/escala', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM escala_notas ORDER BY nota').all());
});
app.put('/api/escala', auth(['director','admin']), (req, res) => {
  const { escala } = req.body; // array de {id, nota, puntaje_min, puntaje_max, descripcion}
  const upd = db.prepare('UPDATE escala_notas SET nota=?,puntaje_min=?,puntaje_max=?,descripcion=? WHERE id=?');
  const trx = db.transaction(() => escala.forEach(e => upd.run(e.nota, e.puntaje_min, e.puntaje_max, e.descripcion, e.id)));
  trx();
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
app.delete('/api/periodos/:id', auth(['director']), (req, res) => { db.prepare('DELETE FROM periodos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
app.delete('/api/carreras/:id', auth(['director']), (req, res) => { db.prepare('DELETE FROM carreras WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
app.delete('/api/cursos/:id', auth(['director']), (req, res) => { db.prepare('DELETE FROM cursos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
app.delete('/api/materias/:id', auth(['director']), (req, res) => { db.prepare('DELETE FROM materias WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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
app.delete('/api/docentes/:uid', auth(['director']), (req, res) => {
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
    ${where} ORDER BY c.nombre,cu.anio,cu.division,COALESCE(a.apellido,u.apellido)`).all(...params));
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
app.delete('/api/alumnos/:id', auth(['director']), (req, res) => {
  const a = db.prepare('SELECT usuario_id FROM alumnos WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM alumnos WHERE id=?').run(req.params.id);
  if (a?.usuario_id) db.prepare('DELETE FROM usuarios WHERE id=?').run(a.usuario_id);
  res.json({ ok: true });
});

// Importar desde Excel
app.post('/api/alumnos/importar', auth(ADM), upload.single('archivo'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    const results = { ok: 0, errores: [] };
    rows.forEach(row => {
      try {
        const carrera = db.prepare('SELECT id,codigo FROM carreras WHERE codigo=? OR nombre=?').get(String(row.carrera||'').trim(), String(row.carrera||'').trim());
        if (!carrera) { results.errores.push(`${row.nombre||'?'}: carrera no encontrada "${row.carrera}"`); return; }
        const nombre = String(row.nombre||'').trim(), apellido = String(row.apellido||'').trim(), ci = String(row.ci||'').trim();
        if (!nombre || !ci) { results.errores.push(`Fila incompleta: nombre="${nombre}" ci="${ci}"`); return; }
        if (db.prepare('SELECT id FROM alumnos WHERE ci=?').get(ci)) { results.errores.push(`CI duplicada: ${ci} (${nombre} ${apellido})`); return; }
        let cursoId = null;
        if (row.anio) {
          const div = String(row.division||'U').trim().toUpperCase();
          cursoId = db.prepare('SELECT id FROM cursos WHERE carrera_id=? AND anio=? AND division=?').get(carrera.id, parseInt(row.anio), div)?.id || null;
        }
        const cnt = db.prepare('SELECT COUNT(*) as n FROM alumnos WHERE carrera_id=?').get(carrera.id).n;
        const matricula = `${carrera.codigo}-${new Date().getFullYear()}-${String(cnt+1).padStart(3,'0')}`;
        db.prepare('INSERT INTO alumnos (id,matricula,carrera_id,curso_id,fecha_ingreso,estado,telefono,ci,nombre,apellido) VALUES (?,?,?,?,?,?,?,?,?,?)').run('a_'+Date.now()+'_'+Math.random().toString(36).slice(2,5),matricula,carrera.id,cursoId,new Date().toISOString().split('T')[0],'Activo',String(row.telefono||'').trim(),ci,nombre,apellido);
        results.ok++;
      } catch(e) { results.errores.push(`Error en fila: ${e.message}`); }
    });
    res.json(results);
  } catch(e) { res.status(400).json({ error: 'Error procesando archivo: '+e.message }); }
});

app.get('/api/alumnos/plantilla', auth(ADM), (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { nombre:'Ana',apellido:'García',ci:'3.456.789',telefono:'0981-111-001',carrera:'CRM',anio:1,division:'A' },
    { nombre:'Luis',apellido:'Pérez',ci:'4.567.890',telefono:'0982-222-002',carrera:'FAR',anio:1,division:'B' },
    { nombre:'María',apellido:'Sánchez',ci:'5.678.901',telefono:'0983-333-003',carrera:'ENF',anio:2,division:'U' },
  ]);
  ws['!cols'] = [{wch:14},{wch:20},{wch:12},{wch:14},{wch:8},{wch:5},{wch:9}];
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
      (SELECT COUNT(*) FROM alumnos WHERE curso_id=a.curso_id AND estado='Activo') as total_alumnos
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

// ── NOTAS ─────────────────────────────────────────────────────────────────────
// Obtener todos los alumnos de una asignación con sus notas
app.get('/api/notas/asignacion/:asig_id', auth(), (req, res) => {
  const asig = db.prepare('SELECT a.*,m.peso_tp,m.peso_parcial,m.peso_final FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id=?').get(req.params.asig_id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });
  const alumnos = db.prepare(`
    SELECT al.id,al.matricula,COALESCE(al.ci,u.ci) as alumno_ci,
      COALESCE(al.nombre,u.nombre) as alumno_nombre,
      COALESCE(al.apellido,u.apellido) as alumno_apellido,
      n.id as nota_id,n.tp,n.parcial,n.parcial_recuperatorio,n.final,n.final_extraordinario,
      n.parcial_efectivo,n.final_efectivo,n.puntaje_total,n.nota_final,n.estado as nota_estado
    FROM alumnos al
    LEFT JOIN usuarios u ON al.usuario_id=u.id
    LEFT JOIN notas n ON n.alumno_id=al.id AND n.asignacion_id=?
    WHERE al.curso_id=? AND al.estado='Activo'
    ORDER BY COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id, asig.curso_id);
  res.json({ alumnos, pesos: { tp: asig.peso_tp, parcial: asig.peso_parcial, final: asig.peso_final } });
});

// Guardar/actualizar notas de un alumno
app.put('/api/notas/:alumno_id/:asig_id', auth(['director','docente','admin']), (req, res) => {
  const { tp, parcial, parcial_recuperatorio, final, final_extraordinario } = req.body;
  const asig = db.prepare('SELECT a.*,m.peso_tp,m.peso_parcial,m.peso_final FROM asignaciones a JOIN materias m ON a.materia_id=m.id WHERE a.id=?').get(req.params.asig_id);
  if (!asig) return res.status(404).json({ error: 'Asignación no encontrada' });

  const calc = calcularPuntaje(
    tp !== '' ? parseFloat(tp) : null,
    parcial !== '' ? parseFloat(parcial) : null,
    parcial_recuperatorio !== '' && parcial_recuperatorio != null ? parseFloat(parcial_recuperatorio) : null,
    final !== '' ? parseFloat(final) : null,
    final_extraordinario !== '' && final_extraordinario != null ? parseFloat(final_extraordinario) : null,
    asig.peso_tp, asig.peso_parcial, asig.peso_final
  );

  const estado = calc.puntaje === null ? 'Pendiente' : (calc.nota >= 2 ? 'Aprobado' : 'Reprobado');
  const existe = db.prepare('SELECT id FROM notas WHERE alumno_id=? AND asignacion_id=?').get(req.params.alumno_id, req.params.asig_id);

  const vals = [
    tp !== '' ? parseFloat(tp) : null,
    parcial !== '' ? parseFloat(parcial) : null,
    parcial_recuperatorio !== '' && parcial_recuperatorio != null ? parseFloat(parcial_recuperatorio) : null,
    final !== '' ? parseFloat(final) : null,
    final_extraordinario !== '' && final_extraordinario != null ? parseFloat(final_extraordinario) : null,
    calc.parcial_ef ?? null, calc.final_ef ?? null,
    calc.puntaje, calc.nota, estado
  ];

  if (existe) {
    db.prepare('UPDATE notas SET tp=?,parcial=?,parcial_recuperatorio=?,final=?,final_extraordinario=?,parcial_efectivo=?,final_efectivo=?,puntaje_total=?,nota_final=?,estado=? WHERE alumno_id=? AND asignacion_id=?').run(...vals, req.params.alumno_id, req.params.asig_id);
  } else {
    db.prepare('INSERT INTO notas (id,alumno_id,asignacion_id,tp,parcial,parcial_recuperatorio,final,final_extraordinario,parcial_efectivo,final_efectivo,puntaje_total,nota_final,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('n_'+Date.now(), req.params.alumno_id, req.params.asig_id, ...vals);
  }
  res.json({ puntaje: calc.puntaje, nota: calc.nota, parcial_ef: calc.parcial_ef, final_ef: calc.final_ef, estado });
});

// Notas de un alumno específico (para vista alumno)
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

// ── ASISTENCIA ────────────────────────────────────────────────────────────────
app.get('/api/asistencia/asignacion/:asig_id', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT as2.*,COALESCE(al.nombre,u.nombre) as alumno_nombre,COALESCE(al.apellido,u.apellido) as alumno_apellido
    FROM asistencia as2 JOIN alumnos al ON as2.alumno_id=al.id LEFT JOIN usuarios u ON al.usuario_id=u.id
    WHERE as2.asignacion_id=? ORDER BY as2.fecha,COALESCE(al.apellido,u.apellido)`).all(req.params.asig_id));
});
app.post('/api/asistencia/bulk', auth(['director','docente','admin']), (req, res) => {
  const { asignacion_id, fecha, registros } = req.body;
  db.transaction(() => {
    registros.forEach(r => {
      db.prepare('INSERT OR REPLACE INTO asistencia (id,alumno_id,asignacion_id,fecha,estado,observacion) VALUES (?,?,?,?,?,?)').run('as_'+Date.now()+'_'+Math.random().toString(36).slice(2,4),r.alumno_id,asignacion_id,fecha,r.estado,r.observacion||null);
    });
  })();
  res.json({ ok: true });
});

// ── PAGOS ─────────────────────────────────────────────────────────────────────
app.get('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id } = req.query;
  const where = alumno_id ? 'WHERE p.alumno_id=?' : '';
  res.json(db.prepare(`SELECT p.*,COALESCE(al.nombre,u.nombre) as nombre,COALESCE(al.apellido,u.apellido) as apellido,c.nombre as carrera
    FROM pagos p JOIN alumnos al ON p.alumno_id=al.id LEFT JOIN usuarios u ON al.usuario_id=u.id JOIN carreras c ON al.carrera_id=c.id
    ${where} ORDER BY p.fecha_pago DESC LIMIT 200`).all(...(alumno_id?[alumno_id]:[])));
});
app.post('/api/pagos', auth(ADM), (req, res) => {
  const { alumno_id, periodo_id, concepto, monto, fecha_pago, comprobante } = req.body;
  db.prepare('INSERT INTO pagos (id,alumno_id,periodo_id,concepto,monto,fecha_pago,estado,comprobante) VALUES (?,?,?,?,?,?,?,?)').run('pg_'+Date.now(),alumno_id,periodo_id,concepto,monto,fecha_pago,'Pagado',comprobante||null);
  res.json({ ok: true });
});

// ── USUARIOS CON ACCESO TOTAL (directores) ────────────────────────────────────
app.get('/api/usuarios/directores', auth(['director']), (req, res) => {
  res.json(db.prepare("SELECT id,nombre,apellido,email,ci,activo,rol FROM usuarios WHERE rol IN ('director','admin','secretaria') ORDER BY nombre").all());
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

// ── MI PERFIL — cualquier usuario puede cambiar su propia contraseña ───────────
app.get('/api/mi-perfil', auth(), (req, res) => {
  const u = db.prepare('SELECT id,nombre,apellido,email,ci,rol FROM usuarios WHERE id=?').get(req.user.id);
  res.json(u);
});
app.put('/api/mi-perfil/password', auth(), (req, res) => {
  const { actual, nueva } = req.body;
  const u = db.prepare('SELECT password_hash FROM usuarios WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(actual, u.password_hash)) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
  if (!nueva || nueva.length < 4) return res.status(400).json({ error: 'La nueva contraseña es muy corta' });
  db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(bcrypt.hashSync(nueva, 10), req.user.id);
  res.json({ ok: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth(), (req, res) => {
  res.json({
    total_alumnos: db.prepare("SELECT COUNT(*) as n FROM alumnos WHERE estado='Activo'").get().n,
    total_docentes: db.prepare("SELECT COUNT(*) as n FROM usuarios WHERE rol='docente' AND activo=1").get().n,
    total_carreras: db.prepare("SELECT COUNT(*) as n FROM carreras WHERE activa=1").get().n,
    total_cursos: db.prepare("SELECT COUNT(*) as n FROM cursos WHERE activo=1").get().n,
    periodo_activo: db.prepare("SELECT nombre FROM periodos WHERE activo=1").get()?.nombre||'Sin período activo',
    aprobados: db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Aprobado'").get().n,
    reprobados: db.prepare("SELECT COUNT(*) as n FROM notas WHERE estado='Reprobado'").get().n,
    por_carrera: db.prepare("SELECT c.nombre,COUNT(a.id) as total FROM carreras c LEFT JOIN alumnos a ON c.id=a.carrera_id AND a.estado='Activo' WHERE c.activa=1 GROUP BY c.id ORDER BY total DESC").all()
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'..','frontend','public','index.html')));
app.listen(PORT, () => { console.log(`✓ ITS v3 en http://localhost:${PORT}\n  director@its.edu.py / director123`); });
