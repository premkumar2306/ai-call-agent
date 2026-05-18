import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';

const PORT        = process.env.PORT || 8080;
const WORKERS_URL = process.env.WORKERS_URL;
const DG_KEY      = process.env.DEEPGRAM_API_KEY;
const CA_KEY      = process.env.CARTESIA_API_KEY;
const RELAY_HOST  = process.env.RELAY_HOST;

const DG_URL = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
  model: 'nova-2', language: 'multi', encoding: 'mulaw', sample_rate: '8000',
  channels: '1', endpointing: '300', interim_results: 'false', smart_format: 'true',
});

// ── HTTP: health + Twilio inbound webhook ─────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }

  if (req.method === 'POST' && req.url === '/twilio/inbound') {
    const host = RELAY_HOST || req.headers.host;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0"?><Response><Connect><Stream url="wss://${host}/stream"/></Connect></Response>`);
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket: one connection per call ────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twWs) => {
  let callSid, streamSid, busy = false;

  const dgWs = new WebSocket(DG_URL, { headers: { Authorization: `Token ${DG_KEY}` } });

  dgWs.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'Results' || !msg.is_final) return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text || busy) return;

    busy = true;
    try {
      const fillers = ['One moment...', 'Let me check that for you...', 'Almost there...'];
      let fi = 0, done = false;

      const replyPromise = turn(text, callSid).finally(() => { done = true; });

      while (!done) {
        await speak(fillers[fi++ % fillers.length], streamSid, twWs);
      }

      const reply = await replyPromise;
      if (reply) await speak(reply, streamSid, twWs);
    } finally {
      busy = false;
    }
  });

  dgWs.on('error', (e) => console.error('[dg]', e.message));

  twWs.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.event === 'start') {
      callSid = msg.start.callSid;
      streamSid = msg.start.streamSid;
      console.log('call', callSid.slice(-8));
      busy = true;
      speak("Hi, I'm Avery. How can I help you today?", streamSid, twWs)
        .finally(() => { busy = false; });
    } else if (msg.event === 'media') {
      if (dgWs.readyState === WebSocket.OPEN && !busy)
        dgWs.send(Buffer.from(msg.media.payload, 'base64'));
    } else if (msg.event === 'stop') {
      dgWs.close();
    }
  });

  twWs.on('close', () => dgWs.close());
});

// ── Workers: forward transcript, extract <Say> text ───────────────────────
async function turn(transcript, callSid) {
  const res = await fetch(`${WORKERS_URL}/twilio/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SpeechResult: transcript, CallSid: callSid ?? 'relay' }).toString(),
  });
  const twiml = await res.text();
  return twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/i)?.[1]?.trim() ?? null;
}

// ── Cartesia: stream µ-law audio back to Twilio ───────────────────────────
async function speak(text, streamSid, twWs) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'Cartesia-Version': '2025-04-16', 'X-API-Key': CA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: '25d2c432-139c-4035-bfd6-9baaabcdd006' },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
  });
  if (!res.ok) { console.error('cartesia', res.status); return; }

  for await (const chunk of res.body) {
    if (twWs.readyState !== WebSocket.OPEN) break;
    twWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: Buffer.from(chunk).toString('base64') } }));
  }
  if (twWs.readyState === WebSocket.OPEN)
    twWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
}

server.listen(PORT, '0.0.0.0', () => console.log(`relay :${PORT}`));
