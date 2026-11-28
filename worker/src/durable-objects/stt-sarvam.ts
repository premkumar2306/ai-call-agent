// Sarvam AI streaming STT (Saaras) over a WebSocket, for Hindi and Hinglish
// callers. Same contract as createDeepgramSTT: onTranscript once per caller
// utterance, onSpeechStart as the barge-in signal.
//
// Protocol (Sarvam JS SDK `speechToTextStreaming`, v1.1.x):
//   wss://api.sarvam.ai/speech-to-text/ws?language-code=hi-IN&model=…&mode=…
//     &sample_rate=16000&input_audio_codec=wav&vad_signals=true
//   header  Api-Subscription-Key: <SARVAM_API_KEY>
//   send    {"audio":{"data":"<base64 PCM s16le>","sample_rate":16000,"encoding":"audio/wav"}}
//   receive {"type":"events","data":{"signal_type":"START_SPEECH"|"END_SPEECH",…}}
//           {"type":"data","data":{"transcript":"…","language_code":"hi-IN",…}}
//           {"type":"error","data":{"error":"…","code":"…"}}
//
// Differences from Deepgram that shape this adapter:
//  • Sarvam's own VAD decides end of speech and then sends one final
//    transcript; there are no interim results. So barge-in on recognised
//    words happens when that transcript lands (CallRelay's backstop), or on
//    START_SPEECH if VOICE_BARGE_IN_ON_VAD=1.
//  • Twilio sends 8 kHz µ-law; Sarvam takes 16-bit PCM and prefers 16 kHz
//    ("8kHz is only supported via the connection parameter"). Audio is
//    decoded and upsampled here, and batched into 80 ms messages.
//  • `input_audio_codec=wav` with headerless PCM frames is what Pipecat's
//    Sarvam service sends by default; the SDK types only allow
//    encoding "audio/wav" on audio messages.
//  • No per-transcript confidence, so there is no low-confidence filter.

import type { BargeDecision, EndInfo, OnTranscript, SpeechStartReason, Stt } from './stt-deepgram';
import { bargeInDecision, looksIncomplete } from './stt-deepgram';
import { MulawUpsampler, bytesToBase64, pcm16ToBytes } from './audio';
import type { InterruptionLevel, VoiceLanguage } from '../services/voice-language';

export const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text/ws';
export const DEFAULT_SARVAM_STT_MODEL = 'saaras:v3';
export const SARVAM_STT_SAMPLE_RATE = 16000;
// 80 ms of Twilio audio (4 × 20 ms frames of 8 kHz µ-law) per message.
const CHUNK_MULAW_BYTES = 640;

export interface SarvamSttOptions {
  apiKey: string;
  language: VoiceLanguage;
  /** Saaras model. Default saaras:v3 (SARVAM_STT_MODEL). */
  model?: string;
  isEcho?: (text: string) => boolean;
  onActivity?: () => void;
  /** The socket closed or errored while the call was still using it (not after our own close()). */
  onClose?: () => void;
  bargeInMinWords?: number;
  onBargeDecision?: (d: BargeDecision) => void;
  interimBargeIn?: boolean;
  interruption?: () => InterruptionLevel;
  /** Extra ms a finished utterance waits before it's answered (patient turn-taking); speaking again extends it. Default 0. */
  settleMs?: number;
  /** How long a transcript ending on a dangling word waits for the rest. Default 900; 0 disables. */
  incompleteHoldMs?: number;
  /** Ask Sarvam for its high-sensitivity VAD (quiet callers, noisy lines). */
  highVadSensitivity?: boolean;
  debug?: boolean;
}

/** language-code + mode for a voice language. Hinglish uses `codemix`: English words in Latin, Hindi in Devanagari. */
export function sarvamSttLanguage(lang: VoiceLanguage): { languageCode: string; mode: string } {
  if (lang === 'hi') return { languageCode: 'hi-IN', mode: 'transcribe' };
  if (lang === 'hi-en') return { languageCode: 'hi-IN', mode: 'codemix' };
  if (lang === 'kn' || lang === 'te' || lang === 'ta') return { languageCode: `${lang}-IN`, mode: 'transcribe' };
  return { languageCode: 'en-IN', mode: 'transcribe' };
}

export function sarvamSttUrl(opts: Pick<SarvamSttOptions, 'language' | 'model' | 'highVadSensitivity'>): string {
  const { languageCode, mode } = sarvamSttLanguage(opts.language);
  return `${SARVAM_STT_URL}?` + new URLSearchParams({
    'language-code': languageCode,
    model: opts.model || DEFAULT_SARVAM_STT_MODEL,
    mode,
    sample_rate: String(SARVAM_STT_SAMPLE_RATE),
    input_audio_codec: 'wav',
    vad_signals: 'true',
    ...(opts.highVadSensitivity ? { high_vad_sensitivity: 'true' } : {}),
  });
}

export async function createSarvamSTT(
  opts: SarvamSttOptions,
  onTranscript: OnTranscript,
  onSpeechStart?: (reason: SpeechStartReason) => void,
): Promise<Stt> {
  const { apiKey, language: lang, debug = false, bargeInMinWords = 2, incompleteHoldMs = 900, settleMs = 0, isEcho, onActivity, onClose } = opts;
  if (!apiKey) throw new Error('Missing SARVAM_API_KEY');

  const resp = await fetch(sarvamSttUrl(opts), {
    headers: { Upgrade: 'websocket', 'Api-Subscription-Key': apiKey },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`Sarvam STT did not accept the WebSocket upgrade (${resp.status})`);
  ws.accept();

  let isOpen = true;
  const upsampler = new MulawUpsampler();
  let pending = new Uint8Array(0);
  let utteranceStart = 0;
  let speechEndAt = 0;
  let speechEndPerf = 0;
  let endInfo: EndInfo | undefined;

  // A fragment ending on a dangling word, waiting for the rest of its sentence.
  let held = '';
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseHeld = () => {
    holdTimer = undefined;
    const text = held;
    held = '';
    if (text) {
      console.log(`[sarvam stt] releasing held text: "${text}"`);
      onTranscript(text, endInfo);
    }
  };

  const handleTranscript = (raw: string) => {
    const text = raw.trim();
    const ms = utteranceStart ? Date.now() - utteranceStart : -1;
    const afterEnd = speechEndAt ? Date.now() - speechEndAt : -1;
    const speechMs = utteranceStart && speechEndAt ? speechEndAt - utteranceStart : undefined;
    // Sarvam gives no confidence, so none is passed (LOW's one-word rule stays off).
    endInfo = { signal: speechEndPerf ? 'END_SPEECH' : 'transcript', at: speechEndPerf || performance.now(), ...(speechMs !== undefined ? { speechMs } : {}) };
    utteranceStart = 0;
    speechEndAt = 0;
    speechEndPerf = 0;
    if (!text) return;
    console.log(`[sarvam stt] ⏱ transcript-finalized: ${ms}ms (${afterEnd}ms after END_SPEECH) — "${text}"`);
    onActivity?.();
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = undefined;
    const combined = [held, text].filter(Boolean).join(' ');
    // No interims: this is the first moment there are words to barge in on.
    const verdict = bargeInDecision(text, bargeInMinWords, lang, isEcho, { interim: opts.interimBargeIn, level: opts.interruption?.(), voicedMs: speechMs });   // transcript-time: the final-transcript backstop already interrupts
    opts.onBargeDecision?.(verdict);
    if (verdict.interrupt) onSpeechStart?.('interim');
    const incomplete = incompleteHoldMs > 0 && looksIncomplete(combined, lang);
    if (incomplete || settleMs > 0) {
      held = combined;
      holdTimer = setTimeout(releaseHeld, incomplete ? incompleteHoldMs : settleMs);
      if (debug) console.log(`[sarvam stt] holding incomplete "${combined}"`);
      return;
    }
    held = '';
    onTranscript(combined, endInfo);
  };

  ws.addEventListener('message', (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (debug) console.log(`[sarvam stt] ${JSON.stringify(msg).slice(0, 200)}`);
      if (msg.type === 'events') {
        const signal = msg.data?.signal_type;
        if (signal === 'START_SPEECH') {
          if (!utteranceStart) utteranceStart = Date.now();
          // Speaking again while a fragment is held: give the words time to
          // arrive, but not forever, in case it was only noise.
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = setTimeout(releaseHeld, 1500); }
          onActivity?.();
          onSpeechStart?.('vad');
        } else if (signal === 'END_SPEECH') {
          speechEndAt = Date.now();
          speechEndPerf = performance.now();
        }
        return;
      }
      if (msg.type === 'data') {
        handleTranscript(String(msg.data?.transcript ?? ''));
        return;
      }
      if (msg.type === 'error') {
        console.error(`[sarvam stt] error ${msg.data?.code ?? ''}: ${msg.data?.error ?? JSON.stringify(msg).slice(0, 200)}`);
      }
    } catch (e: any) {
      console.error('[sarvam stt] parse error', e?.message || e);
    }
  });
  ws.addEventListener('close', (e: any) => {
    const was = isOpen;
    if (was) console.warn(`[sarvam stt] socket closed (${e?.code ?? ''} ${e?.reason ?? ''})`);
    isOpen = false;
    if (was) onClose?.();
  });
  ws.addEventListener('error', (e: any) => { const was = isOpen; isOpen = false; console.error('[sarvam stt]', e?.message || e); if (was) onClose?.(); });

  const sendChunk = (mulaw: Uint8Array) => {
    const pcm = pcm16ToBytes(upsampler.push(mulaw));
    ws.send(JSON.stringify({ audio: { data: bytesToBase64(pcm), sample_rate: SARVAM_STT_SAMPLE_RATE, encoding: 'audio/wav' } }));
  };

  return {
    sendAudio: (buf: ArrayBuffer) => {
      if (!isOpen) return;
      const next = new Uint8Array(pending.length + buf.byteLength);
      next.set(pending);
      next.set(new Uint8Array(buf), pending.length);
      if (next.length < CHUNK_MULAW_BYTES) { pending = next; return; }
      pending = new Uint8Array(0);
      try { sendChunk(next); } catch (e: any) { console.error('[sarvam stt] send', e?.message || e); }
    },
    close: () => {
      isOpen = false;
      if (holdTimer) clearTimeout(holdTimer);
      try { ws.close(); } catch {}
    },
  };
}
