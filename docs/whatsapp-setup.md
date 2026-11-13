# WhatsApp setup (for clinic and law-firm owners in India)

Avery can answer your WhatsApp number the way it answers calls: it replies to questions,
books appointments, understands voice notes and replies in Hindi if your business uses Hindi.
This guide takes about an hour of your time, plus a few days of waiting for Meta to verify
your business.

You need:
- a laptop with Node.js 20 or newer, and this project checked out;
- a phone number for WhatsApp that is **not** already used in the WhatsApp or WhatsApp
  Business app (or that you are willing to move off it, see step 3);
- your business documents (step 1).

> **Never paste a token, secret or password into a chat, an email or a ticket**, including a
> chat with an AI assistant. You type them only into Meta's website and into the
> `npx wrangler secret put` prompt on your own computer.

---

## 1. Create a Meta Business portfolio and verify your business

1. Go to **business.facebook.com** and sign in with your personal Facebook account.
2. Create a **Business portfolio** (earlier called "Business Manager") with your business's
   legal name, your name and your business email.
3. Open **Settings → Business info → Business verification → Start verification**. Meta asks
   for your legal name, address, phone and website, then one or two documents that show the
   same legal name and address. In India, any of these usually work:
   - GST registration certificate;
   - Udyam (MSME) registration certificate;
   - Shop and Establishment certificate;
   - certificate of incorporation, or the partnership deed for a firm;
   - for a clinic: a clinical establishment registration; for an advocate's office: a Bar
     Council certificate together with a utility bill in the firm's name.
4. Meta confirms by email, phone or a code sent to your domain. Verification usually takes
   **1–5 working days**. You can do steps 2–4 while you wait; you can't go live or send more
   than a few messages until it's done.

Your website should show the same business name and address as your documents. A mismatch
is the most common reason for rejection.

## 2. Create the app and add WhatsApp

1. Go to **developers.facebook.com → My Apps → Create app**.
2. Choose **Other → Business** as the app type (the "Business" type is required for WhatsApp).
3. Give it a name, such as "Avery receptionist", and choose your business portfolio.
4. On the app dashboard, find **WhatsApp** and click **Set up**. Pick your business portfolio.
   Meta creates a **WhatsApp Business Account (WABA)** and a free test number.
5. Open **WhatsApp → API Setup** and note two ids:
   - **WhatsApp Business Account ID** (this is `WA_WABA_ID`);
   - later, your real number's **Phone number ID** (this is `WA_PHONE_NUMBER_ID`).
6. Open **App settings → Basic**, click **Show** next to **App secret**, and keep that page
   open for step 5. It's `WA_APP_SECRET`.

## 3. Add and verify your phone number

1. Open **WhatsApp Manager** (business.facebook.com → WhatsApp accounts) → **Phone numbers →
   Add phone number**.
2. Pick a number:
   - It must be able to receive an SMS or a voice call for the 6-digit code. A landline
     works with the voice-call option, and so does an Exotel number that can receive calls.
   - It must **not** be registered in the WhatsApp or WhatsApp Business app. If it is,
     either use another number, or delete that WhatsApp account first (in the app: Settings
     → Account → Delete account; chats are lost unless you back them up). Meta also offers
     an in-place move for WhatsApp Business app numbers ("coexistence"); if you see that option
     when adding the number, it keeps the app working on your phone as well.
3. **Display name**: the name customers see. It must match your business name, or a clear
   short form of it, as shown on your website or documents ("Smile Dental Clinic", not "Best
   Dentist Bangalore"). It can't be only a generic word, can't use all capitals unless that's
   your brand, and can't include a person's name unless it's part of the business name. Meta
   reviews it, usually within a day.
4. Enter the code you receive. Then set a **6-digit two-step verification PIN** when asked,
   and write it down. The setup script uses it if the number still shows as *Pending*.

## 4. Create a System User with a permanent token

The token from the API Setup page expires after 24 hours. Avery needs one that doesn't expire.

1. business.facebook.com → **Settings → Users → System users → Add**. Name it "avery", with
   role **Admin**.
2. **Assign assets**: add your **app** (Full control) and your **WhatsApp account** (Full control).
3. **Generate new token** → choose your app → **Token expiration: Never** → tick
   **whatsapp_business_messaging** and **whatsapp_business_management** → Generate.
4. Copy the token straight into step 5. Meta shows it only once. It starts with `EAA`. This is
   `WA_ACCESS_TOKEN`.

## 5. Put the four secrets into the Worker

On your computer, in the project folder:

```bash
cd worker
npx wrangler secret put WA_APP_SECRET       # paste the App secret from step 2.6
npx wrangler secret put WA_VERIFY_TOKEN     # type any random string, e.g. the output of: openssl rand -hex 16
npx wrangler secret put WA_ACCESS_TOKEN     # paste the System User token from step 4
npx wrangler secret put WA_PHONE_NUMBER_ID  # paste your number's Phone number ID (step 2.5)
```

Each command asks for the value; it is not shown on screen and is stored encrypted in Cloudflare.

For the setup script, create a file `worker/.env` (it's in `.gitignore`, so it's never
committed) with:

```
WA_ACCESS_TOKEN=EAA...            # the same token
WA_WABA_ID=1234567890             # WhatsApp Business Account ID (step 2.5)
WA_VERIFY_TOKEN=...               # the same random string as above
WORKER_URL=https://<your-worker>.workers.dev
ADMIN_KEY=...                     # the Worker's ADMIN_SECRET (only needed for --map)
```

## 6. Run the setup script

```bash
cd worker
npm run whatsapp-setup -- --dry-run        # check everything, change nothing
npm run whatsapp-setup                     # do it
```

It:
1. checks the token and lists your numbers with their **phone_number_id**, display number,
   verified name, quality rating and status;
2. subscribes your app to your WhatsApp Business Account, so messages reach your app;
3. prints the **Callback URL** for Meta, `https://<your-worker>/whatsapp/webhook`, and checks
   that the Worker answers Meta's verification with your verify token;
4. maps the number to a business (`--map <business_key>`);
5. sends you a test message (`--test-to <your WhatsApp number>`).

It never prints your token. The verify token is shown masked unless you add
`--show-verify-token`. Running it again is safe. If a number shows **PENDING**, add
`--register-pin <your 6-digit PIN>`. With several numbers, pick one with `--phone-number-id <id>`.

Then, in **developers.facebook.com → your app → WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL**: the URL the script printed;
- **Verify token**: your `WA_VERIFY_TOKEN`;
- click **Verify and save**, then under **Webhook fields** click **Subscribe** next to **messages**.

Finally, switch the app to **Live** (the toggle at the top of the app dashboard; it needs a
privacy policy URL in App settings → Basic). In Development mode Meta only delivers messages
from people listed as testers.

## 7. Map the number to your business

If you didn't use `--map`, open the app as the operator: **Operator → WhatsApp** (`#/op/whatsapp`),
add the **phone_number_id** and choose the business. Each WhatsApp number answers for exactly one
business. A message to a number that isn't mapped gets no reply, so one clinic's number never
answers as another's.

Avery replies in the business's language from **Settings → Voice**: English, Hindi (हिंदी,
Devanagari) or Hinglish. Voice notes are transcribed in that language too.

## 8. Send a test message

```bash
npm run whatsapp-setup -- --test-to "+91 98450 12345"
```

You receive Meta's **hello_world** template. Reply "Hi, I'd like to book an appointment":
- for an Indian business, the first reply is the AI/privacy notice (sent once per customer),
  then the answer;
- book a slot, and check the booking appears in the Calls tab.

Why a template? See the next step.

## 9. Templates, reminders and missed-call follow-ups

WhatsApp allows **free-form messages only within 24 hours of the customer's last message**
(the "customer service window"). Avery's chat replies are always inside it. Anything Avery
starts itself (a reminder the day before, a "we missed your call" message, a confirmation for a
booking made on a **phone call**) has to be an **approved template**. Avery manages these for
you from the admin UI.

### 9.1 Give the Worker your WhatsApp Business Account id

WhatsApp Manager → **Account tools** (or Business settings → Accounts → WhatsApp accounts): copy
the **WhatsApp Business Account ID** (the same number as `WA_WABA_ID` in step 5), then:

```bash
npx wrangler secret put WA_BUSINESS_ACCOUNT_ID
npx wrangler secret put ADMIN_NOTIFY_EMAIL     # optional: where number-quality alerts go
```

The System User token from step 4 already has `whatsapp_business_management`, which is what
creating templates needs.

### 9.2 Subscribe the webhook to template and quality updates

Meta → your app → WhatsApp → **Configuration** → Webhook fields: besides `messages`, subscribe
**`message_template_status_update`** (approvals arrive in seconds instead of on the next sync)
and **`phone_number_quality_update`** (quality drops are picked up at once).

### 9.3 Create the templates (Operator → WhatsApp → Message templates)

For each event, press **Create Avery's template**. It sends one **Utility** template to Meta in
three languages:

| Event | Template name | Languages |
|---|---|---|
| Booking confirmation | `avery_booking_confirmation` | `en`, `hi`, and `avery_booking_confirmation_hinglish` in `en` |
| Reminder, 24 hours before | `avery_appointment_reminder` | same pattern |
| Cancellation | `avery_booking_cancellation` | same pattern |
| Missed call: "reply here" | `avery_missed_call` | same pattern |

Hinglish is written in Latin script and Meta has no language code for it, so it is a separate
template name in English. Every body names the business, says what it's about, and ends with
"Reply STOP to opt out" (in Hindi: "मैसेज बंद करने के लिए STOP लिखें"). You can see the
wording under **Wording**, or create your own with **Create a custom template** (Avery checks
Meta's rules first: no parameter at the very start or end, parameters numbered in order, an
opt-out line).

The status of each language shows as **pending**, **approved** or **rejected** (hover a rejected
one for Meta's reason). **Sync from Meta** refreshes them all. Utility templates are usually
approved within minutes. Meta may decide one is really **marketing**. A missed-call message is
the likeliest. If that happens, it no longer shows as approved, so Avery stops using it.

### 9.4 Choose which template each event uses

Pick the template in each event's dropdown. Avery then sends the approved variant in the
business's language (Settings → Voice), or the English one if that language isn't approved yet.
Until an event has a chosen, approved template:

| Event | Without an approved template |
|---|---|
| Booking confirmation / cancellation | SMS, exactly as before (and the legacy `WA_CONFIRMATION_TEMPLATE`, if set) |
| Reminder | SMS if Twilio SMS is set up, otherwise skipped and logged |
| Missed-call follow-up | skipped and logged (`[wa:missed_call:…]` in `wrangler tail`) |

Once a confirmation/cancellation template is chosen, a customer gets it on WhatsApp **instead
of** SMS, with SMS as the fallback if WhatsApp can't be used (no number, not approved, or sending fails).

### 9.5 Owners turn reminders and follow-ups on (Settings → WhatsApp)

Both are **off** for every business until its owner (or the operator) turns them on:

- **Appointment reminders.** An hourly job sends one reminder per booking, 23–24 hours before
  it. A missed hour is caught up by the next, up to 2 hours before the appointment. Bookings
  made less than 12 hours ahead get none: they just got a confirmation. Each booking is marked
  before it is sent, so it is never reminded twice.
- **Missed-call follow-up.** When a caller hangs up before saying anything, the call is cut short
  (their last words went unanswered, or it lasted under 20 seconds), or the assistant took a
  message, the caller gets the `avery_missed_call` template inviting them to continue on
  WhatsApp. It is never sent after a booking or a transfer to staff, and at most once per caller
  per business every 7 days.

The page also shows the business's WhatsApp number (read-only) and a preview of each message in
the business's language.

### 9.6 Opt-out and consent (Meta's rules for business-initiated messages)

- **STOP is honoured everywhere.** `STOP`, `Unsubscribe`, `End`, `Quit`, `Opt out`, and in
  Hindi/Hinglish `बंद`, `बंद करो`, `बंद करें`, `मत भेजो`, `रोको`, `band karo`, `mat bhejo`,
  and similar, record an opt-out for that business. No reminder, follow-up or confirmation goes
  to that customer again, **on WhatsApp or by SMS**, until they send `START` (or `शुरू`).
  If they keep chatting, Avery still answers: they wrote first. "Cancel" on its own is *not* an
  opt-out, because after a reminder it means "cancel my appointment".
- **Consent records.** Every opt-in and opt-out is kept in `messaging_consent` (business,
  hashed customer number, action, source such as `keyword:STOP` or `whatsapp_inbound`, time).
  A customer's first WhatsApp message is their opt-in. Opt-out records are kept even after a
  data erasure request, because the suppression record is what keeps honouring the STOP.
- **Who may get one.** Meta requires an opt-in before you message someone first. Reminders
  and confirmations go only to the number a booking was made with. Missed-call follow-ups go to
  people who called you. Owners are asked to tell callers they may get WhatsApp messages about
  their booking, for example in the call greeting or the privacy notice (Settings → Privacy).
- **Templates only** outside the 24-hour window. Inside it, the same wording goes as a
  free-form message, which Meta doesn't charge for.

### 9.7 Number health (Operator → WhatsApp and Operator → Integrations)

For each mapped number, the **WhatsApp number health** card shows the following, refreshed
hourly and by **Refresh**:

- Meta's **quality rating** (High / Medium / Low);
- the **daily messaging limit** (250, 1,000, 10,000 … business-initiated conversations a day);
- the **display-name status** and **verified name**;
- when the webhook last delivered a customer message;
- each event's template statuses.

When a number drops to **Medium (yellow)** or **Low (red)**, the operator gets one email at
`ADMIN_NOTIFY_EMAIL` per drop. A number that recovers to green and drops again alerts again. If
quality is falling, turn off missed-call follow-ups first: they are the likeliest to be reported.

## 10. What it costs

Meta charges **per delivered template message** (since 1 July 2025), by category and by the
customer's country. Your own WhatsApp number and the Cloud API itself are free.

| What | Who starts it | Meta's charge |
|------|---------------|---------------|
| Avery's replies to a customer's message (service messages) | the customer | **Free** |
| Utility template (confirmation, reminder, cancellation, missed-call follow-up) sent while the 24-hour window is open | you | Free, under the July 2025 rules |
| Utility template outside the window | you | about **₹0.12–0.15** per message |
| Authentication template (OTP) | you | about **₹0.12–0.15** per message |
| Marketing template (offers, reminders to come back) | you | about **₹0.86–1.09** per message (Avery doesn't send these) |

These rupee figures are approximate. They come from Indian WhatsApp partners' 2026 summaries,
and those summaries disagree with each other because Meta changed some India rates during 2026.
Meta's own page is the only authority: **[Pricing on the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing)**
(rate cards per market, in INR). Check it before you budget; your WhatsApp Manager → **Insights**
shows what you actually paid. GST is added on Meta's invoice. Avery separately counts WhatsApp
conversations and AI usage per business in Billing; your Avery plan doesn't charge for them today.

## 11. Troubleshooting

**"Webhook not verified" / "The callback URL or verify token couldn't be validated."**
- The Callback URL must be exactly `https://<your-worker>/whatsapp/webhook`, using https and with no trailing slash.
- The verify token in Meta must equal `WA_VERIFY_TOKEN` in the Worker. Run
  `npm run whatsapp-setup -- --dry-run`: step 3 tells you which side is wrong. To reset, run
  `npx wrangler secret put WA_VERIFY_TOKEN`, then update `worker/.env` and Meta with the same value.

**Error 401 / code 190, "token expired" or "Session has expired".**
You used the 24-hour token from API Setup. Create a System User token with **Never** expiry
(step 4) and run `npx wrangler secret put WA_ACCESS_TOKEN` again. If the token was ever
pasted somewhere public, delete it in System users → Revoke, then make a new one.

**Messages don't arrive (no reply, nothing in the logs).**
- In Meta → WhatsApp → Configuration, check the **messages** field is subscribed.
- Run the script without `--dry-run`, so the app is subscribed to your WhatsApp account (step 2 of its output).
- Check the app is **Live**, not in Development mode.
- Check the number is mapped to a business (Operator → WhatsApp). Unmapped numbers get no reply.
- Check the Worker's logs with `npx wrangler tail`. Lines start with `[wa]`. An "unmapped
  phone_number_id" line means step 7 is missing; `WA_APP_SECRET not set` or a 403 means
  `WA_APP_SECRET` is wrong. It must be the **App secret** of the same app.

**The number shows "Pending" or "Not registered", or sending fails with code 133010.**
Run `npm run whatsapp-setup -- --register-pin <your 6-digit PIN>`. If you forgot the PIN,
reset it in WhatsApp Manager → Phone numbers → Settings → Two-step verification.

**The display name was rejected.** Edit it in WhatsApp Manager to match your legal or
website name (step 3.3), then resubmit.

**The test message fails with code 131030.** The app is still in Development mode and your
number isn't on the allowed list. Add it under WhatsApp → API Setup → To, or switch the app to Live.

**A customer gets no reply after a long gap.** Avery doesn't answer a message that reached it
more than 24 hours late (Meta would refuse a free-form reply). Ask the customer to message again.
