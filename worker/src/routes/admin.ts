import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { HonoEnv } from '../middleware';
import { withAdminKey } from '../middleware';
import { getSectors, getSector, upsertSector } from '../services/sector.service';
import { getDb } from '../db/client';
import { vendors as vendorsTable, products as productsTable } from '../db/schema';

const adminRouter = new Hono<HonoEnv>();

interface SectorConfig {
  storeName: string;
  greeting: string;
  agentName: string;
  primaryColor: string;
  supportEmail: string;
  maxRecommendations: number;
}

function defaultConfig(name: string, sector: string): SectorConfig {
  return {
    storeName: name,
    greeting: `Welcome to ${name}! How can I help you today?`,
    agentName: 'Avery',
    primaryColor: '#6c47ff',
    supportEmail: '',
    maxRecommendations: 3,
  };
}

const CONFIG_KEY = (sector: string) => `admin_config:${sector}`;

async function getConfig(env: HonoEnv['Bindings'], sector: string): Promise<SectorConfig> {
  const raw = await env.CACHE.get(CONFIG_KEY(sector));
  if (raw) return JSON.parse(raw) as SectorConfig;
  const meta = await getSector(env, sector);
  return defaultConfig(meta?.name ?? sector, sector);
}

async function putConfig(env: HonoEnv['Bindings'], sector: string, cfg: SectorConfig): Promise<void> {
  await env.CACHE.put(CONFIG_KEY(sector), JSON.stringify(cfg));
}

// ── Sector CRUD ────────────────────────────────────────────────────────────

// GET /admin/sectors — list all sectors from DB
adminRouter.get('/sectors', async (c) => {
  const sectors = await getSectors(c.env);
  return c.json({ success: true, data: Object.entries(sectors).map(([key, meta]) => ({ key, ...meta })) });
});

// POST /admin/sectors — create or update a sector (no deploy needed)
adminRouter.post('/sectors', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.key || !body?.name || !body?.hours) {
    return c.json({ success: false, error: 'key, name, and hours are required' }, 400);
  }
  await upsertSector(c.env, body.key, {
    name:         body.name,
    model:        body.model ?? 'service',
    categories:   body.categories ?? [],
    hours:        body.hours,
    timezone:     body.timezone ?? 'America/Chicago',
    currency:     body.currency ?? 'USD',
    address:      body.address,
    phone:        body.phone,
    website:      body.website,
  });
  return c.json({ success: true, data: { key: body.key, name: body.name } });
});

// GET /admin/sectors/:key — get one sector
adminRouter.get('/sectors/:key', async (c) => {
  const meta = await getSector(c.env, c.req.param('key'));
  if (!meta) return c.json({ success: false, error: 'Sector not found' }, 404);
  return c.json({ success: true, data: meta });
});

// ── UI Config ──────────────────────────────────────────────────────────────

adminRouter.get('/config/:sector', async (c) => {
  const { sector } = c.req.param();
  const meta = await getSector(c.env, sector);
  if (!meta) return c.json({ success: false, error: 'Unknown sector' }, 404);
  return c.json({ success: true, data: await getConfig(c.env, sector) });
});

adminRouter.put('/config/:sector', withAdminKey, async (c) => {
  const { sector } = c.req.param();
  const meta = await getSector(c.env, sector);
  if (!meta) return c.json({ success: false, error: 'Unknown sector' }, 404);
  const existing = await getConfig(c.env, sector);
  const body = await c.req.json().catch(() => ({}));
  const updated = { ...existing, ...body };
  await putConfig(c.env, sector, updated);
  return c.json({ success: true, data: updated });
});

// ── Vendor + Product bulk import (used by /add-vertical skill) ─────────────

// POST /admin/vendors  — upsert one or many vendors
adminRouter.post('/vendors', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const rows: any[] = Array.isArray(body) ? body : body ? [body] : [];
  if (!rows.length) return c.json({ success: false, error: 'Provide a vendor object or array' }, 400);

  const db = getDb(c.env.DB);
  const now = new Date();
  for (const v of rows) {
    if (!v.id || !v.name || !v.business_type) {
      return c.json({ success: false, error: `id, name, business_type required — got: ${JSON.stringify(v)}` }, 400);
    }
    await db.insert(vendorsTable).values({
      id: v.id, name: v.name, businessType: v.business_type,
      contactEmail: v.contact_email ?? 'info@example.com',
      apiBaseUrl: v.api_base_url ?? null,
      isActive: true, createdAt: now,
    }).onConflictDoUpdate({ target: vendorsTable.id, set: { name: v.name, businessType: v.business_type } });
  }
  return c.json({ success: true, data: { inserted: rows.length } });
});

// POST /admin/products  — upsert one or many products
adminRouter.post('/products', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const rows: any[] = Array.isArray(body) ? body : body ? [body] : [];
  if (!rows.length) return c.json({ success: false, error: 'Provide a product object or array' }, 400);

  const db = getDb(c.env.DB);
  const now = new Date();
  for (const p of rows) {
    if (!p.id || !p.business_type || !p.vendor_id || !p.name) {
      return c.json({ success: false, error: `id, business_type, vendor_id, name required — got: ${JSON.stringify(p)}` }, 400);
    }
    await db.insert(productsTable).values({
      id: p.id, businessType: p.business_type,
      vendorId: p.vendor_id, vendorName: p.vendor_name ?? p.vendor_id,
      name: p.name, category: p.category ?? 'GENERAL',
      type: p.type ?? 'SERVICE_APPOINTMENT',
      fulfillmentType: p.fulfillment_type ?? 'SERVICE_BOOKING',
      description: p.description ?? '',
      priceCents: p.price_cents ?? 0,
      originalPriceCents: p.original_price_cents ?? p.price_cents ?? 0,
      isActive: true,
      upsellProductId: p.upsell_product_id ?? null,
      durationMinutes: p.duration_minutes ?? null,
      createdAt: now,
    }).onConflictDoUpdate({
      target: productsTable.id,
      set: { name: p.name, priceCents: p.price_cents ?? 0, description: p.description ?? '' },
    });
    // Invalidate product cache
    await c.env.CACHE.delete(`products:${p.business_type}:all`);
  }
  return c.json({ success: true, data: { inserted: rows.length } });
});

// GET /admin/products/:businessType — list products for a sector
adminRouter.get('/products/:businessType', async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(productsTable)
    .where(eq(productsTable.businessType, c.req.param('businessType')));
  return c.json({ success: true, data: rows });
});

export { adminRouter };
export type { SectorConfig };
