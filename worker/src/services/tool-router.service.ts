import type { SessionPayload, Env, SectorMeta } from '../types';
import { getProducts, getProductById, searchProducts } from './catalog.service';
import { placeOrder, getOrders, getOrder, cancelOrder } from './order.service';
import { scoreProducts } from './recommendations.service';
import { isAmbiguousServiceIntent } from './voice-guard.service';

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
// Generates realistic open slots from today+1 through today+7.
// In production, replace with a real availability/calendar API call.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function parseHoursRange(range: string): { openH: number; closeH: number } | null {
  // e.g. "8am–7pm" or "7:30am–6pm"
  const m = range.match(/^(\d+)(?::(\d+))?(am|pm)[–-](\d+)(?::(\d+))?(am|pm)$/i);
  if (!m) return null;
  let openH = parseInt(m[1]);
  const openAP = m[3].toLowerCase();
  let closeH = parseInt(m[4]);
  const closeAP = m[6].toLowerCase();
  if (openAP === 'pm' && openH !== 12) openH += 12;
  if (openAP === 'am' && openH === 12) openH = 0;
  if (closeAP === 'pm' && closeH !== 12) closeH += 12;
  if (closeAP === 'am' && closeH === 12) closeH = 0;
  return { openH, closeH };
}

function getAvailableSlots(meta: SectorMeta | null | undefined, durationMinutes = 60): Array<{ date: string; time: string; datetime: string; label: string }> {
  const slots: Array<{ date: string; time: string; datetime: string; label: string }> = [];
  const now = new Date();
  // Step in whole hours; a 30-min appt still books on the hour
  const stepH = Math.max(1, Math.ceil(durationMinutes / 60));
  const durationH = durationMinutes / 60;

  for (let dayOffset = 1; dayOffset <= 14 && slots.length < 12; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    const dayKey = DAY_NAMES[d.getDay()];
    const hoursStr = meta?.hours[dayKey];
    if (!hoursStr) continue; // closed this day

    const parsed = parseHoursRange(hoursStr);
    if (!parsed) continue;

    // Only offer slots where appointment fits before closing
    for (let h = parsed.openH; h + durationH <= parsed.closeH; h += stepH) {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const timeLabel = `${h12}:00 ${ampm}`;
      const dateStr = d.toISOString().slice(0, 10);
      const hPad = String(h).padStart(2, '0');
      const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      slots.push({
        date: dateStr,
        time: timeLabel,
        datetime: `${dateStr}T${hPad}:00:00`,
        label: `${dateLabel} at ${timeLabel}`,
      });
    }
  }
  return slots;
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
  sectorMeta?: SectorMeta | null
): Promise<ToolResult> {
  const { businessType, account } = token;

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
        if (isAmbiguousServiceIntent(query)) {
          return {
            success: true,
            data: { products: [], matchType: 'ambiguous_intent', query },
            spoken_response: "I can help with a specific service, but I need to know what kind of work your car needs.",
          };
        }

        const all = await getProducts(env, businessType, args.category as string | undefined);
        const results = query ? searchProducts(all, query) : all;
        const top5 = results.slice(0, 5);
        if (top5.length === 0) {
          return {
            success: true,
            data: { products: [], matchType: 'no_match', query },
            spoken_response: "I couldn't match that to a listed service.",
          };
        }
        // Include IDs in data so Claude can use them immediately for check_availability / book_appointment
        const topResult = top5[0];
        const price = topResult.priceCents === 0 ? 'free' : `$${(topResult.priceCents / 100).toFixed(0)}`;
        const duration = topResult.durationMinutes ? `, about ${topResult.durationMinutes} minutes` : '';
        const spoken = top5.length === 1
          ? `I found ${topResult.name} for ${price}${duration}. Want me to check availability?`
          : `Top match: ${topResult.name} for ${price}. I also have ${top5.slice(1, 3).map(p => p.name).join(' and ')}. Which interests you?`;
        return {
          success: true,
          data: {
            products: top5.map(p => ({ id: p.id, name: p.name, priceCents: p.priceCents, durationMinutes: p.durationMinutes, category: p.category })),
            matchType: 'match',
            query,
          },
          spoken_response: spoken,
        };
      }

      case 'get_service_detail':
      case 'get_product_detail': {
        const p = await getProductById(env, args.product_id as string);
        if (!p) return { success: false, spoken_response: "I couldn't find that service." };
        const price = p.priceCents === 0 ? 'Free' : `$${(p.priceCents / 100).toFixed(0)}`;
        const duration = p.durationMinutes ? ` Takes about ${p.durationMinutes} minutes.` : '';
        return {
          success: true, data: p,
          spoken_response: `${p.name} — ${price}.${duration} ${p.description.slice(0, 120)}.`,
        };
      }

      // ── Scheduling ───────────────────────────────────────────────
      case 'check_availability': {
        const serviceId = args.service_id as string | undefined;
        let duration = 60;
        let serviceName = '';
        if (serviceId) {
          const p = await getProductById(env, serviceId);
          if (p?.durationMinutes) duration = p.durationMinutes;
          if (p?.name) serviceName = p.name;
        }
        const slots = getAvailableSlots(sectorMeta, duration);
        if (slots.length === 0) {
          return { success: true, data: { slots: [] }, spoken_response: "We don't have any openings in the next 2 weeks. Please call us directly." };
        }
        // Pick 3 slots spread across different days for a natural voice response
        const shown: typeof slots = [];
        const seenDays = new Set<string>();
        for (const s of slots) {
          if (!seenDays.has(s.date)) { seenDays.add(s.date); shown.push(s); }
          if (shown.length === 3) break;
        }
        const spokenFor = serviceName ? ` for ${serviceName}` : '';
        const spoken = `I have openings${spokenFor}: ${shown.map(s => s.label).join(', ')}. Which works for you?`;
        return { success: true, data: { slots: slots.slice(0, 12) }, spoken_response: spoken };
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
        const p = await getProductById(env, args.product_id as string);
        if (!p?.upsellProductId) {
          return { success: true, data: { upsells: [] }, spoken_response: "No add-ons available for that one." };
        }
        const upsell = await getProductById(env, p.upsellProductId);
        if (!upsell) return { success: true, data: { upsells: [] }, spoken_response: "No add-ons right now." };
        const price = upsell.priceCents === 0 ? 'Free' : `$${(upsell.priceCents / 100).toFixed(0)}`;
        return {
          success: true,
          data: { upsells: [upsell] },
          spoken_response: `Many customers also add ${upsell.name} for ${price}. Want to include that?`,
        };
      }

      case 'get_recommendations': {
        const all = await getProducts(env, businessType);
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
        const p = await getProductById(env, args.product_id as string);
        return {
          success: true, data: { cart },
          spoken_response: `Added ${p?.name ?? 'item'} to your cart. Ready to confirm?`,
        };
      }

      // ── Booking / Order ───────────────────────────────────────────
      case 'book_appointment':
      case 'place_order': {
        const order = await placeOrder(
          env,
          token.sub,
          businessType,
          args.product_id as string,
          args.payment_method as string,
          args.shipping_address as any,
          args.scheduled_at as string | undefined
        );
        // Clear from cart
        const key = cartKey(token);
        const cart = await getCart(env, key);
        await setCart(env, key, cart.filter(i => i.productId !== args.product_id));

        const scheduledPart = order.scheduledAt
          ? ` Your appointment is confirmed for ${new Date(order.scheduledAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`
          : '';
        const msg = order.status === 'COMPLETE'
          ? `Done!${scheduledPart} ${order.productName} is confirmed. Reference: ${order.id.slice(0, 8)}.`
          : `Booked!${scheduledPart} ${order.productName}. Reference: ${order.id.slice(0, 8)}.`;
        return { success: true, data: order, spoken_response: msg };
      }

      // ── Booking management ────────────────────────────────────────
      case 'get_booking_status':
      case 'get_order_status': {
        const order = await getOrder(env, args.order_id as string, token.sub);
        if (!order) return { success: false, spoken_response: "I couldn't find that booking." };
        const scheduled = order.scheduledAt
          ? ` Scheduled for ${new Date(order.scheduledAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`
          : '';
        let spoken = `Booking ${order.id.slice(0, 8)} — ${order.productName} is ${order.status}.${scheduled}`;
        if (order.trackingNumber) spoken += ` Tracking: ${order.trackingNumber}.`;
        return { success: true, data: order, spoken_response: spoken };
      }

      case 'list_bookings':
      case 'list_orders': {
        const orders = await getOrders(env, token.sub, businessType);
        if (orders.length === 0) {
          return { success: true, data: { orders: [] }, spoken_response: "You don't have any bookings yet." };
        }
        const spoken = `You have ${orders.length} booking${orders.length > 1 ? 's' : ''}: ${orders.slice(0, 3).map(o => `${o.productName} (${o.status})`).join(', ')}.`;
        return { success: true, data: { orders }, spoken_response: spoken };
      }

      case 'cancel_booking':
      case 'cancel_order': {
        let orderId = args.order_id as string | undefined;
        // If no order_id, find the most recent matching booking by product name
        if (!orderId && args.product_name) {
          const recent = await getOrders(env, token.sub, businessType);
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
        return { success: true, data: order, spoken_response: `Done — your ${order.productName} appointment has been cancelled.` };
      }

      default:
        return { success: false, spoken_response: `Unknown tool: ${toolName}`, error: 'UNKNOWN_TOOL' };
    }
  } catch (err: any) {
    return { success: false, spoken_response: `Sorry, something went wrong: ${err.message}`, error: err.code ?? 'ERROR' };
  }
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
          service_id:     { type: 'string', description: 'Optional: service ID to match slot length to appointment duration.' },
          preferred_date: { type: 'string', description: 'Optional ISO date the customer prefers, e.g. "2026-04-15".' },
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
      description: `Book a ${isService ? 'service appointment' : 'service or order'}. Always confirm the service name, price, and time before calling. Ask for a shipping address only for physical items.`,
      parameters: {
        type: 'object',
        properties: {
          product_id:      { type: 'string' },
          payment_method:  { type: 'string', enum: ['CREDIT_CARD', 'DEBIT_CARD', 'STORE_CREDIT', 'INVOICE'] },
          scheduled_at:    { type: 'string', description: 'ISO datetime for the appointment, e.g. "2026-04-15T09:00:00". Required for SERVICE_BOOKING.' },
          shipping_address: { type: 'object', description: 'Required only for physical items: { line1, city, state, zip }.' },
        },
        required: ['product_id', 'payment_method'],
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
