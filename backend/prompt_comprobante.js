// Instrucciones para leer comprobantes de transferencia (las usan gemini.js y claude.js).
const PROMPT_COMPROBANTE = `Esta imagen es un comprobante de transferencia bancaria paraguaya (de apps como Ueno Bank, Itaú, Banco Atlas/SIP, Continental, Familiar, Visión Banco, Mango, etc.). Cada comprobante muestra DOS partes: quien envía el dinero (origen) y quien lo recibe (destino, que es la cuenta del Instituto). Los nombres de estas dos secciones varían según el banco:
- Origen/remitente puede aparecer como: "DE", "Origen", "Remitente", "Enviado por", "Titular débito", "Cuenta débito".
- Destino/beneficiario (NO es lo que necesitamos) puede aparecer como: "PARA", "Destino", "Destinatario", "Beneficiario", "A la cuenta de", "Cuenta crédito". A veces el destinatario aparece primero, destacado junto al monto, SIN una etiqueta explícita (justo debajo del logo del banco) — en ese caso, el nombre que SÍ tiene la etiqueta "Origen" (o equivalente) es el remitente correcto, no el de arriba.

IMPORTANTE: el campo "nombre_remitente" debe ser el nombre de la sección de ORIGEN (quien envía/paga), nunca el de destino/beneficiario (que normalmente es el Instituto u otra institución). Si no podés distinguir con certeza cuál lado es el remitente, devolvé null en ese campo en vez de adivinar.

Las fechas pueden venir en formatos como "10/03/2026", "05/05/2026 09:40:36", "12/06/2026 - 15:33 Hs", "02-06-2026" o "05 jun 2026 - 09:15 Hs" — siempre son formato día/mes/año (DD/MM/YYYY), normalizalas a YYYY-MM-DD.

Algunos comprobantes muestran un campo "Estado" de la transferencia (ej: "Procesando transferencia", "Transferencia exitosa", "Rechazada", "Pendiente"). Es MUY IMPORTANTE detectarlo: si dice algo distinto de "exitosa"/"enviada"/"completada"/"cargada" (por ejemplo "procesando" o "pendiente"), el dinero puede no haber llegado todavía.

Extraé los datos visibles y respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto adicional) con esta forma exacta:
{"monto": <número entero en guaraníes, sin puntos ni comas, o null si no se ve>, "fecha": "<YYYY-MM-DD o null si no se ve>", "banco": "<nombre del banco/billetera o null>", "referencia": "<número de comprobante/operación/transacción o null>", "nombre_remitente": "<nombre de quien envía/origen, o null si no está claro>", "estado_transferencia": "<exitosa|procesando|pendiente|rechazada|desconocido — según lo que diga el comprobante, o 'desconocido' si no muestra estado>", "es_comprobante": <true o false — true solo si la imagen realmente parece un comprobante/recibo de transferencia bancaria>}
Si la imagen no parece un comprobante de pago, poné "es_comprobante": false y el resto de los campos en null.`;
module.exports = { PROMPT_COMPROBANTE };
