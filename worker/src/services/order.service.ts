import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { orders as ordersTable } from '../db/schema';
import { getProductById } from './catalog.service';
import type { Sector, Order, Env } from '../types';

function mapRow(r: typeof ordersTable.$inferSelect): Order {
  return {
    id: r.id,
    customerIdHashed: r.customerIdHashed,
    businessType: r.businessType as Sector,
    productId: r.productId,
    productName: r.productName,
    vendorName: r.vendorName,
    status: r.status,
    priceCents: r.priceCents,
    paymentMethod: r.paymentMethod,
    trackingNumber: r.trackingNumber,
    scheduledAt: r.scheduledAt,
    calendarEventId: r.calendarEventId,
    calendarSync: r.calendarSync,
    customerName: r.customerName,
    vehicle: r.vehicle,
    callbackPhone: r.callbackPhone,
    notes: r.notes,
    resourceId: r.resourceId ?? null,
    resourceName: r.resourceName ?? null,
    endsAt: r.endsAt ?? null,
    details: r.details ?? null,
    createdAt: (r.createdAt as Date).toISOString(),
    updatedAt: (r.updatedAt as Date).toISOString(),
  };
}

// Accepts "YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]" — the shape the booking
// tools produce — and rejects anything else before it reaches the DB.
const SCHEDULED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

export function validateScheduledAt(scheduledAt: string, now = new Date()): string | null {
  if (!SCHEDULED_AT_RE.test(scheduledAt) || Number.isNaN(Date.parse(scheduledAt))) {
    return 'scheduled_at must be an ISO datetime like 2026-04-15T09:00:00';
  }
  // Compare on the calendar date only: stored times are business-local
  // wall-clock values without an offset, so sub-day comparisons against UTC
  // "now" would be wrong. Same-day bookings are still allowed.
  if (scheduledAt.slice(0, 10) < now.toISOString().slice(0, 10)) return 'scheduled_at is in the past';
  return null;
}

// What the front desk took down with the booking.
export interface BookingDetails {
  customerName?: string;
  vehicle?: string;
  callbackPhone?: string;
  notes?: string;
  /** Different customers' visits that may start at the same time. */
  capacity?: number;
  /**
   * Booked with a resource (a clinic's doctor): conflicts are any overlap
   * with that resource's other bookings, instead of `capacity`.
   */
  resource?: { id: string; name: string; endsAt: string };
  /** Vertical booking fields (patient age, reason…), stored as JSON. */
  details?: Record<string, string>;
  /** Overrides the product price (a doctor's consultation fee). */
  priceCents?: number;
}

const clip = (s: string | undefined, n: number) => (s?.trim() ? s.trim().slice(0, n) : null);

export async function placeOrder(
  env: Env,
  customerIdHashed: string,
  sector: Sector,
  productId: string,
  paymentMethod: string,
  shippingAddress?: { line1: string; city: string; state: string; zip: string },
  scheduledAt?: string,
  booking: BookingDetails = {},
): Promise<Order> {
  const product = await getProductById(env, productId);
  if (!product || !product.isActive) throw Object.assign(new Error('Product not found'), { code: 'NOT_FOUND' });
  if (product.businessType !== sector) throw Object.assign(new Error('Product not in sector'), { code: 'INVALID_SECTOR' });

  const needsShipping = ['PHYSICAL_PART', 'PHYSICAL_ACCESSORY'].includes(product.type);
  if (needsShipping && !shippingAddress) {
    throw Object.assign(new Error('Shipping address required'), { code: 'ADDRESS_REQUIRED' });
  }

  if (scheduledAt) {
    const problem = validateScheduledAt(scheduledAt);
    if (problem) throw Object.assign(new Error(problem), { code: 'INVALID_SCHEDULE' });
  }

  const db = getDb(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  const priceCents = booking.priceCents ?? product.priceCents;
  const details = booking.details && Object.keys(booking.details).length ? booking.details : null;

  const row = {
    id,
    customerIdHashed,
    businessType: sector,
    productId,
    productName: product.name,
    vendorName: product.vendorName,
    status: 'PENDING',
    priceCents,
    paymentMethod,
    trackingNumber: null,
    scheduledAt: scheduledAt ?? null,
    calendarEventId: null,
    calendarSync: null,
    customerName: clip(booking.customerName, 120),
    vehicle: clip(booking.vehicle, 120),
    callbackPhone: clip(booking.callbackPhone, 32),
    notes: clip(booking.notes, 500),
    resourceId: booking.resource?.id ?? null,
    resourceName: booking.resource?.name ?? null,
    endsAt: booking.resource?.endsAt ?? null,
    details,
    shippingLine1: shippingAddress?.line1,
    shippingCity: shippingAddress?.city,
    shippingState: shippingAddress?.state,
    shippingZip: shippingAddress?.zip,
    createdAt: now,
    updatedAt: now,
  };

  if (scheduledAt && booking.resource) {
    // Same single-statement guarantee as below, but the slot is the
    // resource's: it's taken when any of that doctor's bookings overlaps
    // [scheduledAt, endsAt). Times are business-local "YYYY-MM-DDTHH:MM…"
    // strings, so they compare lexically.
    const nowSec = Math.floor(now.getTime() / 1000);
    const { id: rid, name: rname, endsAt } = booking.resource;
    const result = await db.run(sql`
      INSERT INTO orders (
        id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status,
        price_cents, payment_method, tracking_number, scheduled_at,
        customer_name, vehicle, callback_phone, notes, resource_id, resource_name, ends_at, details,
        shipping_line1, shipping_city, shipping_state, shipping_zip, created_at, updated_at
      )
      SELECT ${id}, ${customerIdHashed}, ${sector}, ${productId}, ${product.vendorName}, ${product.name}, 'PENDING',
        ${priceCents}, ${paymentMethod}, NULL, ${scheduledAt},
        ${row.customerName}, ${row.vehicle}, ${row.callbackPhone}, ${row.notes}, ${rid}, ${rname}, ${endsAt},
        ${details ? JSON.stringify(details) : null},
        ${shippingAddress?.line1 ?? null}, ${shippingAddress?.city ?? null},
        ${shippingAddress?.state ?? null}, ${shippingAddress?.zip ?? null}, ${nowSec}, ${nowSec}
      WHERE NOT EXISTS (
        SELECT 1 FROM orders
        WHERE business_type = ${sector}
          AND status != 'CANCELLED'
          AND substr(scheduled_at, 1, 16) = substr(${scheduledAt}, 1, 16)
          AND customer_id_hashed = ${customerIdHashed}
          AND product_id = ${productId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM orders
        WHERE resource_id = ${rid}
          AND status != 'CANCELLED'
          AND substr(scheduled_at, 1, 16) < substr(${endsAt}, 1, 16)
          AND substr(coalesce(ends_at, scheduled_at), 1, 16) > substr(${scheduledAt}, 1, 16)
      )`);
    if (!result.meta.changes) {
      throw Object.assign(new Error('That time slot was just booked'), { code: 'SLOT_TAKEN' });
    }
  } else if (scheduledAt) {
    // Single-statement conditional insert: SQLite runs it atomically, so two
    // callers racing for the same slot can't both succeed (a SELECT-then-
    // INSERT would leave a window between the two). Slot identity matches
    // getBookedDatetimes(): business + minute-resolution start time. Up to
    // `capacity` different customers may start then (bays). The same
    // customer may stack different services on one start time — that's one
    // visit with several jobs ("add a tune-up to my oil change").
    const nowSec = Math.floor(now.getTime() / 1000);
    const capacity = Math.max(1, booking.capacity ?? 1);
    const result = await db.run(sql`
      INSERT INTO orders (
        id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status,
        price_cents, payment_method, tracking_number, scheduled_at,
        customer_name, vehicle, callback_phone, notes,
        shipping_line1, shipping_city, shipping_state, shipping_zip, created_at, updated_at
      )
      SELECT ${id}, ${customerIdHashed}, ${sector}, ${productId}, ${product.vendorName}, ${product.name}, 'PENDING',
        ${priceCents}, ${paymentMethod}, NULL, ${scheduledAt},
        ${row.customerName}, ${row.vehicle}, ${row.callbackPhone}, ${row.notes},
        ${shippingAddress?.line1 ?? null}, ${shippingAddress?.city ?? null},
        ${shippingAddress?.state ?? null}, ${shippingAddress?.zip ?? null}, ${nowSec}, ${nowSec}
      WHERE NOT EXISTS (
        SELECT 1 FROM orders
        WHERE business_type = ${sector}
          AND status != 'CANCELLED'
          AND substr(scheduled_at, 1, 16) = substr(${scheduledAt}, 1, 16)
          AND customer_id_hashed = ${customerIdHashed}
          AND product_id = ${productId}
      )
      AND (
        SELECT count(DISTINCT customer_id_hashed) FROM orders
        WHERE business_type = ${sector}
          AND status != 'CANCELLED'
          AND substr(scheduled_at, 1, 16) = substr(${scheduledAt}, 1, 16)
          AND customer_id_hashed != ${customerIdHashed}
      ) < ${capacity}`);
    if (!result.meta.changes) {
      throw Object.assign(new Error('That time slot was just booked'), { code: 'SLOT_TAKEN' });
    }
  } else {
    await db.insert(ordersTable).values(row);
  }

  // Order stays PENDING — real fulfillment (vendor webhook / admin confirmation) will advance status.
  // SERVICE_BOOKING appointments are confirmed via the admin dashboard or a webhook callback.
  // No read-back: every field of `Order` is already known from `row` above,
  // an insert of a fresh row can't have been concurrently modified, and the
  // read-back was a full extra D1 round trip on the hot booking path for no
  // new information.
  return mapRow(row as typeof ordersTable.$inferSelect);
}

export async function getOrders(env: Env, customerIdHashed: string, sector: Sector): Promise<Order[]> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.customerIdHashed, customerIdHashed), eq(ordersTable.businessType, sector)))
    .orderBy(desc(ordersTable.createdAt))
    .limit(20);
  return rows.map(mapRow);
}

export async function getOrder(env: Env, id: string, customerIdHashed: string): Promise<Order | null> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.id, id), eq(ordersTable.customerIdHashed, customerIdHashed)));
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Corrects the caller's details on an active booking; null if it isn't theirs or isn't active. */
export async function updateOrderDetails(
  env: Env, id: string, customerIdHashed: string,
  details: { customerName?: string; vehicle?: string; callbackPhone?: string; notes?: string; extra?: Record<string, string> },
): Promise<Order | null> {
  const set: Partial<typeof ordersTable.$inferInsert> = { updatedAt: new Date() };
  if (details.customerName) set.customerName = clip(details.customerName, 120);
  if (details.vehicle) set.vehicle = clip(details.vehicle, 120);
  if (details.callbackPhone) set.callbackPhone = clip(details.callbackPhone, 32);
  if (details.notes) set.notes = clip(details.notes, 500);
  // Vertical fields merge into what's there (patient age without losing the reason).
  if (details.extra && Object.keys(details.extra).length) {
    set.details = sql`json_patch(coalesce(${ordersTable.details}, '{}'), ${JSON.stringify(details.extra)})` as any;
  }
  const rows = await getDb(env.DB).update(ordersTable).set(set)
    .where(and(eq(ordersTable.id, id), eq(ordersTable.customerIdHashed, customerIdHashed),
      inArray(ordersTable.status, ['PENDING', 'ACCEPTED', 'COMPLETE'])))
    .returning();
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function cancelOrder(env: Env, id: string, customerIdHashed: string): Promise<Order> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.id, id), eq(ordersTable.customerIdHashed, customerIdHashed)));

  if (!rows[0]) throw Object.assign(new Error('Order not found'), { code: 'NOT_FOUND' });
  // COMPLETE for service bookings means "confirmed appointment" — still cancellable until the appointment date
  if (!['PENDING', 'ACCEPTED', 'COMPLETE'].includes(rows[0].status)) {
    throw Object.assign(new Error(`Cannot cancel a ${rows[0].status} order`), { code: 'INVALID_STATUS' });
  }

  await db.update(ordersTable)
    .set({ status: 'CANCELLED', updatedAt: new Date() })
    .where(eq(ordersTable.id, id));

  const updated = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  return mapRow(updated[0]);
}
