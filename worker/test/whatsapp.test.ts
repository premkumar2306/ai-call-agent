import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import {
  cannedReply, confirmBookingOnWhatsApp, GRAPH_API_VERSION, graphBase, graphFetch, inboundMessages, redactSecrets,
  sendBusinessMessage, splitMessage, templateLanguage, templateParam, utteranceOf, WA_TEXT_MAX, withinServiceWindow,
} from '../src/services/whatsapp-api';
import { claimMessage, rateLimit, resolveBusinessType, verifyMetaSignature, voiceNoteQuery, WA_RATE_LIMIT } from '../src/routes/whatsapp';
import { hashId } from '../src/utils/identity';
import { createD1, createKV } from './stubs/d1';
import type { Env } from '../src/types';

const SECRET = 'app-secret-test';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: createD1() as unknown as D1Database,
    CACHE: createKV() as unknown as KVNamespace,
    CART: createKV() as unknown as KVNamespace,
    TOKEN_SECRET: 't'.repeat(40), ADMIN_SECRET: 'a'.repeat(32), NODE_ENV: 'production', CUSTOMER_HASH_SALT: 'salt',
    WA_APP_SECRET: SECRET, WA_VERIFY_TOKEN: 'verify-me', WA_ACCESS_TOKEN: 'EAAtesttoken1234567890abcdefghij', WA_PHONE_NUMBER_ID: '1000',
    ...over,
  } as Env;
}

let env: Env;
let graph: { url: string; body: any }[];
let pending: Promise<unknown>[];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} });

beforeEach(() => {
  env = makeEnv();
  graph = [];
  pending = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    graph.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function waPayload(messages: any[], phoneNumberId = '1000', extra: any = {}) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '91800' }, messages, ...extra } }] }] };
}
async function post(payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  const res = await app.request('/whatsapp/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig ?? sign(body) } }, env, ctx() as any);
  await Promise.all(pending);
  return res;
}

describe('webhook verification and signatures', () => {
  it('answers the handshake only with the right token', async () => {
    const ok = await app.request('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42', {}, env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('42');
    expect((await app.request('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42', {}, env)).status).toBe(403);
  });

  it('rejects a bad or missing signature, accepts upper-case hex', async () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(await verifyMetaSignature(SECRET, body, sign(body).toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(await verifyMetaSignature(SECRET, body, sign(body).slice(7))).toBe(false);
    expect((await post(waPayload([]), 'sha256=00')).status).toBe(403);
  });
});

describe('webhook payloads', () => {
  it('a statuses-only webhook gets 200 and no reply', async () => {
    const res = await post(waPayload([], '1000', { statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '919800000000' }] }));
    expect(res.status).toBe(200);
    expect(graph).toHaveLength(0);
  });

  it('reads every message in a batched payload, skipping non-message fields', () => {
    const p = waPayload([{ from: '91', id: 'a', type: 'text', text: { body: 'hi' } }, { from: '91', id: 'b', type: 'text', text: { body: 'yo' } }]);
    p.entry.push({ id: 'w2', changes: [{ field: 'account_update', value: { messages: [{ from: '1', id: 'c', type: 'text' }] } } as any] });
    expect(inboundMessages(p).map(m => m.message.id)).toEqual(['a', 'b']);
    expect(inboundMessages({ object: 'page' })).toEqual([]);
  });

  it('answers a retried message id once', async () => {
    expect(await claimMessage(env, 'wamid.dup')).toBe(true);
    expect(await claimMessage(env, 'wamid.dup')).toBe(false);
  });

  it('does not reply for a number that is not mapped', async () => {
    expect(await resolveBusinessType('999', env)).toBeNull();
    await post(waPayload([{ from: '919800000000', id: 'wamid.un', timestamp: String(now()), type: 'text', text: { body: 'hello' } }], '999'));
    expect(graph.filter(g => g.url.includes('/messages'))).toHaveLength(0);
  });

  it('replies from the number the customer wrote to, politely for unsupported types', async () => {
    env = makeEnv({ WA_PHONE_NUMBER_MAP: JSON.stringify({ '2000': 'advanced_vtech' }) } as any);
    await post(waPayload([{ from: '919800000000', id: 'wamid.st', timestamp: String(now()), type: 'sticker', sticker: { id: 's' } }], '2000'));
    const sends = graph.filter(g => g.body?.type === 'text');
    expect(sends).toHaveLength(1);
    expect(sends[0].url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/2000/messages`);
    expect(sends[0].body.to).toBe('919800000000');
    expect(sends[0].body.text.body).toBe(cannedReply('unsupported'));
    // Marked as read (with typing indicator) on the same number.
    expect(graph.some(g => g.url.endsWith('/2000/messages') && g.body?.status === 'read' && g.body.message_id === 'wamid.st')).toBe(true);
  });

  it('ignores a message older than the 24-hour window', async () => {
    await post(waPayload([{ from: '919800000000', id: 'wamid.old', timestamp: String(now() - 25 * 3600), type: 'text', text: { body: 'hi' } }]));
    expect(graph).toHaveLength(0);
  });
});

describe('message types', () => {
  const m = (type: string, extra: any) => ({ from: '91', id: 'x', type, ...extra });
  it('turns each type into text, audio, ignore or a canned reply', () => {
    expect(utteranceOf(m('text', { text: { body: ' hi ' } }))).toEqual({ kind: 'text', text: 'hi' });
    expect(utteranceOf(m('interactive', { interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Book now' } } }))).toEqual({ kind: 'text', text: 'Book now' });
    expect(utteranceOf(m('interactive', { interactive: { type: 'list_reply', list_reply: { id: 'l', title: 'Cleaning', description: '30 min' } } }))).toEqual({ kind: 'text', text: 'Cleaning — 30 min' });
    expect(utteranceOf(m('button', { button: { text: 'Yes', payload: 'Y' } }))).toEqual({ kind: 'text', text: 'Yes' });
    expect(utteranceOf(m('audio', { audio: { id: 'media1', mime_type: 'audio/ogg; codecs=opus' } }))).toMatchObject({ kind: 'audio', mediaId: 'media1' });
    const loc = utteranceOf(m('location', { location: { latitude: 12.97, longitude: 77.59, name: 'Clinic', address: 'MG Road' } }));
    expect(loc.kind === 'text' && loc.text).toMatch(/location: Clinic, MG Road \(12\.97000, 77\.59000\)/);
    const card = utteranceOf(m('contacts', { contacts: [{ name: { formatted_name: 'Asha Rao' }, phones: [{ phone: '+91 98450 12345' }] }] }));
    expect(card.kind === 'text' && card.text).toMatch(/Asha Rao \+91 98450 12345/);
    expect(utteranceOf(m('image', { image: { id: 'i' } }))).toEqual({ kind: 'reply', canned: 'media' });
    const captioned = utteranceOf(m('image', { image: { id: 'i', caption: 'Is this swelling normal?' } }));
    expect(captioned.kind === 'text' && captioned.text).toMatch(/^Is this swelling normal\?\n\[The customer also sent a image/);
    expect(utteranceOf(m('reaction', { reaction: { emoji: '👍' } }))).toEqual({ kind: 'ignore' });
    expect(utteranceOf(m('sticker', {}))).toEqual({ kind: 'reply', canned: 'unsupported' });
    expect(utteranceOf(m('unsupported', {}))).toEqual({ kind: 'reply', canned: 'unsupported' });
  });

  it('canned replies follow the business language', () => {
    expect(cannedReply('unsupported', 'hi')).toMatch(/[ऀ-ॿ]/);
    expect(cannedReply('unsupported', 'hi-en')).toMatch(/type karein/);
  });

  it('voice notes use the business language in Deepgram', () => {
    expect(voiceNoteQuery('en')).toContain('language=en');
    expect(voiceNoteQuery('hi')).toContain('language=hi');
    expect(voiceNoteQuery('hi-en')).toContain('language=multi');
  });
});

describe('limits, window and templates', () => {
  it('splits long replies at natural breaks, within 4096 characters', () => {
    expect(splitMessage('short')).toEqual(['short']);
    const para = 'Sentence one is here. '.repeat(150);
    const parts = splitMessage(`${para}\n\n${para}`);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(p => p.length <= WA_TEXT_MAX)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(`${para}\n\n${para}`.trim().replace(/\s+/g, ' '));
    expect(splitMessage('x'.repeat(5000)).map(p => p.length)).toEqual([4096, 904]);
  });

  it('knows the 24-hour customer-service window', () => {
    expect(withinServiceWindow(now() - 3600)).toBe(true);
    expect(withinServiceWindow(now() - 24 * 3600 - 1)).toBe(false);
    expect(withinServiceWindow(null)).toBe(false);
  });

  it('template parameters drop newlines and tabs', () => {
    expect(templateParam('Booked:\nMon\t10am      at MG Road')).toBe('Booked: Mon 10am   at MG Road');
    expect(templateLanguage({}, 'hi')).toBe('hi');
    expect(templateLanguage({ WA_TEMPLATE_LANGUAGE: 'en_US' }, 'hi')).toBe('en_US');
  });

  it('inside the window sends text; outside it the template; without one, nothing', async () => {
    const opts = { phoneNumberId: '1000', to: '919800000000', phoneHash: 'h1', text: 'You are booked.\nMon 10am', lang: 'en' as const };
    expect(await sendBusinessMessage(env, opts)).toBe('skipped');
    expect(graph).toHaveLength(0);
    env = makeEnv({ WA_CONFIRMATION_TEMPLATE: 'booking_confirmation' } as any);
    expect(await sendBusinessMessage(env, opts)).toBe('template');
    expect(graph[0].body.template).toEqual({ name: 'booking_confirmation', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'You are booked. Mon 10am' }] }] });
    await env.CACHE.put('wa:last:h1', JSON.stringify({ at: now() - 60, pnid: '1000' }));
    expect(await sendBusinessMessage(env, opts)).toBe('text');
    await env.CACHE.put('wa:optout:h1', '1');
    expect(await sendBusinessMessage(env, opts)).toBe('skipped');
  });

  it('confirms a phone booking on WhatsApp only when configured and mapped', async () => {
    const phoneHash = await hashId('919800000000', 'salt');
    const opts = { businessType: 'clinic_x', phone: '+91 98000 00000', phoneHash, text: 'Booked', lang: 'en' as const };
    expect(await confirmBookingOnWhatsApp(env, opts)).toBe('skipped');   // no template configured
    env = makeEnv({ WA_CONFIRMATION_TEMPLATE: 'booking_confirmation' } as any);
    expect(await confirmBookingOnWhatsApp(env, opts)).toBe('skipped');   // business has no WhatsApp number
    await env.DB.prepare('INSERT INTO whatsapp_numbers (phone_number_id, business_type, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('3000', 'clinic_x', null, now(), now()).run();
    expect(await confirmBookingOnWhatsApp(env, opts)).toBe('template');
    expect(graph.at(-1)!.url).toMatch(/\/3000\/messages$/);
    expect(graph.at(-1)!.body.to).toBe('919800000000');
  });

  it('local rate limit tells the customer once a minute, then stays quiet', async () => {
    const seen = [];
    for (let i = 0; i < WA_RATE_LIMIT + 3; i++) seen.push(await rateLimit(env, 'h'));
    expect(seen.filter(s => s === 'ok')).toHaveLength(WA_RATE_LIMIT);
    expect(seen.slice(WA_RATE_LIMIT)).toEqual(['limited', 'silent', 'silent']);
  });
});

describe('Graph client', () => {
  it('pins the API version in one place, with a validated override', () => {
    expect(graphBase({})).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}`);
    expect(graphBase({ WA_GRAPH_API_VERSION: 'v25.0' })).toBe('https://graph.facebook.com/v25.0');
    expect(graphBase({ WA_GRAPH_API_VERSION: '../evil' })).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}`);
  });

  it('logs Graph errors without the token, and retries throttling once', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errors.push(a.join(' ')); });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: 130429, message: 'Rate limit hit' } }), { status: 400 })
        : new Response(JSON.stringify({ error: { code: 190, message: `Invalid token ${env.WA_ACCESS_TOKEN} access_token=EAAsecret` } }), { status: 401 });
    }));
    const r = await graphFetch(env, '1000/messages', { body: {} }, 'send');
    expect(calls).toBe(2);
    expect(r).toMatchObject({ ok: false, status: 401, errorCode: 190 });
    expect(errors.join('\n')).toMatch(/HTTP 401 code 190.*renew WA_ACCESS_TOKEN/);
    expect(errors.join('\n')).not.toContain(env.WA_ACCESS_TOKEN!);
    expect(errors.join('\n')).not.toContain('EAAsecret');
  });

  it('redacts token-shaped strings', () => {
    expect(redactSecrets('Bearer EAAB1234567890123456789012345 and access_token=abc&x=1', 'abc')).toBe('Bearer [redacted] and access_token=[redacted]&x=1');
  });
});
