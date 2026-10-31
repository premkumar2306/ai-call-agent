import { eq, and, ne, gte, lte } from 'drizzle-orm';
import type { SessionPayload, Env, SectorMeta } from '../types';
import { getProducts, getProductById, searchProducts } from './catalog.service';
import { placeOrder, getOrders, getOrder, cancelOrder } from './order.service';
import { scoreProducts } from './recommendations.service';
import { formatPrice } from './business-profile';
import { getDb } from '../db/client';
import { orders as ordersTable } from '../db/schema';
import type { CallCache } from './call-context';
import {
  getCalendarBusy, overlapsBusy, bookingInterval, isSlotFreeInCalendar,
  syncBookingToCalendar, removeBookingFromCalendar, type BusyInterval,
} from './calendar';

/** Optional per-tool-call timing hook: fn(label) logs elapsed ms since the tool started. */
type ToolLap = (label: string) => void;

/**
 * Optional sink for work that must not delay the reply (calendar event
 * writes) — HTTP routes pass ctx.waitUntil, CallRelay a floating promise.
 * Without one the work is awaited inline.
 */
type Background = (p: Promise<unknown>) => void;

const CART_TTL = 3600; // 1 hour

function cartKey(token: SessionPayload) { return `cart:${token.sub}:${token.businessType}`; }

async function getCart(env: Env, key: string): Promise<{ productId: string; quantity: number }[]> {
  const raw = await env.CART.get(key);
  return raw ? JSON.parse(raw) : [];
}
async function setCart(env: Env, key: string, cart: { productId: string; quantity: number }[]): Promise<void> {
  await env.CART.put(key, JSON.stringify(cart), { expirationTtl: CART_TTL });
}

// ── Availability helpers ───────────────────────────────────────────────────

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function parseHoursRange(range: string): { openH: number; openM: number; closeH: number; closeM: number } | null {
  // e.g. "8am–7pm" or "7:30am–6pm"
  const m = range.trim().match(/^(\d+)(?::(\d+))?\s*(am|pm)\s*[–-]\s*(\d+)(?::(\d+))?\s*(am|pm)$/i);
  if (!m) return null;
  let openH = parseInt(m[1]);
  const openAP = m[3].toLowerCase();
  let closeH = parseInt(m[4]);
  const closeAP = m[6].toLowerCase();
  if (openAP === 'pm' && openH !== 12) openH += 12;
  if (openAP === 'am' && openH === 12) openH = 0;
  if (closeAP === 'pm' && closeH !== 12) closeH += 12;
  if (closeAP === 'am' && closeH === 12) closeH = 0;
  return { openH, openM: parseInt(m[2] ?? '0'), closeH, closeM: parseInt(m[5] ?? '0') };
}

/**
 * Query D1 for confirmed SERVICE_BOOKING datetimes for this business, bounded
 * to the next 14 days (the only window getAvailableSlots ever offers) rather
 * than every booking in the table's lifetime. Relies on
 * idx_orders_business_type_scheduled (businessType, scheduledAt) — without it
 * this is a full table scan filtered post-hoc, which is exactly the O(all
 * bookings ever) cost this was meant to fix. `scheduled_at` is stored as an
 * ISO string, so lexical and chronological ordering agree and gte/lte work
 * directly on it.
 */
export async function getBookedDatetimes(env: Env, businessType: string): Promise<Set<string>> {
  const db = getDb(env.DB);
  const now = new Date().toISOString();
  const horizon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const booked = await db
    .select({ scheduledAt: ordersTable.scheduledAt })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.businessType, businessType),
        ne(ordersTable.status, 'CANCELLED'),
        gte(ordersTable.scheduledAt, now),
        lte(ordersTable.scheduledAt, horizon),
      )
    );
  // Normalise to "YYYY-MM-DDTHH:MM" for slot collision matching
  return new Set(booked.map(r => r.scheduledAt!.slice(0, 16)));
}

// Calendar date + weekday of `date` as seen in the business's timezone.
// Slot times are business-local wall-clock values, so the day they fall on
// must come from that zone, not from the Worker's UTC clock (otherwise a
// Chicago shop's Monday hours get offered on Sunday evening local time).
export function localDay(date: Date, timeZone: string | undefined): { ymd: string; dayKey: typeof DAY_NAMES[number] } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(date);
  } catch {
    // Unknown IANA zone in sector config — fall back rather than fail the tool.
    return localDay(date, 'UTC');
  }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const dayKey = get('weekday').toLowerCase().slice(0, 3) as typeof DAY_NAMES[number];
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, dayKey };
}

// Minutes since local midnight in the business's timezone.
export function localMinutes(date: Date, timeZone: string | undefined): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    return localMinutes(date, 'UTC');
  }
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  return get('hour') * 60 + get('minute');
}

export interface Slot { date: string; time: string; datetime: string; label: string; minutes: number }

// "9:00 AM" from minutes since midnight.
function clockLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Spoken label for a business-local "YYYY-MM-DDTHH:MM[:SS]" — formatted from
// the string itself, never via Date parsing (the Worker clock is UTC, the
// string is wall-clock time in the business's zone).
export function formatSlotLabel(datetime: string, todayYmd?: string, tomorrowYmd?: string): string {
  const ymd = datetime.slice(0, 10);
  const mins = parseInt(datetime.slice(11, 13), 10) * 60 + parseInt(datetime.slice(14, 16), 10);
  const day = ymd === todayYmd ? 'today'
    : ymd === tomorrowYmd ? 'tomorrow'
    : new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${day} at ${clockLabel(mins)}`;
}

// Earliest a same-day slot may start, so nobody is offered "today at 2"
// at 1:55.
const SAME_DAY_LEAD_MIN = 60;
export const AVAILABILITY_DAYS = 14;

export async function getAvailableSlots(
  env: Env,
  businessType: string,
  meta: SectorMeta | null | undefined,
  durationMinutes = 60,
  bookedDatetimes?: Set<string>,
  calendarBusy?: BusyInterval[] | null,
  now: Date = new Date(),
): Promise<Slot[]> {
  const rawSlots: Slot[] = [];
  // Any half hour inside opening hours is bookable, so "9 works" can be
  // booked even when 8:30 and 9:30 were the times read out.
  const stepMin = 30;
  const today = localDay(now, meta?.timezone).ymd;
  const tomorrow = localDay(new Date(now.getTime() + 86_400_000), meta?.timezone).ymd;
  const nowMin = localMinutes(now, meta?.timezone);

  for (let dayOffset = 0; dayOffset <= AVAILABILITY_DAYS; dayOffset++) {
    const { ymd: dateStr, dayKey } = localDay(new Date(now.getTime() + dayOffset * 86_400_000), meta?.timezone);
    const hoursStr = meta?.hours[dayKey];
    if (!hoursStr) continue;

    const parsed = parseHoursRange(hoursStr);
    if (!parsed) continue;
    const openMin = Math.ceil((parsed.openH * 60 + parsed.openM) / 30) * 30;
    const closeMin = parsed.closeH * 60 + parsed.closeM;

    for (let m = openMin; m + durationMinutes <= closeMin; m += stepMin) {
      if (dateStr === today && m < nowMin + SAME_DAY_LEAD_MIN) continue;
      const datetime = `${dateStr}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      rawSlots.push({
        date: dateStr,
        time: clockLabel(m),
        datetime,
        label: formatSlotLabel(datetime, today, tomorrow),
        minutes: m,
      });
    }
  }

  // Filter out slots already booked. If the caller already has a fresh
  // booked-slot set for this call (CallRelay prefetches one at call start
  // and keeps it in sync — see CallCache), reuse it instead of a D1 round
  // trip; otherwise fetch fresh (stateless callers, or no cache yet).
  const booked = bookedDatetimes ?? await getBookedDatetimes(env, businessType);
  // Then anything the business's connected calendar says is busy, over the
  // appointment's full length (not just its start time).
  const busy = calendarBusy ?? [];
  return rawSlots
    .filter(s => !booked.has(s.datetime.slice(0, 16)))
    .filter(s => {
      if (!busy.length) return true;
      const { start, end } = bookingInterval(s.datetime, durationMinutes, meta?.timezone);
      return !overlapsBusy(start.getTime(), end.getTime(), busy);
    });
}

const TIME_OF_DAY: Record<string, [number, number]> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 24 * 60],
};

/**
 * Narrows the open slots to what the caller asked for and picks the few to
 * say out loud. A preferred date shows that day's times; with no preference
 * the first opening on each of the next few days is offered. When the
 * preference can't be met the nearest alternatives are returned instead,
 * flagged so the reply can say so rather than silently offering other days.
 */
export function pickSlots(
  slots: Slot[],
  opts: { preferredDate?: string; timeOfDay?: string; count?: number },
): { shown: Slot[]; matchedPreference: boolean } {
  const count = opts.count ?? 3;
  const range = opts.timeOfDay ? TIME_OF_DAY[opts.timeOfDay.toLowerCase()] : undefined;
  const inRange = (s: Slot) => !range || (s.minutes >= range[0] && s.minutes < range[1]);
  const spread = (list: Slot[]) => {
    const out: Slot[] = [];
    const seen = new Set<string>();
    for (const s of list) {
      if (!seen.has(s.date)) { seen.add(s.date); out.push(s); }
      if (out.length === count) break;
    }
    return out;
  };

  // Same-day choices read out an hour apart (7:30, 8:30, 9:30), not three
  // neighbouring half hours; the in-between times are still bookable.
  const spaced = (list: Slot[]) => {
    const out: Slot[] = [];
    for (const s of list) {
      if (!out.length || s.minutes >= out[out.length - 1].minutes + 60) out.push(s);
      if (out.length === count) break;
    }
    return out;
  };

  const preferred = opts.preferredDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.preferredDate) ? opts.preferredDate : undefined;
  if (preferred) {
    const sameDay = slots.filter(s => s.date === preferred);
    const fitting = sameDay.filter(inRange);
    if (fitting.length) return { shown: spaced(fitting), matchedPreference: true };
    if (sameDay.length) return { shown: spaced(sameDay), matchedPreference: false };
    const after = slots.filter(s => s.date > preferred);
    return { shown: spread(after.length ? after : slots), matchedPreference: false };
  }
  if (range) {
    const fitting = slots.filter(inRange);
    if (fitting.length) return { shown: spread(fitting), matchedPreference: true };
    return { shown: spread(slots), matchedPreference: false };
  }
  return { shown: spread(slots), matchedPreference: true };
}

// Prefers the call's cached catalog over a KV/D1 round trip.
async function lookupProduct(env: Env, cache: CallCache | undefined, id: string | undefined) {
  if (!id) return null;
  return cache?.productsAll?.find(p => p.id === id) ?? await getProductById(env, id);
}

function formatHours(meta: SectorMeta | null | undefined): string {
  if (!meta) return 'Please call for hours.';
  const lines = (Object.entries(meta.hours) as [string, string][])
    .map(([day, hours]) => `${day.charAt(0).toUpperCase() + day.slice(1)}: ${hours}`);
  return lines.join(', ');
}

// ── Main executor ──────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  data?: unknown;
  spoken_response: string;
  error?: string;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  token: SessionPayload,
  env: Env,
  sectorMeta?: SectorMeta | null,
  cache?: CallCache,
  lap?: ToolLap,
  background?: Background,
): Promise<ToolResult> {
  const { businessType, account } = token;
  const defer = async (p: Promise<unknown>) => {
    const safe = p.catch(err => console.error(`[tool:${toolName}] background error`, err?.message || err));
    if (background) background(safe); else await safe;
  };

  try {
    switch (toolName) {

      // ── Account ──────────────────────────────────────────────────
      case 'check_account': {
        const credit = (account.store_credit_cents / 100).toFixed(2);
        return {
          success: true,
          data: account,
          spoken_response: `You have $${credit} in store credit and you're a ${account.tier} member.`,
        };
      }

      // ── Discovery ────────────────────────────────────────────────
      case 'search_services':
      case 'search_products': {
        const query = (args.query as string | undefined)?.trim() ?? '';
        const rawCategory = args.category as string | undefined;
        const category = rawCategory && rawCategory !== 'ALL' ? rawCategory : undefined;
        // Reuse the call's cached full product list when there's no category
        // filter — avoids a KV round trip on every search_services call in a
        // multi-turn call (e.g. after a clarifying question).
        let all: Awaited<ReturnType<typeof getProducts>>;
        if (!category && cache?.productsAll) {
          all = cache.productsAll;
        } else {
          all = await getProducts(env, businessType, category);
          if (!category && cache) cache.productsAll = all;
        }
        lap?.('getProducts');
        const results = query ? searchProducts(all, query) : all;
        const top5 = results.slice(0, 5);
        if (top5.length === 0) {
          // Hand the model the real menu so it can suggest the closest
          // service instead of dead-ending the caller.
          return {
            success: true,
            data: { products: [], matchType: 'no_match', query, all_services: all.map(p => p.name) },
            spoken_response: "I couldn't match that to a listed service.",
          };
        }
        // Include IDs in data so Claude can use them immediately for check_availability / book_appointment
        const topResult = top5[0];
        const price = formatPrice(topResult);
        const duration = topResult.durationMinutes ? `, about ${topResult.durationMinutes} minutes` : '';
        const spoken = top5.length === 1
          ? `We have ${topResult.name} — ${price}${duration}. Want me to find you a time?`
          : `The closest match is ${topResult.name} — ${price}. We also have ${top5.slice(1, 3).map(p => p.name).join(' and ')}. Which one sounds right?`;
        return {
          success: true,
          data: {
            products: top5.map(p => ({ id: p.id, name: p.name, price: formatPrice(p), durationMinutes: p.durationMinutes, category: p.category, description: p.description })),
            matchType: 'match',
            query,
          },
          spoken_response: spoken,
        };
      }

      case 'get_service_detail':
      case 'get_product_detail': {
        const p = await lookupProduct(env, cache, args.product_id as string);
        if (!p) return { success: false, spoken_response: "I couldn't find that service." };
        const duration = p.durationMinutes ? ` Takes about ${p.durationMinutes} minutes.` : '';
        return {
          success: true, data: p,
          spoken_response: `${p.name} — ${formatPrice(p)}.${duration} ${p.description}`,
        };
      }

      // ── Scheduling ───────────────────────────────────────────────
      case 'check_availability': {
        const serviceId = args.service_id as string | undefined;
        let duration = 60;
        let serviceName = '';
        // Calendar busy times are fetched alongside the product lookup.
        // CallRelay prefetches them at call start too; null means not
        // loaded yet (or the calendar was unreachable — retried next time).
        const busyP = cache?.calendarBusy
          ? Promise.resolve(cache.calendarBusy)
          : getCalendarBusy(env, businessType).then(b => { if (cache && b) cache.calendarBusy = b; return b; });
        if (serviceId) {
          const p = await lookupProduct(env, cache, serviceId);
          lap?.('lookupProduct');
          if (p?.durationMinutes) duration = p.durationMinutes;
          if (p?.name) serviceName = p.name;
        }
        const calendarBusy = await busyP;
        lap?.('calendarBusy');
        // getAvailableSlots' internal D1 lookup (getBookedDatetimes) is
        // skipped entirely when the call already has a prefetched, kept-in-
        // sync booked-slot set (CallRelay prefetches one at call start —
        // see CallCache) — this tool becomes pure CPU in that case.
        const slots = await getAvailableSlots(env, businessType, sectorMeta, duration, cache?.bookedDatetimes ?? undefined, calendarBusy);
        lap?.('getAvailableSlots');
        if (slots.length === 0) {
          return { success: true, data: { slots: [] }, spoken_response: `We don't have any openings in the next ${AVAILABILITY_DAYS} days. Please call us directly.` };
        }
        const preferredDate = args.preferred_date as string | undefined;
        const timeOfDay = args.time_of_day as string | undefined;
        // An exact day and time ("Wednesday at 10"): if it's open, hand back
        // just that slot so the model books it this turn instead of reading
        // out three other times. If not, offer that day's nearest times.
        const timeMatch = /^(\d{1,2}):(\d{2})/.exec(String(args.preferred_time ?? ''));
        if (preferredDate && timeMatch) {
          const wanted = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
          const exact = slots.find(s => s.date === preferredDate && s.minutes === wanted);
          if (exact) {
            const { minutes: _m, ...slot } = exact;
            return {
              success: true,
              data: { requested_slot: slot, requested_open: true, service_id: serviceId },
              spoken_response: `${exact.label} is open.`,
            };
          }
          const sameDay = slots.filter(s => s.date === preferredDate)
            .sort((a, b) => Math.abs(a.minutes - wanted) - Math.abs(b.minutes - wanted))
            .slice(0, 3)
            .sort((a, b) => a.minutes - b.minutes);
          if (sameDay.length) {
            const spokenFor = serviceName ? ` for ${serviceName}` : '';
            return {
              success: true,
              data: { requested_open: false, offered: sameDay.map(({ minutes: _x, ...r }) => r), service_id: serviceId },
              spoken_response: `That time isn't open, but the nearest openings${spokenFor} are ${joinOr(sameDay.map(s => s.label))}. Which works for you?`,
            };
          }
        }
        const { shown, matchedPreference } = pickSlots(slots, { preferredDate, timeOfDay });
        const spokenFor = serviceName ? ` for ${serviceName}` : '';
        const asked = preferredDate || timeOfDay;
        const lead = asked && !matchedPreference
          ? `That time is booked up, but the nearest openings${spokenFor} are`
          : `I have openings${spokenFor}`;
        const spoken = `${lead} ${joinOr(shown.map(s => s.label))}. Which works for you?`;
        // `datetime` is what book_appointment needs — offered slots first so
        // the model books exactly what the caller heard.
        const strip = ({ minutes: _m, ...rest }: Slot) => rest;
        // Everything else open on the day(s) being discussed comes first, so
        // "anything earlier?" can be answered from this result instead of
        // the model guessing that what it offered was all there is.
        const focusDays = new Set(preferredDate ? [preferredDate] : shown.map(s => s.date));
        const notShown = slots.filter(s => !shown.includes(s));
        const rest = [
          ...notShown.filter(s => focusDays.has(s.date)),
          ...notShown.filter(s => !focusDays.has(s.date)),
        ].slice(0, 15);
        return {
          success: true,
          data: { offered: shown.map(strip), other_open_slots: rest.map(strip), matched_preference: matchedPreference, service_id: serviceId },
          spoken_response: spoken,
        };
      }

      case 'get_business_hours': {
        const hoursStr = formatHours(sectorMeta);
        const name = sectorMeta?.name ?? businessType;
        return {
          success: true,
          data: { name, hours: sectorMeta?.hours ?? {}, timezone: sectorMeta?.timezone },
          spoken_response: `${name} hours: ${hoursStr}.`,
        };
      }

      // ── Upsell / Recommendations ─────────────────────────────────
      case 'get_upsells': {
        const p = await lookupProduct(env, cache, args.product_id as string);
        if (!p?.upsellProductId) {
          return { success: true, data: { upsells: [] }, spoken_response: "No add-ons available for that one." };
        }
        const upsell = await lookupProduct(env, cache, p.upsellProductId);
        if (!upsell) return { success: true, data: { upsells: [] }, spoken_response: "No add-ons right now." };
        const price = formatPrice(upsell);
        return {
          success: true,
          data: { upsells: [upsell] },
          spoken_response: `Many customers also add ${upsell.name} for ${price}. Want to include that?`,
        };
      }

      case 'get_recommendations': {
        const all = cache?.productsAll ?? await getProducts(env, businessType);
        if (cache && !cache.productsAll) cache.productsAll = all;
        const scored = scoreProducts(all, account.store_credit_cents).slice(0, (args.limit as number) || 3);
        if (scored.length === 0) {
          return { success: true, data: { recommendations: [] }, spoken_response: "No recommendations right now. What are you looking for?" };
        }
        const spoken = `My top picks: ${scored.map(r => `${r.name} — ${r.reason}`).join('; ')}.`;
        return { success: true, data: { recommendations: scored }, spoken_response: spoken };
      }

      // ── Cart ─────────────────────────────────────────────────────
      case 'add_to_cart': {
        const key = cartKey(token);
        const cart = await getCart(env, key);
        const existing = cart.find(i => i.productId === args.product_id);
        if (existing) {
          existing.quantity += (args.quantity as number) || 1;
        } else {
          cart.push({ productId: args.product_id as string, quantity: (args.quantity as number) || 1 });
        }
        await setCart(env, key, cart);
        const p = await lookupProduct(env, cache, args.product_id as string);
        return {
          success: true, data: { cart },
          spoken_response: `Added ${p?.name ?? 'item'} to your cart. Ready to confirm?`,
        };
      }

      // ── Booking / Order ───────────────────────────────────────────
      case 'book_appointment':
      case 'place_order': {
        const scheduledAt = args.scheduled_at as string | undefined;
        const product = await lookupProduct(env, cache, args.product_id as string);
        if (!product) return { success: false, error: 'NOT_FOUND', spoken_response: TOOL_ERROR_MESSAGES.NOT_FOUND };
        if (product.fulfillmentType === 'SERVICE_BOOKING' && !scheduledAt) {
          return { success: false, error: 'INVALID_SCHEDULE', spoken_response: "Which day and time would you like? I can check what's open." };
        }
        // The model sometimes books a time it never offered ("2:15", or a
        // Sunday). Reject anything outside opening hours or already past
        // before it reaches the DB, so the reply can steer back to real slots.
        if (scheduledAt) {
          const problem = checkWithinHours(scheduledAt, product.durationMinutes ?? 60, sectorMeta);
          if (problem) return { success: false, error: problem, spoken_response: TOOL_ERROR_MESSAGES[problem] };
        }
        // Re-check the slot against the business's calendar (something may
        // have been added since check_availability). Runs in parallel with
        // the D1 insert so the common, free case adds no latency; if the
        // calendar says busy, the just-created booking is cancelled again.
        const durationP = Promise.resolve(product.durationMinutes ?? 60);
        const slotFreeP = scheduledAt
          ? durationP.then(d => {
              const { start, end } = bookingInterval(scheduledAt, d, sectorMeta?.timezone);
              return isSlotFreeInCalendar(env, businessType, start, end);
            })
          : Promise.resolve(true);
        const [order, slotFree] = await Promise.all([
          placeOrder(
            env,
            token.sub,
            businessType,
            args.product_id as string,
            (args.payment_method as string | undefined) ?? 'CREDIT_CARD',
            args.shipping_address as any,
            scheduledAt
          ),
          slotFreeP,
        ]);
        lap?.('placeOrder');
        if (!slotFree) {
          await cancelOrder(env, order.id, token.sub);
          // Stale busy times got us here — refetch on the next availability check.
          if (cache) cache.calendarBusy = null;
          return { success: false, error: 'SLOT_TAKEN', spoken_response: TOOL_ERROR_MESSAGES.SLOT_TAKEN };
        }
        if (order.scheduledAt) {
          const duration = await durationP;
          await defer(syncBookingToCalendar(env, order, sectorMeta, duration));
        }
        // Clear from cart. The customer already heard the booking confirmed
        // by the time this write happens — cart bookkeeping doesn't need to
        // block the response, so fire it and move on.
        const key = cartKey(token);
        const cart = await getCart(env, key);
        setCart(env, key, cart.filter(i => i.productId !== args.product_id))
          .catch(err => console.error('cart clear error', err.message));

        // This call's cached order list / booked-slot set are now stale.
        // Invalidate the list wholesale (cheap — next getOrders() refetches)
        // and patch the booked-slot set in place rather than dropping it
        // entirely, since check_availability right after a booking is a
        // common next turn and shouldn't pay a fresh D1 round trip for it.
        if (cache) {
          cache.orders = null;
          cache.ordersLoaded = false;
          if (order.scheduledAt && cache.bookedDatetimes) {
            cache.bookedDatetimes.add(order.scheduledAt.slice(0, 16));
          }
        }

        const when = order.scheduledAt ? ` for ${formatSlotLabel(order.scheduledAt, ...todayTomorrow(sectorMeta))}` : '';
        const msg = `You're all set — ${order.productName}${when}.`;
        return {
          success: true,
          data: { id: order.id, reference: order.id.slice(0, 8), service: order.productName, scheduled_at: order.scheduledAt, status: order.status, price: formatPrice(product) },
          spoken_response: msg,
        };
      }

      // ── Booking management ────────────────────────────────────────
      case 'get_booking_status':
      case 'get_order_status': {
        const order = await getOrder(env, args.order_id as string, token.sub);
        if (!order) return { success: false, spoken_response: "I couldn't find that booking." };
        const scheduled = order.scheduledAt
          ? ` Scheduled for ${formatSlotLabel(order.scheduledAt, ...todayTomorrow(sectorMeta))}.`
          : '';
        let spoken = `Booking ${order.id.slice(0, 8)} — ${order.productName} is ${order.status}.${scheduled}`;
        if (order.trackingNumber) spoken += ` Tracking: ${order.trackingNumber}.`;
        return { success: true, data: order, spoken_response: spoken };
      }

      case 'list_bookings':
      case 'list_orders': {
        let orders = cache?.ordersLoaded ? cache.orders! : await getOrders(env, token.sub, businessType);
        if (cache && !cache.ordersLoaded) { cache.orders = orders; cache.ordersLoaded = true; }
        if (orders.length === 0) {
          return { success: true, data: { orders: [] }, spoken_response: "You don't have any bookings yet." };
        }
        const upcoming = orders.filter(o => o.status !== 'CANCELLED');
        if (upcoming.length === 0) {
          return { success: true, data: { orders: [] }, spoken_response: "You don't have any active bookings." };
        }
        const describe = (o: typeof orders[number]) =>
          `${o.productName}${o.scheduledAt ? ` on ${formatSlotLabel(o.scheduledAt, ...todayTomorrow(sectorMeta))}` : ''}`;
        const spoken = `You have ${upcoming.length} booking${upcoming.length > 1 ? 's' : ''}: ${upcoming.slice(0, 3).map(describe).join(', and ')}.`;
        return {
          success: true,
          data: { orders: upcoming.slice(0, 10).map(o => ({ id: o.id, service: o.productName, scheduled_at: o.scheduledAt, status: o.status })) },
          spoken_response: spoken,
        };
      }

      case 'cancel_booking':
      case 'cancel_order': {
        let orderId = args.order_id as string | undefined;
        // If no order_id, find the most recent matching booking by product name
        if (!orderId && args.product_name) {
          const recent = cache?.ordersLoaded ? cache.orders! : await getOrders(env, token.sub, businessType);
          if (cache && !cache.ordersLoaded) { cache.orders = recent; cache.ordersLoaded = true; }
          const query = (args.product_name as string).toLowerCase();
          const match = recent.find(o =>
            ['PENDING', 'ACCEPTED', 'COMPLETE'].includes(o.status) &&
            o.productName.toLowerCase().includes(query)
          );
          if (!match) {
            return { success: false, spoken_response: `I couldn't find an active booking for ${args.product_name}. Want me to list your bookings?` };
          }
          orderId = match.id;
        }
        if (!orderId) return { success: false, spoken_response: "I need to know which booking to cancel. Let me pull up your recent bookings first." };
        const order = await cancelOrder(env, orderId, token.sub);
        lap?.('cancelOrder');
        await defer(removeBookingFromCalendar(env, order));
        // Stale cached order list / booked-slot entry — same reasoning as
        // book_appointment above.
        if (cache) {
          cache.orders = null;
          cache.ordersLoaded = false;
          if (order.scheduledAt && cache.bookedDatetimes) {
            cache.bookedDatetimes.delete(order.scheduledAt.slice(0, 16));
          }
        }
        const when = order.scheduledAt ? ` on ${formatSlotLabel(order.scheduledAt, ...todayTomorrow(sectorMeta))}` : '';
        return {
          success: true,
          data: { id: order.id, service: order.productName, scheduled_at: order.scheduledAt, status: order.status },
          spoken_response: `Done — your ${order.productName} appointment${when} is cancelled.`,
        };
      }

      default:
        return { success: false, spoken_response: `Unknown tool: ${toolName}`, error: 'UNKNOWN_TOOL' };
    }
  } catch (err: any) {
    const code: string = err?.code ?? 'ERROR';
    // Known business errors get a caller-safe sentence; anything else is
    // logged, never spoken — raw error text can leak internals (SQL, URLs).
    const known = TOOL_ERROR_MESSAGES[code];
    if (!known) console.error(`[tool:${toolName}] error`, err?.message || err);
    return { success: false, spoken_response: known ?? "Sorry, I ran into a problem with that. Could you try again?", error: code };
  }
}

const TOOL_ERROR_MESSAGES: Record<string, string> = {
  NOT_FOUND: "I couldn't find that one.",
  INVALID_SECTOR: "That service isn't offered here.",
  ADDRESS_REQUIRED: "I'll need a shipping address for that item.",
  INVALID_STATUS: "That booking can't be changed anymore.",
  INVALID_SCHEDULE: "I need a valid upcoming date and time for that booking.",
  SLOT_TAKEN: "Sorry, that time was just taken. Want me to check other openings?",
  OUTSIDE_HOURS: "We're not open then. Want me to find the nearest opening?",
  PAST_TIME: "That time has already passed. Want me to find the next opening?",
};

function todayTomorrow(meta: SectorMeta | null | undefined): [string, string] {
  const now = new Date();
  return [localDay(now, meta?.timezone).ymd, localDay(new Date(now.getTime() + 86_400_000), meta?.timezone).ymd];
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/** Null if `scheduledAt` (business-local wall clock) fits the opening hours and hasn't passed. */
export function checkWithinHours(
  scheduledAt: string, durationMinutes: number, meta: SectorMeta | null | undefined, now: Date = new Date(),
): 'OUTSIDE_HOURS' | 'PAST_TIME' | null {
  if (!meta || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scheduledAt)) return null;
  const ymd = scheduledAt.slice(0, 10);
  const mins = parseInt(scheduledAt.slice(11, 13), 10) * 60 + parseInt(scheduledAt.slice(14, 16), 10);
  const today = localDay(now, meta.timezone).ymd;
  if (ymd < today || (ymd === today && mins < localMinutes(now, meta.timezone))) return 'PAST_TIME';
  const dayKey = DAY_NAMES[new Date(`${ymd}T12:00:00Z`).getUTCDay()];
  const parsed = meta.hours[dayKey] ? parseHoursRange(meta.hours[dayKey]!) : null;
  if (!parsed) return 'OUTSIDE_HOURS';
  const open = parsed.openH * 60 + parsed.openM;
  const close = parsed.closeH * 60 + parsed.closeM;
  return mins >= open && mins + durationMinutes <= close ? null : 'OUTSIDE_HOURS';
}

// ── Tool definitions — sector-agnostic, voice-optimised ───────────────────
// Each sector populates the category enum from its SECTORS metadata.

export function getToolDefinitions(sector: string, sectorMeta?: SectorMeta | null) {
  const meta = sectorMeta;
  const categoryEnum = meta ? [...meta.categories, 'ALL'] : ['ALL'];
  const bizName = meta?.name ?? sector;
  const isService = meta?.model === 'service';
  const isMixed = meta?.model === 'mixed';

  return [
    {
      name: 'check_account',
      description: 'Check the customer\'s balance, loyalty tier, and account status.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'search_services',
      description: `Search ${bizName} services${isMixed ? ' or products' : ''}. Use whenever the customer asks "what do you offer", "do you have X", or anything about pricing.`,
      parameters: {
        type: 'object',
        properties: {
          query:    { type: 'string', description: 'What the customer is asking about. E.g. "oil change", "root canal", "3 bedroom".' },
          category: { type: 'string', enum: categoryEnum, description: 'Optional filter by category.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_service_detail',
      description: 'Get full details (price, duration, description) for a specific service or listing.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'string', description: 'ID from search_services results.' } },
        required: ['product_id'],
      },
    },
    {
      name: 'check_availability',
      description: 'Get the next available appointment slots. Call this whenever the customer asks "when can I come in", "what times are open", or "schedule me".',
      parameters: {
        type: 'object',
        properties: {
          service_id:     { type: 'string', description: 'The [id] of the service being booked, so slots match its length.' },
          preferred_date: { type: 'string', description: 'YYYY-MM-DD, only if the customer named a day ("tomorrow", "Friday"). Resolve it with the dates in the system prompt.' },
          time_of_day:    { type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Only if the customer said a part of the day.' },
          preferred_time: { type: 'string', description: 'HH:MM 24-hour, only if the customer named an exact time ("at 10" → 10:00). Use with preferred_date.' },
        },
        required: [],
      },
    },
    {
      name: 'get_business_hours',
      description: `Return ${bizName}'s hours of operation. Call this when customer asks "are you open", "what are your hours", "open on Saturday".`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_upsells',
      description: 'Return an upgrade or add-on recommendation for a selected service. Call after a customer picks a service to offer a relevant upsell.',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'string', description: 'The service the customer just selected.' } },
        required: ['product_id'],
      },
    },
    {
      name: 'get_recommendations',
      description: 'Return personalized service recommendations based on account tier and store credit.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results. Defaults to 3.' } },
        required: [],
      },
    },
    {
      name: 'book_appointment',
      description: `Book a ${isService ? 'service appointment' : 'service or order'} once the customer has chosen a service and one of the times check_availability returned. Ask for a shipping address only for physical items.`,
      parameters: {
        type: 'object',
        properties: {
          product_id:      { type: 'string' },
          payment_method:  { type: 'string', enum: ['CREDIT_CARD', 'DEBIT_CARD', 'STORE_CREDIT', 'INVOICE'], description: 'Defaults to CREDIT_CARD (paid at the shop).' },
          scheduled_at:    { type: 'string', description: 'The exact `datetime` of the chosen slot from check_availability, e.g. "2026-04-15T09:00:00".' },
          shipping_address: { type: 'object', description: 'Required only for physical items: { line1, city, state, zip }.' },
        },
        required: ['product_id'],
      },
    },
    {
      name: 'get_booking_status',
      description: 'Check the status of an existing booking or order.',
      parameters: {
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      },
    },
    {
      name: 'list_bookings',
      description: 'List the customer\'s recent bookings.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results. Defaults to 5.' } },
        required: [],
      },
    },
    {
      name: 'cancel_booking',
      description: 'Cancel a booking. Works on PENDING, ACCEPTED, and COMPLETE (confirmed) appointments — COMPLETE just means the booking is confirmed, not that the service has been performed. If you have the order_id use it. If not, pass product_name and the system will find it.',
      parameters: {
        type: 'object',
        properties: {
          order_id:     { type: 'string', description: 'The booking ID to cancel. Use if known.' },
          product_name: { type: 'string', description: 'Service name to cancel (e.g. "oil change"). Used when order_id is unknown.' },
        },
        required: [],
      },
    },
  ];
}
