# ICP and pilot offer (DeskZen / Avery, dental clinics, India)

Status: **draft for owner approval.** Pricing follows the recommendation in
`docs/market/competition-analysis.md` (draft PR #100, branch `claude/competition-analysis`), which is also
a draft. The product today seeds only `in_starter` (₹2,999/month excl. GST, 300 min, ₹7/min, 14-day
trial). The Clinic plan must be created with `PUT /admin/billing/plans/in_clinic` before the first
customer pays.

## Ideal clinic (who we chase first)

| Attribute | Ideal | Why |
|---|---|---|
| Type | Independent or 2–3 branch dental clinic (general, ortho, implants, paediatric) | Owner decides alone; no procurement |
| Size | 2–5 chairs, 1–3 dentists, **one** front-desk person (or the dentist's assistant answers) | One receptionist can't cover calls during patient handling, lunch, and after 7 pm |
| Call volume | 20–80 inbound calls/day; new-patient value ₹3,000–₹50,000 (RCT, aligners, implants) | One recovered booking a month pays for the plan |
| Hours | Open 6 days, evenings; closed Sunday or afternoon break | After-hours and Sunday calls go unanswered |
| Location | Bengaluru (Indiranagar, HSR, Whitefield, Koramangala, JP Nagar, Jayanagar, Electronic City), Hyderabad (Gachibowli, Kondapur, Madhapur, Kukatpally, Banjara Hills, Jubilee Hills) | Dense, competitive, patients search and call several clinics |
| Digital | Has a website or Practo/Google listing, public phone, maybe WhatsApp button | Already buys patients online; understands lead leakage |
| Languages | Patients call in **English or Hindi/Hinglish** | Avery doesn't speak Tamil, Telugu or Kannada yet, so skip clinics whose callers are mostly Kannada- or Telugu-speaking for now |

**Signs they miss calls** (score +1 each, prioritise 3+):
- Google/Practo reviews saying "couldn't reach", "no one picks up", "phone always busy", "didn't call back";
- only one landline listed, or a personal mobile as the clinic number;
- website says "call to book" with no online booking;
- hours listed as closed for lunch (1–4 pm) or Sunday;
- multiple branches sharing one number;
- the cold call itself goes unanswered or to voicemail (log it: it is the best proof).

**Uses Practo/Clinicia?** That's fine, even a plus. Practo's AI answers *Practo's* booking line, not
the clinic's own number. Pitch: "Keep Practo for your diary; Avery picks up the calls Practo can't."

**Not now:** dental chains with central call centres (Clove, Sabka, FMS), hospital dental wings,
dental colleges, labs, suppliers.

## The offer

**"Never miss a patient call: 14-day free pilot."**

1. **Free 14-day pilot.** We set up Avery on call forwarding (busy / no-answer / after-hours) to an
   Avery number. The clinic keeps its number and receptionist. Setup takes one 20-minute call:
   we load the clinic's doctors, timings, services and prices. No card needed to start.
2. **Then the Clinic plan: ₹4,999/month + GST** *(draft)*: 800 call minutes, one Indian number,
   WhatsApp reminders and missed-call follow-up; ₹6/minute after. **Starter ₹2,999/month + GST**
   (300 min, ₹7/min) for single-chair clinics. Month to month, cancel any time, UPI AutoPay or card
   through Razorpay.
3. **Founding offer (first 25 clinics):** free setup and the **first paid month free**, with the price
   locked for 12 months. In return we ask for a testimonial or a referral if they're happy. *(Draft:
   owner to approve.)* With the 14-day pilot, a founding clinic pays nothing for about 6 weeks.
4. What's included: answers in English/Hindi/Hinglish, books into the calendar, WhatsApp
   confirmation to the patient, call summary to the doctor on WhatsApp/email, AI disclosure
   at call start, DPDP-ready privacy notice (see `docs/compliance-india.md`).

## Guarantee

- **Pilot:** if Avery doesn't capture at least **5 appointment requests** you would otherwise have
  missed (after-hours, busy or unanswered calls) in 14 days, you don't pay and we remove it.
  We show the call log so you can check every one.
- **First charged month:** if you're not happy, tell us within 30 days and we refund it in full.
  No questions.
- Your number never changes; removing Avery is one call-forwarding switch on your phone.

## Pricing ladder (draft, from the competition analysis)

| Plan | Price (excl. GST) | Minutes | Who |
|---|---|---|---|
| Starter (in product) | ₹2,999/mo | 300, then ₹7/min | 1-chair clinic, overflow + after-hours |
| **Clinic (recommended, not yet seeded)** | **₹4,999/mo** | 800, then ₹6/min | 2–5 chairs, all missed + after-hours calls |
| Founding (first 25) | Free setup + first month free, price locked 12 months | as plan | Early clinics |

Why it holds up: WhatsApp-only tools (AiSensy, WATI, ₹1.5–4k/mo) don't answer calls. Global AI receptionists
cost 2–9× more and don't speak Hindi. Agencies reselling Retell/Vapi/Bolna need building and billing work that
Avery already does. No local proof yet, so **the pilot is the proof**: put the first pilots' numbers in the copy.
