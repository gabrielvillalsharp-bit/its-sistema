// Exportaciones a Excel con exceljs (encabezado con color, filtros y primera fila fija).
// Uso: const buf = await excelBuffer([{ nombre: 'Alumnos', filas: [{...}, ...], anchos: [20, 10] }]);
const ExcelJS = require('exceljs');

async function excelBuffer(hojas) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema ITS';
  wb.created = new Date();
  for (const h of hojas) {
    const ws = wb.addWorksheet(String(h.nombre || 'Hoja').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    const filas = h.filas || [];
    // columnas = unión de las claves de todas las filas, en orden de aparición
    const cols = [];
    filas.forEach(f => Object.keys(f).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
    ws.columns = cols.map((k, i) => ({
      header: k, key: k,
      width: (h.anchos && h.anchos[i]) || Math.min(45, Math.max(10, k.length + 4)),
    }));
    filas.forEach(f => ws.addRow(cols.map(k => (f[k] === undefined || f[k] === null ? '' : f[k]))));
    if (cols.length) {
      const enc = ws.getRow(1);
      enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      enc.alignment = { vertical: 'middle', wrapText: true };
      enc.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F6E56' } }; });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { excelBuffer };
