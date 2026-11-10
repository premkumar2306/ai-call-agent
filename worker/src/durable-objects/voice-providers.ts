// The STT/TTS provider seam for CallRelay. A business's VoiceSettings
// (sectors.voice_*, migration 0012) pick the providers; the defaults
// (English, Deepgram, Cartesia) build exactly the clients CallRelay always
// used, with the same options.
//
//   SttProvider — opened once per call. Feeds 8 kHz µ-law in; calls
//     onTranscript once per caller utterance and onSpeechStart as the
//     barge-in signal. (`Stt` is the handle it returns.)
//   TtsProvider — start(text) issues one synthesis request and resolves when
//     its headers are back; the Response body is raw 8 kHz µ-law, which
//     cartesiaDrain() streams to Twilio. Keeping start and drain apart is
//     what lets CallRelay overlap chunk N+1's TTFB with chunk N's playback.
//
// Adding a provider: write an adapter with that shape, add its name to
// STT_PROVIDERS / TTS_PROVIDERS (services/voice-language.ts) and a case here.

import type { Env } from '../types';
import type { VoiceSettings } from '../services/voice-language';
import { createDeepgramSTT, createDeepgramFluxSTT, type SpeechStartReason, type Stt, type SttOptions } from './stt-deepgram';
import { createSarvamSTT } from './stt-sarvam';
import { cartesiaStart } from './tts-cartesia';
import { sarvamTtsStart } from './tts-sarvam';

export type { Stt, SpeechStartReason };

/** Provider-independent knobs CallRelay passes to every STT (see SttOptions). */
export type SttCommon = Omit<SttOptions, 'apiKey' | 'model' | 'language' | 'voiceLanguage'>;

export interface TtsProvider {
  readonly name: string;
  start(text: string, signal?: AbortSignal): Promise<Response | null>;
}

export class MissingVoiceKeyError extends Error {}

/** The secret a voice config needs that isn't set, if any — Sarvam fails closed. */
export function missingVoiceSecret(env: Env, voice: VoiceSettings): string | null {
  if ((voice.sttProvider === 'sarvam' || voice.ttsProvider === 'sarvam') && !env.SARVAM_API_KEY) return 'SARVAM_API_KEY';
  return null;
}

/**
 * Deepgram's `language` for a voice language. English keeps DG_LANGUAGE
 * (default 'en'); Hindi is nova-3 `hi`; Hinglish is nova-3 `multi`, the
 * code-switching mode that covers Hindi + English.
 */
export function deepgramLanguage(env: Env, voice: VoiceSettings): string | undefined {
  if (voice.language === 'hi') return 'hi';
  if (voice.language === 'hi-en') return 'multi';
  return env.DG_LANGUAGE;
}

export function createStt(
  env: Env,
  voice: VoiceSettings,
  common: SttCommon,
  onTranscript: (text: string) => void,
  onSpeechStart?: (reason: SpeechStartReason) => void,
): Promise<Stt> {
  if (voice.sttProvider === 'sarvam') {
    if (!env.SARVAM_API_KEY) return Promise.reject(new MissingVoiceKeyError('Missing SARVAM_API_KEY'));
    return createSarvamSTT({
      apiKey: env.SARVAM_API_KEY,
      language: voice.language,
      model: env.SARVAM_STT_MODEL,
      isEcho: common.isEcho,
      onActivity: common.onActivity,
      bargeInMinWords: common.bargeInMinWords,
      incompleteHoldMs: common.incompleteHoldMs,
      highVadSensitivity: /^(1|true)$/i.test(env.SARVAM_HIGH_VAD_SENSITIVITY ?? ''),
      debug: common.debug,
    }, onTranscript, onSpeechStart);
  }
  if (voice.language === 'en') {
    // Today's path, untouched: DG_MODEL=flux-* switches to Deepgram's end-of-turn model.
    const create = /^flux/.test(env.DG_MODEL ?? '') ? createDeepgramFluxSTT : createDeepgramSTT;
    return create({ ...common, apiKey: env.DEEPGRAM_API_KEY ?? '', model: env.DG_MODEL, language: env.DG_LANGUAGE }, onTranscript, onSpeechStart);
  }
  // Hindi / Hinglish on Deepgram: Flux is English-only, so always nova-3 (or DG_MODEL if it isn't flux).
  return createDeepgramSTT({
    ...common,
    apiKey: env.DEEPGRAM_API_KEY ?? '',
    model: /^flux/.test(env.DG_MODEL ?? '') ? 'nova-3' : env.DG_MODEL,
    language: deepgramLanguage(env, voice),
    voiceLanguage: voice.language,
  }, onTranscript, onSpeechStart);
}

export function createTts(env: Env, voice: VoiceSettings): TtsProvider {
  if (voice.ttsProvider === 'sarvam') {
    const cfg = {
      apiKey: env.SARVAM_API_KEY ?? '',
      language: voice.language,
      speaker: voice.voiceId ?? env.SARVAM_TTS_SPEAKER,
      model: env.SARVAM_TTS_MODEL,
      codec: env.SARVAM_TTS_CODEC === 'linear16' ? 'linear16' as const : 'mulaw' as const,
    };
    return { name: 'sarvam', start: (text, signal) => sarvamTtsStart(cfg, text, signal) };
  }
  const cfg = {
    apiKey: env.CARTESIA_API_KEY!,
    voiceId: voice.voiceId ?? env.CARTESIA_VOICE_ID,
    modelId: env.CARTESIA_MODEL_ID,
    ...(voice.language !== 'en' ? { language: 'hi' } : {}),
  };
  return { name: 'cartesia', start: (text, signal) => cartesiaStart(cfg, text, signal) };
}
