import { eq, and, desc } from 'drizzle-orm';
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
    createdAt: (r.createdAt as Date).toISOString(),
    updatedAt: (r.updatedAt as Date).toISOString(),
  };
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

  const db = getDb(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();

  await db.insert(ordersTable).values({
    id,
    customerIdHashed,
    businessType: sector,
    productId,
    productName: product.name,
    vendorName: product.vendorName,
    status: 'PENDING',
    priceCents: product.priceCents,
    paymentMethod,
    scheduledAt: scheduledAt ?? null,
    shippingLine1: shippingAddress?.line1,
    shippingCity: shippingAddress?.city,
    shippingState: shippingAddress?.state,
    shippingZip: shippingAddress?.zip,
    createdAt: now,
    updatedAt: now,
  });

  // Simulate vendor acceptance / auto-confirm
  const newStatus = product.fulfillmentType === 'SERVICE_BOOKING' ? 'COMPLETE' : 'FULFILLING';
  const trackingNumber = product.fulfillmentType === 'VENDOR_SHIP'
    ? `TRK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    : null;

  await db.update(ordersTable)
    .set({ status: newStatus, trackingNumber, updatedAt: new Date() })
    .where(eq(ordersTable.id, id));

  const rows = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  return mapRow(rows[0]);
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
