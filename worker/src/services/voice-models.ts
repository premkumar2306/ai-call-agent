import type { Env } from '../types';
import { DEFAULT_SARVAM_STT_MODEL } from '../durable-objects/stt-sarvam';
import { DEFAULT_SARVAM_TTS_MODEL } from '../durable-objects/tts-sarvam';
import { DEFAULT_CARTESIA_MODEL } from '../durable-objects/tts-cartesia';

// The exact speech model ids a call uses, resolved the same way voice-providers.ts
// builds the STT/TTS clients (env override, else the code default). Recorded on
// the usage record so the cost page shows the real model, not a guess.

export const DEFAULT_DEEPGRAM_MODEL = 'nova-3'; // createDeepgramSTT's default

export function sttModelFor(env: Env, sttProvider: string, language: string): string {
  if (sttProvider === 'sarvam') return env.SARVAM_STT_MODEL || DEFAULT_SARVAM_STT_MODEL;
  const dg = env.DG_MODEL;
  // Flux is English-only: Hindi / Hinglish on Deepgram always use nova-3.
  if (language !== 'en' && /^flux/.test(dg ?? '')) return DEFAULT_DEEPGRAM_MODEL;
  return dg || DEFAULT_DEEPGRAM_MODEL;
}

export function ttsModelFor(env: Env, ttsProvider: string): string {
  return ttsProvider === 'sarvam'
    ? env.SARVAM_TTS_MODEL || DEFAULT_SARVAM_TTS_MODEL
    : env.CARTESIA_MODEL_ID || DEFAULT_CARTESIA_MODEL;
}
