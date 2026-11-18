---
name: onboard-clinic
description: Onboard an Indian dental clinic from the campaign lead list (or manual details) as a draft Avery business with the India dental preset. Use when the owner says "onboard <clinic>" or wants the top leads set up.
---

# Onboard a clinic

Creates a **draft** business with the India dental preset (`worker/src/services/presets.ts`). It maps no phone number, creates no owner account and sends nothing to anyone. Never call, email or message a clinic from a session.

## Inputs
- A lead id: a `slug` from `campaigns/india-dental-leads/approved-organizations.json` (top leads are the first in `sendOrder`), or
- manual details (name, address, website): add the clinic to a lead file first, or use `add-vertical` for a non-dental business.

Needs `WORKER_URL` and `ADMIN_KEY` in the environment (never paste or print the key).

## Steps
1. **Dry run** (default; prints every call, creates nothing):
   `cd worker && npm run onboard:clinic -- --lead <id>`
2. **Create the business** (owner approves first): `npm run onboard:clinic -- --lead <id> --apply`
   It applies the preset: IN/INR/Asia/Kolkata/en-IN, English + Hindi/Hinglish (`hi-en`, Sarvam), dental starter services, duration booking, guardrails, DTMF, plan `in_clinic` + `FOUNDING25` (not charged), overflow pilot draft, DPDP notice on, all WhatsApp/recall/review/no-show switches OFF. Safe to re-run: a finished business is untouched, an interrupted run resumes.
3. **Owner email** (when the clinic replies with one): the owner signs in at the admin site with it; add them: `POST /account/businesses/<key>/members {"email":"…","role":"owner"}` with the `X-Admin-Key` header. Don't use the outreach email or guess one.
4. **Front-desk confirmation**: needs the front desk phone. `npm run onboard:clinic -- --lead <id> --apply --front-desk-phone "+91…"` is only for a new business; for an existing one use `PUT /practice/<key> {"confirmationMode":true,"frontDeskPhone":"+91…"}`.
5. **Map an Avery number** (only when one is assigned and the clinic agrees):
   `curl -X PUT $WORKER_URL/admin/phone-numbers -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" -d '{"number":"+91…","provider":"exotel","businessType":"<key>"}'`
6. **Activation checklist**: hours confirmed, at least one doctor (`/admin/resources`), staff line set, owner can sign in, forwarding tested (`POST /pilot/<key>/forwarding-test`), then start the pilot: `PUT /pilot/<key> {"enabled":true,"startsOn":"<today>","endsOn":"<today+14d>","clinicNumber":"+91…","clinicLine":"airtel"}` (the dry run prints the dates). Billing starts when the owner subscribes in Billing.
7. **Test call**: from a test phone to the Avery number, or `npm run simulate-call`. Never place a call to the clinic's public number.

## Notes
- WhatsApp stays OFF until the owner's templates are approved (`/admin/whatsapp/business/<key>`).
- Sarvam voice needs the `SARVAM_API_KEY` secret on the Worker, or `--apply` stops at the first step with a clear error.
- Hours are a placeholder until the owner confirms; the lead has none.
