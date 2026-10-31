import { eq, and, desc, sql } from 'drizzle-orm';
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

export async function placeOrder(
  env: Env,
  customerIdHashed: string,
  sector: Sector,
  productId: string,
  paymentMethod: string,
  shippingAddress?: { line1: string; city: string; state: string; zip: string },
  scheduledAt?: string
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

  const row = {
    id,
    customerIdHashed,
    businessType: sector,
    productId,
    productName: product.name,
    vendorName: product.vendorName,
    status: 'PENDING',
    priceCents: product.priceCents,
    paymentMethod,
    trackingNumber: null,
    scheduledAt: scheduledAt ?? null,
    calendarEventId: null,
    calendarSync: null,
    shippingLine1: shippingAddress?.line1,
    shippingCity: shippingAddress?.city,
    shippingState: shippingAddress?.state,
    shippingZip: shippingAddress?.zip,
    createdAt: now,
    updatedAt: now,
  };

  if (scheduledAt) {
    // Single-statement conditional insert: SQLite runs it atomically, so two
    // callers racing for the same slot can't both succeed (a SELECT-then-
    // INSERT would leave a window between the two). Slot identity matches
    // getBookedDatetimes(): business + minute-resolution start time. The
    // same customer may stack different services on one start time — that's
    // one visit with several jobs ("add a tune-up to my oil change").
    const nowSec = Math.floor(now.getTime() / 1000);
    const result = await db.run(sql`
      INSERT INTO orders (
        id, customer_id_hashed, business_type, product_id, vendor_name, product_name, status,
        price_cents, payment_method, tracking_number, scheduled_at,
        shipping_line1, shipping_city, shipping_state, shipping_zip, created_at, updated_at
      )
      SELECT ${id}, ${customerIdHashed}, ${sector}, ${productId}, ${product.vendorName}, ${product.name}, 'PENDING',
        ${product.priceCents}, ${paymentMethod}, NULL, ${scheduledAt},
        ${shippingAddress?.line1 ?? null}, ${shippingAddress?.city ?? null},
        ${shippingAddress?.state ?? null}, ${shippingAddress?.zip ?? null}, ${nowSec}, ${nowSec}
      WHERE NOT EXISTS (
        SELECT 1 FROM orders
        WHERE business_type = ${sector}
          AND status != 'CANCELLED'
          AND substr(scheduled_at, 1, 16) = substr(${scheduledAt}, 1, 16)
          AND (customer_id_hashed != ${customerIdHashed} OR product_id = ${productId})
      )`);
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
