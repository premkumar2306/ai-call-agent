# Pilot metrics: exact formulas

Per business, computed live by `computeMetrics()` in `worker/src/services/metrics.ts`, and shown on
Home → **Assistant results** (Indian businesses), in the weekly email and on the shareable report.
Every figure comes from rows written by real calls and bookings. There are no sample or estimated
numbers anywhere. A rate with no denominator is shown as "—", never 0%.

## Data

| Table | Written by | What it holds |
|---|---|---|
| `call_outcomes` (0024) | CallRelay when a call ends (all carriers) | carrier, call id, caller hash, start/end, caller turns, transferred, message taken, `is_test` |
| `call_routing` (0023) | the carrier answer webhook | overflow tag and `forwarded_from` (see [overflow-pilot.md](overflow-pilot.md)) |
| `orders` | bookings (calls and WhatsApp) | caller hash, created time, status |

Excluded everywhere: test calls (`is_test`: synthetic callers), cancelled bookings, and synthetic
customers.

## Window

`[from, to)` in unix seconds. The dashboard offers the last 7, 30 or 90 days, or **Pilot dates**:
the pilot's start date 00:00 IST to its end date 23:59:59 IST (or now). The shared report uses
the pilot dates when a pilot exists, otherwise the last 30 days. The weekly email covers Monday
00:00 to Monday 00:00 in the business's time zone.

## Formulas

Let **C** be the calls in `call_outcomes` for the business with `from ≤ started_at < to`, not test calls.

| Metric | Formula |
|---|---|
| Calls handled | `|C|` |
| Answered | calls in C with `user_turns ≥ 1` (the caller said something to the assistant) |
| **Answer rate** | `answered / |C|`. Calls that reached the assistant and became a conversation. Calls that staff picked up never reach Avery, so this is not the clinic's overall answer rate. |
| Overflow calls | calls in C with a `call_routing` row for the same carrier and call id where `is_overflow = 1` |
| After-hours calls | calls in C whose start, in the business's time zone, falls outside every opening range for that weekday (`sectors.hours`; "Closed" = all day; unparseable hours never count as after-hours) |
| Booking from a call | a non-cancelled booking whose `customer_id_hashed` equals the call's caller hash and whose `created_at` is between call start and call end + 10 minutes. Each booking counts once. |
| Bookings from calls | the number of distinct such bookings |
| **Recovered bookings** | distinct bookings from calls that were overflow **or** after-hours |
| Transfers | calls in C with `transferred = 1` |
| **Transfer rate** | `transfers / answered` |
| **No-show rate** | `no_show / (completed + no_show)` over appointments **scheduled** in the window whose visit staff marked (Appointments → Completed / No-show, launch item 4). "Before" is the same-length window just before `from`; "after" is the window. Shown as "not tracked" until at least one visit in either window is marked. |

Rates are rounded to 0.1 percentage point in the API and to whole percent in the UI.

## Sharing and the weekly email (off by default)

- **Weekly summary:** Home → Assistant results → "Email me a weekly summary". The daily cron
  (02:17 IST) sends last week's figures on Monday to the business's notification email, once per
  week (`metrics_settings.weekly_last_sent`). It goes by email only, because a WhatsApp message
  to the owner would need an approved Meta template, and none has been approved yet.
- **Shareable report:** "Share a read-only report link" creates `/report/<48-hex token>` on the
  Worker. It shows the business name and the figures above, with no caller numbers, names or
  transcripts, and is marked `noindex`. Turning it off kills the link. Turning it on again
  makes a new one.
