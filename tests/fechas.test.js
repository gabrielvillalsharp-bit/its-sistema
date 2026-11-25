import { describe, it, expect } from 'vitest';
const { hoyPY, horaPY, utcAPY, sumarDias, diasEntre, fmtDMY } = require('../backend/fechas');

describe('fechas (dayjs, America/Asuncion)', () => {
  it('hoyPY y horaPY dan el mismo resultado que la cuenta manual de siempre', () => {
    const viejoDia = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Asuncion' });
    expect(hoyPY()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([viejoDia, new Date(Date.now() + 60000).toLocaleDateString('sv-SE', { timeZone: 'America/Asuncion' })]).toContain(hoyPY());
    expect(horaPY()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
  it('utcAPY pasa de UTC a hora de Paraguay (UTC-3 en diciembre) y rechaza fechas inválidas', () => {
    expect(utcAPY('2026-12-04 02:30:00')).toBe('2026-12-03 23:30:00');
    expect(utcAPY('2026-12-04 15:00:00')).toBe('2026-12-04 12:00:00');
    expect(utcAPY('basura')).toBeNull();
    expect(utcAPY(null)).toBeNull();
  });
  it('sumarDias, diasEntre y fmtDMY', () => {
    expect(sumarDias('2026-12-04', 14)).toBe('2026-12-18');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(diasEntre('2026-12-04', '2026-12-22')).toBe(18);
    expect(fmtDMY('2026-12-04')).toBe('04/12/2026');
    expect(fmtDMY('')).toBe('');
  });
});
