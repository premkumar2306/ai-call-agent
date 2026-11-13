import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import {
  assignDefaultPlan, assignPlan, billingState, billingSummary, closePeriod, confirmCheckout, entitlements, getAccount,
  overageDecision, periodEndUnix, recordUsage, startSubscription, upsertPlan, allAccountsStatus,
} from '../src/services/billing/service';
import { applyWebhook, cancelSubscription, changePlan, runDunning } from '../src/services/billing/lifecycle';
import { listTaxInvoices, renderInvoiceHtml } from '../src/services/billing/invoices';
import { financialYear, formatInvoiceNumber, invoiceTotals, splitInclusive, graceDays } from '../src/services/billing/pricing';
import { billingRouter, razorpayRouter } from '../src/routes/billing';

// The subscription lifecycle against an in-memory D1, with Razorpay and
// Resend stubbed at fetch: trial → checkout → active → failed payment →
// dunning → halted → overage → tax invoice → plan change → cancel.

const DAY = 86_400;
const SUPPLIER = '27AAPFU0939F1ZV';   // Maharashtra
const CUSTOMER_MH = '27AAACR5055K1Z7';
const CUSTOMER_KA = '29AAACR5055K1Z3';

let env: Env;
let emails: Array<{ to: string; subject: string; html?: string }>;
let rzp: Array<{ method: string; path: string; body: any }>;
let subs: Map<string, any>;

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))), b => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  env = {
    DB: createD1() as any, CACHE: createKV() as any, CART: createKV() as any, NODE_ENV: 'production',
    RESEND_API_KEY: 're_test', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'keysecret', RAZORPAY_WEBHOOK_SECRET: 'whsec',
    BILLING_SUPPLIER_GSTIN: SUPPLIER, ADMIN_SECRET: 'admin',
  } as Env;
  emails = []; rzp = []; subs = new Map();
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (u.startsWith('https://api.resend.com/')) { emails.push({ to: body.to[0], subject: body.subject, html: body.html }); return Response.json({ id: 'e' }); }
    if (u.startsWith('https://api.razorpay.com/v1')) {
      const path = u.slice('https://api.razorpay.com/v1'.length), method = init.method ?? 'GET';
      rzp.push({ method, path, body });
      const j = (o: unknown, s = 200) => Response.json(o, { status: s });
      if (method === 'POST' && path === '/plans') return j({ id: `plan_${++n}` });
      if (method === 'POST' && path === '/subscriptions') { const s = { id: `sub_${++n}`, status: 'created', plan_id: body.plan_id, short_url: 'https://rzp.io/i/x' }; subs.set(s.id, s); return j(s); }
      const m = path.match(/^\/subscriptions\/([^/]+)(\/cancel|\/addons)?$/);
      if (m && method === 'GET') return subs.has(m[1]) ? j(subs.get(m[1])) : j({ error: { description: 'nf' } }, 404);
      if (m && m[2] === '/cancel') { const s = subs.get(m[1]); if (!body.cancel_at_cycle_end) s.status = 'cancelled'; return j(s); }
      if (m && m[2] === '/addons') return j({ id: `ao_${++n}` });
      if (m && method === 'PATCH') { const s = subs.get(m[1]); if (body.schedule_change_at === 'now') s.plan_id = body.plan_id; return j(s); }
      return j({ error: { description: `no ${method} ${path}` } }, 400);
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, notify_email, created_at, updated_at) VALUES ('in_clinic', 'Sharma Clinic', 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 'IN', 'owner@clinic.in', 0, 0)`).run();
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, created_at, updated_at) VALUES ('us_biz', 'US Biz', 'service', '[]', '{}', 0, 0)`).run();
  await upsertPlan(env, 'in_starter', { name: 'Starter', monthlyFeePaise: 299_900, includedMinutes: 300, overagePaisePerMinute: 700, trialDays: 14, gstRateBps: 1800, isDefault: true, razorpayPlanId: 'plan_starter' });
  await upsertPlan(env, 'in_growth', { name: 'Growth', monthlyFeePaise: 599_900, includedMinutes: 800, overagePaisePerMinute: 600, trialDays: 14, gstRateBps: 1800, razorpayPlanId: 'plan_growth' });
});
afterEach(() => vi.unstubAllGlobals());

const webhook = async (event: string, payload: object, id = crypto.randomUUID()) => {
  const raw = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  return razorpayRouter.request('/webhook', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': await hmacHex('whsec', raw), 'x-razorpay-event-id': id } }, env);
};
async function subscribed(status = 'active') {
  await assignDefaultPlan(env, 'in_clinic');
  const { subscriptionId } = await startSubscription(env, 'in_clinic');
  subs.get(subscriptionId).status = status;
  subs.get(subscriptionId).current_end = Math.floor(Date.now() / 1000) + 20 * DAY;
  await webhook(`subscription.${status === 'active' ? 'activated' : status}`, { subscription: { entity: { id: subscriptionId } } });
  return subscriptionId;
}

describe('pure maths', () => {
  it('financial year and invoice numbers (India time, April start, ≤16 chars)', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('25-26');  // 23:59 IST 31 Mar
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('26-27');  // 00:01 IST 1 Apr
    expect(formatInvoiceNumber('26-27', 42)).toBe('AVY/26-27/000042');
    expect(formatInvoiceNumber('26-27', 42).length).toBeLessThanOrEqual(16);
  });
  it('backs GST out of an inclusive amount; lines add up to what was paid', () => {
    expect(splitInclusive(353_882, 1800)).toEqual({ taxablePaise: 299_900, gstPaise: 53_982 });
    const t = invoiceTotals([{ description: 'Plan', totalPaise: 353_882 }, { description: 'Extra', totalPaise: 8_260 }], 1800, '27', '27');
    expect(t.totalPaise).toBe(362_142);
    expect(t.lines.reduce((s, l) => s + l.amountPaise, 0)).toBe(t.taxablePaise);
    expect(t.cgst + t.sgst).toBe(t.gstPaise);
    expect(t.igst).toBe(0);
    expect(invoiceTotals([{ description: 'Plan', totalPaise: 353_882 }], 1800, '27', '29').igst).toBe(53_982);
  });
  it('grace days: default 7, bounded', () => {
    expect(graceDays(undefined)).toBe(7);
    expect(graceDays('3')).toBe(3);
    expect(graceDays('-1')).toBe(7);
    expect(graceDays('abc')).toBe(7);
  });
  it('periodEndUnix is midnight India time', () => {
    expect(new Date(periodEndUnix('2026-11') * 1000).toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(new Date(periodEndUnix('2026-12') * 1000).toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });
});

describe('states and entitlements', () => {
  const now = 1_800_000_000;
  const a = (o: object) => ({ planId: 'p', trialEndsAt: null, subscriptionStatus: null, pastDueSince: null, ...o }) as any;
  it('maps every Razorpay status', () => {
    expect(billingState(a({ subscriptionStatus: 'paused' }), now)).toBe('paused');
    expect(billingState(a({ subscriptionStatus: 'pending' }), now)).toBe('past_due');
    expect(billingState(a({ subscriptionStatus: 'completed' }), now)).toBe('cancelled');
    expect(billingState(a({ subscriptionStatus: 'active', pastDueSince: now - 10 }), now)).toBe('past_due');
  });
  it('never restricts in good standing; restricts after grace, at once when halted', () => {
    expect(entitlements(a({ subscriptionStatus: 'active' }), 7, now).overageAllowed).toBe(true);
    expect(entitlements(a({ subscriptionStatus: 'pending', pastDueSince: now - 6 * DAY }), 7, now)).toMatchObject({ restricted: false, graceEndsAt: now + DAY });
    expect(entitlements(a({ subscriptionStatus: 'pending', pastDueSince: now - 8 * DAY }), 7, now).restricted).toBe(true);
    expect(entitlements(a({ subscriptionStatus: 'halted', pastDueSince: now }), 7, now).restricted).toBe(true);
    expect(entitlements(a({ trialEndsAt: now - 2 * DAY }), 7, now).restricted).toBe(false);   // unpaid, in grace
    expect(entitlements(a({ trialEndsAt: now - 8 * DAY }), 7, now).restricted).toBe(true);
    expect(entitlements(null, 7, now).overageAllowed).toBe(true);                               // billing off
  });
  it('overage decision at month end', () => {
    const end = now;
    expect(overageDecision(a({ subscriptionStatus: 'active', razorpaySubscriptionId: 's' }), 0, end, 7, now)).toBe('no_overage');
    expect(overageDecision(a({ subscriptionStatus: 'active', razorpaySubscriptionId: 's' }), 700, end, 7, now)).toBe('bill');
    expect(overageDecision(a({ trialEndsAt: end + 1 }), 700, end, 7, now)).toBe('trial');
    expect(overageDecision(a({ subscriptionStatus: 'pending', pastDueSince: now - DAY, razorpaySubscriptionId: 's' }), 700, end, 7, now)).toBe('deferred');
    expect(overageDecision(a({ subscriptionStatus: 'halted', pastDueSince: now, razorpaySubscriptionId: 's' }), 700, end, 7, now)).toBe('waived');
  });
});

describe('trial and checkout', () => {
  it('a new Indian business starts on the default plan with its trial; a US business is untouched', async () => {
    const acct = await assignDefaultPlan(env, 'in_clinic');
    expect(acct?.planId).toBe('in_starter');
    expect(acct!.trialEndsAt! - Math.floor(Date.now() / 1000)).toBeGreaterThan(13 * DAY);
    expect(await assignDefaultPlan(env, 'us_biz')).toBeNull();
    expect(await getAccount(env, 'us_biz')).toBeNull();
    const s: any = await billingSummary(env, 'in_clinic', { role: 'owner' });
    expect(s.state).toBe('trialing');
    expect(s.trialDaysLeft).toBe(14);
    expect(s.nextAction).toBe('subscribe');
  });
  it('subscribe defers the first charge to the trial end and prefills Checkout', async () => {
    await assignDefaultPlan(env, 'in_clinic');
    const c = await startSubscription(env, 'in_clinic');
    const call = rzp.find(r => r.path === '/subscriptions')!;
    expect(call.body.plan_id).toBe('plan_starter');
    expect(call.body.start_at).toBe((await getAccount(env, 'in_clinic'))!.trialEndsAt);
    expect(c.prefill.email).toBe('owner@clinic.in');
    expect((await startSubscription(env, 'in_clinic')).subscriptionId).toBe(c.subscriptionId); // reused until paid
  });
  it('checkout signature: valid → authenticated, bad → refused', async () => {
    await assignDefaultPlan(env, 'in_clinic');
    const { subscriptionId } = await startSubscription(env, 'in_clinic');
    expect(await confirmCheckout(env, 'in_clinic', { paymentId: 'pay_1', subscriptionId, signature: 'deadbeef' })).toBe(false);
    expect((await getAccount(env, 'in_clinic'))!.subscriptionStatus).toBe('created');
    const sig = await hmacHex('keysecret', `pay_1|${subscriptionId}`);
    expect(await confirmCheckout(env, 'in_clinic', { paymentId: 'pay_1', subscriptionId, signature: sig })).toBe(true);
    expect(billingState(await getAccount(env, 'in_clinic'))).toBe('active');
  });
});

describe('webhooks', () => {
  it('rejects a bad signature and de-duplicates by event id', async () => {
    const id = await subscribed();
    const raw = JSON.stringify({ event: 'subscription.halted', payload: { subscription: { entity: { id } } } });
    expect((await razorpayRouter.request('/webhook', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': 'bad' } }, env)).status).toBe(401);
    const evt = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f', subscription_id: id, error_description: 'Card declined', created_at: 100 } } } };
    expect(await applyWebhook(env, 'evt_1', evt)).toMatch(/payment.failed/);
    expect(await applyWebhook(env, 'evt_1', evt)).toBe('duplicate');
    expect(emails.filter(e => /payment failed/.test(e.subject))).toHaveLength(1);
  });
  it('payment.failed → past_due + one dunning email; payment.captured clears it; stale events ignored', async () => {
    const id = await subscribed();
    await webhook('payment.failed', { payment: { entity: { id: 'pay_f', subscription_id: id, error_description: 'Card declined', created_at: 200 } } });
    let a = (await getAccount(env, 'in_clinic'))!;
    expect(billingState(a)).toBe('past_due');
    expect(a.lastPaymentError).toBe('Card declined');
    await webhook('payment.failed', { payment: { entity: { id: 'pay_f2', subscription_id: id, created_at: 300 } } });
    expect(emails.filter(e => /payment failed/.test(e.subject))).toHaveLength(1);   // once per episode
    const s: any = await billingSummary(env, 'in_clinic', { role: 'owner' });
    expect(s.nextAction).toBe('update_payment');
    expect(s.payment.graceEndsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await webhook('payment.captured', { payment: { entity: { id: 'pay_old', subscription_id: id, created_at: 100 } } });
    expect(billingState(await getAccount(env, 'in_clinic'))).toBe('past_due');          // older than the failure
    await webhook('payment.captured', { payment: { entity: { id: 'pay_ok', subscription_id: id, created_at: 400 } } });
    a = (await getAccount(env, 'in_clinic'))!;
    expect(billingState(a)).toBe('active');
  });
  it('a card declined inside Checkout (no mandate yet) sends no dunning email', async () => {
    await assignDefaultPlan(env, 'in_clinic');
    const { subscriptionId } = await startSubscription(env, 'in_clinic');
    await webhook('payment.failed', { payment: { entity: { id: 'p', subscription_id: subscriptionId, created_at: 1 } } });
    expect(emails).toHaveLength(0);
  });
  it('subscription.halted → past_due, restricted at once; the US business is never touched', async () => {
    const id = await subscribed();
    subs.get(id).status = 'halted';
    await webhook('subscription.halted', { subscription: { entity: { id } } });
    const a = (await getAccount(env, 'in_clinic'))!;
    expect(a.subscriptionStatus).toBe('halted');
    expect(entitlements(a, 7).restricted).toBe(true);
    expect((await billingSummary(env, 'in_clinic', { role: 'owner' }) as any).nextAction).toBe('subscribe');
    expect((await allAccountsStatus(env)).find(r => r.businessType === 'us_biz')!.state).toBe('off');
  });
  it('re-reads the subscription so an out-of-order event cannot regress the state', async () => {
    const id = await subscribed();
    await webhook('subscription.pending', { subscription: { entity: { id, status: 'pending' } } });  // stale: Razorpay says active
    expect(billingState(await getAccount(env, 'in_clinic'))).toBe('active');
  });
  it('a failure while applying releases the event id (5xx → Razorpay retries, then applies)', async () => {
    const id = await subscribed();
    const evt = { event: 'invoice.paid', payload: { invoice: { entity: { id: 'inv_r', subscription_id: id, amount_paid: 353_882 } } } };
    const real = env.DB;
    const broken = { ...env, DB: { prepare: (q: string) => { if (/tax_invoices/.test(q)) throw new Error('D1 down'); return real.prepare(q); }, batch: real.batch?.bind(real) } } as any;
    await expect(applyWebhook(broken, 'evt_r', evt)).rejects.toThrow(/D1 down/);
    expect(await applyWebhook(env, 'evt_r', evt)).toMatch(/tax invoice/);
    expect(await applyWebhook(env, 'evt_r', evt)).toBe('duplicate');
  });
});

describe('invoices', () => {
  it('invoice.paid → numbered GST invoice (CGST+SGST same state), emailed once, downloadable', async () => {
    await updateGstin(CUSTOMER_MH);
    const id = await subscribed();
    const inv = { id: 'inv_1', subscription_id: id, amount_paid: 362_142, paid_at: Math.floor(Date.now() / 1000), billing_start: 1, billing_end: 2,
      line_items: [{ type: 'plan', name: 'Starter', net_amount: 353_882 }, { type: 'addon', name: 'Extra minutes 2026-10', net_amount: 8_260 }] };
    await webhook('invoice.paid', { invoice: { entity: inv }, payment: { entity: { id: 'pay_9' } } });
    await webhook('invoice.paid', { invoice: { entity: inv }, payment: { entity: { id: 'pay_9' } } }, 'other-id');  // redelivery, new id
    const list = await listTaxInvoices(env, 'in_clinic');
    expect(list).toHaveLength(1);
    const t = list[0];
    expect(t.invoiceNumber).toMatch(/^AVY\/\d\d-\d\d\/000001$/);
    expect(t.totalPaise).toBe(362_142);
    expect(t.cgstPaise + t.sgstPaise + t.taxablePaise).toBe(362_142);
    expect(t.igstPaise).toBe(0);
    expect(emails.filter(e => /Tax invoice/.test(e.subject))).toHaveLength(1);
    const html = renderInvoiceHtml(env, t);
    expect(html).toContain('CGST 9%');
    expect(html).toContain(SUPPLIER);
    const owner = await billingRouter.request(`/in_clinic/invoices/${t.id}`, { headers: { 'x-admin-key': 'admin' } }, env);
    expect(owner.status).toBe(200);
    expect(owner.headers.get('content-type')).toMatch(/text\/html/);
  });
  it('IGST across states; numbers run on without gaps; refunds are shown', async () => {
    await updateGstin(CUSTOMER_KA);
    const id = await subscribed();
    for (const n of [1, 2]) await webhook('invoice.paid', { invoice: { entity: { id: `inv_${n}`, subscription_id: id, amount_paid: 353_882 } }, payment: { entity: { id: `pay_${n}` } } });
    const list = await listTaxInvoices(env, 'in_clinic');
    expect(list.map(l => l.invoiceNumber.slice(-6)).sort()).toEqual(['000001', '000002']);
    expect(list.every(l => l.igstPaise === 53_982 && l.cgstPaise === 0)).toBe(true);
    await webhook('refund.processed', { refund: { entity: { payment_id: 'pay_1', amount: 10_000 } }, payment: { entity: { id: 'pay_1', amount_refunded: 10_000 } } });
    expect((await listTaxInvoices(env, 'in_clinic')).find(l => l.razorpayPaymentId === 'pay_1')!.refundedPaise).toBe(10_000);
  });
});

async function updateGstin(g: string) {
  await assignDefaultPlan(env, 'in_clinic');
  await env.DB.prepare('UPDATE billing_accounts SET gstin = ? WHERE business_type = ?').bind(g, 'in_clinic').run();
}

describe('month end', () => {
  it('overage becomes one add-on (incl. GST); re-running never adds it twice', async () => {
    const id = await subscribed();
    await env.DB.prepare('UPDATE billing_accounts SET trial_ends_at = 0').run();
    const started = Math.floor(Date.UTC(2026, 9, 10) / 1000);
    await recordUsage(env, { businessType: 'in_clinic', channel: 'voice', provider: 'exotel', sourceId: 'CA1', startedAt: started, durationSeconds: 310 * 60 });
    expect(await closePeriod(env, '2026-10')).toEqual([{ businessType: 'in_clinic', status: 'billed' }]);
    const addon = rzp.filter(r => r.path === `/subscriptions/${id}/addons`);
    expect(addon).toHaveLength(1);
    expect(addon[0].body.item.amount).toBe(8_260);   // 10 min × ₹7 + 18%
    expect(await closePeriod(env, '2026-10')).toEqual([]);
    expect(rzp.filter(r => r.path.endsWith('/addons'))).toHaveLength(1);
  });
  it('past due in grace → deferred, then billed once payment recovers; failed add-on retries', async () => {
    const id = await subscribed();
    await env.DB.prepare('UPDATE billing_accounts SET trial_ends_at = 0').run();
    await recordUsage(env, { businessType: 'in_clinic', channel: 'voice', provider: 'exotel', sourceId: 'CA2', startedAt: Math.floor(Date.UTC(2026, 9, 10) / 1000), durationSeconds: 301 * 60 });
    await webhook('payment.failed', { payment: { entity: { id: 'pf', subscription_id: id, created_at: 10 } } });
    expect((await closePeriod(env, '2026-10'))[0].status).toBe('deferred');
    await webhook('payment.captured', { payment: { entity: { id: 'pc', subscription_id: id, created_at: 20 } } });
    expect((await closePeriod(env, '2026-10'))[0].status).toBe('billed');
  });
});

describe('owner actions', () => {
  it('upgrade now, downgrade at cycle end (applied by the webhook)', async () => {
    const id = await subscribed();
    expect(await changePlan(env, 'in_clinic', 'in_growth')).toEqual({ effective: 'now', needsCheckout: false });
    expect(rzp.at(-1)).toMatchObject({ method: 'PATCH', body: { plan_id: 'plan_growth', schedule_change_at: 'now' } });
    expect((await getAccount(env, 'in_clinic'))!.planId).toBe('in_growth');
    expect((await changePlan(env, 'in_clinic', 'in_starter')).effective).toBe('cycle_end');
    let a = (await getAccount(env, 'in_clinic'))!;
    expect([a.planId, a.pendingPlanId]).toEqual(['in_growth', 'in_starter']);
    subs.get(id).plan_id = 'plan_starter';
    await webhook('subscription.charged', { subscription: { entity: { id } } });
    a = (await getAccount(env, 'in_clinic'))!;
    expect([a.planId, a.pendingPlanId]).toEqual(['in_starter', null]);
  });
  it('during the trial, a plan change just switches (no charge)', async () => {
    await assignDefaultPlan(env, 'in_clinic');
    expect(await changePlan(env, 'in_clinic', 'in_growth')).toEqual({ effective: 'now', needsCheckout: false });
    expect(rzp).toHaveLength(0);
  });
  it('cancel at period end keeps it active until Razorpay cancels it', async () => {
    const id = await subscribed();
    expect(await cancelSubscription(env, 'in_clinic')).toEqual({ atPeriodEnd: true, status: 'active' });
    expect(rzp.at(-1)).toMatchObject({ path: `/subscriptions/${id}/cancel`, body: { cancel_at_cycle_end: 1 } });
    let s: any = await billingSummary(env, 'in_clinic', { role: 'owner' });
    expect([s.state, s.cancelAtPeriodEnd, s.nextCharge]).toEqual(['active', true, null]);
    await expect(cancelSubscription(env, 'in_clinic')).rejects.toThrow(/Already/);
    subs.get(id).status = 'cancelled';
    await webhook('subscription.cancelled', { subscription: { entity: { id } } });
    s = await billingSummary(env, 'in_clinic', { role: 'owner' });
    expect([s.state, s.cancelAtPeriodEnd, s.nextAction]).toEqual(['cancelled', false, 'subscribe']);
  });
});

describe('dunning cron', () => {
  it('trial-ending reminder and grace-over notice, once each', async () => {
    await assignPlan(env, 'in_clinic', 'in_starter');
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('UPDATE billing_accounts SET trial_ends_at = ?').bind(now + 2 * DAY).run();
    expect(await runDunning(env, now)).toHaveLength(1);
    expect(await runDunning(env, now)).toHaveLength(0);
    await env.DB.prepare(`UPDATE billing_accounts SET subscription_status = 'pending', past_due_since = ?, razorpay_subscription_id = 's'`).bind(now - 8 * DAY).run();
    expect((await runDunning(env, now))[0]).toMatch(/restricted/);
    expect(emails.at(-1)!.subject).toMatch(/extra minutes paused/);
    expect(await runDunning(env, now)).toHaveLength(0);
  });
});
