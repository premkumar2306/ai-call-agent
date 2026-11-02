/**
 * Synthetic phone call for latency testing — no phone needed.
 *
 * Speaks a scripted conversation (macOS `say` voices, converted to the 8 kHz
 * µ-law Twilio uses) into the same Media Streams WebSocket a real call uses,
 * plays the assistant's audio back at real-time speed (acknowledging Twilio
 * playback marks when "played", honouring `clear` on barge-in), and waits
 * for each reply to finish before saying the next line.
 *
 * Measures, per turn:
 *   e2e    — end of the caller's speech → first assistant audio back. What a
 *            caller actually waits; includes end-of-speech detection.
 *   server — the Worker's own breakdown saved with the transcript
 *            (transcripts.metrics): queueing, model first token, tools,
 *            first audio.
 *
 * Usage (from worker/):
 *   ADMIN_KEY=… node scripts/latency-test.mjs                    # production
 *   node scripts/latency-test.mjs --local                        # wrangler dev on :8787
 *   node scripts/latency-test.mjs --lines "Hi, do you fix brakes?" "How much is it?"
 *   BUSINESS_TYPE=dental ADMIN_KEY=… node scripts/latency-test.mjs
 *
 * Production mode gets a stream token from POST /admin/stream-token and reads
 * the server breakdown from /admin/transcripts. Local mode reads it from the
 * local D1 with wrangler. Requires macOS `say` and ffmpeg.
 */

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const local = args.includes('--local');
const linesIdx = args.indexOf('--lines');
const LINES = linesIdx >= 0 ? args.slice(linesIdx + 1).filter(a => !a.startsWith('--')) : [
  'Hi, do you guys fix windshields?',
  'How much is an oil change?',
  'Where are you located?',
  'What times do you have Tuesday morning for an oil change?',
  "Okay, thanks. That's all.",
];
const BUSINESS = process.env.BUSINESS_TYPE ?? 'advanced_vtech';
const BASE = local ? `http://localhost:${process.env.PORT ?? 8787}` : (process.env.WORKER_URL ?? 'https://mogi-platform.premkumar-2ba.workers.dev');
const ADMIN_KEY = process.env.ADMIN_KEY;
const VOICE = process.env.SAY_VOICE ?? 'Samantha';
const REPLY_DONE_MS = 1500;   // assistant audio quiet this long after playback = reply finished
const TURN_TIMEOUT_MS = 20000;
if (!local && !ADMIN_KEY) {
  console.error('ADMIN_KEY is required for production (the admin UI key). Or use --local.');
  process.exit(1);
}

// ── Caller audio ───────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'mogi-latency-'));
function speech(text, i) {
  const aiff = join(tmp, `${i}.aiff`);
  execFileSync('say', ['-v', VOICE, '-o', aiff, text]);
  const out = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', aiff, '-ar', '8000', '-ac', '1', '-f', 'mulaw', '-'], { maxBuffer: 20 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`ffmpeg: ${out.stderr}`);
  return out.stdout;
}
const clips = LINES.map(speech);
const SILENCE = Buffer.alloc(160, 0xff);

// ── Connect ────────────────────────────────────────────────────────────────
const params = { businessType: BUSINESS };
if (!local) {
  const r = await fetch(`${BASE}/admin/stream-token`, {
    method: 'POST', headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessType: BUSINESS }),
  });
  const j = await r.json();
  if (!j.success) { console.error('stream-token:', j.error ?? r.status); process.exit(1); }
  params.streamToken = j.data.token;
}
const callSid = `CAsynth${Date.now()}`;
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/twilio/stream?businessType=${BUSINESS}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket failed')); });
ws.send(JSON.stringify({ event: 'start', start: { callSid, streamSid: 'MZsynth', customParameters: params } }));

// ── Assistant playback model ───────────────────────────────────────────────
// Twilio plays audio in real time and reports each mark when playback reaches
// it; `clear` drops buffered audio and returns pending marks at once.
let playbackEndsAt = 0;
let lastAgentAudioAt = 0;
let firstAudioAfter = null;  // set when waiting for a reply
let closed = false;
const pendingMarks = new Set();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const now = Date.now();
  if (m.event === 'media') {
    const bytes = Buffer.from(m.media.payload, 'base64').length;
    playbackEndsAt = Math.max(now, playbackEndsAt) + bytes / 8;
    lastAgentAudioAt = now;
    if (firstAudioAfter && !firstAudioAfter.at) firstAudioAfter.at = now;
  } else if (m.event === 'mark') {
    const name = m.mark.name;
    pendingMarks.add(name);
    setTimeout(() => {
      if (!pendingMarks.delete(name) || closed) return;
      ws.send(JSON.stringify({ event: 'mark', streamSid: 'MZsynth', mark: { name } }));
    }, Math.max(0, playbackEndsAt - now));
  } else if (m.event === 'clear') {
    playbackEndsAt = now;
    for (const name of pendingMarks) ws.send(JSON.stringify({ event: 'mark', streamSid: 'MZsynth', mark: { name } }));
    pendingMarks.clear();
  }
};
ws.onclose = () => { closed = true; };

// Twilio streams continuously; between lines we send silence.
let speaking = null;
const ticker = setInterval(() => {
  if (closed) return;
  let frame = SILENCE;
  if (speaking) {
    frame = speaking.buf.subarray(speaking.off, speaking.off + 160);
    speaking.off += 160;
    if (speaking.off >= speaking.buf.length) { speaking.done(Date.now()); speaking = null; }
    if (frame.length < 160) frame = Buffer.concat([frame, SILENCE]).subarray(0, 160);
  }
  ws.send(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } }));
}, 20);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (buf) => new Promise(done => { speaking = { buf, off: 0, done }; });
async function waitForReplyDone() {
  const start = Date.now();
  while (Date.now() - start < TURN_TIMEOUT_MS) {
    const now = Date.now();
    if (lastAgentAudioAt && now > playbackEndsAt && now - Math.max(lastAgentAudioAt, playbackEndsAt) > REPLY_DONE_MS && pendingMarks.size === 0) return;
    await sleep(100);
  }
}

// ── Conversation ───────────────────────────────────────────────────────────
console.log(`Calling ${BUSINESS} at ${BASE} (${callSid})…`);
await waitForReplyDone();                      // greeting
const results = [];
for (let i = 0; i < LINES.length; i++) {
  firstAudioAfter = { at: null };
  lastAgentAudioAt = 0;
  const endedAt = await say(clips[i]);
  const t = Date.now();
  while (!firstAudioAfter.at && Date.now() - t < TURN_TIMEOUT_MS) await sleep(20);
  const e2e = firstAudioAfter.at ? firstAudioAfter.at - endedAt : null;
  results.push({ line: LINES[i], e2e });
  console.log(`  ${i + 1}. "${LINES[i]}" → ${e2e == null ? 'no reply' : `${e2e} ms`}`);
  await waitForReplyDone();
  await sleep(400);
}
ws.send(JSON.stringify({ event: 'stop' }));
await sleep(500);
clearInterval(ticker);
ws.close();

// ── Server breakdown ───────────────────────────────────────────────────────
await sleep(2500);  // transcript is written on hang-up
let row = null;
if (local) {
  const out = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command',
    `SELECT turns, metrics FROM transcripts WHERE call_sid = '${callSid}'`], { encoding: 'utf8' });
  try { row = JSON.parse(out.stdout)[0].results[0]; } catch { /* not written */ }
  if (row) row = { turns: JSON.parse(row.turns), metrics: JSON.parse(row.metrics ?? 'null') };
} else {
  const r = await fetch(`${BASE}/admin/transcripts/${BUSINESS}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  const j = await r.json();
  row = (j.data ?? []).find(t => t.callSid === callSid) ?? null;
}

const lapAt = (m, pre) => m.laps.find(l => l[0].startsWith(pre))?.[1];
const metrics = row?.metrics ?? [];
const col = (v, w) => String(v ?? '—').padStart(w);
// caller wait = end-of-speech detection + queue + reply text + voice.
console.log('\nAll ms.  wait = what the caller waits (end of their speech → first audio back)');
console.log('turn   wait  end-of-speech  1st-sentence  (tools)  voice   heard as');
results.forEach((r, i) => {
  const m = metrics[i];
  const sentence = m ? lapAt(m, 'first-chunk-emitted') : undefined;
  const toolEnd = m ? lapAt(m, 'tools#') : undefined;
  const tools = toolEnd != null ? toolEnd - (lapAt(m, 'anthropic#0 (') ?? 0) : undefined;
  const eos = r.e2e != null && m?.firstAudio != null ? r.e2e - m.firstAudio - (m.queued ?? 0) : undefined;
  console.log(`${col(i + 1, 4)}  ${col(r.e2e, 5)}  ${col(eos, 13)}  ${col(sentence, 12)}  ${col(tools, 7)}  ${col(m?.tts, 5)}   "${m?.text ?? '?'}"`);
});
console.log('\nend-of-speech: Deepgram deciding you stopped talking (+ network). 1st-sentence: model writing the first');
console.log('speakable sentence (incl. any tool call). voice: Cartesia time to first audio for it.');
const e2es = results.map(r => r.e2e).filter(x => x != null).sort((a, b) => a - b);
if (e2es.length) console.log(`\nmedian e2e ${e2es[Math.floor(e2es.length / 2)]} ms, worst ${e2es[e2es.length - 1]} ms`);
if (!row) console.log('\n(server breakdown not found — transcript not written yet?)');
else {
  console.log('\nTranscript:');
  for (const t of row.turns) console.log(`  ${t.role === 'user' ? 'CALLER' : 'AGENT '}: ${t.content}`);
}
process.exit(0);
