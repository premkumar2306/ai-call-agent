import { beforeEach, describe, expect, it } from 'vitest';
import {
  billableMinutes, costParts, costRates, DEFAULT_COST_RATES, estimateCostUsdMicros, usdMicrosToPaise, type UsageForCost,
} from '../src/services/billing/pricing';
import { assignPlan, callCosts, modelSummary, recordUsage, upsertPlan } from '../src/services/billing/service';
import { turnCost, type TurnRow } from '../src/services/turn-timeline';
import { sttModelFor, ttsModelFor } from '../src/services/voice-models';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';

// Each call's cost must equal Σ(rate × measured usage). The expected numbers
// below are written out from the list prices (not read back from the code), so
// a silently changed rate fails here.

let env: Env;
beforeEach(() => { env = { DB: createD1() as unknown as D1Database, CACHE: createKV() as unknown as KVNamespace } as Env; });

const NO_LLM = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usd = (u: UsageForCost) => estimateCostUsdMicros(u) / 1e6;

describe('carrier minutes', () => {
  it('bills every started minute, for every carrier (the rounding the code assumes)', () => {
    expect([0, 1, 59, 60, 61, 179, 180, 181].map(billableMinutes)).toEqual([0, 1, 1, 1, 2, 3, 3, 4]);
  });
  it.each([['twilio', 0.0085], ['exotel', 0.006], ['plivo', 0.006], ['web', 0]])('%s = $%s per started minute', (provider, perMin) => {
    const u: UsageForCost = { channel: 'voice', provider, durationSeconds: 125, sttSeconds: 0, ttsChars: 0, llm: NO_LLM };
    expect(usd(u)).toBeCloseTo(3 * perMin, 6); // 125 s → 3 billed minutes
  });
});

describe('cost = Σ(rate × usage)', () => {
  it('Deepgram + Cartesia + Haiku 5.5 on Twilio, with input, output and cached tokens split', () => {
    const u: UsageForCost = {
      channel: 'voice', provider: 'twilio', sttProvider: 'deepgram', ttsProvider: 'cartesia', llmModel: 'claude-haiku-5-5',
      durationSeconds: 61, sttSeconds: 61, ttsChars: 1000, llm: { input: 10_000, output: 1_000, cacheRead: 50_000, cacheWrite: 2_000 },
    };
    const phone = 2 * 0.0085;
    const stt = 61 * (0.0077 / 60);
    const tts = 1000 * 0.00003;
    const llm = 10_000 * 0.10e-6 + 1_000 * 0.50e-6 + 50_000 * 0.01e-6 + 2_000 * 0.125e-6;
    const parts = costParts(u);
    expect(parts.telephony / 1e6).toBeCloseTo(phone, 5);
    expect(parts.stt / 1e6).toBeCloseTo(stt, 5);
    expect(parts.tts / 1e6).toBeCloseTo(tts, 5);
    expect(parts.llm / 1e6).toBeCloseTo(llm, 5);
    expect(usd(u)).toBeCloseTo(phone + stt + tts + llm, 5);
    // The four parts add up to the total (to rounding of each part to a micro-dollar).
    expect(Math.abs(parts.telephony + parts.stt + parts.tts + parts.llm - estimateCostUsdMicros(u))).toBeLessThanOrEqual(2);
  });
  it('Sarvam speech on Exotel (Hindi line)', () => {
    const u: UsageForCost = {
      channel: 'voice', provider: 'exotel', sttProvider: 'sarvam', ttsProvider: 'sarvam', llmModel: 'claude-haiku-5-5',
      durationSeconds: 120, sttSeconds: 120, ttsChars: 1500, llm: { input: 4000, output: 400, cacheRead: 0, cacheWrite: 0 },
    };
    const expected = 2 * 0.006 + 120 * (30 / 88 / 3600) + 1500 * (15 / 88 / 10_000) + 4000 * 0.10e-6 + 400 * 0.50e-6;
    expect(usd(u)).toBeCloseTo(expected, 5);
  });
  it('an unknown LLM model, STT or TTS provider falls back to the default rate, never zero', () => {
    const u: UsageForCost = { channel: 'voice', provider: 'twilio', sttProvider: 'x', ttsProvider: 'y', llmModel: 'nope', durationSeconds: 60, sttSeconds: 60, ttsChars: 100, llm: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(usd(u)).toBeCloseTo(0.0085 + 60 * (0.0077 / 60) + 100 * 0.00003 + 0.10, 5);
  });
  it('BILLING_COST_RATES overrides change the cost', () => {
    const r = costRates(JSON.stringify({ usdToInr: 100 }));
    expect(usdMicrosToPaise(1_000_000, r)).toBe(10_000);
    expect(usdMicrosToPaise(1_000_000, DEFAULT_COST_RATES)).toBe(8_800);
  });
});

describe('per-turn costs vs the per-call total', () => {
  const turn = (n: number, stt: number, chars: number, llm: { in: number; out: number; cr: number; cw: number }, provider = 'deepgram', tts = 'cartesia'): TurnRow => ({
    call_sid: 'C', business_type: 'biz', provider: 'twilio', turn_n: n, started_at: 0, end_signal: 'x', endpointing_ms: 250,
    t_speech_end: 0, t_final: 0, t_first_phrase: 0, t_first_tts: 0, t_first_sent: 0, t_first_filler_sent: null, t_playback_done: 0,
    tools: [], stt_audio_s: stt, tts_chars: chars, reply_used_cached_audio: false, audio_cache: null,
    llm_in: llm.in, llm_out: llm.out, llm_cache_read: llm.cr, llm_cache_write: llm.cw,
    barge_in: false, outcome: 'done', stt_provider: provider, tts_provider: tts, llm_model: 'claude-haiku-5-5', sync_dtmf_at: null,
  });
  const turns = [turn(1, 8.5, 140, { in: 3000, out: 90, cr: 0, cw: 2500 }), turn(2, 12, 260, { in: 500, out: 150, cr: 2500, cw: 0 }), turn(3, 6.25, 90, { in: 600, out: 60, cr: 2500, cw: 0 })];

  it('call total = Σ turns + phone line + speech outside the turns (greeting, filler, prompts, listening between turns)', () => {
    const rates = DEFAULT_COST_RATES;
    const sumTurns = turns.reduce((n, t) => n + turnCost(t, rates).total_usd_micros, 0);
    // Whole call: 70 s on Twilio. All of it is streamed to STT; the greeting + a silence prompt (180 chars)
    // are synthesized outside any turn, so only the call total has them.
    const turnChars = turns.reduce((n, t) => n + t.tts_chars, 0);
    const sumLlm = (k: 'llm_in' | 'llm_out' | 'llm_cache_read' | 'llm_cache_write') => turns.reduce((n, t) => n + t[k], 0);
    const call: UsageForCost = {
      channel: 'voice', provider: 'twilio', sttProvider: 'deepgram', ttsProvider: 'cartesia', llmModel: 'claude-haiku-5-5',
      durationSeconds: 70, sttSeconds: 70, ttsChars: turnChars + 180,
      llm: { input: sumLlm('llm_in'), output: sumLlm('llm_out'), cacheRead: sumLlm('llm_cache_read'), cacheWrite: sumLlm('llm_cache_write') },
    };
    const callTotal = estimateCostUsdMicros(call, rates);
    const phone = costParts(call, rates).telephony;
    const outsideStt = Math.round((70 - turns.reduce((n, t) => n + t.stt_audio_s, 0)) * (0.0077 / 60) * 1e6);
    const outsideTts = Math.round(180 * 0.00003 * 1e6);
    // LLM tokens, STT seconds and TTS characters inside turns reconcile exactly (±1 micro-dollar per rounded part per turn).
    expect(Math.abs(callTotal - (sumTurns + phone + outsideStt + outsideTts))).toBeLessThanOrEqual(3 * turns.length + 3);
    // The gap is real and positive: turns alone understate the call.
    expect(callTotal).toBeGreaterThan(sumTurns + phone);
  });

  it('per-turn tokens, characters and seconds are priced like the call-level totals', () => {
    const t = turns[0];
    const c = turnCost(t, DEFAULT_COST_RATES);
    expect(c.stt_usd_micros / 1e6).toBeCloseTo(8.5 * 0.0077 / 60, 6);
    expect(c.tts_usd_micros / 1e6).toBeCloseTo(140 * 0.00003, 6);
    expect(c.llm_usd_micros / 1e6).toBeCloseTo(3000 * 0.10e-6 + 90 * 0.50e-6 + 2500 * 0.125e-6, 6);
  });
});

describe('model ids come from the code config', () => {
  it('STT', () => {
    expect(sttModelFor({} as Env, 'deepgram', 'en')).toBe('nova-3');
    expect(sttModelFor({ DG_MODEL: 'flux-general-en' } as Env, 'deepgram', 'en')).toBe('flux-general-en');
    expect(sttModelFor({ DG_MODEL: 'flux-general-en' } as Env, 'deepgram', 'hi')).toBe('nova-3'); // flux is English-only
    expect(sttModelFor({} as Env, 'sarvam', 'hi')).toBe('saaras:v3');
    expect(sttModelFor({ SARVAM_STT_MODEL: 'saaras:v4' } as Env, 'sarvam', 'hi')).toBe('saaras:v4');
  });
  it('TTS', () => {
    expect(ttsModelFor({} as Env, 'cartesia')).toBe('sonic-3.5');
    expect(ttsModelFor({ CARTESIA_MODEL_ID: 'sonic-3' } as Env, 'cartesia')).toBe('sonic-3');
    expect(ttsModelFor({} as Env, 'sarvam')).toBe('bulbul:v3');
  });
});

describe('cost page rows (callCosts)', () => {
  const t0 = 1_800_000_000;
  const period = new Date(t0 * 1000).toISOString().slice(0, 7);
  const starter = { name: 'Starter', currency: 'INR', monthlyFeePaise: 299_900, includedMinutes: 300, overagePaisePerMinute: 700, trialDays: 0, gstRateBps: 1800, isActive: true } as any;

  it("the owner's screenshot: a 3-minute call costs ₹9.71 (phone ₹2.24, speech ₹7.31, AI ₹0.16), earns ₹29.99, margin ₹20.28", async () => {
    await upsertPlan(env, 'starter', starter);
    await assignPlan(env, 'biz', 'starter');
    await recordUsage(env, {
      businessType: 'biz', channel: 'voice', provider: 'twilio', sttProvider: 'deepgram', ttsProvider: 'cartesia',
      sttModel: 'nova-3', ttsModel: 'sonic-3.5', sourceId: 'CA3', startedAt: t0, durationSeconds: 180, sttSeconds: 180,
      ttsChars: 1998, llmModel: 'claude-haiku-5-5', llm: { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 0 },
    });
    const { rows } = await callCosts(env, 'biz', period);
    const r = rows[0];
    expect([r.phonePaise, r.speechPaise, r.aiPaise, r.costPaise, r.revenuePaise, r.marginPaise]).toEqual([224, 731, 16, 971, 2999, 2028]);
    expect(r.sttPaise + r.ttsPaise).toBe(r.speechPaise);
    expect(r.sttPaise).toBe(203); // 180 s × $0.0077/min × ₹88
    expect(r.phonePaise + r.sttPaise + r.ttsPaise + r.aiPaise).toBe(r.costPaise);
    expect([r.sttProvider, r.sttModel, r.ttsProvider, r.ttsModel, r.llmModel]).toEqual(['deepgram', 'nova-3', 'cartesia', 'sonic-3.5', 'claude-haiku-5-5']);
  });

  it('margin = revenue − cost; revenue = fee over included minutes, then overage; rows reconcile and the by-model summary adds up', async () => {
    await upsertPlan(env, 'tiny', { ...starter, monthlyFeePaise: 100_000, includedMinutes: 2, overagePaisePerMinute: 500 });
    await assignPlan(env, 'biz', 'tiny');
    const llm = { input: 2000, output: 300, cacheRead: 1000, cacheWrite: 0 };
    await recordUsage(env, { businessType: 'biz', channel: 'voice', provider: 'exotel', sttProvider: 'sarvam', ttsProvider: 'sarvam', sttModel: 'saaras:v3', ttsModel: 'bulbul:v3', sourceId: 'H1', startedAt: t0, durationSeconds: 90, sttSeconds: 90, ttsChars: 400, llmModel: 'claude-haiku-5-5', llm });
    await recordUsage(env, { businessType: 'biz', channel: 'voice', provider: 'twilio', sttProvider: 'deepgram', ttsProvider: 'cartesia', sttModel: 'nova-3', ttsModel: 'sonic-3.5', sourceId: 'E1', startedAt: t0 + 600, durationSeconds: 150, sttSeconds: 150, ttsChars: 600, llmModel: 'claude-haiku-5-5', llm });
    const { rows, byModel } = await callCosts(env, 'biz', period);
    expect(rows.map(r => r.revenuePaise)).toEqual([1500, 100_000]) // newest first;
    for (const r of rows) {
      expect(r.marginPaise).toBe(r.revenuePaise - r.costPaise);
      expect(r.phonePaise + r.sttPaise + r.ttsPaise + r.aiPaise).toBe(r.costPaise);
    }
    const label = (g: { kind: string; provider: string | null; model: string | null }) => `${g.kind}:${g.provider}:${g.model}`;
    expect(byModel.map(label).sort()).toEqual([
      'llm:anthropic:claude-haiku-5-5', 'stt:deepgram:nova-3', 'stt:sarvam:saaras:v3', 'tts:cartesia:sonic-3.5', 'tts:sarvam:bulbul:v3',
    ]);
    const kindTotal = (k: string) => byModel.filter(g => g.kind === k).reduce((n, g) => n + g.costPaise, 0);
    expect(kindTotal('stt')).toBe(rows.reduce((n, r) => n + r.sttPaise, 0));
    expect(kindTotal('tts')).toBe(rows.reduce((n, r) => n + r.ttsPaise, 0));
    expect(kindTotal('llm')).toBe(rows.reduce((n, r) => n + r.aiPaise, 0));
    const llmG = byModel.find(g => g.kind === 'llm')!;
    expect([llmG.inputTokens, llmG.outputTokens, llmG.cacheTokens, llmG.calls]).toEqual([4000, 600, 2000, 2]);
    const dg = byModel.find(g => g.model === 'nova-3')!;
    expect([dg.seconds, dg.callSeconds]).toEqual([150, 150]);
    expect(dg.costPaisePerMinute).toBe(Math.round(dg.costPaise / 2.5));
  });

  it('modelSummary ignores in-app test calls and WhatsApp', () => {
    const base = { sourceId: 'x', id: 'x', billable: true, startedAt: 0, durationSeconds: 60, billableMinutes: 1, llmModel: 'm', costPaise: 0, phonePaise: 0, speechPaise: 0, sttPaise: 0, ttsPaise: 0, aiPaise: 0, revenuePaise: 0, marginPaise: 0, sttProvider: null, sttModel: null, ttsProvider: null, ttsModel: null, sttSeconds: 0, ttsChars: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCacheTokens: 0 };
    expect(modelSummary([{ ...base, channel: 'voice', provider: 'web' }, { ...base, channel: 'whatsapp', provider: null }])).toEqual([]);
  });
});
