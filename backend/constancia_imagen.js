// Constancia de pago como IMAGEN (PNG) con todos los datos del recibo (N° de recibo, alumno, concepto, monto, fecha).
// Se dibuja como SVG y se convierte a PNG con @resvg/resvg-js, con la tipografía Inter incluida en assets/fonts
// (así el resultado es idéntico en cualquier servidor, sin depender de las fuentes instaladas).
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const FUENTES = ['Inter_400Regular.ttf', 'Inter_600SemiBold.ttf', 'Inter_800ExtraBold.ttf'].map(f => path.join(__dirname, 'assets', 'fonts', f));
const LOGO_PATH = path.join(__dirname, '..', 'frontend', 'public', 'logo.png');
let _logoB64 = null;
function logoB64() {
  if (_logoB64 === null) { try { _logoB64 = fs.readFileSync(LOGO_PATH).toString('base64'); } catch { _logoB64 = ''; } }
  return _logoB64;
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const guaranies = n => 'Gs. ' + Math.round(Number(n) || 0).toLocaleString('es-PY');
const fechaDMY = f => { const m = String(f || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(f || ''); };

// Ancho aproximado de un texto en Inter (para cortar líneas y achicar la letra, resvg no hace saltos de línea solo)
const anchoTexto = (t, px, peso) => String(t).length * px * (peso >= 800 ? 0.63 : peso >= 600 ? 0.6 : 0.57);
function cortarLineas(texto, px, peso, anchoMax, maxLineas) {
  const palabras = String(texto || '').split(/\s+/).filter(Boolean);
  const lineas = []; let actual = '';
  for (const p of palabras) {
    const prueba = actual ? actual + ' ' + p : p;
    if (anchoTexto(prueba, px, peso) <= anchoMax || !actual) actual = prueba; else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  if (lineas.length > maxLineas) { const resto = lineas.splice(maxLineas - 1).join(' '); lineas.push(resto); }
  return lineas;
}
// Valor que cabe en `ancho`: se achica la letra hasta un mínimo y, si aun así no entra, se corta con "…"
function ajustar(texto, pxMax, pxMin, peso, ancho) {
  let px = pxMax; const t = String(texto || '');
  while (px > pxMin && anchoTexto(t, px, peso) > ancho) px -= 1;
  if (anchoTexto(t, px, peso) <= ancho) return { texto: t, px };
  const maxChars = Math.max(4, Math.floor(ancho / (px * (peso >= 600 ? 0.6 : 0.57))));
  return { texto: t.slice(0, maxChars - 1) + '…', px };
}

// d = { recibo, recibos[], estado, alumno, ci, carrera, curso, concepto, items:[{materia, recibo, monto}], monto, fecha, medio, emitido }
function armarSvg(d) {
  const W = 1080, X0 = 100, X1 = 980, G = '#14532d', G2 = '#15803d';
  const anulado = String(d.estado || '').toLowerCase() === 'anulado';
  const color = anulado ? '#b91c1c' : G2;
  const partes = []; let y = 0;
  const txt = (x, yy, s, px, peso, fill, extra = '') => `<text x="${x}" y="${yy}" font-family="Inter" font-size="${px}" font-weight="${peso}" fill="${fill}" ${extra}>${esc(s)}</text>`;

  // ── Encabezado ──
  const logo = logoB64();
  partes.push(`<rect x="40" y="40" width="1000" height="250" fill="url(#hg)"/>`);
  partes.push(`<circle cx="170" cy="165" r="88" fill="#ffffff"/>`);
  if (logo) partes.push(`<image x="108" y="104" width="124" height="120" href="data:image/png;base64,${logo}" preserveAspectRatio="xMidYMid meet"/>`);
  partes.push(txt(290, 132, 'INSTITUTO TÉCNICO SUPERIOR', 29, 600, '#bbf7d0', 'letter-spacing="2.5"'));
  partes.push(txt(290, 200, 'Santísima Trinidad', 62, 800, '#ffffff'));
  partes.push(txt(290, 244, 'Sistema Académico', 27, 400, '#dcfce7'));
  y = 350;

  // ── Título, número de recibo y estado ──
  partes.push(txt(540, y, 'CONSTANCIA DE PAGO', 28, 600, '#64748b', 'text-anchor="middle" letter-spacing="6"'));
  y += 100;
  const recs = (d.recibos && d.recibos.length ? d.recibos : [d.recibo]).filter(Boolean);
  if (recs.length <= 1) {
    partes.push(txt(540, y, recs[0] || '', 104, 800, G, 'text-anchor="middle"'));
  } else {
    const rango = `${recs[0]}  a  ${recs[recs.length - 1]}`;
    partes.push(txt(540, y - 10, rango, 58, 800, G, 'text-anchor="middle"'));
  }
  y += 36;
  const etiqueta = anulado ? 'ANULADO' : 'PAGADO';
  const pw = anulado ? 260 : 320;
  partes.push(`<rect x="${540 - pw / 2}" y="${y}" width="${pw}" height="62" rx="31" fill="${anulado ? '#fee2e2' : '#dcfce7'}"/>`);
  if (!anulado) partes.push(`<path d="M${540 - 112} ${y + 32} l14 14 l28 -30" stroke="${G2}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  partes.push(txt(anulado ? 540 : 568, y + 43, etiqueta, 32, 800, color, 'text-anchor="middle" letter-spacing="3"'));
  y += 62 + 56;

  // ── Datos ──
  partes.push(`<line x1="${X0}" y1="${y - 26}" x2="${X1}" y2="${y - 26}" stroke="#e2e8f0" stroke-width="2"/>`);
  const fila = (etq, valor) => {
    partes.push(txt(X0, y + 10, etq, 26, 400, '#64748b'));
    if (anchoTexto(valor, 28, 600) <= 560) {
      const a = ajustar(valor, 34, 28, 600, 560);
      partes.push(txt(X1, y + 12, a.texto, a.px, 600, '#0f172a', 'text-anchor="end"'));
      y += 72;
    } else { // valor largo: dos líneas
      const ls = cortarLineas(valor, 28, 600, 560, 2);
      ls.forEach((l, i) => { const a = ajustar(l, 28, 20, 600, 600); partes.push(txt(X1, y + 4 + i * 36, a.texto, a.px, 600, '#0f172a', 'text-anchor="end"')); });
      y += 72 + (ls.length - 1) * 36;
    }
    partes.push(`<line x1="${X0}" y1="${y - 30}" x2="${X1}" y2="${y - 30}" stroke="#f1f5f9" stroke-width="2"/>`);
  };
  fila('Alumno', d.alumno);
  if (d.ci) fila('C.I.', d.ci);
  if (d.carrera) fila('Carrera', d.carrera);
  if (d.curso) fila('Curso', d.curso);
  fila('Concepto', d.concepto);
  if (d.items && d.items.length === 1 && d.items[0].materia) fila('Materia', d.items[0].materia);
  if (d.medio) fila('Medio de pago', d.medio);
  fila('Fecha de pago', fechaDMY(d.fecha));

  // Pago por lote: una línea por materia con su recibo
  if (d.items && d.items.length > 1) {
    y += 10;
    partes.push(txt(X0, y + 8, 'MATERIAS', 24, 600, '#64748b', 'letter-spacing="4"'));
    y += 44;
    for (const it of d.items) {
      const ls = cortarLineas(it.materia || '', 26, 600, 470, 2);
      ls.forEach((l, i) => partes.push(txt(X0, y + 8 + i * 32, l, 26, 600, '#0f172a')));
      partes.push(txt(700, y + 8, it.recibo || '', 26, 600, G2, 'text-anchor="start"'));
      partes.push(txt(X1, y + 8, guaranies(it.monto), 26, 400, '#475569', 'text-anchor="end"'));
      y += 58 + (ls.length - 1) * 32;
      partes.push(`<line x1="${X0}" y1="${y - 24}" x2="${X1}" y2="${y - 24}" stroke="#f1f5f9" stroke-width="2"/>`);
    }
  }

  // ── Monto ──
  y += 20;
  partes.push(`<rect x="${X0 - 20}" y="${y}" width="${X1 - X0 + 40}" height="170" rx="28" fill="${anulado ? '#fef2f2' : '#f0fdf4'}" stroke="${anulado ? '#fecaca' : '#bbf7d0'}" stroke-width="3"/>`);
  partes.push(txt(540, y + 52, anulado ? 'MONTO ANULADO' : 'MONTO PAGADO', 25, 600, '#64748b', 'text-anchor="middle" letter-spacing="5"'));
  const mt = ajustar(guaranies(d.monto), 90, 56, 800, 800);
  partes.push(txt(540, y + 138, mt.texto, mt.px, 800, color, 'text-anchor="middle"'));
  y += 170 + 60;

  // ── Aviso: el N° de recibo es lo que identifica el pago ──
  {
    const refRecibo = recs.length > 1 ? `(${recs[0]} a ${recs[recs.length - 1]})` : `(${recs[0] || ''})`;
    const nota = anulado ? 'Este recibo fue anulado y ya no es válido. Ante cualquier duda comunicate con la administración del instituto.'
      : `Conservá este comprobante. Con el N° de recibo ${refRecibo} podés verificar tu pago en la administración del instituto.`;
    const ls = cortarLineas(nota, 27, 400, 800, 3);
    ls.forEach((l, i) => partes.push(txt(540, y + 10 + i * 40, l, 27, 400, '#475569', 'text-anchor="middle"')));
    y += 10 + ls.length * 40 + 30;
  }

  // ── Pie ──
  partes.push(`<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="#e2e8f0" stroke-width="2"/>`);
  partes.push(txt(540, y + 46, `Emitido por el Sistema Académico del ITS${d.emitido ? ' · ' + d.emitido : ''}`, 22, 400, '#94a3b8', 'text-anchor="middle"'));
  partes.push(txt(540, y + 82, 'Instituto Técnico Superior Santísima Trinidad', 22, 600, '#94a3b8', 'text-anchor="middle"'));
  y += 82 + 54;

  const H = y;
  const marca = anulado ? `<text x="540" y="${Math.round(H * 0.55)}" font-family="Inter" font-size="210" font-weight="800" fill="#b91c1c" fill-opacity="0.12" text-anchor="middle" transform="rotate(-24 540 ${Math.round(H * 0.55)})">ANULADO</text>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14532d"/><stop offset="1" stop-color="#16a34a"/></linearGradient>
<clipPath id="card"><rect x="40" y="40" width="1000" height="${H - 80}" rx="40"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#e7efe9"/>
<rect x="40" y="40" width="1000" height="${H - 80}" rx="40" fill="#ffffff"/>
<g clip-path="url(#card)">${partes.join('\n')}${marca}</g>
</svg>`;
  return svg;
}

function generarConstanciaPNG(datos) {
  const svg = armarSvg(datos);
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1080 },
    font: { fontFiles: FUENTES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    background: 'rgba(255,255,255,1)'
  });
  return r.render().asPng();
}

module.exports = { generarConstanciaPNG, armarSvg };
