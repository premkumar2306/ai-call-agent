import { Hono } from 'hono';
import { eq, and, desc, ne } from 'drizzle-orm';
import type { HonoEnv } from '../middleware';
import { withAdminKey, withBusinessAccess } from '../middleware';
import { getSectors, getSector, upsertSector, updateSector, invalidateSectors, updateSectorVoice } from '../services/sector.service';
import { parseAssistantName, parseBusinessPatch, parseService, serviceProductId } from '../services/accounts';
import { assistantNameOf, isVertical } from '../services/verticals';
import {
  createResource, deleteWhatsAppNumber, isPhoneNumberId, listNumberRequests, listResources, listWhatsAppNumbers,
  MAX_RESOURCES, parseResourceInput, resourceRowToInput, setNumberRequestStatus, updateResource, upsertWhatsAppNumber,
} from '../services/self-serve';
import { parseHoursRanges } from '../services/tool-router.service';
import { parseVoiceInput, resolveVoiceSettings } from '../services/voice-language';
import { getDb } from '../db/client';
import { getDefaultBusiness, setDefaultBusiness } from '../services/line-config';
import { signStreamToken } from '../utils/stream-token';
import { COUNTRIES, isValidCountryCode, isValidCurrency, isValidLocale, isValidTimeZone } from '../utils/locale';
import { removeBookingFromCalendar } from '../services/calendar';
import { deletePhoneNumber, listPhoneNumbers, normalizeE164, PROVIDER_COUNTRY, upsertPhoneNumber } from '../services/phone-numbers';
import { isTelephonyProvider, TELEPHONY_PROVIDERS } from '../telephony/types';
import { vendors as vendorsTable, products as productsTable, transcripts as transcriptsTable, orders as ordersTable, callMessages, resources as resourcesTable } from '../db/schema';

const adminRouter = new Hono<HonoEnv>();

interface SectorConfig {
  storeName: string;
  greeting: string;
  agentName: string;
  primaryColor: string;
  supportEmail: string;
  maxRecommendations: number;
}

function defaultConfig(name: string, agentName: string): SectorConfig {
  return {
    storeName: name,
    greeting: `Welcome to ${name}! How can I help you today?`,
    agentName,
    primaryColor: '#6c47ff',
    supportEmail: '',
    maxRecommendations: 3,
  };
}

const CONFIG_KEY = (sector: string) => `admin_config:${sector}`;

async function getConfig(env: HonoEnv['Bindings'], sector: string): Promise<SectorConfig> {
  // The assistant's name lives on the business (sectors.assistant_name), so
  // the greeting and the call prompt always say the same name.
  const meta = await getSector(env, sector);
  const agentName = assistantNameOf(meta);
  const raw = await env.CACHE.get(CONFIG_KEY(sector));
  if (raw) return { ...(JSON.parse(raw) as SectorConfig), agentName };
  return defaultConfig(meta?.name ?? sector, agentName);
}

async function putConfig(env: HonoEnv['Bindings'], sector: string, cfg: SectorConfig): Promise<void> {
  await env.CACHE.put(CONFIG_KEY(sector), JSON.stringify(cfg));
}

// ── Sector CRUD ────────────────────────────────────────────────────────────

// GET /admin/default-business — which business answers the phone line
adminRouter.get('/default-business', withAdminKey, async (c) => {
  const selected = await getDefaultBusiness(c.env);
  return c.json({
    success: true,
    data: {
      selected,
      effective: selected ?? c.env.TWILIO_DEFAULT_BUSINESS_TYPE ?? null,
      envDefault: c.env.TWILIO_DEFAULT_BUSINESS_TYPE ?? null,
    },
  });
});

// PUT /admin/default-business { businessType: string | null } — null reverts to the env default
adminRouter.put('/default-business', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const businessType = body?.businessType;
  if (businessType !== null && typeof businessType !== 'string') {
    return c.json({ success: false, error: 'businessType must be a sector key or null' }, 400);
  }
  if (businessType && !(await getSector(c.env, businessType))) {
    return c.json({ success: false, error: `Unknown business: ${businessType}` }, 404);
  }
  await setDefaultBusiness(c.env, businessType || null);
  return c.json({ success: true, data: { selected: businessType || null } });
});

// ── Phone numbers → business (phone_numbers, migration 0013) ─────────────────

// GET /admin/phone-numbers — every mapped number
adminRouter.get('/phone-numbers', withAdminKey, async (c) => {
  return c.json({ success: true, data: await listPhoneNumbers(c.env) });
});

// PUT /admin/phone-numbers { number, provider, businessType, label? } — map (or remap) a number
adminRouter.put('/phone-numbers', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const provider = body?.provider;
  if (!isTelephonyProvider(provider)) {
    return c.json({ success: false, error: `provider must be one of ${TELEPHONY_PROVIDERS.join(', ')}` }, 400);
  }
  const number = normalizeE164(typeof body?.number === 'string' ? body.number : null, PROVIDER_COUNTRY[provider]);
  if (!number) return c.json({ success: false, error: 'number must be a phone number, e.g. +918047123456' }, 400);
  const businessType = body?.businessType;
  if (typeof businessType !== 'string' || !(await getSector(c.env, businessType))) {
    return c.json({ success: false, error: `Unknown business: ${businessType}` }, 404);
  }
  const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  await upsertPhoneNumber(c.env, { number, provider, businessType, label });
  return c.json({ success: true, data: { number, provider, businessType, label } });
});

// DELETE /admin/phone-numbers/:provider/:number — unmap (number URL-encoded, e.g. %2B9180…)
adminRouter.delete('/phone-numbers/:provider/:number', withAdminKey, async (c) => {
  const provider = c.req.param('provider');
  if (!isTelephonyProvider(provider)) return c.json({ success: false, error: 'Unknown provider' }, 400);
  const number = normalizeE164(decodeURIComponent(c.req.param('number') ?? ''), PROVIDER_COUNTRY[provider]);
  if (!number || !(await deletePhoneNumber(c.env, provider, number))) {
    return c.json({ success: false, error: 'Number not mapped' }, 404);
  }
  return c.json({ success: true, data: { number, provider } });
});

// GET /admin/sectors — list all sectors from DB
adminRouter.get('/sectors', withAdminKey, async (c) => {
  const sectors = await getSectors(c.env);
  return c.json({ success: true, data: Object.entries(sectors).map(([key, meta]) => ({ key, ...meta })) });
});

// POST /admin/sectors — create or update a sector (no deploy needed)
adminRouter.post('/sectors', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.key || !body?.name || !body?.hours) {
    return c.json({ success: false, error: 'key, name, and hours are required' }, 400);
  }
  // Locale fields are optional; when given they must be valid, so a typo
  // can't silently break price or date formatting on live calls.
  const invalid = [
    body.currency !== undefined && !isValidCurrency(body.currency) && 'currency (ISO 4217, e.g. "INR")',
    body.locale !== undefined && !isValidLocale(body.locale) && 'locale (BCP 47, e.g. "en-IN")',
    body.country_code !== undefined && !isValidCountryCode(body.country_code) && `country_code (one of ${Object.keys(COUNTRIES).join(', ')})`,
    body.timezone !== undefined && !isValidTimeZone(body.timezone) && 'timezone (IANA, e.g. "Asia/Kolkata")',
  ].filter(Boolean);
  if (invalid.length) return c.json({ success: false, error: `Invalid ${invalid.join(', ')}` }, 400);
  if (body.vertical != null && !isVertical(body.vertical)) {
    return c.json({ success: false, error: `Unknown vertical: ${body.vertical}` }, 400);
  }
  // Optional voice settings: voice_language, stt_provider, tts_provider, voice_id.
  const voice = parseVoiceInput(body, resolveVoiceSettings(await getSector(c.env, body.key)), !!c.env.SARVAM_API_KEY);
  if (!voice.ok) return c.json({ success: false, error: voice.error }, 400);
  await upsertSector(c.env, body.key, {
    name:         body.name,
    model:        body.model ?? 'service',
    categories:   body.categories ?? [],
    hours:        body.hours,
    timezone:     body.timezone ?? 'America/Chicago',
    currency:     body.currency,
    locale:       body.locale,
    countryCode:  body.country_code,
    address:      body.address,
    phone:        body.phone,
    website:      body.website,
    about:        typeof body.about === 'string' ? body.about.slice(0, 4000) : undefined,
    notifyEmail:  typeof body.notify_email === 'string' && /^[^\s@]+@[^\s@]+$/.test(body.notify_email) ? body.notify_email : undefined,
    capacity:     Number.isInteger(body.capacity) && body.capacity >= 1 && body.capacity <= 50 ? body.capacity : undefined,
    // Omitted = keep; null = back to general.
    vertical:     body.vertical === null ? null : body.vertical ?? undefined,
    voice:        voice.value,
  });
  return c.json({ success: true, data: { key: body.key, name: body.name } });
});

// GET /admin/sectors/:key/voice — phone-line language + STT/TTS providers
adminRouter.get('/sectors/:key/voice', withBusinessAccess('staff', 'key'), async (c) => {
  const meta = await getSector(c.env, c.req.param('key') ?? '');
  if (!meta) return c.json({ success: false, error: 'Sector not found' }, 404);
  return c.json({ success: true, data: { ...resolveVoiceSettings(meta), sarvamConfigured: !!c.env.SARVAM_API_KEY } });
});

// PUT /admin/sectors/:key/voice { voice_language?, stt_provider?, tts_provider?, voice_id? }
// Changes only the voice settings (POST /admin/sectors replaces the whole sector).
adminRouter.put('/sectors/:key/voice', withBusinessAccess('owner', 'key'), async (c) => {
  const key = c.req.param('key') ?? '';
  const meta = await getSector(c.env, key);
  if (!meta) return c.json({ success: false, error: 'Sector not found' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ success: false, error: 'JSON body required' }, 400);
  const current = resolveVoiceSettings(meta);
  const voice = parseVoiceInput(body, current, !!c.env.SARVAM_API_KEY);
  if (!voice.ok) return c.json({ success: false, error: voice.error }, 400);
  await updateSectorVoice(c.env, key, voice.value);
  const updated = { ...current, ...voice.value };
  if ('voiceId' in voice.value && !voice.value.voiceId) delete updated.voiceId;
  return c.json({ success: true, data: updated });
});

// GET /admin/sectors/:key — get one sector
adminRouter.get('/sectors/:key', withBusinessAccess('staff', 'key'), async (c) => {
  const key = c.req.param('key') ?? '';
  const meta = await getSector(c.env, key);
  if (!meta) return c.json({ success: false, error: 'Sector not found' }, 404);
  return c.json({ success: true, data: meta });
});

// PUT /admin/sectors/:key — the owner's Business tab: change details, hours, staff line…
// Only the fields sent are changed (see parseBusinessPatch).
adminRouter.put('/sectors/:key', withBusinessAccess('owner', 'key'), async (c) => {
  const patch = parseBusinessPatch(await c.req.json().catch(() => null));
  if (typeof patch === 'string') return c.json({ success: false, error: patch }, 400);
  const key = c.req.param('key') ?? '';
  if (!(await updateSector(c.env, key, patch))) return c.json({ success: false, error: 'Sector not found' }, 404);
  return c.json({ success: true, data: await getSector(c.env, key) });
});

// ── UI Config ──────────────────────────────────────────────────────────────

adminRouter.get('/config/:sector', withBusinessAccess('staff', 'sector'), async (c) => {
  const { sector } = c.req.param();
  const meta = await getSector(c.env, sector);
  if (!meta) return c.json({ success: false, error: 'Unknown sector' }, 404);
  return c.json({ success: true, data: await getConfig(c.env, sector) });
});

adminRouter.put('/config/:sector', withBusinessAccess('owner', 'sector'), async (c) => {
  const { sector } = c.req.param();
  const meta = await getSector(c.env, sector);
  if (!meta) return c.json({ success: false, error: 'Unknown sector' }, 404);
  const existing = await getConfig(c.env, sector);
  const body = await c.req.json().catch(() => ({}));
  // Only merge known keys with matching types — the stored blob is read back
  // by the UI, so arbitrary keys/types would persist garbage.
  const updated: SectorConfig = { ...existing };
  for (const key of Object.keys(existing) as (keyof SectorConfig)[]) {
    if (body && typeof body[key] === typeof existing[key]) (updated as any)[key] = body[key];
  }
  if (updated.agentName !== existing.agentName) {
    const name = parseAssistantName(updated.agentName);
    if (name === undefined) return c.json({ success: false, error: 'Assistant name must be 2–30 letters' }, 400);
    await updateSector(c.env, sector, { assistantName: name });
    updated.agentName = name ?? assistantNameOf(null);
  }
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
    // Invalidate product caches (list + single-product lookup)
    await Promise.all([
      c.env.CACHE.delete(`products:${p.business_type}:all`),
      c.env.CACHE.delete(`product:${p.id}`),
    ]);
  }
  return c.json({ success: true, data: { inserted: rows.length } });
});

// POST /admin/resources — upsert one or many bookable people (a clinic's doctors)
// { id, business_type, name, role?, hours: { mon: "10am–1pm, 5pm–9pm" }, slot_minutes?, fee_cents?, about?,
//   categories?: ["DENTAL"] (product categories they do; omit = all), sort_order?, is_active? }
adminRouter.post('/resources', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const rows: any[] = Array.isArray(body) ? body : body ? [body] : [];
  if (!rows.length) return c.json({ success: false, error: 'Provide a resource object or array' }, 400);
  for (const r of rows) {
    if (!r?.id || !r.business_type || !r.name || !r.hours || typeof r.hours !== 'object') {
      return c.json({ success: false, error: `id, business_type, name, hours required — got: ${JSON.stringify(r)}` }, 400);
    }
    const bad = Object.entries(r.hours).find(([, v]) => typeof v !== 'string' || !parseHoursRanges(v).length);
    if (bad) return c.json({ success: false, error: `Unreadable hours for ${r.id}.${bad[0]}: ${JSON.stringify(bad[1])} (use e.g. "10am–1pm, 5pm–9pm")` }, 400);
    if (r.slot_minutes != null && !(Number.isInteger(r.slot_minutes) && r.slot_minutes >= 5 && r.slot_minutes <= 240)) {
      return c.json({ success: false, error: `slot_minutes must be 5–240 for ${r.id}` }, 400);
    }
  }
  const db = getDb(c.env.DB);
  const now = new Date();
  for (const r of rows) {
    const values = {
      businessType: r.business_type,
      name: String(r.name).slice(0, 120),
      role: typeof r.role === 'string' ? r.role.slice(0, 120) : null,
      hours: r.hours,
      slotMinutes: r.slot_minutes ?? 15,
      feeCents: Number.isInteger(r.fee_cents) && r.fee_cents >= 0 ? r.fee_cents : null,
      about: typeof r.about === 'string' ? r.about.slice(0, 1000) : null,
      categories: Array.isArray(r.categories) && r.categories.every((x: unknown) => typeof x === 'string') && r.categories.length ? r.categories : null,
      sortOrder: Number.isInteger(r.sort_order) ? r.sort_order : 0,
      isActive: r.is_active !== false,
    };
    await db.insert(resourcesTable).values({ id: r.id, ...values, createdAt: now })
      .onConflictDoUpdate({ target: resourcesTable.id, set: values });
  }
  await invalidateSectors(c.env);
  return c.json({ success: true, data: { upserted: rows.length } });
});

// GET /admin/resources/:businessType — a business's bookable people, inactive included
adminRouter.get('/resources/:businessType', withBusinessAccess('staff'), async (c) => {
  return c.json({ success: true, data: await listResources(c.env, c.req.param('businessType') ?? '') });
});

// ── Practitioners, scoped to one business (owner's Doctors / Lawyers tab) ──
// Ids are generated and every update is matched on (id, business), so one
// business can never change another's people.

// POST /admin/resources/:businessType { name, role?, hours, slotMinutes?, feeCents?, about?, categories? }
adminRouter.post('/resources/:businessType', withBusinessAccess('owner'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: 'Unknown business' }, 404);
  const input = parseResourceInput(await c.req.json().catch(() => null));
  if (typeof input === 'string') return c.json({ success: false, error: input }, 400);
  const row = await createResource(c.env, businessType, input);
  if (!row) return c.json({ success: false, error: `A business can have up to ${MAX_RESOURCES} people` }, 403);
  return c.json({ success: true, data: row }, 201);
});

// PUT /admin/resources/:businessType/:id — change any of the fields above, or isActive
adminRouter.put('/resources/:businessType/:id', withBusinessAccess('owner'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  const id = c.req.param('id') ?? '';
  const [existing] = await getDb(c.env.DB).select().from(resourcesTable)
    .where(and(eq(resourcesTable.id, id), eq(resourcesTable.businessType, businessType))).limit(1);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const input = parseResourceInput(await c.req.json().catch(() => null), resourceRowToInput(existing));
  if (typeof input === 'string') return c.json({ success: false, error: input }, 400);
  return c.json({ success: true, data: await updateResource(c.env, businessType, id, input) });
});

// DELETE /admin/resources/:businessType/:id — deactivates (bookings keep referring to them)
adminRouter.delete('/resources/:businessType/:id', withBusinessAccess('owner'), async (c) => {
  const row = await updateResource(c.env, c.req.param('businessType') ?? '', c.req.param('id') ?? '', { isActive: false });
  if (!row) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true });
});

// ── WhatsApp numbers → business (whatsapp_numbers, migration 0018) ─────────

adminRouter.get('/whatsapp-numbers', withAdminKey, async (c) => {
  return c.json({ success: true, data: await listWhatsAppNumbers(c.env) });
});

// GET /admin/whatsapp-status — which WhatsApp settings are present on this
// deployment (operator only). Booleans only: never the values.
adminRouter.get('/whatsapp-status', withAdminKey, (c) => {
  const env = c.env;
  return c.json({
    success: true,
    data: {
      appSecret: !!env.WA_APP_SECRET,
      verifyToken: !!env.WA_VERIFY_TOKEN,
      accessToken: !!env.WA_ACCESS_TOKEN,
      phoneNumberMap: !!env.WA_PHONE_NUMBER_MAP,
      webhookPath: '/whatsapp/webhook',
    },
  });
});

// PUT /admin/whatsapp-numbers { phoneNumberId, businessType, label? }
adminRouter.put('/whatsapp-numbers', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isPhoneNumberId(body?.phoneNumberId)) return c.json({ success: false, error: 'phoneNumberId must be the numeric id from Meta' }, 400);
  if (typeof body.businessType !== 'string' || !(await getSector(c.env, body.businessType))) {
    return c.json({ success: false, error: `Unknown business: ${body?.businessType}` }, 404);
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  await upsertWhatsAppNumber(c.env, body.phoneNumberId, body.businessType, label);
  return c.json({ success: true, data: { phoneNumberId: body.phoneNumberId, businessType: body.businessType, label } });
});

adminRouter.delete('/whatsapp-numbers/:id', withAdminKey, async (c) => {
  if (!(await deleteWhatsAppNumber(c.env, c.req.param('id') ?? ''))) return c.json({ success: false, error: 'Not mapped' }, 404);
  return c.json({ success: true });
});

// ── Phone-number requests from owners (number_requests, migration 0018) ────

adminRouter.get('/number-requests', withAdminKey, async (c) => {
  return c.json({ success: true, data: await listNumberRequests(c.env) });
});

// PATCH /admin/number-requests/:id { status: 'open' | 'done' }
adminRouter.patch('/number-requests/:id', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const status = body?.status === 'done' ? 'done' : body?.status === 'open' ? 'open' : null;
  if (!status) return c.json({ success: false, error: 'status must be open or done' }, 400);
  if (!(await setNumberRequestStatus(c.env, c.req.param('id') ?? '', status))) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true });
});

// GET /admin/products/:businessType — list products for a sector
adminRouter.get('/products/:businessType', withBusinessAccess('staff'), async (c) => {
  const db = getDb(c.env.DB);
  const businessType = c.req.param('businessType') ?? '';
  const rows = await db.select().from(productsTable)
    .where(eq(productsTable.businessType, businessType));
  return c.json({ success: true, data: rows });
});

// ── Services, scoped to one business (owner's Services tab) ───────────────
// Unlike POST /admin/products (operator bulk import), ids are generated here
// and every update is matched on (id, business), so one business can never
// overwrite another's catalog.

async function invalidateProduct(env: HonoEnv['Bindings'], businessType: string, id: string, category: string) {
  await Promise.all([
    env.CACHE.delete(`products:${businessType}:all`),
    env.CACHE.delete(`products:${businessType}:${category}`),
    env.CACHE.delete(`product:${id}`),
  ]);
}

// POST /admin/products/:businessType { name, priceCents, durationMinutes, description? }
adminRouter.post('/products/:businessType', withBusinessAccess('owner'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  const meta = await getSector(c.env, businessType);
  if (!meta) return c.json({ success: false, error: 'Unknown business' }, 404);
  const svc = parseService(await c.req.json().catch(() => null));
  if (typeof svc === 'string') return c.json({ success: false, error: svc }, 400);

  const db = getDb(c.env.DB);
  if ((await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.businessType, businessType))).length >= 200) {
    return c.json({ success: false, error: 'A business can have up to 200 services' }, 403);
  }
  // Businesses from the wizard have a vendor with their own key; older ones
  // have whatever vendor the seed gave them.
  let [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.businessType, businessType)).limit(1);
  if (!vendor) {
    [vendor] = await db.insert(vendorsTable).values({
      id: serviceProductId(businessType).replace('-svc-', '-vendor-'), name: meta.name, businessType,
      contactEmail: meta.notifyEmail ?? 'info@example.com', isActive: true, createdAt: new Date(),
    }).returning();
  }
  const category = svc.category ?? (meta.categories.includes('SERVICES') || !meta.categories.length ? 'SERVICES' : meta.categories[0]);
  const [row] = await db.insert(productsTable).values({
    id: serviceProductId(businessType), businessType, vendorId: vendor.id, vendorName: vendor.name,
    name: svc.name, category, type: 'SERVICE_APPOINTMENT', fulfillmentType: 'SERVICE_BOOKING',
    description: svc.description, priceCents: svc.priceCents, originalPriceCents: svc.priceCents,
    durationMinutes: svc.durationMinutes, isActive: true, createdAt: new Date(),
  }).returning();
  await invalidateProduct(c.env, businessType, row.id, category);
  return c.json({ success: true, data: row }, 201);
});

// PUT /admin/products/:businessType/:id { name?, priceCents?, durationMinutes?, description?, isActive? }
adminRouter.put('/products/:businessType/:id', withBusinessAccess('owner'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  const id = c.req.param('id') ?? '';
  const db = getDb(c.env.DB);
  const [existing] = await db.select().from(productsTable)
    .where(and(eq(productsTable.id, id), eq(productsTable.businessType, businessType))).limit(1);
  if (!existing) return c.json({ success: false, error: 'Service not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const svc = parseService({
    name: body?.name ?? existing.name,
    priceCents: body?.priceCents ?? existing.priceCents,
    durationMinutes: body?.durationMinutes ?? existing.durationMinutes ?? 60,
    description: body?.description ?? existing.description,
    // Only when sent, so saving an older service never renames its category.
    ...(body?.category !== undefined ? { category: body.category } : {}),
  });
  if (typeof svc === 'string') return c.json({ success: false, error: svc }, 400);
  const priceChanged = svc.priceCents !== existing.priceCents;
  const [row] = await db.update(productsTable).set({
    name: svc.name, description: svc.description, durationMinutes: svc.durationMinutes,
    ...(svc.category && svc.category !== existing.category ? { category: svc.category } : {}),
    ...(priceChanged ? { priceCents: svc.priceCents, originalPriceCents: svc.priceCents } : {}),
    ...(typeof body?.isActive === 'boolean' ? { isActive: body.isActive } : {}),
  }).where(and(eq(productsTable.id, id), eq(productsTable.businessType, businessType))).returning();
  await invalidateProduct(c.env, businessType, id, existing.category);
  if (row.category !== existing.category) await invalidateProduct(c.env, businessType, id, row.category);
  return c.json({ success: true, data: row });
});

// DELETE /admin/products/:businessType/:id — hides the service (bookings keep referring to it)
adminRouter.delete('/products/:businessType/:id', withBusinessAccess('owner'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  const id = c.req.param('id') ?? '';
  const rows = await getDb(c.env.DB).update(productsTable).set({ isActive: false })
    .where(and(eq(productsTable.id, id), eq(productsTable.businessType, businessType)))
    .returning({ category: productsTable.category });
  if (!rows.length) return c.json({ success: false, error: 'Service not found' }, 404);
  await invalidateProduct(c.env, businessType, id, rows[0].category);
  return c.json({ success: true });
});

// GET /admin/transcripts/:businessType — list recent transcripts for a sector
// Optional query param: ?channel=wa (filter by callSid starting with 'wa:')
adminRouter.get('/transcripts/:businessType', withBusinessAccess('staff'), async (c) => {
  const businessType = c.req.param('businessType') ?? '';
  const channel = c.req.query('channel');
  const db = getDb(c.env.DB);

  let rows = await db
    .select()
    .from(transcriptsTable)
    .where(eq(transcriptsTable.businessType, businessType))
    .orderBy(desc(transcriptsTable.createdAt))
    .limit(50);

  if (channel === 'wa') {
    rows = rows.filter(r => r.callSid?.startsWith('wa:'));
  }
  return c.json({ success: true, data: rows });
});

export const SYNTHETIC_CALLER = 'synthetic-latency-test';

// POST /admin/stream-token { businessType, caller? } — a media-stream token for
// svt/latency-test.mjs, so a synthetic caller can talk to production
// without a phone call. The caller identity is fixed and marked synthetic.
adminRouter.post('/stream-token', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  const businessType = typeof body?.businessType === 'string' ? body.businessType : '';
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: 'Unknown business' }, 404);
  // Parallel test calls each get their own identity (`caller`), so they
  // don't cancel each other's bookings.
  const caller = typeof body?.caller === 'string' && /^[a-z0-9-]{1,20}$/.test(body.caller)
    ? `${SYNTHETIC_CALLER}:${body.caller}` : SYNTHETIC_CALLER;
  // Each run starts clean: earlier runs' bookings would otherwise take the
  // slots this one asks for, and pile up in the shop's list and calendar.
  const stale = await getDb(c.env.DB).update(ordersTable).set({ status: 'CANCELLED' })
    .where(and(eq(ordersTable.customerIdHashed, caller), ne(ordersTable.status, 'CANCELLED')))
    .returning({ id: ordersTable.id, businessType: ordersTable.businessType, calendarEventId: ordersTable.calendarEventId });
  c.executionCtx.waitUntil(Promise.all(stale.map(o => removeBookingFromCalendar(c.env, o))));
  // A real call always has caller ID; 555-01xx numbers are reserved for fiction.
  const token = await signStreamToken(c.env, businessType, caller, '+13125550100');
  return c.json({ success: true, data: { token } });
});

// GET /admin/bookings/:businessType — recent bookings with the caller's details
adminRouter.get('/bookings/:businessType', withBusinessAccess('staff'), async (c) => {
  const rows = await getDb(c.env.DB).select().from(ordersTable)
    .where(eq(ordersTable.businessType, c.req.param('businessType') ?? ''))
    .orderBy(desc(ordersTable.createdAt))
    .limit(100);
  return c.json({ success: true, data: rows });
});

// GET /admin/messages/:businessType — messages callers left for staff
adminRouter.get('/messages/:businessType', withBusinessAccess('staff'), async (c) => {
  const rows = await getDb(c.env.DB).select().from(callMessages)
    .where(eq(callMessages.businessType, c.req.param('businessType') ?? ''))
    .orderBy(desc(callMessages.createdAt))
    .limit(100);
  return c.json({ success: true, data: rows });
});

// PATCH /admin/messages/:businessType/:id — mark a message handled { status: 'DONE' | 'NEW' }
adminRouter.patch('/messages/:businessType/:id', withBusinessAccess('staff'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const status = body?.status === 'DONE' ? 'DONE' : 'NEW';
  await getDb(c.env.DB).update(callMessages).set({ status })
    .where(and(eq(callMessages.id, c.req.param('id') ?? ''), eq(callMessages.businessType, c.req.param('businessType') ?? '')));
  return c.json({ success: true });
});

export { adminRouter };
export type { SectorConfig };
