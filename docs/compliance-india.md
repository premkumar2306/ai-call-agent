# Using Avery in India: DPDP and AI-call disclosure

**This is not legal advice.** It explains what Avery does to help a business meet India's
data-protection rules, and what stays the business's job. The law is new, most of its duties
start in 2027, and parts of it are still being interpreted. Have a lawyer review your setup
before you rely on it.

## The rules that apply

| Rule | What it says (in short) | Status (as of November 2026) |
|------|-------------------------|------------------------------|
| Digital Personal Data Protection Act, 2023 (Act No. 22 of 2023, "DPDP Act"), published on meity.gov.in | A business that decides why and how caller data is processed is a *Data Fiduciary*. It must give notice (s.5), have consent or another lawful ground (ss.6–7), keep data accurate and secure, erase it when the purpose is served (s.8(7)), and let people access, correct and erase their data and raise grievances (ss.11–13). | Act in force in stages with the Rules |
| [DPDP Rules, 2025](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) (G.S.R. 846(E), notified 13/14 Nov 2025; link as listed by secondary sources) | Rule 3: notice must stand on its own, in clear and plain language, with an itemised list of the personal data and the purpose of each, and say how to withdraw consent, exercise rights and complain to the Data Protection Board. Rule 8: erase data when no longer needed; r.8(3) keep personal data, traffic data and processing logs for **at least one year** for the purposes in the Seventh Schedule. Rule 14: publish how people exercise their rights; answer grievances within **90 days**. | Rules 3, 5–16, 22–23 apply **18 months after notification (around May 2027)**; Board provisions apply now |
| TRAI [Telecom Commercial Communications Customer Preference Regulations (TCCCPR), 2018](https://www.trai.gov.in/) and amendments | Commercial calls and messages must go through registered headers/templates on the operators' DLT platform; unsolicited commercial communication is penalised. A draft third amendment ([consultation, 13 March 2026](https://www.trai.gov.in/sites/default/files/2026-03/Draft_CP_13032026_0.pdf)) treats automated / artificial-voice (A2P) calls as a declared category; reports say the final amendment was notified on 18 Sept 2026. | Applies to **outbound** commercial calls. We could not confirm from TRAI's site whether the final text requires an in-call "this is an AI" statement; treat it as good practice |

The primary texts could not be fetched while writing this (network-restricted environment), so the
summary relies on these secondary sources — verify against the Gazette:
[SCC Online summary of the Rules](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/),
[PwC news alert](https://www.pwc.in/research-insights/news_alert/regulatory-insights/meity-notifies-digital-personal-data-protection-rules-2025.html),
[Wikipedia: DPDP Rules 2025](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025),
[IFF statement on the Rules](https://x.com/internetfreedom/status/1989308420676280340),
[Business Standard on TRAI's AI-call plans](https://www.business-standard.com/technology/tech-news/ai-calls-how-to-identify-legitimate-calls-spam-scams-126091500686_1.html).

## What Avery does

All of these are per business and **off for existing businesses** unless switched on.
Admin UI: **Settings → Privacy & data**. API: `/admin/privacy/:businessType/*` (admin key).

- **Call-start notice.** Right after "Thanks for calling!", Avery says the caller is talking to
  an AI assistant and that the call is transcribed. Default wording:
  *"Just so you know, you're speaking with an AI assistant, and this call is transcribed so we
  can help you. Our privacy notice is linked in any text we send you."* Businesses whose phone line
  speaks Hindi or Hinglish (voice language `hi` / `hi-en`) get a Hindi (Devanagari) or Hinglish
  version of this default instead. You can replace it with your own wording, up to 400 characters;
  your wording is used whatever the language. Setting: *Automatic* (on when the business is in India — its
  country is IN, or its timezone is Asia/Kolkata or currency INR), *Always on*, or *Off*.
- **Privacy notice link.** With the notice on and a privacy notice URL set, booking confirmation
  texts and the first WhatsApp reply of a conversation include `Privacy notice: <url>`. The first
  WhatsApp reply also carries a short AI notice.
- **Notice audit trail.** Every notice given is stored in `consent_records`: business, channel,
  call id, the hashed caller id, the exact wording and its version hash, when it started, and
  whether the caller heard it to the end (Twilio confirmed playback) or talked over it / hung up.
- **Access and erasure.** Export everything stored about a caller as JSON, or erase it, by their
  phone number. Erasure deletes their transcripts, staff messages, live call/WhatsApp history and
  (when no other business holds their data) their customer record; clears name, phone, vehicle,
  notes and address from their bookings but keeps the booking (service, price, time, status) for
  your records; cancels their upcoming bookings and removes them from your connected calendar.
  Notice records are kept as the audit trail but unlinked from the caller. Each export and erasure
  is logged in `data_requests`.
- **Retention.** Set how many days to keep transcripts and staff messages; a daily job
  (Cloudflare Cron Trigger, 21:17 UTC / 02:47 IST) deletes older ones. Notice records are kept for
  at least 365 days. Empty = keep (the default).
- **No audio recordings.** Avery streams call audio for speech recognition and does not store it.
  The transcript is the record of the call. (The speech-to-text, text-to-speech and AI model
  providers process audio/text on Avery's behalf — list them in your privacy notice.)
- **Inbound only.** Avery answers calls and messages people start. It does not place outbound or
  promotional calls.

## What remains the business's responsibility

- **Your privacy notice.** Adapt [privacy-notice-template.md](privacy-notice-template.md), publish
  it, and set its URL. Rule 3 needs an itemised, standalone notice — a spoken sentence on the call
  is not enough on its own, which is why the link matters.
- **Your lawful basis.** Decide whether you rely on consent or a "legitimate use" (DPDP s.7) for
  handling enquiries and bookings. Consent under s.6 must be free, specific, informed and given by a
  clear affirmative action; a caller simply staying on the line after the notice may not meet that
  bar. Take advice.
- **Answering requests.** Verify that a request really comes from the person (e.g. call back on the
  number) before exporting or erasing. Answer grievances within 90 days. Correction of booking
  details is done by your staff. Publish a contact for privacy requests (a Grievance Officer /
  contact person).
- **Choosing retention periods.** Pick periods that fit your purposes and any other laws (tax,
  medical records). Note r.8(3)'s one-year minimum for certain data and logs; a period under 365
  days shows a warning in the admin UI.
- **Data in your own systems.** Booking emails sent to you, your calendar, your phones and any
  exports you download are yours to manage.
- **Breaches.** If you learn of a personal data breach, the Rules require notifying affected people
  and the Data Protection Board (r.7). Tell Avery's operator too.
- **Children and health data.** Calls about children or patients may need extra care (verifiable
  parental consent for children under s.9; sector rules for clinics). Don't rely on Avery alone.
- **Outbound calls and messages.** Do not use Avery for outbound or promotional calls. Those need
  DLT registration and consent under TRAI's TCCCPR, and (per the 2026 amendment) declaration of
  automated calls. Booking confirmations sent by text are transactional; if you send them from an
  Indian number, the SMS route also needs DLT-registered headers and templates.
- **Significant Data Fiduciaries** (if the Government notifies you as one) have further duties
  (DPO, audits, impact assessments) that Avery does not cover.

## Turning it on for a business

1. Settings → Privacy & data → pick the business.
2. Leave the notice on *Automatic* (or *Always on*), and adjust the wording if you like.
3. Publish your privacy notice and paste its URL.
4. Set a retention period, or leave empty to keep data.
5. Make a test call and check **Recent notice records** shows it.
