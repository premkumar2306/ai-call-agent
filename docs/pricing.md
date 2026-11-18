# Pricing (India)

Public pricing copy for the website, sales deck and WhatsApp replies, plus the margin check
behind it. The numbers come from the database (`billing_plans`, `billing_offers`, migration
0022) and are served to the signup page by `GET /account/plans`. If a plan changes there,
change this page too.

## Public copy

> **DeskZen Clinic: ₹4,999/month + GST**
> Your AI receptionist answers every call on your clinic's number, in English, Hindi or Hinglish,
> books the appointment and confirms it on WhatsApp.
>
> - **800 minutes of calls included every month.** That's about 400 two-minute calls.
> - After 800 minutes: ₹6 per minute + GST. You see "Included minutes used" in Settings → Billing
>   all month, and we email you at 80% and 100%, so there are no surprises.
> - Calls are never cut off for being over your minutes.
> - Booking, transfer to your staff, call transcripts, WhatsApp confirmations and reminders.
> - One GST tax invoice a month. Pay by UPI AutoPay or card. Cancel any time.
>
> **Founding offer for the first 25 clinics:** free setup and your first month free.
> Use code **FOUNDING25** when you sign up.
>
> **Starter: ₹2,999/month + GST** for single-chair clinics: 300 minutes included, then ₹7 per
> minute + GST.
>
> Both plans start with a 14-day free trial. Nothing is charged until you subscribe.

Prices exclude 18% GST: Clinic is ₹5,898.82/month and Starter ₹3,538.82/month including GST.

Rules for anyone quoting prices:

- Don't promise "unlimited" anything. Minutes beyond the plan are billed.
- The founding offer is limited to 25 clinics and to the Clinic plan. Check seats left with
  `GET /account/plans` (`offers[].seatsLeft`) before promising it.
- Minutes are billed per started minute of each call (telecom convention). A transfer to staff
  stops the meter. Test calls from the dashboard are free.

## Plans in the code

| | Clinic (`in_clinic`) | Starter (`in_starter`) |
|---|---|---|
| Monthly fee (excl. GST) | ₹4,999 | ₹2,999 |
| Included minutes | 800 | 300 |
| Overage (excl. GST) | ₹6/min | ₹7/min (unchanged) |
| Trial | 14 days | 14 days |
| Setup fee | ₹0 (set `setupFeePaise` to charge one) | ₹0 |
| Headline on signup | yes (`is_featured`) | no |

Founding offer `FOUNDING25`: `freeDays` 30 (replaces the 14-day trial; Razorpay's first charge is
moved to day 30), `waiveSetupFee` true, `planIds` `in_clinic`, `maxRedemptions` 25. It is a coupon
row, not a price: removing or closing it changes nothing for clinics already on it.

## Margin check

Cost per connected minute, from `DEFAULT_COST_RATES` in
`worker/src/services/billing/pricing.ts` (list prices, ₹88/USD). The figures are pinned by a unit
test (`worker/test/billing-offers.test.ts`, "margin").

Assumed typical minute: the caller's audio goes through speech recognition for the whole minute;
the assistant speaks about 450 characters; about 4 LLM turns with a ~3,000-token cached prompt,
300 new input and 60 output tokens each (Claude Haiku 5.5 rates).

| Part | English call on Plivo/Exotel (Deepgram + Cartesia) | Hindi call on Plivo (Sarvam STT + TTS) |
|---|---|---|
| Phone line (Plivo/Exotel, $0.006/min) | ₹0.53 | ₹0.53 |
| Speech to text | ₹0.68 (Deepgram $0.0077/min) | ₹0.50 (Sarvam ~₹30/hour) |
| Text to speech | ₹1.19 (Cartesia $0.00003/char) | ₹0.68 (Sarvam ~₹15/10K chars) |
| LLM | ₹0.03 | ₹0.03 |
| **Total per minute** | **₹2.43** | **₹1.73** |

What that means for each plan, if every included minute is used (worst case):

| | Revenue (excl. GST) | Provider cost at ₹2.43/min | Gross margin |
|---|---|---|---|
| Clinic, 800 min | ₹4,999 | ₹1,944 | ₹3,055 (61%) |
| Clinic overage, per minute | ₹6.00 | ₹2.43 | ₹3.57 (60%) |
| Starter, 300 min | ₹2,999 | ₹729 | ₹2,270 (76%) |
| Starter overage, per minute | ₹7.00 | ₹2.43 | ₹4.57 (65%) |
| Clinic in the founding month | ₹0 | up to ₹1,944 | −₹1,944 (one month per founding clinic; 25 × = up to ₹48,600) |

Not included above, and to be confirmed against real invoices before scaling:

- the Indian number's monthly rental (Plivo/Exotel), WhatsApp template messages (Meta charges
  business-initiated conversations), Razorpay's ~2% per payment, Cloudflare;
- the telephony rate: `$0.006/min` is the table's placeholder for Plivo and Exotel. Check the
  carrier's India inbound rate card and set `BILLING_COST_RATES` if it differs;
- real per-call mixes: the operator view (Billing → cost and margin) shows measured cost per minute
  from usage records once real calls flow. Use it instead of this estimate as soon as it exists.

Per-call rounding helps margin: a 61-second call bills 2 minutes but costs ~1 minute.
