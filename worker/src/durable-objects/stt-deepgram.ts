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
// below speech_final normally wins — endpointing is 200ms where
// utterance_end_ms cannot go below 1000ms — so UtteranceEnd is a *fallback*
// for utterances where Deepgram never emits speech_final, not a latency win
// in the common case. (The commit that introduced it claimed otherwise; the
// real win there was using the interim text rather than waiting for a final
// Results message.)

export interface SttOptions {
  apiKey: string;
  /** Deepgram model. Default 'nova-2'. Try 'nova-3' for lower finalization latency. */
  model?: string;
  /** 'multi' (default) for multilingual; 'en' is faster if the deployment is English-only. */
  language?: string;
  debug?: boolean;
}

function dgUrl(model: string, language: string): string {
  return 'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model, language,
    encoding: 'mulaw', sample_rate: '8000', channels: '1',
    endpointing: '200', interim_results: 'true', utterance_end_ms: '1000',
    smart_format: 'true',
    // Emits SpeechStarted as soon as voice activity is detected, which beats
    // even the first interim Results message. Drives barge-in.
    vad_events: 'true',
  });
}

export type SpeechStartReason = 'vad' | 'interim';

export interface Stt {
  sendAudio(buf: ArrayBuffer): void;
  close(): void;
}

export async function createDeepgramSTT(
  opts: SttOptions,
  onTranscript: (text: string) => void,
  onSpeechStart?: (reason: SpeechStartReason, text?: string) => void,
): Promise<Stt> {
  const { apiKey, model = 'nova-2', language = 'multi', debug = false } = opts;
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const resp = await fetch(dgUrl(model, language), {
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
  let utteranceStart = 0;
  let finalized = false;
  // Barge-in fires at most once per utterance. SpeechStarted and the first
  // interim both signal the same thing and can both arrive; whichever is
  // first wins and the other is ignored until the next finalize().
  let speechAnnounced = false;

  // `text` is the interim transcript when there is one. The caller needs it
  // to judge whether this is real speech or our own audio echoing back off
  // the caller's handset, which Deepgram happily recognises as words.
  const announceSpeech = (reason: SpeechStartReason, text?: string) => {
    if (speechAnnounced) return;
    speechAnnounced = true;
    if (debug) console.log(`[dg stt] speech-start (${reason}) "${text ?? ''}"`);
    onSpeechStart?.(reason, text);
  };

  const finalize = (text: string, reason: 'speech_final' | 'utterance_end') => {
    if (!text || finalized) return;
    finalized = true;
    const ms = utteranceStart ? Date.now() - utteranceStart : -1;
    console.log(`[dg stt] ⏱ transcript-finalized (${reason}): ${ms}ms — "${text}"`);
    lastText = '';
    utteranceStart = 0;
    speechAnnounced = false;
    onTranscript(text);
  };

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

      if (msg.type === 'SpeechStarted') {
        if (!utteranceStart) utteranceStart = Date.now();
        announceSpeech('vad');
        return;
      }

      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (debug) {
          console.log(`[dg stt] Results is_final=${!!msg.is_final} speech_final=${!!msg.speech_final} text="${text ?? ''}"`);
        }
        if (text) {
          if (!msg.is_final) {
            // Interim result: reliable signal of new/ongoing speech. Only
            // stamp a fresh utteranceStart if we're not already mid-utterance
            // (lastText empty) or just finalized one (finalized true).
            if (!lastText || finalized) utteranceStart = Date.now();
            lastText = text;
            finalized = false;
            // Backstop for barge-in if vad_events is unavailable or missed.
            announceSpeech('interim', text);
          } else if (!finalized) {
            // is_final but not (yet) speech_final, and we haven't already
            // finalized this utterance — keep lastText fresh as a fallback
            // for UtteranceEnd, but don't finalize here: is_final alone can
            // fire mid-sentence on an endpointing pause, truncating the
            // transcript. speech_final (checked below) is Deepgram's actual
            // end-of-utterance signal.
            lastText = text;
          }
          // If finalized is already true, this is a trailing confirmation
          // Results message for an utterance UtteranceEnd already closed —
          // ignore it for state purposes so we don't double-fire.
        }
        if (msg.speech_final && text && !finalized) finalize(text, 'speech_final');
        return;
      }

      if (msg.type === 'UtteranceEnd') {
        if (debug) console.log(`[dg stt] UtteranceEnd lastText="${lastText}" finalized=${finalized}`);
        if (lastText) {
          finalize(lastText, 'utterance_end');
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
    close: () => { isOpen = false; try { ws.close(); } catch {} },
  };
}
