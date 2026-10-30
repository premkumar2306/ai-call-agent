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

// Words that carry no signal about *which* service a caller wants.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'me', 'i', 'im', 'is', 'are', 'was', 'be', 'to', 'for', 'of', 'on', 'in', 'at', 'it',
  'and', 'or', 'do', 'does', 'you', 'your', 'have', 'has', 'need', 'needs', 'want', 'get', 'got', 'can',
  'could', 'would', 'like', 'some', 'any', 'how', 'much', 'what', 'whats', 'with', 'this', 'that', 'there',
  'please', 'about', 'service', 'services', 'car', 'vehicle', 'just', 'its', 'cost', 'price',
]);

// Caller phrasing → catalog vocabulary. Callers describe symptoms ("squeaky
// brakes", "AC blowing warm"); catalogs list services ("Brake Pad
// Replacement", "A/C Inspection & Recharge").
const SYNONYMS: Record<string, string[]> = {
  squeak: ['brake'], squeal: ['brake'], grind: ['brake'], pad: ['brake'], rotor: ['brake'],
  ac: ['a/c', 'air', 'recharge'], aircon: ['a/c'], heat: ['heating'], heater: ['heating'], cold: ['a/c'], warm: ['a/c'],
  light: ['diagnostic', 'warning'], warning: ['diagnostic'], engine: ['diagnostic', 'engine'], code: ['diagnostic'],
  pull: ['alignment'], pulling: ['alignment'], drift: ['alignment'], vibration: ['balancing', 'suspension'],
  bumpy: ['suspension'], shock: ['suspension'], strut: ['suspension'], clunk: ['suspension'],
  tire: ['tire'], tyre: ['tire'], flat: ['tire'], rotation: ['rotate'],
  checkup: ['inspection'], check: ['inspection'], inspect: ['inspection'], estimate: ['estimate', 'inspection'],
  quote: ['estimate'], general: ['inspection'], spark: ['tune'], plug: ['tune'], tuneup: ['tune'],
  fleet: ['fleet'], truck: ['fleet'], van: ['fleet'], battery: ['battery', 'electrical'],
  cleaning: ['cleaning'], teeth: ['dental', 'cleaning'], tooth: ['dental'], whiten: ['whitening'],
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/a\/c/g, 'ac').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Ranks products by how well they match a free-form caller query. Every
 * query word (after stopwords, with light stemming and symptom synonyms)
 * scores against the name (3), category (2) and description (1); the whole
 * query appearing verbatim scores a bonus. Products with no hit are dropped.
 */
export function searchProducts(products: Product[], query: string): Product[] {
  const q = query.toLowerCase().trim();
  if (!q) return products;
  const terms = new Set<string>();
  for (const t of tokens(q)) {
    if (STOPWORDS.has(t)) continue;
    const s = stem(t);
    terms.add(s);
    for (const syn of SYNONYMS[s] ?? SYNONYMS[t] ?? []) terms.add(stem(syn.replace('/', '')));
  }
  if (!terms.size) return [];

  const scored = products.map(p => {
    const name = new Set(tokens(p.name).map(stem));
    const cat = new Set(tokens(p.category).map(stem));
    const desc = new Set(tokens(p.description).map(stem));
    let score = 0;
    for (const t of terms) {
      if (name.has(t)) score += 3;
      else if (cat.has(t)) score += 2;
      else if (desc.has(t)) score += 1;
    }
    if (p.name.toLowerCase().includes(q)) score += 5;
    return { p, score };
  });
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.p);
}
