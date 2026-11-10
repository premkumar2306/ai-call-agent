# India launch: workstreams

Each workstream is its own branch and draft PR, built by its own Claude Code session.
Merging to `main` deploys to production, so every change must leave current behaviour
(the US `advanced_vtech` business, English, Twilio) exactly as it is unless a business
is configured to use the new feature.

| # | Workstream | Branch | Migration file | Owns |
|---|-----------|--------|----------------|------|
| A | Locale: ₹, `Asia/Kolkata`, +91, Indian date/number formats per business | `claude/india-locale` | `0011_*.sql` | `sectors` locale/currency columns, price/phone/date formatting |
| B | Hindi + Hinglish voice (STT/TTS providers, language per business) | `claude/india-indic-voice` | `0012_*.sql` | STT/TTS provider adapters, voice language config, prompt language rules |
| C | Indian phone numbers (Exotel stream adapter, number → business routing) | `claude/india-telephony` | `0013_*.sql` | telephony adapter layer, Exotel routes |
| D | DPDP compliance (AI + recording disclosure, privacy notice, data deletion, retention) | `claude/india-compliance` | `0014_*.sql` | disclosure, deletion/export endpoints, retention cron |
| E | Multi-tenant self-serve signup and per-business login | `claude/india-multitenant` | `0015_*.sql` | owner accounts, business-scoped auth, onboarding wizard |
| F | Billing: Razorpay subscriptions + per-minute usage metering with GST fields | `claude/india-billing` | `0016_*.sql` | plans, usage records, Razorpay webhook |
| G | Clinic vertical + Indian-accent / Hinglish synthetic test callers | `claude/india-clinic-svt` | `0017_*.sql` (only if needed) | clinic template seed, `svt/` personas |

## Rules for every workstream

- Use only your assigned migration number, so migrations never collide.
- New behaviour is off by default and switched on per business (a `sectors` column or config).
- No secrets in code. New secrets go in `wrangler.toml` comments, `.dev.vars.example`
  and the README secrets list; the Worker fails closed without them, as it does today.
- `cd worker && npm run check` and `cd web && npm run build` pass before every push.
- Add unit tests for new logic; update the README section your change affects.
- When another workstream's PR merges first, rebase onto `main` and resolve conflicts.

## Status

Workstreams run one at a time, in the order A, G, D, C, B, E, F, to stay within the account's usage limit.

| # | PR | CI | State | Owner must configure |
|---|----|----|-------|----------------------|
| A | [#68](https://github.com/premkumar2306/ai-call-agent/pull/68) | green | done, ready for review | Pick India in Settings → Country for an Indian business |
| G | [#69](https://github.com/premkumar2306/ai-call-agent/pull/69) | green | done, ready for review | Apply `worker/seeds/demo_clinic_india.sql` to try the demo clinic; live Indian-voice test calls need a Mac |
| D | [#70](https://github.com/premkumar2306/ai-call-agent/pull/70) | green | done, ready for review | Fill in `docs/privacy-notice-template.md` and publish it; set retention days and privacy URL in Settings. Disclosure has English, Hindi and Hinglish wording |
| C | [#71](https://github.com/premkumar2306/ai-call-agent/pull/71) | green | done, ready for review | Exotel account with KYC, an Indian number, the Voicebot flow and `EXOTEL_*` secrets; then add the number in Settings. Needs a live test call |
| B | [#72](https://github.com/premkumar2306/ai-call-agent/pull/72) | green | done, ready for review | Sarvam account and `SARVAM_API_KEY`; pick Hindi/Hinglish voice in Settings. Needs live test calls |
| E | [#73](https://github.com/premkumar2306/ai-call-agent/pull/73) | green | done, ready for review | `RESEND_API_KEY` and `EMAIL_FROM` for sign-in emails. After merging, switch the other PRs' routes to `withBusinessAccess` (list in #73) |
| F | [#74](https://github.com/premkumar2306/ai-call-agent/pull/74) | green | done, ready for review | Razorpay account, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, webhook URL; set a plan per business. Needs a test-mode run |

All seven workstreams are complete. Merge in this order: #68, #69, #70, #71, #72, #73, #74.
Each PR's description lists the conflicts to expect when it merges after the earlier ones.
