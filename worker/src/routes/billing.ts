import { Hono, type Context, type Next } from 'hono';
import type { HonoEnv } from '../middleware';
import { withAdminKey } from '../middleware';
import { timingSafeEqual } from '../config';
import { getSector } from '../services/sector.service';
import { isPeriod, isValidGstin, normalizeGstin, billingPeriod } from '../services/billing/pricing';
import { checkWebhook, RazorpayNotConfigured } from '../services/billing/razorpay';
import {
  applyWebhook, assignPlan, billingSummary, closePeriod, confirmCheckout, getAccount, listPlans,
  startSubscription, syncPlanToRazorpay, updateBillingDetails, upsertPlan, usageRecordsFor, validatePlanInput,
  type BillingDetails, type RazorpayWebhook, type Viewer,
} from '../services/billing/service';

type BillingEnv = { Bindings: HonoEnv['Bindings']; Variables: HonoEnv['Variables'] & { viewer: Viewer } };

// ── Access ──────────────────────────────────────────────────────────────────
// Who may see and manage a business's billing. Today only the operator, with
// X-Admin-Key. Owner logins (workstream E) plug in here: resolve the owner's
// session, check it is for :businessType, and return { role: 'owner' }.
// Everything below keys off `viewer.role`, so owners automatically get the
// summary without cost/margin and none of the /admin/billing routes.
export async function resolveBillingViewer(c: Context<BillingEnv>, _businessType: string): Promise<Viewer | null> {
  const key = c.req.header('x-admin-key');
  if (c.env.ADMIN_SECRET && key && timingSafeEqual(key, c.env.ADMIN_SECRET)) return { role: 'operator' };
  return null;
}

async function withBillingAccess(c: Context<BillingEnv>, next: Next) {
  const businessType = c.req.param('businessType');
  if (!businessType) return c.json({ success: false, error: 'Business required' }, 400);
  const viewer = await resolveBillingViewer(c, businessType);
  if (!viewer) return c.json({ success: false, error: 'Admin key required' }, 401);
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: `Unknown business: ${businessType}` }, 404);
  c.set('viewer', viewer);
  await next();
}

function errorResponse(c: Context<any>, e: any) {
  if (e instanceof RazorpayNotConfigured) return c.json({ success: false, error: e.message }, 503);
  const status = typeof e?.status === 'number' ? e.status : 502;
  if (status >= 500) console.error('[billing]', e?.message || e);
  return c.json({ success: false, error: e?.message || 'Billing error' }, status);
}

// ── /billing/:businessType — business-scoped (owner-ready) ──────────────────

export const billingRouter = new Hono<BillingEnv>();

billingRouter.use('/:businessType', withBillingAccess);
billingRouter.use('/:businessType/*', withBillingAccess);

billingRouter.get('/:businessType', async (c) => {
  const period = c.req.query('period');
  if (period && !isPeriod(period)) return c.json({ success: false, error: 'period must be YYYY-MM' }, 400);
  const data = await billingSummary(c.env, c.req.param('businessType'), c.get('viewer'), period || billingPeriod(new Date()));
  return c.json({ success: true, data });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^[1-9][0-9]{5}$/;

export function validateBillingDetails(b: any): BillingDetails | string {
  if (!b || typeof b !== 'object') return 'JSON body required';
  const out: BillingDetails = {};
  const str = (k: keyof BillingDetails, max = 200) => {
    const v = b[k];
    if (v === undefined) return null;
    if (v !== null && typeof v !== 'string') return `${k} must be a string`;
    const t = v === null ? null : v.trim();
    if (t && t.length > max) return `${k} is too long`;
    (out as any)[k] = t || null;
    return null;
  };
  for (const k of ['legalName', 'billingEmail', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'gstin'] as const) {
    const err = str(k);
    if (err) return err;
  }
  if (out.gstin) {
    if (!isValidGstin(out.gstin)) return 'GSTIN is not valid (15 characters, check digit must match)';
    out.gstin = normalizeGstin(out.gstin);
  }
  if (out.billingEmail && !EMAIL_RE.test(out.billingEmail)) return 'billingEmail is not a valid email';
  if (out.postalCode && !PIN_RE.test(out.postalCode)) return 'postalCode must be a 6-digit PIN code';
  return out;
}

billingRouter.put('/:businessType/details', async (c) => {
  const parsed = validateBillingDetails(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ success: false, error: parsed }, 400);
  await updateBillingDetails(c.env, c.req.param('businessType'), parsed);
  return c.json({ success: true });
});

// Creates (or re-uses) the Razorpay subscription; the UI opens Checkout with it.
billingRouter.post('/:businessType/subscribe', async (c) => {
  try {
    return c.json({ success: true, data: await startSubscription(c.env, c.req.param('businessType')) });
  } catch (e) { return errorResponse(c, e); }
});

billingRouter.post('/:businessType/confirm', async (c) => {
  const b = await c.req.json().catch(() => null);
  const paymentId = b?.razorpay_payment_id, subscriptionId = b?.razorpay_subscription_id, signature = b?.razorpay_signature;
  if (![paymentId, subscriptionId, signature].every(v => typeof v === 'string' && v)) {
    return c.json({ success: false, error: 'razorpay_payment_id, razorpay_subscription_id and razorpay_signature are required' }, 400);
  }
  const ok = await confirmCheckout(c.env, c.req.param('businessType'), { paymentId, subscriptionId, signature });
  return ok ? c.json({ success: true }) : c.json({ success: false, error: 'Payment signature did not verify' }, 400);
});

// ── /admin/billing — operator only ──────────────────────────────────────────

export const billingAdminRouter = new Hono<HonoEnv>();
billingAdminRouter.use('*', withAdminKey);

billingAdminRouter.get('/plans', async (c) => c.json({ success: true, data: await listPlans(c.env) }));

// PUT /admin/billing/plans/:id — create or change a plan (prices in paise, excl. GST)
billingAdminRouter.put('/plans/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[a-z0-9_-]{1,40}$/.test(id)) return c.json({ success: false, error: 'plan id: lowercase letters, digits, _ and -' }, 400);
  const parsed = validatePlanInput(await c.req.json().catch(() => null));
  if (typeof parsed === 'string') return c.json({ success: false, error: parsed }, 400);
  return c.json({ success: true, data: await upsertPlan(c.env, id, parsed) });
});

// POST /admin/billing/plans/:id/razorpay — create the matching Razorpay plan.
// Razorpay plans are immutable: after changing the price, call this again and
// new subscriptions use the new plan; existing ones keep the old price.
billingAdminRouter.post('/plans/:id/razorpay', async (c) => {
  try { return c.json({ success: true, data: await syncPlanToRazorpay(c.env, c.req.param('id')) }); }
  catch (e) { return errorResponse(c, e); }
});

// PUT /admin/billing/accounts/:businessType { planId: string | null } — billing on/off
billingAdminRouter.put('/accounts/:businessType', async (c) => {
  const businessType = c.req.param('businessType');
  const b = await c.req.json().catch(() => null);
  if (!b || (b.planId !== null && typeof b.planId !== 'string')) {
    return c.json({ success: false, error: 'planId must be a plan id or null' }, 400);
  }
  if (!(await getSector(c.env, businessType))) return c.json({ success: false, error: `Unknown business: ${businessType}` }, 404);
  try {
    const account = await assignPlan(c.env, businessType, b.planId);
    return c.json({ success: true, data: account });
  } catch (e) { return errorResponse(c, e); }
});

billingAdminRouter.get('/accounts/:businessType', async (c) => {
  return c.json({ success: true, data: await getAccount(c.env, c.req.param('businessType')) });
});

// GET /admin/billing/usage/:businessType?period=YYYY-MM — per-call records with cost
billingAdminRouter.get('/usage/:businessType', async (c) => {
  const period = c.req.query('period') || billingPeriod(new Date());
  if (!isPeriod(period)) return c.json({ success: false, error: 'period must be YYYY-MM' }, 400);
  return c.json({ success: true, data: await usageRecordsFor(c.env, c.req.param('businessType'), period) });
});

// POST /admin/billing/close-period { period?: 'YYYY-MM' } — the cron job, by hand
billingAdminRouter.post('/close-period', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b?.period !== undefined && !isPeriod(b.period)) return c.json({ success: false, error: 'period must be YYYY-MM' }, 400);
  return c.json({ success: true, data: await closePeriod(c.env, b?.period) });
});

// ── /razorpay/webhook ───────────────────────────────────────────────────────

export const razorpayRouter = new Hono<HonoEnv>();

razorpayRouter.post('/webhook', async (c) => {
  const raw = await c.req.text();
  const check = await checkWebhook(c.env, raw, c.req.header('x-razorpay-signature'));
  if (check === 'not_configured') {
    console.error('[razorpay] RAZORPAY_WEBHOOK_SECRET is not set; rejecting webhook');
    return c.json({ success: false, error: 'Webhook not configured' }, 503);
  }
  if (check === 'bad_signature') return c.json({ success: false, error: 'Invalid signature' }, 401);

  let evt: RazorpayWebhook;
  try { evt = JSON.parse(raw); } catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }
  if (typeof evt?.event !== 'string') return c.json({ success: false, error: 'Missing event' }, 400);

  // A 5xx makes Razorpay retry; the event id is only stored once applied.
  const result = await applyWebhook(c.env, c.req.header('x-razorpay-event-id') ?? null, evt);
  console.log(`[razorpay] ${evt.event}: ${result}`);
  return c.json({ success: true });
});
