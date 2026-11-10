// Display helpers for a business's locale (sectors.currency / locale /
// country_code). Mirrors worker/src/utils/locale.ts: US businesses keep the
// existing "$12.00" / raw-number display; others go through Intl.

// The supported countries and their defaults live in one place, shared with
// the worker (which validates country_code against the same list).
export { COUNTRIES, countryDefaults } from '../../worker/src/utils/locale';

export interface SectorLocale { currency?: string; locale?: string; countryCode?: string }

/** "$12.00" (USD, as before) or e.g. "₹1,500.00" with Indian grouping. */
export function formatMoney(minor: number, loc?: SectorLocale): string {
  const currency = loc?.currency || 'USD';
  const locale = loc?.locale || 'en-US';
  if (currency === 'USD' && locale === 'en-US') return `$${(minor / 100).toFixed(2)}`;
  try {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

const IN_METRO_STD = new Set(['11', '20', '22', '33', '40', '44', '79', '80']);

/** "+91 98765 43210" / "+91 22 2345 6789" for Indian numbers; anything else unchanged. */
export function formatPhone(e164: string): string {
  const m = /^\+91(\d{10})$/.exec(e164);
  if (!m) return e164;
  const n = m[1];
  if (/^[6-9]/.test(n)) return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
  const std = IN_METRO_STD.has(n.slice(0, 2)) ? 2 : 3;
  return `+91 ${n.slice(0, std)} ${n.slice(std, -4)} ${n.slice(-4)}`;
}
