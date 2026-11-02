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
 * The caller is Claude playing a randomly picked persona (a goal, a car, a
 * way of talking), so every run is a different, natural conversation: it
 * hears the assistant (its audio transcribed with Deepgram) and decides
 * what to say next, until it hangs up. `--lines` runs a fixed script instead.
 *
 * Usage (from worker/; ANTHROPIC_API_KEY and DEEPGRAM_API_KEY for the caller):
 *   ADMIN_KEY=… node scripts/latency-test.mjs                    # production, random persona
 *   ADMIN_KEY=… node scripts/latency-test.mjs --persona 2        # a specific persona
 *   node scripts/latency-test.mjs --local                        # wrangler dev on :8787
 *   node scripts/latency-test.mjs --lines "Hi, do you fix brakes?" "How much is it?"
 *   BUSINESS_TYPE=dental ADMIN_KEY=… node scripts/latency-test.mjs
 *
 * Production mode gets a stream token from POST /admin/stream-token and reads
 * the server breakdown from /admin/transcripts. Local mode reads it from the
 * local D1 with wrangler. Requires macOS `say` and ffmpeg.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const args = process.argv.slice(2);
const local = args.includes('--local');
const linesIdx = args.indexOf('--lines');
const LINES = linesIdx >= 0 ? args.slice(linesIdx + 1).filter(a => !a.startsWith('--')) : null;
const personaIdx = args.indexOf('--persona');

// Who's calling. Each is a goal plus a way of talking; Claude improvises the rest.
const PERSONAS = [
  'You drive a 2016 Toyota Camry. Your brakes started squealing this week. You want to know if they can look at it and roughly what it costs, then book something Saturday morning if possible. You are friendly but a bit rushed.',
  "You manage 6 delivery vans for a bakery and want to know if they do fleet maintenance and how it works. You ask practical questions, one at a time. You don't book anything today; you want someone to call you back.",
  "Your check engine light came on in your 2012 Honda Accord. You're worried and not very car-savvy. You ask whether it's safe to drive and when they can look at it. You book the earliest time they offer.",
  'You want an oil change for your 2019 Ford F-150. You ask the price, push a little when they don\'t give an exact number, then book Tuesday afternoon. Give your name (Chris Romero) and number (312 555 0187) when asked.',
  'You got a rock chip in your windshield on the highway. You ask if they fix chips or only replace windshields, and how long it takes. You talk in short, casual fragments with some "um"s.',
  "You're an older caller. You start by asking what their hours are on Saturday, then ask if they can do an alignment because the car pulls to the right. You sometimes repeat yourself. You decide to call back later.",
  "You booked something earlier this week but can't remember what time. You want to check your appointment and maybe move it to Friday. If they can't find it, you ask to talk to a person.",
  'You want to convert your work truck to propane and have lots of questions: is it worth it, how long it takes, what it costs. Ask one thing at a time.',
];
const VOICES = ['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Fred', 'Victoria'];
const MAX_TURNS = 10;
const BUSINESS = process.env.BUSINESS_TYPE ?? 'advanced_vtech';
const BASE = local ? `http://localhost:${process.env.PORT ?? 8787}` : (process.env.WORKER_URL ?? 'https://mogi-platform.premkumar-2ba.workers.dev');
const ADMIN_KEY = process.env.ADMIN_KEY;
const VOICE = process.env.SAY_VOICE ?? VOICES[Math.floor(Math.random() * VOICES.length)];
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
let agentAudio = [];         // what the assistant said since the caller last spoke
const pendingMarks = new Set();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const now = Date.now();
  if (m.event === 'media') {
    const bytes = Buffer.from(m.media.payload, 'base64').length;
    playbackEndsAt = Math.max(now, playbackEndsAt) + bytes / 8;
    lastAgentAudioAt = now;
    agentAudio.push(Buffer.from(m.media.payload, 'base64'));
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

// ── The caller ─────────────────────────────────────────────────────────────
// What the assistant said, from its audio, as a caller would hear it.
async function hear(chunks) {
  const audio = Buffer.concat(chunks);
  if (!audio.length || !process.env.DEEPGRAM_API_KEY) return '';
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&encoding=mulaw&sample_rate=8000&smart_format=true', {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/octet-stream' },
    body: audio,
  });
  const j = await r.json().catch(() => null);
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}

const persona = LINES ? null : PERSONAS[personaIdx >= 0 ? Number(args[personaIdx + 1]) % PERSONAS.length : Math.floor(Math.random() * PERSONAS.length)];
const anthropic = LINES ? null : new Anthropic();
const heardSoFar = [];  // [{who: 'shop' | 'you', text}]

// Claude, in character, decides the caller's next line; null = hang up.
async function nextLine() {
  if (LINES) return LINES[heardSoFar.filter(h => h.who === 'you').length] ?? null;
  if (heardSoFar.filter(h => h.who === 'you').length >= MAX_TURNS) return null;
  const transcript = heardSoFar.map(h => `${h.who === 'you' ? 'You' : 'Shop'}: ${h.text}`).join('\n');
  const res = await anthropic.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system: `You are role-playing a real person phoning a car repair shop. The shop's phone is answered by an AI receptionist.

${persona}

Speak the way people really talk on the phone: casual, usually one short sentence, sometimes a fragment, "yeah", "um", or a follow-up that depends on what you just heard. React to what the shop actually said — if it misunderstood you, say so; if it asked you something, answer it. Don't read out a list of questions. Never describe actions or add stage directions.

Reply with only the words you say next. When your goal is done, or the conversation has naturally ended and you've said goodbye, reply with exactly [HANG UP].`,
    messages: [{ role: 'user', content: `The call so far:\n${transcript || '(the shop is picking up)'}\n\nWhat do you say next?` }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim().replace(/^["']|["']$/g, '');
  return !text || /\[HANG UP\]/i.test(text) ? null : text;
}

// ── Conversation ───────────────────────────────────────────────────────────
console.log(`Calling ${BUSINESS} at ${BASE} (${callSid}), caller voice ${VOICE}`);
if (persona) console.log(`Persona: ${persona}\n`);
agentAudio = [];
await waitForReplyDone();                      // greeting
heardSoFar.push({ who: 'shop', text: await hear(agentAudio) });
const results = [];
for (let i = 0; ; i++) {
  const line = await nextLine();
  if (!line) break;
  heardSoFar.push({ who: 'you', text: line });
  firstAudioAfter = { at: null };
  lastAgentAudioAt = 0;
  agentAudio = [];
  const endedAt = await say(speech(line, i));
  const t = Date.now();
  while (!firstAudioAfter.at && Date.now() - t < TURN_TIMEOUT_MS) await sleep(20);
  const e2e = firstAudioAfter.at ? firstAudioAfter.at - endedAt : null;
  results.push({ line, e2e });
  await waitForReplyDone();
  const reply = await hear(agentAudio);
  heardSoFar.push({ who: 'shop', text: reply });
  console.log(`  ${i + 1}. CALLER: ${line}\n     (${e2e == null ? 'no reply' : `${e2e} ms`}) SHOP: ${reply}`);
  await sleep(300);
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
