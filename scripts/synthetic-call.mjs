#!/usr/bin/env node
/**
 * Synthetic phone-call monitor.
 *
 * Has Twilio dial the production number, speak a scripted question, hang up,
 * then checks the worker saved a transcript in which the assistant gave a real
 * answer. Passing means: phone line -> Twilio webhook -> routing -> Deepgram ->
 * Claude all worked end to end.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   Twilio credentials
 *   SYNTHETIC_FROM_NUMBER                   a Twilio number to call from (E.164)
 *   SYNTHETIC_TO_NUMBER                     the number under test (E.164)
 *   ADMIN_KEY                               worker X-Admin-Key (reads transcripts)
 * Optional env:
 *   WORKER_URL           default https://mogi-platform.premkumar-2ba.workers.dev
 *   SYNTHETIC_QUESTION   default "What are your opening hours today?"
 *   SYNTHETIC_PATTERN    regex the caller's turn must match, default "hour|open"
 *   SLACK_WEBHOOK_URL    if set, failures are posted here too
 */

const env = (k, d) => process.env[k] || d;
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`::error::Missing ${k} (see scripts/synthetic-call.mjs header)`); process.exit(2); }
  return v;
};

const SID = need('TWILIO_ACCOUNT_SID');
const TOKEN = need('TWILIO_AUTH_TOKEN');
const FROM = need('SYNTHETIC_FROM_NUMBER');
const TO = need('SYNTHETIC_TO_NUMBER');
const ADMIN_KEY = need('ADMIN_KEY');
const WORKER = env('WORKER_URL', 'https://mogi-platform.premkumar-2ba.workers.dev').replace(/\/$/, '');
const QUESTION = env('SYNTHETIC_QUESTION', 'What are your opening hours today?');
const PATTERN = new RegExp(env('SYNTHETIC_PATTERN', 'hour|open'), 'i');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const twAuth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const toMs = (t) => (typeof t === 'number' ? t * 1000 : new Date(t).getTime());

async function fail(msg) {
  console.error(`::error::Synthetic call FAILED: ${msg}`);
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (hook) {
    await fetch(hook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `:rotating_light: Mogi synthetic call failed: ${msg}` }),
    }).catch(() => {});
  }
  process.exit(1);
}

async function admin(path) {
  const res = await fetch(`${WORKER}${path}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(`${path}: ${res.status} ${json.error ?? ''}`);
  return json.data;
}

// 1. Which business should be answering right now?
const { effective: expected } = await admin('/admin/default-business').catch(e => fail(e.message));
if (!expected) await fail('worker reports no effective default business');
console.log(`expecting business: ${expected}`);

// 2. Place the call. The caller stays silent while the assistant greets
//    (~10s), asks its question, waits for the reply, then hangs up.
const twiml =
  `<Response><Pause length="14"/><Say voice="Polly.Joanna">${QUESTION}</Say><Pause length="18"/><Hangup/></Response>`;
const startedAt = Date.now();
const callRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`, {
  method: 'POST',
  headers: { Authorization: twAuth, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ To: TO, From: FROM, Twiml: twiml }),
});
const call = await callRes.json();
if (!callRes.ok) await fail(`Twilio refused the call: ${call.message ?? callRes.status}`);
console.log(`call ${call.sid} placed`);

// 3. Wait for it to finish.
let status = call.status;
for (let i = 0; i < 30 && !['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status); i++) {
  await sleep(5000);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/${call.sid}.json`, { headers: { Authorization: twAuth } });
  status = (await r.json()).status;
}
console.log(`call status: ${status}`);
if (status !== 'completed') await fail(`call ended as "${status}" (expected completed)`);

// 4. Find the transcript the worker saved for that call (written when the stream stops).
let match;
for (let i = 0; i < 12 && !match; i++) {
  const rows = await admin(`/admin/transcripts/${encodeURIComponent(expected)}`).catch(() => []);
  match = rows.find(r =>
    toMs(r.createdAt) >= startedAt - 5000 &&
    (r.turns ?? []).some(t => t.role === 'user' && PATTERN.test(t.content)));
  if (!match) await sleep(5000);
}
if (!match) {
  // Distinguish "answered as the wrong business" from "never heard / never answered".
  await fail(`no ${expected} transcript with a caller turn matching ${PATTERN} after the call - the assistant did not hear the question, or the call was answered as a different business`);
}

const turns = match.turns;
const reply = turns.find((t, i) => t.role === 'assistant' && i > turns.findIndex(x => x.role === 'user' && PATTERN.test(x.content)));
console.log('transcript:', JSON.stringify(turns));
if (!reply || !reply.content.trim()) await fail('caller was heard but the assistant gave no reply');
if (/trouble right now|having trouble/i.test(reply.content)) await fail(`assistant gave the failure fallback: "${reply.content}"`);

console.log(`PASS: "${reply.content}"`);
