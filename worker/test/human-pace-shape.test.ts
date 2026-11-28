import { describe, expect, it } from 'vitest';
import { sarvamPace, sarvamTtsBody, SARVAM_DEFAULT_PACE } from '../src/durable-objects/tts-sarvam';
import { createTts } from '../src/durable-objects/voice-providers';
import { buildAgentRules, INDIA_VOICE_RULES } from '../src/services/turn.service';

describe('Sarvam pace', () => {
  it('defaults to a calmer pace than the provider default, and accepts a sane override', () => {
    expect(SARVAM_DEFAULT_PACE).toBeLessThan(1);
    expect(sarvamPace(undefined)).toBe(SARVAM_DEFAULT_PACE);
    expect(sarvamPace('')).toBe(SARVAM_DEFAULT_PACE);
    expect(sarvamPace('0.9')).toBe(0.9);
    expect(sarvamPace('0.1')).toBe(SARVAM_DEFAULT_PACE);   // out of range
    expect(sarvamPace('fast')).toBe(SARVAM_DEFAULT_PACE);
  });
  it('is sent in every Sarvam TTS request', async () => {
    const sent: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response('', { status: 500 }); }) as any;
    try {
      const tts = createTts({ SARVAM_API_KEY: 'k' } as any, { language: 'hi', sttProvider: 'sarvam', ttsProvider: 'sarvam' } as any);
      await tts.start('hello');
      expect(sent[0].pace).toBe(SARVAM_DEFAULT_PACE);
    } finally { globalThis.fetch = orig; }
    expect(sarvamTtsBody({ apiKey: 'k', language: 'hi', pace: 0.9 }, 'x').pace).toBe(0.9);
  });
});

describe('India voice rules', () => {
  it('are added for Indian businesses on the phone only', () => {
    const base = buildAgentRules('x', 'Clinic', 'voice');
    const india = buildAgentRules('x', 'Clinic', 'voice', undefined, 'en', 'Avery', '', true);
    expect(india).toContain(INDIA_VOICE_RULES);
    expect(india).toContain('half past ten');
    expect(base).not.toContain('half past ten');
    expect(buildAgentRules('x', 'Clinic', 'chat', undefined, 'en', 'Avery', '', true)).not.toContain('half past ten');
  });
});

describe('Sarvam pace with the business speed setting', () => {
  it('multiplies the calibrated base pace, so slow is slower than normal', async () => {
    const sent: number[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body).pace); return new Response('', { status: 500 }); }) as any;
    try {
      const v = { language: 'hi', sttProvider: 'sarvam', ttsProvider: 'sarvam' } as any;
      await createTts({ SARVAM_API_KEY: 'k' } as any, v).start('x');
      await createTts({ SARVAM_API_KEY: 'k' } as any, v, 0.9).start('x');
      await createTts({ SARVAM_API_KEY: 'k' } as any, v, 1.1).start('x');
    } finally { globalThis.fetch = orig; }
    expect(sent).toEqual([0.8, 0.72, 0.88]);
  });
});
