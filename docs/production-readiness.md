# Production readiness

Every outside service Avery uses, what it needs, and the order to set them up. The same list
lives in the Worker (`worker/src/services/integrations.ts`) and drives:

- **Operator → Integrations** in the admin UI: a card per service (Not set up / Set up — not
  checked / Working / Failing), a **Check now** button, and a production-readiness score with
  blockers listed first.
- `GET /admin/integrations` and `POST /admin/integrations/:id/check` (admin key). They return
  booleans per setting name and redacted check results; secret values never leave the Worker.
- `npm run preflight` (below): the go-live checklist from your terminal.

Each live check is read-only and free: it lists or fetches something with the configured key.
None sends a message, places a call or charges money.

## Services

Set up in this order. **Required** services block go-live, and so does having no phone carrier.

| # | Service | Needed for | Required? | Secrets (`wrangler secret put`) | Plain vars (`wrangler.toml`) | Where to get them | Cost model | Live check |
|---|---|---|---|---|---|---|---|---|
| 1 | <a id="cloudflare"></a>Cloudflare D1 and KV | Database and cache | Required | — | `DB`, `CACHE` bindings | [Cloudflare dashboard](https://dash.cloudflare.com/) | Workers paid plan, ~$5/month base plus usage | `SELECT 1`, KV read |
| 2 | <a id="avery-secrets"></a>Avery secrets | Sign-in tokens, caller hashing, operator key | Required | `TOKEN_SECRET` (32+ chars), `CUSTOMER_HASH_SALT`, `ADMIN_SECRET`; optional `MOGI_SECRET` | — | Generate: `openssl rand -hex 32` | Free | `TOKEN_SECRET` length |
| 3 | <a id="resend"></a>Resend | Email: sign-in codes, booking and billing notifications | Required | `RESEND_API_KEY` | `EMAIL_FROM`; optional `ADMIN_NOTIFY_EMAIL` | [resend.com/api-keys](https://resend.com/api-keys); verify your sending domain | Free up to 3,000 emails/month, then monthly plans | `GET /domains` (a sending-only key also passes) |
| 4 | <a id="anthropic"></a>Anthropic | The AI on calls and WhatsApp | Required | `ANTHROPIC_API_KEY` | optional `ANTHROPIC_MODEL`, `VOICE_MODEL` | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Per token | `GET /v1/models` |
| 5 | <a id="deepgram"></a>Deepgram | Speech recognition (English calls, voice notes) | Required | `DEEPGRAM_API_KEY` | optional `DG_*` tuning | [console.deepgram.com](https://console.deepgram.com/) | Per audio minute | `GET /v1/projects` |
| 6 | <a id="cartesia"></a>Cartesia | The assistant's voice (English calls) | Required | `CARTESIA_API_KEY` | optional `CARTESIA_VOICE_ID`, `CARTESIA_MODEL_ID` | [play.cartesia.ai/keys](https://play.cartesia.ai/keys) | Per character spoken | `GET /voices` |
| 7 | <a id="twilio"></a>Twilio | US numbers, booking texts | One carrier required | `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID` | `TWILIO_WEBHOOK_URL`, `TWILIO_SMS_FROM` | [console.twilio.com](https://console.twilio.com/) | Number rental + per minute + per text | `GET /Accounts/{sid}` (needs `TWILIO_ACCOUNT_SID`) |
| 7 | <a id="exotel"></a>Exotel | Indian numbers (ExoPhones) | One carrier required | `EXOTEL_WEBHOOK_SECRET`; for the check: `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` | optional `EXOTEL_SUBDOMAIN` (`api.in.exotel.com` for the Mumbai cluster) | [Exotel API settings](https://my.exotel.com/apisettings/site#api-credentials) | Number rental + per minute | `GET /v1/Accounts/{sid}/Calls.json?PageSize=1` |
| 7 | <a id="plivo"></a>Plivo | Indian numbers | One carrier required | `PLIVO_AUTH_TOKEN`; for the check: `PLIVO_AUTH_ID` | `PLIVO_WEBHOOK_URL` | [console.plivo.com](https://console.plivo.com/dashboard/) | Number rental + per minute | `GET /v1/Account/{id}/` |
| 8 | <a id="sarvam"></a>Sarvam | Hindi and Hinglish calls | Optional | `SARVAM_API_KEY` | optional `SARVAM_*` models | [dashboard.sarvam.ai](https://dashboard.sarvam.ai/) | Per audio minute and per character | An empty TTS request: a valid key gets a validation error, nothing is synthesised |
| 9 | <a id="razorpay"></a>Razorpay | Billing: subscriptions, payments, GST invoices | Optional | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | `BILLING_SUPPLIER_GSTIN`, `BILLING_SUPPLIER_NAME`, `BILLING_SUPPLIER_ADDRESS`, `BILLING_SAC_CODE`, `APP_URL` | [Razorpay API keys](https://dashboard.razorpay.com/app/website-app-settings/api-keys) — see [razorpay-setup.md](razorpay-setup.md) | ~2% per payment | `GET /v1/plans?count=1` |
| 10 | <a id="meta-whatsapp"></a>Meta WhatsApp | The assistant on WhatsApp | Optional | `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_ACCESS_TOKEN`; optional `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID` (templates) | optional `WA_CONFIRMATION_TEMPLATE` (legacy), `WA_TEMPLATE_LANGUAGE`, `WA_GRAPH_API_VERSION` | [WhatsApp Manager](https://business.facebook.com/wa/manage/) — see [whatsapp-setup.md](whatsapp-setup.md) | Per conversation (Meta pricing) | `GET /{phone-number-id}` |
| 11 | <a id="google-calendar"></a>Google Calendar | Bookings in the business's calendar | Optional | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALENDAR_TOKEN_KEY` | — | [Google Cloud credentials](https://console.cloud.google.com/apis/credentials) (Web application client, Calendar API on, redirect `https://<worker>/oauth/google/callback`) | Free | Token exchange with a dummy refresh token: `invalid_grant` means the client is right |

Owners never see setting names. Where a feature depends on an optional service that isn't set
up (Hindi, Google Calendar, WhatsApp, online payment), their Settings show a calm "not available
yet" note instead.

## Go-live steps

1. Set every secret in the table, in order (`cd worker && npx wrangler secret put NAME`), and
   the plain vars in `wrangler.toml`. Never put a secret in `wrangler.toml`.
2. Deploy (merge to `main`, or `npm run deploy`).
3. Run the preflight from `worker/`:

   ```sh
   WORKER_URL=https://<your-worker> ADMIN_KEY=<admin key> npm run preflight
   ```

   It lists the deployed secrets by name (`wrangler secret list`), runs every live check through
   `/admin/integrations`, and prints a ✓ / ✗ checklist with the next action for each service.
   It exits 0 only when every blocker is Working. It never prints a secret value.
   Add `--no-check` to report without running the checks.
4. Open **Operator → Integrations** in the admin UI and confirm the score is 100%.
5. Do the live tests in [live-test-checklist.md](live-test-checklist.md): one real call per
   carrier, WhatsApp, and a billing round trip.
6. Set up [WhatsApp](whatsapp-setup.md) and [Razorpay](razorpay-setup.md) when you need them;
   they are optional for go-live.

## Scheduled jobs (Cron Triggers)

`worker/wrangler.toml` has two triggers; `scheduled()` in `worker/src/index.ts` tells them apart
by the cron string.

| Cron (UTC) | Jobs | Safe to re-run? |
|---|---|---|
| `47 20 * * *` (daily, 02:17 IST) | data-retention sweep, month-end overage billing, dunning notices | Yes: each is idempotent |
| `17 * * * *` (hourly) | WhatsApp appointment reminders (2–24 h ahead, for businesses that turned them on), WhatsApp number health and quality alerts | Yes: each booking is claimed before its reminder is sent; alerts go once per drop |

The hourly trigger exists because reminders have to go out about 24 hours before each
appointment, and appointments start at any hour. With nothing turned on it does one D1 query and,
if WhatsApp is set up, one Graph read per mapped number. To run the reminders by hand: **Operator →
WhatsApp → Send due reminders now** (or `POST /admin/whatsapp/reminders/run`). Outside
production, that endpoint also takes `{ "now": "<ISO time>" }` so the e2e simulator can fake
the clock.

## WhatsApp at scale

- Templates, event choices, number health: **Operator → WhatsApp** (see
  [whatsapp-setup.md §9](whatsapp-setup.md#9-templates-reminders-and-missed-call-follow-ups)).
  The health card also sits under **Operator → Integrations**.
- Per business: **Settings → WhatsApp** (owners) turns reminders and missed-call follow-ups on.
  Both are off by default.
- Limits: each reminder run handles up to 200 bookings; more are picked up the next hour (the
  2–24 h window allows catch-up). Meta's own daily limit per number is shown as the tier in
  number health; a new number starts at 250 business-initiated conversations a day.
- Alerts: set `ADMIN_NOTIFY_EMAIL` to be emailed when a number's quality drops to yellow or red.
