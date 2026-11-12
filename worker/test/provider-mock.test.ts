import { afterEach, describe, expect, it } from 'vitest';
import { installProviderMock, mockedUrl } from '../src/utils/provider-mock';

const ORIGINAL = Symbol.for('avery.originalFetch');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any)[ORIGINAL];
});

describe('provider mock (e2e only)', () => {
  it('maps outside services onto the mock base, path and query kept', () => {
    expect(mockedUrl('https://api.sarvam.ai/text-to-speech/stream?x=1', 'http://127.0.0.1:9/'))
      .toBe('http://127.0.0.1:9/api.sarvam.ai/text-to-speech/stream?x=1');
    expect(mockedUrl('https://api.deepgram.com/v1/listen?model=nova-3', 'http://m'))
      .toBe('http://m/api.deepgram.com/v1/listen?model=nova-3');
    expect(mockedUrl('https://oauth2.googleapis.com/token', 'http://m')).toBeNull();
    expect(mockedUrl('not a url', 'http://m')).toBeNull();
  });

  it('never redirects in production, whatever the vars say', () => {
    installProviderMock({ NODE_ENV: 'production', PROVIDER_MOCK_URL: 'http://evil.example' });
    expect(globalThis.fetch).toBe(realFetch);
  });

  it('does nothing without PROVIDER_MOCK_URL', () => {
    installProviderMock({ NODE_ENV: 'staging' });
    expect(globalThis.fetch).toBe(realFetch);
  });

  it('redirects mocked hosts and leaves the rest alone when enabled', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response('ok');
    }) as typeof fetch;
    installProviderMock({ NODE_ENV: 'staging', PROVIDER_MOCK_URL: 'http://127.0.0.1:9' });
    await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
    await fetch('https://example.com/x');
    expect(seen).toEqual(['http://127.0.0.1:9/api.anthropic.com/v1/messages', 'https://example.com/x']);
  });
});
