# Outreach compliance checklist (India)

Not legal advice; see `docs/compliance-india.md` for sources. Apply before **every** send.

## All channels
- Only **public business** contact data (clinic website, listing, signboard). No personal
  mobiles from private profiles, no bought lists, no scraped patient data.
- Each lead keeps `source_url`; record `consent_status` changes in `pipeline.csv`.
- Honour opt-outs immediately and across channels: add to `suppression.csv` (create on first
  opt-out; hash the contact if you commit it, like `delivery-ledger.json`).
- Never message a lead already in `campaigns/india-dental-leads/delivery-ledger.json` (the email
  campaign) on the same channel; `leads.csv` is already deduped against the campaign lists.
- DPDP Act 2023: B2B contact data of a business is still personal data if it names a person
  (e.g. dr.name@gmail.com). Use it only for this one purpose, say who you are and how to opt out,
  delete it on request, and keep no more than you need.

## Email
- From `premkumar@deskzen.in` with the real name and company; working "reply STOP / no" opt-out.
- Max 3 touches, ≥3 days apart; stop on any reply.
- Keep the existing campaign's daily caps (≤10/day per mailbox while warming).

## WhatsApp
- Only to a number the clinic **publishes as its WhatsApp/business number** (wa.me link, "WhatsApp us"
  button, listing marked WhatsApp).
- WhatsApp Business policy: a business may message people only when they have given their number
  and agreed to be contacted by WhatsApp. A clinic's published "WhatsApp us" number invites
  **inbound** contact; the safest pattern is to send **from the personal WhatsApp Business app,
  one-to-one, manually**, max 2 messages, stop on no reply. Never bulk-send, never use the
  Cloud API for cold outreach (needs opt-in + approved marketing templates; risks the number
  that Avery uses for customers).
- Opt-out line in every message.

## Calls (TRAI TCCCPR)
- Do **not** place promotional robo/AI or pre-recorded calls. Manual calls by the founder only.
- Unsolicited commercial calls from 10-digit numbers risk disconnection under TRAI's 2024
  directions. Use the cold-call script as a **service enquiry to a business line**, keep it
  short, ask permission in the first 10 seconds, and stop at the first "no".
- Better: ask for the call by email/WhatsApp first ("can I call you for 5 minutes?") so the
  call is consented. Check the number against NCPR/DND isn't possible for landlines; when unsure,
  email first.
- Log every call outcome; never call a number that said "don't call".

## LinkedIn
- Connection note to clinic owners only via their public professional profile; no automation
  tools (violates LinkedIn User Agreement).
