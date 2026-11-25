import { describe, it, expect } from 'vitest';
const { excelBuffer, leerFilas, leerObjetos } = require('../backend/excel');

describe('excel (exceljs): exportar y leer', () => {
  it('lo que se exporta se vuelve a leer igual (filas y objetos)', async () => {
    const buf = await excelBuffer([{ nombre: 'Hoja', filas: [{ CI: '1234567', Nombre: 'Ana', Monto: 150000 }, { CI: '7654321', Nombre: 'Luis', Monto: 0 }] }]);
    expect(await leerFilas(buf)).toEqual([['CI', 'Nombre', 'Monto'], ['1234567', 'Ana', 150000], ['7654321', 'Luis', 0]]);
    expect(await leerObjetos(buf)).toEqual([{ CI: '1234567', Nombre: 'Ana', Monto: 150000 }, { CI: '7654321', Nombre: 'Luis', Monto: 0 }]);
  });
  it('encabezados repetidos y filas vacías en objetos', async () => {
    const buf = await excelBuffer([{ nombre: 'H', encabezados: ['Cuota', 'Cuota', 'Total'], matriz: [[1, 2, 3], ['', '', ''], [4, 5, 6]] }]);
    const o = await leerObjetos(buf);
    expect(o).toEqual([{ Cuota: 1, Cuota_1: 2, Total: 3 }, { Cuota: 4, Cuota_1: 5, Total: 6 }]);
  });
  it('lee fórmulas como su resultado y fechas como número de serie de Excel', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x');
    ws.addRow([2, 3]); ws.getCell('C1').value = { formula: 'A1+B1', result: 5 };
    ws.getCell('A2').value = new Date(Date.UTC(2026, 11, 4));
    const f = await leerFilas(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(f[0]).toEqual([2, 3, 5]);
    expect(Math.round(f[1][0])).toBe(46360); // 04/12/2026
  });
  it('lee CSV y avisa claramente si el archivo es el .xls viejo', async () => {
    expect(await leerFilas(Buffer.from('a,b\n1,2\n'))).toEqual([['a', 'b'], [1, 2]]);
    const viejo = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(64)]);
    await expect(leerFilas(viejo)).rejects.toThrow(/\.xlsx/);
  });
});
