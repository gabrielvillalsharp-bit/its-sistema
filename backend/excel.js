// Excel con exceljs: EXPORTAR (excelBuffer) y LEER archivos subidos (leerFilas / leerObjetos).
// Reemplaza a la librería "xlsx" (SheetJS 0.18.5), que tiene fallas de seguridad conocidas al leer archivos de terceros.
const ExcelJS = require('exceljs');

// ── EXPORTAR ──────────────────────────────────────────────────────────────────
// excelBuffer([{ nombre, filas:[{col:valor}], anchos:[..], color:'FF0F6E56' }])
//   o con matriz (por si hay encabezados repetidos): { nombre, encabezados:[..], matriz:[[..],[..]] }
async function excelBuffer(hojas) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema ITS';
  wb.created = new Date();
  for (const h of hojas) {
    const ws = wb.addWorksheet(String(h.nombre || 'Hoja').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    let cols = [], datos = [];
    if (h.matriz) { cols = h.encabezados || []; datos = h.matriz; }
    else {
      const filas = h.filas || [];
      filas.forEach(f => Object.keys(f).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
      datos = filas.map(f => cols.map(k => f[k]));
    }
    ws.columns = cols.map((k, i) => ({
      header: String(k), key: 'c' + i,
      width: (h.anchos && h.anchos[i]) || Math.min(45, Math.max(10, String(k).length + 4)),
    }));
    datos.forEach(f => ws.addRow(f.map(v => (v === undefined || v === null ? '' : v))));
    if (cols.length) {
      const enc = ws.getRow(1);
      enc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      enc.alignment = { vertical: 'middle', wrapText: true };
      enc.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: h.color || 'FF0F6E56' } }; });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── LEER ──────────────────────────────────────────────────────────────────────
// Valor de una celda de exceljs → valor "crudo" como lo entregaba xlsx (números reales, fechas como número de serie de Excel).
function valorCelda(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.getTime() / 86400000 + 25569; // fecha → número de serie de Excel
  if (typeof v === 'object') {
    if ('result' in v) return valorCelda(v.result);                       // fórmula → su resultado
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join(''); // texto con formato
    if ('text' in v) return valorCelda(v.text);                           // hipervínculo
    if ('error' in v) return '';
    return String(v);
  }
  return v;
}

async function abrir(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const wb = new ExcelJS.Workbook();
  if (b.slice(0, 2).toString() === 'PK') { await wb.xlsx.load(b); return wb.worksheets[0]; }
  if (b.slice(0, 4).toString('hex') === 'd0cf11e0') {
    throw new Error('El archivo está en el formato viejo de Excel (.xls). Abrilo en Excel y guardalo como "Libro de Excel (.xlsx)" para importarlo.');
  }
  // texto plano (CSV)
  const { Readable } = require('stream');
  return wb.csv.read(Readable.from([b]));
}

// Matriz de filas (como sheet_to_json con header:1 y defval:''). Todas las filas con el mismo ancho.
async function leerFilas(buffer) {
  const ws = await abrir(buffer);
  if (!ws) return [];
  const ancho = ws.columnCount || 0, alto = ws.rowCount || 0;
  const out = [];
  for (let r = 1; r <= alto; r++) {
    const fila = ws.getRow(r), arr = [];
    for (let c = 1; c <= ancho; c++) {
      const cel = fila.getCell(c);
      // en celdas combinadas, exceljs repite el valor en todas; xlsx (y el sistema) solo lo tienen en la celda de arriba a la izquierda
      arr.push(cel.isMerged && cel.master && cel.master.address !== cel.address ? '' : (cel.type === ExcelJS.ValueType.Formula ? valorCelda(cel.result) : valorCelda(cel.value)));
    }
    out.push(arr);
  }
  return out;
}

// Lista de objetos con la primera fila como nombres de columna (como sheet_to_json por defecto, defval:''). Salta filas vacías.
async function leerObjetos(buffer) {
  const filas = await leerFilas(buffer);
  if (!filas.length) return [];
  const usados = {};
  const enc = filas[0].map((h, i) => {
    let k = String(h === '' ? '__EMPTY' + (i ? '_' + i : '') : h);
    if (usados[k] !== undefined) { usados[k]++; k = k + '_' + usados[k]; } else usados[k] = 0;
    return k;
  });
  return filas.slice(1).filter(f => f.some(v => v !== '')).map(f => Object.fromEntries(enc.map((k, i) => [k, f[i] === undefined ? '' : f[i]])));
}

module.exports = { excelBuffer, leerFilas, leerObjetos };
