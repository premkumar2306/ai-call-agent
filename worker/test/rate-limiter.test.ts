import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/durable-objects/rate-limiter';
import { hitLimit } from '../src/middleware';
import type { Env } from '../src/types';

class TestStorage {
  private values = new Map<string, unknown>();
  private transactionTail = Promise.resolve();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarmAt = null;
  }

  async transaction<T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

function createNamespace() {
  const instances = new Map<string, RateLimiter>();
  const storages = new Map<string, TestStorage>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        let instance = instances.get(id);
        if (!instance) {
          const storage = new TestStorage();
          storages.set(id, storage);
          instance = new RateLimiter({ storage } as unknown as DurableObjectState, {});
          instances.set(id, instance);
        }
        return instance.fetch(new Request(input, init));
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, instances, storages };
}

afterEach(() => vi.useRealTimers());

describe('atomic rate limiter', () => {
  it('admits exactly max requests during a concurrent burst', async () => {
    const { namespace } = createNamespace();
    const env = { RATE_LIMITER: namespace } as Env;

    const results = await Promise.all(
      Array.from({ length: 200 }, () => hitLimit(env, 'rl:burst:customer', 25, 60)),
    );

    expect(results.filter(limited => !limited)).toHaveLength(25);
    expect(results.filter(Boolean)).toHaveLength(175);
  });

  it('isolates keys while serializing requests for the same key', async () => {
    const { namespace } = createNamespace();
    const env = { RATE_LIMITER: namespace } as Env;

    const [first, second] = await Promise.all([
      Promise.all(Array.from({ length: 40 }, () => hitLimit(env, 'rl:voice:a', 7, 60))),
      Promise.all(Array.from({ length: 40 }, () => hitLimit(env, 'rl:voice:b', 11, 60))),
    ]);

    expect(first.filter(limited => !limited)).toHaveLength(7);
    expect(second.filter(limited => !limited)).toHaveLength(11);
  });

  it('opens a fresh window after expiry and removes expired storage on alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { namespace, instances, storages } = createNamespace();
    const env = { RATE_LIMITER: namespace } as Env;

    expect(await hitLimit(env, 'rl:auth:ip', 2, 10)).toBe(false);
    expect(await hitLimit(env, 'rl:auth:ip', 2, 10)).toBe(false);
    expect(await hitLimit(env, 'rl:auth:ip', 2, 10)).toBe(true);

    vi.advanceTimersByTime(10_001);
    expect(await hitLimit(env, 'rl:auth:ip', 2, 10)).toBe(false);

    vi.advanceTimersByTime(10_001);
    await instances.get('rl:auth:ip')!.alarm();
    expect(await storages.get('rl:auth:ip')!.get('limit')).toBeUndefined();
  });

  it('rejects malformed limiter requests without changing state', async () => {
    const storage = new TestStorage();
    const limiter = new RateLimiter({ storage } as unknown as DurableObjectState, {});
    const response = await limiter.fetch(new Request('https://rate-limiter.internal/hit', {
      method: 'POST',
      body: JSON.stringify({ max: 0, windowSeconds: 60 }),
    }));

    expect(response.status).toBe(400);
    expect(await storage.get('limit')).toBeUndefined();
  });
});
