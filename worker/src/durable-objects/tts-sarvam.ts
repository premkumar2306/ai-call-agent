// Sarvam AI streaming TTS (Bulbul) for Hindi / Hinglish replies.
//
// Uses the HTTP streaming endpoint, which has the same shape as Cartesia's
// /tts/bytes: one POST per chunk of text, audio streamed back in the
// response body. That keeps CallRelay's start/drain pipelining (chunk N+1's
// request overlaps chunk N's playback) unchanged.
//
// Request (Sarvam JS SDK `textToSpeech.convertStream`, v1.1.x):
//   POST https://api.sarvam.ai/text-to-speech/stream
//   header api-subscription-key: <SARVAM_API_KEY>
//   {"text", "language_code": "hi-IN", "model": "bulbul:v3", "speaker"?,
//    "speech_sample_rate": 8000, "output_audio_codec": "mulaw"}
//
// mulaw at 8000 Hz is exactly what Twilio plays. In case the stream arrives
// wrapped in a WAV header or as 16-bit PCM, toMulaw8k() normalises it
// (SARVAM_TTS_CODEC=linear16 asks for PCM explicitly).

import { toMulaw8k, type TtsCodec } from './audio';
import type { VoiceLanguage } from '../services/voice-language';

export const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech/stream';
export const DEFAULT_SARVAM_TTS_MODEL = 'bulbul:v3';

export interface SarvamTtsConfig {
  apiKey: string;
  language: VoiceLanguage;
  /** Bulbul speaker (lowercase, must match the model). Unset = Sarvam's default for the model. */
  speaker?: string;
  model?: string;
  codec?: TtsCodec;
  pace?: number;
}

export function sarvamTtsLanguage(lang: VoiceLanguage): string {
  // Hinglish is code-mixed text in a Hindi voice; Bulbul handles the English words.
  return lang === 'en' ? 'en-IN' : 'hi-IN';
}

export function sarvamTtsBody(cfg: SarvamTtsConfig, text: string): Record<string, unknown> {
  return {
    text,
    language_code: sarvamTtsLanguage(cfg.language),
    model: cfg.model || DEFAULT_SARVAM_TTS_MODEL,
    ...(cfg.speaker ? { speaker: cfg.speaker } : {}),
    ...(cfg.pace ? { pace: cfg.pace } : {}),
    speech_sample_rate: 8000,
    output_audio_codec: cfg.codec ?? 'mulaw',
  };
}

/**
 * Issues the synthesis request; resolves once headers are back. The
 * returned Response's body is raw 8 kHz µ-law, ready for cartesiaDrain().
 */
export async function sarvamTtsStart(cfg: SarvamTtsConfig, text: string, signal?: AbortSignal): Promise<Response | null> {
  if (signal?.aborted) return null;
  if (!cfg.apiKey) throw new Error('Missing SARVAM_API_KEY');
  const res = await fetch(SARVAM_TTS_URL, {
    method: 'POST', signal,
    headers: { 'api-subscription-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(sarvamTtsBody(cfg, text)),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    console.error('[sarvam tts]', res.status, body.slice(0, 500));
    return null;
  }
  return new Response(toMulaw8k(res.body, cfg.codec ?? 'mulaw', 'sarvam tts'), { status: 200 });
}
