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
// notice is in the consent audit trail. Plus Razorpay: plan sync →
// subscription → signed webhook → account active.

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
  EXOTEL_WEBHOOK_SECRET: 'ex-secret-mock', PLIVO_AUTH_TOKEN: 'pl-auth-mock', PLIVO_WEBHOOK_URL: BASE,
  RAZORPAY_KEY_ID: 'rzp_test_mock', RAZORPAY_KEY_SECRET: 'rzp-secret-mock', RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook-mock',
  RESEND_API_KEY: 're_mock', EMAIL_FROM: 'Avery <test@example.com>',
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
  const args = ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE,
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
  const call = { callSid, streamSid, number, from, audioFrames: 0, badFrames: [], marks: 0, cleared: 0, closedByServer: false };
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
  check(n, 'spoken booking is saved', !!booked, booked ? `${booked.productName ?? booked.product_name} at ${booked.scheduledAt ?? booked.scheduled_at}` : JSON.stringify(call.turns?.map(t => t.heard)).slice(0, 200));
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

async function razorpayScenario(mocks) {
  const n = 'Razorpay subscription';
  console.log(`\n▶ ${n}`);
  await api('PUT', '/admin/billing/accounts/in_exotel', { planId: 'in_starter' });
  const plan = await api('POST', '/admin/billing/plans/in_starter/razorpay');
  check(n, 'plan is created in Razorpay', mocks.log.razorpay.some(r => r.path === '/v1/plans' && r.auth), JSON.stringify(plan).slice(0, 80));
  const sub = await api('POST', '/billing/in_exotel/subscribe');
  check(n, 'subscription is created for checkout', /^sub_/.test(sub?.subscriptionId ?? ''), sub?.subscriptionId);
  const evt = { entity: 'event', event: 'subscription.activated', payload: { subscription: { entity: { id: sub.subscriptionId, status: 'active' } } }, created_at: Math.floor(Date.now() / 1000) };
  const raw = JSON.stringify(evt);
  const bad = await fetch(`${BASE}/razorpay/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad', 'X-Razorpay-Event-Id': 'evt_bad' } });
  check(n, 'webhook with a bad signature is refused', bad.status === 401, `${bad.status}`);
  const sig = createHmac('sha256', SECRETS.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  const ok = await fetch(`${BASE}/razorpay/webhook`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': 'evt_e2e_1' } });
  check(n, 'signed webhook is accepted', ok.ok, `${ok.status}`);
  const summary = await api('GET', '/billing/in_exotel');
  check(n, 'account becomes active', summary?.state === 'active', `state=${summary?.state}`);
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
  for (const s of SCENARIOS) if (!only || s.name.toLowerCase().includes(only) || s.carrier === only) await callScenario(mocks, s);
  if (!only || 'razorpay'.includes(only)) await razorpayScenario(mocks);
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
