import { describe, expect, it } from 'vitest';
import { parseServiceLines } from './servicesImport';

describe('parseServiceLines', () => {
  it('parses dash and comma formats', () => {
    const { good, bad } = parseServiceLines('Cleaning - 800 - 30\nRoot canal, 4500, 60min\n\nConsultation, ₹1,000');
    expect(bad).toEqual([]);
    expect(good).toEqual([
      { name: 'Cleaning', priceCents: 80000, durationMinutes: 30 },
      { name: 'Root canal', priceCents: 450000, durationMinutes: 60 },
      { name: 'Consultation', priceCents: 100000, durationMinutes: 30 },
    ]);
  });
  it('treats "on request" as price 0 and keeps dashes inside names', () => {
    const { good } = parseServiceLines('Filling - composite - 1500 - 45\nBraces - on request - 30');
    expect(good[0]).toEqual({ name: 'Filling - composite', priceCents: 150000, durationMinutes: 45 });
    expect(good[1]).toMatchObject({ name: 'Braces', priceCents: 0 });
  });
  it('skips and reports bad lines', () => {
    const { good, bad } = parseServiceLines('Just a name\nX, abc, 30\nY, 100, 0\nOK, 100, 20');
    expect(good).toHaveLength(1);
    expect(bad.map(b => b.line)).toEqual(['Just a name', 'X, abc, 30', 'Y, 100, 0']);
  });
});
