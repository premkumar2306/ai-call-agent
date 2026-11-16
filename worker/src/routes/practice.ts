import { Hono } from 'hono';
import { withBusinessAccess, type HonoEnv } from '../middleware';
import {
  confirmByFrontDesk, getPracticeSettings, orderForToken, publicSettings, savePracticeSettings, suggestByFrontDesk, syncIcs, validatePracticeInput,
} from '../services/practice';
import { getSector } from '../services/sector.service';
import { notifyBooking } from '../services/notify.service';
import { getDb } from '../db/client';
import { orders } from '../db/schema';
import { eq } from 'drizzle-orm';

// /practice/:businessType — practice-software settings (owner).
// /fd/:token — the front desk's one-tap Confirm / Suggest another time page.

export const practiceRouter = new Hono<HonoEnv>();

practiceRouter.get('/:businessType', withBusinessAccess('staff'), async (c) =>
  c.json({ success: true, data: publicSettings(await getPracticeSettings(c.env, c.req.param('businessType')!)) }));

practiceRouter.put('/:businessType', withBusinessAccess('owner'), async (c) => {
  const parsed = validatePracticeInput(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ success: false, error: parsed }, 400);
  try {
    return c.json({ success: true, data: publicSettings(await savePracticeSettings(c.env, c.req.param('businessType')!, parsed)) });
  } catch (e: any) { return c.json({ success: false, error: e?.message || 'Could not save' }, e?.status ?? 500); }
});

// POST /practice/:businessType/ics/sync — import the ICS feed now (also runs hourly).
practiceRouter.post('/:businessType/ics/sync', withBusinessAccess('owner'), async (c) => {
  const bt = c.req.param('businessType')!;
  const r = await syncIcs(c.env, bt, (await getSector(c.env, bt))?.timezone || 'Asia/Kolkata');
  return c.json({ success: r.ok, data: r, ...(r.error ? { error: r.error } : {}) }, r.ok ? 200 : 400);
});

// ── Front desk page ─────────────────────────────────────────────────────────

export const frontDeskRouter = new Hono<HonoEnv>();

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:24px auto;padding:0 16px;color:#1d2433;background:#fff}
button,input{font:inherit;padding:12px 16px;border-radius:10px;border:1px solid #c9ced8}button{width:100%;margin:6px 0;cursor:pointer}
.ok{background:#1f7a4d;color:#fff;border:0}.muted{color:#5b6475;font-size:14px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
@media (prefers-color-scheme:dark){body{background:#12151c;color:#e6e9ef}.muted{color:#9aa3b2}input,button{background:#1b2030;color:#e6e9ef;border-color:#2a303c}}
</style></head><body>${body}</body></html>`;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };

// GET shows the request and the buttons; it never changes anything (link previews are safe).
frontDeskRouter.get('/:token', async (c) => {
  const o = await orderForToken(c.env, c.req.param('token'));
  if (!o) return c.html(page('Not found', '<h1>This link is not valid</h1>'), 404, HEADERS);
  const meta = await getSector(c.env, o.business_type);
  const when = o.scheduled_at ? o.scheduled_at.slice(0, 16).replace('T', ' at ') : 'no time given';
  const state = o.status === 'CANCELLED' ? '<p><b>This booking was cancelled.</b></p>'
    : o.front_desk_status === 'confirmed' ? '<p><b>✓ Confirmed.</b> The patient has been told.</p>'
    : o.front_desk_status === 'suggested' ? `<p><b>You suggested ${esc((o.suggested_at ?? '').replace('T', ' at '))}.</b> The patient has been asked to reply or call.</p>` : '';
  const open = o.status !== 'CANCELLED' && o.front_desk_status === 'pending';
  return c.html(page(`${meta?.name ?? 'Clinic'}: booking request`, `<h1>Booking request</h1>
<p class="muted">${esc(meta?.name ?? '')}: taken by the phone assistant. The patient was told it is pending until you confirm.</p>
<dl><dt>Patient</dt><dd>${esc(o.customer_name ?? 'Not given')}</dd><dt>Phone</dt><dd>${o.callback_phone ? `<a href="tel:${esc(o.callback_phone)}">${esc(o.callback_phone)}</a>` : '—'}</dd>
<dt>Service</dt><dd>${esc(o.product_name)}</dd><dt>Requested</dt><dd>${esc(when)}</dd></dl>${state}
${open ? `<form method="post" action="/fd/${esc(c.req.param('token'))}/confirm"><button class="ok" type="submit">Confirm ${esc(when)}</button></form>
<form method="post" action="/fd/${esc(c.req.param('token'))}/suggest"><label class="muted">Or suggest another time<br><input type="datetime-local" name="at" required></label><button type="submit">Suggest this time</button></form>` : ''}`), 200, HEADERS);
});

frontDeskRouter.post('/:token/confirm', async (c) => {
  const t = c.req.param('token');
  const before = await orderForToken(c.env, t);
  const o = await confirmByFrontDesk(c.env, t);
  if (!o) return c.html(page('Not found', '<h1>This request is no longer open</h1>'), 404, HEADERS);
  if (before?.front_desk_status !== 'confirmed') {
    // The patient now gets the normal booking confirmation (WhatsApp template or SMS).
    const [order] = await getDb(c.env.DB).select().from(orders).where(eq(orders.id, o.id));
    const meta = await getSector(c.env, o.business_type);
    if (order) await notifyBooking(c.env, meta, order as any, 'booked').catch(e => console.error('[fd] confirm notify', e?.message || e));
  }
  return c.redirect(`/fd/${t}`, 303);
});

frontDeskRouter.post('/:token/suggest', async (c) => {
  const t = c.req.param('token');
  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const o = await orderForToken(c.env, t);
  const meta = o ? await getSector(c.env, o.business_type) : null;
  const r = await suggestByFrontDesk(c.env, meta, t, String(body.at ?? '').slice(0, 16));
  if (typeof r === 'string') return c.html(page('Could not suggest', `<p>${esc(r)}</p><p><a href="/fd/${esc(t)}">Back</a></p>`), 400, HEADERS);
  return c.redirect(`/fd/${t}`, 303);
});
