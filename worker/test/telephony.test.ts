import { describe, expect, it } from 'vitest';
import { mulawDecodeSample, mulawEncodeSample, mulawToPcm16le, pcm16leToMulaw } from '../src/telephony/g711';
import { TwilioAdapter, ExotelAdapter, PlivoAdapter, createTelephonyAdapter, PROVIDER_HEADER, PREAUTH_HEADER } from '../src/telephony';
import { EXOTEL_FRAME_ALIGN, EXOTEL_MIN_FRAME } from '../src/telephony/exotel';
import { normalizeE164 } from '../src/services/phone-numbers';
import { signCompactStreamToken, verifyCompactStreamToken } from '../src/utils/stream-token';
import { callerIdentity, hashId } from '../src/utils/identity';
import { exotelSecretMatches } from '../src/routes/exotel';
import { plivoRouter, plivoV3BaseString, validatePlivoV3Signature } from '../src/routes/plivo';
import { streamConfig } from '../src/durable-objects/call-relay';
import type { Env } from '../src/types';

const env = (over: Partial<Env> = {}) => ({ TOKEN_SECRET: 'x'.repeat(32), NODE_ENV: 'production', ...over }) as Env;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

describe('G.711 μ-law', () => {
  it('matches the standard reference points', () => {
    expect(mulawEncodeSample(0)).toBe(0xff);
    expect(mulawDecodeSample(0xff)).toBe(0);
    expect(mulawDecodeSample(0x7f)).toBe(0);
    expect(mulawDecodeSample(0x00)).toBe(-32124);
    expect(mulawDecodeSample(0x80)).toBe(32124);
    expect(mulawEncodeSample(32767)).toBe(0x80);
    expect(mulawEncodeSample(-32768)).toBe(0x00);
  });

  it('decode → encode is the identity on every μ-law byte except negative zero', () => {
    for (let u = 0; u < 256; u++) {
      if (u === 0x7f) continue;   // -0 decodes to 0, which encodes as +0 (0xff)
      expect(mulawEncodeSample(mulawDecodeSample(u))).toBe(u);
    }
  });

  it('converts buffers both ways (16-bit little-endian)', () => {
    const mulaw = new Uint8Array([0xff, 0x80, 0x00, 0x7e]);
    const pcm = mulawToPcm16le(mulaw);
    expect(pcm.length).toBe(8);
    expect(new DataView(pcm.buffer).getInt16(2, true)).toBe(32124);
    expect(pcm16leToMulaw(pcm)).toEqual(mulaw);
    expect(pcm16leToMulaw(new Uint8Array(3)).length).toBe(1);   // trailing odd byte ignored
  });
});

describe('TwilioAdapter', () => {
  // These are byte-for-byte the frames CallRelay sent before the adapter layer.
  it('produces the same wire frames as before', () => {
    const a = new TwilioAdapter();
    const start = a.parse(JSON.stringify({
      event: 'start', start: { callSid: 'CA1', streamSid: 'MZ1', customParameters: { businessType: 'advanced_vtech', streamToken: 'tok' } },
    }));
    expect(start).toEqual({ type: 'start', start: { callSid: 'CA1', streamSid: 'MZ1', params: { businessType: 'advanced_vtech', streamToken: 'tok' } } });
    expect(a.audio(new Uint8Array([1, 2, 3]))).toEqual([JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { payload: b64(new Uint8Array([1, 2, 3])) } })]);
    expect(a.mark('m1')).toEqual(['{"event":"mark","streamSid":"MZ1","mark":{"name":"m1"}}']);
    expect(a.clear()).toEqual(['{"event":"clear","streamSid":"MZ1"}']);
  });

  it('parses media, mark and stop; ignores everything else', () => {
    const a = new TwilioAdapter();
    expect(a.parse(JSON.stringify({ event: 'media', media: { payload: b64(new Uint8Array([9, 8])) } })))
      .toEqual({ type: 'media', audio: new Uint8Array([9, 8]) });
    expect(a.parse('{"event":"mark","mark":{"name":"m7"}}')).toEqual({ type: 'mark', name: 'm7' });
    expect(a.parse('{"event":"stop"}')).toEqual({ type: 'stop' });
    expect(a.parse('{"event":"connected"}')).toBeNull();
    expect(a.parse('not json')).toBeNull();
    expect(a.parse(new ArrayBuffer(4))).toBeNull();
  });
});

describe('ExotelAdapter', () => {
  const startFrame = (over: Record<string, unknown> = {}) => JSON.stringify({
    event: 'start', sequence_number: 1, stream_sid: 'SS1',
    start: {
      stream_sid: 'SS1', call_sid: 'EXCA1', account_sid: 'acct', from: '09876543210', to: '08047123456',
      custom_parameters: { a: '1' }, media_format: { encoding: 'raw/slin', sample_rate: '8000', bit_rate: '128kbps' },
      ...over,
    },
  });

  it('parses the start event (snake_case ids, from/to, custom parameters)', () => {
    const a = new ExotelAdapter();
    expect(a.parse(startFrame())).toEqual({
      type: 'start',
      start: { callSid: 'EXCA1', streamSid: 'SS1', params: { a: '1' }, from: '09876543210', to: '08047123456' },
    });
    expect((a.parse(startFrame({ custom_parameters: 'x=1&y=2' })) as any).start.params).toEqual({ x: '1', y: '2' });
  });

  it('converts inbound 16-bit PCM to μ-law for STT', () => {
    const a = new ExotelAdapter();
    const pcm = mulawToPcm16le(new Uint8Array([0x10, 0x90, 0xff, 0x42]));
    expect(a.parse(JSON.stringify({ event: 'media', stream_sid: 'SS1', media: { chunk: 1, timestamp: '20', payload: b64(pcm) } })))
      .toEqual({ type: 'media', audio: new Uint8Array([0x10, 0x90, 0xff, 0x42]) });
    expect(a.parse('{"event":"mark","stream_sid":"SS1","mark":{"name":"m3"}}')).toEqual({ type: 'mark', name: 'm3' });
    expect(a.parse('{"event":"dtmf","dtmf":{"digit":"1"}}')).toBeNull();
    expect(a.parse('{"event":"connected"}')).toBeNull();
    expect(a.parse('{"event":"stop","stop":{"reason":"callended"}}')).toEqual({ type: 'stop' });
  });

  it('frames outbound audio as ≥3200-byte, 320-aligned PCM and pads the tail at a mark', () => {
    const a = new ExotelAdapter();
    a.parse(startFrame());
    // 1000 μ-law bytes → 2000 PCM bytes: below the minimum frame, so held.
    expect(a.audio(new Uint8Array(1000).fill(0xff))).toEqual([]);
    // +1500 → 5000 PCM bytes buffered: one 4800-byte frame, 200 held.
    const sent = a.audio(new Uint8Array(1500).fill(0x80)).map(f => JSON.parse(f));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'media', stream_sid: 'SS1' });
    const first = unb64(sent[0].media.payload);
    expect(first.length).toBe(4800);
    expect(first.length % EXOTEL_FRAME_ALIGN).toBe(0);
    expect(first.length).toBeGreaterThanOrEqual(EXOTEL_MIN_FRAME);

    const atMark = a.mark('m1').map(f => JSON.parse(f));
    expect(atMark.map(f => f.event)).toEqual(['media', 'mark']);
    const tail = unb64(atMark[0].media.payload);
    expect(tail.length).toBe(320);                  // 200 bytes padded to 320
    expect([...tail.subarray(200)].every(b => b === 0)).toBe(true);   // silence
    expect(atMark[1]).toEqual({ event: 'mark', stream_sid: 'SS1', mark: { name: 'm1' } });
    // Nothing left to flush.
    expect(a.mark('m2')).toEqual(['{"event":"mark","stream_sid":"SS1","mark":{"name":"m2"}}']);
  });

  it('clear drops buffered audio and tells Exotel to drop its queue', () => {
    const a = new ExotelAdapter();
    a.parse(startFrame());
    a.audio(new Uint8Array(100));
    expect(a.clear()).toEqual(['{"event":"clear","stream_sid":"SS1"}']);
    expect(a.mark('m1')).toHaveLength(1);   // the dropped audio isn't flushed later
  });
});

describe('PlivoAdapter', () => {
  it('speaks playAudio / checkpoint / clearAudio with μ-law 8 kHz', () => {
    const a = new PlivoAdapter();
    expect(a.parse(JSON.stringify({
      event: 'start', start: { callId: 'uuid-1', streamId: 'st-1', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
      extra_headers: 'businessType=dental',
    }))).toEqual({ type: 'start', start: { callSid: 'uuid-1', streamSid: 'st-1', params: { businessType: 'dental' }, from: undefined, to: undefined } });
    expect(JSON.parse(a.audio(new Uint8Array([5]))[0])).toEqual({
      event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: b64(new Uint8Array([5])) },
    });
    expect(JSON.parse(a.mark('m1')[0])).toEqual({ event: 'checkpoint', streamId: 'st-1', name: 'm1' });
    expect(JSON.parse(a.clear()[0])).toEqual({ event: 'clearAudio', streamId: 'st-1' });
    expect(a.parse('{"event":"playedStream","streamId":"st-1","name":"m1"}')).toEqual({ type: 'mark', name: 'm1' });
    expect(a.parse(JSON.stringify({ event: 'media', media: { payload: b64(new Uint8Array([7])) } }))).toEqual({ type: 'media', audio: new Uint8Array([7]) });
  });
});

describe('createTelephonyAdapter / streamConfig', () => {
  it('builds the adapter for each provider', () => {
    expect(createTelephonyAdapter('twilio').provider).toBe('twilio');
    expect(createTelephonyAdapter('exotel').provider).toBe('exotel');
    expect(createTelephonyAdapter('plivo').provider).toBe('plivo');
  });

  it('reads the provider and URL credential the stream route set', () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    expect(streamConfig(req('https://w/twilio/stream?businessType=x&token=t'))).toEqual({ provider: 'twilio', urlToken: undefined, preauthenticated: false });
    expect(streamConfig(req('https://w/exotel/stream?t=abc', { [PROVIDER_HEADER]: 'exotel' }))).toEqual({ provider: 'exotel', urlToken: 'abc', preauthenticated: false });
    expect(streamConfig(req('https://w/exotel/stream', { [PROVIDER_HEADER]: 'exotel', [PREAUTH_HEADER]: '1' })).preauthenticated).toBe(true);
    expect(streamConfig(req('https://w/plivo/stream?token=jwt', { [PROVIDER_HEADER]: 'plivo' })).urlToken).toBe('jwt');
    // Preauth only means anything for Exotel; unknown providers fall back to Twilio.
    expect(streamConfig(req('https://w/x', { [PROVIDER_HEADER]: 'twilio', [PREAUTH_HEADER]: '1' })).preauthenticated).toBe(false);
    expect(streamConfig(req('https://w/x', { [PROVIDER_HEADER]: 'bogus' })).provider).toBe('twilio');
  });
});

describe('normalizeE164', () => {
  it('handles Indian national formats (Exotel)', () => {
    expect(normalizeE164('09876543210')).toBe('+919876543210');
    expect(normalizeE164('9876543210')).toBe('+919876543210');
    expect(normalizeE164('08047123456')).toBe('+918047123456');
    expect(normalizeE164('919876543210')).toBe('+919876543210');
    expect(normalizeE164('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeE164('0091 9876543210')).toBe('+919876543210');
  });
  it('keeps E.164 and applies the default country to national numbers', () => {
    expect(normalizeE164('+13126854305', '1')).toBe('+13126854305');
    expect(normalizeE164('3126854305', '1')).toBe('+13126854305');
  });
  it('rejects things that are not phone numbers', () => {
    for (const bad of [undefined, null, '', 'anonymous', '123', '+1234567890123456', '0123']) expect(normalizeE164(bad as any)).toBeNull();
  });
});

describe('callerIdentity', () => {
  it('hashes the E.164 digits — the same key Twilio and WhatsApp use', async () => {
    const id = await callerIdentity('09876543210', 'CA1', 'salt', (r) => normalizeE164(r, '91'));
    expect(id).toEqual({ callerHash: await hashId('919876543210', 'salt'), callerPhone: '+919876543210' });
  });
  it('gives a withheld number a per-call identity', async () => {
    const id = await callerIdentity('anonymous', 'CA9', 'salt', (r) => normalizeE164(r, '91'));
    expect(id).toEqual({ callerHash: await hashId('call:CA9', 'salt'), callerPhone: undefined });
  });
});

describe('compact stream token (Exotel)', () => {
  const claims = { callSid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', businessType: 'kovai_wellness_clinic', from: '+919876543210' };

  it('round-trips and fits Exotel\'s 256-char query limit', async () => {
    const t = await signCompactStreamToken(env(), claims);
    expect(`t=${t}`.length).toBeLessThan(256);
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyCompactStreamToken(env(), t)).toEqual(claims);
  });

  it('drops the optional caller number rather than exceed the limit', async () => {
    const long = { ...claims, businessType: 'b'.repeat(70) };
    const t = await signCompactStreamToken(env(), long);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(await verifyCompactStreamToken(env(), t)).toEqual({ callSid: long.callSid, businessType: long.businessType, from: undefined });
  });

  it('rejects tampering, another secret, and expiry', async () => {
    const t = await signCompactStreamToken(env(), claims, 1000);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ c: claims.callSid, b: 'other', e: 99999999999 })).toString('base64url');
    expect(await verifyCompactStreamToken(env(), `${forged}.${sig}`, 1001)).toBeNull();
    expect(await verifyCompactStreamToken(env({ TOKEN_SECRET: 'y'.repeat(32) }), t, 1001)).toBeNull();
    expect(await verifyCompactStreamToken(env(), `${body}.${sig}`, 1001)).not.toBeNull();
    expect(await verifyCompactStreamToken(env(), t, 1000 + 301)).toBeNull();
    expect(await verifyCompactStreamToken(env(), 'garbage', 1001)).toBeNull();
    expect(await verifyCompactStreamToken(env(), `${body}.${sig}.x`, 1001)).toBeNull();
  });
});

describe('exotelSecretMatches', () => {
  const q = (s: string) => new URLSearchParams(s);
  it('accepts ?key= or a Basic-auth password', () => {
    expect(exotelSecretMatches('s3cret', q('key=s3cret'), undefined)).toBe(true);
    expect(exotelSecretMatches('s3cret', q(''), `Basic ${btoa('avery:s3cret')}`)).toBe(true);
    expect(exotelSecretMatches('s3cret', q(''), `Basic ${btoa(':s3cret')}`)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(exotelSecretMatches('s3cret', q('key=wrong'), undefined)).toBe(false);
    expect(exotelSecretMatches('s3cret', q(''), `Basic ${btoa('avery:wrong')}`)).toBe(false);
    expect(exotelSecretMatches('s3cret', q(''), `Basic ${btoa('s3cret')}`)).toBe(false);   // no colon
    expect(exotelSecretMatches('s3cret', q(''), 'Basic !!!notbase64')).toBe(false);
    expect(exotelSecretMatches('s3cret', q(''), 'Bearer s3cret')).toBe(false);
    expect(exotelSecretMatches('s3cret', q(''), undefined)).toBe(false);
  });
});

describe('Plivo V3 signature', () => {
  it('builds the base string from the URL, sorted params and nonce', () => {
    expect(plivoV3BaseString('POST', 'https://w.dev/plivo/answer', { To: '918', From: '919', CallUUID: 'u' }, 'n1'))
      .toBe('https://w.dev/plivo/answer?CallUUIDuFrom919To918.n1');
    expect(plivoV3BaseString('POST', 'https://w.dev/plivo/hangup', {}, 'n1')).toBe('https://w.dev/plivo/hangup.n1');
    expect(plivoV3BaseString('POST', 'https://w.dev/p?a=1', {}, 'n1')).toBe('https://w.dev/p?a=1.n1');
    expect(plivoV3BaseString('POST', 'https://w.dev/plivo/answer?b=2&a=1', { X: '1' }, 'n1'))
      .toBe('https://w.dev/plivo/answer?a=1&b=2.X1.n1');
    expect(plivoV3BaseString('GET', 'https://w.dev/p?b=2', { a: '1' }, 'n')).toBe('https://w.dev/p?a=1&b=2.n');
  });

  it('validates any of the comma-separated signatures', async () => {
    const url = 'https://w.dev/plivo/answer';
    const params = { CallUUID: 'u', From: '919876543210' };
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('tok'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plivoV3BaseString('POST', url, params, 'n1')))).toString('base64');
    expect(await validatePlivoV3Signature('tok', `old,${sig}`, 'n1', 'POST', url, params)).toBe(true);
    expect(await validatePlivoV3Signature('tok', sig, 'n2', 'POST', url, params)).toBe(false);
    expect(await validatePlivoV3Signature('tok', sig, 'n1', 'POST', url, { ...params, From: '1' })).toBe(false);
  });

  it("matches a signature computed with Plivo's SDK algorithm (url?sortedParams.nonce)", async () => {
    // HMAC-SHA256('tok', 'https://w.dev/plivo/answer?CallUUIDuFrom919To918.n1'), base64.
    const sdk = 'qSkJ4jtgVLWjXIy7vHy8LfsnlABM3krBIA4sUGYUnF8=';
    expect(await validatePlivoV3Signature('tok', sdk, 'n1', 'POST', 'https://w.dev/plivo/answer', { To: '918', From: '919', CallUUID: 'u' })).toBe(true);
  });
});

describe('Plivo routes', () => {
  const kv = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } }; };
  const TOKEN = 'pl-tok';
  const BASE = 'https://w.dev';
  async function signed(path: string, params: Record<string, string>, e: Env, sig?: string) {
    const nonce = 'n' + Math.random().toString(36).slice(2);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const good = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plivoV3BaseString('POST', BASE + path, params, nonce)))).toString('base64');
    return plivoRouter.request(path, {
      method: 'POST', body: new URLSearchParams(params).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Plivo-Signature-V3': sig ?? good, 'X-Plivo-Signature-V3-Nonce': nonce },
    }, e);
  }
  const penv = (cache = kv()) => env({ PLIVO_AUTH_TOKEN: TOKEN, PLIVO_WEBHOOK_URL: BASE, CACHE: cache as any });

  it('rejects unsigned and badly signed webhooks, and fails closed in production without the token', async () => {
    const p = { CallUUID: 'u1', From: '919812345678', To: '918047100001' };
    expect((await signed('/answer', p, penv(), 'bad')).status).toBe(403);
    expect((await plivoRouter.request('/answer', { method: 'POST', body: new URLSearchParams(p).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, penv())).status).toBe(403);
    expect((await plivoRouter.request('/hangup', { method: 'POST', body: '' }, env({ CACHE: kv() as any }))).status).toBe(403);
  });

  it('transfers with our own number as caller ID and a Dial action', async () => {
    const cache = kv();
    cache.m.set('transfer:u2', '+919876500001');
    const res = await signed('/after-stream', { CallUUID: 'u2', To: '918047100001', From: '919812345678' }, penv(cache));
    const body = await res.text();
    expect(body).toContain('callerId="918047100001"');
    expect(body).toContain('action="https://w.dev/plivo/after-dial"');
    expect(body).toContain('<Number>919876500001</Number>');
    expect(body).not.toContain('<Speak>');
    expect(await (await signed('/after-stream', { CallUUID: 'u3' }, penv(cache))).text()).toContain('<Hangup/>');
  });

  it('only apologises when the staff leg was not answered', async () => {
    expect(await (await signed('/after-dial', { CallUUID: 'u2', DialStatus: 'completed' }, penv())).text()).not.toContain('Speak');
    expect(await (await signed('/after-dial', { CallUUID: 'u2', DialStatus: 'no-answer' }, penv())).text()).toContain('nobody was able to pick up');
  });

  it('acknowledges the hangup callback (also when it arrives at the Answer URL)', async () => {
    const cache = kv();
    cache.m.set('transfer:u4', '+919876500001');
    const r = await signed('/hangup', { CallUUID: 'u4', CallStatus: 'completed', Event: 'Hangup', HangupCause: 'NORMAL_CLEARING', Duration: '42' }, penv(cache));
    expect(r.status).toBe(200);
    expect(cache.m.has('transfer:u4')).toBe(false);
    const a = await signed('/answer', { CallUUID: 'u5', CallStatus: 'completed', Event: 'Hangup', To: '918047100001' }, penv());
    expect(a.status).toBe(200);
    expect(await a.text()).not.toContain('<Stream');
  });
});
