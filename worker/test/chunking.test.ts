import { describe, expect, it } from 'vitest';
import {
  popFirstChunk,
  extractCompleteSentences,
  canSpeakToolResultDirectly,
} from '../src/services/turn.service';
import type { ToolResult } from '../src/services/tool-router.service';

// These decide what the caller hears and when, so a bug here either drops
// words, repeats them, or stalls the stream. `extractCompleteSentences` has
// its own coverage in logic.test.ts; this file covers the first-chunk flush,
// the direct-reply predicate, and the streaming invariant across both.

describe('popFirstChunk', () => {
  it('prefers a complete sentence when one is available', () => {
    expect(popFirstChunk('Sure thing. Let me look that up for you now.')?.chunk)
      .toBe('Sure thing.');
  });

  it('waits below the minimum length', () => {
    // Has a comma, but too short to be worth speaking on its own.
    expect(popFirstChunk('Great news, we')).toBeNull();
  });

  it('breaks on a clause boundary past the minimum', () => {
    expect(popFirstChunk('Great news for you today, we have a standard oil change available'))
      .toEqual({ chunk: 'Great news for you today,', rest: 'we have a standard oil change available' });
  });

  it('breaks on a spaced dash', () => {
    // No terminal punctuation — otherwise the sentence branch would win.
    expect(popFirstChunk('That one runs about ninety dollars — want me to check')?.chunk)
      .toBe('That one runs about ninety dollars —');
  });

  it('ignores a clause boundary that lands before the minimum', () => {
    expect(popFirstChunk('Yes, we can absolutely fit you in this week; here are some times')?.chunk)
      .toBe('Yes, we can absolutely fit you in this week;');
  });

  it('does not split inside a decimal price', () => {
    expect(popFirstChunk('The full synthetic oil change is $175.00 all in')).toBeNull();
  });

  it('breaks at a word boundary once the hard cap is passed', () => {
    // No punctuation at all: without the cap, time-to-first-audio is unbounded.
    const long = 'I can definitely help you with that and I will go ahead and pull up '
               + 'everything we have on file for you right now';
    const r = popFirstChunk(long);
    expect(r).not.toBeNull();
    expect(r!.chunk.length).toBeLessThanOrEqual(90);
    expect(long.startsWith(r!.chunk)).toBe(true);
    expect(long[r!.chunk.length]).toBe(' '); // never mid-word
  });

  it('still waits when below the hard cap with no punctuation', () => {
    expect(popFirstChunk('No punctuation here but still fairly short')).toBeNull();
  });
});

/** Mirrors the `drain` closure in runTurn(). */
function drainAll(text: string, tokenSize: number): string[] {
  const emitted: string[] = [];
  let emittedAny = false;
  let buffer = '';

  const drain = (buf: string): string => {
    let rest = buf;
    if (!emittedAny) {
      const first = popFirstChunk(rest);
      if (!first) return rest;
      if (first.chunk) { emitted.push(first.chunk); emittedAny = true; }
      rest = first.rest;
    }
    const { chunks, rest: remainder } = extractCompleteSentences(rest);
    for (const c of chunks) { emitted.push(c); emittedAny = true; }
    return remainder;
  };

  for (let i = 0; i < text.length; i += tokenSize) {
    buffer = drain(buffer + text.slice(i, i + tokenSize));
  }
  const trailing = buffer.trim();
  if (trailing) emitted.push(trailing);
  return emitted;
}

const SAMPLES = [
  'Great news, we have a standard oil change for $49. Want me to check availability?',
  "I've got Tuesday at 10 or Wednesday at 2 — which works for you?",
  'Booked! Your appointment is confirmed for Tue, Mar 3. Reference: a1b2c3d4.',
  'Short one.',
  'No terminal punctuation at all on this one',
  'Mogi Dental hours: Mon: 8am-5pm, Tue: 8am-5pm, Wed: 8am-5pm.',
];

describe('streaming the model output into TTS chunks', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

  it.each([1, 2, 3, 5, 11, 40])('drops and duplicates nothing at %i chars/token', (tokenSize) => {
    for (const sample of SAMPLES) {
      expect(norm(drainAll(sample, tokenSize).join(' '))).toBe(norm(sample));
    }
  });

  it('always emits a non-empty first chunk and terminates', () => {
    for (const sample of SAMPLES) {
      const emitted = drainAll(sample, 1);
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted[0].length).toBeGreaterThan(0);
    }
  });
});

describe('canSpeakToolResultDirectly', () => {
  const ok = (data: unknown): ToolResult => ({ success: true, spoken_response: 'something', data });

  it('always speaks hours directly', () => {
    expect(canSpeakToolResultDirectly('get_business_hours', ok({}))).toBe(true);
  });

  it('speaks availability directly only when there are slots', () => {
    expect(canSpeakToolResultDirectly('check_availability', ok({ offered: [{}] }))).toBe(true);
    expect(canSpeakToolResultDirectly('check_availability', ok({ offered: [] }))).toBe(false);
  });

  it('speaks search directly only on a clean match', () => {
    expect(canSpeakToolResultDirectly('search_services', ok({ matchType: 'match' }))).toBe(true);
    expect(canSpeakToolResultDirectly('search_services', ok({ matchType: 'ambiguous_intent' }))).toBe(false);
    expect(canSpeakToolResultDirectly('search_services', ok({ matchType: 'no_match' }))).toBe(false);
  });

  it('round-trips state-changing and unknown tools through the model', () => {
    expect(canSpeakToolResultDirectly('book_appointment', ok({ id: 'x' }))).toBe(false);
    expect(canSpeakToolResultDirectly('cancel_booking', ok({ id: 'x' }))).toBe(false);
    expect(canSpeakToolResultDirectly('get_upsells', ok({ upsells: [] }))).toBe(false);
  });

  it('never speaks a failed or empty tool result directly', () => {
    expect(canSpeakToolResultDirectly('get_business_hours', { success: false, spoken_response: 'x' })).toBe(false);
    expect(canSpeakToolResultDirectly('get_business_hours', { success: true, spoken_response: '' })).toBe(false);
  });
});
