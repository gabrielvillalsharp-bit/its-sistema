// Herramientas de SOLO LECTURA que el bot de WhatsApp puede consultar. Solo información INSTITUCIONAL:
// fechas de exámenes, horarios de clases y costos de documentos. NINGUNA devuelve datos de un alumno
// (notas, pagos, deuda, asistencia, estado): eso se atiende únicamente en la plataforma académica.
// La restricción está en este código, no en el prompt: aunque alguien insista, no existe herramienta que lo entregue.

const _norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const MAX_FILAS = 60;

function crearHerramientasBot({ db, periodoVigenteId, hoyPY }) {

  // Busca la carrera que nombró la persona (tolera tildes, mayúsculas y nombres parciales).
  function _buscarCarrera(texto) {
    const t = _norm(texto);
    if (!t) return { error: 'Falta la carrera. Preguntale a la persona de qué carrera se trata.' };
    // Solo carreras con cursos activos: cada carrera tiene un espejo vacío de Cerro Corá (cc_) que duplicaría los nombres.
    const lista = db.prepare("SELECT ca.id, ca.nombre FROM carreras ca WHERE ca.activa=1 AND EXISTS (SELECT 1 FROM cursos WHERE carrera_id=ca.id AND activo=1) ORDER BY ca.nombre").all();
    const hits = lista.filter(c => { const n = _norm(c.nombre); return n.includes(t) || t.includes(n); });
    if (hits.length === 1) return { carrera: hits[0] };
    if (hits.length > 1) return { error: 'Hay varias carreras que coinciden: ' + hits.map(h => h.nombre).join(', ') + '. Preguntale cuál es.' };
    return { error: 'No encontré esa carrera. Las carreras son: ' + lista.map(c => c.nombre).join(', ') + '.' };
  }

  const _anio = v => { const n = parseInt(v, 10); return n >= 1 && n <= 4 ? n : null; };

  function fechas_examenes({ carrera, anio, materia, tipo } = {}) {
    const r = _buscarCarrera(carrera);
    if (r.error) return { error: r.error };
    const pid = periodoVigenteId();
    if (!pid) return { error: 'No hay un semestre en curso cargado.' };
    // Fechas suspendidas por la Dirección: no se informan (igual que en la plataforma del alumno).
    let suspendidas = [];
    try { suspendidas = String(db.prepare("SELECT valor FROM configuracion WHERE clave='fechas_examen_suspendidas'").get()?.valor || '').split(',').map(s => s.trim()).filter(Boolean); } catch {}
    const hoy = hoyPY();
    const a = _anio(anio);
    const filas = db.prepare(`
      SELECT e.tipo, e.fecha, e.hora, e.aula, m.nombre AS materia, cu.anio, cu.division
      FROM examenes e
      JOIN asignaciones asg ON e.asignacion_id = asg.id
      JOIN materias m  ON asg.materia_id = m.id
      JOIN cursos cu   ON asg.curso_id = cu.id
      WHERE e.periodo_id = ? AND cu.carrera_id = ? AND e.fecha >= ?
      ORDER BY e.fecha, e.hora, m.nombre`).all(pid, r.carrera.id, hoy)
      .filter(f => !suspendidas.includes(f.fecha))
      .filter(f => !a || f.anio === a)
      .filter(f => !materia || _norm(f.materia).includes(_norm(materia)))
      .filter(f => {
        const t = _norm(tipo);
        if (!t || t === 'todos') return true;
        return _norm(f.tipo).includes(t);
      });
    return {
      carrera: r.carrera.nombre,
      hoy,
      total: filas.length,
      mostrando: Math.min(filas.length, MAX_FILAS),
      examenes: filas.slice(0, MAX_FILAS).map(f => ({
        tipo: f.tipo, fecha: f.fecha, hora: f.hora || null, aula: f.aula || null,
        materia: f.materia, curso: f.anio + '° año' + (f.division ? ' ' + f.division : '')
      })),
      nota: filas.length === 0 ? 'No hay exámenes próximos con esos datos. Si insisten, derivá a un asesor.' : 'Solo se listan los exámenes desde hoy. Las fechas pueden cambiar: ante dudas, confirmar con Dirección.'
    };
  }

  function horario_de_clases({ carrera, anio } = {}) {
    const r = _buscarCarrera(carrera);
    if (r.error) return { error: r.error };
    const pid = periodoVigenteId();
    if (!pid) return { error: 'No hay un semestre en curso cargado.' };
    const a = _anio(anio);
    const filas = db.prepare(`
      SELECT h.dia, h.hora_inicio, h.hora_fin, m.nombre AS materia, cu.anio, cu.division
      FROM horarios h
      JOIN asignaciones asg ON h.asignacion_id = asg.id
      JOIN materias m ON asg.materia_id = m.id
      JOIN cursos cu  ON asg.curso_id = cu.id
      WHERE asg.periodo_id = ? AND cu.carrera_id = ?
      ORDER BY cu.anio, cu.division, h.dia, h.hora_inicio`).all(pid, r.carrera.id)
      .filter(f => !a || f.anio === a);
    return {
      carrera: r.carrera.nombre,
      total: filas.length,
      clases: filas.slice(0, MAX_FILAS).map(f => ({
        curso: f.anio + '° año' + (f.division ? ' ' + f.division : ''),
        dia: f.dia, desde: (f.hora_inicio || '').slice(0, 5), hasta: (f.hora_fin || '').slice(0, 5), materia: f.materia
      })),
      nota: filas.length === 0 ? 'No hay horarios cargados con esos datos.' : (filas.length > MAX_FILAS ? 'Hay más clases que las mostradas: pedí el año para acotar.' : '')
    };
  }

  // Solo documentos con costo propio y claro. Matrícula y aranceles de examen quedan afuera a propósito
  // (matrícula pendiente de confirmación por la Dirección; los de examen se ven en la plataforma).
  function costos_documentos() {
    const filas = db.prepare("SELECT concepto, monto FROM aranceles WHERE activo=1 AND tipo IN ('certificado','otro') ORDER BY concepto").all();
    return {
      documentos: filas.map(f => ({ concepto: f.concepto, monto_gs: f.monto })),
      nota: 'Los trámites de documentos se realizan en secretaría. Si piden algo que no figura acá, no inventes: derivá a un asesor.'
    };
  }

  const definiciones = [
    {
      name: 'fechas_examenes',
      description: 'Fechas de exámenes próximos (parciales, recuperatorios, finales) de UNA carrera en el semestre en curso. Usala siempre que pregunten por fechas de exámenes; no las respondas de memoria porque cambian. Si faltan la carrera o el año, preguntalos antes.',
      input_schema: {
        type: 'object',
        properties: {
          carrera: { type: 'string', description: 'Nombre de la carrera, ej: Enfermería, Cosmiatría' },
          anio: { type: 'integer', description: 'Año de cursada (1, 2 o 3). Opcional.' },
          materia: { type: 'string', description: 'Parte del nombre de la materia. Opcional.' },
          tipo: { type: 'string', description: 'parcial, recuperatorio o final. Opcional; sin dato se listan todos.' }
        },
        required: ['carrera']
      }
    },
    {
      name: 'horario_de_clases',
      description: 'Días y horas de clase por materia de UNA carrera en el semestre en curso. Usala cuando pregunten por días u horarios exactos de clase.',
      input_schema: {
        type: 'object',
        properties: {
          carrera: { type: 'string', description: 'Nombre de la carrera' },
          anio: { type: 'integer', description: 'Año de cursada (1, 2 o 3). Opcional pero conviene pedirlo.' }
        },
        required: ['carrera']
      }
    },
    {
      name: 'costos_documentos',
      description: 'Costos de documentos que emite el instituto (ej. certificado de estudios). Usala cuando pregunten cuánto cuesta un documento o trámite.',
      input_schema: { type: 'object', properties: {} }
    }
  ];

  const ejecutores = { fechas_examenes, horario_de_clases, costos_documentos };
  function ejecutar(nombre, args) {
    const fn = ejecutores[nombre];
    if (!fn) return { error: 'Herramienta desconocida: ' + nombre };
    return fn(args && typeof args === 'object' ? args : {});
  }

  return { definiciones, ejecutar };
}

module.exports = { crearHerramientasBot };
