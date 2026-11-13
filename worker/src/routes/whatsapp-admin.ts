import { Hono } from 'hono';
import type { HonoEnv } from '../middleware';
import { hitLimit, withAdminKey, withBusinessAccess } from '../middleware';
import { isProduction } from '../config';
import { getSector } from '../services/sector.service';
import {
  createDefaults, createTemplate, DEFAULT_TEMPLATES, EVENTS, isEvent, isTemplateName, listTemplates, setEventChoice,
  syncTemplates, TemplateError, VARIANTS, wabaId,
} from '../services/whatsapp-templates';
import { getBusinessSettings, previews, runReminders, setBusinessSettings } from '../services/whatsapp-outbound';
import { businessNumber, healthView, refreshHealth, templateSummary } from '../services/whatsapp-health';
import type { ReplyLanguage } from '../services/whatsapp-api';

// /admin/whatsapp/*: templates, event choices, number health and the
// reminder runner for the operator; Settings → WhatsApp for owners.
export const whatsappAdminRouter = new Hono<HonoEnv>();

const fail = (c: any, e: unknown) => {
  if (e instanceof TemplateError) return c.json({ success: false, error: e.message }, e.status);
  throw e;
};

// GET /admin/whatsapp/templates — stored templates, the defaults and the per-event choices.
whatsappAdminRouter.get('/templates', withAdminKey, async (c) => {
  return c.json({
    success: true,
    data: {
      wabaConfigured: !!wabaId(c.env),
      templates: await listTemplates(c.env),
      events: await templateSummary(c.env),
      defaults: DEFAULT_TEMPLATES,
    },
  });
});

// POST /admin/whatsapp/templates/sync — pull statuses from Meta.
whatsappAdminRouter.post('/templates/sync', withAdminKey, async (c) => {
  if (await hitLimit(c.env, 'rl:wa:sync', 10, 60)) return c.json({ success: false, error: 'Too many syncs. Please wait a minute.' }, 429);
  try { return c.json({ success: true, data: { synced: await syncTemplates(c.env) } }); } catch (e) { return fail(c, e); }
});

// POST /admin/whatsapp/templates { event } → Avery's default for that event in en, hi and Hinglish;
// or { name, variant, body, example[] } → one custom template. Both UTILITY.
whatsappAdminRouter.post('/templates', withAdminKey, async (c) => {
  if (await hitLimit(c.env, 'rl:wa:create', 20, 60)) return c.json({ success: false, error: 'Too many requests. Please wait a minute.' }, 429);
  const body = await c.req.json().catch(() => null);
  try {
    if (isEvent(body?.event) && !body?.body) return c.json({ success: true, data: await createDefaults(c.env, body.event) });
    if (!isTemplateName(body?.name)) return c.json({ success: false, error: 'name: lower case letters, digits and _' }, 400);
    if (!VARIANTS.includes(body?.variant)) return c.json({ success: false, error: 'variant must be en, hi or hi-en' }, 400);
    if (typeof body?.body !== 'string') return c.json({ success: false, error: 'body is required' }, 400);
    const example = Array.isArray(body.example) ? body.example.map((x: unknown) => String(x ?? '')).slice(0, 10) : [];
    return c.json({ success: true, data: await createTemplate(c.env, { name: body.name, variant: body.variant as ReplyLanguage, body: body.body, example, purpose: isEvent(body.event) ? body.event : null }) });
  } catch (e) { return fail(c, e); }
});

// PUT /admin/whatsapp/templates/choice { event, family | null }
whatsappAdminRouter.put('/templates/choice', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isEvent(body?.event)) return c.json({ success: false, error: `event must be one of ${EVENTS.join(', ')}` }, 400);
  if (body.family !== null && !isTemplateName(body?.family)) return c.json({ success: false, error: 'family must be a template name, or null for none' }, 400);
  await setEventChoice(c.env, body.event, body.family);
  return c.json({ success: true, data: await templateSummary(c.env) });
});

// GET /admin/whatsapp/health; POST /admin/whatsapp/health/refresh
whatsappAdminRouter.get('/health', withAdminKey, async (c) => c.json({ success: true, data: await healthView(c.env) }));
whatsappAdminRouter.post('/health/refresh', withAdminKey, async (c) => {
  if (await hitLimit(c.env, 'rl:wa:health', 10, 60)) return c.json({ success: false, error: 'Too many refreshes. Please wait a minute.' }, 429);
  const r = await refreshHealth(c.env);
  return c.json({ success: true, data: { ...r, ...(await healthView(c.env)) } });
});

// POST /admin/whatsapp/reminders/run { now? } — the hourly job, on demand.
// `now` (an ISO time, to test timing) is refused in production.
whatsappAdminRouter.post('/reminders/run', withAdminKey, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let now = new Date();
  if (body?.now !== undefined) {
    if (isProduction(c.env)) return c.json({ success: false, error: 'now can only be set outside production' }, 400);
    now = new Date(String(body.now));
    if (Number.isNaN(now.getTime())) return c.json({ success: false, error: 'now must be an ISO time' }, 400);
  }
  return c.json({ success: true, data: await runReminders(c.env, now) });
});

// ── Owner: Settings → WhatsApp ───────────────────────────────────────────────

whatsappAdminRouter.get('/business/:businessType', withBusinessAccess('owner'), async (c) => {
  const key = c.req.param('businessType') ?? '';
  const meta = await getSector(c.env, key);
  if (!meta) return c.json({ success: false, error: 'Not found' }, 404);
  const [settings, number, events] = await Promise.all([getBusinessSettings(c.env, key), businessNumber(c.env, key), templateSummary(c.env)]);
  return c.json({
    success: true,
    data: {
      connected: !!number && !!c.env.WA_ACCESS_TOKEN,
      number,
      settings,
      ready: Object.fromEntries(events.map(e => [e.event, e.ready])),
      previews: previews(meta, meta.name),
    },
  });
});

whatsappAdminRouter.put('/business/:businessType', withBusinessAccess('owner'), async (c) => {
  const key = c.req.param('businessType') ?? '';
  if (!(await getSector(c.env, key))) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const patch: { reminders?: boolean; missedCallFollowup?: boolean } = {};
  if (typeof body?.reminders === 'boolean') patch.reminders = body.reminders;
  if (typeof body?.missedCallFollowup === 'boolean') patch.missedCallFollowup = body.missedCallFollowup;
  if (!Object.keys(patch).length) return c.json({ success: false, error: 'Send reminders and/or missedCallFollowup (true or false)' }, 400);
  return c.json({ success: true, data: await setBusinessSettings(c.env, key, patch) });
});
