import { describe, expect, it } from 'vitest';
import { isDefaultTuning, parseTuningInput, resolveTuning } from '../src/services/voice-language';
import { cartesiaStart } from '../src/durable-objects/tts-cartesia';
import { sarvamTtsBody } from '../src/durable-objects/tts-sarvam';

describe('resolveTuning', () => {
  it('a US business (or none) is exactly today: normal everything, nothing sent', () => {
    for (const m of [null, undefined, { countryCode: 'US' }, {}]) {
      const t = resolveTuning(m);
      expect(t).toMatchObject({ speakingRate: 'normal', rate: 1, interruption: 'normal', endpointing: 'normal', noiseCancellation: false });
      expect(isDefaultTuning(t)).toBe(true);
    }
  });
  it('an Indian business with nothing chosen is slow / low / patient / noise reduction on', () => {
    expect(resolveTuning({ countryCode: 'IN' })).toMatchObject({ speakingRate: 'slow', rate: 0.9, interruption: 'low', endpointing: 'patient', noiseCancellation: true });
  });
  it('explicit choices win in both directions', () => {
    expect(resolveTuning({ countryCode: 'IN', tuning: { speakingRate: 'normal', interruption: 'high', endpointing: 'normal', noiseCancellation: false } }))
      .toMatchObject({ rate: 1, interruption: 'high', endpointing: 'normal', noiseCancellation: false });
    expect(resolveTuning({ countryCode: 'US', tuning: { speakingRate: 'fast', noiseCancellation: true } })).toMatchObject({ rate: 1.1, noiseCancellation: true, interruption: 'normal' });
  });
});

describe('parseTuningInput', () => {
  it('accepts the four fields and null (automatic); rejects anything else', () => {
    expect(parseTuningInput({ speaking_rate: 'slow', interruption_sensitivity: 'low', endpointing: 'patient', noise_cancellation: true })).toEqual({ ok: true, value: { speakingRate: 'slow', interruptionSensitivity: 'low', endpointing: 'patient', noiseCancellation: true } });
    expect(parseTuningInput({ speaking_rate: null, noise_cancellation: null })).toEqual({ ok: true, value: { speakingRate: null, noiseCancellation: null } });
    expect(parseTuningInput({})).toEqual({ ok: true, value: {} });
    for (const bad of [{ speaking_rate: 'warp' }, { interruption_sensitivity: 'max' }, { endpointing: 'slow' }, { noise_cancellation: 'yes' }]) expect(parseTuningInput(bad).ok).toBe(false);
  });
});

describe('voice requests', () => {
  it('Cartesia: speed goes in generation_config only when it is not 1', async () => {
    const bodies: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response('x'); }) as any;
    try {
      await cartesiaStart({ apiKey: 'k' }, 'hi');
      await cartesiaStart({ apiKey: 'k', speed: 1 }, 'hi');
      await cartesiaStart({ apiKey: 'k', speed: 0.9 }, 'hi');
    } finally { globalThis.fetch = orig; }
    expect(bodies[0].generation_config).toBeUndefined();
    expect(bodies[1].generation_config).toBeUndefined();
    expect(bodies[2].generation_config).toEqual({ speed: 0.9 });
  });
  it('Sarvam: pace only when set', () => {
    expect(sarvamTtsBody({ apiKey: 'k', language: 'hi' }, 'x').pace).toBeUndefined();
    expect(sarvamTtsBody({ apiKey: 'k', language: 'hi', pace: 0.9 }, 'x').pace).toBe(0.9);
  });
});
