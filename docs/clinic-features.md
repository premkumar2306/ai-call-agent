# Clinic features

Four per-business switches, all **off by default** (no `clinic_features` row means everything is
off). Owners turn them on in Settings → WhatsApp → **Clinic follow-ups** (Indian businesses). The
API is `GET/PUT /clinic/:business`. Migration 0025.

| Feature | What happens | Needs |
|---|---|---|
| **Book by procedure length** (`durationBooking`) | A slot is offered and booked only if fewer than `capacity` other patients' visits overlap **the whole procedure** (each service's `duration_minutes`, default 60). The booking stores `ends_at`. The final check is part of the atomic insert, so two callers can't take the last chair. Doctors (resources) already book by duration and overlap. | Service durations; `sectors.capacity` = chairs |
| **No-show recovery** (`noShowRecovery`) | When staff mark a visit **No-show**, the patient gets the `no_show` message ("book a new time, or reply CALL"), and a "Missed appointment … call to rebook" task appears in Messages: that's the follow-up call option, made by staff. | Visits marked on Appointments |
| **Recalls** (`recalls`, `recallMonths` 1–36, default 6, optional `recallCategory`) | About N months after a **completed** visit (in that service category, if one is set), the patient gets the `recall` message inviting them to book. Skipped if they already have a later booking. A 7-day catch-up window covers missed cron runs. | Visits marked **Came** |
| **Review requests** (`reviewRequests`, `reviewUrl`) | 2 hours after a visit scheduled in the last week is marked **Came**, the patient gets the clinic's Google review link (`review_request`). | Google review link (g.page / search.google.com / maps.app.goo.gl) |

## Google review policy: no gating

Google's review policy prohibits *selectively soliciting positive reviews* and *discouraging
negative ones* (review gating). So Avery **doesn't** ask for a rating first and send the Google
link only to happy patients. Every patient with a completed visit gets the same message, which
also invites them to reply privately to the clinic. A "quick rating first, then the link only for
4–5 stars" flow was deliberately not built.

## Messages, opt-out and timing

- All three use `sendEventMessage`: the approved WhatsApp template on the business's number,
  free text inside the 24-hour window, else SMS when Twilio SMS is set up. A patient who replied
  STOP (`messaging_consent`) gets nothing (`skipped:opted_out`). Synthetic callers are skipped.
- New template families, with en / hi / Hinglish bodies in `whatsapp-templates.ts`:
  `avery_recall`, `avery_missed_appointment`, `avery_review_request`. Create them from Operator →
  WhatsApp → Templates, and choose them as each event's template once Meta approves them. Until
  then SMS is used. **The Hindi and Hinglish wording needs review by a native speaker**
  (see the translations list that comes with the languages work).
- They run from the **hourly cron** (`17 * * * *`) via `runClinicFollowUps`, at most 200 per run per
  type. Each booking is claimed (`no_show_sent_at` / `review_sent_at` / `recall_sent_at`) before
  sending, so each message goes once. Visits marked more than 7 days ago are never messaged, so
  turning a switch on doesn't blast old visits. Run by hand: `POST /admin/clinic/run` (operator).
- Marked visits also feed the **no-show rate** in [pilot-metrics.md](pilot-metrics.md).

## Marking visits

Appointments → open a past appointment → **Came** / **No-show** (click again to clear). API:
`POST /clinic/:business/visits/:orderId { "status": "completed" | "no_show" | null }` (staff).
