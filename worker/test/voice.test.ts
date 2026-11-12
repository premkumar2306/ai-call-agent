import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantNameOf } from '../src/services/verticals';
import {
  DEFAULT_VOICE, endsSentence, isDefaultVoice, languageRules, parseVoiceInput, resolveVoiceSettings,
  sttDiffers, voiceLines, wordsOf, type VoiceSettings,
} from '../src/services/voice-language';
import { isBackchannel, isDiscourseOnly, isEchoOf, looksIncomplete, createDeepgramSTT } from '../src/durable-objects/stt-deepgram';
import {
  MulawUpsampler, decodeMulaw, encodeMulaw, linearToMulaw, mulawToLinear, parseWavHeader, toMulaw8k,
} from '../src/durable-objects/audio';
import { createSarvamSTT, sarvamSttUrl } from '../src/durable-objects/stt-sarvam';
import { sarvamTtsStart } from '../src/durable-objects/tts-sarvam';
import { createStt, createTts, deepgramLanguage, missingVoiceSecret, MissingVoiceKeyError } from '../src/durable-objects/voice-providers';
import { buildAgentRules, buildSystemPrompt, extractCompleteSentences, popFirstChunk, popSentence } from '../src/services/turn.service';
import type { Env } from '../src/types';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Stands in for the WebSocket a Workers fetch() upgrade returns. */
class FakeSocket {
  sent: any[] = [];
  closed = false;
  accepted = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  accept() { this.accepted = true; }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  send(data: any) { this.sent.push(data); }
  close() { this.closed = true; }
  /** Deliver a server message. */
  emit(msg: unknown) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(msg) }); }
}

function mockUpgrade() {
  const socket = new FakeSocket();
  const calls: { url: string; init: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { status: 101, webSocket: socket } as any;
  }));
  return { socket, calls };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

const env = (extra: Partial<Env> = {}): Env => ({
  DEEPGRAM_API_KEY: 'dg', CARTESIA_API_KEY: 'ca', ...extra,
} as unknown as Env);

const HI: VoiceSettings = { language: 'hi', sttProvider: 'sarvam', ttsProvider: 'sarvam' };
const HINGLISH_DG: VoiceSettings = { language: 'hi-en', sttProvider: 'deepgram', ttsProvider: 'cartesia', voiceId: 'hindi-voice-1' };

// ── Settings ────────────────────────────────────────────────────────────────

describe('voice settings', () => {
  it('defaults to English / Deepgram / Cartesia for missing or unknown values', () => {
    expect(resolveVoiceSettings(null)).toEqual(DEFAULT_VOICE);
    expect(resolveVoiceSettings({})).toEqual(DEFAULT_VOICE);
    expect(resolveVoiceSettings({ voice: { language: 'fr' as any, sttProvider: 'x' as any } })).toEqual(DEFAULT_VOICE);
    expect(isDefaultVoice(resolveVoiceSettings(null))).toBe(true);
    expect(isDefaultVoice({ ...DEFAULT_VOICE, voiceId: 'v' })).toBe(false);
    expect(sttDiffers({ ...DEFAULT_VOICE, voiceId: 'v' })).toBe(false);   // TTS-only change keeps the STT socket
    expect(sttDiffers(HINGLISH_DG)).toBe(true);
  });

  it('validates admin input and fails closed on Sarvam without a key', () => {
    expect(parseVoiceInput({ voice_language: 'hi', stt_provider: 'sarvam', tts_provider: 'sarvam' }, DEFAULT_VOICE, true))
      .toEqual({ ok: true, value: { language: 'hi', sttProvider: 'sarvam', ttsProvider: 'sarvam' } });
    const noKey = parseVoiceInput({ stt_provider: 'sarvam' }, DEFAULT_VOICE, false);
    expect(noKey.ok).toBe(false);
    expect(!noKey.ok && noKey.error).toMatch(/SARVAM_API_KEY/);
    expect(parseVoiceInput({ voice_language: 'ta' }, DEFAULT_VOICE, true).ok).toBe(false);
    expect(parseVoiceInput({ voice_id: 'bad id!' }, DEFAULT_VOICE, true).ok).toBe(false);
    // Hindi on Cartesia needs a Hindi-native voice.
    expect(parseVoiceInput({ voice_language: 'hi' }, DEFAULT_VOICE, false).ok).toBe(false);
    expect(parseVoiceInput({ voice_language: 'hi', voice_id: 'abc-123' }, DEFAULT_VOICE, false).ok).toBe(true);
    // Nothing given: nothing changes, and an English business needs no Sarvam key.
    expect(parseVoiceInput({}, DEFAULT_VOICE, false)).toEqual({ ok: true, value: {} });
    // Clearing the voice id.
    expect(parseVoiceInput({ voice_id: null }, { ...HI, voiceId: 'ritu' }, true)).toEqual({ ok: true, value: { voiceId: undefined } });
  });

  it('names the missing secret only for Sarvam businesses', () => {
    expect(missingVoiceSecret(env(), DEFAULT_VOICE)).toBeNull();
    expect(missingVoiceSecret(env(), HINGLISH_DG)).toBeNull();
    expect(missingVoiceSecret(env(), HI)).toBe('SARVAM_API_KEY');
    expect(missingVoiceSecret(env({ SARVAM_API_KEY: 'k' }), HI)).toBeNull();
  });
});

// ── Text rules ──────────────────────────────────────────────────────────────

describe('Hindi text rules', () => {
  it('keeps Devanagari when splitting words', () => {
    expect(wordsOf('हाँ जी, ठीक है।', 'hi')).toEqual(['हाँ', 'जी', 'ठीक', 'है']);
    // The English normaliser drops it — which is why the language matters.
    expect(wordsOf('हाँ जी', 'en')).toEqual([]);
  });

  it('treats the danda as a sentence end for Hindi only', () => {
    expect(endsSentence('मुझे appointment चाहिए।', 'hi')).toBe(true);
    expect(endsSentence('क्या आप खुले हैं?', 'hi-en')).toBe(true);
    expect(endsSentence('मुझे appointment चाहिए।', 'en')).toBe(false);
    expect(endsSentence('Sure.', 'en')).toBe(true);
  });

  it('recognises Hindi and Hinglish backchannels', () => {
    for (const t of ['हाँ', 'हाँ जी', 'अच्छा', 'जी', 'ठीक है', 'haan ji', 'achha', 'Hmm.', 'ok ji', 'theek hai']) {
      expect(isBackchannel(t, 'hi-en'), t).toBe(true);
    }
    for (const t of ['नहीं', 'haan book kar do', 'मुझे कल आना है', 'nahi', '']) {
      expect(isBackchannel(t, 'hi-en'), t).toBe(false);
    }
    // English rules are untouched: Hindi words aren't backchannels on an English line.
    expect(isBackchannel('haan ji')).toBe(false);
    expect(isBackchannel('uh huh')).toBe(true);
  });

  it('holds Hindi floor-holders and dangling words, not unpunctuated sentences', () => {
    expect(isDiscourseOnly('तो', 'hi')).toBe(true);
    expect(isDiscourseOnly('matlab', 'hi-en')).toBe(true);
    expect(isDiscourseOnly('तो कल आ जाऊँ?', 'hi')).toBe(false);
    expect(looksIncomplete('मुझे oil change और', 'hi-en')).toBe(true);
    expect(looksIncomplete('mera naam Ravi hai aur', 'hi-en')).toBe(true);
    expect(looksIncomplete('मेरी गाड़ी का', 'hi')).toBe(true);
    // Hindi STT often has no punctuation: that alone mustn't add a hold.
    expect(looksIncomplete('मुझे कल सुबह appointment चाहिए', 'hi')).toBe(false);
    expect(looksIncomplete('mera number 98450 12345 hai', 'hi-en')).toBe(false);
    // English behaviour unchanged.
    expect(looksIncomplete('I need an oil change')).toBe(true);
  });

  it('detects a Hindi echo of what the assistant said', () => {
    const said = 'जी, सोमवार सुबह 10 बजे का slot खाली है। बुक कर दें?';
    expect(isEchoOf('सोमवार सुबह 10 बजे का slot खाली है', said, 'hi')).toBe(true);
    expect(isEchoOf('हाँ सोमवार ठीक है', said, 'hi')).toBe(false);
    // A caller's own Hindi question shares the common words with what was just
    // said (found by the e2e simulator), but not the word order: not an echo.
    const notice = 'आपकी जानकारी के लिए, आप एक AI सहायक से बात कर रहे हैं। मैं Mogi हूँ, हम आपकी बुकिंग कर सकते हैं। क्या मदद करें?';
    expect(isEchoOf('क्या मैं किसी से बात कर सकता हूँ?', notice, 'hi')).toBe(false);
    expect(isEchoOf('आप एक AI सहायक से बात कर रहे हैं', notice, 'hi')).toBe(true);
    // The English normaliser can't see Devanagari at all.
    expect(isEchoOf('सोमवार सुबह 10 बजे का slot खाली है', said)).toBe(false);
  });
});

describe('canned lines and prompt rules', () => {
  it('keeps the original English lines', () => {
    const en = voiceLines('en');
    expect(en.opener).toBe('Thanks for calling!');
    expect(en.fillers).toEqual(['One moment.', 'Let me check.', 'Just a second.']);
    // advanced_vtech's assistant name is configured as Mogi (migration 0018).
    expect(en.greeting('Advanced Vtech', en.capabilityHint('advanced_vtech'), assistantNameOf({ assistantName: 'Mogi' })))
      .toBe("You've reached Advanced Vtech. I'm Mogi, the virtual assistant. I can answer questions about our services and prices, or book you in — what can I do for you?");
    expect(en.greeting('Sharma Clinic', '', assistantNameOf(null))).toContain("I'm Avery, the virtual assistant.");
    expect(en.goodbye('Shop')).toBe("I haven't heard anything, so I'll hang up now. Thanks for calling Shop. Goodbye!");
  });

  it('speaks Hindi lines in Devanagari, chunkable on the danda', () => {
    const hi = voiceLines('hi');
    expect(hi.opener).toMatch(/[ऀ-ॿ]/);
    expect(extractCompleteSentences(hi.greeting('शर्मा क्लिनिक', hi.capabilityHint('clinic'), 'Avery') + ' ').chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('adds language rules only for Hindi / Hinglish voice lines', () => {
    expect(languageRules('en')).toBe('');
    expect(buildAgentRules('auto', 'Biz', 'voice')).not.toMatch(/LANGUAGE/);
    const hi = buildAgentRules('auto', 'Biz', 'voice', undefined, 'hi-en');
    expect(hi).toMatch(/LANGUAGE/);
    expect(hi).toMatch(/Devanagari/);
    expect(hi).toMatch(/₹1,500/);
    expect(hi).not.toMatch(/Plain spoken English/);
    expect(buildAgentRules('auto', 'Biz', 'chat', undefined, 'hi')).not.toMatch(/LANGUAGE/);
    const meta: any = { name: 'Biz', model: 'service', categories: [], hours: {}, timezone: 'Asia/Kolkata', currency: 'INR', voice: { language: 'hi' } };
    const session: any = { sub: 'x', businessType: 'auto', iat: 0, exp: 0, account: { tier: 'BASIC', store_credit_cents: 0 } };
    expect(buildSystemPrompt({ businessType: 'auto', sectorMeta: meta, products: [], session, orders: [] })[0].text).toMatch(/Reply in Hindi/);
  });
});

describe('Devanagari sentence chunking', () => {
  it('pops a sentence ending in a danda or question mark', () => {
    expect(popSentence('जी हाँ। हम सोमवार को खुले हैं')).toEqual({ chunk: 'जी हाँ।', rest: 'हम सोमवार को खुले हैं' });
    expect(popSentence('क्या आप कल आ सकते हैं? बताइए')?.chunk).toBe('क्या आप कल आ सकते हैं?');
    expect(popSentence('अभी पूरा नहीं हुआ')).toBeNull();
  });

  it('first chunk prefers the danda sentence', () => {
    expect(popFirstChunk('जी, बिल्कुल। Oil change ₹1,500 का है।')?.chunk).toBe('जी, बिल्कुल।');
  });

  it('does not split prices, times or mixed text', () => {
    const { chunks, rest } = extractCompleteSentences('Oil change ₹1,500 का है। सोमवार 4:30 बजे खाली है? ');
    expect(chunks).toEqual(['Oil change ₹1,500 का है।', 'सोमवार 4:30 बजे खाली है?']);
    expect(rest).toBe('');
  });
});

// ── Audio ───────────────────────────────────────────────────────────────────

describe('µ-law codec', () => {
  it('matches G.711 reference points', () => {
    expect(mulawToLinear(0xff)).toBe(0);
    expect(mulawToLinear(0x7f)).toBe(0);
    expect(mulawToLinear(0x00)).toBe(-32124);
    expect(mulawToLinear(0x80)).toBe(32124);
    expect(linearToMulaw(0)).toBe(0xff);
    expect(linearToMulaw(32767)).toBe(0x80);
    expect(linearToMulaw(-32768)).toBe(0x00);
  });

  it('round-trips every µ-law byte', () => {
    for (let b = 0; b < 256; b++) {
      if (b === 0x7f) continue; // -0 and +0 both decode to 0, which encodes as 0xff
      expect(linearToMulaw(mulawToLinear(b))).toBe(b);
    }
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i).filter(b => b !== 0x7f);
    expect(Array.from(encodeMulaw(decodeMulaw(bytes)))).toEqual(Array.from(bytes));
  });

  it('upsamples 8 kHz to 16 kHz continuously across frames', () => {
    const up = new MulawUpsampler();
    const hi = linearToMulaw(1000);
    const a = up.push(Uint8Array.of(hi, hi));
    expect(a.length).toBe(4);
    const v = mulawToLinear(hi);
    expect(Array.from(a)).toEqual([v >> 1, v, v, v]);
    // The next frame interpolates from the last sample of the previous one.
    const b = up.push(Uint8Array.of(0xff));
    expect(Array.from(b)).toEqual([v >> 1, 0]);
  });
});

function wav(format: number, bits: number, rate: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  out.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
  dv.setUint32(4, 36 + data.length, true);
  out.set([...'WAVEfmt '].map(c => c.charCodeAt(0)), 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * bits / 8, true);
  dv.setUint16(32, bits / 8, true);
  dv.setUint16(34, bits, true);
  out.set([...'data'].map(c => c.charCodeAt(0)), 36);
  dv.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(...value); }
  return out;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
}

describe('TTS stream normalisation', () => {
  it('passes headerless µ-law straight through', async () => {
    expect(await collect(toMulaw8k(streamOf(Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)), 'mulaw'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('strips a WAV header split across chunks (µ-law)', async () => {
    const file = wav(7, 8, 8000, Uint8Array.of(10, 20, 30, 40));
    expect(await collect(toMulaw8k(streamOf(file.slice(0, 3), file.slice(3, 30), file.slice(30)), 'mulaw'))).toEqual([10, 20, 30, 40]);
    expect(parseWavHeader(file)).toEqual({ dataOffset: 44, format: 'mulaw', sampleRate: 8000 });
  });

  it('encodes 16-bit PCM (from the WAV header, or as asked) to µ-law, across odd chunk splits', async () => {
    const samples = Int16Array.of(0, 1000, -1000, 32000);
    const pcm = new Uint8Array(samples.buffer.slice(0));
    const expected = Array.from(encodeMulaw(samples));
    const file = wav(1, 16, 8000, pcm);
    expect(await collect(toMulaw8k(streamOf(file.slice(0, 45), file.slice(45, 48), file.slice(48)), 'mulaw'))).toEqual(expected);
    expect(await collect(toMulaw8k(streamOf(pcm.slice(0, 3), pcm.slice(3)), 'linear16'))).toEqual(expected);
  });
});

// ── Sarvam STT (mocked socket) ──────────────────────────────────────────────

describe('Sarvam streaming STT', () => {
  it('connects with the language, model, VAD signals and auth header', async () => {
    const { calls, socket } = mockUpgrade();
    await createSarvamSTT({ apiKey: 'sk', language: 'hi-en' }, () => {});
    expect(socket.accepted).toBe(true);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.sarvam.ai/speech-to-text/ws');
    expect(url.searchParams.get('language-code')).toBe('hi-IN');
    expect(url.searchParams.get('mode')).toBe('codemix');
    expect(url.searchParams.get('model')).toBe('saaras:v3');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('vad_signals')).toBe('true');
    expect(calls[0].init.headers).toEqual({ Upgrade: 'websocket', 'Api-Subscription-Key': 'sk' });
    expect(new URL(sarvamSttUrl({ language: 'hi' })).searchParams.get('mode')).toBe('transcribe');
    expect(new URL(sarvamSttUrl({ language: 'en', model: 'saaras:v4' })).searchParams.get('language-code')).toBe('en-IN');
  });

  it('refuses to start without a key', async () => {
    await expect(createSarvamSTT({ apiKey: '', language: 'hi' }, () => {})).rejects.toThrow(/SARVAM_API_KEY/);
  });

  it('sends 80 ms batches of 16 kHz PCM, base64 in JSON', async () => {
    const { socket } = mockUpgrade();
    const stt = await createSarvamSTT({ apiKey: 'sk', language: 'hi' }, () => {});
    const frame = new Uint8Array(160).fill(linearToMulaw(2000));   // one 20 ms Twilio frame
    for (let i = 0; i < 3; i++) stt.sendAudio(frame.buffer.slice(0));
    expect(socket.sent).toHaveLength(0);
    stt.sendAudio(frame.buffer.slice(0));
    expect(socket.sent).toHaveLength(1);
    const msg = JSON.parse(socket.sent[0]);
    expect(msg.audio.sample_rate).toBe(16000);
    expect(msg.audio.encoding).toBe('audio/wav');
    const pcm = Uint8Array.from(atob(msg.audio.data), c => c.charCodeAt(0));
    expect(pcm.length).toBe(640 * 2 * 2);   // 640 µ-law samples → 1280 PCM samples → 2560 bytes
    expect(new DataView(pcm.buffer).getInt16(pcm.length - 2, true)).toBe(mulawToLinear(linearToMulaw(2000)));
    stt.close();
    stt.sendAudio(new Uint8Array(640).buffer);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });

  it('turns VAD events and final transcripts into barge-in and turns', async () => {
    const { socket } = mockUpgrade();
    const transcripts: string[] = [];
    const starts: string[] = [];
    let activity = 0;
    await createSarvamSTT(
      { apiKey: 'sk', language: 'hi-en', onActivity: () => activity++ },
      t => transcripts.push(t), r => starts.push(r),
    );
    socket.emit({ type: 'events', data: { signal_type: 'START_SPEECH' } });
    expect(starts).toEqual(['vad']);
    socket.emit({ type: 'events', data: { signal_type: 'END_SPEECH' } });
    socket.emit({ type: 'data', data: { transcript: 'मुझे कल oil change करवाना है', language_code: 'hi-IN' } });
    expect(starts).toEqual(['vad', 'interim']);
    expect(transcripts).toEqual(['मुझे कल oil change करवाना है']);
    // A backchannel is a turn (CallRelay decides) but never a barge-in signal.
    socket.emit({ type: 'data', data: { transcript: 'हाँ जी' } });
    expect(starts).toEqual(['vad', 'interim']);
    expect(transcripts).toHaveLength(2);
    // Empty transcripts and errors don't produce turns.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    socket.emit({ type: 'data', data: { transcript: '  ' } });
    socket.emit({ type: 'error', data: { error: 'bad audio', code: '400' } });
    expect(transcripts).toHaveLength(2);
    expect(activity).toBeGreaterThan(0);
  });

  it('suppresses barge-in on echo', async () => {
    const { socket } = mockUpgrade();
    const starts: string[] = [];
    await createSarvamSTT({ apiKey: 'sk', language: 'hi', isEcho: () => true }, () => {}, r => starts.push(r));
    socket.emit({ type: 'data', data: { transcript: 'सोमवार सुबह 10 बजे खाली है' } });
    expect(starts).toEqual([]);
  });

  it('holds a fragment that ends on a dangling word and joins the rest', async () => {
    vi.useFakeTimers();
    const { socket } = mockUpgrade();
    const transcripts: string[] = [];
    await createSarvamSTT({ apiKey: 'sk', language: 'hi' }, t => transcripts.push(t));
    socket.emit({ type: 'data', data: { transcript: 'मेरी गाड़ी का' } });
    expect(transcripts).toEqual([]);
    socket.emit({ type: 'events', data: { signal_type: 'START_SPEECH' } });
    socket.emit({ type: 'data', data: { transcript: 'brake खराब है' } });
    expect(transcripts).toEqual(['मेरी गाड़ी का brake खराब है']);
    // On its own, a held fragment is released after the hold.
    socket.emit({ type: 'data', data: { transcript: 'और' } });
    vi.advanceTimersByTime(950);
    expect(transcripts).toEqual(['मेरी गाड़ी का brake खराब है', 'और']);
  });
});

// ── Sarvam TTS (mocked fetch) ───────────────────────────────────────────────

describe('Sarvam streaming TTS', () => {
  it('asks for 8 kHz µ-law in Hindi and streams the body back', async () => {
    let req: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      req = { url, init, body: JSON.parse(init.body) };
      return new Response(streamOf(Uint8Array.of(1, 2, 3)), { status: 200 });
    }));
    const res = await sarvamTtsStart({ apiKey: 'sk', language: 'hi-en', speaker: 'ritu' }, 'जी, बिल्कुल।');
    expect(req.url).toBe('https://api.sarvam.ai/text-to-speech/stream');
    expect(req.init.method).toBe('POST');
    expect(req.init.headers['api-subscription-key']).toBe('sk');
    expect(req.body).toEqual({
      text: 'जी, बिल्कुल।', language_code: 'hi-IN', model: 'bulbul:v3', speaker: 'ritu',
      speech_sample_rate: 8000, output_audio_codec: 'mulaw',
    });
    expect(await collect(res!.body!)).toEqual([1, 2, 3]);
  });

  it('returns null on an API error and on an aborted request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad speaker"}', { status: 400 })));
    expect(await sarvamTtsStart({ apiKey: 'sk', language: 'hi' }, 'नमस्ते')).toBeNull();
    const ac = new AbortController(); ac.abort();
    expect(await sarvamTtsStart({ apiKey: 'sk', language: 'hi' }, 'नमस्ते', ac.signal)).toBeNull();
  });
});

// ── Provider selection ──────────────────────────────────────────────────────

describe('provider factories', () => {
  it('builds the unchanged Deepgram socket for the default voice', async () => {
    const { calls } = mockUpgrade();
    await createStt(env(), DEFAULT_VOICE, {}, () => {});
    const url = new URL(calls[0].url);
    expect(url.hostname).toBe('api.deepgram.com');
    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(calls[0].init.headers.Authorization).toBe('Token dg');
  });

  it('uses Deepgram multi for Hinglish and hi for Hindi, never Flux', async () => {
    const { calls } = mockUpgrade();
    await createStt(env({ DG_MODEL: 'flux-general-en' }), HINGLISH_DG, {}, () => {});
    let url = new URL(calls[0].url);
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('language')).toBe('multi');
    expect(url.searchParams.get('model')).toBe('nova-3');
    await createStt(env(), { ...HINGLISH_DG, language: 'hi' }, {}, () => {});
    url = new URL(calls[1].url);
    expect(url.searchParams.get('language')).toBe('hi');
    expect(deepgramLanguage(env({ DG_LANGUAGE: 'multi' }), DEFAULT_VOICE)).toBe('multi');
  });

  it('opens Sarvam when selected, failing closed without the key', async () => {
    const { calls } = mockUpgrade();
    await expect(createStt(env(), HI, {}, () => {})).rejects.toBeInstanceOf(MissingVoiceKeyError);
    await createStt(env({ SARVAM_API_KEY: 'sk', SARVAM_STT_MODEL: 'saaras:v4' }), HI, {}, () => {});
    expect(new URL(calls[0].url).searchParams.get('model')).toBe('saaras:v4');
  });

  it('Cartesia: English request unchanged, Hindi adds language and the business voice', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(streamOf(Uint8Array.of(0)), { status: 200 });
    }));
    await createTts(env({ CARTESIA_VOICE_ID: 'env-voice' }), DEFAULT_VOICE).start('Hi.');
    expect(Object.keys(bodies[0])).toEqual(['model_id', 'transcript', 'voice', 'output_format']);
    expect(bodies[0].voice.id).toBe('env-voice');
    await createTts(env(), HINGLISH_DG).start('जी हाँ।');
    expect(bodies[1].language).toBe('hi');
    expect(bodies[1].voice.id).toBe('hindi-voice-1');
    expect(createTts(env({ SARVAM_API_KEY: 'k' }), HI).name).toBe('sarvam');
  });
});

// ── Deepgram with Hindi rules (mocked socket) ───────────────────────────────

describe('Deepgram adapter on a Hindi line', () => {
  it('ignores Hindi backchannels for barge-in and answers unpunctuated Hindi at once', async () => {
    const { socket } = mockUpgrade();
    const transcripts: string[] = [];
    const starts: string[] = [];
    await createDeepgramSTT({ apiKey: 'dg', language: 'multi', voiceLanguage: 'hi-en', statementHoldMs: 0 }, t => transcripts.push(t), r => starts.push(r));
    socket.emit({ type: 'Results', is_final: false, start: 0, duration: 0.5, channel: { alternatives: [{ transcript: 'हाँ जी', confidence: 0.9 }] } });
    expect(starts).toEqual([]);
    socket.emit({ type: 'Results', is_final: false, start: 1, duration: 1, channel: { alternatives: [{ transcript: 'मुझे कल appointment चाहिए', confidence: 0.9 }] } });
    expect(starts).toEqual(['interim']);
    socket.emit({ type: 'Results', is_final: true, speech_final: true, start: 1, duration: 1.2, channel: { alternatives: [{ transcript: 'मुझे कल appointment चाहिए', confidence: 0.9 }] } });
    expect(transcripts).toEqual(['मुझे कल appointment चाहिए']);
  });
});
