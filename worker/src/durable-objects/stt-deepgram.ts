// Deepgram streaming STT — outbound WebSocket client from within a Durable Object.
// Ported from relay/relay.js's createDeepgramSTT (Node `ws` client) to the Workers
// pattern: fetch() with an `Upgrade: websocket` header, then read `response.webSocket`.
// Workers' fetch() requires http(s):// — it rewrites the scheme to ws(s):// internally
// when the Upgrade header is present.

// interim_results + utterance_end_ms let us react to Deepgram's UtteranceEnd
// event (word-timing-based) instead of always waiting for the next is_final
// Results message with trailing silence (endpointing). endpointing is also
// lowered from the original 300ms toward 200ms as a cheap complementary win.
// UtteranceEnd requires interim_results: 'true' per Deepgram's docs.
const DG_URL = 'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
  model: 'nova-2', language: 'multi', encoding: 'mulaw', sample_rate: '8000',
  channels: '1', endpointing: '200', interim_results: 'true', utterance_end_ms: '1000',
  smart_format: 'true',
});

export interface Stt {
  sendAudio(buf: ArrayBuffer): void;
  close(): void;
}

export async function createDeepgramSTT(
  apiKey: string,
  onTranscript: (text: string) => void,
  debug: boolean = false,
): Promise<Stt> {
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const resp = await fetch(DG_URL, {
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

  const finalize = (text: string, reason: 'speech_final' | 'utterance_end') => {
    if (!text || finalized) return;
    finalized = true;
    const ms = utteranceStart ? Date.now() - utteranceStart : -1;
    console.log(`[dg stt] ⏱ transcript-finalized (${reason}): ${ms}ms — "${text}"`);
    lastText = '';
    utteranceStart = 0;
    onTranscript(text);
  };

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

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
        if (lastText) finalize(lastText, 'utterance_end');
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
