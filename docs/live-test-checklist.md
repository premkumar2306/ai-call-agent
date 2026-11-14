# First live calls: checklist

The e2e simulator (`cd worker && npm run e2e`) checks the Worker's side of every protocol on each
PR. These checks need a real account and a real phone, once per provider, after its keys are set.
Do them on a test business first, not a customer's line.

Before you start, in Settings set the test business's country to **India**, add one service, and
set your own mobile as the staff phone.

## Exotel (Indian number)
1. Create the Exotel flow from the README: Voicebot applet → `https://<worker>/exotel/voicebot`,
   then Passthru → `/exotel/after-stream`, then Connect → `/exotel/connect`.
2. Map the ExoPhone to the test business in Settings → Phone numbers.
3. Call it. You should hear "Thanks for calling", then the AI/recording notice, then the greeting.
   - [ ] The voice is clear, at normal speed, with no crackle. Crackle or chipmunk audio means a
     sample-rate mismatch; remove any `?sample-rate=` from the stream URL.
   - [ ] Interrupting mid-sentence stops the assistant.
   - [ ] "I'd like to book an appointment" → offered times → pick one → booked. The booking shows
     in the Calls tab.
   - [ ] "Can I speak to someone?" → your staff phone rings.
   - [ ] Admin → Privacy → notices shows the call with `heard_fully = 1`.

## Plivo (alternative Indian number)
Follow [plivo-setup.md](plivo-setup.md). The Application's Answer URL is
`https://<worker>/plivo/answer` and its Hangup URL is `/plivo/hangup`, both POST.
`PLIVO_WEBHOOK_URL` must be exactly `https://<worker>`: a wrong value gives a 403, because the
signature won't match. Run `npm run plivo:verify` first, then make the English and Hindi calls in
plivo-setup.md §7: book, cancel, transfer, and hang up early.

## Sarvam (Hindi / Hinglish)
1. Set `SARVAM_API_KEY`. In Settings → Voice, pick Hindi with Sarvam for speech recognition and voice.
2. Call and speak Hindi.
   - [ ] The notice and greeting are in Hindi, and the voice sounds natural.
   - [ ] "मुझे अपॉइंटमेंट बुक करना है" leads to a booking.
   - [ ] "क्या मैं किसी से बात कर सकता हूँ?" transfers you. Before the e2e simulator's fix, this
     was wrongly ignored as an echo.
   - [ ] Try Hinglish (switching languages mid-sentence) and a noisy room.

## Razorpay billing (test mode first)
Setup is in [razorpay-setup.md](razorpay-setup.md). Use **test** keys until every box is ticked.
1. Keys, webhook secret, `BILLING_SUPPLIER_GSTIN` set; webhook added with the events listed there.
2. Operator → Plans & billing: Starter is created in Razorpay and set as the plan new businesses start on.
   - [ ] The US business still shows **Billing off** in the all-businesses table.
3. Trial: create a test business as an owner.
   - [ ] Settings → Billing shows **Free trial: 14 days left**, 0 / 300 minutes, and **Subscribe**.
4. Checkout: Subscribe, then close the window.
   - [ ] "Nothing was charged". Subscribe again and pay with `failure@razorpay`: Razorpay's reason is shown.
   - [ ] Pay with `success@razorpay` (or a test recurring card): **Subscribed**, next charge on the trial's end date.
5. Usage: make two short calls and one in-app test call.
   - [ ] Minutes go up by the calls only. The operator's Cost per call shows the test call with ₹0 revenue.
6. Failed payment: fail a charge from the Razorpay Dashboard (test mode).
   - [ ] **Payment failed**, with the grace date; the owner gets one email; **Update payment** opens Razorpay's page.
   - [ ] A call during this time is answered normally.
7. Recovery: let the retry succeed (or pay through Update payment).
   - [ ] Back to **Subscribed**. An invoice appears under **Invoices** and arrives by email.
   - [ ] The invoice has the right GST: CGST + SGST if the billing GSTIN is in your state, else IGST. Its number is `AVY/<FY>/…`.
8. Month end: run close-period for the current month (see razorpay-setup.md § 7).
   - [ ] Extra minutes show **Added to next invoice**, and the add-on is on the subscription in the Dashboard.
9. Plan change: Upgrade (starts now); Downgrade (shows "Moves to … at the end of this period").
10. Cancel: **Cancel subscription**.
    - [ ] "Cancels at period end", no next charge; after the period (or cancelling in the Dashboard) it shows **Cancelled**.
11. Switch to live keys (razorpay-setup.md § 8) and repeat steps 4 and 7 with a real ₹ payment, then refund it in the Dashboard.
    - [ ] The invoice shows the refund.

## Resend (owner sign-in)
- [ ] Set `RESEND_API_KEY` and `EMAIL_FROM` (on a verified domain), sign up with a real email, and
  check the code arrives within a minute.

## WhatsApp (Meta Cloud API)
Follow [`docs/whatsapp-setup.md`](whatsapp-setup.md) first. `npm run whatsapp-setup -- --dry-run` should end with no ✗.
1. `npm run whatsapp-setup -- --test-to <your WhatsApp number>`, then reply to the hello_world message.
   - [ ] For an Indian business, the first reply is the AI/privacy notice, then the answer. Your
     next message gets no second notice.
   - [ ] Blue ticks appear on your message, and "typing…" shows while Avery writes.
   - [ ] "I'd like to book an appointment" → times offered → "the first one works" → booked. The
     booking shows in the Calls tab, with your WhatsApp number as the callback.
   - [ ] A voice note ("Can I book for tomorrow?") gets a sensible answer.
   - [ ] A photo with no caption gets a polite "please type it" reply; a location pin is understood.
   - [ ] In a Hindi business (Settings → Voice → Hindi) the replies are in Devanagari.
   - [ ] "STOP" (and, in a second test, "बंद करो") gets the unsubscribe confirmation. Writing again
     still gets answers, but no reminders arrive until you send "START".
2. Admin → Billing → usage shows one WhatsApp conversation for the day.
3. Optional, after a `booking_confirmation` template is approved and `WA_CONFIRMATION_TEMPLATE` is set:
   - [ ] Book by **phone call** from a number that hasn't messaged on WhatsApp for 24 hours. The
     WhatsApp confirmation arrives as the template.
4. Templates, reminders and follow-ups (after setup-guide §9; use a test business):
   - [ ] Operator → WhatsApp → Message templates: **Create Avery's template** for Reminder and
     Missed call. Each shows English, Hindi and Hinglish as *pending*, then *approved* (seconds
     after Meta approves, if `message_template_status_update` is subscribed; else **Sync from Meta**).
   - [ ] Choose them in the dropdowns; the event shows **Sending on WhatsApp**.
   - [ ] Settings → WhatsApp (as the owner): the number shows, the previews read correctly in the
     business's language, and both switches start off. Turn both on.
   - [ ] Book by phone for **tomorrow**, at least 12 hours ahead, from a phone that hasn't messaged
     on WhatsApp for 24 hours. About 24 hours before the slot (or **Send due reminders now**
     once it is inside 24 hours), the reminder template arrives. Running it again sends nothing.
   - [ ] Unset the reminder template (choose *None*), book another slot, and run reminders: an
     SMS arrives instead (if Twilio SMS is set up).
   - [ ] Call the business and hang up during the greeting: the "we missed your call" template
     arrives within a minute. A second call the same week doesn't send another.
   - [ ] Reply "STOP" to the template, then run reminders for another booking: nothing arrives,
     on WhatsApp or SMS. "START" resumes.
   - [ ] Operator → WhatsApp → Number health: quality, daily limit, display name and "last
     message: just now" are shown for the number.
