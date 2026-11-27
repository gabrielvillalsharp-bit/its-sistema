import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, director;

beforeAll(() => {
  // Servidor de prueba: base temporal, sin WhatsApp / IA / respaldos y sin tareas programadas ni puerto
  process.env.ITS_TEST = '1';
  process.env.AVISO_INACTIVO_DESDE = '2020-01-01'; // en producción el aviso empieza el 4/12/2026
  process.env.DB_PATH = path.join(os.tmpdir(), 'its_vitest_' + Date.now() + '.db');
  process.env.JWT_SECRET = 'secreto-de-pruebas';
  for (const k of ['EVOLUTION_URL', 'EVOLUTION_KEY', 'EVOLUTION_INSTANCE', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'GITHUB_BACKUP_REPO', 'GITHUB_BACKUP_TOKEN', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'RAILWAY_VOLUME_MOUNT_PATH']) process.env[k] = '';
  ({ app, db } = require('../backend/server.js'));
  director = jwt.sign({ id: 'u_director', nombre: 'D', apellido: 'S', rol: 'director', email: 'd@its', docenteId: null, alumnoId: null, sede: 'pjc' }, 'secreto-de-pruebas', { expiresIn: '1h' });
});

const auth = (r) => r.set('Authorization', 'Bearer ' + director);

describe('API', () => {
  it('sin sesión no se accede a los datos', async () => {
    expect((await request(app).get('/api/alumnos')).status).toBe(401);
    expect((await request(app).get('/api/examenes/calendario.pdf')).status).toBe(401);
  });
  it('plantilla de alumnos: Excel válido (exceljs)', async () => {
    const r = await auth(request(app).get('/api/alumnos/plantilla')).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.body.slice(0, 2).toString()).toBe('PK'); // un .xlsx es un zip
  });
  it('calendario de exámenes en PDF (pdfkit)', async () => {
    const r = await auth(request(app).get('/api/examenes/calendario.pdf')).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.slice(0, 4).toString()).toBe('%PDF');
  });
  describe('alumnos inactivos y puntaje cargado por el docente', () => {
    let asig, docUsuario, cursoId;
    const nuevoAlumno = (id, estado, tel) => db.prepare("INSERT INTO alumnos (id,nombre,apellido,ci,estado,curso_id,carrera_id,telefono) VALUES (?,?,?,?,?,?,(SELECT carrera_id FROM cursos WHERE id=?),?)")
      .run(id, 'Nom' + id, 'Ape' + id, '9' + id.length + id.charCodeAt(1), estado, cursoId, cursoId, tel || null);
    beforeAll(() => {
      // una base nueva no trae algunas columnas que la de producción sí tiene (ver nota en tests/LEEME.md)
      try { db.prepare('ALTER TABLE alumnos ADD COLUMN habilitado_pago_pendiente INTEGER DEFAULT 0').run(); } catch {}
      asig = db.prepare('SELECT a.id, a.curso_id, a.docente_id, d.usuario_id FROM asignaciones a JOIN docentes d ON d.id=a.docente_id LIMIT 1').get();
      cursoId = asig.curso_id; docUsuario = asig.usuario_id;
      nuevoAlumno('t_activo', 'Activo'); nuevoAlumno('t_inactivo', 'Inactivo', '0981000111'); nuevoAlumno('t_retirado', 'Retirado');
      nuevoAlumno('t_inactivo_sin_tel', 'Inactivo');
    });
    it('la planilla del docente incluye Activos e Inactivos (marcados), no Retirados', async () => {
      const r = await auth(request(app).get('/api/notas/asignacion/' + asig.id));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const por = Object.fromEntries(r.body.alumnos.map(a => [a.id, a.estado_alumno]));
      expect(por.t_activo).toBe('Activo');
      expect(por.t_inactivo).toBe('Inactivo');
      expect(por.t_retirado).toBeUndefined();
    });
    it('al cargarle puntaje a un inactivo con teléfono se registra el aviso; sin teléfono no', async () => {
      const tokDoc = jwt.sign({ id: docUsuario, nombre: 'Doc', apellido: 'X', rol: 'docente', email: 'doc@its', docenteId: asig.docente_id, alumnoId: null, sede: 'pjc' }, 'secreto-de-pruebas', { expiresIn: '1h' });
      const put = (al) => request(app).put('/api/notas/' + al + '/' + asig.id).set('Authorization', 'Bearer ' + tokDoc).send({ tp1: 7 });
      expect((await put('t_inactivo')).status).toBe(200);
      expect((await put('t_inactivo_sin_tel')).status).toBe(200);
      expect((await put('t_activo')).status).toBe(200);
      await new Promise(r => setTimeout(r, 1500)); // el aviso se manda en segundo plano
      const av = db.prepare("SELECT destinatario_id FROM wa_mensajes WHERE mensaje LIKE '%no podrá rendir los exámenes finales%'").all().map(r => r.destinatario_id);
      expect(av).toContain('t_inactivo');
      expect(av).not.toContain('t_inactivo_sin_tel');
      expect(av).not.toContain('t_activo');
    });
  });
  it('PDF de habilitados sin nota: solo exámenes ya rendidos, con el detalle de la nota que falta', async () => {
    const asig = db.prepare('SELECT a.id, a.curso_id FROM asignaciones a LIMIT 1').get();
    const per = db.prepare('SELECT id FROM periodos LIMIT 1').get().id;
    db.prepare("INSERT INTO alumnos (id,nombre,apellido,ci,estado,curso_id,carrera_id) VALUES ('t_hab','Hab','Pendiente','5551234','Activo',?,(SELECT carrera_id FROM cursos WHERE id=?))").run(asig.curso_id, asig.curso_id);
    db.prepare("INSERT INTO examenes (id,asignacion_id,tipo,fecha,hora,periodo_id) VALUES ('t_ex_pasado',?,'final_ord','2020-01-10','19:00',?)").run(asig.id, per);
    db.prepare("INSERT INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado) VALUES ('t_h1','t_hab',?,'final_ord',1)").run(asig.id);
    const j = await auth(request(app).get('/api/admin/habilitados-sin-nota'));
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    expect(j.body.some(r => r.alumno_id === 't_hab' && r.tipo_examen === 'final_ord')).toBe(true);
    db.prepare("INSERT INTO alumnos (id,nombre,apellido,ci,estado,curso_id,carrera_id) VALUES ('t_hab_ina','Hab','Inactivo','5559999','Inactivo',?,(SELECT carrera_id FROM cursos WHERE id=?))").run(asig.curso_id, asig.curso_id);
    db.prepare("INSERT INTO habilitaciones_examen (id,alumno_id,asignacion_id,tipo_examen,habilitado) VALUES ('t_h2','t_hab_ina',?,'final_ord',1)").run(asig.id);
    const todos = (await auth(request(app).get('/api/admin/habilitados-sin-nota'))).body;
    expect(todos.find(r => r.alumno_id === 't_hab_ina')?.estado_alumno).toBe('Inactivo');
    expect(todos.find(r => r.alumno_id === 't_hab')?.estado_alumno).toBe('Activo');
    for (const est of ['Activo', 'Inactivo']) {
      const pr = await auth(request(app).get('/api/admin/habilitados-sin-nota.pdf?estado=' + est)).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(pr.status).toBe(200); expect(pr.body.slice(0, 4).toString()).toBe('%PDF');
    }
    const r = await auth(request(app).get('/api/admin/habilitados-sin-nota.pdf')).buffer(true).parse((res, cb) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
