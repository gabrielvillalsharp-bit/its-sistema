// PDFs generados en el servidor con pdfkit (sin depender del navegador de quien los pide).
// pdfTabla({ titulo, subtitulo, columnas:[{ t:'Fecha', w:70 }, ...], filas:[[...], ...], pie })  →  Promise<Buffer>
// pdfkit se carga recién al generar un PDF: si la librería fallara, el servidor igual arranca (Railway usa Node 18)

function pdfTabla({ titulo, subtitulo, columnas, filas, pie, apaisado = true }) {
  return new Promise((resolve, reject) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', layout: apaisado ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const partes = [];
    doc.on('data', c => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);

    const ancho = doc.page.width - 72;
    const sumaW = columnas.reduce((s, c) => s + c.w, 0);
    const cols = columnas.map(c => ({ ...c, w: (c.w / sumaW) * ancho }));
    const VERDE = '#0F6E56';

    const encabezado = (conTitulo) => {
      if (conTitulo) {
        doc.font('Helvetica-Bold').fontSize(15).fillColor('#04342C').text(titulo, 36, 36, { width: ancho });
        if (subtitulo) doc.font('Helvetica').fontSize(9.5).fillColor('#475569').text(subtitulo, { width: ancho });
        doc.moveDown(0.6);
      }
      const y = doc.y;
      doc.rect(36, y, ancho, 18).fill(VERDE);
      let x = 36;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
      cols.forEach(c => { doc.text(c.t, x + 4, y + 5, { width: c.w - 8, lineBreak: false }); x += c.w; });
      doc.y = y + 18;
    };

    encabezado(true);
    filas.forEach((f, i) => {
      doc.font('Helvetica').fontSize(8.5);
      const alto = Math.max(16, ...f.map((v, k) => doc.heightOfString(String(v ?? ''), { width: cols[k].w - 8 }) + 8));
      if (doc.y + alto > doc.page.height - 50) { doc.addPage(); encabezado(false); }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(36, y, ancho, alto).fill('#F1F5F9');
      let x = 36;
      doc.fillColor('#0f172a');
      f.forEach((v, k) => { doc.text(String(v ?? ''), x + 4, y + 4, { width: cols[k].w - 8 }); x += cols[k].w; });
      doc.y = y + alto;
    });

    const n = doc.bufferedPageRange().count;
    for (let i = 0; i < n; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
        .text(`${pie || ''}   ·   Página ${i + 1} de ${n}`, 36, doc.page.height - 30, { width: ancho, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { pdfTabla };
