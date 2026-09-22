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
| `relay/` | Legacy Node.js media relay (Fly.io). No longer deployed — the Worker's `CallRelay` Durable Object replaced it. Kept only as an offline local-dev fallback (e.g. macOS `say` TTS with no API keys) and for its synthetic call-test harness (`relay/test/simulate-call.js`). |
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
cd uhg

# Install worker deps
cd worker && npm install

# Install web deps
cd ../web && npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Set secrets (one-time)

```bash
cd worker

wrangler secret put ANTHROPIC_API_KEY      # sk-ant-...
wrangler secret put TOKEN_SECRET           # any 32+ char random string
wrangler secret put CUSTOMER_HASH_SALT     # any random string
wrangler secret put AVERY_SECRET           # any random string
wrangler secret put TWILIO_AUTH_TOKEN      # from Twilio console
wrangler secret put DEEPGRAM_API_KEY       # speech-to-text for live calls
wrangler secret put CARTESIA_API_KEY       # text-to-speech for live calls
wrangler secret put CARTESIA_VOICE_ID      # optional — has a built-in default
```

### 4. Run the database migrations locally

```bash
cd worker
npm run db:migrate:local   # creates local D1 (SQLite)
```

Seed with products and services:

```bash
wrangler d1 execute avery-platform --local --file=./drizzle/0001_seed.sql
```

### 5. Start local dev server

```bash
cd worker
npm run dev
# → http://localhost:8787
```

Test the health endpoint:

```bash
curl http://localhost:8787/health
# → { "status": "ok", "sectors": ["auto_shop", "clinic", "real_estate"], "anthropic": true }
```

### 6. Start the admin UI (optional)

```bash
cd web
npm run dev
# → http://localhost:5173
```

---

## Testing Voice Turns Locally

### Text-only turns (no audio, fastest)

```bash
# Send a spoken turn straight to the LLM agent loop
curl -X POST http://localhost:8787/twilio/turn \
  -d "CallSid=test-call-001&SpeechResult=What+are+your+Saturday+hours"
```

The response is TwiML XML containing what Mogi would say.

### Full audio pipeline (STT → LLM → TTS), against a deployed Worker

`/twilio/inbound` now returns `<Connect><Stream>` TwiML (no spoken greeting on its own) —
the actual audio round-trip happens over the `/twilio/stream` WebSocket. Use the relay's
synthetic call simulator to exercise that path without a real phone call:

```bash
cd relay
RELAY_URL="wss://<your-worker>.workers.dev/twilio/stream?businessType=dental" \
  node test/simulate-call.js                # streams silence — tests connection + greeting
RELAY_URL="wss://<your-worker>.workers.dev/twilio/stream?businessType=dental" \
  node test/simulate-call.js path/to/speech.wav   # full STT → LLM → TTS round-trip
```

Received TTS audio is saved to `relay/test/received-<timestamp>.ul` (play with
`ffplay -f mulaw -ar 8000 -ac 1 <file>`).

---

## Deploying Changes

### Worker (API + AI)

```bash
cd worker
npm run type-check   # catch TypeScript errors first
npm run deploy       # wrangler deploy → avery-platform.premkumar-2ba.workers.dev
```

### Database schema change

1. Edit `worker/src/db/schema.ts`
2. Generate migration: `npm run db:generate`
3. Apply to production: `npm run db:migrate`

### Web (admin UI)

```bash
cd web
npm run build
npm run deploy       # wrangler pages deploy dist
```

---

## Adding a New Business Vertical

Use the built-in Claude Code skill:

```
/add-vertical
```

It will walk you through adding a new sector (e.g. `spa`, `gym`, `law_firm`) — collecting the business details, generating a voice-first service catalogue, and updating the codebase.

Manual steps if not using the skill:

1. Add entry to `SECTORS` in `worker/src/types.ts`
2. Append vendors + products to `worker/drizzle/0001_seed.sql`
3. Run `npm run db:seed` (local) or apply SQL to production D1
4. Deploy: `npm run deploy`

---

## Key Files

| File | Purpose |
|------|---------|
| `worker/src/routes/twilio.ts` | Twilio webhook handlers, call history, agentic loop |
| `worker/src/routes/avery.ts` | Web chat endpoint |
| `worker/src/services/tool-router.service.ts` | AI tool definitions (search, availability, booking) |
| `worker/src/types.ts` | `SECTORS` config — drives everything |
| `worker/src/db/schema.ts` | Drizzle ORM schema (D1/SQLite) |
| `worker/drizzle/0001_seed.sql` | Products and services for all verticals |
| `worker/wrangler.toml` | Cloudflare bindings (D1, KV, env vars) |

---

## Environment Variables

Set via `wrangler secret put` for production. See `worker/.env.example` for the full list.

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Powers Avery's AI responses |
| `TOKEN_SECRET` | Yes | Signs JWT session tokens |
| `CUSTOMER_HASH_SALT` | Yes | Hashes customer IDs for privacy |
| `AVERY_SECRET` | Yes | Service-to-service auth header |
| `TWILIO_AUTH_TOKEN` | Yes (prod) | Validates webhook signatures |
| `RESEND_API_KEY` | No | Sends booking confirmation emails |

# ai-call-agent
