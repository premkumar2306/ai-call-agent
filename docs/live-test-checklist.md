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
Same as Exotel. The answer URL is `https://<worker>/plivo/answer`, and `PLIVO_WEBHOOK_URL` must
be exactly the URL Plivo calls. A wrong value gives a 403, because the signature won't match.

## Sarvam (Hindi / Hinglish)
1. Set `SARVAM_API_KEY`. In Settings → Voice, pick Hindi with Sarvam for speech recognition and voice.
2. Call and speak Hindi.
   - [ ] The notice and greeting are in Hindi, and the voice sounds natural.
   - [ ] "मुझे अपॉइंटमेंट बुक करना है" leads to a booking.
   - [ ] "क्या मैं किसी से बात कर सकता हूँ?" transfers you. Before the e2e simulator's fix, this
     was wrongly ignored as an echo.
   - [ ] Try Hinglish (switching languages mid-sentence) and a noisy room.

## Razorpay (test mode first)
1. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (test keys) and `RAZORPAY_WEBHOOK_SECRET`. Add the
   webhook `https://<worker>/razorpay/webhook` for `subscription.*` events.
2. Admin → Billing: sync the Starter plan to Razorpay, then assign it to the test business.
3. As the owner, open Billing → Subscribe and pay with Razorpay's test card or UPI.
   - [ ] Billing shows **active** within a minute.
   - [ ] After a few test calls, the minutes used go up.

## Resend (owner sign-in)
- [ ] Set `RESEND_API_KEY` and `EMAIL_FROM` (on a verified domain), sign up with a real email, and
  check the code arrives within a minute.
