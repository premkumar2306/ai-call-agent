import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drives a real CallRelay through a fake carrier socket: the carrier's
// protocol frames in, the frames CallRelay sends back out. Deepgram is
// replaced by a fake STT and Cartesia by a stubbed fetch, so this runs
// offline. Covers the Exotel adapter end to end and pins the Twilio wire
// format so the refactor can't change the US line.

const stt = vi.hoisted(() => ({ audio: [] as Uint8Array[], closed: 0 }));
vi.mock('../src/durable-objects/stt-deepgram', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/durable-objects/stt-deepgram')>();
  const fake = async () => ({
    sendAudio: (buf: ArrayBuffer) => { stt.audio.push(new Uint8Array(buf)); },
    close: () => { stt.closed++; },
  });
  return { ...real, createDeepgramSTT: fake, createDeepgramFluxSTT: fake };
});

import { CallRelay } from '../src/durable-objects/call-relay';
import { ExotelAdapter, TwilioAdapter } from '../src/telephony';
import { mulawToPcm16le } from '../src/telephony/g711';
import { signCompactStreamToken, signStreamToken } from '../src/utils/stream-token';
import { hashId } from '../src/utils/identity';
import type { Env } from '../src/types';

class FakeSocket {
  readyState = 1;   // OPEN
  sent: any[] = [];
  closed?: { code: number; reason: string };
  send(m: string) { this.sent.push(JSON.parse(m)); }
  close(code: number, reason: string) { this.readyState = 3; this.closed = { code, reason }; }
}

// Cartesia: every synthesis returns 2500 bytes of μ-law in two network chunks.
const TTS_BYTES = 2500;
function stubCartesia() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).includes('cartesia')) throw new Error(`unexpected fetch ${url}`);
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new Uint8Array(2000).fill(0x80));
        ctl.enqueue(new Uint8Array(TTS_BYTES - 2000).fill(0x80));
        ctl.close();
      },
    });
    return new Response(body, { status: 200 });
  }));
}

function makeEnv(over: Partial<Env> = {}): Env {
  const unavailable = () => { throw new Error('D1 unavailable in this test'); };
  return {
    NODE_ENV: 'development',
    TOKEN_SECRET: 'x'.repeat(32),
    CUSTOMER_HASH_SALT: 'salt',
    TWILIO_DEFAULT_CUSTOMER_HASH: 'demo-caller',
    CARTESIA_API_KEY: 'test',
    DEEPGRAM_API_KEY: 'test',
    // health_nav skips the catalog/booking prefetches, which need D1.
    EXOTEL_DEFAULT_BUSINESS_TYPE: 'health_nav',
    DB: { prepare: unavailable, batch: unavailable } as any,
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } as any,
    ...over,
  } as Env;
}

function makeRelay(env: Env, provider: 'exotel' | 'twilio', opts: { urlToken?: string; preauth?: boolean } = {}) {
  const ctx = { acceptWebSocket() {}, waitUntil(p: Promise<unknown>) { p.catch(() => {}); } };
  const relay = new CallRelay(ctx as any, env) as any;
  const ws = new FakeSocket();
  relay.twWs = ws;
  relay.telephony = provider === 'exotel' ? new ExotelAdapter() : new TwilioAdapter();
  relay.urlToken = opts.urlToken;
  relay.preauthenticated = !!opts.preauth;
  const send = (m: unknown) => relay.webSocketMessage(ws, JSON.stringify(m));
  return { relay, ws, send };
}

const exotelStart = (callSid = 'EXCA1') => ({
  event: 'start', sequence_number: 1, stream_sid: 'SS1',
  start: {
    stream_sid: 'SS1', call_sid: callSid, account_sid: 'acct', from: '09876543210', to: '08047123456',
    custom_parameters: {}, media_format: { encoding: 'raw/slin', sample_rate: '8000', bit_rate: '128kbps' },
  },
});

beforeEach(() => { stt.audio = []; stt.closed = 0; stubCartesia(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CallRelay over Exotel', () => {
  it('greets in Exotel frames, tracks marks, forwards caller audio and barges in', async () => {
    const { relay, ws, send } = makeRelay(makeEnv(), 'exotel');
    vi.spyOn(console, 'error').mockImplementation(() => {});   // the D1 number lookup fails here → default business
    await send({ event: 'connected' });
    expect(ws.sent).toEqual([]);

    await send(exotelStart());
    expect(relay.session).toMatchObject({ businessType: 'health_nav', callerPhone: '+919876543210', sub: await hashId('919876543210', 'salt') });

    // Greeting: "Thanks for calling!" then the business line — two chunks, two marks.
    await vi.waitFor(() => expect(ws.sent.filter(m => m.event === 'mark')).toHaveLength(2));
    for (const m of ws.sent) expect(m.stream_sid).toBe('SS1');
    const media = ws.sent.filter(m => m.event === 'media').map(m => Buffer.from(m.media.payload, 'base64'));
    for (const frame of media) expect(frame.length % 320).toBe(0);
    // Each chunk (2000 + 500 μ-law bytes → 4000 + 1000 PCM): 3840 bytes (320-aligned,
    // ≥3200) go out as the first network chunk arrives; the 160 left over plus
    // the second chunk's 1000 are padded to 1280 at the mark.
    expect(media.map(f => f.length)).toEqual([3840, 1280, 3840, 1280]);
    // Audio is μ-law → 16-bit PCM: 0x80 decodes to +32124.
    expect(media[0].readInt16LE(0)).toBe(32124);

    // Exotel reports playback reaching the marks.
    expect(relay.pendingMarks.size).toBe(2);
    for (const m of ws.sent.filter(m => m.event === 'mark')) await send({ event: 'mark', stream_sid: 'SS1', mark: { name: m.mark.name } });
    expect(relay.pendingMarks.size).toBe(0);

    // Caller audio reaches STT as μ-law.
    const pcm = mulawToPcm16le(new Uint8Array(160).fill(0x2a));
    await send({ event: 'media', stream_sid: 'SS1', media: { chunk: 1, timestamp: '20', payload: Buffer.from(pcm).toString('base64') } });
    expect(stt.audio.at(-1)).toEqual(new Uint8Array(160).fill(0x2a));

    // Barge-in clears Exotel's playback queue.
    relay.bargeIn();
    expect(ws.sent.at(-1)).toEqual({ event: 'clear', stream_sid: 'SS1' });

    await send({ event: 'stop', stream_sid: 'SS1', stop: { reason: 'callended' } });
    expect(stt.closed).toBeGreaterThan(0);
  });

  it('accepts a /exotel/voicebot token bound to this call (production)', async () => {
    const env = makeEnv({ NODE_ENV: 'production' });
    const t = await signCompactStreamToken(env, { callSid: 'EXCA1', businessType: 'health_nav', from: '+919811122233' });
    const { relay, ws, send } = makeRelay(env, 'exotel', { urlToken: t });
    await send(exotelStart('EXCA1'));
    expect(ws.closed).toBeUndefined();
    expect(relay.session).toMatchObject({ businessType: 'health_nav', callerPhone: '+919811122233' });
  });

  it('rejects a token minted for another call, and a missing token, in production', async () => {
    const env = makeEnv({ NODE_ENV: 'production' });
    const t = await signCompactStreamToken(env, { callSid: 'OTHER', businessType: 'health_nav' });
    const a = makeRelay(env, 'exotel', { urlToken: t });
    await a.send(exotelStart('EXCA1'));
    expect(a.ws.closed).toEqual({ code: 1008, reason: 'Unauthorized' });
    expect(a.relay.session).toBeUndefined();

    const b = makeRelay(env, 'exotel');
    await b.send(exotelStart('EXCA1'));
    expect(b.ws.closed).toEqual({ code: 1008, reason: 'Unauthorized' });
  });

  it('accepts a route-authenticated static stream and routes by the called number', async () => {
    const env = makeEnv({ NODE_ENV: 'production' });
    const { relay, ws, send } = makeRelay(env, 'exotel', { preauth: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});   // the D1 lookup fails here → default business
    await send(exotelStart());
    expect(ws.closed).toBeUndefined();
    expect(relay.session).toMatchObject({ businessType: 'health_nav', callerPhone: '+919876543210' });
  });
});

describe('CallRelay over Twilio (unchanged wire format)', () => {
  it('sends camelCase media/mark/clear frames exactly as before', async () => {
    const env = makeEnv({ NODE_ENV: 'production' });
    const streamToken = await signStreamToken(env, 'health_nav', 'hash-1', '+13125550100');
    const { relay, ws, send } = makeRelay(env, 'twilio');
    await send({ event: 'start', start: { callSid: 'CA1', streamSid: 'MZ1', customParameters: { businessType: 'health_nav', streamToken } } });
    expect(relay.session).toMatchObject({ businessType: 'health_nav', sub: 'hash-1', callerPhone: '+13125550100' });

    await vi.waitFor(() => expect(ws.sent.filter(m => m.event === 'mark')).toHaveLength(2));
    // μ-law passes straight through, one media frame per Cartesia network chunk.
    expect(ws.sent.slice(0, 3)).toEqual([
      { event: 'media', streamSid: 'MZ1', media: { payload: Buffer.alloc(2000, 0x80).toString('base64') } },
      { event: 'media', streamSid: 'MZ1', media: { payload: Buffer.alloc(500, 0x80).toString('base64') } },
      { event: 'mark', streamSid: 'MZ1', mark: { name: 'm1' } },
    ]);

    await send({ event: 'mark', streamSid: 'MZ1', mark: { name: 'm1' } });
    await send({ event: 'media', media: { payload: Buffer.alloc(160, 0x11).toString('base64') } });
    expect(stt.audio.at(-1)).toEqual(new Uint8Array(160).fill(0x11));
    relay.bargeIn();
    expect(ws.sent.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
  });

  it('still rejects a stream without a token in production', async () => {
    const { ws, send } = makeRelay(makeEnv({ NODE_ENV: 'production' }), 'twilio');
    await send({ event: 'start', start: { callSid: 'CA1', streamSid: 'MZ1', customParameters: {} } });
    expect(ws.closed).toEqual({ code: 1008, reason: 'Unauthorized' });
  });
});
