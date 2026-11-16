# DeskZen big-client acquisition plan

As of 15 November 2026, the current dental effort has 15 attempts, three
bounced/blocked recipients, 12 without a recorded bounce, and no replies. That
is too little data to judge the product, but enough to stop the current sending
pattern and fix account selection, contact evidence, and the ask. No sale is
assumed or promised.

## Decision: regional diagnostics and imaging

The next wedge is a regional diagnostics or imaging operator with roughly 5–50
locations in Bengaluru, Chennai, or Hyderabad. The buyer is a founder/COO,
regional operations head, customer-experience head, or call-centre owner who can
authorize a one-branch trial.

The public evidence supports this wedge:

- [Prima Diagnostics](https://primadiagnostics.com/centres/) publishes nine
  Bengaluru centres, modality differences, home collection, and a central
  contact.
- [Uniscans](https://www.uniscans.org/contact-us) lists ten network locations,
  branch phones, and a central booking/support route.
- [Lucid](https://luciddiagnostics.com/pages/locations) lists a dense Hyderabad
  network with branch-specific phones, central email, and MRI/CT availability.
- [Sprint](https://www.sprintdiagnostics.in/contact) lists six Hyderabad
  centres, one central number, MRI/CT, and service until 11 PM.
- [MedQuest](https://medquestdiagnostics.com/contact.html) lists five Hyderabad
  centres, seven overall, and 24-hour MRI/CT at two sites; its public site also
  names a COO.
- [Anderson](https://www.andersondiagnostics.com/chennai/) exposes a large
  Chennai branch/collection network and a shared helpline.

These operators have frequent appointment, scan, home-collection, price, prep,
and report calls. A missed high-value scan enquiry can be measured without
claiming that every missed call would have converted. National chains and
single-location centres remain lower priority because their buying paths or
account value conflict with the goal.

## Audit of the current system

| Area | Finding | Correction |
|---|---|---|
| List quality | Branch records were treated as prospects and organization dedupe was incomplete. | One account per parent organization; location count and source URL required. |
| Mailbox verification | `mx_valid` was treated too close to mailbox verification; three of 15 attempts bounced/blocked. | Separate `domainValidity` from `mailboxVerification`; MX or an official listing never proves mailbox existence. |
| Seniority | Generic clinic inboxes and branch contacts rarely own multi-location operations. | Prefer COO/founder/operations/CX/call-centre roles; qualify by public phone when no relevant public inbox exists. |
| Targeting | Dental included many small clinics and very large chains, weakening the “substantial but fast” objective. | Focus on 5–50-location regional diagnostic operators; keep exceptions below the first batch. |
| Copy | Prior copy described features, languages, setup, a WhatsApp link, and organization size before establishing pain. | Lead with lost bookings from missed calls; use 80–100 plain-text words. |
| Offer | “Free setup” was not bounded by branch, duration, or measurable exit. | 14 days, one branch, fixed scope, baseline and success criteria, then paid/stop. |
| Attachment friction | Personalized MP3 attachments in a cold first touch add security and attention friction. | No cold attachment; create a 60-second demo only after permission. |
| CTA | Asking to review examples, contact on WhatsApp, and consider a pilot created multiple decisions. | One CTA: permission to make the short demo. |
| Inbox risk | Fifteen sends across low-confidence recipients, generic inboxes, links, and attachments increase filtering risk. | Five-account manual batch, independently verified mailboxes, no attachment, no tracking link, one recipient per account. |
| Follow-up | No disciplined buyer handoff/cadence was defined. | One follow-up after three business days, then stop; human call to identify the owner; WhatsApp only after explicit permission. |

## Account and contact policy

The source-cited target list is in
`campaigns/india-regional-diagnostics/data/targets.json`. It contains 32 rows
representing 30 distinct organizations; Aarthi is intentionally represented by
three regional operating footprints and must be deduplicated to one account
before any batch.

A contact can enter a send batch only when all are true:

1. Prem approves the organization and the exact person or functional mailbox.
2. The role plausibly owns appointment-call operations or can route to that
   owner.
3. The address is public; no pattern-derived or guessed address is allowed.
4. The domain is valid.
5. A mailbox-level verifier, successful prior delivery, or direct human
   confirmation establishes `mailboxVerification: verified`.
6. Suppression, prior attempt, opt-out, and organization dedupe checks pass.

An official web page proves only `public_listed`. MX proves only domain mail
configuration. Neither upgrades the mailbox.

## Top ten accounts

1. Lucid Medical Diagnostics — Hyderabad, ~30 locations.
2. Anderson Diagnostics & Labs — Chennai, large city network.
3. Tapadia Diagnostic Centre — Hyderabad, at least 12 local centres.
4. Prima Diagnostics — Bengaluru, nine centres.
5. Uniscans & Labs — Chennai, ten network locations.
6. Sprint Diagnostics — Hyderabad, six local centres.
7. MedQuest Diagnostics — Hyderabad, five local centres; public COO listing.
8. DiabCare Labs — Hyderabad, 5+ full-service centres and 20+ collection points.
9. Bharath Jan Sewa Labs — Bengaluru, ten centres/hubs.
10. Rashi Diagnostics — Bengaluru, four company-owned centres and a public
    enquiry route.

The first five-account batch should start with MedQuest, Prima, Sprint,
Uniscans, and Rashi. This mix favors a named buyer or clear public inbox and
avoids concentrating the whole learning cycle in one city.

## Exact first move

Prem should call MedQuest's public central line and ask for **Praveen Potluri,
COO, or the person who owns appointment-call operations across the five
Hyderabad centres**. The only ask is permission to create a 60-second example
for the Madinaguda or LB Nagar branch, where the public site states CT/MRI runs
24 hours. If the operator confirms a better owner, record that name and route.
Do not send the demo or a WhatsApp message until permission is explicit.

At the same time, run independent mailbox-level checks on the public business
addresses for the five-account batch. Only then should Prem approve and manually
send the exact plain-text messages in
`campaigns/india-regional-diagnostics/outreach.md`.

## Pilot and proof

The offer is a 14-day, one-branch, free-setup pilot using overflow and/or
after-hours call forwarding. It does not replace the existing number, team, or
booking system. Baseline inputs, safety requirements, ROI formula, success
criteria, and the paid/stop exit are in `pilot-and-roi.md`.

Before a workflow review, prepare the proof package in
`proof/enterprise-proof-package.md`: security/privacy, DPDP disclosure, data
flow, implementation and rollback, measured success criteria, ROI assumptions,
and post-success testimonial/metrics/referral asks. Unknown security or product
capabilities must be marked as gaps, not represented as finished.

## Ten-business-day operating plan

The day-by-day plan and exit criteria are in `execution-plan.md`. The key rule
is to learn from five accounts before increasing volume. The dashboard in
`funnel-dashboard.json` measures approvals, verified mailboxes, delivery,
relevant conversations, demo permission, workflow reviews, pilots, and paid
conversion. “No recorded bounce” is not counted as a reply or sale signal.

## Automation hold

The dental campaign and the new diagnostics campaign are both held in
monitoring-only mode. Existing sent history, bounces, suppression hashes,
`targets-500.json`, and the three 1,000-location files remain preserved. The
dental send script now rejects a send action unless the policy is explicitly
changed to approved and Prem's approval flags are all true.

## Blockers requiring Prem

- Choose and approve the first five organizations and exact message text.
- Use a reputable mailbox verifier or direct human confirmation; this repo has
  no mailbox-verification provider credential.
- Confirm that `premkumar@deskzen.in` has SPF, DKIM, DMARC, a healthy sending
  history, a complete signature, and reply monitoring. DNS configuration was
  not changed in this workstream.
- Confirm the public price after the free pilot and the maximum included call
  volume so the ROI comparison is real.
- Provide current security/subprocessor, retention, incident-response, and DPDP
  details for the proof package; do not send it with placeholders.
- Make the human call and, only if invited, the WhatsApp handoff. No automated
  outreach was performed here.
