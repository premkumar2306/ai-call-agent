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
 *   node test/simulate-call.js                                  # 2s silence — tests connection + greeting
 *   node test/simulate-call.js path/to/speech.wav                # real speech — tests full STT→LLM→TTS
 *   RELAY_URL=wss://<preview>.workers.dev/twilio/stream node test/simulate-call.js speech.wav
 *   BUSINESS_TYPE=kovai_wellness_clinic node test/simulate-call.js speech.wav
 *
 * The WAV file is auto-converted to µ-law 8 kHz mono via ffmpeg.
 * Received TTS audio is saved to test/received-<timestamp>.ul
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

const BUSINESS_TYPE = process.env.BUSINESS_TYPE ?? 'dental';
const RELAY_URL = process.env.RELAY_URL
  ?? `ws://localhost:8787/twilio/stream?businessType=${encodeURIComponent(BUSINESS_TYPE)}`;
const CALL_SID = 'CA' + 'test'.padEnd(32, '0');
const STREAM_SID = 'MZ' + 'test'.padEnd(32, '0');
const FRAME_MS = 20;           // Twilio sends 20 ms frames
const FRAME_BYTES = 160;       // 8000 Hz × 20 ms × 1 byte/sample (µ-law)

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Prepare audio ────────────────────────────────────────────────────────
function loadMulaw(wavPath) {
  if (!wavPath) {
    console.log('[test] no audio file — streaming 2 s of silence');
    return Buffer.alloc(16000, 0xff);
  }

  console.log(`[test] converting ${wavPath} → µ-law 8 kHz mono via ffmpeg`);
  const result = spawnSync('ffmpeg', [
    '-y', '-i', wavPath,
    '-ar', '8000', '-ac', '1',
    '-f', 'mulaw', '-',
  ], { maxBuffer: 10 * 1024 * 1024 });

  if (result.status !== 0) {
    console.error('[test] ffmpeg error:', result.stderr.toString());
    process.exit(1);
  }
  return result.stdout;
}

// ── Run simulation ──────────────────────────────────────────────────────
const mulaw = loadMulaw(process.argv[2]);
const ws = new WebSocket(RELAY_URL);
const rxPath = join(__dir, `received-${Date.now()}.ul`);
const rxChunks = [];
let firstMediaAt = null;
const startedAt = Date.now();

ws.on('open', () => {
  console.log(`[test] connected to ${RELAY_URL}`);

  ws.send(JSON.stringify({
    event: 'start',
    start: { callSid: CALL_SID, streamSid: STREAM_SID, customParameters: { businessType: BUSINESS_TYPE } },
  }));

  let offset = 0;
  const interval = setInterval(() => {
    if (offset >= mulaw.length) {
      clearInterval(interval);
      console.log('[test] audio finished — sending stop');
      ws.send(JSON.stringify({ event: 'stop' }));
      setTimeout(() => ws.close(), 8000);
      return;
    }
    const frame = mulaw.slice(offset, offset + FRAME_BYTES);
    ws.send(JSON.stringify({
      event: 'media',
      media: { payload: frame.toString('base64') },
    }));
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
    rxChunks.push(Buffer.from(msg.media.payload, 'base64'));
  } else if (msg.event === 'mark') {
    console.log(`\n[test] mark: ${msg.mark?.name} (t=${Date.now() - startedAt}ms)`);
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
    console.log(`       play with: ffplay -f mulaw -ar 8000 -ac 1 ${rxPath}`);
  } else {
    console.log('[test] no TTS audio received');
  }
  console.log('[test] done');
});

ws.on('error', (e) => {
  console.error('[test] error:', e.message);
  process.exit(1);
});
