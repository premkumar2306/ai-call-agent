import { describe, expect, it } from 'vitest';
import type { Product, SectorMeta } from '../src/types';
import {
  COUNTRIES, countryDefaults, formatClock, formatDayLabel, formatMoney, formatPhone, indianNumberWords, isValidCountryCode, isValidCurrency,
  isValidLocale, isValidTimeZone, localeGuidance, localeOf, normalizePhone, spokenMoney, spokenPhone,
} from '../src/utils/locale';
import { buildBusinessProfile, describeLocalNow, formatPrice, formatSpokenPrice } from '../src/services/business-profile';
import { executeTool, formatSlotLabel, getAvailableSlots } from '../src/services/tool-router.service';
import { createCallCache } from '../src/services/call-context';
import { bookingSummary } from '../src/services/notify.service';
import { getSectorGreeting } from '../src/services/recommendations.service';

const IN = { currency: 'INR', locale: 'en-IN', countryCode: 'IN' };
const US = localeOf(null);

const CLINIC: SectorMeta = {
  name: 'Sharma Dental Care',
  model: 'service',
  categories: ['DENTAL'],
  hours: { mon: '10am–7pm', tue: '10am–7pm', wed: '10am–7pm', thu: '10am–7pm', fri: '10am–7pm', sat: '10am–2pm' },
  timezone: 'Asia/Kolkata',
  ...IN,
  phone: '+91 22 2345 6789',
};

const product = (p: Partial<Product> & Pick<Product, 'id' | 'name' | 'priceCents'>): Product => ({
  businessType: 'sharma_dental', vendorId: 'v', vendorName: 'Sharma', category: 'DENTAL', type: 'SERVICE_APPOINTMENT',
  fulfillmentType: 'SERVICE_BOOKING', description: 'Done by a senior dentist.', originalPriceCents: p.priceCents,
  isActive: true, durationMinutes: 30, ...p,
});

const PRODUCTS: Product[] = [
  product({ id: 'consult', name: 'Consultation', priceCents: 50_000 }),
  product({ id: 'clean', name: 'Scaling and Polishing', priceCents: 150_000, originalPriceCents: 200_000 }),
  product({ id: 'implant', name: 'Dental Implant', priceCents: 15_000_000, durationMinutes: 120 }),
];

describe('locale defaults', () => {
  it('a sector without locale fields is US', () => {
    expect(localeOf(undefined)).toEqual({ currency: 'USD', locale: 'en-US', countryCode: 'US' });
    expect(localeOf({ currency: 'USD' })).toEqual(US);
    expect(localeGuidance(US)).toBe('');
  });
});

describe('money', () => {
  it('keeps the US format exactly', () => {
    expect(formatMoney(8999, US)).toBe('$89.99');
    expect(formatMoney(150000, US)).toBe('$1500');
    expect(formatMoney(1200, US, { alwaysFraction: true })).toBe('$12.00');
    expect(spokenMoney(8999, US)).toBe('$89.99');
  });

  it('writes rupees with Indian grouping', () => {
    expect(formatMoney(150_000, IN)).toBe('₹1,500');
    expect(formatMoney(15_000_000, IN)).toBe('₹1,50,000');
    expect(formatMoney(1_000_000_000, IN)).toBe('₹1,00,00,000');
    expect(formatMoney(9950, IN)).toBe('₹99.50');
    expect(formatMoney(150_000, IN, { alwaysFraction: true })).toBe('₹1,500.00');
  });

  it('says rupees the way Indian callers do', () => {
    expect(spokenMoney(150_000, IN)).toBe('fifteen hundred rupees');
    expect(spokenMoney(15_000_000, IN)).toBe('one lakh fifty thousand rupees');
    expect(spokenMoney(50_000, IN)).toBe('five hundred rupees');
    expect(spokenMoney(9950, IN)).toBe('ninety-nine rupees and fifty paise');
    expect(spokenMoney(100, IN)).toBe('one rupee');
    expect(spokenMoney(2_500_000_000, IN)).toBe('two crore fifty lakh rupees');
  });

  it('spells Indian numbers', () => {
    expect(indianNumberWords(0)).toBe('zero');
    expect(indianNumberWords(1000)).toBe('one thousand');
    expect(indianNumberWords(1250)).toBe('one thousand two hundred fifty');
    expect(indianNumberWords(2500)).toBe('twenty-five hundred');
    expect(indianNumberWords(12_345)).toBe('twelve thousand three hundred forty-five');
    expect(indianNumberWords(10_00_000)).toBe('ten lakh');
    expect(indianNumberWords(1_23_45_678)).toBe('one crore twenty-three lakh forty-five thousand six hundred seventy-eight');
  });

  it('uses the currency’s own minor unit', () => {
    expect(formatMoney(1500, { currency: 'JPY', locale: 'ja-JP', countryCode: 'JP' })).toBe('￥1,500');
    expect(formatMoney(150_050, { currency: 'EUR', locale: 'de-DE', countryCode: 'DE' })).toMatch(/^1\.500,50\s€$/);
  });

  it('prices products in the business locale', () => {
    expect(formatPrice(PRODUCTS[1], IN)).toBe('₹1,500 (regularly ₹2,000)');
    expect(formatSpokenPrice(PRODUCTS[1], IN)).toBe('fifteen hundred rupees (regularly two thousand rupees)');
    expect(formatPrice(PRODUCTS[1])).toBe('$1500 (regularly $2000)');
  });
});

describe('dates and times', () => {
  it('keeps the US slot label', () => {
    expect(formatClock(9 * 60, 'en-US')).toBe('9:00 AM');
    expect(formatSlotLabel('2026-10-30T09:00:00')).toBe('Friday, Oct 30 at 9:00 AM');
  });

  it('labels slots the Indian way', () => {
    expect(formatDayLabel('2026-10-30', 'en-IN')).toBe('Friday, 30 Oct');
    expect(formatSlotLabel('2026-10-30T17:30:00', undefined, undefined, 'en-IN')).toBe('Friday, 30 Oct at 5:30 pm');
    expect(formatSlotLabel('2026-10-30T09:00:00', '2026-10-30', undefined, 'en-IN')).toBe('today at 9:00 am');
  });

  it('falls back to en-US for a bad locale instead of throwing', () => {
    expect(formatSlotLabel('2026-10-30T09:00:00', undefined, undefined, 'not a locale')).toBe('Friday, Oct 30 at 9:00 AM');
    expect(describeLocalNow(new Date('2026-10-30T04:30:00Z'), 'Asia/Kolkata', 'not a locale')).toContain('Friday, October 30, 2026');
  });

  it('describes "now" in Asia/Kolkata (UTC+5:30)', () => {
    // 20:00 UTC on Thursday is 01:30 Friday in India.
    const s = describeLocalNow(new Date('2026-10-29T20:00:00Z'), 'Asia/Kolkata', 'en-IN');
    expect(s).toContain('Friday, 30 October 2026');
    expect(s).toMatch(/1:30\s?am/);
    expect(s).toContain('today 2026-10-30, tomorrow 2026-10-31, Sunday 2026-11-01');
  });

  it('offers slots on the Indian calendar day', async () => {
    // 04:30 UTC Friday = 10:00 IST Friday; same-day lead time is an hour.
    const slots = await getAvailableSlots({} as any, 'sharma_dental', CLINIC, 30, new Map(), [], new Date('2026-10-30T04:30:00Z'));
    expect(slots[0].datetime).toBe('2026-10-30T11:00:00');
    expect(slots[0].label).toBe('today at 11:00 am');
    expect(slots.find(s => s.date === '2026-11-02')?.label).toBe('Monday, 2 Nov at 10:00 am');
  });
});

describe('phone numbers', () => {
  it('reads US numbers as before', () => {
    expect(normalizePhone('(847) 555-1234')).toBe('+18475551234');
    expect(normalizePhone('+18475551234', 'US')).toBe('+18475551234');
    expect(normalizePhone('555-1234')).toBeUndefined();
  });

  it('reads Indian mobiles and landlines', () => {
    for (const raw of ['98765 43210', '098765-43210', '+91 98765 43210', '91 9876543210', '0091 98765 43210', '+919876543210']) {
      expect(normalizePhone(raw, 'IN'), raw).toBe('+919876543210');
    }
    expect(normalizePhone('022 2345 6789', 'IN')).toBe('+912223456789');
    expect(normalizePhone('+91-22-23456789', 'IN')).toBe('+912223456789');
    expect(normalizePhone('0141 234 5678', 'IN')).toBe('+911412345678');
    // Twilio/Exotel caller ID abroad still works.
    expect(normalizePhone('+18475551234', 'IN')).toBe('+18475551234');
  });

  it('rejects incomplete Indian numbers', () => {
    expect(normalizePhone('2345 6789', 'IN')).toBeUndefined(); // landline without STD code
    expect(normalizePhone('98765 4321', 'IN')).toBeUndefined();
    expect(normalizePhone('0000000000', 'IN')).toBeUndefined();
  });

  it('formats Indian numbers for display and leaves others alone', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhone('+912223456789')).toBe('+91 22 2345 6789');
    expect(formatPhone('+911412345678')).toBe('+91 141 234 5678');
    expect(formatPhone('+18475551234')).toBe('+18475551234');
  });

  it('reads numbers back digit by digit for an Indian business', () => {
    expect(spokenPhone('+919876543210', IN)).toBe('9 8 7 6 5, 4 3 2 1 0');
    expect(spokenPhone('+919876543210', US)).toBe('+919876543210');
    expect(spokenPhone('+18475551234', IN)).toBe('+18475551234');
  });
});

describe('admin validation', () => {
  it('accepts real codes and rejects typos', () => {
    expect(isValidCurrency('INR')).toBe(true);
    expect(isValidCurrency('inr')).toBe(false);
    expect(isValidCurrency('RUPEES')).toBe(false);
    expect(isValidLocale('en-IN')).toBe(true);
    expect(isValidLocale('hi-IN')).toBe(true);
    expect(isValidLocale('english')).toBe(false);
    expect(isValidCountryCode('IN')).toBe(true);
    expect(isValidCountryCode('IND')).toBe(false);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Asia/Bombay_Typo')).toBe(false);
  });
});

describe('an Indian business end to end', () => {
  const profile = buildBusinessProfile('sharma_dental', CLINIC, PRODUCTS);

  it('puts rupee prices and the speaking rule in the profile', () => {
    expect(profile).toContain('Consultation [id: consult] — ₹500');
    expect(profile).toContain('₹1,500 (regularly ₹2,000)');
    expect(profile).toContain('₹1,50,000');
    expect(profile).toContain('"fifteen hundred rupees"');
    expect(profile).toContain('(Asia/Kolkata time)');
    expect(profile).not.toContain('$');
  });

  const token = { sub: 'caller-in', businessType: 'sharma_dental', callerPhone: '+919876543210', iat: 0, exp: 0, account: { tier: 'BASIC' as const, store_credit_cents: 0 } };
  const cache = () => {
    const c = createCallCache();
    c.sectorMeta = CLINIC;
    c.productsAll = PRODUCTS;
    return c;
  };
  const env = () => ({ CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } }) as any;

  it('speaks prices in rupees from tools', async () => {
    const r = await executeTool('get_service_detail', { product_id: 'implant' }, token, env(), CLINIC, cache());
    expect(r.spoken_response).toContain('one lakh fifty thousand rupees');
    const s = await executeTool('search_services', { query: 'scaling' }, token, env(), CLINIC, cache());
    expect(s.spoken_response).toContain('fifteen hundred rupees');
    expect((s.data as any).products[0].price).toBe('₹1,500 (regularly ₹2,000)');
  });

  it('formats emails and greetings for India', () => {
    const summary = bookingSummary({
      id: 'abcdefgh1234', productName: 'Consultation', scheduledAt: '2026-11-02T10:30:00',
      customerName: 'Priya', callbackPhone: '+919876543210',
    } as any, CLINIC);
    expect(summary).toContain('Consultation — Monday, 2 Nov at 10:30 am');
    expect(summary).toContain('Callback: +91 98765 43210');
    expect(getSectorGreeting('sharma_dental', 50_000, 'GOLD', CLINIC)).toContain('₹500.00 in store credit');
  });
});

describe('country dropdown defaults', () => {
  it('India fills in rupees, en-IN, IST and +91', () => {
    expect(countryDefaults('IN', 'America/Chicago')).toEqual({ countryCode: 'IN', currency: 'INR', locale: 'en-IN', timezone: 'Asia/Kolkata' });
    expect(COUNTRIES.IN.dialCode).toBe('+91');
  });

  it('switching back to the US restores exactly what a US business had', () => {
    expect(countryDefaults('US', 'Asia/Kolkata')).toEqual({ countryCode: 'US', currency: 'USD', locale: 'en-US', timezone: 'America/Chicago' });
    // A US business in another US zone keeps it.
    expect(countryDefaults('US', 'America/New_York').timezone).toBe('America/New_York');
    expect(COUNTRIES.US.dialCode).toBe('+1');
  });

  it('only listed countries are accepted', () => {
    expect(Object.keys(COUNTRIES).every(isValidCountryCode)).toBe(true);
    expect(isValidCountryCode('GB')).toBe(false);
    expect(countryDefaults('GB').countryCode).toBe('US');
  });
});
