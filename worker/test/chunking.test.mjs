/**
 * Logic tests for the TTS chunking helpers in turn.service.ts.
 *
 * These are the pieces that decide what the caller hears and when, so a bug
 * here either drops words, repeats them, or stalls the stream. No live
 * credentials are needed — the functions are pure.
 *
 *   node --test test/chunking.test.mjs
 *
 * The TypeScript source is transpiled through esbuild (already a wrangler
 * dependency) into a temp ESM module, so the tests run against the real
 * implementation rather than a copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
// Must live inside the project so Node resolves the externals below against
// worker/node_modules rather than the system temp directory.
const outDir = join(__dir, '.tmp-chunking');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'turn.mjs');

await build({
  entryPoints: [join(__dir, '..', 'src', 'services', 'turn.service.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  // Nothing under test touches these; keeping them external avoids dragging
  // the SDK and drizzle into the bundle.
  external: ['@anthropic-ai/sdk', 'drizzle-orm', 'drizzle-orm/*', 'cloudflare:workers'],
  logLevel: 'silent',
});

const { popSentence, popFirstChunk, extractCompleteSentences, canSpeakToolResultDirectly } =
  await import(pathToFileURL(outFile).href);

process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));

// ── popSentence ────────────────────────────────────────────────────────────

test('popSentence returns null until terminal punctuation arrives', () => {
  assert.equal(popSentence('Great news, we have'), null);
  assert.equal(popSentence('No punctuation here at all'), null);
});

test('popSentence pops one sentence and leaves the remainder', () => {
  const r = popSentence('We have it. Want a slot?');
  assert.deepEqual(r, { chunk: 'We have it.', rest: 'Want a slot?' });
});

test('popSentence handles a sentence at end-of-buffer', () => {
  assert.deepEqual(popSentence('All booked!'), { chunk: 'All booked!', rest: '' });
});

// ── popFirstChunk ──────────────────────────────────────────────────────────

test('popFirstChunk prefers a complete sentence when one is available', () => {
  const r = popFirstChunk('Sure thing. Let me look that up for you now.');
  assert.equal(r.chunk, 'Sure thing.');
});

test('popFirstChunk waits below the minimum length', () => {
  // Has a comma, but too short to be worth speaking on its own.
  assert.equal(popFirstChunk('Great news, we'), null);
});

test('popFirstChunk breaks on a clause boundary past the minimum', () => {
  const r = popFirstChunk('Great news for you today, we have a standard oil change available');
  assert.ok(r, 'expected a chunk');
  assert.equal(r.chunk, 'Great news for you today,');
  assert.equal(r.rest, 'we have a standard oil change available');
});

test('popFirstChunk breaks on a spaced dash', () => {
  // No terminal punctuation — otherwise popSentence would (correctly) win.
  const r = popFirstChunk('That one runs about ninety dollars — want me to check');
  assert.ok(r);
  assert.equal(r.chunk, 'That one runs about ninety dollars —');
});

test('popFirstChunk ignores a clause boundary that lands before the minimum', () => {
  // The comma at index 3 is too early; the next boundary is past the minimum.
  const r = popFirstChunk('Yes, we can absolutely fit you in this week; here are some times');
  assert.ok(r);
  assert.equal(r.chunk, 'Yes, we can absolutely fit you in this week;');
});

test('popFirstChunk breaks at a word boundary once the hard cap is passed', () => {
  // No punctuation at all: without the cap, time-to-first-audio is unbounded.
  const long = 'I can definitely help you with that and I will go ahead and pull up '
             + 'everything we have on file for you right now';
  const r = popFirstChunk(long);
  assert.ok(r, 'expected a chunk past the hard cap');
  assert.ok(r.chunk.length <= 90, `chunk too long: ${r.chunk.length}`);
  assert.ok(!r.chunk.endsWith(' '), 'chunk should be trimmed');
  // Must break between words, never mid-word.
  assert.ok(long.startsWith(r.chunk), 'chunk must be a prefix of the input');
  assert.ok(long[r.chunk.length] === ' ', 'must break at a word boundary');
});

test('popFirstChunk still waits when below the hard cap with no punctuation', () => {
  assert.equal(popFirstChunk('No punctuation here but still fairly short'), null);
});

test('popFirstChunk does not split inside a decimal price', () => {
  // '$175.00' must not be treated as a sentence end mid-number.
  const r = popFirstChunk('The full synthetic oil change is $175.00 all in');
  assert.equal(r, null);
});

// ── extractCompleteSentences ───────────────────────────────────────────────

test('extractCompleteSentences pulls every finished sentence', () => {
  const { chunks, rest } = extractCompleteSentences('One. Two! Three? And a half');
  assert.deepEqual(chunks, ['One.', 'Two!', 'Three?']);
  assert.equal(rest, 'And a half');
});

// ── streaming invariant: nothing dropped, nothing duplicated ───────────────

/** Mirrors the `drain` closure in runTurn(). */
function drainAll(text, { tokenSize = 3 } = {}) {
  const emitted = [];
  let emittedAny = false;
  let buffer = '';

  const drain = (buf) => {
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

test('streaming never drops or duplicates text, at any token granularity', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const sample of SAMPLES) {
    for (const tokenSize of [1, 2, 3, 5, 11, 40]) {
      const emitted = drainAll(sample, { tokenSize });
      assert.equal(
        norm(emitted.join(' ')), norm(sample),
        `mismatch for tokenSize=${tokenSize} on: ${sample}`,
      );
    }
  }
});

test('the first emitted chunk is never empty and the stream always terminates', () => {
  for (const sample of SAMPLES) {
    const emitted = drainAll(sample, { tokenSize: 1 });
    assert.ok(emitted.length > 0, `nothing emitted for: ${sample}`);
    assert.ok(emitted[0].length > 0, `empty first chunk for: ${sample}`);
  }
});

// ── canSpeakToolResultDirectly ─────────────────────────────────────────────

const ok = (data) => ({ success: true, spoken_response: 'something', data });

test('hours can always be spoken directly', () => {
  assert.equal(canSpeakToolResultDirectly('get_business_hours', ok({})), true);
});

test('availability is spoken directly only when there are slots', () => {
  assert.equal(canSpeakToolResultDirectly('check_availability', ok({ slots: [{}] })), true);
  assert.equal(canSpeakToolResultDirectly('check_availability', ok({ slots: [] })), false);
});

test('search is spoken directly only on a clean match', () => {
  assert.equal(canSpeakToolResultDirectly('search_services', ok({ matchType: 'match' })), true);
  assert.equal(canSpeakToolResultDirectly('search_services', ok({ matchType: 'ambiguous_intent' })), false);
  assert.equal(canSpeakToolResultDirectly('search_services', ok({ matchType: 'no_match' })), false);
});

test('state-changing and unknown tools always round-trip through the model', () => {
  assert.equal(canSpeakToolResultDirectly('book_appointment', ok({ id: 'x' })), false);
  assert.equal(canSpeakToolResultDirectly('cancel_booking', ok({ id: 'x' })), false);
  assert.equal(canSpeakToolResultDirectly('get_upsells', ok({ upsells: [] })), false);
});

test('a failed or empty tool result is never spoken directly', () => {
  assert.equal(canSpeakToolResultDirectly('get_business_hours', { success: false, spoken_response: 'x' }), false);
  assert.equal(canSpeakToolResultDirectly('get_business_hours', { success: true, spoken_response: '' }), false);
});
