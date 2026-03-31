import { eq, and, asc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { products as productsTable } from '../db/schema';
import type { Sector, Product, Env } from '../types';

const TTL_SECONDS = 5 * 60; // 5 minutes

async function getCache<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.CACHE.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

async function setCache(env: Env, key: string, data: unknown): Promise<void> {
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: TTL_SECONDS });
}

function rowToProduct(r: typeof productsTable.$inferSelect): Product {
  return {
    id: r.id,
    businessType: r.businessType as Sector,
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    name: r.name,
    category: r.category,
    type: r.type,
    fulfillmentType: r.fulfillmentType,
    description: r.description,
    priceCents: r.priceCents,
    originalPriceCents: r.originalPriceCents,
    isActive: r.isActive,
    imageUrl: r.imageUrl ?? undefined,
  };
}

export async function getProducts(env: Env, sector: Sector, category?: string): Promise<Product[]> {
  const key = `products:${sector}:${category ?? 'all'}`;
  const cached = await getCache<Product[]>(env, key);
  if (cached) return cached;

  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(productsTable)
    .where(
      category
        ? and(eq(productsTable.businessType, sector), eq(productsTable.isActive, true), eq(productsTable.category, category))
        : and(eq(productsTable.businessType, sector), eq(productsTable.isActive, true))
    )
    .orderBy(asc(productsTable.priceCents));

  const result = rows.map(rowToProduct);
  await setCache(env, key, result);
  return result;
}

export async function getProductById(env: Env, id: string): Promise<Product | null> {
  const key = `product:${id}`;
  const cached = await getCache<Product>(env, key);
  if (cached) return cached;

  const db = getDb(env.DB);
  const rows = await db.select().from(productsTable).where(eq(productsTable.id, id));
  if (!rows[0]) return null;

  const product = rowToProduct(rows[0]);
  await setCache(env, key, product);
  return product;
}

export function searchProducts(products: Product[], query: string): Product[] {
  const q = query.toLowerCase();
  return products.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q)
  );
}
