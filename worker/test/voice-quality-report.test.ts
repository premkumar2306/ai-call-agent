import { describe, expect, it } from 'vitest';
import { renderReport, summariseCall } from '../scripts/voice-quality-report-lib.mjs';

const turn = (o: Record<string, unknown>) => ({ barge_in: false, outcome: 'done', endpointing_ms: 250, t_speech_end: 0, t_first_sent: 900, t_playback_done: 5900, tts_chars: 100, reply_used_cached_audio: false, barge: null, ...o });

describe('voice quality report', () => {
  const data = { provider: 'plivo', end_reason: 'caller_hangup', duration_seconds: 80, turns: [
    turn({}),
    turn({ barge_in: true, outcome: 'interrupted', barge: { reason: 'stop_word', word: 'ruko-ek-minute-please', withdrawn: false, skipped: [{ reason: 'echo', words: 3, word: 'we' }] } }),
    turn({ barge_in: true, outcome: 'interrupted', barge: { reason: 'enough_words', withdrawn: true, skipped: [{ reason: 'backchannel', words: 1, word: 'haan' }] } }),
  ] };
  it('counts barge-ins by reason, withdrawn replies, echo filtering, gap and speaking rate', () => {
    const c = summariseCall({ call_sid: 'CAxxxxxxxx12345678' }, data, 'hi-en');
    expect(c).toMatchObject({ callId: '12345678', carrier: 'plivo', language: 'hi-en', endReason: 'caller_hangup', turns: 3, bargeIns: 2, withdrawn: 1, echoFiltered: 1, avgEndpointingMs: 250, gapP50Ms: 900 });
    expect(c.reasons).toEqual({ '1-word stop': 1, 'interim words': 1 });
    expect(c.charsPerSecP50).toBeCloseTo(20, 5);
    expect(Object.keys(c.triggers)).toEqual(['ruko-ek-minu']);   // truncated to 12 characters
  });
  it('prints aggregates only', () => {
    const text = renderReport({ business: 'jd_dental', days: 7, settings: { speakingRate: 'slow', interruptionSensitivity: 'low', endpointing: 'patient', noiseCancellation: true }, calls: [summariseCall({ call_sid: 'a12345678' }, data, 'hi-en')] });
    expect(text).toMatch(/TOTALS {2}1 calls, 3 caller turns/);
    expect(text).toMatch(/withdrawn by the 2-second rule: 1/);
    expect(text).toMatch(/ruko-ek-minu ×1/);
  });
});
