// Local stand-ins for every outside service a call touches, speaking each
// provider's real wire protocol. The Worker reaches them through
// PROVIDER_MOCK_URL (src/utils/provider-mock.ts): https://api.X/path arrives
// here as /api.X/path. Everything they receive is logged for the e2e checks.
//
//   Anthropic   POST /v1/messages            SSE stream (or JSON), scripted "brain" below
//   Deepgram    WS   /v1/listen              Results / SpeechStarted, driven by say()
//   Sarvam STT  WS   /speech-to-text/ws      events + data, driven by say()
//   Cartesia    POST /tts/bytes              raw µ-law 8 kHz
//   Sarvam TTS  POST /text-to-speech/stream  raw µ-law 8 kHz
//   Razorpay    /v1/plans, /v1/subscriptions[/:id[/cancel|/addons]], PATCH /v1/subscriptions/:id, /v1/invoices/:id
//               (stateful: the e2e sets a subscription's status with razorpaySub(id))
//   Resend      POST /emails                 logged with the body (log.email)
//   WhatsApp    graph.facebook.com           messages / mark-as-read logged; media → voice-note bytes
//   Deepgram    POST /v1/listen              voice-note transcription (the "audio" is the text)
//   Resend / Twilio REST                     accepted and logged

import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startMocks({ port = 0 } = {}) {
  const log = { tts: [], stt: [], anthropic: [], razorpay: [], email: [], whatsapp: [], deepgramRest: [], other: [], sttAudio: { deepgram: 0, sarvam: 0 }, sarvamSttFormats: new Set() };
  let stt = null;   // the call's open speech-recognition socket { kind, ws, t }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const [, host, ...rest] = url.pathname.split('/');
    const path = '/' + rest.join('/');
    const body = await readBody(req);
    try {
      if (host === 'api.anthropic.com' && path === '/v1/messages') return anthropic(JSON.parse(body), res, log);
      if (host === 'api.cartesia.ai' && path === '/tts/bytes') {
        const b = JSON.parse(body);
        log.tts.push({ provider: 'cartesia', text: b.transcript, format: b.output_format, at: Date.now() });
        return audioResponse(res, b.transcript);
      }
      if (host === 'api.sarvam.ai' && path === '/text-to-speech/stream') {
        const b = JSON.parse(body);
        log.tts.push({ provider: 'sarvam', text: b.text, format: { codec: b.output_audio_codec, sample_rate: b.speech_sample_rate, language: b.language_code }, at: Date.now() });
        return audioResponse(res, b.text);
      }
      if (host === 'graph.facebook.com') return graph(req, path, body, res, log);
      if (host === 'api.deepgram.com' && path === '/v1/listen' && req.method === 'POST') {
        log.deepgramRest.push({ query: Object.fromEntries(url.searchParams), contentType: req.headers['content-type'], at: Date.now() });
        return json(res, 200, { results: { channels: [{ alternatives: [{ transcript: body, confidence: 0.97 }] }] } });
      }
      if (host === 'api.razorpay.com') return razorpay(req.method, path, body, req.headers.authorization, res, log);
      if (host === 'api.resend.com' && path === '/emails') {
        const b = JSON.parse(body);
        log.email.push({ to: b.to?.[0], subject: b.subject, text: b.text, html: !!b.html, at: Date.now() });
        return json(res, 200, { id: `email_${Date.now()}` });
      }
      log.other.push({ host, path, method: req.method });
      return json(res, 200, { id: `mock_${Date.now()}`, sid: 'SMmock', messages: [{ id: 'wamid.mock' }] });
    } catch (e) {
      console.error('[mock]', host, path, e);
      return json(res, 500, { error: String(e?.message || e) });
    }
  });

  // Speech recognition: Deepgram and Sarvam both open WebSockets.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    const kind = url.pathname.startsWith('/api.deepgram.com/') ? 'deepgram'
      : url.pathname.startsWith('/api.sarvam.ai/speech-to-text') ? 'sarvam' : null;
    if (!kind) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const entry = { kind, ws, t: 0, query: Object.fromEntries(url.searchParams) };
      log.stt.push({ kind, query: entry.query, at: Date.now() });
      stt = entry;
      ws.on('message', (data, isBinary) => {
        if (kind === 'deepgram') {
          if (isBinary) log.sttAudio.deepgram += data.length;
          return;   // KeepAlive / Finalize / CloseStream control frames
        }
        try {
          const m = JSON.parse(String(data));
          if (m.audio?.data) {
            log.sttAudio.sarvam += Buffer.from(m.audio.data, 'base64').length;
            log.sarvamSttFormats.add(`${m.audio.encoding}@${m.audio.sample_rate}`);
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => { if (stt === entry) stt = null; });
    });
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  /** The caller says `text`: the open STT socket recognises it, as its provider would. */
  async function say(text) {
    if (!stt) throw new Error('no speech-recognition socket is open');
    const { kind, ws } = stt;
    if (kind === 'deepgram') {
      const start = stt.t, duration = Math.max(0.6, text.split(/\s+/).length * 0.3);
      stt.t += duration + 0.2;
      const results = (is_final, speech_final) => JSON.stringify({
        type: 'Results', is_final, speech_final, start, duration,
        channel: { alternatives: [{ transcript: text, confidence: 0.98, words: [] }] },
      });
      ws.send(JSON.stringify({ type: 'SpeechStarted', timestamp: start }));
      await sleep(120);
      ws.send(results(false, false));
      await sleep(200);
      ws.send(results(true, true));
    } else {
      ws.send(JSON.stringify({ type: 'events', data: { signal_type: 'START_SPEECH' } }));
      await sleep(200);
      ws.send(JSON.stringify({ type: 'events', data: { signal_type: 'END_SPEECH' } }));
      ws.send(JSON.stringify({ type: 'data', data: { transcript: text } }));
    }
  }

  return {
    url, log, say,
    /** The mock's stored Razorpay subscription, to change its status as Razorpay would. */
    razorpaySub: id => subs.get(id),
    sttKind: () => stt?.kind ?? null,
    close: () => new Promise(r => { wss.close(); server.close(r); server.closeAllConnections?.(); }),
  };
}

// ── Anthropic: a small scripted receptionist ─────────────────────────────────
// Enough judgement to drive real tool calls through the Worker's tool router:
// asks for availability, books the slot the tool offered, transfers, says bye.

function decide(req) {
  const msgs = req.messages ?? [];
  const last = msgs.at(-1);
  const tools = new Set((req.tools ?? []).map(t => t.name));
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map(b => b.text ?? '').join('\n');
  const hindi = /LANGUAGE/.test(system) && /हिंदी|Hindi/.test(system);
  const say = (en, hi) => ({ text: hindi && hi ? hi : en });
  const toolResults = msgs.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
  const lastIsToolResult = Array.isArray(last?.content) && last.content.some(b => b.type === 'tool_result');
  const userTexts = msgs.filter(m => m.role === 'user' && !(Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')))
    .map(m => (Array.isArray(m.content) ? m.content.map(b => b.text ?? '').join(' ') : String(m.content ?? '')).toLowerCase());
  const lastUserText = userTexts.at(-1) ?? '';
  const serviceIdOf = () => (system.match(/\[id: ([^\]]+)\]/) ?? [])[1];
  const wantsFirst = t => /(first one|that works|yes please|book it|पहला)/.test(t);
  if (lastIsToolResult) {
    // A chat keeps only the text of earlier turns, so after "the first one
    // works" the model re-checks availability, then books the first slot.
    const r0 = last.content.find(b => b.type === 'tool_result');
    const t0 = typeof r0.content === 'string' ? r0.content : (r0.content ?? []).map(c => c.text ?? '').join('');
    const slot0 = (t0.match(/"datetime":"([^"]+)"/) ?? [])[1];
    const booked = msgs.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.name === 'book_appointment'));
    if (slot0 && wantsFirst(lastUserText) && !booked && tools.has('book_appointment') && serviceIdOf()) {
      return { tool: 'book_appointment', input: { product_id: serviceIdOf(), scheduled_at: slot0, customer_name: 'Priya Sharma' } };
    }
    // Say what the tool said (its spoken_response), as the real model would.
    const r = last.content.find(b => b.type === 'tool_result');
    const text = typeof r.content === 'string' ? r.content : (r.content ?? []).map(c => c.text ?? '').join('');
    const spoken = (text.match(/"(?:spoken_response|_spoken_hint)":"((?:[^"\\]|\\.)*)"/) ?? [])[1];
    return { text: spoken ? JSON.parse(`"${spoken}"`) : (hindi ? 'हो गया। और कुछ मदद चाहिए?' : 'Done. Anything else I can help with?'), toolResult: text.slice(0, 300) };
  }

  const userText = (Array.isArray(last?.content) ? last.content.map(b => b.text ?? '').join(' ') : String(last?.content ?? '')).toLowerCase();
  const serviceId = (system.match(/\[id: ([^\]]+)\]/) ?? [])[1];
  const findSlot = () => {
    for (const r of toolResults.slice().reverse()) {
      const text = typeof r.content === 'string' ? r.content : (r.content ?? []).map(c => c.text ?? '').join('');
      const m = text.match(/"datetime":"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  };

  if (/(staff|person|someone|human|transfer|किसी से बात)/.test(userText) && tools.has('transfer_to_staff')) {
    return { tool: 'transfer_to_staff', input: { reason: 'caller asked for a person' } };
  }
  if (/(first one|that works|yes please|book it|पहला)/.test(userText) && tools.has('book_appointment')) {
    const slot = findSlot();
    if (slot && serviceId) return { tool: 'book_appointment', input: { product_id: serviceId, scheduled_at: slot, customer_name: 'Priya Sharma' } };
    if (!slot && serviceId && tools.has('check_availability')) return { tool: 'check_availability', input: { service_id: serviceId } };
  }
  if (/(book|appointment|बुक|अपॉइंटमेंट)/.test(userText) && tools.has('check_availability') && serviceId) {
    return { tool: 'check_availability', input: { service_id: serviceId } };
  }
  if (/(bye|thank you|धन्यवाद)/.test(userText)) return say('Thank you for calling. Goodbye!', 'कॉल करने के लिए धन्यवाद। नमस्ते!');
  return say('Sure, I can help with that. Would you like to book a consultation?', 'ज़रूर, मैं मदद कर सकती हूँ। क्या आप अपॉइंटमेंट बुक करना चाहेंगे?');
}

function anthropic(req, res, log) {
  const d = decide(req);
  log.anthropic.push({ model: req.model, stream: !!req.stream, decision: d.tool ?? 'text', toolResult: d.toolResult, tools: (req.tools ?? []).length, at: Date.now() });
  const usage = { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
  const id = `msg_mock_${Date.now()}`;
  const block = d.tool
    ? { type: 'tool_use', id: `toolu_${Date.now()}`, name: d.tool, input: d.input }
    : { type: 'text', text: d.text };
  const stop = d.tool ? 'tool_use' : 'end_turn';
  if (!req.stream && (req.tools ?? []).length) {
    // Non-streaming agent loop (WhatsApp): the same decision as one message.
    return json(res, 200, { id, type: 'message', role: 'assistant', model: req.model, content: [block], stop_reason: stop, stop_sequence: null, usage });
  }
  if (!req.stream) {
    // Non-streaming callers (the after-call classifier) get a plain message.
    return json(res, 200, { id, type: 'message', role: 'assistant', model: req.model, content: [{ type: 'text', text: '{"category":"booking","summary":"Caller booked a consultation."}' }], stop_reason: 'end_turn', stop_sequence: null, usage });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id, type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  if (block.type === 'text') {
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const part of block.text.match(/[^.!?।]+[.!?।]?\s*/g) ?? [block.text]) {
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
    }
  } else {
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  }
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  ev('message_stop', {});
  res.end();
}

// ── WhatsApp Cloud API (Graph) ───────────────────────────────────────────────
// A voice note's media id is `voice-<base64url text>`; its "audio" is that text,
// which the Deepgram mock then "recognises".

function graph(req, path, body, res, log) {
  const auth = req.headers.authorization ?? '';
  const parsed = body ? JSON.parse(body) : null;
  const m = path.match(/^\/(v\d+\.\d+)\/([^/]+)(\/messages)?$/);
  log.whatsapp.push({ method: req.method, path, version: m?.[1], phoneNumberId: m?.[3] ? m[2] : null, body: parsed, auth: auth.startsWith('Bearer '), at: Date.now() });
  if (!auth.startsWith('Bearer ')) return json(res, 401, { error: { code: 190, message: 'Invalid OAuth access token' } });
  const dl = path.match(/^\/media-download\/(.+)$/);
  if (dl) {
    res.writeHead(200, { 'content-type': 'audio/ogg' });
    return res.end(Buffer.from(dl[1].replace(/^voice-/, ''), 'base64url').toString('utf8'));
  }
  if (m && m[3] && req.method === 'POST') {
    if (parsed?.status === 'read') return json(res, 200, { success: true });
    return json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: parsed?.to, wa_id: parsed?.to }], messages: [{ id: `wamid.mock${Date.now()}${Math.floor(Math.random() * 1e6)}` }] });
  }
  if (m && req.method === 'GET') return json(res, 200, { url: `https://graph.facebook.com/media-download/${m[2]}`, mime_type: 'audio/ogg; codecs=opus', id: m[2] });
  return json(res, 404, { error: { message: `mock has no ${req.method} ${path}` } });
}

// ── Razorpay ─────────────────────────────────────────────────────────────────

const subs = new Map();
let rzpSeq = 0;
function razorpay(method, path, body, auth, res, log) {
  const b = body ? JSON.parse(body) : null;
  log.razorpay.push({ method, path, auth: !!auth, body: b });
  if (!auth?.startsWith('Basic ')) return json(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
  const id = p => `${p}_mock${Date.now()}${++rzpSeq}`;
  if (method === 'POST' && path === '/v1/plans') return json(res, 200, { id: id('plan'), entity: 'plan', item: b.item });
  if (method === 'POST' && path === '/v1/subscriptions') {
    const sub = { id: id('sub'), entity: 'subscription', plan_id: b.plan_id, status: 'created', short_url: 'https://rzp.io/i/mock', customer_id: null, current_start: null, current_end: null, start_at: b.start_at ?? null };
    subs.set(sub.id, sub);
    return json(res, 200, sub);
  }
  const m = path.match(/^\/v1\/subscriptions\/([^/]+)(\/cancel|\/addons)?$/);
  const sub = m && subs.get(m[1]);
  if (m && !sub) return json(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
  if (m && method === 'GET' && !m[2]) return json(res, 200, sub);
  if (m && method === 'PATCH' && !m[2]) {
    if (sub.status !== 'active') return json(res, 400, { error: { description: 'Subscription can be updated only when active' } });
    if (b.schedule_change_at === 'now') sub.plan_id = b.plan_id; else sub.has_scheduled_changes = true;
    return json(res, 200, sub);
  }
  if (m && method === 'POST' && m[2] === '/cancel') {
    if (!b.cancel_at_cycle_end) sub.status = 'cancelled';
    return json(res, 200, sub);
  }
  if (m && method === 'POST' && m[2] === '/addons') {
    if (!['active', 'authenticated'].includes(sub.status)) return json(res, 400, { error: { description: 'Addon can be created only for active subscriptions' } });
    return json(res, 200, { id: id('ao'), entity: 'addon', item: b.item, quantity: b.quantity });
  }
  const inv = path.match(/^\/v1\/invoices\/([^/]+)$/);
  if (inv && method === 'GET') return json(res, 200, { id: inv[1], entity: 'invoice', subscription_id: [...subs.keys()].at(-1) ?? null });
  return json(res, 404, { error: { description: `mock has no ${method} ${path}` } });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const MS_PER_WORD = 60;
function audioResponse(res, text) {
  // Raw µ-law 8 kHz, roughly as long as the words would take to say.
  const bytes = Math.max(1600, String(text).split(/\s+/).length * 8 * MS_PER_WORD);
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = i % 16 < 8 ? 0x7f : 0xff;   // a quiet buzz, not silence
  res.end(buf);
}
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => r(d)); });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
