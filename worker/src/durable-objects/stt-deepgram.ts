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

export async function createDeepgramSTT(apiKey: string, onTranscript: (text: string) => void): Promise<Stt> {
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');

  const resp = await fetch(DG_URL, {
    headers: { Upgrade: 'websocket', Authorization: `Token ${apiKey}` },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error('Deepgram did not accept the WebSocket upgrade');
  ws.accept();

  let isOpen = true;

  // Track the latest (possibly still-changing) interim transcript text, plus
  // when the current utterance started, so either UtteranceEnd or is_final —
  // whichever fires first — can trigger onTranscript() with the freshest
  // text instead of always waiting on a final Results message.
  let lastText = '';
  let utteranceStart = 0;
  let finalized = false;

  const finalize = (text: string) => {
    if (!text || finalized) return;
    finalized = true;
    const ms = utteranceStart ? Date.now() - utteranceStart : -1;
    console.log(`[dg stt] ⏱ transcript-finalized: ${ms}ms — "${text}"`);
    lastText = '';
    onTranscript(text);
  };

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);

      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (text) {
          if (!lastText) utteranceStart = Date.now();
          lastText = text;
          finalized = false;
        }
        if (msg.is_final && text) finalize(text);
        return;
      }

      if (msg.type === 'UtteranceEnd') {
        if (lastText) finalize(lastText);
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
