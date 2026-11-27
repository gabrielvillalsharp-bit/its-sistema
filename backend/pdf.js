// PDFs generados en el servidor con pdfkit (sin depender del navegador de quien los pide).
// pdfkit se carga recién al generar un PDF: si la librería fallara, el servidor igual arranca (Railway usa Node 18).
//
//  pdfTabla({ titulo, subtitulo, columnas:[{ t, w }], filas:[[...]], pie })         → tabla simple (calendario)
//  pdfInforme({ titulo, subtitulo, resumen:{ titulo, filas }, carreras:[...], columnas, pie })  → informe por carrera/año/materia
//     carreras: [{ nombre, cursos:[{ nombre, materias:[{ nombre, docente, filas:[[...]] }] }] }]
const VERDE = '#0F6E56', VERDE_OSC = '#04342C', GRIS = '#475569', ROJO = '#b91c1c';

// Pie de página con "Página X de Y". Se escribe con el margen inferior en 0: si no, pdfkit agrega una hoja en blanco por cada pie.
function ponerPies(doc, pie) {
  const n = doc.bufferedPageRange().count;
  for (let i = 0; i < n; i++) {
    doc.switchToPage(i);
    const mb = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text(`${pie || ''}   ·   Página ${i + 1} de ${n}`, 36, doc.page.height - 26, { width: doc.page.width - 72, align: 'center', lineBreak: false });
    doc.page.margins.bottom = mb;
  }
}

function nuevoDoc(apaisado) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: apaisado ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
  const partes = [];
  const listo = new Promise((resolve, reject) => {
    doc.on('data', c => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
  });
  return { doc, listo };
}

// Dibuja una fila de tabla con altura según el texto más largo; salta de hoja si no entra.
function fila(doc, cols, valores, i, opts = {}) {
  const tam = opts.size || 8.5;
  const est = k => (opts.estilos && opts.estilos[k]) || {};
  const fuente = k => (opts.negrita || est(k).negrita) ? 'Helvetica-Bold' : 'Helvetica';
  doc.fontSize(tam);
  const alto = Math.max(tam + 9, ...valores.map((v, k) => { doc.font(fuente(k)); return doc.heightOfString(String(v ?? ''), { width: cols[k].w - 8 }) + 8; }));
  if (doc.y + alto > doc.page.height - 48) { doc.addPage(); if (opts.alSaltar) opts.alSaltar(); }
  const y = doc.y, ancho = cols.reduce((s, c) => s + c.w, 0);
  if (i % 2 === 1) doc.rect(36, y, ancho, alto).fill('#F1F5F9');
  let x = 36;
  valores.forEach((v, k) => { doc.font(fuente(k)).fontSize(tam).fillColor(est(k).color || '#0f172a'); doc.text(String(v ?? ''), x + 4, y + 4, { width: cols[k].w - 8 }); x += cols[k].w; });
  doc.y = y + alto;
}

function encabezadoTabla(doc, cols, color, tam = 9) {
  const y = doc.y, ancho = cols.reduce((s, c) => s + c.w, 0);
  doc.rect(36, y, ancho, tam + 11).fill(color || VERDE);
  let x = 36;
  doc.font('Helvetica-Bold').fontSize(tam).fillColor('#FFFFFF');
  cols.forEach(c => { doc.text(c.t, x + 4, y + 5, { width: c.w - 8, lineBreak: false }); x += c.w; });
  doc.y = y + tam + 11;
}

const escalar = (columnas, ancho) => { const s = columnas.reduce((a, c) => a + c.w, 0); return columnas.map(c => ({ ...c, w: (c.w / s) * ancho })); };

// Si no queda lugar para el título + al menos 2 filas, pasa a la hoja siguiente (evita títulos huérfanos)
const reservar = (doc, alto) => { if (doc.y + alto > doc.page.height - 48) doc.addPage(); };

// ── TABLA SIMPLE ──────────────────────────────────────────────────────────────
function pdfTabla({ titulo, subtitulo, columnas, filas, pie, apaisado = true }) {
  return new Promise((resolve, reject) => {
    try {
      const { doc, listo } = nuevoDoc(apaisado);
      listo.then(resolve, reject);
      const cols = escalar(columnas, doc.page.width - 72);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(VERDE_OSC).text(titulo, 36, 36, { width: doc.page.width - 72 });
      if (subtitulo) doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text(subtitulo, { width: doc.page.width - 72 });
      doc.moveDown(0.6);
      encabezadoTabla(doc, cols);
      filas.forEach((f, i) => fila(doc, cols, f, i, { alSaltar: () => encabezadoTabla(doc, cols) }));
      ponerPies(doc, pie);
      doc.end();
    } catch (e) { reject(e); }
  });
}

// ── INFORME POR CARRERA → AÑO → MATERIA ───────────────────────────────────────
function pdfInforme({ titulo, subtitulo, resumen, resumen2, carreras, columnas, pie, apaisado = true }) {
  return new Promise((resolve, reject) => {
    try {
      const { doc, listo } = nuevoDoc(apaisado);
      listo.then(resolve, reject);
      const W = doc.page.width - 72;
      const cols = escalar(columnas, W);
      const estilos = columnas.map(c => c.estilo || {});

      const tablaResumen = (r, ancho) => {
        const rc = escalar(r.columnas, Math.min(W, ancho));
        doc.font('Helvetica-Bold').fontSize(13).fillColor(VERDE_OSC).text(r.titulo, 36);
        doc.moveDown(0.3);
        encabezadoTabla(doc, rc, VERDE, 10);
        r.filas.forEach((f, i) => fila(doc, rc, f, i, { size: 10, negrita: f[0] === 'TOTAL', alSaltar: () => encabezadoTabla(doc, rc, VERDE, 10) }));
        doc.moveDown(1);
      };

      // Portada: título grande + resúmenes
      doc.rect(36, 36, W, 56).fill(VERDE_OSC);
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF').text(titulo, 50, 46, { width: W - 28 });
      doc.font('Helvetica').fontSize(10).fillColor('#A7F3D0').text('Instituto Técnico Superior Santísima Trinidad', 50, 74, { width: W - 28 });
      doc.y = 104;
      if (subtitulo) { doc.font('Helvetica').fontSize(10.5).fillColor(GRIS).text(subtitulo, 36, doc.y, { width: W }); doc.moveDown(0.9); }
      if (resumen && resumen.filas.length) tablaResumen(resumen, 520);
      if (resumen2 && resumen2.filas.length) { reservar(doc, 120); tablaResumen(resumen2, W); }

      carreras.forEach(car => {
        doc.addPage();
        const total = car.cursos.reduce((s, c) => s + c.materias.reduce((a, m) => a + m.filas.length, 0), 0);
        // Banda de carrera (título grande)
        const y0 = doc.y;
        doc.rect(36, y0, W, 38).fill(VERDE_OSC);
        doc.font('Helvetica-Bold').fontSize(20).fillColor('#FFFFFF').text(car.nombre.toUpperCase(), 48, y0 + 9, { width: W - 230, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#FCA5A5').text(total + ' nota' + (total !== 1 ? 's' : '') + ' pendiente' + (total !== 1 ? 's' : ''), 36, y0 + 13, { width: W - 12, align: 'right', lineBreak: false });
        doc.y = y0 + 48;

        car.cursos.forEach(cur => {
          const totalCur = cur.materias.reduce((a, m) => a + m.filas.length, 0);
          reservar(doc, 110);
          const y1 = doc.y;
          doc.rect(36, y1, W, 28).fill('#D1FAE5');
          doc.rect(36, y1, 6, 28).fill(VERDE);
          doc.font('Helvetica-Bold').fontSize(15).fillColor(VERDE_OSC).text(cur.nombre, 52, y1 + 6, { width: W - 190, lineBreak: false });
          doc.font('Helvetica-Bold').fontSize(10.5).text(totalCur + ' nota' + (totalCur !== 1 ? 's' : '') + ' pendiente' + (totalCur !== 1 ? 's' : ''), 36, y1 + 9, { width: W - 12, align: 'right', lineBreak: false });
          doc.y = y1 + 38;

          cur.materias.forEach(mat => {
            reservar(doc, 100);
            // Tarjeta de materia: nombre grande + docente que no cargó
            const y2 = doc.y;
            doc.rect(36, y2, W, 34).fillAndStroke('#F8FAFC', '#CBD5E1');
            doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#0f172a').text(mat.nombre, 46, y2 + 5, { width: W - 20, lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ROJO).text('Docente que no cargó la nota:', 46, y2 + 21, { lineBreak: false, continued: true });
            doc.fillColor('#0f172a').text('  ' + (mat.docente || 'sin docente asignado'), { lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(10).fillColor(ROJO).text(mat.filas.length + ' pendiente' + (mat.filas.length !== 1 ? 's' : ''), 36, y2 + 21, { width: W - 10, align: 'right', lineBreak: false });
            doc.y = y2 + 38;
            encabezadoTabla(doc, cols, '#475569', 9);
            mat.filas.forEach((f, i) => fila(doc, cols, f, i, { size: 9.5, estilos, alSaltar: () => encabezadoTabla(doc, cols, '#475569', 9) }));
            doc.moveDown(0.9);
          });
          doc.moveDown(0.3);
        });
      });

      if (!carreras.length) {
        doc.addPage();
        doc.font('Helvetica').fontSize(13).fillColor(GRIS).text('No hay pendientes con los filtros elegidos.', 36, 60);
      }
      ponerPies(doc, pie);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { pdfTabla, pdfInforme };
