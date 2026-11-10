import { describe, expect, it } from 'vitest';
import { parseBusinessInput, parseBusinessPatch } from '../src/services/accounts';
import { inferCountry } from '../src/utils/locale';

// A business that signs up through the wizard must get the country its
// currency/clock say, or an Indian clinic would read +91 numbers as US ones
// and skip the DPDP call-start notice.
const wizard = (extra: Record<string, unknown>) => ({
  name: 'Sharma Dental', kind: 'dental', hours: { mon: '10am–7pm' },
  services: [{ name: 'Consultation', priceCents: 50000, durationMinutes: 15 }], ...extra,
});

describe('signup country and locale', () => {
  it('infers India from INR or Asia/Kolkata, else the US default', () => {
    expect(inferCountry('Asia/Kolkata', 'INR')).toBe('IN');
    expect(inferCountry('Asia/Kolkata', 'USD')).toBe('IN');
    expect(inferCountry('Asia/Calcutta', undefined)).toBe('IN');
    expect(inferCountry('America/Chicago', 'INR')).toBe('IN');
    expect(inferCountry('America/Chicago', 'USD')).toBe('US');
    expect(inferCountry(undefined, undefined)).toBe('US');
  });

  it('sets up an INR business as Indian (en-IN)', () => {
    const r = parseBusinessInput(wizard({ timezone: 'Asia/Kolkata', currency: 'INR' }));
    expect(typeof r).not.toBe('string');
    expect(r).toMatchObject({ countryCode: 'IN', locale: 'en-IN' });
  });

  it('keeps a US business on the original defaults', () => {
    expect(parseBusinessInput(wizard({ timezone: 'America/Chicago', currency: 'USD' })))
      .toMatchObject({ countryCode: 'US', locale: 'en-US' });
  });

  it('accepts an explicit country and rejects unsupported ones', () => {
    expect(parseBusinessInput(wizard({ timezone: 'America/Chicago', currency: 'USD', country_code: 'IN' })))
      .toMatchObject({ countryCode: 'IN', locale: 'en-IN' });
    expect(parseBusinessInput(wizard({ timezone: 'Asia/Kolkata', currency: 'INR', country_code: 'XX' })))
      .toBe('Choose a supported country');
  });

  it('lets the owner switch country; the locale follows unless given', () => {
    expect(parseBusinessPatch({ country_code: 'IN' })).toEqual({ countryCode: 'IN', locale: 'en-IN' });
    expect(parseBusinessPatch({ country_code: 'IN', locale: 'hi-IN' })).toEqual({ countryCode: 'IN', locale: 'hi-IN' });
    expect(parseBusinessPatch({ country_code: 'ZZ' })).toBe('Choose a supported country');
  });
});
