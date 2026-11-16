# Atomic rate limiting

Spend-sensitive and authentication routes use `hitLimit`, `ipRateLimit`, or
`sessionRateLimit` from `worker/src/middleware.ts`. These APIs route requests to
the `RATE_LIMITER` Durable Object binding rather than incrementing KV counters.

## Behavior

- Each complete limiter key maps to one Durable Object using `idFromName`.
- The object applies a fixed window beginning with the first admitted request.
- State updates run in a Durable Object storage transaction, so concurrent
  requests for one key cannot read the same counter and overshoot the limit.
- The request that reaches `max` is admitted. Later requests receive HTTP 429
  from route middleware until the window expires.
- Different limiter keys map to independent objects and do not block each other.
- An alarm removes expired state. A request arriving after expiry can begin the
  next window immediately even if cleanup has not run yet.
- Limiter service errors fail closed through the Worker's global error handler;
  an unavailable binding does not silently allow spend-sensitive traffic.

## Configuration and deployment

`worker/wrangler.toml` binds `RATE_LIMITER` to the `RateLimiter` class. Durable
Object migration `v2` creates its SQLite-backed namespace. Deploy the Worker
normally with `npm run deploy`; Wrangler applies Durable Object class migrations
as part of version deployment. Do not remove or rename a deployed class without
adding the corresponding Wrangler migration.

Route-specific limits remain declared beside each route. Changing a limit takes
effect immediately for new requests. Existing windows retain their original
expiry but evaluate admission against the newly deployed `max` value.

## Verification

From `worker/`, run:

```sh
npm run check
```

`test/rate-limiter.test.ts` sends concurrent bursts against an in-memory model
of Durable Object transactional storage and verifies exact admission, key
isolation, window reset, alarm cleanup, and invalid-input handling.
