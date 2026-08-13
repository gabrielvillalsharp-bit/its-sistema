const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\ADM 2025\\Downloads\\its_2026-08-06.db', { readonly: true });

// Reproducir la lógica del servidor
const MES_A_CUOTA_NUM = { 3:1, 4:2, 5:3, 6:4, 7:5, 8:6, 9:7, 10:8, 11:9, 12:10, 1:11, 2:12 };
const HOY = new Date('2026-08-06T00:00:00');
const mesActual = HOY.getMonth() + 1; // 8
const cuotaMesActual = MES_A_CUOTA_NUM[mesActual]; // 6
const cuotaLimite = HOY.getDate() > 10 ? cuotaMesActual : cuotaMesActual - 1; // dia 6 <= 10 → 5

const periodo = db.prepare('SELECT id FROM periodos WHERE activo=1').get();
console.log(`Periodo activo: ${periodo.id} | Cuota límite hoy: ${cuotaLimite} (Cuota 1-${cuotaLimite} son las exigibles)`);

// Función vieja (sin corrección)
function calcularDeudaVieja(alumno_id) {
  const cuotasVencidas = Array.from({ length: cuotaLimite }, (_, i) => 'Cuota ' + (i + 1));
  const pagados = db.prepare(`SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'`).all(alumno_id, periodo.id).map(p => p.concepto);
  return cuotasVencidas.filter(c => !pagados.includes(c));
}

// Función nueva (con corrección por fecha_ingreso)
function calcularDeudaNueva(alumno_id, fecha_ingreso) {
  let cuotaInicio = 1;
  if (fecha_ingreso) {
    const mesIngreso = new Date(fecha_ingreso + 'T00:00:00').getMonth() + 1;
    cuotaInicio = MES_A_CUOTA_NUM[mesIngreso] || 1;
  }
  const cuotasVencidas = Array.from({ length: cuotaLimite }, (_, i) => 'Cuota ' + (i + 1))
    .filter(c => parseInt(c.split(' ')[1]) >= cuotaInicio);
  const pagados = db.prepare(`SELECT concepto FROM pagos WHERE alumno_id=? AND periodo_id=? AND estado='Pagado'`).all(alumno_id, periodo.id).map(p => p.concepto);
  return cuotasVencidas.filter(c => !pagados.includes(c));
}

// Buscar alumnos afectados: bloqueados con la lógica vieja, desbloqueados con la nueva
const alumnos = db.prepare(`SELECT id, nombre, apellido, matricula, carrera_id, fecha_ingreso FROM alumnos WHERE estado='Activo'`).all();

const afectados = [];
for (const al of alumnos) {
  const deudaVieja = calcularDeudaVieja(al.id);
  const deudaNueva = calcularDeudaNueva(al.id, al.fecha_ingreso);
  if (deudaVieja.length >= 1 && deudaNueva.length === 0) {
    afectados.push({
      alumno: `${al.nombre} ${al.apellido}`,
      matricula: al.matricula,
      carrera: al.carrera_id,
      fecha_ingreso: al.fecha_ingreso,
      cuotas_faltantes_viejo: deudaVieja,
      cuotas_faltantes_nuevo: deudaNueva,
    });
  }
}

console.log(`\n=== ALUMNOS AFECTADOS POR EL BUG (bloqueados sin razón) ===`);
console.log(`Total: ${afectados.length}`);
afectados.forEach(a => {
  console.log(`  • ${a.alumno} (${a.matricula||'sin mat.'}) | Ingreso: ${a.fecha_ingreso} | Faltaban: ${a.cuotas_faltantes_viejo.join(', ')}`);
});

// Verificar Luana específicamente
const luana = alumnos.find(a => a.matricula === 'COS-2026-090');
if (luana) {
  console.log(`\n=== LUANA RUIZ AGÜERO ===`);
  console.log(`Fecha ingreso: ${luana.fecha_ingreso}`);
  console.log(`Deuda vieja: [${calcularDeudaVieja(luana.id).join(', ')}]`);
  console.log(`Deuda nueva: [${calcularDeudaNueva(luana.id, luana.fecha_ingreso).join(', ')}]`);
  console.log(`¿Bloqueada antes? ${calcularDeudaVieja(luana.id).length >= 1 ? 'SÍ' : 'NO'}`);
  console.log(`¿Bloqueada después del fix? ${calcularDeudaNueva(luana.id, luana.fecha_ingreso).length >= 1 ? 'SÍ' : 'NO'}`);
}

db.close();
