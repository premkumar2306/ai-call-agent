import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';
import { assignDefaultPlan, billingSummary, startSubscription, upsertPlan } from '../src/services/billing/service';
import { applyOffer, getOffer, offerProblem, openOffers, upsertOffer } from '../src/services/billing/offers';
import { ownerPlans } from '../src/services/billing/lifecycle';
import { estimateCostUsdMicros, usdMicrosToPaise, DEFAULT_COST_RATES } from '../src/services/billing/pricing';

// Clinic plan (0022), offers such as FOUNDING25, setup fee waiving, and the
// "included minutes used" figures on the Billing tab.

const DAY = 86_400;
let env: Env;
let rzp: Array<{ method: string; path: string; body: any }>;

beforeEach(async () => {
  env = { DB: createD1() as any, CACHE: createKV() as any, NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'k' } as Env;
  rzp = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (u.startsWith('https://api.razorpay.com/v1')) {
      const path = u.slice('https://api.razorpay.com/v1'.length);
      rzp.push({ method: init.method ?? 'GET', path, body });
      if (path === '/subscriptions') return Response.json({ id: `sub_${++n}`, status: 'created' });
      return Response.json({ id: `plan_${++n}` });
    }
    return Response.json({ id: 'e' });
  }));
  for (const key of ['in_a', 'in_b', 'in_c']) {
    await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, timezone, currency, country_code, created_at, updated_at) VALUES (?, ?, 'service', '[]', '{}', 'Asia/Kolkata', 'INR', 'IN', 0, 0)`).bind(key, key).run();
  }
  await env.DB.prepare(`INSERT INTO sectors (key, name, model, categories, hours, created_at, updated_at) VALUES ('us_biz', 'US Biz', 'service', '[]', '{}', 0, 0)`).run();
});
afterEach(() => vi.unstubAllGlobals());

describe('Clinic plan and Starter (migration 0022)', () => {
  it('seeds Clinic as the headline: ₹4,999, 800 min, ₹6/min; Starter unchanged', async () => {
    const plans = await ownerPlans(env);
    const clinic = plans.find(p => p.id === 'in_clinic')!;
    const starter = plans.find(p => p.id === 'in_starter')!;
    expect(clinic).toMatchObject({ monthlyFeePaise: 499_900, includedMinutes: 800, overagePaisePerMinute: 600, gstRateBps: 1800, isFeatured: true });
    expect(starter).toMatchObject({ monthlyFeePaise: 299_900, includedMinutes: 300, overagePaisePerMinute: 700, isFeatured: false });
  });
  it('signup can pick a plan; a US business never gets one', async () => {
    expect((await assignDefaultPlan(env, 'in_a', 'in_clinic'))?.planId).toBe('in_clinic');
    expect(await assignDefaultPlan(env, 'us_biz', 'in_clinic')).toBeNull();
    expect(await assignDefaultPlan(env, 'in_b', 'nope')).toBeNull(); // unknown plan, no default → billing stays off
  });
});

describe('offers', () => {
  it('FOUNDING25: free first month (30 days), setup waived, Clinic only, 25 seats', async () => {
    const o = (await getOffer(env, 'FOUNDING25'))!;
    expect(o).toMatchObject({ freeDays: 30, waiveSetupFee: true, planIds: 'in_clinic', maxRedemptions: 25, redeemed: 0 });
    expect(offerProblem(o, 'in_starter')).toMatch(/different plan/);
    expect(offerProblem(o, 'in_clinic')).toBeNull();
    expect((await openOffers(env)).map(x => x.code)).toContain('FOUNDING25');
  });

  it('applying extends the trial to 30 days, once per business, and claims a seat', async () => {
    await assignDefaultPlan(env, 'in_a', 'in_clinic');
    const before = Math.floor(Date.now() / 1000);
    const a = await applyOffer(env, 'in_a', ' founding25 ');
    expect(a.offerCode).toBe('FOUNDING25');
    expect(a.trialEndsAt! - before).toBeGreaterThanOrEqual(30 * DAY - 5);
    expect((await applyOffer(env, 'in_a', 'FOUNDING25')).offerCode).toBe('FOUNDING25'); // idempotent, no second seat
    expect((await getOffer(env, 'FOUNDING25'))!.redeemed).toBe(1);
    const s: any = await billingSummary(env, 'in_a', { role: 'owner' });
    expect(s.state).toBe('trialing');
    expect(s.trialDaysLeft).toBe(30);
    expect(s.offer.code).toBe('FOUNDING25');
  });

  it('the cap holds: the last seat goes once', async () => {
    await upsertOffer(env, 'TWO', { name: 'Two', freeDays: 30, maxRedemptions: 2 });
    for (const b of ['in_a', 'in_b', 'in_c']) await assignDefaultPlan(env, b, 'in_starter');
    await applyOffer(env, 'in_a', 'TWO');
    await applyOffer(env, 'in_b', 'TWO');
    await expect(applyOffer(env, 'in_c', 'TWO')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/taken/) });
    expect((await getOffer(env, 'TWO'))!.redeemed).toBe(2);
    expect((await openOffers(env)).map(x => x.code)).not.toContain('TWO');
  });

  it('refuses without a plan, wrong plan, unknown or expired codes', async () => {
    await expect(applyOffer(env, 'in_a', 'FOUNDING25')).rejects.toMatchObject({ status: 409 });
    await assignDefaultPlan(env, 'in_a', 'in_starter');
    await expect(applyOffer(env, 'in_a', 'FOUNDING25')).rejects.toMatchObject({ message: expect.stringMatching(/different plan/) });
    await expect(applyOffer(env, 'in_a', 'NOPE99')).rejects.toMatchObject({ status: 400 });
    await upsertOffer(env, 'OLD', { name: 'Old', freeDays: 10, expiresAt: 1000 });
    await expect(applyOffer(env, 'in_a', 'OLD')).rejects.toMatchObject({ message: expect.stringMatching(/ended/) });
  });

  it('a setup fee is charged with the first payment unless the offer waives it; the price never changes', async () => {
    await upsertPlan(env, 'in_clinic', { name: 'Clinic', monthlyFeePaise: 499_900, includedMinutes: 800, overagePaisePerMinute: 600, trialDays: 14, setupFeePaise: 200_000, razorpayPlanId: 'plan_clinic' });
    await assignDefaultPlan(env, 'in_a', 'in_clinic');
    await assignDefaultPlan(env, 'in_b', 'in_clinic');
    await applyOffer(env, 'in_b', 'FOUNDING25');
    await startSubscription(env, 'in_a');
    await startSubscription(env, 'in_b');
    const [subA, subB] = rzp.filter(r => r.path === '/subscriptions').map(r => r.body);
    expect(subA.plan_id).toBe('plan_clinic');
    expect(subA.addons).toEqual([{ item: { name: 'Setup', amount: 236_000, currency: 'INR' } }]);
    expect(subB.plan_id).toBe('plan_clinic');
    expect(subB.addons).toBeUndefined();
    expect(subB.notes.offer).toBe('FOUNDING25');
    expect(subB.start_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * DAY);
    const s: any = await billingSummary(env, 'in_b', { role: 'owner' });
    expect(s.plan.setupFee.waived).toBe(true);
    expect(s.plan.monthly.amountPaise).toBe(499_900);
  });

  it('Billing shows included minutes used and left', async () => {
    await assignDefaultPlan(env, 'in_a', 'in_clinic');
    const s: any = await billingSummary(env, 'in_a', { role: 'owner' });
    expect(s.usage).toMatchObject({ includedMinutes: 800, includedMinutesUsed: 0, includedMinutesLeft: 800 });
  });
});

describe('margin: cost per minute from the pricing table', () => {
  // A typical connected minute: caller audio through STT for the whole minute,
  // ~450 characters spoken by the assistant, ~4 LLM turns of ~3K cached prompt
  // + 300 fresh input + 60 output tokens. See docs/pricing.md.
  const minute = (provider: string, stt: string, tts: string) => usdMicrosToPaise(estimateCostUsdMicros({
    channel: 'voice', provider, sttProvider: stt, ttsProvider: tts, durationSeconds: 60, sttSeconds: 60, ttsChars: 450,
    llmModel: 'claude-haiku-5-5', llm: { input: 1200, output: 240, cacheRead: 12_000, cacheWrite: 0 },
  }, DEFAULT_COST_RATES));
  it('stays well under the ₹6/minute overage on every provider mix', () => {
    const englishPlivo = minute('plivo', 'deepgram', 'cartesia');
    const hindiPlivo = minute('plivo', 'sarvam', 'sarvam');
    const englishExotel = minute('exotel', 'deepgram', 'cartesia');
    expect(englishPlivo).toBeLessThan(600);
    expect(hindiPlivo).toBeLessThan(600);
    expect(englishExotel).toBeLessThan(600);
    // Pin the numbers quoted in docs/pricing.md (paise per minute).
    expect({ englishPlivo, hindiPlivo, englishExotel }).toMatchSnapshot();
  });
});
