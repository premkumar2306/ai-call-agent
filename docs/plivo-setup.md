# Plivo set-up (Indian numbers)

Plivo is the second Indian carrier, next to Exotel. A call goes like this:

1. Plivo POSTs the call to the Application's **Answer URL**, `https://<worker>/plivo/answer`.
   The Worker checks the `X-Plivo-Signature-V3` signature, finds the business for the called
   number and returns a bidirectional `<Stream>` (µ-law 8 kHz) to `/plivo/stream`.
2. The assistant talks to the caller over that stream. Indian businesses hear the AI and
   recording notice (DPDP) first, in the line's language. Hindi lines use Sarvam.
3. When the stream ends, Plivo follows the `<Redirect>` to `/plivo/after-stream`. If the caller
   asked for a person, the Worker dials the business's staff phone, using your Plivo number as
   the caller ID. Otherwise it hangs up. `/plivo/after-dial` apologises only if nobody answered.
4. Plivo POSTs the **Hangup URL**, `https://<worker>/plivo/hangup`. Usage (provider `plivo`, with
   its cost) and the transcript are saved when the stream closes, even if the caller hangs up
   early.

## Settings

| Setting | Kind | Needed | What breaks without it |
|---|---|---|---|
| `PLIVO_AUTH_TOKEN` | secret | yes | Signatures can't be checked, so production rejects every Plivo webhook with 403. |
| `PLIVO_WEBHOOK_URL` | secret | yes | The public base URL Plivo calls, e.g. `https://mogi-platform.<acct>.workers.dev`, with no trailing path. Production rejects every webhook without it. If it differs from the URL in the Plivo Application, the signature doesn't match and every call gets a 403. |
| `PLIVO_AUTH_ID` | secret | for checks | The Integrations check and `npm run plivo:verify` can't read the account. Calls still work. |
| `PLIVO_DEFAULT_BUSINESS_TYPE` | plain var | optional | Callers to a Plivo number that isn't mapped in Settings hear "This line is not configured" and the call ends. |
| `SARVAM_API_KEY` | secret | Hindi lines | A Hindi line refuses to start rather than fall back to English. |
| `NODE_ENV = "production"` | plain var | yes | Outside production, unsigned webhooks are accepted (for local testing). |

## 1. Plivo account and KYC

1. Sign up at [console.plivo.com](https://console.plivo.com/) and add credit.
2. Indian numbers need KYC. In the console, go to **Phone Numbers → Compliance** (or **Address &
   Identity**) and upload the business's documents: GST certificate or company registration,
   plus an authorised signatory's ID and address proof. Approval usually takes 1 to 3 working
   days, and you can't buy an Indian number until it's done.
3. Copy the **Auth ID** and **Auth Token** from the console's overview page.

## 2. Buy or verify a number

- **Buy:** go to **Phone Numbers → Buy Numbers**, choose country India, and pick a voice-enabled
  number (an 080/022 landline or a toll-free number).
- **Port or verify:** if you already have a number with another carrier, ask Plivo support to
  port it. Only numbers in your Plivo account can be routed to Avery.

## 3. Create the Plivo Application

Go to **Voice → Applications → Add New Application**, and set:

| Field | Value |
|---|---|
| Application name | `Avery` |
| Answer URL | `https://<worker>/plivo/answer`, method **POST** |
| Hangup URL | `https://<worker>/plivo/hangup`, method **POST** |

`<worker>` must be exactly what you set as `PLIVO_WEBHOOK_URL`: the same scheme and host, with no
trailing slash. Then go to **Phone Numbers → Your Numbers → (the number)**, set Application Type
to **XML Application**, and choose `Avery`.

## 4. Set the secrets

From `worker/`:

```sh
npx wrangler secret put PLIVO_AUTH_ID       # Auth ID from the console
npx wrangler secret put PLIVO_AUTH_TOKEN    # Auth Token from the console
npx wrangler secret put PLIVO_WEBHOOK_URL   # https://<worker>, no trailing slash
```

`PLIVO_DEFAULT_BUSINESS_TYPE` is optional. It's a plain var in `wrangler.toml` `[vars]`.

## 5. Map the number in Avery

Go to **Operator → Phone numbers** and add the number. Enter it (for example
`+918047100001`), choose provider **Plivo**, and pick the business. For a Hindi line, also open
**Settings → Voice** and choose Hindi with Sarvam for both speech recognition and voice.

## 6. Run the live check

From `worker/`:

```sh
WORKER_URL=https://<worker> ADMIN_KEY=<admin key> npm run plivo:verify
```

The check:

- runs the Plivo account check with the real keys;
- confirms that `PLIVO_WEBHOOK_URL` matches `WORKER_URL`;
- lists every number in the Plivo account, with its Application's answer and hangup URLs;
- flags any number whose answer URL isn't `<WORKER_URL>/plivo/answer`, and gives the exact fix;
- shows which Avery business each number reaches;
- sends one unsigned request to `/plivo/answer` and confirms that it's rejected with 403.

It prints a ✓ / ✗ checklist with next actions, and exits 0 only when everything passes. It is
read-only: it never prints a secret, places a call or spends money. It uses the operator
endpoint `GET /admin/plivo/verify`, which takes the admin key, is limited to 6 runs a minute,
and redacts its output.

## 7. Live test calls

Use a test business first. Set its country to India, add a service, and put your own mobile as
the staff phone. Then make each call below and check the result.

**English line**

- [ ] You hear "Thanks for calling", then the AI/recording notice, then the greeting.
- [ ] The audio is clear and plays at normal speed.
- [ ] Book: say "I'd like to book an appointment", then pick a time. The booking appears in the
      Calls tab.
- [ ] Cancel: call again and say "cancel my appointment". The booking is cancelled.
- [ ] Transfer: say "Can I speak to someone?". Your staff phone rings and shows the Plivo number
      as the caller. Answer it, talk, and hang up: the call ends with no apology. Repeat without
      answering: the caller hears "Sorry, nobody was able to pick up".
- [ ] Hang up early, in the middle of the assistant's sentence. The call still appears in the
      Calls tab with its transcript.

**Hindi line** (Sarvam)

- [ ] The notice and greeting are in Hindi, and a Hinglish request ("mujhe kal appointment book
      karna hai") books correctly.
- [ ] Cancel, transfer and hang up early behave the same as on the English line.

**After each call**

- [ ] The call record and transcript are in the **Calls** tab.
- [ ] Usage shows the call with provider `plivo` and a cost (**Admin → Billing**, or
      `GET /admin/billing/usage/<business>`).
- [ ] **Admin → Privacy → notices** shows the notice with `heard_fully = 1`.
- [ ] In the Plivo console, open **Logs → Calls → (the call)**. The Answer and Hangup callbacks
      both returned 200, and there's no 403. A 403 means `PLIVO_WEBHOOK_URL` doesn't match the
      Application URL.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Plivo's call log shows 403 on the Answer URL | `PLIVO_WEBHOOK_URL` or `PLIVO_AUTH_TOKEN` is wrong | Run `npm run plivo:verify` and fix what it flags |
| "This line is not configured" | The number isn't mapped | Operator → Phone numbers, provider Plivo |
| Transfer rings nobody | No staff phone set, or the caller ID is rejected | Set the staff phone, and check that the number is a voice-enabled Plivo number |
| Silence after the greeting on a Hindi line | `SARVAM_API_KEY` is missing | `npx wrangler secret put SARVAM_API_KEY` |
