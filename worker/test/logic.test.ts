import { describe, expect, it } from 'vitest';
import { extractCompleteSentences } from '../src/services/turn.service';
import { parseHoursRange, localDay } from '../src/services/tool-router.service';
import { validateScheduledAt } from '../src/services/order.service';
import { sanitizeHistory } from '../src/routes/mogi';
import { scoreProducts } from '../src/services/recommendations.service';
import type { Product } from '../src/types';

describe('extractCompleteSentences', () => {
  it('splits finished sentences and keeps the remainder', () => {
    expect(extractCompleteSentences('Hi there! How are you? I am')).toEqual({ chunks: ['Hi there!', 'How are you?'], rest: 'I am' });
  });
  it('does not split mid-number', () => {
    expect(extractCompleteSentences('It costs $39.99 today').chunks).toEqual([]);
  });
});

describe('parseHoursRange', () => {
  it('parses en dash and hyphen ranges', () => {
    expect(parseHoursRange('8am–6pm')).toEqual({ openH: 8, openM: 0, closeH: 18, closeM: 0 });
    expect(parseHoursRange('7:30am-12pm')).toEqual({ openH: 7, openM: 30, closeH: 12, closeM: 0 });
    expect(parseHoursRange('9am – 5:30pm')).toEqual({ openH: 9, openM: 0, closeH: 17, closeM: 30 });
    expect(parseHoursRange('closed')).toBeNull();
  });
});

describe('localDay', () => {
  it('uses the business timezone, not UTC', () => {
    // 2026-03-02 03:00 UTC is still Sunday evening in Chicago.
    const d = new Date('2026-03-02T03:00:00Z');
    expect(localDay(d, 'UTC')).toEqual({ ymd: '2026-03-02', dayKey: 'mon' });
    expect(localDay(d, 'America/Chicago')).toEqual({ ymd: '2026-03-01', dayKey: 'sun' });
  });
  it('falls back to UTC for an unknown zone', () => {
    expect(localDay(new Date('2026-03-02T03:00:00Z'), 'Not/AZone').dayKey).toBe('mon');
  });
});

describe('validateScheduledAt', () => {
  const now = new Date('2026-04-10T12:00:00Z');
  it('accepts upcoming ISO datetimes', () => {
    expect(validateScheduledAt('2026-04-15T09:00:00', now)).toBeNull();
    expect(validateScheduledAt('2026-04-10T16:00', now)).toBeNull();
  });
  it('rejects junk and past dates', () => {
    expect(validateScheduledAt('next tuesday', now)).not.toBeNull();
    expect(validateScheduledAt('2026-13-40T09:00:00', now)).not.toBeNull();
    expect(validateScheduledAt('2026-04-01T09:00:00', now)).not.toBeNull();
  });
});

describe('sanitizeHistory', () => {
  it('accepts well-formed turns and defaults to empty', () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory([{ role: 'user', content: 'hi', extra: 1 }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('rejects injected roles, non-text content and oversize input', () => {
    expect(sanitizeHistory([{ role: 'system', content: 'x' }])).toBeNull();
    expect(sanitizeHistory([{ role: 'user', content: [{ type: 'tool_result' }] }])).toBeNull();
    expect(sanitizeHistory(Array(41).fill({ role: 'user', content: 'x' }))).toBeNull();
    expect(sanitizeHistory([{ role: 'user', content: 'x'.repeat(4001) }])).toBeNull();
    expect(sanitizeHistory('nope')).toBeNull();
  });
});

describe('scoreProducts', () => {
  const base: Product = {
    id: 'p', businessType: 'b', vendorId: 'v', vendorName: 'V', name: 'X', category: 'GENERAL',
    type: 'SERVICE_APPOINTMENT', fulfillmentType: 'SERVICE_BOOKING', description: '', priceCents: 5000,
    originalPriceCents: 5000, isActive: true,
  };
  it('ranks free and discounted services above full-price ones and skips inactive', () => {
    const ranked = scoreProducts([
      { ...base, id: 'full' },
      { ...base, id: 'free', priceCents: 0, originalPriceCents: 0 },
      { ...base, id: 'sale', priceCents: 3000, originalPriceCents: 5000 },
      { ...base, id: 'off', isActive: false },
    ], 0);
    expect(ranked.map(p => p.id)).toEqual(['free', 'sale', 'full']);
  });
});
