/**
 * Simulates a Twilio Media Streams call against a running Worker (local
 * `wrangler dev` or a deployed preview URL), to exercise the
 * CallRelay Durable Object end to end: Twilio protocol → Deepgram STT →
 * runTurn() (Anthropic, now streamed) → Cartesia TTS, without needing a
 * real phone call.
 *
 * Recreated per issue #3 — the original lived at relay/test/simulate-call.js
 * and was removed when the standalone Fly.io relay/ directory was folded
 * into the Cloudflare Worker (see #1/#2). This version points at the
 * Worker's /twilio/stream route instead.
 *
 * Usage:
 *   node scripts/simulate-call.mjs                                  # 2s silence — tests connection + greeting
 *   node scripts/simulate-call.mjs path/to/speech.wav                # real speech — tests full STT→LLM→TTS
 *   RELAY_URL=wss://<preview>.workers.dev/twilio/stream node scripts/simulate-call.mjs speech.wav
 *   BUSINESS_TYPE=kovai_wellness_clinic node scripts/simulate-call.mjs speech.wav
 *   PROVIDER=exotel node scripts/simulate-call.mjs speech.wav       # Exotel Voicebot protocol → /exotel/stream
 *
 * PROVIDER=twilio (default) speaks Twilio Media Streams (µ-law 8 kHz);
 * PROVIDER=exotel speaks Exotel's Voicebot stream (16-bit PCM 8 kHz,
 * snake_case stream_sid/call_sid, caller in the start event) and checks the
 * framing Exotel requires (outbound media a multiple of 320 bytes). Exotel
 * mode connects without a token, so like Twilio mode it only works against
 * a Worker running with NODE_ENV=development; the business comes from
 * EXOTEL_DEFAULT_BUSINESS_TYPE or ?businessType=.
 *
 * The WAV file is auto-converted via ffmpeg. Received TTS audio is saved to
 * scripts/received-<timestamp>.ul (Twilio, µ-law) or .s16 (Exotel, PCM).
 *
 * Timing: watch for "⏱ first-chunk-spoken" in the Worker's console log
 * (wrangler dev / `wrangler tail`) — that's the metric this test exists to
 * validate: time from transcript to the first spoken TTS chunk, which
 * should now be well under the old 3-5s full-turn latency on tool-using
 * turns.
 */

import { WebSocket } from 'ws';
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const BUSINESS_TYPE = process.env.BUSINESS_TYPE ?? 'advanced_vtech';
const PROVIDER = process.env.PROVIDER ?? 'twilio';
if (!['twilio', 'exotel'].includes(PROVIDER)) { console.error('PROVIDER must be twilio or exotel'); process.exit(1); }
const EXOTEL = PROVIDER === 'exotel';
const RELAY_URL = process.env.RELAY_URL
  ?? `ws://localhost:8787/${PROVIDER}/stream?businessType=${encodeURIComponent(BUSINESS_TYPE)}`;
const CALL_SID = 'CA' + 'test'.padEnd(32, '0');
const STREAM_SID = 'MZ' + 'test'.padEnd(32, '0');
const FRAME_MS = 20;           // both carriers send 20 ms frames
// 8000 Hz × 20 ms: 1 byte/sample µ-law (Twilio), 2 bytes/sample PCM (Exotel)
const FRAME_BYTES = EXOTEL ? 320 : 160;

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Prepare audio ────────────────────────────────────────────────────────
function loadAudio(wavPath) {
  if (!wavPath) {
    console.log('[test] no audio file — streaming 2 s of silence');
    return EXOTEL ? Buffer.alloc(32000, 0) : Buffer.alloc(16000, 0xff);
  }

  const format = EXOTEL ? 's16le' : 'mulaw';
  console.log(`[test] converting ${wavPath} → ${format} 8 kHz mono via ffmpeg`);
  const result = spawnSync('ffmpeg', [
    '-y', '-i', wavPath,
    '-ar', '8000', '-ac', '1',
    '-f', format, '-',
  ], { maxBuffer: 10 * 1024 * 1024 });

  if (result.status !== 0) {
    console.error('[test] ffmpeg error:', result.stderr.toString());
    process.exit(1);
  }
  return result.stdout;
}

// ── Run simulation ──────────────────────────────────────────────────────
const audio = loadAudio(process.argv[2]);
const ws = new WebSocket(RELAY_URL);
const rxPath = join(__dir, `received-${Date.now()}.${EXOTEL ? 's16' : 'ul'}`);
let badFrames = 0;
const rxChunks = [];
let firstMediaAt = null;
const startedAt = Date.now();

ws.on('open', () => {
  console.log(`[test] connected to ${RELAY_URL} (${PROVIDER})`);

  if (EXOTEL) {
    ws.send(JSON.stringify({ event: 'connected' }));
    ws.send(JSON.stringify({
      event: 'start', sequence_number: 1, stream_sid: STREAM_SID,
      start: {
        stream_sid: STREAM_SID, call_sid: CALL_SID, account_sid: 'simulated',
        from: process.env.FROM ?? '09876543210', to: process.env.TO ?? '08047123456',
        custom_parameters: { businessType: BUSINESS_TYPE },
        media_format: { encoding: 'raw/slin', sample_rate: '8000', bit_rate: '128kbps' },
      },
    }));
  } else {
    ws.send(JSON.stringify({
      event: 'start',
      start: { callSid: CALL_SID, streamSid: STREAM_SID, customParameters: { businessType: BUSINESS_TYPE } },
    }));
  }

  let offset = 0;
  let seq = 1;
  const interval = setInterval(() => {
    if (offset >= audio.length) {
      clearInterval(interval);
      console.log('[test] audio finished — sending stop');
      ws.send(JSON.stringify(EXOTEL
        ? { event: 'stop', stream_sid: STREAM_SID, stop: { call_sid: CALL_SID, reason: 'callended' } }
        : { event: 'stop' }));
      setTimeout(() => ws.close(), 8000);
      return;
    }
    const frame = audio.slice(offset, offset + FRAME_BYTES);
    ws.send(JSON.stringify(EXOTEL
      ? { event: 'media', sequence_number: ++seq, stream_sid: STREAM_SID, media: { chunk: seq, timestamp: String(offset / 16), payload: frame.toString('base64') } }
      : { event: 'media', media: { payload: frame.toString('base64') } }));
    offset += FRAME_BYTES;
  }, FRAME_MS);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.event === 'media') {
    if (firstMediaAt === null) {
      firstMediaAt = Date.now();
      console.log(`\n[test] first audio byte after ${firstMediaAt - startedAt}ms`);
    }
    process.stdout.write('.');
    const bytes = Buffer.from(msg.media.payload, 'base64');
    if (EXOTEL && (bytes.length % 320 !== 0 || msg.stream_sid !== STREAM_SID)) badFrames++;
    rxChunks.push(bytes);
  } else if (msg.event === 'mark') {
    console.log(`\n[test] mark: ${msg.mark?.name} (t=${Date.now() - startedAt}ms)`);
    // A real carrier echoes the mark once playback reaches it.
    if (EXOTEL) ws.send(JSON.stringify({ event: 'mark', stream_sid: STREAM_SID, mark: { name: msg.mark?.name } }));
    else ws.send(JSON.stringify({ event: 'mark', streamSid: STREAM_SID, mark: { name: msg.mark?.name } }));
  } else if (msg.event === 'clear') {
    console.log('[test] ← clear (barge-in triggered)');
  } else {
    console.log('[test] ←', msg.event ?? JSON.stringify(msg).slice(0, 80));
  }
});

ws.on('close', () => {
  if (rxChunks.length) {
    const buf = Buffer.concat(rxChunks);
    mkdirSync(__dir, { recursive: true });
    writeFileSync(rxPath, buf);
    console.log(`[test] saved ${buf.length} bytes of TTS audio → ${rxPath}`);
    console.log(`       play with: ffplay -f ${EXOTEL ? 's16le' : 'mulaw'} -ar 8000 -ac 1 ${rxPath}`);
    if (EXOTEL) console.log(badFrames ? `[test] ✗ ${badFrames} media frames broke Exotel framing (320-byte multiple / stream_sid)` : '[test] ✓ every media frame is a 320-byte multiple with stream_sid');
  } else {
    console.log('[test] no TTS audio received');
  }
  console.log('[test] done');
});

ws.on('error', (e) => {
  console.error('[test] error:', e.message);
  process.exit(1);
});
