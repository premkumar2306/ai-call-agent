# Avery (DeskZen): notes for Claude sessions

AI phone + WhatsApp receptionist for clinics, dental practices and law firms (India first, US too).
Read this instead of re-reading the whole README.

## Stack
- `worker/`: Cloudflare Worker (Hono). Durable Object `CallRelay` runs calls. D1 (migrations in `worker/drizzle/`, numbered; use the next free number), KV.
- `web/`: React + Vite admin site on Cloudflare Pages (`avery-admin`).
- Carriers: Twilio (US), Exotel and Plivo (India). Speech: Deepgram, Sarvam (Indic); voice: Cartesia, Sarvam. AI: Anthropic.
- Merging to `main` deploys to production (CI → D1 migrations → wrangler deploy → smoke test → Pages).

## Checks before every non-WIP push
```
cd worker && npm run check && npm run e2e   # unit tests + simulated end-to-end calls
cd web && npm run build
```
The e2e simulator (`worker/e2e/`) mocks every outside service; it never runs in production.

## Rules
- New behaviour is off by default, per business. The existing US business must not change.
- No secrets in code, logs or responses. Secrets go in with `npx wrangler secret put`.
- Never send real messages, calls or emails to clinics or patients from a session.
- Never merge without the owner's explicit go-ahead.
- Small PRs, one concern each. Draft first; commit and push often.

## How to work (Karpathy-style)
- Think first: state the plan and assumptions in a few lines before editing.
- Simplest thing that works. No speculative abstractions or extra features.
- Surgical changes: touch only what the task needs; match the existing style.
- Goal-driven: define the check that proves it works (a test or e2e case), then make it pass.
- Report observed facts only; say plainly what is untested.

## Token budget (the owner hits usage limits)
- Workers run on Sonnet (`claude-sonnet-5-5`). The orchestrator runs on Opus and only plans, reviews risky changes (billing, signatures and security, migrations, merge order) and unblocks.
- If a Sonnet worker fails at the same thing twice, it stops and reports; the orchestrator decides whether that task moves to Opus.
- One fresh, short session per task. Read only the files you need; don't re-explore the repo.
- No automatic routines unless the owner asks for one.
- Keep reports short: PR number, what changed, what the owner must do.
