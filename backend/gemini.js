// Cliente minimalista para la API de Google AI Studio (Gemini) — usa REST, sin SDK.
const { PROMPT_COMPROBANTE } = require('./prompt_comprobante');
const MODEL = 'gemini-2.5-flash';

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
    generationConfig: { temperature: 0.6, maxOutputTokens: 8192 }
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

  const prompt = PROMPT_COMPROBANTE;

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
