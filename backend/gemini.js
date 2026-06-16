// Cliente minimalista para la API de Google AI Studio (Gemini) — usa REST, sin SDK.
const MODEL = 'gemini-2.0-flash';

async function geminiChat(systemPrompt, historial, mensaje) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const contents = [
    ...historial.map(h => ({ role: h.role, parts: [{ text: h.texto }] })),
    { role: 'user', parts: [{ text: mensaje }] }
  ];

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.6, maxOutputTokens: 500 }
      }),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!texto.trim()) throw new Error('Gemini devolvió respuesta vacía');
  return texto.trim();
}

module.exports = { geminiChat };
