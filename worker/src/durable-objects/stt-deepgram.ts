// Deepgram streaming STT — outbound WebSocket client from within a Durable Object.
// Ported from relay/relay.js's createDeepgramSTT (Node `ws` client) to the Workers
// pattern: fetch() with an `Upgrade: websocket` header, then read `response.webSocket`.
// Workers' fetch() requires http(s):// — it rewrites the scheme to ws(s):// internally
// when the Upgrade header is present.

const DG_URL = 'https://api.deepgram.com/v1/listen?' + new URLSearchParams({
  model: 'nova-2', language: 'multi', encoding: 'mulaw', sample_rate: '8000',
  channels: '1', endpointing: '300', interim_results: 'false', smart_format: 'true',
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

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'Results' || !msg.is_final) return;
      const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
      if (text) { console.log(`[dg stt] ${text}`); onTranscript(text); }
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
