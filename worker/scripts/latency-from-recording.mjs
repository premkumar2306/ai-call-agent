#!/usr/bin/env node
// What the caller heard: per-turn latency from a handset-side recording.
//
//   node scripts/latency-from-recording.mjs recording.wav turns.json [--min-gap-ms 300] [--json]
//
// recording.wav : the handset's audio during the call (WAV; MP3/M4A work if ffmpeg is installed).
// turns.json    : GET /admin/calls/<callSid>/turns for that call.
// The first DTMF digit pressed at call start is the sync marker (see docs/latency-handset-test.md).

import { readFileSync } from 'node:fs';
import { findBursts, findDtmf, formatTable, loadAudio, perTurn, turnsOf } from './latency-from-recording-lib.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return undefined; return args.splice(i, 2)[1]; };
const asJson = args.includes('--json') && !!args.splice(args.indexOf('--json'), 1);
const minGapMs = Number(flag('--min-gap-ms') ?? 300);
const [audioPath, turnsPath] = args;
if (!audioPath || !turnsPath) {
  console.error('usage: node scripts/latency-from-recording.mjs <recording.wav> <turns.json> [--min-gap-ms 300] [--json]');
  process.exit(2);
}

try {
  const { sampleRate, samples } = loadAudio(audioPath);
  const { turns, syncDtmfAt, provider } = turnsOf(JSON.parse(readFileSync(turnsPath, 'utf8')));
  if (!syncDtmfAt) throw new Error('the call has no DTMF sync marker: press a digit on the handset right after the call connects');
  const dtmf = findDtmf(samples, sampleRate);
  if (!dtmf) throw new Error('no DTMF tone found in the recording: the recorder must hear the handset\'s keypad tone (use the handset speaker, keypad tones on)');
  const bursts = findBursts(samples, sampleRate, { minGapMs, mask: [[dtmf.start - 0.05, dtmf.end + 0.1]] });
  const rows = perTurn(bursts, turns, { dtmfAt: dtmf.start, syncDtmfAt });
  if (asJson) console.log(JSON.stringify({ provider, dtmf, bursts, rows }, null, 2));
  else {
    console.log(`recording ${(samples.length / sampleRate).toFixed(1)}s @ ${sampleRate} Hz; DTMF "${dtmf.digit}" at ${dtmf.start.toFixed(2)}s; ${bursts.length} sound bursts`);
    console.log(formatTable(rows, provider));
  }
} catch (e) {
  console.error(`latency-from-recording: ${e.message}`);
  process.exit(1);
}
