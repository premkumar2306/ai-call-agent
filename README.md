# Avery Platform

AI-powered voice assistant for multi-vertical businesses (auto shop, clinic, real estate). Customers call a phone number and talk to **Avery** — a voice agent that searches services, checks availability, and books appointments.

**Live phone number: +1 (312) 685-4305**

---

## Architecture

```
Caller → Twilio → Cloudflare Worker (Hono API)
                        ├── /twilio/inbound  → <Connect><Stream> TwiML
                        ├── /twilio/stream   → CallRelay Durable Object (1 per call)
                        │                        ├── Deepgram (STT)
                        │                        ├── Cartesia (TTS)
                        │                        └── runTurn() ─┐
                        ├── Anthropic Claude (voice AI) ────────┘
                        ├── D1 Database (products, orders, transcripts)
                        └── KV Store (catalog cache, call history)

Browser → Cloudflare Pages (React admin UI)
```

Everything — call audio streaming, STT/TTS, and the LLM agent loop — runs inside the
Cloudflare Worker. There's no separate media-relay service to deploy or keep running.

| Folder | What it is |
|--------|-----------|
| `worker/` | Cloudflare Worker — API, AI logic, Twilio webhooks, call-audio Durable Object |
| `web/` | Cloudflare Pages — React admin dashboard |
| `.claude/commands/` | `/add-vertical` skill for Claude Code |

---

## Making a Call

1. Call **+1 (312) 685-4305**
2. Avery greets you and asks how she can help
3. Say what you need — e.g. *"What are your hours on Saturday?"* or *"I need an oil change"*
4. Avery searches services, checks availability, and can book an appointment

The call goes: Twilio → `/twilio/inbound` (returns a `<Stream>` TwiML) → `/twilio/stream`
(WebSocket, upgrades into a per-call `CallRelay` Durable Object) → Deepgram STT → the LLM
agent loop (`runTurn()`) → Cartesia TTS streamed back to the caller, with barge-in support
(interrupting the assistant mid-sentence starts a new turn immediately).

`/twilio/turn` (plain HTTP, TwiML in/out) still exists as a thin wrapper around the same
`runTurn()` logic — useful for `curl`-based testing without a real phone call (see below).

---

## Local Development

### Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm install -g wrangler`
- Cloudflare account (free tier works)
- Anthropic API key

### 1. Clone and install

```bash
git clone <repo-url>
cd ai-call-agent

# Install worker deps
cd worker && npm install

# Install web deps
cd ../web && npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Local secrets

```bash
cd worker
cp .dev.vars.example .dev.vars   # gitignored; read by `wrangler dev`
```

`NODE_ENV=development` in `.dev.vars` relaxes the production fail-closed checks
(unsigned Twilio/WhatsApp webhooks, media streams without a signed token) so you
can test with `curl` and the call simulator.

### 4. Create and seed the local database

```bash
cd worker
npm run db:bootstrap:local   # schema.sql + seed data, then drizzle/ migrations
```

### 5. Start local dev server

```bash
cd worker
npm run dev
# → http://localhost:8787
curl http://localhost:8787/health          # liveness
curl "http://localhost:8787/health?deep=1" # also checks D1 + KV
```

Or run worker + web together from the repo root: `./dev.sh`.

### 6. Start the admin UI (optional)

```bash
cd web
cp .env.example .env.local   # VITE_API_URL only — never put secrets in VITE_*
npm run dev
# → http://localhost:5173
```

Admin tabs (Customize, WhatsApp) need the `ADMIN_SECRET` value: enter it in the
"Admin key" field in the header. It is kept in `sessionStorage` for the tab only.

---

## Checks

```bash
cd worker && npm run check   # tsc + vitest unit tests
cd web && npm run build      # tsc + vite build
```

CI (`.github/workflows/ci.yml`) runs these on every PR plus a `wrangler deploy --dry-run`
bundle. Pushes to `main` run CI, then deploy (`.github/workflows/deploy.yml`).

---

## Testing Voice Turns Locally

### Text-only turns (no audio, fastest)

```bash
curl -X POST http://localhost:8787/twilio/turn \
  -d "CallSid=test-call-001&SpeechResult=What+are+your+Saturday+hours"
```

The response is TwiML XML containing what Mogi would say.

### Full audio pipeline (STT → LLM → TTS)

```bash
cd worker
npm run simulate-call                         # 2s silence: connection + greeting
node scripts/simulate-call.mjs speech.wav     # real speech through the whole pipeline
```

The simulator speaks Twilio's Media Streams protocol to `/twilio/stream`. In production
the stream must carry the signed `streamToken` that `/twilio/inbound` puts in the TwiML,
so the simulator only works against a Worker running with `NODE_ENV=development`.

---

## Deploying

### Automatic (recommended)

Merging to `main` runs CI, applies D1 migrations, deploys the Worker, smoke-tests
`/health?deep=1`, then deploys the admin UI to Pages. Required repository secrets:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional repository variables:
`WORKER_URL` (default `https://mogi-platform.premkumar-2ba.workers.dev`) and
`PAGES_PROJECT` (default `mogi-admin`).

### Manual

```bash
./deploy.sh            # worker + web
./deploy.sh migrate    # D1 migrations only
```

### Production secrets (one-time)

The Worker **fails closed** in production: if a secret below is missing, the routes that
depend on it reject requests instead of running unauthenticated.

```bash
cd worker
wrangler secret put TOKEN_SECRET          # >= 32 random chars
wrangler secret put CUSTOMER_HASH_SALT    # random; don't rotate (re-keys every customer)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_SECRET          # X-Admin-Key for /admin/*
wrangler secret put TWILIO_AUTH_TOKEN     # Twilio console
wrangler secret put TWILIO_WEBHOOK_URL    # public base URL Twilio calls
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put CARTESIA_API_KEY
# WhatsApp: WA_APP_SECRET, WA_VERIFY_TOKEN, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN
```

### Database schema change

1. Edit `worker/src/db/schema.ts`
2. Generate a migration: `npm run db:generate`
3. Commit it — the deploy workflow applies it (`npm run db:migrate` to apply by hand)

---

## Adding a New Business Vertical

Use the built-in Claude Code skill:

```
/add-vertical
```

Sectors, vendors and products live in D1 and can be added without a deploy via the
admin API (`POST /admin/sectors`, `/admin/vendors`, `/admin/products`, all requiring
`X-Admin-Key`).

---

## Key Files

| File | Purpose |
|------|---------|
| `worker/src/config.ts` | Model id, Anthropic client timeouts, fail-closed secret helpers |
| `worker/src/routes/twilio.ts` | Twilio webhooks (signature-verified) and stream TwiML |
| `worker/src/durable-objects/call-relay.ts` | Per-call Durable Object: Deepgram STT → `runTurn()` → Cartesia TTS |
| `worker/src/services/turn.service.ts` | Voice agent loop (streaming, prompt caching) |
| `worker/src/services/tool-router.service.ts` | AI tool definitions (search, availability, booking) |
| `worker/src/routes/mogi.ts` | Browser voice-test API (`/mogi/*`) |
| `worker/src/routes/whatsapp.ts` | WhatsApp Cloud API webhook |
| `worker/src/db/schema.ts` | Drizzle ORM schema (D1/SQLite) |
| `worker/wrangler.toml` | Cloudflare bindings, vars, observability, secrets list |

---

## Operations

- **Logs:** Workers Logs is enabled (`[observability]` in `wrangler.toml`); live tail with
  `npx wrangler tail`. Unhandled errors are logged as JSON with a `requestId`, which is
  also returned to the client and in the `X-Request-Id` header.
- **Health:** point an uptime monitor at `/health?deep=1` (returns 503 if D1 or KV fail).
- **Cost guards:** per-IP/per-session KV rate limits on token minting, voice turns, STT/TTS
  proxies and transcript email; Anthropic calls time out after 20s with one retry.

### Voice latency tuning

Plain vars (set in `wrangler.toml`), not secrets. All optional — the defaults are
what ships.

| Var | Default | Effect |
|-----|---------|--------|
| `VOICE_MODEL` | `claude-haiku-5-5` | Overrides the model used on live calls only (`DEFAULT_VOICE_MODEL` in `src/config.ts`). `ANTHROPIC_MODEL` covers the other agent surfaces. |
| `DG_MODEL` | `nova-2` | Deepgram model. Try `nova-3` for lower finalization latency. |
| `DG_LANGUAGE` | `multi` | Set to `en` on an English-only deployment — faster than the multilingual model. |
| `VOICE_BARGE_IN_ON_VAD` | on | Set `0` to make barge-in wait for the first interim transcript instead of Deepgram's VAD event. Slower to react, but needs recognised words rather than any voice activity. |
| `VOICE_DIRECT_TOOL_REPLY` | on | Set `0` to always round-trip a tool result through Claude for paraphrasing instead of speaking the tool's own response. Costs one extra model call per tool turn. |
| `DG_DEBUG` | off | Set `1` to log every Deepgram Results/UtteranceEnd message. |

Watch the `⏱` lines in `npx wrangler tail`: `transcript-finalized` (STT),
`anthropic#N first-token`, `direct-tool-reply` (when the second model call is
skipped), `first-chunk-spoken` (finalized transcript → first audio out), and
`cache_read=` (prompt caching actually landing).
