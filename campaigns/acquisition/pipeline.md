# Pipeline and weekly targets

Tracker: `pipeline.csv` (one row per clinic once it's first contacted; stages below). `leads.csv` keeps the raw
research and `status` / `consent_status`.

| Stage | Means | Exit when |
|---|---|---|
| lead | In `leads.csv`, not contacted | First touch sent |
| contacted | ≥1 touch sent (email/WhatsApp/call/LinkedIn) | Any reply, or the sequence ends → `lost:no_reply` |
| replied | Human reply (not out-of-office) | Demo time agreed, or `lost:<reason>` / `opted_out` |
| demo_booked | 15–20 min call booked | Pilot agreed |
| pilot | Call forwarding live, 14 days | Day 14 review |
| paid | Razorpay subscription active | (customer) |

Track `lost:<reason>` (price, has receptionist, no need, chain, no reply) and `opted_out`. Never re-contact
`opted_out` or `dnc`.

## Funnel maths (goal: 10 paying clinics by mid-January 2027)

Assumptions: 8% of contacts reply, 50% of replies book a demo, 50% of demos start a pilot, 60% of pilots convert.

| Per week | Target | Notes |
|---|---|---|
| New contacts | 150 (30/day × 5 days) | 10/day existing email campaign + 10/day email from `leads.csv` + 5 WhatsApp + 5 calls |
| Replies | ~12 | |
| Demos booked | 5 | Demo = their personalized link + live call to Avery |
| Pilots started | 2 | Founder sets each up in 20 min |
| Paid (from week 3) | 1–2 | 10 paid in ~7 weeks |

Keep to 30 contacts a day. Email domain warm-up and the hand-sent WhatsApp/calls rule set the limit, not appetite.
Raise it to 50/day only once bounce rate < 3% and there are no spam complaints.

## Weekly review (Friday, 20 min)
1. Count rows by stage; compare with the targets above.
2. Read every `lost:` reason. If the same one shows up 3+ times, change the offer or copy.
3. Pick next week's 150 leads (tier B first, then C; areas from the ICP list).
4. Ask each pilot clinic for a referral (day 10) and a testimonial (on conversion).
