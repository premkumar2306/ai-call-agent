# Acquisition: first 10 paying customers (dental clinics, Bengaluru + Hyderabad)

**Nothing here has been sent.** Everything is prepared for the owner to approve and send by hand.
The existing email campaign (`campaigns/india-dental-leads`, workflow `dental-email-campaign.yml`) is
untouched. Keep it running; this plan adds new leads and channels around it.

| File | What |
|---|---|
| `offer.md` | ICP, 14-day free pilot → ₹2,999/mo + GST, founding price (draft), guarantee |
| `leads.csv` | 399 new dental clinics (Bengaluru 288, Hyderabad 111), deduped against every list in `campaigns/` |
| `sequences.md` | Email ×3, WhatsApp ×2, cold-call script, LinkedIn note, each in English + Hinglish, with opt-out wording |
| `compliance-checklist.md` | DPDP, TRAI TCCCPR, WhatsApp Business policy and LinkedIn rules for each channel |
| `pipeline.csv`, `pipeline.md` | Stage tracker (lead → contacted → replied → demo booked → pilot → paid) and weekly targets |
| `channels.md` | IDA branches, distributors, software resellers, alumni groups, Nov–Dec events, referral offer |
| `scripts/collect-leads.py` | Rebuilds `leads.csv` from Overture Maps Places (public, CDLA-Permissive-2.0) |
| `scripts/personalize.mjs` | Adds `demo_slug`, `demo_url`, `first_line`, and `whatsapp` (only if the clinic's own site publishes one) |

## About the leads
- Source: Overture Maps Places, release 2026-10-21.0 (aggregates public business listings). Each row gives its
  `source_url` (the public Facebook page or website) and the Overture id.
- Excludes every clinic in the existing campaign lists (match on id, phone, email, website domain, or name + PIN).
  These are the clinics ranked *below* the email campaign's top 1,000, so quality is tier B/C and they need a
  quick look before contact.
- `rating`, `review_count`, `missed_call_signal` are **blank on purpose**. Google Maps terms forbid scraping. Fill
  them by hand for the clinics you're about to contact (2 minutes each: open the listing, note the rating, search
  reviews for "not reachable / no one picks up / didn't call back").
- Rebuild: `pip install pyarrow && python3 campaigns/acquisition/scripts/collect-leads.py`, then
  `NODE_USE_ENV_PROXY=1 node campaigns/acquisition/scripts/personalize.mjs`. The second step fetches each clinic's
  home page once, 2 s apart, after checking robots.txt.
- Demo links use `https://demo.deskzen.in/?demo=<demo_slug>`. The demo-site workstream needs to accept these
  slugs (or read name/area from `leads.csv`). Open a link before sending it.

## Owner approval needed before anything goes out
1. Offer and price: 14-day free pilot, ₹2,999/mo + GST, **founding price ₹1,999/mo for 12 months (draft)**,
   guarantee (5 caught bookings or free; 30-day refund on the first paid month).
2. Referral terms: one month free for both clinics; 20% recurring for 12 months for partners (draft).
3. Copy in `sequences.md`, especially the subject line and the "1 in 5 calls" claim (replace it with real pilot data when you have it).
4. Channels: email from premkumar@deskzen.in by hand (or a separate approved run, not the existing workflow);
   WhatsApp only to clinic-published numbers, one by one; calls manual only.
5. That the demo site renders for these slugs.

## Today
- [ ] Approve or edit `offer.md` and `sequences.md`.
- [ ] Expodent Hyderabad is on **14–15 Nov at HITEX**. If someone can go on the 15th, meet distributors there (`channels.md` §2).
- [ ] Pick 30 tier-B leads in ICP areas (HSR, Koramangala, Whitefield, Indiranagar, JP Nagar; Gachibowli, Kondapur, Madhapur, Kukatpally). Fill in rating and missed-call signal; check their demo links.
- [ ] Send email touch 1 to 10 of them by hand. Log each in `pipeline.csv`.

## This week
- [ ] 30 contacts/day (≈150): 10 via the existing campaign, 10 email from `leads.csv`, 5 WhatsApp, 5 follow-up calls.
- [ ] Email IDA head office for the Bangalore and Deccan branch secretaries; ask for a CDE-meeting slot.
- [ ] Contact Dentostack and Vamtech about integration and resale; Pinkblue about a referral partnership.
- [ ] Confirm IACDE dates (27–29 Nov, Bengaluru?) and register if they're right.
- [ ] Target: 5 demos booked, 2 pilots live.

## This month (to mid-December)
- [ ] 600 contacts, 20 demos, 8 pilots, first 3–4 paying clinics.
- [ ] After each pilot, use its numbers ("caught 11 calls in 14 days") in the copy instead of the generic claim.
- [ ] Ask every pilot clinic for a referral on day 10; get 2 testimonials.
- [ ] One IDA talk or alumni session booked; one distributor or software partner signed.
- [ ] Friday reviews (`pipeline.md`); if replies are under 5%, change the subject line and first line before adding volume.
- [ ] Then extend to Chennai (existing list), other clinic types (dermatology, physio) and law firms with the same playbook.
