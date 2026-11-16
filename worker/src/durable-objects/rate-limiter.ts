import { DurableObject } from 'cloudflare:workers';

interface LimitState {
  count: number;
  resetAt: number;
}

interface LimitRequest {
  max: number;
  windowSeconds: number;
}

interface LimitResult {
  limited: boolean;
  remaining: number;
  resetAt: number;
}

const STATE_KEY = 'limit';

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class RateLimiter extends DurableObject<unknown> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let input: LimitRequest;
    try {
      input = await request.json<LimitRequest>();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!validPositiveInteger(input.max) || !validPositiveInteger(input.windowSeconds)) {
      return Response.json({ error: 'max and windowSeconds must be positive integers' }, { status: 400 });
    }

    const now = Date.now();
    const result = await this.ctx.storage.transaction(async transaction => {
      const stored = await transaction.get<LimitState>(STATE_KEY);
      const state = stored && stored.resetAt > now
        ? stored
        : { count: 0, resetAt: now + input.windowSeconds * 1000 };

      if (state.count >= input.max) {
        return { limited: true, remaining: 0, resetAt: state.resetAt } satisfies LimitResult;
      }

      state.count += 1;
      await transaction.put(STATE_KEY, state);
      return {
        limited: false,
        remaining: input.max - state.count,
        resetAt: state.resetAt,
      } satisfies LimitResult;
    });

    await this.ctx.storage.setAlarm(result.resetAt);
    return Response.json(result);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<LimitState>(STATE_KEY);
    if (!state || state.resetAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(state.resetAt);
  }
}
