// Caller-line energy, from the μ-law audio the carrier sends. Measures only; it decides nothing.
//
// Two numbers, both for the barge-in diagnostics (and, later, its decision):
//   noiseFloorDb  the quietest the line has been lately (dBFS). Drops fast, rises ~1 dB/s, so a
//                 line that gets noisier is followed but speech does not become "the floor".
//   voicedMs      how long the caller has been talking without a pause longer than 600 ms.
// A frame is voiced when it is VOICED_MARGIN_DB above the floor and above an absolute minimum.

import { mulawToLinear } from '../durable-objects/audio';

const VOICED_MARGIN_DB = 9;
const MIN_VOICED_DB = -50;
const FLOOR_RISE_DB_PER_S = 1;
const HANGOVER_MS = 600;

export class LineLevel {
  private floor = Number.NaN;
  private run = 0;
  private quiet = 0;

  /** One chunk of 8 kHz μ-law audio from the caller. */
  push(mulaw: Uint8Array): void {
    if (!mulaw.length) return;
    const ms = mulaw.length / 8;
    let sum = 0;
    for (let i = 0; i < mulaw.length; i++) { const s = mulawToLinear(mulaw[i]); sum += s * s; }
    const db = 20 * Math.log10(Math.max(Math.sqrt(sum / mulaw.length), 1) / 32768);
    this.floor = Number.isNaN(this.floor) ? db : db < this.floor ? db : this.floor + FLOOR_RISE_DB_PER_S * ms / 1000;
    if (db > this.floor + VOICED_MARGIN_DB && db > MIN_VOICED_DB) {
      this.run += ms + this.quiet;
      this.quiet = 0;
    } else if (this.run) {
      this.quiet += ms;
      if (this.quiet > HANGOVER_MS) { this.run = 0; this.quiet = 0; }
    }
  }

  snapshot(): { noiseFloorDb: number; voicedMs: number } {
    return { noiseFloorDb: Number.isNaN(this.floor) ? -96 : Math.round(this.floor), voicedMs: Math.round(this.run) };
  }
}
