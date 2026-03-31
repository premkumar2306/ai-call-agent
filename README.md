# Avery Platform

AI-powered voice assistant for multi-vertical businesses (auto shop, clinic, real estate). Customers call a phone number and talk to **Avery** — a voice agent that searches services, checks availability, and books appointments.

**Live phone number: +1 (312) 685-4305**

---

## Architecture

```
Caller → Twilio → Cloudflare Worker (Hono API)
                        ├── Anthropic Claude (voice AI)
                        ├── D1 Database (products, orders, transcripts)
                        └── KV Store (catalog cache, call history)

Browser → Cloudflare Pages (React admin UI)
```

| Folder | What it is |
|--------|-----------|
| `worker/` | Cloudflare Worker — API, AI logic, Twilio webhooks |
| `web/` | Cloudflare Pages — React admin dashboard |
| `.claude/commands/` | `/add-vertical` skill for Claude Code |

---

## Making a Call

1. Call **+1 (312) 685-4305**
2. Avery greets you and asks how she can help
3. Say what you need — e.g. *"What are your hours on Saturday?"* or *"I need an oil change"*
4. Avery searches services, checks availability, and can book an appointment

The call goes: Twilio → `/twilio/inbound` (greeting) → `/twilio/turn` (each spoken exchange).

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

Simulate a Twilio webhook call without an actual phone:

```bash
# Start inbound call
curl -X POST http://localhost:8787/twilio/inbound \
  -d "CallSid=test-call-001"

# Send a spoken turn
curl -X POST http://localhost:8787/twilio/turn \
  -d "CallSid=test-call-001&SpeechResult=What+are+your+Saturday+hours"
```

The response is TwiML XML containing what Avery would say.

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
