// Cliente minimalista para la API de Google AI Studio (Gemini) — usa REST, sin SDK.
const MODEL = 'gemini-2.0-flash';

const _sleep = ms => new Promise(r => setTimeout(r, ms));

async function _geminiRequest(apiKey, body, timeoutMs) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  return r;
}

async function geminiChat(systemPrompt, historial, mensaje) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const contents = [
    ...historial.map(h => ({ role: h.role, parts: [{ text: h.texto }] })),
    { role: 'user', parts: [{ text: mensaje }] }
  ];
  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.6, maxOutputTokens: 500 }
  };

  // Hasta 2 intentos: si hay 429 espera 4s y reintenta una vez
  for (let intento = 0; intento < 2; intento++) {
    const r = await _geminiRequest(apiKey, body, 15000);
    if (r.status === 429 && intento === 0) {
      await _sleep(4000);
      continue;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    const data = await r.json();
    const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!texto.trim()) throw new Error('Gemini devolvió respuesta vacía');
    return texto.trim();
  }
  // Si llegó aquí fue porque el retry del 429 también falló
  throw Object.assign(new Error('Gemini 429: cuota excedida — intentá de nuevo en unos minutos'), { status: 429 });
}

// Lee un comprobante de transferencia (imagen) y extrae monto/fecha/banco como ayuda de precarga.
// El resultado SIEMPRE debe ser verificado por el director contra su cuenta bancaria antes de aprobar.
async function geminiLeerComprobante(base64, mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const prompt = `Esta imagen es un comprobante de transferencia bancaria paraguaya (de apps como Ueno Bank, Itaú, Banco Atlas/SIP, Continental, Familiar, Visión Banco, Mango, etc.). Cada comprobante muestra DOS partes: quien envía el dinero (origen) y quien lo recibe (destino, que es la cuenta del Instituto). Los nombres de estas dos secciones varían según el banco:
- Origen/remitente puede aparecer como: "DE", "Origen", "Remitente", "Enviado por", "Titular débito", "Cuenta débito".
- Destino/beneficiario (NO es lo que necesitamos) puede aparecer como: "PARA", "Destino", "Destinatario", "Beneficiario", "A la cuenta de", "Cuenta crédito". A veces el destinatario aparece primero, destacado junto al monto, SIN una etiqueta explícita (justo debajo del logo del banco) — en ese caso, el nombre que SÍ tiene la etiqueta "Origen" (o equivalente) es el remitente correcto, no el de arriba.

IMPORTANTE: el campo "nombre_remitente" debe ser el nombre de la sección de ORIGEN (quien envía/paga), nunca el de destino/beneficiario (que normalmente es el Instituto u otra institución). Si no podés distinguir con certeza cuál lado es el remitente, devolvé null en ese campo en vez de adivinar.

Las fechas pueden venir en formatos como "10/03/2026", "05/05/2026 09:40:36", "12/06/2026 - 15:33 Hs", "02-06-2026" o "05 jun 2026 - 09:15 Hs" — siempre son formato día/mes/año (DD/MM/YYYY), normalizalas a YYYY-MM-DD.

Algunos comprobantes muestran un campo "Estado" de la transferencia (ej: "Procesando transferencia", "Transferencia exitosa", "Rechazada", "Pendiente"). Es MUY IMPORTANTE detectarlo: si dice algo distinto de "exitosa"/"enviada"/"completada"/"cargada" (por ejemplo "procesando" o "pendiente"), el dinero puede no haber llegado todavía.

Extraé los datos visibles y respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto adicional) con esta forma exacta:
{"monto": <número entero en guaraníes, sin puntos ni comas, o null si no se ve>, "fecha": "<YYYY-MM-DD o null si no se ve>", "banco": "<nombre del banco/billetera o null>", "referencia": "<número de comprobante/operación/transacción o null>", "nombre_remitente": "<nombre de quien envía/origen, o null si no está claro>", "estado_transferencia": "<exitosa|procesando|pendiente|rechazada|desconocido — según lo que diga el comprobante, o 'desconocido' si no muestra estado>", "es_comprobante": <true o false — true solo si la imagen realmente parece un comprobante/recibo de transferencia bancaria>}
Si la imagen no parece un comprobante de pago, poné "es_comprobante": false y el resto de los campos en null.`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mime || 'image/jpeg', data: base64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      }),
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const texto = (data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').trim();
  const limpio = texto.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    throw new Error('No se pudo interpretar la respuesta de Gemini: ' + limpio.slice(0, 200));
  }
}

module.exports = { geminiChat, geminiLeerComprobante };
