import { describe, expect, it } from 'vitest';
import {
  billingPeriod, previousPeriod, billableMinutes, computeOverage, gstOn, withGst, usageAlertLevel,
  isValidGstin, gstinCheckChar, gstinStateCode, splitGst, estimateCostUsdMicros, costRates,
  usdMicrosToPaise, DEFAULT_COST_RATES, isPeriod,
} from '../src/services/billing/pricing';
import { verifyRazorpaySignature, checkWebhook, verifyCheckoutSignature } from '../src/services/billing/razorpay';
import { billingState, validatePlanInput } from '../src/services/billing/service';
import { UsageMeter } from '../src/services/billing/meter';
import { razorpayRouter, validateBillingDetails, billingRouter } from '../src/routes/billing';
import type { Env } from '../src/types';

const STARTER = { monthlyFeePaise: 299_900, includedMinutes: 300, overagePaisePerMinute: 700, gstRateBps: 1800 };

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))), b => b.toString(16).padStart(2, '0')).join('');
}

const env = (over: Partial<Env> = {}) => ({ NODE_ENV: 'production', ...over }) as Env;

describe('Razorpay webhook signature', () => {
  const body = '{"entity":"event","event":"subscription.activated","payload":{}}';
  it('accepts hex HMAC-SHA256 of the raw body with the webhook secret', async () => {
    const sig = await hmacHex('whsec', body);
    expect(await verifyRazorpaySignature(body, sig, 'whsec')).toBe(true);
    expect(await verifyRazorpaySignature(body, sig.toUpperCase(), 'whsec')).toBe(true);
  });
  it('rejects tampering, the wrong secret, and a missing signature', async () => {
    const sig = await hmacHex('whsec', body);
    expect(await verifyRazorpaySignature(body + ' ', sig, 'whsec')).toBe(false);
    expect(await verifyRazorpaySignature(body, sig, 'other')).toBe(false);
    expect(await verifyRazorpaySignature(body, null, 'whsec')).toBe(false);
    expect(await verifyRazorpaySignature(body, sig, '')).toBe(false);
  });
  it('fails closed in production without a secret, open only in development', async () => {
    expect(await checkWebhook(env(), body, 'x')).toBe('not_configured');
    expect(await checkWebhook(env({ NODE_ENV: 'development' }), body, undefined)).toBe('ok');
    expect(await checkWebhook(env({ RAZORPAY_WEBHOOK_SECRET: 's' }), body, 'bad')).toBe('bad_signature');
    expect(await checkWebhook(env({ RAZORPAY_WEBHOOK_SECRET: 's' }), body, await hmacHex('s', body))).toBe('ok');
    // A configured secret is enforced even in development.
    expect(await checkWebhook(env({ NODE_ENV: 'development', RAZORPAY_WEBHOOK_SECRET: 's' }), body, 'bad')).toBe('bad_signature');
  });
  it('checkout signature is HMAC(key secret, payment_id|subscription_id)', async () => {
    const sig = await hmacHex('ksecret', 'pay_1|sub_1');
    expect(await verifyCheckoutSignature(env({ RAZORPAY_KEY_SECRET: 'ksecret' }), 'pay_1', 'sub_1', sig)).toBe(true);
    expect(await verifyCheckoutSignature(env({ RAZORPAY_KEY_SECRET: 'ksecret' }), 'pay_2', 'sub_1', sig)).toBe(false);
    expect(await verifyCheckoutSignature(env(), 'pay_1', 'sub_1', sig)).toBe(false);
  });
});

describe('POST /razorpay/webhook', () => {
  const body = JSON.stringify({ event: 'payment.captured', payload: {} });
  const post = (e: Env, headers: Record<string, string> = {}) =>
    razorpayRouter.request('/webhook', { method: 'POST', body, headers }, e);

  it('503s in production when the secret is missing', async () => {
    expect((await post(env())).status).toBe(503);
  });
  it('401s on a bad signature', async () => {
    expect((await post(env({ RAZORPAY_WEBHOOK_SECRET: 's' }), { 'x-razorpay-signature': 'nope' })).status).toBe(401);
  });
  it('accepts a correctly signed event (non-subscription events are ignored)', async () => {
    const res = await post(env({ RAZORPAY_WEBHOOK_SECRET: 's' }), { 'x-razorpay-signature': await hmacHex('s', body) });
    expect(res.status).toBe(200);
  });
});

describe('billing routes need the admin key', () => {
  it('401s without X-Admin-Key', async () => {
    const res = await billingRouter.request('/advanced_vtech', {}, env({ ADMIN_SECRET: 'k' }));
    expect(res.status).toBe(401);
    const wrong = await billingRouter.request('/advanced_vtech', { headers: { 'x-admin-key': 'x' } }, env({ ADMIN_SECRET: 'k' }));
    expect(wrong.status).toBe(401);
  });
});

describe('usage rollup periods and minutes', () => {
  it('rolls up by calendar month in India time', () => {
    // 31 Jan 19:00 UTC is 1 Feb 00:30 IST.
    expect(billingPeriod(new Date('2026-01-31T19:00:00Z'))).toBe('2026-02');
    expect(billingPeriod(new Date('2026-01-31T18:00:00Z'))).toBe('2026-01');
  });
  it('steps back a month across a year boundary', () => {
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(previousPeriod('2026-11')).toBe('2026-10');
  });
  it('validates periods', () => {
    expect(isPeriod('2026-11')).toBe(true);
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('26-1')).toBe(false);
  });
  it('bills every started minute', () => {
    expect(billableMinutes(0)).toBe(0);
    expect(billableMinutes(1)).toBe(1);
    expect(billableMinutes(60)).toBe(1);
    expect(billableMinutes(61)).toBe(2);
    expect(billableMinutes(-5)).toBe(0);
    expect(billableMinutes(NaN)).toBe(0);
  });
});

describe('overage maths', () => {
  it('charges nothing within the included minutes', () => {
    expect(computeOverage(STARTER, 300)).toMatchObject({ overageMinutes: 0, overagePaise: 0, gstPaise: 0, totalPaise: 0 });
  });
  it('charges ₹7/min + 18% GST beyond them', () => {
    // 350 min → 50 over → ₹350 + ₹63 GST = ₹413
    expect(computeOverage(STARTER, 350)).toEqual({
      minutesUsed: 350, includedMinutes: 300, overageMinutes: 50, overagePaise: 35_000, gstPaise: 6_300, totalPaise: 41_300,
    });
  });
  it('rounds GST to the nearest paisa', () => {
    expect(gstOn(299_900, 1800)).toBe(53_982);  // ₹2,999 → ₹539.82 GST
    expect(withGst(299_900, 1800)).toBe(353_882); // ₹3,538.82
    expect(gstOn(1, 1800)).toBe(0);
    expect(gstOn(3, 1800)).toBe(1);
  });
});

describe('soft limits', () => {
  it('alerts at 80% and 100%, never for a plan with no included minutes', () => {
    expect(usageAlertLevel(239, 300)).toBe(0);
    expect(usageAlertLevel(240, 300)).toBe(80);
    expect(usageAlertLevel(299, 300)).toBe(80);
    expect(usageAlertLevel(300, 300)).toBe(100);
    expect(usageAlertLevel(900, 300)).toBe(100);
    expect(usageAlertLevel(5, 0)).toBe(0);
  });
});

describe('GSTIN', () => {
  it('accepts a valid GSTIN and checks the check character', () => {
    const base = '27AAPFU0939F1Z';
    const valid = base + gstinCheckChar(base);
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin(valid.toLowerCase())).toBe(true);
    const wrong = base + (valid[14] === 'A' ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
    expect(isValidGstin('')).toBe(false);
  });
  it('matches a published GSTIN', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
  });
  it('splits GST: same state CGST+SGST, otherwise IGST', () => {
    expect(gstinStateCode('27AAPFU0939F1ZV')).toBe('27');
    expect(splitGst(6_301, '27', '27')).toEqual({ cgst: 3_150, sgst: 3_151, igst: 0 });
    expect(splitGst(6_300, '27', '29')).toEqual({ cgst: 0, sgst: 0, igst: 6_300 });
    expect(splitGst(6_300, null, '29')).toEqual({ cgst: 0, sgst: 0, igst: 6_300 });
  });
});

describe('provider cost estimate', () => {
  it('adds telephony, STT, TTS and model tokens', () => {
    const micros = estimateCostUsdMicros({
      channel: 'voice', provider: 'twilio', durationSeconds: 90, sttSeconds: 90, ttsChars: 1000,
      llmModel: 'claude-haiku-5-5', llm: { input: 10_000, output: 1_000, cacheRead: 100_000, cacheWrite: 2_000 },
    });
    const r = DEFAULT_COST_RATES;
    const expected = 2 * 0.0085 + 90 * r.sttPerSecond + 1000 * r.ttsPerChar
      + (10_000 * 0.10 + 1_000 * 0.50 + 100_000 * 0.01 + 2_000 * 0.125) / 1e6;
    expect(micros).toBe(Math.round(expected * 1e6));
  });
  it('falls back to default model rates and merges overrides', () => {
    const rates = costRates('{"usdToInr": 90, "telephonyPerMinute": {"exotel": 0.01}}');
    expect(rates.usdToInr).toBe(90);
    expect(rates.telephonyPerMinute.exotel).toBe(0.01);
    expect(rates.telephonyPerMinute.twilio).toBe(0.0085);
    expect(costRates('not json')).toBe(DEFAULT_COST_RATES);
    expect(usdMicrosToPaise(1_000_000, rates)).toBe(9_000);
    const unknown = estimateCostUsdMicros({ channel: 'whatsapp', durationSeconds: 0, sttSeconds: 0, ttsChars: 0, llmModel: 'x', llm: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(unknown).toBe(100_000);
  });
});

describe('UsageMeter', () => {
  it('accumulates TTS characters and Anthropic usage', () => {
    const m = new UsageMeter();
    m.addTts('Hello');
    m.addTts('there!');
    m.addLlm('claude-haiku-5-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: null });
    m.addLlm('claude-haiku-5-5', { input_tokens: 1, output_tokens: 2 });
    m.addLlm(undefined, null);
    expect(m.ttsChars).toBe(11);
    expect(m.llmModel).toBe('claude-haiku-5-5');
    expect(m.llm).toEqual({ input: 11, output: 7, cacheRead: 100, cacheWrite: 0 });
  });
});

describe('billing state', () => {
  const now = 1_800_000_000;
  it('is off without a plan (the default: nothing is billed)', () => {
    expect(billingState(null, now)).toBe('off');
    expect(billingState({ planId: null, trialEndsAt: null, subscriptionStatus: 'active' }, now)).toBe('off');
  });
  it('follows the trial and the Razorpay subscription status', () => {
    expect(billingState({ planId: 'p', trialEndsAt: now + 10, subscriptionStatus: null }, now)).toBe('trialing');
    expect(billingState({ planId: 'p', trialEndsAt: now - 10, subscriptionStatus: null }, now)).toBe('unpaid');
    expect(billingState({ planId: 'p', trialEndsAt: now - 10, subscriptionStatus: 'created' }, now)).toBe('unpaid');
    expect(billingState({ planId: 'p', trialEndsAt: now + 10, subscriptionStatus: 'authenticated' }, now)).toBe('active');
    expect(billingState({ planId: 'p', trialEndsAt: null, subscriptionStatus: 'active' }, now)).toBe('active');
    expect(billingState({ planId: 'p', trialEndsAt: null, subscriptionStatus: 'halted' }, now)).toBe('past_due');
    expect(billingState({ planId: 'p', trialEndsAt: null, subscriptionStatus: 'cancelled' }, now)).toBe('cancelled');
  });
});

describe('input validation', () => {
  it('validates plans', () => {
    expect(validatePlanInput({ name: 'Starter', ...STARTER })).toMatchObject({ name: 'Starter', includedMinutes: 300 });
    expect(validatePlanInput({ name: 'x', ...STARTER, includedMinutes: -1 })).toMatch(/includedMinutes/);
    expect(validatePlanInput({ name: 'x', ...STARTER, overagePaisePerMinute: 7.5 })).toMatch(/overagePaisePerMinute/);
    expect(validatePlanInput({ ...STARTER })).toMatch(/name/);
  });
  it('validates billing details', () => {
    expect(validateBillingDetails({ gstin: ' 27aapfu0939f1zv ', postalCode: '400001', billingEmail: 'a@b.in' }))
      .toEqual({ gstin: '27AAPFU0939F1ZV', postalCode: '400001', billingEmail: 'a@b.in' });
    expect(validateBillingDetails({ gstin: '27AAPFU0939F1ZA' })).toMatch(/GSTIN/);
    expect(validateBillingDetails({ postalCode: '012345' })).toMatch(/PIN/);
    expect(validateBillingDetails({ billingEmail: 'nope' })).toMatch(/email/);
    expect(validateBillingDetails({ gstin: '' })).toEqual({ gstin: null });
  });
});
