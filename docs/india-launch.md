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
| A | [#68](https://github.com/premkumar2306/ai-call-agent/pull/68) | merged | live (off until configured) | Pick India in Settings → Country for an Indian business |
| G | [#69](https://github.com/premkumar2306/ai-call-agent/pull/69) | merged | live (off until configured) | Apply `worker/seeds/demo_clinic_india.sql` to try the demo clinic; live Indian-voice test calls need a Mac |
| D | [#70](https://github.com/premkumar2306/ai-call-agent/pull/70) | merged | live (off until configured) | Fill in `docs/privacy-notice-template.md` and publish it; set retention days and privacy URL in Settings. Disclosure has English, Hindi and Hinglish wording |
| C | [#71](https://github.com/premkumar2306/ai-call-agent/pull/71) | merged | live (off until configured) | Exotel account with KYC, an Indian number, the Voicebot flow and `EXOTEL_*` secrets; then add the number in Settings. Needs a live test call |
| B | [#72](https://github.com/premkumar2306/ai-call-agent/pull/72) | merged | live (off until configured) | Sarvam account and `SARVAM_API_KEY`; pick Hindi/Hinglish voice in Settings. Needs live test calls |
| E | [#73](https://github.com/premkumar2306/ai-call-agent/pull/73) | merged | live (off until configured) | `RESEND_API_KEY` and `EMAIL_FROM` for sign-in emails. After merging, switch the other PRs' routes to `withBusinessAccess` (list in #73) |
| F | [#74](https://github.com/premkumar2306/ai-call-agent/pull/74) | merged | live (off until configured) | Razorpay account, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, webhook URL; set a plan per business. Needs a test-mode run. End-to-end billing (dunning, plan changes, GST tax invoices) in #84: follow [razorpay-setup.md](razorpay-setup.md) |

All seven were merged on 10 Nov 2026, in the order A #68, G #69, D #70, C #71, B #72, E #73, F #74,
after testing them together (307 worker tests, web build, wrangler dry-run, every migration in merge
order). Each merge deployed to production. New behaviour stays off for a business until it is
configured: the US business is unchanged.

Fixes made while merging:
- one price formatter for clinic fees and the locale (written "₹500", spoken "500 rupees");
- one daily cron for the retention sweep and month-end billing;
- signup sets country/locale (explicit, or inferred from INR / Asia/Kolkata), so an Indian business
  gets +91 numbers and the DPDP notice;
- privacy, voice, doctors and billing routes accept a business owner's login as well as the admin key;
- usage records name the real carrier (Twilio, Exotel or Plivo), and cost estimates price Sarvam and Plivo.

## General app (clinics, dental, law firms; self-serve)

Branch `claude/multi-vertical`, migration `0018_multi_vertical.sql`: signup picks the call script from
the business type (fixes every signed-up business getting the auto-shop script), a `legal` vertical
for law firms and advocates, a neutral `appointments` vertical, owner-managed doctors/dentists/lawyers,
owner Settings, a phone-number request, D1 WhatsApp number routing, an optional default trial plan, and
a configurable assistant name (default Avery; `advanced_vtech` keeps Mogi).

Still to do by the owner: Sarvam, Exotel, Razorpay and Resend accounts and secrets; live test calls;
publishing the privacy notice.
