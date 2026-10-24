import { describe, expect, it } from 'vitest';
import { missingProductionConfig } from '../src/config';
import type { Env } from '../src/types';

// Every name below fails *closed* somewhere deep inside a request, where the
// only symptom is a generic error to the caller. These tests pin the list so
// a deploy can't pass its smoke test while the phone line is dead.

const COMPLETE = {
  NODE_ENV: 'production',
  TOKEN_SECRET: 'x'.repeat(32),
  CUSTOMER_HASH_SALT: 'salt',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_WEBHOOK_URL: 'https://mogi-platform.example.workers.dev',
  DEEPGRAM_API_KEY: 'dg',
  CARTESIA_API_KEY: 'ct',
} as unknown as Env;

const without = (key: keyof Env) => {
  const env = { ...COMPLETE } as Record<string, unknown>;
  delete env[key as string];
  return env as unknown as Env;
};

describe('missingProductionConfig', () => {
  it('reports nothing when production config is complete', () => {
    expect(missingProductionConfig(COMPLETE)).toEqual([]);
  });

  it('stays quiet outside production, so local dev needs no secrets', () => {
    expect(missingProductionConfig({ NODE_ENV: 'development' } as unknown as Env)).toEqual([]);
  });

  it.each([
    'TOKEN_SECRET',
    'CUSTOMER_HASH_SALT',
    'ANTHROPIC_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WEBHOOK_URL',
    'DEEPGRAM_API_KEY',
    'CARTESIA_API_KEY',
  ] as const)('reports %s when it is unset', (key) => {
    expect(missingProductionConfig(without(key))).toContain(key);
  });

  it('treats a too-short TOKEN_SECRET as missing, since signing throws on it', () => {
    // This is the case that 500s /twilio/inbound rather than merely degrading:
    // present, non-empty, and still fatal.
    expect(missingProductionConfig({ ...COMPLETE, TOKEN_SECRET: 'short' } as unknown as Env))
      .toContain('TOKEN_SECRET');
  });

  it('reports every missing name at once, not just the first', () => {
    const bare = { NODE_ENV: 'production' } as unknown as Env;
    expect(missingProductionConfig(bare)).toEqual([
      'TOKEN_SECRET',
      'CUSTOMER_HASH_SALT',
      'ANTHROPIC_API_KEY',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_WEBHOOK_URL',
      'DEEPGRAM_API_KEY',
      'CARTESIA_API_KEY',
    ]);
  });

  it('never returns a config value, only its name', () => {
    const secrets = ['x'.repeat(32), 'salt', 'sk-ant-test', 'tok', 'dg', 'ct'];
    const reported = missingProductionConfig({ NODE_ENV: 'production' } as unknown as Env).join(' ');
    for (const secret of secrets) expect(reported).not.toContain(secret);
  });
});
