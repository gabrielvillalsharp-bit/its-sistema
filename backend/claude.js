// Cliente de la API de Claude (Anthropic) para el bot de WhatsApp y la lectura de comprobantes.
// Misma forma que gemini.js: claudeChat(systemPrompt, historial, mensaje) y claudeLeerComprobante(base64, mime).
// El SDK se carga recién al usarlo: si faltara o fallara en el servidor, el sistema igual arranca.
const { PROMPT_COMPROBANTE } = require('./prompt_comprobante');

// Modelo configurable desde Railway (variable CLAUDE_MODEL) sin tocar código.
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let _cliente = null;
function cliente() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');
  if (!_cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    const Cls = Anthropic.default || Anthropic;
    // maxRetries: el SDK reintenta solo 429/5xx/cortes de red con espera creciente.
    _cliente = new Cls({ timeout: 45000, maxRetries: 2 });
  }
  return _cliente;
}

function _texto(resp) {
  if (resp.stop_reason === 'refusal') {
    const e = new Error('Claude declinó responder (' + (resp.stop_details?.category || 'refusal') + ')');
    e.status = 200;
    throw e;
  }
  return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// historial: [{ role: 'user'|'model', texto }] (el rol 'model' viene del bot anterior; en Claude es 'assistant')
// opciones (opcional): { herramientas: [definiciones], ejecutar: async (nombre, args) => resultado, maxPasos }
// Con herramientas, Claude puede consultar datos del sistema antes de contestar (ver bot_tools.js).
async function claudeChat(systemPrompt, historial, mensaje, opciones = {}) {
  const c = cliente();
  const previos = (historial || []).map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.texto
  }));
  while (previos.length && previos[0].role !== 'user') previos.shift(); // la conversación debe empezar con el usuario
  const messages = [...previos, { role: 'user', content: mensaje }];
  const tools = opciones.herramientas?.length ? opciones.herramientas : undefined;
  const maxPasos = opciones.maxPasos || 5;

  for (let paso = 0; paso < maxPasos; paso++) {
    const resp = await c.messages.create({
      model: MODEL(),
      max_tokens: 4096,
      system: systemPrompt,
      output_config: { effort: 'low' }, // respuestas cortas de WhatsApp: prioriza velocidad
      ...(tools ? { tools } : {}),
      messages
    });

    if (resp.stop_reason === 'tool_use' && opciones.ejecutar) {
      // Se devuelve el contenido completo del asistente (incluye bloques de razonamiento) y TODOS los
      // resultados de herramientas juntos en un solo mensaje del usuario.
      messages.push({ role: 'assistant', content: resp.content });
      const resultados = [];
      for (const b of resp.content.filter(x => x.type === 'tool_use')) {
        try {
          const salida = await opciones.ejecutar(b.name, b.input);
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: typeof salida === 'string' ? salida : JSON.stringify(salida) });
        } catch (e) {
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: 'Error al consultar: ' + e.message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: resultados });
      continue;
    }

    const texto = _texto(resp);
    if (!texto) throw new Error('Claude devolvió respuesta vacía');
    return texto;
  }
  throw new Error('La IA no terminó de consultar los datos (demasiados pasos)');
}

// Lee un comprobante (imagen o PDF) y extrae monto/fecha/banco. El director SIEMPRE verifica contra su cuenta.
async function claudeLeerComprobante(base64, mime) {
  const c = cliente();
  const tipo = (mime || 'image/jpeg').toLowerCase();
  const archivo = tipo === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: ['image/png', 'image/gif', 'image/webp'].includes(tipo) ? tipo : 'image/jpeg', data: base64 } };

  const resp = await c.messages.create({
    model: MODEL(),
    max_tokens: 2048,
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: [archivo, { type: 'text', text: PROMPT_COMPROBANTE }] }]
  });
  const texto = _texto(resp);
  const limpio = texto.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(limpio);
  } catch {
    throw new Error('No se pudo interpretar la respuesta de Claude: ' + limpio.slice(0, 200));
  }
}

module.exports = { claudeChat, claudeLeerComprobante };
