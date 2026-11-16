export function createTestRateLimiter() {
  const limits = new Map();
  const tails = new Map();

  return {
    idFromName(name) { return name; },
    get(id) {
      return {
        async fetch(_input, init = {}) {
          const previous = tails.get(id) ?? Promise.resolve();
          let release;
          tails.set(id, new Promise(resolve => { release = resolve; }));
          await previous;
          try {
            const { max, windowSeconds } = JSON.parse(String(init.body ?? '{}'));
            const now = Date.now();
            const stored = limits.get(id);
            const state = stored && stored.resetAt > now
              ? stored
              : { count: 0, resetAt: now + windowSeconds * 1000 };
            const limited = state.count >= max;
            if (!limited) state.count += 1;
            limits.set(id, state);
            return Response.json({ limited, remaining: Math.max(0, max - state.count), resetAt: state.resetAt });
          } finally {
            release();
          }
        },
      };
    },
  };
}
