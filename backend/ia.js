// Punto único de IA del sistema. Usa Claude si hay ANTHROPIC_API_KEY; si no, cae a Gemini (transición).
// IA_PROVIDER=claude|gemini fuerza uno. Cuando Claude esté andando en Railway, gemini.js se puede borrar.
const gemini = require('./gemini');
const claude = require('./claude');

function iaProveedor() {
  const forzado = (process.env.IA_PROVIDER || '').toLowerCase();
  if (forzado === 'claude') return process.env.ANTHROPIC_API_KEY ? 'claude' : null;
  if (forzado === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}
const iaConfigurado = () => !!iaProveedor();

// opciones: { herramientas, ejecutar } solo las usa Claude; Gemini (transición) contesta sin consultar datos.
function iaChat(sistema, historial, mensaje, opciones) {
  const p = iaProveedor();
  if (p === 'claude') return claude.claudeChat(sistema, historial, mensaje, opciones);
  if (p === 'gemini') return gemini.geminiChat(sistema, historial, mensaje);
  return Promise.reject(new Error('IA no configurada: falta ANTHROPIC_API_KEY'));
}

function iaLeerComprobante(base64, mime) {
  const p = iaProveedor();
  if (p === 'claude') return claude.claudeLeerComprobante(base64, mime);
  if (p === 'gemini') return gemini.geminiLeerComprobante(base64, mime);
  return Promise.reject(new Error('IA no configurada: falta ANTHROPIC_API_KEY'));
}

module.exports = { iaChat, iaLeerComprobante, iaProveedor, iaConfigurado };
