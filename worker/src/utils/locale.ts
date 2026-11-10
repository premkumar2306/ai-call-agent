// Per-business locale: how a business's prices, dates and phone numbers are
// written and spoken. Configured per sector (`sectors.currency`, `locale`,
// `country_code`, `timezone`) and defaulting to USD / en-US / US.
//
// The defaults deliberately go through the exact hand-rolled formatting the
// platform used before locales existed ("$89.99", "$1500", "Friday, Oct 30 at
// 9:00 AM", raw E.164 numbers), so an existing US business's prompt — and its
// prompt cache — stays byte-for-byte the same. Anything else goes through Intl.

export interface BusinessLocale {
  /** ISO 4217, e.g. "USD", "INR". Prices are stored in its minor unit (cents, paise). */
  currency: string;
  /** BCP 47, e.g. "en-US", "en-IN". */
  locale: string;
  /** ISO 3166-1 alpha-2, e.g. "US", "IN". Decides how bare local phone numbers are read. */
  countryCode: string;
}

export const DEFAULT_LOCALE: BusinessLocale = { currency: 'USD', locale: 'en-US', countryCode: 'US' };

export interface CountryDefaults {
  name: string;
  flag: string;
  /** International dialling code, e.g. "+91". */
  dialCode: string;
  currency: string;
  locale: string;
  timezone: string;
}

/**
 * Supported countries and what picking one sets up for a business. The admin
 * UI's Country dropdown and the worker's validation both read this list; add
 * a country here (and its phone rules in normalizePhone) to support it.
 */
export const COUNTRIES: Record<string, CountryDefaults> = {
  US: { name: 'United States', flag: '🇺🇸', dialCode: '+1', currency: 'USD', locale: 'en-US', timezone: 'America/Chicago' },
  IN: { name: 'India', flag: '🇮🇳', dialCode: '+91', currency: 'INR', locale: 'en-IN', timezone: 'Asia/Kolkata' },
};

/**
 * The currency, locale and timezone a business gets when switched to
 * `countryCode`. A timezone the business already has in that country (an
 * "America/…" zone for the US) is kept, so switching a US business back to
 * the US restores exactly what it had.
 */
export function countryDefaults(countryCode: string, currentTimezone?: string): BusinessLocale & { timezone: string } {
  const c = COUNTRIES[countryCode] ?? COUNTRIES[DEFAULT_LOCALE.countryCode];
  const code = COUNTRIES[countryCode] ? countryCode : DEFAULT_LOCALE.countryCode;
  const keepZone = currentTimezone && (code === 'US' ? currentTimezone.startsWith('America/') : currentTimezone === c.timezone);
  return { countryCode: code, currency: c.currency, locale: c.locale, timezone: keepZone ? currentTimezone! : c.timezone };
}

/** The locale fields of a sector, with defaults for anything unset. */
export function localeOf(meta: { currency?: string | null; locale?: string | null; countryCode?: string | null } | null | undefined): BusinessLocale {
  return {
    currency: meta?.currency || DEFAULT_LOCALE.currency,
    locale: meta?.locale || DEFAULT_LOCALE.locale,
    countryCode: meta?.countryCode || DEFAULT_LOCALE.countryCode,
  };
}

/** True for the pre-locale US formatting path (kept byte-for-byte). */
export function isLegacyUs(loc: BusinessLocale): boolean {
  return loc.currency === 'USD' && loc.locale === 'en-US';
}

// ── Validation (admin input) ────────────────────────────────────────────────

export function isValidCurrency(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) return false;
  try { new Intl.NumberFormat('en', { style: 'currency', currency: v }); return true; } catch { return false; }
}

export function isValidLocale(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)) return false;
  try { return Intl.getCanonicalLocales(v).length === 1; } catch { return false; }
}

/** Only countries in COUNTRIES: phone numbers are read per country, so an unknown one can't be served. */
export function isValidCountryCode(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COUNTRIES, v);
}

export function isValidTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; }
}

// ── Money ───────────────────────────────────────────────────────────────────

function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Written price, e.g. "$89.99" / "$1500" (US, unchanged) or "₹1,50,000" (en-IN).
 * Whole amounts drop the decimals unless `alwaysFraction` (store credit) is set.
 */
export function formatMoney(minor: number, loc: BusinessLocale = DEFAULT_LOCALE, opts: { alwaysFraction?: boolean } = {}): string {
  if (isLegacyUs(loc)) {
    return `$${(minor / 100).toFixed(opts.alwaysFraction || minor % 100 !== 0 ? 2 : 0)}`;
  }
  const digits = minorDigits(loc.currency);
  const major = minor / 10 ** digits;
  const whole = minor % 10 ** digits === 0;
  const fraction = whole && !opts.alwaysFraction ? 0 : digits;
  try {
    return new Intl.NumberFormat(loc.locale, {
      style: 'currency', currency: loc.currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction,
    }).format(major);
  } catch {
    return `${loc.currency} ${major.toFixed(fraction)}`;
  }
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return under100(r);
  return `${ONES[h]} hundred${r ? ` ${under100(r)}` : ''}`;
}

/**
 * A whole number in words the Indian way: lakh and crore, and "fifteen
 * hundred" for round hundreds between 1,100 and 9,900 (how prices are said).
 */
export function indianNumberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n < 1000) return under1000(n);
  if (n < 10_000 && n % 100 === 0 && n % 1000 !== 0) return `${under100(n / 100)} hundred`;
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${crore >= 1000 ? indianNumberWords(crore) : under1000(crore)} crore`);
  if (lakh) parts.push(`${under100(lakh)} lakh`);
  if (thousand) parts.push(`${under100(thousand)} thousand`);
  if (rest) parts.push(under1000(rest));
  return parts.join(' ');
}

/**
 * A price as it should be said aloud on a call. INR: "fifteen hundred rupees",
 * "one lakh fifty thousand rupees", "ninety-nine rupees and fifty paise".
 * Other currencies use the written form, which the voice already reads well
 * (and US output is unchanged).
 */
export function spokenMoney(minor: number, loc: BusinessLocale = DEFAULT_LOCALE): string {
  if (loc.currency === 'INR' && /^en(-|$)/i.test(loc.locale)) {
    const rupees = Math.floor(minor / 100);
    const paise = minor % 100;
    const r = rupees ? `${indianNumberWords(rupees)} ${rupees === 1 ? 'rupee' : 'rupees'}` : '';
    const p = paise ? `${under100(paise)} paise` : '';
    return r && p ? `${r} and ${p}` : r || p || 'zero rupees';
  }
  return formatMoney(minor, loc);
}

// ── Dates and times ─────────────────────────────────────────────────────────

/** "9:00 AM" (US, unchanged) or the locale's own clock ("9:00 am" in en-IN). */
export function formatClock(mins: number, locale = DEFAULT_LOCALE.locale): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (locale === 'en-US') {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
  } catch {
    return formatClock(mins, 'en-US');
  }
}

/** "Friday, Oct 30" (US) / "Friday, 30 Oct" (en-IN) for a "YYYY-MM-DD". */
export function formatDayLabel(ymd: string, locale = DEFAULT_LOCALE.locale): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' };
  try {
    return d.toLocaleDateString(locale, opts);
  } catch {
    return d.toLocaleDateString('en-US', opts);
  }
}

// ── Phone numbers ───────────────────────────────────────────────────────────

// Two-digit STD codes (metros); other Indian landline codes are mostly three digits.
const IN_METRO_STD = new Set(['11', '20', '22', '33', '40', '44', '79', '80']);

function indianNational(n: string | undefined): string | undefined {
  return n && /^[1-9]\d{9}$/.test(n) ? `+91${n}` : undefined;
}

/**
 * A number as spoken or typed by a caller → E.164, or undefined if it can't
 * be read unambiguously. US (default): "(847) 555-1234" → "+18475551234".
 * India: "98765 43210", "098765 43210", "91 98765 43210", "022 2345 6789",
 * "+91-22-23456789" → "+919876543210" / "+912223456789".
 */
export function normalizePhone(raw: string | undefined, countryCode: string = DEFAULT_LOCALE.countryCode): string | undefined {
  const trimmed = raw?.trim() ?? '';
  let digits = trimmed.replace(/\D/g, '');
  if (countryCode === 'IN') {
    let international = trimmed.startsWith('+');
    if (!international && /^00[1-9]/.test(digits)) { digits = digits.slice(2); international = true; }
    if (digits.length === 12 && digits.startsWith('91')) return indianNational(digits.slice(2));
    if (international) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
    if (digits.length === 11 && digits.startsWith('0')) return indianNational(digits.slice(1));
    if (digits.length === 10) return indianNational(digits);
    return undefined;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

function indianGroups(national: string): string[] {
  if (/^[6-9]/.test(national)) return [national.slice(0, 5), national.slice(5)];
  const std = IN_METRO_STD.has(national.slice(0, 2)) ? 2 : 3;
  const sub = national.slice(std);
  return [national.slice(0, std), sub.slice(0, sub.length - 4), sub.slice(-4)];
}

/**
 * Display form for emails, calendar events and the admin UI. Indian numbers:
 * "+91 98765 43210" (mobile), "+91 22 2345 6789" (metro landline),
 * "+91 141 234 5678". Everything else is returned unchanged.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return e164 ?? '';
  const m = /^\+91(\d{10})$/.exec(e164);
  return m ? `+91 ${indianGroups(m[1]).join(' ')}` : e164;
}

/**
 * How the voice reads a callback number back. For an Indian business and an
 * Indian number: the national digits one by one in their usual groups
 * ("9 8 7 6 5, 4 3 2 1 0"), never "+91…". Unchanged otherwise.
 */
export function spokenPhone(e164: string, loc: BusinessLocale = DEFAULT_LOCALE): string {
  const m = /^\+91(\d{10})$/.exec(e164);
  if (loc.countryCode !== 'IN' || !m) return e164;
  return indianGroups(m[1]).map(g => g.split('').join(' ')).join(', ');
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/**
 * One line for the business profile telling the model how to say prices and
 * numbers in this locale. Empty for the default US locale (prompt unchanged).
 */
export function localeGuidance(loc: BusinessLocale): string {
  if (isLegacyUs(loc)) return '';
  const lines: string[] = [];
  if (loc.currency === 'INR') {
    lines.push('Prices are in Indian rupees. Say amounts in words the way Indian callers do: ₹1,500 is "fifteen hundred rupees", ₹1,50,000 is "one lakh fifty thousand rupees", ₹99.50 is "ninety-nine rupees and fifty paise".');
  } else {
    lines.push(`Prices are in ${loc.currency}.`);
  }
  if (loc.countryCode === 'IN') {
    lines.push('Phone numbers are Indian: ten digits (mobiles start with 6 to 9; landlines include the STD code). Read a number back digit by digit in two groups, without "+91".');
  }
  return lines.join(' ');
}
