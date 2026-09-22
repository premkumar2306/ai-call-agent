/**
 * Simulates a Twilio Media Streams call against the local relay.
 *
 * Usage:
 *   node test/simulate-call.js                      # streams silence (tests connection + greeting)
 *   node test/simulate-call.js path/to/speech.wav   # streams real speech (tests full STT→LLM→TTS)
 *
 * The WAV file is auto-converted to µ-law 8 kHz mono via ffmpeg.
 * Received TTS audio is saved to test/received-<timestamp>.ul
 */

import { WebSocket } from 'ws';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const RELAY_URL  = process.env.RELAY_URL ?? 'ws://localhost:8080/stream';
const CALL_SID   = 'CA' + 'test'.padEnd(32, '0');
const STREAM_SID = 'MZ' + 'test'.padEnd(32, '0');
const FRAME_MS   = 20;           // Twilio sends 20 ms frames
const FRAME_BYTES = 160;         // 8000 Hz × 20 ms × 1 byte/sample (µ-law)

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Prepare audio ─────────────────────────────────────────────────────────────
function loadMulaw(wavPath) {
  if (!wavPath) {
    // 2 seconds of µ-law silence (0xFF = silence in G.711)
    console.log('[test] no audio file — streaming 2 s of silence');
    return Buffer.alloc(16000, 0xFF);
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

// ── Run simulation ────────────────────────────────────────────────────────────
const mulaw  = loadMulaw(process.argv[2]);
const ws     = new WebSocket(RELAY_URL);
const rxPath = join(__dir, `received-${Date.now()}.ul`);
const rxChunks = [];

ws.on('open', () => {
  console.log(`[test] connected to ${RELAY_URL}`);

  // 1. Send Twilio 'start' event
  ws.send(JSON.stringify({
    event: 'start',
    start: { callSid: CALL_SID, streamSid: STREAM_SID },
  }));

  // 2. Stream audio as 20 ms 'media' frames
  let offset = 0;
  const interval = setInterval(() => {
    if (offset >= mulaw.length) {
      clearInterval(interval);
      console.log('[test] audio finished — sending stop');
      ws.send(JSON.stringify({ event: 'stop' }));
      // Give relay 5 s to finish responding then close
      setTimeout(() => ws.close(), 5000);
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
    process.stdout.write('.');   // one dot per audio chunk received
    rxChunks.push(Buffer.from(msg.media.payload, 'base64'));
  } else if (msg.event === 'mark') {
    console.log(`\n[test] mark: ${msg.mark?.name}`);
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
