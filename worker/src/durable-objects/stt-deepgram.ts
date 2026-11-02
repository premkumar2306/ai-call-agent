// Deepgram streaming STT — outbound WebSocket client from within a Durable Object.
// Ported from relay/relay.js's createDeepgramSTT (Node `ws` client) to the Workers
// pattern: fetch() with an `Upgrade: websocket` header, then read `response.webSocket`.
// Workers' fetch() requires http(s):// — it rewrites the scheme to ws(s):// internally
// when the Upgrade header is present.

// Two separate signals come out of here:
//
//   onSpeechStart — fired as soon as Deepgram reports *any* speech for a new
//     utterance (vad_events' SpeechStarted, or the first interim Results
//     message, whichever lands first). This is the barge-in trigger. It must
//     not wait for finalization: the caller is already talking over the
//     assistant by this point, and every ms until TTS stops is talk-over.
//
//   onTranscript — fired once per utterance with the finalized text, and is
//     what actually starts a turn.
//
// On finalization: `endpointing` (silence-based) drives speech_final, and
// utterance_end_ms drives UtteranceEnd (word-timing-based). With the values
// below speech_final normally wins — endpointing is 250ms (default) where
// utterance_end_ms cannot go below 1000ms — so UtteranceEnd is a *fallback*
// for utterances where Deepgram never emits speech_final, not a latency win
// in the common case. (The commit that introduced it claimed otherwise; the
// real win there was using the interim text rather than waiting for a final
// Results message.)

export interface SttOptions {
  apiKey: string;
  /** True when an interim transcript is our own voice coming back (speakerphone echo) — no barge-in. */
  isEcho?: (text: string) => boolean;
  /** Extra wait (ms) after a complete statement of 4+ words, for a follow-up question. Default 400; 0 disables. */
  statementHoldMs?: number;
  /** Any recognised caller speech (every interim) — e.g. to reset a silence timer mid-sentence. */
  onActivity?: () => void;
  /** Deepgram model. Default 'nova-3'. */
  model?: string;
  /** 'en' (default); set 'multi' for multilingual. */
  language?: string;
  /**
   * Silence (ms) Deepgram waits before declaring end-of-speech. Longer is more
   * robust to background noise and mid-sentence pauses, at the cost of that
   * much extra reply latency. Default 250 — short pauses that split a sentence
   * are rejoined by the incomplete-sentence hold and segment assembly below.
   */
  endpointingMs?: number;
  /**
   * Finalized transcripts whose Deepgram confidence is below this are dropped
   * as noise / background speech rather than answered. Default 0.5; 0 disables.
   */
  minConfidence?: number;
  /**
   * An interim transcript only counts as the caller interrupting once it has
   * this many words, so a cough or a stray word from the background doesn't
   * cut the assistant off. Pure acknowledgements ("uh huh", "okay") never
   * count. The finalized transcript is still a barge-in backstop. Default 2.
   */
  bargeInMinWords?: number;
  /**
   * How long an incomplete-looking transcript (see looksIncomplete) waits for
   * the caller to carry on before it's answered anyway. Default 900.
   */
  incompleteHoldMs?: number;
  debug?: boolean;
}

function dgUrl(model: string, language: string, endpointingMs: number): string {
  return 'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model, language,
    encoding: 'mulaw', sample_rate: '8000', channels: '1',
    endpointing: String(endpointingMs), interim_results: 'true', utterance_end_ms: '1000',
    smart_format: 'true',
    // Emits SpeechStarted as soon as voice activity is detected, which beats
    // even the first interim Results message. Drives barge-in.
    vad_events: 'true',
  });
}

export type SpeechStartReason = 'vad' | 'interim';

// Words a sentence doesn't end on. "I also wanna change my" is a caller
// drawing breath, not a finished request.
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'our', 'his', 'her', 'their', 'this', 'that', 'some',
  'and', 'or', 'but', 'so', 'because', 'if', 'then', 'also', 'plus',
  'to', 'for', 'of', 'with', 'on', 'at', 'in', 'from', 'about', 'like',
  'i', "i'm", 'im', 'we', 'wanna', 'gonna', 'want', 'need', 'is', 'are', 'was', 'be', 'can', 'could', 'would',
  'um', 'uh', 'er', 'just', 'maybe',
]);

/**
 * True when a finalized transcript reads like the caller stopped mid-thought:
 * no closing punctuation from smart_format, a trailing ellipsis, or a last
 * word sentences don't end on. Such a transcript is held briefly for the
 * rest of the sentence instead of being answered — answering a fragment is
 * what makes the assistant and caller talk over each other.
 */
export function looksIncomplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(\.\.\.|…)$/.test(t)) return true;
  // A number at the end ("…my number is 847-555-0123.") is a finished thought.
  const lastToken = t.split(/\s+/).pop() ?? '';
  const last = t.toLowerCase().replace(/[^a-z'\s]/g, ' ').trim().split(/\s+/).pop() ?? '';
  if (!/\d/.test(lastToken) && DANGLING_WORDS.has(last)) return true;
  return !/[.?!]["')]?$/.test(t);
}

// Listener feedback that shouldn't stop the assistant mid-sentence.
const BACKCHANNEL_WORDS = new Set([
  'uh', 'huh', 'uhhuh', 'um', 'mm', 'mhm', 'mmhmm', 'hmm', 'ok', 'okay', 'right', 'yeah', 'yep', 'yup',
  'sure', 'alright', 'got', 'it', 'i', 'see', 'cool', 'great', 'nice', 'oh',
]);

export function isBackchannel(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, '').replace(/-/g, '').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every(w => BACKCHANNEL_WORDS.has(w));
}

// Words that only hold the floor ("Well,", "Um, so"). Said on their own
// while the assistant is quiet they're the start of a sentence, not a turn.
const DISCOURSE_WORDS = new Set(['well', 'so', 'um', 'uh', 'umm', 'uhh', 'er', 'hmm', 'and', 'but', 'like', 'also', 'then', 'actually']);

export function isDiscourseOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every(w => DISCOURSE_WORDS.has(w));
}

/**
 * Whether `heard` is (mostly) a replay of what the assistant said — its own
 * audio leaking back through a speakerphone into the caller's microphone.
 * Needs 4+ words, most of them from what was just spoken, so a caller
 * picking an option the assistant read out ("all four") isn't mistaken
 * for echo.
 */
export function isEchoOf(heard: string, spoken: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  const h = norm(heard);
  if (h.length < 4) return false;
  const said = new Set(norm(spoken));
  if (!said.size) return false;
  return h.filter(w => said.has(w)).length / h.length >= 0.75;
}

/**
 * smart_format reads a spoken phone number as money: "five five five, two
 * one four, three eight seven six" → "$55,521,438.76". A "dollar amount"
 * with exactly 10 (or 1 + 10) digits is a phone number; rewrite it so the
 * agent can use it. It does the same to model years: "twenty nineteen" →
 * "$20.19" or "2,019"; those go back to "2019".
 */
export function fixPhoneNumbers(text: string): string {
  return text
    .replace(/\$\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?/g, (m) => {
      let d = m.replace(/\D/g, '');
      if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
      return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : m;
    })
    .replace(/\$(19|20)\.(\d{2})\b/g, '$1$2')
    .replace(/\b([12]),(\d{3})\b(?!,\d)/g, (m, a, b) => (/^(19|20)\d\d$/.test(a + b) ? a + b : m));
}

export interface Stt {
  sendAudio(buf: ArrayBuffer): void;
  close(): void;
}

const STABLE_MS = 700;

export async function createDeepgramSTT(
  opts: SttOptions,
  onTranscript: (text: string) => void,
  onSpeechStart?: (reason: SpeechStartReason) => void,
): Promise<Stt> {
  const {
    apiKey, model = 'nova-3', language = 'en', debug = false,
    endpointingMs = 250, minConfidence = 0.5, bargeInMinWords = 2, incompleteHoldMs = 900, statementHoldMs = 400, isEcho, onActivity,
  } = opts;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const resp = await fetch(dgUrl(model, language, endpointingMs), {
    headers: { Upgrade: 'websocket', Authorization: `Token ${apiKey}` },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error('Deepgram did not accept the WebSocket upgrade');
  ws.accept();

  let isOpen = true;

  // Track the latest (possibly still-changing) interim transcript text, plus
  // when the current utterance started, so either UtteranceEnd or speech_final
  // — whichever fires first — can trigger onTranscript() with the freshest
  // text instead of always waiting on a final Results message.
  //
  // `finalized` guards against firing onTranscript() twice for the same
  // utterance. Deepgram can emit UtteranceEnd and the speech_final Results
  // message in either order, and the speech_final message often repeats the
  // same trailing text UtteranceEnd already used. We only treat incoming
  // text as the *start* of a new utterance when it arrives on an interim
  // (is_final: false) message — that's the one message type Deepgram only
  // sends for genuinely new/continuing speech, never as a trailing
  // confirmation of an utterance we already finalized. This also keeps
  // `utteranceStart` from going stale: it's reset in lockstep with
  // `lastText`/`finalized` instead of drifting across utterance boundaries.
  let lastText = '';
  // Deepgram finalizes a long utterance in pieces: each is_final Results
  // carries only the words since the previous one, and speech_final carries
  // just the last piece. The utterance is all of them joined — taking only
  // the last piece turned "What times do you have Tuesday morning for an oil
  // change?" into "Tuesday morning for an oil change?".
  let segments: string[] = [];
  // Audio time (s) up to which speech has been finalized. A final Results
  // message that starts at or after it is new speech, even when no interim
  // came first — with short endpointing a quick utterance can arrive as
  // is_final straight away, and treating it as a trailing confirmation of
  // the previous utterance dropped it entirely.
  let finalizedUntil = 0;
  let lastEnd = 0;
  let lastConfidence = 1;
  let utteranceStart = 0;
  let finalized = false;
  // Barge-in fires at most once per utterance. SpeechStarted and the first
  // interim both signal the same thing and can both arrive; whichever is
  // first wins and the other is ignored until the next finalize().
  let speechAnnounced = false;

  const announceSpeech = (reason: SpeechStartReason) => {
    if (speechAnnounced) return;
    speechAnnounced = true;
    if (debug) console.log(`[dg stt] speech-start (${reason})`);
    onSpeechStart?.(reason);
  };

  // Deepgram sometimes keeps re-sending the same finished interim for
  // seconds before it endpoints (SVT: 6–9 s on "Jordan Lee. It's a 2018
  // Mazda three."). When an interim that ends a sentence repeats unchanged
  // for STABLE_MS, the caller has stopped — finalize it ourselves.
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let lastInterim = '';
  const clearStable = () => { if (stableTimer) clearTimeout(stableTimer); stableTimer = undefined; };

  // A fragment waiting for the rest of its sentence (see looksIncomplete).
  let held = '';
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseHeld = () => {
    holdTimer = undefined;
    const text = held;
    held = '';
    if (text) {
      console.log(`[dg stt] releasing held text: "${text}"`);
      onTranscript(text);
    }
  };

  const finalize = (text: string, reason: 'speech_final' | 'utterance_end' | 'stable', confidence: number) => {
    if (!text || finalized) return;
    finalized = true;
    clearStable();
    lastInterim = '';
    if (confidence < minConfidence) {
      // Most likely background noise or a voice that isn't the caller's.
      console.log(`[dg stt] dropped low-confidence transcript (${confidence.toFixed(2)} < ${minConfidence}): "${text}"`);
      lastText = '';
      segments = [];
      finalizedUntil = lastEnd;
      utteranceStart = 0;
      speechAnnounced = false;
      return;
    }
    const ms = utteranceStart ? Date.now() - utteranceStart : -1;
    console.log(`[dg stt] ⏱ transcript-finalized (${reason}): ${ms}ms — "${text}"`);
    lastText = '';
    segments = [];
    finalizedUntil = lastEnd;
    utteranceStart = 0;
    speechAnnounced = false;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = undefined;
    const combined = [held, text].filter(Boolean).join(' ');
    // A finished statement of a few words is often followed by a question
    // after a breath ("…one or two off the road at a time. Is there a fleet
    // discount?"); answering at the full stop talks over the question.
    // Questions and short answers ("Two works.") go straight through.
    const statementHold = statementHoldMs > 0 && /[.!]["')]?$/.test(combined) && combined.split(/\s+/).length >= 4;
    if ((incompleteHoldMs > 0 && looksIncomplete(combined)) || statementHold) {
      held = combined;
      holdTimer = setTimeout(releaseHeld, looksIncomplete(combined) ? incompleteHoldMs : statementHoldMs);
      if (debug) console.log(`[dg stt] holding ${statementHold && !looksIncomplete(combined) ? 'statement' : 'incomplete'} "${combined}"`);
      return;
    }
    held = '';
    onTranscript(combined);
  };

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

      if (msg.type === 'SpeechStarted') {
        if (!utteranceStart) utteranceStart = Date.now();
        clearStable();  // more speech coming — wait for its words
        // Speaking again while a fragment is held: give the words time to
        // arrive (the interim clears the timer) rather than releasing the
        // fragment now — but not forever, in case it was only noise.
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = setTimeout(releaseHeld, 1500); }
        announceSpeech('vad');
        return;
      }

      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        const confidence = typeof msg.channel?.alternatives?.[0]?.confidence === 'number'
          ? msg.channel.alternatives[0].confidence as number : 1;
        if (debug) {
          console.log(`[dg stt] Results is_final=${!!msg.is_final} speech_final=${!!msg.speech_final} text="${text ?? ''}"`);
        }
        if (typeof msg.start === 'number' && typeof msg.duration === 'number') {
          if (msg.is_final && text && finalized && msg.start >= finalizedUntil - 0.01) {
            // New speech that skipped the interim stage.
            finalized = false;
            segments = [];
            if (!utteranceStart) utteranceStart = Date.now();
          }
          lastEnd = Math.max(lastEnd, msg.start + msg.duration);
        }
        if (text) onActivity?.();
        if (text) {
          if (!msg.is_final) {
            // Interim result: reliable signal of new/ongoing speech. Only
            // stamp a fresh utteranceStart if we're not already mid-utterance
            // (lastText empty) or just finalized one (finalized true).
            if (!lastText || finalized) utteranceStart = Date.now();
            // The caller carried on — the held fragment will be joined to
            // this utterance when it finalizes.
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = undefined; }
            if (finalized) segments = [];
            lastText = [...segments, text].join(' ');
            lastConfidence = confidence;
            finalized = false;
            if (text !== lastInterim) {
              lastInterim = text;
              clearStable();
            } else if (!stableTimer && /[.?!]["')]?$/.test(text) && !looksIncomplete(lastText)) {
              stableTimer = setTimeout(() => { stableTimer = undefined; finalize(lastText, 'stable', lastConfidence); }, STABLE_MS);
            }
            // Barge-in once there are enough words to be a real interruption
            // — and not just the caller saying "mm-hmm" while listening.
            if (text.split(/\s+/).length >= bargeInMinWords && !isBackchannel(text) && !isEcho?.(text)) announceSpeech('interim');
          } else if (!finalized) {
            // is_final but not (yet) speech_final, and we haven't already
            // finalized this utterance — keep lastText fresh as a fallback
            // for UtteranceEnd, but don't finalize here: is_final alone can
            // fire mid-sentence on an endpointing pause, truncating the
            // transcript. speech_final (checked below) is Deepgram's actual
            // end-of-utterance signal.
            // Skip a piece already consumed by an earlier finalize
            // (UtteranceEnd can close an utterance before its last is_final
            // arrives) — it would be spoken twice.
            const stale = typeof msg.start === 'number' && msg.start < finalizedUntil - 0.01;
            if (!msg.speech_final && !stale) segments.push(text);
            lastText = [...segments, ...(msg.speech_final ? [text] : [])].join(' ');
            lastConfidence = confidence;
          }
          // If finalized is already true, this is a trailing confirmation
          // Results message for an utterance UtteranceEnd already closed —
          // ignore it for state purposes so we don't double-fire.
        }
        if (msg.speech_final && !finalized) {
          const full = [...segments, text ?? ''].filter(Boolean).join(' ');
          if (full) finalize(full, 'speech_final', confidence);
        }
        return;
      }

      if (msg.type === 'UtteranceEnd') {
        if (debug) console.log(`[dg stt] UtteranceEnd lastText="${lastText}" finalized=${finalized}`);
        if (lastText) {
          finalize(lastText, 'utterance_end', lastConfidence);
        } else {
          // Speech was detected but produced no transcript (noise, a cough, a
          // word Deepgram couldn't place). finalize() never runs, so reset the
          // barge-in latch here — otherwise one unintelligible noise would
          // suppress barge-in for the rest of the call.
          speechAnnounced = false;
        }
        return;
      }
    } catch (e: any) {
      console.error('[dg stt] parse error', e?.message || e);
    }
  });

  ws.addEventListener('close', () => { isOpen = false; });
  ws.addEventListener('error', (e: any) => { isOpen = false; console.error('[dg stt]', e?.message || e); });

  return {
    sendAudio: (buf: ArrayBuffer) => { if (isOpen) ws.send(buf); },
    close: () => { isOpen = false; if (holdTimer) clearTimeout(holdTimer); clearStable(); try { ws.close(); } catch {} },
  };
}

// ── Flux (DG_MODEL=flux-general-en) ─────────────────────────────────────────
// Deepgram's conversational model decides end-of-turn itself from how the
// sentence sounds and reads, instead of a fixed silence window. That
// replaces endpointing, the incomplete-sentence hold and segment assembly
// above: one EndOfTurn carries the whole turn.
// https://developers.deepgram.com/docs/flux/nova-3-migration

// Flux wants ~80 ms chunks; Twilio sends 20 ms (160 bytes of 8 kHz µ-law).
const FLUX_CHUNK_BYTES = 640;

export async function createDeepgramFluxSTT(
  opts: SttOptions & { eotThreshold?: number; eotTimeoutMs?: number },
  onTranscript: (text: string) => void,
  onSpeechStart?: (reason: SpeechStartReason) => void,
): Promise<Stt> {
  const { apiKey, model = 'flux-general-en', debug = false, minConfidence = 0.5, bargeInMinWords = 2, isEcho } = opts;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');
  const url = 'https://api.deepgram.com/v2/listen?' + new URLSearchParams({
    model, encoding: 'mulaw', sample_rate: '8000',
    eot_threshold: String(opts.eotThreshold ?? 0.7),
    eot_timeout_ms: String(opts.eotTimeoutMs ?? 3000),
  });
  const resp = await fetch(url, { headers: { Upgrade: 'websocket', Authorization: `Token ${apiKey}` } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`Deepgram Flux did not accept the WebSocket upgrade (${resp.status})`);
  ws.accept();

  let isOpen = true;
  let pending = new Uint8Array(0);
  let announcedTurn = -1;
  let turnStartedAt = 0;

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'TurnInfo') {
        if (debug || msg.type === 'Error') console.log(`[dg flux] ${JSON.stringify(msg).slice(0, 200)}`);
        return;
      }
      const text = String(msg.transcript ?? '').trim();
      const turn = Number(msg.turn_index ?? 0);
      if (debug) console.log(`[dg flux] ${msg.event} #${turn} eot=${msg.end_of_turn_confidence} "${text}"`);
      if (msg.event === 'StartOfTurn' && !turnStartedAt) turnStartedAt = Date.now();
      if (text) opts.onActivity?.();
      if ((msg.event === 'StartOfTurn' || msg.event === 'Update') && text && announcedTurn !== turn
          && text.split(/\s+/).length >= bargeInMinWords && !isBackchannel(text) && !isEcho?.(text)) {
        announcedTurn = turn;
        onSpeechStart?.('interim');
      }
      if (msg.event === 'EndOfTurn') {
        const words: { confidence?: number }[] = Array.isArray(msg.words) ? msg.words : [];
        const confidence = words.length ? words.reduce((s, w) => s + (w.confidence ?? 1), 0) / words.length : 1;
        const ms = turnStartedAt ? Date.now() - turnStartedAt : -1;
        turnStartedAt = 0;
        if (!text) return;
        if (confidence < minConfidence) {
          console.log(`[dg flux] dropped low-confidence turn (${confidence.toFixed(2)}): "${text}"`);
          return;
        }
        console.log(`[dg flux] ⏱ end-of-turn (${msg.trigger ?? 'model'}): ${ms}ms — "${text}"`);
        onTranscript(text);
      }
    } catch (e: any) {
      console.error('[dg flux] parse error', e?.message || e);
    }
  });
  ws.addEventListener('close', () => { isOpen = false; });
  ws.addEventListener('error', (e: any) => { isOpen = false; console.error('[dg flux]', e?.message || e); });

  return {
    sendAudio: (buf: ArrayBuffer) => {
      if (!isOpen) return;
      const next = new Uint8Array(pending.length + buf.byteLength);
      next.set(pending);
      next.set(new Uint8Array(buf), pending.length);
      if (next.length < FLUX_CHUNK_BYTES) { pending = next; return; }
      pending = new Uint8Array(0);
      ws.send(next.buffer);
    },
    close: () => {
      isOpen = false;
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
      try { ws.close(); } catch {}
    },
  };
}
