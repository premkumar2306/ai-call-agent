#!/usr/bin/env node
// End-to-end call simulator: the real Worker (wrangler dev, local D1/KV,
// real Durable Object) against local stand-ins for every outside service
// (e2e/mock-providers.mjs), with simulated callers speaking each carrier's
// real protocol. No accounts, keys or network needed.
//
//   npm run e2e                 # all scenarios
//   npm run e2e -- exotel       # only scenarios whose name contains "exotel"
//   E2E_KEEP=1 npm run e2e      # keep wrangler's log (e2e/.state/wrangler.log)
//
// What a scenario proves, per carrier: the inbound webhook (signed as the
// carrier signs it) returns a stream; the stream authenticates; the caller
// hears the greeting (and, for an Indian business, the AI/recording notice
// first, in the line's language); the carrier's audio format and framing are
// right; speech recognition gets the right audio format; a spoken booking
// lands in the database; "speak to someone" ends the stream and the
// after-stream webhook dials staff; the call is metered for billing; the
// notice is in the consent audit trail. Plus WhatsApp: the Meta webhook
// handshake, signatures, a chat booking, voice notes, retries, status
// webhooks, unmapped numbers, Hindi, the DPDP notice and billing. Plus Razorpay billing end to
// end: trial, Checkout signature (good and bad), activation, failed payment → dunning email,
// halted, month-end overage add-on, GST tax invoice, plan change and cancellation. Plus
// /admin/integrations: Working, Not set up, and Failing with a redacted error.

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { rmSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startMocks, sleep } from './mock-providers.mjs';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(WORKER_DIR, 'e2e', '.state');
const PORT = Number(process.env.E2E_PORT || 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'e2e-admin-key';
const SECRETS = {
  TOKEN_SECRET: 'e2e-token-secret-0123456789abcdef0123456789',
  CUSTOMER_HASH_SALT: 'e2e-salt',
  ANTHROPIC_API_KEY: 'sk-ant-mock', DEEPGRAM_API_KEY: 'dg-mock', CARTESIA_API_KEY: 'ca-mock', SARVAM_API_KEY: 'sv-mock',
  TWILIO_AUTH_TOKEN: 'tw-auth-mock', TWILIO_WEBHOOK_URL: BASE, TWILIO_ACCOUNT_SID: 'ACmock', TWILIO_SMS_FROM: '+13125550000',
  EXOTEL_WEBHOOK_SECRET: 'ex-secret-mock', PLIVO_AUTH_TOKEN: 'pl-auth-mock', PLIVO_WEBHOOK_URL: BASE, PLIVO_AUTH_ID: 'MAMOCK0001',
  RAZORPAY_KEY_ID: 'rzp_test_mock', RAZORPAY_KEY_SECRET: 'rzp-secret-mock', RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook-mock',
  RESEND_API_KEY: 're_mock', EMAIL_FROM: 'Avery <test@example.com>',
  BILLING_SUPPLIER_GSTIN: '27AAPFU0939F1ZV',   // Maharashtra: a Maharashtra customer gets CGST+SGST
  WA_APP_SECRET: 'wa-app-secret-mock', WA_VERIFY_TOKEN: 'wa-verify-mock', WA_ACCESS_TOKEN: 'EAAmockwhatsapptoken0123456789',
  // The legacy single number; any other unmapped number is refused.
  WA_PHONE_NUMBER_ID: '109000000000999',
  WA_BUSINESS_ACCOUNT_ID: '102000000000555',
  ADMIN_NOTIFY_EMAIL: 'ops-alerts@example.com',
};

const only = process.argv[2]?.toLowerCase();
const results = [];
const check = (scenario, name, ok, detail = '') => {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── Worker lifecycle ─────────────────────────────────────────────────────────

function wrangler(args, opts = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: WORKER_DIR, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

async function startWorker(mockUrl) {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', STATE, '--file=./schema.sql']);
  wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE]);
  const vars = { NODE_ENV: 'staging', PROVIDER_MOCK_URL: mockUrl, ADMIN_SECRET: ADMIN, ...SECRETS };
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE, '--test-scheduled',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  const out = openSync(join(STATE, 'wrangler.log'), 'w');
  const proc = spawn('npx', args, { cwd: WORKER_DIR, stdio: ['ignore', out, out], detached: true });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health?deep=1`)).ok) return proc; } catch { /* starting */ }
    await sleep(1000);
  }
  throw new Error(`wrangler dev did not start; see ${join(STATE, 'wrangler.log')}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'X-Admin-Key': ADMIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return json?.data ?? json ?? text;
}

const form = params => new URLSearchParams(params).toString();
const twilioSig = (url, params) => createHmac('sha1', SECRETS.TWILIO_AUTH_TOKEN)
  .update(Object.keys(params).sort().reduce((s, k) => s + k + params[k], url)).digest('base64');
function plivoSig(url, params, nonce) {
  const u = new URL(url);
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  const post = Object.keys(params).sort().map(k => k + params[k]).join('');
  base += post;
  return createHmac('sha256', SECRETS.PLIVO_AUTH_TOKEN).update(`${base}.${nonce}`).digest('base64');
}
const unxml = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const toWs = url => url.replace(/^wss:\/\/[^/]+/, `ws://127.0.0.1:${PORT}`);

// ── Businesses ───────────────────────────────────────────────────────────────

const ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, '12am–11:59pm']));

async function setupBusiness({ key, name, country, phone, number, provider, voice }) {
  const india = country === 'IN';
  await api('POST', '/admin/sectors', {
    key, name, hours: ALL_DAY, model: 'service', categories: ['GENERAL'],
    timezone: india ? 'Asia/Kolkata' : 'America/Chicago', currency: india ? 'INR' : 'USD',
    locale: india ? 'en-IN' : 'en-US', country_code: country, phone,
    about: 'End-to-end test business.',
  });
  await api('POST', '/admin/vendors', { id: `${key}-v`, name, business_type: key });
  await api('POST', '/admin/products', {
    id: `${key}-consult`, business_type: key, vendor_id: `${key}-v`, name: 'Consultation',
    description: 'A 30 minute consultation.', price_cents: india ? 50000 : 5000, duration_minutes: 30,
  });
  if (voice) await api('PUT', `/admin/sectors/${key}/voice`, voice);
  await api('PUT', '/admin/phone-numbers', { number, provider, businessType: key });
}

// ── Carriers: how each one frames a call ─────────────────────────────────────

const CARRIERS = {
  twilio: {
    async open({ number, from, callSid }) {
      const params = { CallSid: callSid, From: from, To: number, AccountSid: 'ACmock', CallStatus: 'in-progress' };
      const res = await fetch(`${BASE}/twilio/inbound`, {
        method: 'POST', body: form(params),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSig(`${BASE}/twilio/inbound`, params) },
      });
      const xml = await res.text();
      const url = unxml((xml.match(/<Stream url="([^"]+)"/) ?? [])[1] ?? '');
      const token = unxml((xml.match(/name="streamToken" value="([^"]+)"/) ?? [])[1] ?? '');
      const bt = unxml((xml.match(/name="businessType" value="([^"]+)"/) ?? [])[1] ?? '');
      return { ok: res.ok && !!url && !!token, wsUrl: toWs(url), start: { token, bt }, detail: `${res.status}` };
    },
    startFrames: ({ callSid, streamSid, start }) => [
      { event: 'connected', protocol: 'Call', version: '1.0.0' },
      { event: 'start', sequenceNumber: '1', streamSid, start: { streamSid, callSid, accountSid: 'ACmock', tracks: ['inbound'], customParameters: { businessType: start.bt, streamToken: start.token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } },
    ],
    callerFrame: ({ streamSid, seq }) => ({ event: 'media', sequenceNumber: String(seq), streamSid, media: { track: 'inbound', chunk: String(seq), timestamp: String(seq * 20), payload: Buffer.alloc(160, 0xff).toString('base64') } }),
    // → { kind: 'audio', bytes, ok } | { kind: 'mark', name } | { kind: 'clear' }
    outbound(m) {
      if (m.event === 'media') { const b = Buffer.from(m.media?.payload ?? '', 'base64'); return { kind: 'audio', ms: b.length / 8, ok: b.length > 0 && !!m.streamSid, why: 'µ-law with streamSid' }; }
      if (m.event === 'mark') return { kind: 'mark', name: m.mark?.name };
      if (m.event === 'clear') return { kind: 'clear' };
      return { kind: 'other' };
    },
    ack: ({ streamSid, name }) => ({ event: 'mark', streamSid, mark: { name } }),
    stop: ({ streamSid, callSid }) => ({ event: 'stop', streamSid, stop: { callSid } }),
    async afterStream({ callSid }) {
      const params = { CallSid: callSid, CallStatus: 'in-progress' };
      const res = await fetch(`${BASE}/twilio/after-stream`, { method: 'POST', body: form(params), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSig(`${BASE}/twilio/after-stream`, params) } });
      const xml = await res.text();
      return (xml.match(/<Dial[^>]*>([^<]+)<\/Dial>/) ?? [])[1] ?? null;
    },
  },

  exotel: {
    async open({ number, from, callSid }) {
      const q = new URLSearchParams({ CallSid: callSid, CallFrom: from, CallTo: number, key: SECRETS.EXOTEL_WEBHOOK_SECRET });
      const res = await fetch(`${BASE}/exotel/voicebot?${q}`);
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && !!body.url, wsUrl: toWs(body.url ?? ''), start: {}, detail: `${res.status}` };
    },
    startFrames: ({ callSid, streamSid, number, from }) => [
      { event: 'connected' },
      { event: 'start', sequence_number: 1, stream_sid: streamSid, start: { stream_sid: streamSid, call_sid: callSid, account_sid: 'mock', from, to: number, custom_parameters: '', media_format: { encoding: 'base64', sample_rate: '8000', bit_rate: '128kbps' } } },
    ],
    // Exotel sends 16-bit PCM, 8 kHz: 320 bytes per 20 ms.
    callerFrame: ({ streamSid, seq }) => ({ event: 'media', sequence_number: seq, stream_sid: streamSid, media: { chunk: seq, timestamp: String(seq * 20), payload: Buffer.alloc(320, 0).toString('base64') } }),
    outbound(m) {
      if (m.event === 'media') {
        const b = Buffer.from(m.media?.payload ?? '', 'base64');
        return { kind: 'audio', ms: b.length / 16, ok: b.length > 0 && b.length % 320 === 0 && b.length <= 100000 && !!m.stream_sid, why: `PCM16 ${b.length} bytes, multiple of 320, ≤100 000` };
      }
      if (m.event === 'mark') return { kind: 'mark', name: m.mark?.name };
      if (m.event === 'clear') return { kind: 'clear' };
      return { kind: 'other' };
    },
    ack: ({ streamSid, name }) => ({ event: 'mark', stream_sid: streamSid, mark: { name } }),
    stop: ({ streamSid, callSid }) => ({ event: 'stop', stream_sid: streamSid, stop: { call_sid: callSid, reason: 'stopped' } }),
    async afterStream({ callSid }) {
      const q = new URLSearchParams({ CallSid: callSid, key: SECRETS.EXOTEL_WEBHOOK_SECRET });
      const passthru = await fetch(`${BASE}/exotel/after-stream?${q}`, { redirect: 'manual' });
      if (passthru.status !== 200) return null;
      const connect = await (await fetch(`${BASE}/exotel/connect?${q}`)).json().catch(() => ({}));
      return connect?.destination?.numbers?.[0] ?? null;
    },
  },

  plivo: {
    async open({ number, from, callSid }) {
      const params = { CallUUID: callSid, From: from, To: number, Direction: 'inbound', CallStatus: 'in-progress' };
      const nonce = randomUUID().replace(/-/g, '');
      const res = await fetch(`${BASE}/plivo/answer`, {
        method: 'POST', body: form(params),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Plivo-Signature-V3': plivoSig(`${BASE}/plivo/answer`, params, nonce), 'X-Plivo-Signature-V3-Nonce': nonce },
      });
      const xml = await res.text();
      const url = unxml((xml.match(/<Stream[^>]*>([^<]+)<\/Stream>/) ?? [])[1] ?? '');
      return { ok: res.ok && !!url, wsUrl: toWs(url), start: {}, detail: `${res.status}` };
    },
    startFrames: ({ callSid, streamSid, number, from }) => [
      { event: 'start', sequenceNumber: 0, start: { callId: callSid, streamId: streamSid, accountId: 'MAmock', from, to: number, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } }, extra_headers: '' },
    ],
    callerFrame: ({ streamSid, seq }) => ({ event: 'media', sequenceNumber: seq, streamId: streamSid, media: { track: 'inbound', timestamp: String(seq * 20), chunk: seq, payload: Buffer.alloc(160, 0xff).toString('base64') } }),
    outbound(m) {
      if (m.event === 'playAudio') {
        const b = Buffer.from(m.media?.payload ?? '', 'base64');
        return { kind: 'audio', ms: b.length / 8, ok: b.length > 0 && m.media?.contentType === 'audio/x-mulaw' && m.media?.sampleRate === 8000, why: 'audio/x-mulaw @ 8000' };
      }
      if (m.event === 'checkpoint') return { kind: 'mark', name: m.name };
      if (m.event === 'clearAudio') return { kind: 'clear' };
      return { kind: 'other' };
    },
    ack: ({ streamSid, name }) => ({ event: 'playedStream', streamId: streamSid, name }),
    stop: ({ streamSid }) => ({ event: 'stop', streamId: streamSid }),
    async afterStream({ callSid }) {
      const params = { CallUUID: callSid, CallStatus: 'in-progress' };
      const nonce = randomUUID().replace(/-/g, '');
      const res = await fetch(`${BASE}/plivo/after-stream`, { method: 'POST', body: form(params), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Plivo-Signature-V3': plivoSig(`${BASE}/plivo/after-stream`, params, nonce), 'X-Plivo-Signature-V3-Nonce': nonce } });
      const xml = await res.text();
      return (xml.match(/<Number>([^<]+)<\/Number>/) ?? [])[1] ?? null;
    },
  },
};

// ── One simulated call ───────────────────────────────────────────────────────

async function placeCall(mocks, { carrier, number, from, lines }) {
  const c = CARRIERS[carrier];
  const callSid = `${carrier === 'twilio' ? 'CA' : ''}e2e${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const streamSid = `MZe2e${Date.now()}`;
  const call = { startedAt: Date.now(), callSid, streamSid, number, from, audioFrames: 0, badFrames: [], marks: 0, cleared: 0, closedByServer: false };
  const opened = await c.open({ number, from, callSid });
  call.webhook = opened;
  if (!opened.ok) return call;

  const ws = new WebSocket(opened.wsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let lastAudioAt = 0, pendingAcks = 0, playedUntil = 0;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    const o = c.outbound(m);
    if (o.kind === 'audio') {
      call.audioFrames++;
      if (!o.ok) call.badFrames.push(o.why);
      lastAudioAt = Date.now();
      playedUntil = Math.max(playedUntil, Date.now()) + o.ms;   // the caller's phone plays it in real time
    } else if (o.kind === 'mark') {
      call.marks++;
      pendingAcks++;
      setTimeout(() => {
        pendingAcks--;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(c.ack({ streamSid, name: o.name })));
      }, Math.max(0, playedUntil - Date.now()));
    } else if (o.kind === 'clear') {
      call.cleared++;
      playedUntil = Date.now();
    }
  });
  const closed = new Promise(r => ws.once('close', () => { call.closedByServer = !call.closingByUs; r(); }));
  for (const f of c.startFrames({ callSid, streamSid, number, from, start: opened.start })) ws.send(JSON.stringify(f));

  // The caller's line: 20 ms frames, as a phone sends them, for the whole call.
  let seq = 2;
  const pump = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(c.callerFrame({ streamSid, seq: seq++ }))); }, 20);

  // Wait until the assistant has spoken (new audio after `since`), finished,
  // and the caller has heard it — or the server hung up.
  const quiet = async (since, timeoutMs = 20000) => {
    while (Date.now() - since < timeoutMs) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (lastAudioAt > since && Date.now() - lastAudioAt > 900 && pendingAcks === 0 && Date.now() > playedUntil) return;
      await sleep(100);
    }
  };

  const ttsBefore = mocks.log.tts.length;
  await quiet(Date.now() - 1);
  call.greeting = mocks.log.tts.slice(ttsBefore).map(t => t.text);
  call.turns = [];
  for (const line of lines) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const before = mocks.log.tts.length;
    for (let i = 0; i < 30 && !mocks.sttKind(); i++) await sleep(100);
    const saidAt = Date.now();
    await mocks.say(line);
    await Promise.race([quiet(saidAt), closed]);
    call.turns.push({ said: line, heard: mocks.log.tts.slice(before).map(t => t.text) });
  }
  clearInterval(pump);
  if (ws.readyState === WebSocket.OPEN) {
    call.closingByUs = true;
    ws.send(JSON.stringify(c.stop({ streamSid, callSid })));
    ws.close();
  }
  await Promise.race([closed, sleep(2000)]);
  call.transferTo = await c.afterStream({ callSid });
  await sleep(1500);   // usage and transcripts are written after the call (waitUntil)
  return call;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const NOTICE = { en: /AI assistant.*transcribed/i, hi: /AI सहायक/ };

async function callScenario(mocks, s) {
  console.log(`\n▶ ${s.name}`);
  const ttsStart = mocks.log.tts.length, sttStart = mocks.log.stt.length;
  const audioStart = { ...mocks.log.sttAudio };
  const call = await placeCall(mocks, s);
  const n = s.name;
  check(n, `${s.carrier} webhook returns a signed stream`, call.webhook?.ok, call.webhook?.detail);
  if (!call.webhook?.ok) return;
  check(n, 'assistant answers with a greeting', call.greeting?.length > 0, JSON.stringify(call.greeting?.slice(0, 3)));
  const heard = mocks.log.tts.slice(ttsStart);
  const noticeAt = heard.findIndex(t => NOTICE[s.noticeLang ?? 'en'].test(t.text));
  if (s.expectNotice) {
    const greetAt = heard.findIndex((t, i) => i > noticeAt && /reached|पहुँच|assistant|सहायक/i.test(t.text) && !NOTICE[s.noticeLang ?? 'en'].test(t.text));
    check(n, `AI / recording notice is spoken (${s.noticeLang ?? 'en'}) before the greeting`, noticeAt >= 0 && (greetAt < 0 || noticeAt < greetAt), noticeAt >= 0 ? heard[noticeAt].text.slice(0, 70) : 'not heard');
  } else {
    check(n, 'no AI notice for a business outside India', noticeAt < 0);
  }
  check(n, `${s.carrier} audio frames are in the carrier's format`, call.audioFrames > 0 && call.badFrames.length === 0, `${call.audioFrames} frames${call.badFrames.length ? `, bad: ${call.badFrames[0]}` : ''}`);
  check(n, 'playback marks are sent and acknowledged', call.marks > 0, `${call.marks} marks`);
  // A non-default voice is applied once the business is known; the last
  // socket opened is the one the call used.
  const stt = mocks.log.stt.slice(sttStart).at(-1);
  check(n, `speech recognition is ${s.stt}`, stt?.kind === s.stt, JSON.stringify(stt?.query ?? {}).slice(0, 120));
  if (s.stt === 'deepgram') check(n, 'Deepgram gets µ-law 8 kHz audio', stt?.query?.encoding === 'mulaw' && stt?.query?.sample_rate === '8000' && mocks.log.sttAudio.deepgram > audioStart.deepgram, `${mocks.log.sttAudio.deepgram - audioStart.deepgram} bytes`);
  if (s.stt === 'sarvam') check(n, 'Sarvam gets 16 kHz PCM in hi-IN', stt?.query?.['language-code'] === 'hi-IN' && [...mocks.log.sarvamSttFormats].some(f => f.endsWith('@16000')) && mocks.log.sttAudio.sarvam > audioStart.sarvam, `${[...mocks.log.sarvamSttFormats].join(',')}`);
  // The opener may be synthesized in the default voice before the business's
  // voice is known (then dropped); from the first line in its voice, all are.
  const first = heard.findIndex(t => t.provider === s.tts);
  const voiced = first < 0 ? [] : heard.slice(first);
  const tts = voiced[0];
  if (first > 0) check(n, 'default-voice opener requests before the switch (cost only, not heard)', true, `${first} request(s): ${heard.slice(0, first).map(t => t.provider).join(', ')}`);
  if (s.tts === 'cartesia') check(n, 'Cartesia asked for raw µ-law 8 kHz', voiced.length > 0 && voiced.every(t => t.provider === 'cartesia' && t.format?.encoding === 'pcm_mulaw' && t.format?.sample_rate === 8000), JSON.stringify(tts?.format));
  if (s.tts === 'sarvam') check(n, 'Sarvam TTS asked for µ-law 8 kHz in hi-IN', voiced.length > 0 && voiced.every(t => t.provider === 'sarvam' && t.format?.codec === 'mulaw' && t.format?.sample_rate === 8000 && t.format?.language === 'hi-IN'), JSON.stringify(tts?.format));

  const bookings = await api('GET', `/admin/bookings/${s.key}`);
  const booked = (Array.isArray(bookings) ? bookings : bookings?.bookings ?? []).find(b => (b.customerName ?? b.customer_name) === 'Priya Sharma');
  const toolResults = mocks.log.anthropic.filter(a => a.toolResult && a.at >= call.startedAt).map(a => a.toolResult);
  check(n, 'spoken booking is saved', !!booked, booked ? `${booked.productName ?? booked.product_name} at ${booked.scheduledAt ?? booked.scheduled_at}` : `tool results: ${JSON.stringify(toolResults).slice(0, 400)}`);
  if (s.transfer) {
    check(n, '"speak to someone" ends the stream', call.closedByServer);
    check(n, 'after-stream webhook dials the staff phone', call.transferTo && call.transferTo.replace(/\D/g, '').endsWith(s.staffPhone.replace(/\D/g, '').slice(-10)), `dials ${call.transferTo}`);
  }
  const usage = await api('GET', `/admin/billing/usage/${s.key}`);
  const rec = (Array.isArray(usage) ? usage : usage?.records ?? []).find(r => (r.sourceId ?? r.source_id) === call.callSid);
  check(n, 'call is metered for billing', rec && (rec.provider === s.carrier), rec ? `${rec.provider}, ${rec.durationSeconds ?? rec.duration_seconds}s, cost ${rec.costUsdMicros ?? rec.cost_usd_micros}µ$` : 'no usage record');
  if (s.expectNotice) {
    const notices = await api('GET', `/admin/privacy/${s.key}/notices`);
    const rows = (Array.isArray(notices) ? notices : []).filter(r => (r.call_sid ?? r.callSid) === call.callSid);
    check(n, 'notice is in the consent audit trail', rows.length === 1, rows[0] ? `heard_fully=${rows[0].heard_fully}` : 'missing');
  }
}

async function rzpHook(event, payload, eventId = `evt_${randomUUID()}`, signature) {
  const raw = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = signature ?? createHmac('sha256', SECRETS.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  return fetch(`${BASE}/razorpay/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': eventId } });
}
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'X-Admin-Key': ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

async function razorpayScenario(mocks) {
  const n = 'Razorpay billing';
  console.log(`\n▶ ${n}`);
  const B = 'in_exotel', OWNER = 'billing@clinic.example';
  const emailsTo = (re, since) => mocks.log.email.filter(e => e.to === OWNER && re.test(e.subject) && e.at >= since);

  // Trial: the seeded Starter plan (14-day trial) on the Hindi Plivo business.
  await api('PUT', '/admin/billing/accounts/in_plivo_hi', { planId: 'in_starter' });
  const trial = await api('GET', '/billing/in_plivo_hi');
  check(n, 'trial: a new plan starts a 14-day free trial, next action Subscribe', trial?.state === 'trialing' && trial.trialDaysLeft === 14 && trial.nextAction === 'subscribe', `state=${trial?.state}, ${trial?.trialDaysLeft} days, ${trial?.nextAction}`);

  // A no-trial plan with every minute billed as overage, so month-end has something to bill.
  await api('PUT', '/admin/billing/plans/e2e_metered', { name: 'E2E Metered', monthlyFeePaise: 100000, includedMinutes: 0, overagePaisePerMinute: 700, trialDays: 0, gstRateBps: 1800 });
  await api('PUT', `/admin/billing/accounts/${B}`, { planId: 'e2e_metered' });
  await api('PUT', `/billing/${B}/details`, { legalName: 'Exotel Clinic Pvt Ltd', billingEmail: OWNER, gstin: '27AAACR5055K1Z7', state: 'Maharashtra' });
  const plan = await api('POST', '/admin/billing/plans/e2e_metered/razorpay');
  const planCall = mocks.log.razorpay.find(r => r.path === '/v1/plans' && r.auth);
  check(n, 'plan is created in Razorpay (monthly, fee incl. GST)', /^plan_/.test(plan?.razorpayPlanId ?? '') && planCall?.body?.period === 'monthly' && planCall?.body?.item?.amount === 118000, `${plan?.razorpayPlanId}, ₹${(planCall?.body?.item?.amount ?? 0) / 100}`);

  const sub = await api('POST', `/billing/${B}/subscribe`);
  check(n, 'subscription is created for Checkout, prefilled', /^sub_/.test(sub?.subscriptionId ?? '') && sub?.keyId === SECRETS.RAZORPAY_KEY_ID && sub?.prefill?.email === OWNER, `${sub?.subscriptionId}, prefill ${sub?.prefill?.email}`);
  const id = sub.subscriptionId;

  const badSig = await post(`/billing/${B}/confirm`, { razorpay_payment_id: 'pay_e2e1', razorpay_subscription_id: id, razorpay_signature: 'f'.repeat(64) });
  const goodSig = await post(`/billing/${B}/confirm`, { razorpay_payment_id: 'pay_e2e1', razorpay_subscription_id: id, razorpay_signature: createHmac('sha256', SECRETS.RAZORPAY_KEY_SECRET).update(`pay_e2e1|${id}`).digest('hex') });
  check(n, 'Checkout: a bad payment signature is refused', badSig.status === 400, `${badSig.status}`);
  check(n, 'Checkout: a valid payment signature is accepted', goodSig.ok && (await api('GET', `/billing/${B}`))?.account?.subscriptionStatus === 'authenticated', `${goodSig.status}`);

  const s = mocks.razorpaySub(id);
  Object.assign(s, { status: 'active', customer_id: 'cust_e2e', current_end: Math.floor(Date.now() / 1000) + 30 * 86400 });
  const bad = await rzpHook('subscription.activated', { subscription: { entity: { id } } }, 'evt_bad', 'bad');
  check(n, 'webhook with a bad signature is refused', bad.status === 401, `${bad.status}`);
  const ok = await rzpHook('subscription.activated', { subscription: { entity: { id } } }, 'evt_e2e_1');
  const again = await rzpHook('subscription.activated', { subscription: { entity: { id } } }, 'evt_e2e_1');
  let sum = await api('GET', `/billing/${B}`);
  check(n, 'subscription.activated → active (redelivery is a no-op)', ok.ok && again.ok && sum?.state === 'active' && sum.account.subscriptionStatus === 'active' && sum.nextCharge?.amountPaise === 118000, `state=${sum?.state}, next ${JSON.stringify(sum?.nextCharge)}`);

  // Failed charge: Razorpay marks the subscription pending and sends payment.failed.
  let t = Date.now();
  s.status = 'pending';
  await rzpHook('payment.failed', { payment: { entity: { id: 'pay_fail1', entity: 'payment', status: 'failed', invoice_id: 'inv_fail1', customer_id: 'cust_e2e', error_description: 'Card declined by bank', created_at: Math.floor(Date.now() / 1000) } } });
  await rzpHook('subscription.pending', { subscription: { entity: { id } } });
  sum = await api('GET', `/billing/${B}`);
  check(n, 'payment.failed → past_due, next action Update payment, overage still allowed in grace', sum?.state === 'past_due' && sum.nextAction === 'update_payment' && sum.overageAllowed === true && sum.payment?.lastError === 'Card declined by bank', `state=${sum?.state}, ${sum?.nextAction}, grace to ${sum?.payment?.graceEndsAt}`);
  await sleep(300);
  const dunning = emailsTo(/payment failed/i, t);
  check(n, 'dunning email reaches the owner once (Resend)', dunning.length === 1 && /keeps answering every call/.test(dunning[0].text), `${dunning.length} email(s): ${dunning[0]?.subject}`);
  const upd = await api('POST', `/billing/${B}/update-payment`);
  check(n, 'Update payment opens Razorpay\'s hosted page', upd?.url === 'https://rzp.io/i/mock', JSON.stringify(upd));

  s.status = 'halted';
  await rzpHook('subscription.halted', { subscription: { entity: { id } } });
  sum = await api('GET', `/billing/${B}`);
  check(n, 'subscription.halted → past_due, overage stops (calls never cut off)', sum?.state === 'past_due' && sum.account.subscriptionStatus === 'halted' && sum.overageAllowed === false, `status=${sum?.account?.subscriptionStatus}, overageAllowed=${sum?.overageAllowed}`);

  // The owner pays the due invoice: Razorpay reactivates and charges.
  s.status = 'active';
  await rzpHook('subscription.charged', { subscription: { entity: { id } }, payment: { entity: { id: 'pay_ok1' } } });
  sum = await api('GET', `/billing/${B}`);
  check(n, 'subscription.charged after recovery → active again', sum?.state === 'active' && sum.overageAllowed === true, `state=${sum?.state}`);

  // Month end: this month's metered minutes (the e2e call) become an add-on incl. GST.
  const period = sum.usage.period, minutes = sum.usage.minutes;
  const closed = await api('POST', '/admin/billing/close-period', { period });
  const addon = mocks.log.razorpay.find(r => r.method === 'POST' && r.path === `/v1/subscriptions/${id}/addons`);
  const want = Math.round(minutes * 700 * 1.18);
  check(n, 'month-end overage → one Razorpay add-on, amount incl. GST', minutes > 0 && closed.find(c => c.businessType === B)?.status === 'billed' && addon?.body?.item?.amount === want, `${minutes} min → ₹${(addon?.body?.item?.amount ?? 0) / 100} (want ₹${want / 100})`);
  const rerun = await api('POST', '/admin/billing/close-period', { period });
  check(n, 'closing the month again adds nothing', !rerun.some(c => c.businessType === B) && mocks.log.razorpay.filter(r => r.path.endsWith('/addons')).length === 1);

  // Razorpay charges the next invoice (plan + add-on) → GST tax invoice, emailed.
  t = Date.now();
  const inv = { id: 'inv_e2e_1', entity: 'invoice', subscription_id: id, status: 'paid', amount: 118000 + want, amount_paid: 118000 + want, paid_at: Math.floor(Date.now() / 1000),
    line_items: [{ type: 'plan', name: 'E2E Metered', net_amount: 118000, quantity: 1 }, { type: 'addon', name: `Extra minutes ${period}`, net_amount: want, quantity: 1 }] };
  await rzpHook('invoice.paid', { invoice: { entity: inv }, payment: { entity: { id: 'pay_inv1' } } });
  sum = await api('GET', `/billing/${B}`);
  const ti = sum?.taxInvoices?.[0];
  const gst = ti ? ti.cgst + ti.sgst + ti.igst : 0;
  check(n, 'invoice.paid → GST tax invoice: CGST+SGST (same state), totals add up, numbered', ti && ti.totalPaise === 118000 + want && ti.igst === 0 && ti.cgst > 0 && ti.taxablePaise + gst === ti.totalPaise && Math.abs(gst - Math.round(ti.taxablePaise * 0.18)) <= 1 && /^AVY\/\d\d-\d\d\/000001$/.test(ti.number), ti ? `${ti.number}: ₹${ti.taxablePaise / 100} + CGST ₹${ti.cgst / 100} + SGST ₹${ti.sgst / 100} = ₹${ti.totalPaise / 100}` : 'none');
  const html = ti ? await fetch(`${BASE}/billing/${B}/invoices/${ti.id}`, { headers: { 'X-Admin-Key': ADMIN } }) : null;
  const htmlText = html ? await html.text() : '';
  await sleep(300);
  check(n, 'tax invoice is downloadable (print view) and emailed', html?.ok && /Tax invoice/.test(htmlText) && htmlText.includes(SECRETS.BILLING_SUPPLIER_GSTIN) && emailsTo(/Tax invoice/, t).some(e => e.html), `${html?.status}, ${emailsTo(/Tax invoice/, t).length} email(s)`);

  // Cancel at period end, then Razorpay cancels at the cycle end.
  const cancel = await api('POST', `/billing/${B}/cancel`);
  const cancelCall = mocks.log.razorpay.find(r => r.path === `/v1/subscriptions/${id}/cancel`);
  sum = await api('GET', `/billing/${B}`);
  check(n, 'owner cancels at period end: still active, no next charge', cancel?.atPeriodEnd === true && cancelCall?.body?.cancel_at_cycle_end === 1 && sum?.state === 'active' && sum.cancelAtPeriodEnd && !sum.nextCharge, `state=${sum?.state}, cancelAtPeriodEnd=${sum?.cancelAtPeriodEnd}`);
  s.status = 'cancelled';
  await rzpHook('subscription.cancelled', { subscription: { entity: { id } } });
  sum = await api('GET', `/billing/${B}`);
  check(n, 'subscription.cancelled → cancelled, next action Subscribe', sum?.state === 'cancelled' && sum.nextAction === 'subscribe', `state=${sum?.state}`);

  const all = await api('GET', '/admin/billing/accounts');
  const us = all.find(a => a.businessType === 'us_twilio');
  check(n, 'operator sees every business; the US business stays billing-off', all.length >= 3 && us?.state === 'off' && !us.plan, `${all.length} businesses, us_twilio ${us?.state}`);
}

// ── WhatsApp (Meta Cloud API webhook → Graph API mock) ───────────────────────

const WA = { pnid: '109000000000001', pnidHi: '109000000000002', unmapped: '109000000000777' };
let waSeq = 0;

function waBody(pnid, messages, extra = {}) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA_E2E', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '918047100099', phone_number_id: pnid }, contacts: messages.map(m => ({ profile: { name: 'Priya' }, wa_id: m.from })), messages, ...extra } }] }] });
}
const waSig = raw => `sha256=${createHmac('sha256', SECRETS.WA_APP_SECRET).update(raw).digest('hex')}`;
async function waPost(raw, sig = waSig(raw)) {
  return fetch(`${BASE}/whatsapp/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig } });
}
const waText = (from, text) => ({ from, id: `wamid.e2e${Date.now()}${waSeq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } });
const sends = (mocks, to, since = 0) => mocks.log.whatsapp.filter(w => w.method === 'POST' && w.body?.to === to && w.body?.type && w.at >= since);

/** Waits until the Worker has replied to `to` and gone quiet; returns the texts sent since `since`. */
async function waReplies(mocks, to, since, { min = 1, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  let n = -1, stableAt = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const got = sends(mocks, to, since);
    if (got.length !== n) { n = got.length; stableAt = Date.now(); }
    if (n >= min && Date.now() - stableAt > 1200) break;
    await sleep(150);
  }
  return sends(mocks, to, since);
}
const textOf = s => s.body?.text?.body ?? '';

async function whatsappScenario(mocks) {
  const n = 'WhatsApp (Meta Cloud API)';
  console.log(`\n▶ ${n}`);
  const notice = /AI assistant/;

  // Verification handshake.
  const ok = await fetch(`${BASE}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${SECRETS.WA_VERIFY_TOKEN}&hub.challenge=1158201444`);
  const bad = await fetch(`${BASE}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444`);
  const body = await ok.text();
  check(n, 'verification: right token → challenge, wrong → 403', ok.status === 200 && body === '1158201444' && bad.status === 403, `${ok.status} "${body}", ${bad.status}`);

  // Badly signed POST.
  const customer = '919812300001';
  let t = Date.now();
  const forged = await waPost(waBody(WA.pnid, [waText(customer, 'hello')]), 'sha256=' + '0'.repeat(64));
  await sleep(800);
  check(n, 'badly signed POST is refused (403, nothing sent)', forged.status === 403 && sends(mocks, customer, t).length === 0, `${forged.status}`);

  // A question.
  t = Date.now();
  const q = await waPost(waBody(WA.pnid, [waText(customer, 'Hi, what services do you offer?')]));
  const r1 = await waReplies(mocks, customer, t, { min: 2 });
  const first = r1.filter(s => s.body.type === 'text');
  check(n, 'signed message is acknowledged with 200', q.status === 200, `${q.status}`);
  check(n, 'reply goes from the mapped phone_number_id to the customer', first.length >= 1 && first.every(s => s.phoneNumberId === WA.pnid && s.version && s.auth), first.map(s => `${s.version}/${s.phoneNumberId}→${s.body.to}`).join(', '));
  check(n, 'DPDP notice comes first, then the answer', first.length >= 2 && notice.test(textOf(first[0])) && !notice.test(textOf(first.at(-1))) && textOf(first.at(-1)).length > 0, first.map(s => textOf(s).slice(0, 50)).join(' | '));
  check(n, 'message is marked as read (with typing indicator)', mocks.log.whatsapp.some(w => w.at >= t && w.body?.status === 'read' && w.body?.typing_indicator && w.phoneNumberId === WA.pnid));

  // Book through chat, with the same tools as calls.
  t = Date.now();
  await waPost(waBody(WA.pnid, [waText(customer, "I'd like to book an appointment.")]));
  const r2 = await waReplies(mocks, customer, t);
  t = Date.now();
  await waPost(waBody(WA.pnid, [waText(customer, 'The first one works.')]));
  const r3 = await waReplies(mocks, customer, t);
  const bookings = await api('GET', '/admin/bookings/in_wa');
  const booked = (Array.isArray(bookings) ? bookings : bookings?.bookings ?? []).find(b => (b.customerName ?? b.customer_name) === 'Priya Sharma');
  check(n, 'availability is offered in chat', r2.length >= 1 && /\d/.test(textOf(r2.at(-1))), textOf(r2.at(-1)).slice(0, 90));
  check(n, 'chat booking is saved, with the WhatsApp number as callback', !!booked && String(booked.callbackPhone ?? booked.callback_phone ?? '').replace(/\D/g, '').endsWith(customer.slice(-10)), booked ? `${booked.productName ?? booked.product_name} at ${booked.scheduledAt ?? booked.scheduled_at}` : 'no booking');
  check(n, 'booking confirmation is the reply', r3.length >= 1 && /book|confirm|all set/i.test(textOf(r3.at(-1))), textOf(r3.at(-1)).slice(0, 90));
  check(n, 'DPDP notice was sent once in the whole conversation', sends(mocks, customer).filter(s => notice.test(textOf(s))).length === 1);

  // Voice note (Deepgram).
  t = Date.now();
  const dgBefore = mocks.log.deepgramRest.length;
  const voiceId = `voice-${Buffer.from('Can I book an appointment please').toString('base64url')}`;
  await waPost(waBody(WA.pnid, [{ from: customer, id: `wamid.e2evoice${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: voiceId, mime_type: 'audio/ogg; codecs=opus', voice: true } }]));
  const r4 = await waReplies(mocks, customer, t);
  const dg = mocks.log.deepgramRest.slice(dgBefore)[0];
  check(n, 'voice note is downloaded and transcribed', !!dg && dg.query.language === 'en' && mocks.log.whatsapp.some(w => w.at >= t && w.path.startsWith('/media-download/')), dg ? JSON.stringify(dg.query) : 'Deepgram not called');
  check(n, 'voice note gets an answer', r4.length >= 1 && textOf(r4.at(-1)).length > 0, textOf(r4.at(-1)).slice(0, 90));

  // Retried duplicate.
  t = Date.now();
  const dup = waBody(WA.pnid, [waText(customer, 'What are your hours?')]);
  const d1 = await waPost(dup);
  const d2 = await waPost(dup);
  await waReplies(mocks, customer, t);
  const d3 = await waPost(dup);
  await sleep(1500);
  check(n, 'retried webhook (same message id) is answered once', d1.ok && d2.ok && d3.ok && sends(mocks, customer, t).length === 1, `${sends(mocks, customer, t).length} replies`);

  // Status-only webhook.
  t = Date.now();
  const st = await waPost(waBody(WA.pnid, [], { messages: undefined, statuses: [{ id: 'wamid.x', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: customer }] }));
  await sleep(1500);
  check(n, 'status-only webhook: 200, no reply', st.status === 200 && mocks.log.whatsapp.filter(w => w.at >= t).length === 0, `${st.status}`);

  // Unmapped number.
  t = Date.now();
  const stranger = '919812300009';
  const um = await waPost(waBody(WA.unmapped, [waText(stranger, 'hello?')]));
  await sleep(2000);
  check(n, 'message to an unmapped number: 200, no reply as another business', um.status === 200 && mocks.log.whatsapp.filter(w => w.at >= t).length === 0, `${um.status}`);

  // Hindi business.
  const hiCustomer = '919812300002';
  t = Date.now();
  await waPost(waBody(WA.pnidHi, [waText(hiCustomer, 'नमस्ते, आपके यहाँ क्या सेवाएँ हैं?')]));
  const r5 = (await waReplies(mocks, hiCustomer, t, { min: 2 })).filter(s => s.body.type === 'text');
  const deva = /[\u0900-\u097F]/;
  check(n, 'Hindi business: notice and reply in Hindi, from its own number', r5.length >= 2 && r5.every(s => deva.test(textOf(s)) && s.phoneNumberId === WA.pnidHi) && /AI सहायक/.test(textOf(r5[0])), r5.map(s => textOf(s).slice(0, 40)).join(' | '));

  // Billing usage.
  const usage = await api('GET', '/admin/billing/usage/in_wa');
  const recs = (Array.isArray(usage) ? usage : usage?.records ?? []).filter(r => r.channel === 'whatsapp');
  check(n, 'WhatsApp conversation is recorded for billing (one, with model tokens)', recs.length === 1 && recs[0].provider === 'meta' && Number(recs[0].llmInputTokens ?? recs[0].llm_input_tokens ?? 0) > 0, recs[0] ? JSON.stringify({ provider: recs[0].provider, in: recs[0].llmInputTokens ?? recs[0].llm_input_tokens }) : 'no record');

  // Consent audit trail: one notice per customer.
  const notices = await api('GET', '/admin/privacy/in_wa/notices');
  const waNotices = (Array.isArray(notices) ? notices : []).filter(r => r.channel === 'whatsapp');
  check(n, 'notice is in the consent audit trail once', waNotices.length === 1, `${waNotices.length} row(s)`);
}

// ── WhatsApp production: templates, reminders, fallback, STOP, follow-ups, health ──
// Runs after the WhatsApp scenario (it reuses that chat's booking). Bookings
// are moved with SQL so the reminder timing is exact; the reminder job is
// run on demand with a fake clock (POST /admin/whatsapp/reminders/run {now}).

const sql = command => JSON.parse(wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', STATE, '--json', '--command', command]))[0]?.results ?? [];
const templateSends = (mocks, to, since) => sends(mocks, to, since).filter(s => s.body.type === 'template');

async function statusWebhook(name, language, event, reason) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: SECRETS.WA_BUSINESS_ACCOUNT_ID, changes: [{ field: 'message_template_status_update', value: { event, message_template_id: 1, message_template_name: name, message_template_language: language, reason: reason ?? 'NONE' } }] }] });
  return waPost(raw);
}

async function whatsappProdScenario(mocks) {
  const n = 'WhatsApp production';
  console.log(`\n▶ ${n}`);
  const B = 'in_wa', REM = 'avery_appointment_reminder', MISSED = 'avery_missed_call';

  // Templates: create Avery's defaults on Meta, then approval arrives by webhook / sync.
  const t0 = await api('GET', '/admin/whatsapp/templates');
  check(n, 'templates page: WABA configured, no event has an approved template yet', t0.wabaConfigured && t0.events.every(e => !e.ready) && t0.defaults.length === 4, JSON.stringify(t0.events.map(e => e.event)));
  const created = await api('POST', '/admin/whatsapp/templates', { event: 'reminder' });
  await api('POST', '/admin/whatsapp/templates', { event: 'missed_call' });
  const again = await api('POST', '/admin/whatsapp/templates', { event: 'reminder' });
  const onMeta = [...mocks.wa.templates.values()];
  check(n, 'template create: en, hi and Hinglish, UTILITY, sent to the WABA with examples', created.length === 3 && created.every(t => t.status === 'PENDING')
    && onMeta.some(t => t.name === REM && t.language === 'hi') && onMeta.some(t => t.name === `${REM}_hinglish` && t.language === 'en')
    && onMeta.every(t => t.category === 'UTILITY' && t.components[0].example?.body_text?.[0]?.length >= 1)
    && mocks.log.whatsapp.some(w => w.method === 'POST' && w.path.endsWith(`/${SECRETS.WA_BUSINESS_ACCOUNT_ID}/message_templates`)) && again.length === 0,
    `${created.map(t => `${t.name}/${t.language}:${t.status}`).join(', ')}; re-create made ${again.length}`);
  await api('PUT', '/admin/whatsapp/templates/choice', { event: 'reminder', family: REM });
  await api('PUT', '/admin/whatsapp/templates/choice', { event: 'missed_call', family: MISSED });

  // A booking 3 days out (business-local 11:00), with a number that isn't chatting (outside the 24-hour window).
  const day = new Date(Date.now() + 3 * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const start = `${day}T11:00:00`;
  const startUtc = Date.parse(`${start}+05:30`);
  const remindee = '919812300055';
  const order = sql(`SELECT id FROM orders WHERE business_type = '${B}' AND customer_name = 'Priya Sharma' LIMIT 1`)[0];
  sql(`UPDATE orders SET scheduled_at = '${start}', callback_phone = '+${remindee}', reminder_sent_at = NULL WHERE id = '${order?.id}'`);
  await api('PUT', `/admin/whatsapp/business/${B}`, { reminders: true });
  const runAt = (hoursBefore) => api('POST', '/admin/whatsapp/reminders/run', { now: new Date(startUtc - hoursBefore * 3600e3).toISOString() });
  const mine = r => r.filter(x => x.orderId === order?.id);

  // No approved template yet → SMS fallback.
  let t = Date.now();
  const r1 = mine(await runAt(23.5));
  const sms = mocks.log.sms.filter(m => m.at >= t && m.to === `+${remindee}`);
  check(n, 'reminder with no approved template falls back to SMS', r1[0]?.outcome === 'sms' && sms.length === 1 && /reminder/i.test(sms[0].body) && /STOP/.test(sms[0].body) && templateSends(mocks, remindee, t).length === 0, `${r1[0]?.outcome}; "${sms[0]?.body?.slice(0, 80)}"`);

  // Approval by webhook (en) and by sync (Hindi rejected on Meta).
  mocks.wa.templates.get(`${REM}|en`).status = 'APPROVED';
  mocks.wa.templates.get(`${MISSED}|en`).status = 'APPROVED';
  Object.assign(mocks.wa.templates.get(`${REM}|hi`), { status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' });
  const wh = await statusWebhook(REM, 'en', 'APPROVED');
  await statusWebhook(MISSED, 'en', 'APPROVED');
  await sleep(800);
  const afterHook = await api('GET', '/admin/whatsapp/templates');
  await api('POST', '/admin/whatsapp/templates/sync');
  const afterSync = await api('GET', '/admin/whatsapp/templates');
  const st = (rows, name, lang) => rows.templates.find(r => r.name === name && r.language === lang);
  check(n, 'template status: APPROVED by webhook, REJECTED (with reason) by sync; event shows ready', wh.status === 200 && st(afterHook, REM, 'en')?.status === 'APPROVED'
    && st(afterSync, REM, 'hi')?.status === 'REJECTED' && st(afterSync, REM, 'hi')?.rejectedReason === 'INVALID_FORMAT' && afterSync.events.find(e => e.event === 'reminder').ready,
    `en=${st(afterHook, REM, 'en')?.status} hi=${st(afterSync, REM, 'hi')?.status}`);

  // Timing: nothing 25 h before; the template 23.5 h before; only once.
  sql(`UPDATE orders SET reminder_sent_at = NULL, reminder_channel = NULL WHERE id = '${order?.id}'`);
  t = Date.now();
  const early = mine(await runAt(25));
  const due = mine(await runAt(23.5));
  const twice = mine(await runAt(23));
  const tpl = templateSends(mocks, remindee, t);
  const params = tpl[0]?.body.template?.components?.[0]?.parameters?.map(p => p.text) ?? [];
  check(n, 'reminder is sent 24 h before (not 25 h), as the approved template, once', early.length === 0 && due[0]?.outcome === 'whatsapp' && twice.length === 0 && tpl.length === 1
    && tpl[0].body.template.name === REM && tpl[0].body.template.language.code === 'en' && params[0] === 'WhatsApp Clinic' && /11:00/.test(params[2] ?? '') && tpl[0].phoneNumberId === WA.pnid,
    `${due[0]?.outcome}; ${tpl[0]?.body.template?.name} [${params.join(' | ')}]`);

  // STOP (in Hindi) is honoured: no template and no SMS; START resumes.
  t = Date.now();
  await waPost(waBody(WA.pnid, [waText(remindee, 'बंद करो')]));
  const stopReply = await waReplies(mocks, remindee, t);
  sql(`UPDATE orders SET reminder_sent_at = NULL, reminder_channel = NULL WHERE id = '${order?.id}'`);
  const t2 = Date.now();
  const blocked = mine(await runAt(23.5));
  const consent = sql(`SELECT action, source FROM messaging_consent WHERE business_type = '${B}' ORDER BY created_at`);
  check(n, 'STOP ("बंद करो") is confirmed and recorded; no reminder on WhatsApp or SMS afterwards', /unsubscribed/i.test(textOf(stopReply.at(-1) ?? {})) && blocked[0]?.outcome === 'skipped:opted_out'
    && templateSends(mocks, remindee, t2).length === 0 && mocks.log.sms.filter(m => m.at >= t2).length === 0 && consent.some(c => c.action === 'opt_out' && /keyword/.test(c.source)),
    `${blocked[0]?.outcome}; consent ${JSON.stringify(consent.map(c => c.action))}`);
  t = Date.now();
  await waPost(waBody(WA.pnid, [waText(remindee, 'START')]));
  const startReply = await waReplies(mocks, remindee, t);
  check(n, 'START opts back in', /subscribed again/i.test(textOf(startReply.at(-1) ?? {})) && sql(`SELECT action FROM messaging_consent WHERE customer_id_hashed = (SELECT customer_id_hashed FROM messaging_consent WHERE source LIKE 'keyword:START%' LIMIT 1) ORDER BY created_at DESC LIMIT 1`)[0]?.action === 'opt_in');

  // Missed-call follow-up: a caller who hangs up without speaking gets the template on WhatsApp.
  const off = templateSends(mocks, '919876543210', 0).length;   // the Exotel business has it off
  await api('PUT', `/admin/whatsapp/business/${B}`, { missedCallFollowup: true });
  t = Date.now();
  const caller = '919876500077';
  await placeCall(mocks, { carrier: 'exotel', number: '+918047100098', from: '09876500077', lines: [] });
  let fu = [];
  for (let i = 0; i < 30 && !fu.length; i++) { fu = templateSends(mocks, caller, t); if (!fu.length) await sleep(200); }
  check(n, 'missed-call follow-up: template invites the caller to WhatsApp (and not for a business with it off)', fu.length === 1 && fu[0].body.template.name === MISSED && fu[0].body.template.components[0].parameters[0].text === 'WhatsApp Clinic' && off === 0, `${fu.length} sent; ${off} for the business with it off`);

  // Owner Settings → WhatsApp.
  const owner = await api('GET', `/admin/whatsapp/business/${B}`);
  check(n, 'owner Settings → WhatsApp: number, switches, previews', owner.connected && owner.settings.reminders && owner.settings.missedCallFollowup && owner.ready.reminder && /WhatsApp Clinic/.test(owner.previews.reminder) && /STOP/.test(owner.previews.missed_call), JSON.stringify(owner.number));

  // Number health: Graph fields, webhook health, template statuses; a drop to YELLOW emails the operator once.
  const h1 = await api('POST', '/admin/whatsapp/health/refresh');
  const num = h1.numbers.find(x => x.phoneNumberId === WA.pnid);
  check(n, 'number health shows quality, tier, name status, verified name, last message and templates', num?.qualityRating === 'GREEN' && num.messagingLimitTier === 'TIER_1K' && num.nameStatus === 'APPROVED' && /Clinic/.test(num.verifiedName ?? '') && num.lastMessageAt > Date.now() - 600e3 && h1.templates.find(x => x.event === 'reminder')?.ready,
    num ? `${num.qualityRating} ${num.messagingLimitTier} ${num.nameStatus} "${num.verifiedName}"` : 'missing');
  mocks.wa.health.quality_rating = 'YELLOW';
  t = Date.now();
  await api('POST', '/admin/whatsapp/health/refresh');
  await api('POST', '/admin/whatsapp/health/refresh');
  mocks.wa.health.quality_rating = 'GREEN';
  const alerts = mocks.log.email.filter(e => e.at >= t && e.to === SECRETS.ADMIN_NOTIFY_EMAIL && /quality YELLOW/.test(e.subject));
  check(n, 'quality drop to YELLOW emails the operator once per number (two refreshes)', alerts.length === h1.numbers.length && new Set(alerts.map(a => a.subject)).size === alerts.length, `${alerts.length} email(s) for ${h1.numbers.length} number(s)`);

  // Both cron triggers run (hourly: reminders + health; daily: retention, billing, dunning).
  const hourly = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('17 * * * *')}`);
  const daily = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('47 20 * * *')}`);
  check(n, 'hourly and daily cron triggers both run', hourly.ok && daily.ok, `${hourly.status} / ${daily.status}`);
}

// ── Integrations: /admin/integrations against the stand-ins ──────────────────
// Google Calendar has no keys here (Not set up); Exotel has no API key for its
// live check (set up, not checked); every other service is set up and its
// stand-in answers, so its live check reports Working. Then Deepgram's
// stand-in starts refusing the key and echoing it back: the check shows
// Failing with an error that carries no secret.

async function integrationsScenario(mocks) {
  const n = 'integrations';
  console.log('\n▶ Integrations readiness');
  const before = await api('GET', '/admin/integrations');
  const by0 = Object.fromEntries(before.integrations.map(i => [i.id, i]));
  check(n, 'before any check: set-up services read "unchecked", missing ones "not_configured"', by0.anthropic.status === 'unchecked' && by0.google.status === 'not_configured' && by0.google.missing.includes('GOOGLE_CLIENT_ID'), `${by0.anthropic.status} / ${by0.google.status}`);

  const results = {};
  for (const i of before.integrations) results[i.id] = await api('POST', `/admin/integrations/${i.id}/check`);
  const after = await api('GET', '/admin/integrations');
  const st = Object.fromEntries(after.integrations.map(i => [i.id, i.status]));
  const working = ['cloudflare', 'core', 'anthropic', 'deepgram', 'cartesia', 'sarvam', 'twilio', 'plivo', 'resend', 'razorpay', 'whatsapp'];
  check(n, 'mocked services report Working', working.every(id => st[id] === 'ok'), working.filter(id => st[id] !== 'ok').map(id => `${id}=${st[id]}: ${results[id]?.error ?? results[id]?.note ?? ''}`).join(', ') || 'all ok');
  check(n, 'missing services report Not set up; Exotel without an API key is set up but not checked', st.google === 'not_configured' && st.exotel === 'unchecked' && /EXOTEL_API_KEY/.test(after.integrations.find(i => i.id === 'exotel').lastCheck?.note ?? ''), `google=${st.google} exotel=${st.exotel}`);
  check(n, 'production readiness: 100% with every blocker Working', after.readiness.score === 100 && after.readiness.blockers.length === 0, JSON.stringify(after.readiness));

  mocks.failing.add('api.deepgram.com');
  await sleep(10_500);   // the per-service cooldown
  const res = await fetch(`${BASE}/admin/integrations/deepgram/check`, { method: 'POST', headers: { 'X-Admin-Key': ADMIN } });
  const text = await res.text();
  const listText = await (await fetch(`${BASE}/admin/integrations`, { headers: { 'X-Admin-Key': ADMIN } })).text();
  mocks.failing.delete('api.deepgram.com');
  const fail = JSON.parse(text).data;
  const leaked = Object.values(SECRETS).filter(v => v.length >= 6 && (text.includes(v) || listText.includes(v)));
  check(n, 'a failing provider shows Failing with a safe error', fail?.ok === false && /^HTTP 401/.test(fail.error) && JSON.parse(listText).data.integrations.find(i => i.id === 'deepgram').status === 'fail', fail?.error);
  check(n, 'no secret value appears in any integrations response', leaked.length === 0, leaked.length ? `${leaked.length} leaked` : 'none');
  const again = await fetch(`${BASE}/admin/integrations/deepgram/check`, { method: 'POST', headers: { 'X-Admin-Key': ADMIN } });
  check(n, 'checks are rate limited', again.status === 429, `${again.status}`);

  // npm run preflight against this Worker: a checklist, never a value.
  const pf = spawnSync('node', ['scripts/preflight.mjs', '--no-wrangler', '--no-check'], { cwd: WORKER_DIR, encoding: 'utf8', env: { ...process.env, WORKER_URL: BASE, ADMIN_KEY: ADMIN } });
  const out = pf.stdout + pf.stderr;
  const pfLeaks = [ADMIN, ...Object.values(SECRETS)].filter(v => v.length >= 6 && out.includes(v));
  check(n, 'preflight prints the go-live checklist with ✓ / ✗ and next actions, and no secret', /✓ Anthropic/.test(out) && /✗ Google Calendar/.test(out) && /wrangler secret put GOOGLE_CLIENT_ID/.test(out) && pfLeaks.length === 0, `exit ${pf.status}; ${pfLeaks.length} leaked`);
}

const SCENARIOS = [
  {
    name: 'US business over Twilio (English)', key: 'us_twilio', carrier: 'twilio', country: 'US',
    number: '+13125550199', from: '+13125550123', staffPhone: '+13125550100', stt: 'deepgram', tts: 'cartesia',
    expectNotice: false, transfer: true,
    lines: ["Hi, I'd like to book an appointment.", 'The first one works.', 'Can I speak to someone please?'],
  },
  {
    name: 'Indian business over Exotel (English)', key: 'in_exotel', carrier: 'exotel', country: 'IN',
    number: '+918047100000', from: '09876543210', staffPhone: '+919876500000', stt: 'deepgram', tts: 'cartesia',
    expectNotice: true, noticeLang: 'en', transfer: true,
    lines: ["Hello, I'd like to book an appointment.", 'The first one works.', 'Can I speak to someone please?'],
  },
  {
    name: 'Indian business over Plivo (Hindi, Sarvam)', key: 'in_plivo_hi', carrier: 'plivo', country: 'IN',
    number: '+918047100001', from: '+919812345678', staffPhone: '+919876500001', stt: 'sarvam', tts: 'sarvam',
    voice: { voice_language: 'hi', stt_provider: 'sarvam', tts_provider: 'sarvam' },
    expectNotice: true, noticeLang: 'hi', transfer: true,
    lines: ['नमस्ते, मुझे अपॉइंटमेंट बुक करना है।', 'पहला वाला ठीक है।', 'क्या मैं किसी से बात कर सकता हूँ?'],
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

const mocks = await startMocks();
let worker;
try {
  console.log(`mocks on ${mocks.url}; starting the Worker on ${BASE} …`);
  worker = await startWorker(mocks.url);
  for (const s of SCENARIOS) {
    await setupBusiness({ key: s.key, name: s.name.split(' over ')[0], country: s.country, phone: s.staffPhone, number: s.number, provider: s.carrier, voice: s.voice });
  }
  if (!only || 'whatsapp'.includes(only)) {
    await setupBusiness({ key: 'in_wa', name: 'WhatsApp Clinic', country: 'IN', phone: '+919876500002', number: '+918047100098', provider: 'exotel' });
    await setupBusiness({ key: 'in_wa_hi', name: 'WhatsApp Hindi Clinic', country: 'IN', phone: '+919876500003', number: '+918047100097', provider: 'exotel', voice: { voice_language: 'hi', stt_provider: 'sarvam', tts_provider: 'sarvam' } });
    await api('PUT', '/admin/whatsapp-numbers', { phoneNumberId: WA.pnid, businessType: 'in_wa', label: 'E2E clinic' });
    await api('PUT', '/admin/whatsapp-numbers', { phoneNumberId: WA.pnidHi, businessType: 'in_wa_hi', label: 'E2E Hindi clinic' });
  }
  // The Razorpay scenario bills the Exotel business's call minutes, so `-- razorpay` places that call too.
  for (const s of SCENARIOS) if (!only || s.name.toLowerCase().includes(only) || s.carrier === only || (only === 'razorpay' && s.key === 'in_exotel')) await callScenario(mocks, s);
  if (!only || 'razorpay'.includes(only)) await razorpayScenario(mocks);
  if (!only || 'whatsapp'.includes(only)) await whatsappScenario(mocks);
  if (!only || 'whatsapp'.includes(only)) await whatsappProdScenario(mocks);
  if (!only || 'integrations'.includes(only)) await integrationsScenario(mocks);
} catch (e) {
  console.error('\n✗ e2e run failed:', e.stack || e);
  results.push({ scenario: 'run', name: 'harness', ok: false, detail: String(e.message || e) });
} finally {
  if (worker) { try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* gone */ } }
  await mocks.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map(f => `  ✗ [${f.scenario}] ${f.name} — ${f.detail}`).join('\n')}` : ''}`);
if (failed.length && !process.env.E2E_KEEP) console.log(`(wrangler log: ${join(STATE, 'wrangler.log')})`);
process.exit(failed.length ? 1 : 0);
