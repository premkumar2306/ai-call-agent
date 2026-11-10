import type { Product, SectorMeta } from '../types';
import { formatMoney, localeGuidance, localeOf, spokenMoney } from '../utils/locale';
import { getVertical } from './verticals';

// Renders everything the database knows about a business — contact details,
// weekly hours, and the full service catalog with ids and prices — as one
// plain-text block for the system prompt.
//
// Why this exists: the agent used to see only the business *name*. Address,
// phone and website were in D1 but never reached the model, and every
// "what do you offer / how much is X" question had to go through a
// substring search tool that missed anything not phrased like a product
// name. Small-business catalogs are a few dozen rows, so putting the whole
// thing in the (prompt-cached) system block is both more accurate and
// faster: most questions are answered with no tool round trip at all.

// Past this many products the full catalog stops being cheap to send every
// turn; list names only and let search_services fetch details.
export const FULL_CATALOG_MAX = 80;

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

// A $0 price means two different things in the catalog: genuinely free
// ("Free Vehicle Inspection") or not fixed ("Engine Replacement (Call for
// Quote)", "Custom pricing"). Saying "free" for the second is a costly lie.
const QUOTE_RE = /\b(quote[sd]?|custom pricing|price varies|call for)\b/i;

type Priced = Pick<Product, 'priceCents' | 'originalPriceCents' | 'name' | 'description'>;

// What pricing needs from a business: its locale (currency, number format)
// and vertical (what an unpriced service is called, doctors' fees).
type PriceMeta = Pick<SectorMeta, 'vertical'> & {
  currency?: string | null; locale?: string | null; countryCode?: string | null;
  resources?: SectorMeta['resources'];
};
type Money = (minor: number) => string;

const written = (meta: PriceMeta | null | undefined): Money => c => formatMoney(c, localeOf(meta));
const spoken = (meta: PriceMeta | null | undefined): Money => c => spokenMoney(c, localeOf(meta));

// Prices are stored in the currency's minor unit (cents, paise) and written
// per the business locale: "$89.99" (US, unchanged), "₹1,50,000" (en-IN).
export function formatPrice(p: Priced, meta?: PriceMeta | null): string {
  return describePrice(p, meta, written(meta));
}

/** As formatPrice, but as the voice should say it ("fifteen hundred rupees"). */
export function formatSpokenPrice(p: Priced, meta?: PriceMeta | null): string {
  return describePrice(p, meta, spoken(meta));
}

function describePrice(p: Priced, meta: PriceMeta | null | undefined, money: Money): string {
  if (p.priceCents === 0) {
    return QUOTE_RE.test(`${p.name} ${p.description}`) ? getVertical(meta).quotePrice : 'free';
  }
  const regular = p.originalPriceCents > p.priceCents ? ` (regularly ${money(p.originalPriceCents)})` : '';
  return `${money(p.priceCents)}${regular}`;
}

/**
 * Whether a product is priced by the doctor it's booked with (a clinic's
 * consultation): the vertical says which categories, and the business must
 * have doctors.
 */
export function isResourcePriced(p: Pick<Product, 'category'>, meta: PriceMeta | null | undefined): boolean {
  const spec = getVertical(meta).resources;
  return !!spec && !!meta?.resources?.length && spec.feeCategories.includes(p.category);
}

type PricedInCategory = Priced & Pick<Product, 'category'>;

/** formatPrice, except a consultation reads as the doctor's fee. */
export function priceText(p: PricedInCategory, meta: PriceMeta | null | undefined): string {
  return resourcePrice(p, meta, written(meta)) ?? formatPrice(p, meta);
}

/** priceText as the voice should say it. */
export function spokenPriceText(p: PricedInCategory, meta: PriceMeta | null | undefined): string {
  return resourcePrice(p, meta, spoken(meta)) ?? formatSpokenPrice(p, meta);
}

function resourcePrice(p: PricedInCategory, meta: PriceMeta | null | undefined, money: Money): string | undefined {
  if (!isResourcePriced(p, meta)) return undefined;
  // Only the doctors who do it: a dental consultation is the dentist's fee.
  const who = meta!.resources!.filter(r => !r.categories?.length || r.categories.includes(p.category));
  const fees = (who.length ? who : meta!.resources!).map(r => r.feeCents);
  if (fees[0] != null && fees.every(f => f === fees[0])) return fees[0] ? money(fees[0]) : 'free';
  return getVertical(meta).resources!.feeText;
}

export function formatWeeklyHours(hours: SectorMeta['hours'] | undefined): string {
  if (!hours) return 'not listed';
  return DAY_ORDER
    // Every dash: split hours ("10am–1pm, 5pm–9pm") read as two ranges.
    .map(d => `${DAY_LABEL[d]} ${(hours as Record<string, string | undefined>)[d]?.replace(/[–-]/g, ' to ') ?? 'closed'}`)
    .join('; ');
}

function formatProduct(p: Product, byId: Map<string, Product>, meta: SectorMeta | null | undefined): string {
  const parts = [`- ${p.name} [id: ${p.id}] — ${priceText(p, meta)}`];
  if (p.durationMinutes) parts.push(`about ${p.durationMinutes} min`);
  if (p.type !== 'SERVICE_APPOINTMENT') parts.push(p.fulfillmentType === 'IN_STORE_PICKUP' ? 'part, pick up in store' : 'product');
  let line = parts.join(', ') + `. ${p.description}`;
  const upsell = p.upsellProductId ? byId.get(p.upsellProductId) : undefined;
  if (upsell) line += ` Pairs well with: ${upsell.name}.`;
  return line;
}

export function buildBusinessProfile(
  businessType: string,
  meta: SectorMeta | null | undefined,
  products: Product[],
): string {
  const name = meta?.name ?? businessType;
  const lines: string[] = [`BUSINESS PROFILE — ${name}`];
  if (meta?.address) lines.push(`Address: ${meta.address}`);
  if (meta?.phone) lines.push(`Phone: ${meta.phone}`);
  if (meta?.website) lines.push(`Website: ${meta.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}`);
  lines.push(`Hours: ${formatWeeklyHours(meta?.hours)}${meta?.timezone ? ` (${meta.timezone} time)` : ''}`);
  if (meta?.about?.trim()) lines.push(`About: ${meta.about.trim()}`);
  const guidance = localeGuidance(localeOf(meta));
  if (guidance) lines.push(guidance);
  lines.push(...describeResources(meta));

  const active = products.filter(p => p.isActive);
  if (!active.length) {
    lines.push('Services: none listed.');
    return lines.join('\n');
  }

  if (active.length > FULL_CATALOG_MAX) {
    lines.push(`Services (${active.length}; names only — call search_services for price and details):`);
    lines.push(active.map(p => p.name).join('; '));
    return lines.join('\n');
  }

  const byId = new Map(active.map(p => [p.id, p]));
  const byCategory = new Map<string, Product[]>();
  for (const p of active) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  lines.push('Services and prices (complete list — nothing else is offered):');
  for (const [category, list] of byCategory) {
    lines.push(`${category.replace(/_/g, ' ')}:`);
    for (const p of list) lines.push(formatProduct(p, byId, meta));
  }
  return lines.join('\n');
}

// A clinic's doctors: who, when they sit (OPD hours), fee and slot length.
// Nothing for businesses without resources.
function describeResources(meta: SectorMeta | null | undefined): string[] {
  const spec = getVertical(meta).resources;
  if (!spec || !meta?.resources?.length) return [];
  const lines = [`${spec.heading}:`];
  for (const r of meta.resources) {
    const parts = [`- ${r.name} [${spec.param}: ${r.id}]${r.role ? ` — ${r.role}` : ''}.`];
    parts.push(`Hours: ${formatWeeklyHours(r.hours)}.`);
    if (r.feeCents != null) parts.push(`${spec.feeLabel.charAt(0).toUpperCase() + spec.feeLabel.slice(1)}: ${r.feeCents ? formatMoney(r.feeCents, localeOf(meta)) : 'free'}.`);
    parts.push(`${r.slotMinutes}-minute appointments.`);
    if (r.categories?.length) parts.push(`Books only: ${r.categories.map(c => c.replace(/_/g, ' ').toLowerCase()).join(', ')}.`);
    if (r.about?.trim()) parts.push(r.about.trim());
    lines.push(parts.join(' '));
  }
  return lines;
}

// "Now" as the business sees it, plus the next week's weekday → date map, so
// the model can turn "tomorrow" or "next Tuesday" into the YYYY-MM-DD the
// tools need without guessing. The time is floored to the half hour so this
// block stays byte-identical (and prompt-cacheable) for most of a call.
export function describeLocalNow(now: Date, timeZone: string | undefined, locale = 'en-US'): string {
  const tz = timeZone || 'UTC';
  const floored = new Date(Math.floor(now.getTime() / 1_800_000) * 1_800_000);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return describeLocalNow(now, 'UTC', locale);
  }
  // An invalid locale falls back to en-US rather than breaking the prompt.
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try { return new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }); }
    catch { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }); }
  };
  const today = fmt({
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(floored);
  const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const weekdayFmt = fmt({ weekday: 'long' });
  const weekday = (d: Date) => weekdayFmt.format(d);
  const upcoming: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const label = i === 0 ? 'today' : i === 1 ? 'tomorrow' : weekday(d);
    upcoming.push(`${label} ${ymd(d)}`);
  }
  return `Current local time: ${today}. Dates: ${upcoming.join(', ')}.`;
}
