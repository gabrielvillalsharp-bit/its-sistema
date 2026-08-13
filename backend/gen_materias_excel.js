const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('../data/its.db');

// Traer todas las materias con año y carrera (deduplicadas por nombre+carrera+anio)
const rows = db.prepare(`
  SELECT DISTINCT m.nombre, m.anio, m.codigo, c.nombre as carrera
  FROM materias m
  JOIN carreras c ON c.id = m.carrera_id
  ORDER BY c.nombre, m.anio, m.nombre
`).all();
db.close();

// Normalizar: unificar "Inglés" y "Lengua Extranjera – Inglés" con mismo codigo
const seen = new Set();
const materias = [];
for (const r of rows) {
  const key = `${r.carrera}|${r.anio}|${r.nombre}`;
  if (!seen.has(key)) { seen.add(key); materias.push(r); }
}

// Agrupar por carrera → anio → lista de materias
const porCarrera = {};
for (const m of materias) {
  if (!porCarrera[m.carrera]) porCarrera[m.carrera] = { 1: [], 2: [], 3: [] };
  porCarrera[m.carrera][m.anio] = porCarrera[m.carrera][m.anio] || [];
  porCarrera[m.carrera][m.anio].push(m);
}

// Materias compartidas entre carreras (mismo nombre, múltiples carreras)
const porNombre = {};
for (const m of materias) {
  if (!porNombre[m.nombre]) porNombre[m.nombre] = new Set();
  porNombre[m.nombre].add(m.carrera);
}
const compartidas = Object.entries(porNombre).filter(([_, cs]) => cs.size > 1);

// ── Estilos ───────────────────────────────────────────────────────────────────
const GREEN   = { fgColor: { rgb: '166534' } };
const GREEN2  = { fgColor: { rgb: '1f8246' } };
const ANIO1   = { fgColor: { rgb: 'dbeafe' } }; // azul claro — 1er año
const ANIO2   = { fgColor: { rgb: 'dcfce7' } }; // verde claro — 2do año
const ANIO3   = { fgColor: { rgb: 'fef9c3' } }; // amarillo — 3er año
const WHITE   = { fgColor: { rgb: 'FFFFFF' } };
const GRAY    = { fgColor: { rgb: 'f9fafb' } };
const SHARED_FILL = { fgColor: { rgb: 'fef3c7' } };

const HDR_FONT  = { bold: true, color: { rgb: 'FFFFFF' }, sz: 11, name: 'Arial' };
const BODY      = { sz: 10, name: 'Arial' };
const BOLD      = { bold: true, sz: 10, name: 'Arial' };
const MUTED     = { sz: 10, name: 'Arial', color: { rgb: '6b7280' } };
const BLUE_FONT = { bold: true, sz: 10, name: 'Arial', color: { rgb: '1e40af' } };
const ANIO1_FONT= { bold: true, sz: 10, name: 'Arial', color: { rgb: '1e3a8a' } };
const ANIO2_FONT= { bold: true, sz: 10, name: 'Arial', color: { rgb: '14532d' } };

const BDR = { top:{style:'thin',color:{rgb:'d1d5db'}}, bottom:{style:'thin',color:{rgb:'d1d5db'}}, left:{style:'thin',color:{rgb:'d1d5db'}}, right:{style:'thin',color:{rgb:'d1d5db'}} };

function c(v, font, fill, align='left') {
  return { v, t: typeof v==='number'?'n':'s', s: { fill, font, border: BDR, alignment: { horizontal: align, vertical: 'center', wrapText: true } } };
}
function hdr(v, fill=GREEN) {
  return { v, t:'s', s: { fill, font: HDR_FONT, border: BDR, alignment: { horizontal:'center', vertical:'center', wrapText:true } } };
}
function titulo(v) {
  return { v, t:'s', s: { fill: GREEN, font: { bold:true, sz:13, name:'Arial', color:{rgb:'FFFFFF'} }, alignment: { horizontal:'center', vertical:'center' } } };
}
function seccion(v, fill, font) {
  return { v, t:'s', s: { fill, font: { bold:true, sz:10, name:'Arial', ...font }, alignment: { horizontal:'left', vertical:'center' } } };
}

const CARRERA_COLORS = {
  'Agropecuaria':                { bg:'d1fae5', txt:'064e3b' },
  'Contabilidad':                { bg:'fef9c3', txt:'713f12' },
  'Cosmiatría':                  { bg:'fce7f3', txt:'831843' },
  'Criminalística':              { bg:'ede9fe', txt:'3730a3' },
  'Electricidad':                { bg:'ffedd5', txt:'7c2d12' },
  'Enfermería':                  { bg:'dbeafe', txt:'1e3a8a' },
  'Farmacia':                    { bg:'dcfce7', txt:'14532d' },
  'Instrumentación Quirúrgica':  { bg:'fee2e2', txt:'7f1d1d' },
  'Radiología':                  { bg:'f3e8ff', txt:'4a1772' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HOJA 1 — Por carrera, dividido por año
// ═══════════════════════════════════════════════════════════════════════════════
const rows1 = [
  [titulo('ITS Santísima Trinidad — Materias por Carrera y Año')],
  [hdr('Carrera'), hdr('Año'), hdr('Cód.'), hdr('Materia'), hdr('Compartida con otras carreras')],
];

for (const [carrera, porAnio] of Object.entries(porCarrera)) {
  const { bg, txt } = CARRERA_COLORS[carrera] || { bg:'f0fdf4', txt:'166534' };
  // Encabezado de carrera
  const totalMats = Object.values(porAnio).flat().length;
  rows1.push([
    { v:`${carrera.toUpperCase()}  (${totalMats} materias)`, t:'s', s:{ fill:{fgColor:{rgb:bg}}, font:{bold:true,sz:10,name:'Arial',color:{rgb:txt}}, alignment:{horizontal:'left',vertical:'center'} } },
    null, null, null, null
  ]);
  // Por año
  for (const anio of [1, 2, 3]) {
    const mats = porAnio[anio] || [];
    if (!mats.length) continue;
    const anioFill = anio===1 ? ANIO1 : anio===2 ? ANIO2 : ANIO3;
    const anioFont = anio===1 ? ANIO1_FONT : ANIO2_FONT;
    // Sub-encabezado año
    rows1.push([
      null,
      { v:`${anio}° Año`, t:'s', s:{ fill:anioFill, font:{...anioFont}, border:BDR, alignment:{horizontal:'center',vertical:'center'} } },
      null, null, null
    ]);
    mats.forEach((m, i) => {
      const rowFill = i%2===0 ? WHITE : GRAY;
      const compartidaCon = [...(porNombre[m.nombre]||new Set())].filter(x=>x!==carrera);
      const isShared = compartidaCon.length > 0;
      rows1.push([
        c(carrera, MUTED, rowFill),
        c(anio, {...BODY,color:{rgb:anio===1?'1e3a8a':'14532d'}}, anioFill, 'center'),
        c(m.codigo, MUTED, rowFill, 'center'),
        c(m.nombre, isShared ? BOLD : BODY, rowFill),
        isShared
          ? c(compartidaCon.join(', '), BLUE_FONT, SHARED_FILL)
          : c('—', MUTED, rowFill, 'center'),
      ]);
    });
  }
}

const ws1 = XLSX.utils.aoa_to_sheet(rows1);
ws1['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:4} }];
ws1['!cols'] = [{wch:26},{wch:8},{wch:10},{wch:38},{wch:42}];
ws1['!rows'] = [{hpt:22},{hpt:18}];

// ═══════════════════════════════════════════════════════════════════════════════
// HOJA 2 — Resumen por carrera (1er año / 2do año)
// ═══════════════════════════════════════════════════════════════════════════════
const rows2 = [
  [titulo('ITS — Resumen de Materias por Carrera y Año')],
  [hdr('Carrera'), hdr('1° Año'), hdr('2° Año'), hdr('Total'), hdr('Compartidas')],
];

for (const [carrera, porAnio] of Object.entries(porCarrera)) {
  const { bg, txt } = CARRERA_COLORS[carrera] || { bg:'f0fdf4', txt:'166534' };
  const m1 = (porAnio[1]||[]).length;
  const m2 = (porAnio[2]||[]).length;
  const total = m1 + m2;
  const comp = Object.values(porAnio).flat().filter(m => (porNombre[m.nombre]?.size||0) > 1).length;
  rows2.push([
    c(carrera, {bold:true,sz:10,name:'Arial',color:{rgb:txt}}, {fgColor:{rgb:bg}}),
    { v:m1, t:'n', s:{ fill:ANIO1, font:ANIO1_FONT, border:BDR, alignment:{horizontal:'center',vertical:'center'} } },
    { v:m2, t:'n', s:{ fill:ANIO2, font:ANIO2_FONT, border:BDR, alignment:{horizontal:'center',vertical:'center'} } },
    c(total, BOLD, WHITE, 'center'),
    comp>0 ? { v:comp, t:'n', s:{ fill:SHARED_FILL, font:{...BOLD,color:{rgb:'92400e'}}, border:BDR, alignment:{horizontal:'center',vertical:'center'} } }
           : c(0, MUTED, WHITE, 'center'),
  ]);
}

const ws2 = XLSX.utils.aoa_to_sheet(rows2);
ws2['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:4} }];
ws2['!cols'] = [{wch:30},{wch:10},{wch:10},{wch:8},{wch:12}];
ws2['!rows'] = [{hpt:22},{hpt:18}];

// ═══════════════════════════════════════════════════════════════════════════════
// HOJA 3 — Materias compartidas (con año de cada carrera)
// ═══════════════════════════════════════════════════════════════════════════════
const rows3 = [
  [titulo('ITS — Materias compartidas entre carreras')],
  [hdr('Materia'), hdr('Carrera'), hdr('Año'), hdr('Código')],
];

for (const [nombre, carrerasSet] of compartidas.sort(([a],[b])=>a.localeCompare(b))) {
  const ocurrencias = materias.filter(m => m.nombre===nombre).sort((a,b)=>a.carrera.localeCompare(b.carrera));
  // Fila del nombre fusionada
  rows3.push([
    { v:nombre, t:'s', s:{ fill:SHARED_FILL, font:{bold:true,sz:10,name:'Arial',color:{rgb:'92400e'}}, border:BDR, alignment:{horizontal:'left',vertical:'center'} } },
    null, null, null
  ]);
  ocurrencias.forEach((m, i) => {
    const rowFill = i%2===0 ? WHITE : GRAY;
    const anioFill = m.anio===1 ? ANIO1 : ANIO2;
    rows3.push([
      null,
      c(m.carrera, BODY, rowFill),
      { v:`${m.anio}° Año`, t:'s', s:{ fill:anioFill, font:m.anio===1?ANIO1_FONT:ANIO2_FONT, border:BDR, alignment:{horizontal:'center',vertical:'center'} } },
      c(m.codigo, MUTED, rowFill, 'center'),
    ]);
  });
}

const ws3 = XLSX.utils.aoa_to_sheet(rows3);
ws3['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:3} }];
ws3['!cols'] = [{wch:40},{wch:30},{wch:10},{wch:12}];
ws3['!rows'] = [{hpt:22},{hpt:18}];

// ── Armar y guardar ────────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws1, 'Por Carrera y Año');
XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');
XLSX.utils.book_append_sheet(wb, ws3, 'Materias Compartidas');

const out = path.join('C:\\Users\\ADM 2025\\Desktop', 'ITS_Materias.xlsx');
fs.writeFileSync(out, XLSX.write(wb, { type:'buffer', bookType:'xlsx' }));
console.log('Guardado:', out);
