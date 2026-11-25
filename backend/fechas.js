// Fechas y horas en hora de Paraguay (America/Asuncion) con dayjs.
// Reemplaza las cuentas manuales con toLocaleDateString: mismo formato de salida, un solo lugar.
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'America/Asuncion';

// 'YYYY-MM-DD' de hoy en Paraguay (no en UTC)
const hoyPY = () => dayjs().tz(TZ).format('YYYY-MM-DD');
// 'YYYY-MM-DD HH:mm:ss' de ahora en Paraguay
const horaPY = () => dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss');
// Convierte un 'YYYY-MM-DD HH:mm:ss' guardado en UTC a hora de Paraguay (null si no es una fecha válida)
const utcAPY = (utcStr) => {
  const d = dayjs.utc(String(utcStr || '').replace(' ', 'T').replace(/Z$/, ''));
  return d.isValid() ? d.tz(TZ).format('YYYY-MM-DD HH:mm:ss') : null;
};
// Suma/resta días a una fecha 'YYYY-MM-DD' (sin corrimientos por zona horaria)
const sumarDias = (fecha, n) => dayjs.utc(fecha).add(n, 'day').format('YYYY-MM-DD');
// Diferencia en días enteros entre dos fechas 'YYYY-MM-DD' (b - a)
const diasEntre = (a, b) => dayjs.utc(b).diff(dayjs.utc(a), 'day');
// '2026-12-04' -> '04/12/2026'
const fmtDMY = (fecha) => (fecha ? dayjs.utc(fecha).format('DD/MM/YYYY') : '');

module.exports = { TZ, hoyPY, horaPY, utcAPY, sumarDias, diasEntre, fmtDMY };
