import { describe, expect, it } from 'vitest';
import { timingSafeEqual, customerHashSalt, tokenSecretKey } from '../src/config';
import { twilioSignedUrl, validateTwilioSignature } from '../src/routes/twilio';
import { verifyMetaSignature, isOptOut } from '../src/routes/whatsapp';
import { signStreamToken, verifyStreamToken } from '../src/utils/stream-token';
import { escapeHtml } from '../src/services/email.service';
import { isAllowedOrigin } from '../src/index';
import type { Env } from '../src/types';

const env = (over: Partial<Env> = {}) =>
  ({ TOKEN_SECRET: 'x'.repeat(32), NODE_ENV: 'production', ...over }) as Env;

async function hmacB64(alg: 'SHA-1' | 'SHA-256', key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: alg }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

describe('timingSafeEqual', () => {
  it('compares exactly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('secret config fails closed in production', () => {
  it('requires CUSTOMER_HASH_SALT', () => {
    expect(() => customerHashSalt(env())).toThrow();
    expect(customerHashSalt(env({ NODE_ENV: 'development' }))).toBe('dev-hash-salt');
    expect(customerHashSalt(env({ CUSTOMER_HASH_SALT: 's' }))).toBe('s');
  });
  it('requires a 32+ char TOKEN_SECRET', () => {
    expect(() => tokenSecretKey(env({ TOKEN_SECRET: 'short' }))).toThrow();
    expect(() => tokenSecretKey(env({ TOKEN_SECRET: '' }))).toThrow();
    expect(tokenSecretKey(env())).toBeInstanceOf(Uint8Array);
  });
});

describe('validateTwilioSignature', () => {
  it('accepts a correctly signed request and rejects tampering', async () => {
    const url = 'https://example.workers.dev/twilio/inbound';
    const params = { CallSid: 'CA123', From: '+15551234567' };
    const data = url + 'CallSid' + 'CA123' + 'From' + '+15551234567';
    const sig = btoa(String.fromCharCode(...await hmacB64('SHA-1', 'tok', data)));
    expect(await validateTwilioSignature('tok', sig, url, params)).toBe(true);
    expect(await validateTwilioSignature('tok', sig, url, { ...params, From: '+1999' })).toBe(false);
    expect(await validateTwilioSignature('other', sig, url, params)).toBe(false);
  });

  it('includes the request query string in the signed webhook URL', () => {
    expect(twilioSignedUrl(
      'https://example.workers.dev/',
      '/twilio/inbound',
      'https://internal.example/twilio/inbound?businessType=kovai_wellness_clinic',
    )).toBe('https://example.workers.dev/twilio/inbound?businessType=kovai_wellness_clinic');
  });
});

describe('verifyMetaSignature', () => {
  it('checks X-Hub-Signature-256', async () => {
    const body = '{"object":"whatsapp_business_account"}';
    const hex = Array.from(await hmacB64('SHA-256', 'app', body)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(await verifyMetaSignature('app', body, `sha256=${hex}`)).toBe(true);
    expect(await verifyMetaSignature('app', body + ' ', `sha256=${hex}`)).toBe(false);
    expect(await verifyMetaSignature('app', body, '')).toBe(false);
  });
});

describe('isOptOut', () => {
  it('matches bare keywords only', () => {
    for (const t of ['STOP', 'stop', ' Unsubscribe ', 'cancel', 'opt out', 'opt-out', 'Stop!']) expect(isOptOut(t)).toBe(true);
  });
  it('does not unsubscribe booking requests', () => {
    for (const t of ['I need to cancel my appointment', 'can you stop by tuesday', 'cancel my oil change']) {
      expect(isOptOut(t)).toBe(false);
    }
  });
});

describe('stream token', () => {
  it('round-trips and binds businessType', async () => {
    const tok = await signStreamToken(env(), 'dental');
    expect(await verifyStreamToken(env(), tok)).toBe('dental');
  });
  it('rejects a token signed with another secret or a forged string', async () => {
    const tok = await signStreamToken(env({ TOKEN_SECRET: 'y'.repeat(32) }), 'dental');
    expect(await verifyStreamToken(env(), tok)).toBeNull();
    expect(await verifyStreamToken(env(), 'garbage')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });
});

describe('isAllowedOrigin', () => {
  it('allows Pages projects, previews, localhost and configured extras only', () => {
    const e = { ALLOWED_ORIGINS: 'https://admin.example.com' };
    expect(isAllowedOrigin('https://mogi-admin.pages.dev', e)).toBe(true);
    expect(isAllowedOrigin('https://abc123.avery-admin.pages.dev', e)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', e)).toBe(true);
    expect(isAllowedOrigin('https://admin.example.com', e)).toBe(true);
    expect(isAllowedOrigin('https://evil-mogi-admin.pages.dev', e)).toBe(false);
    expect(isAllowedOrigin('http://mogi-admin.pages.dev', e)).toBe(false);
    expect(isAllowedOrigin('https://evil.com', e)).toBe(false);
  });
});
