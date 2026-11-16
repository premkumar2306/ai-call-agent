# India dental lead lists

This campaign contains two layers for Bengaluru, Hyderabad, and Chennai:

- 1,000 public dental location records per city from Overture Maps Places.
- A deduplicated organization target list per city, ranked by multi-location
  footprint, city coverage, contact availability, and source quality.

Outreach uses the organization lists so a chain with many branches is treated
as one account instead of receiving repeated branch-level messages. Premium
single-location clinics remain in the list at lower priority.

These are research leads, not an automatic send list. Every record starts with
`sendEligible: false`. An address must pass syntax, live MX-domain,
duplicate-recipient, opt-out, and human relevance checks before outreach.

## Directory layout

- `automation-policy.json`: campaign rules, limits, and path manifest.
- `approved-organizations.json`: reviewed outreach queue and delivery status.
- `delivery-ledger.json`: hashed deduplication and daily send counts.
- `data/cities/<city>/`: raw location and organization target lists.
- `data/*.json`: cross-city quality and organization summaries.
- `assets/demos/<city>/`: clinic-specific copy and MP3 attachments.
- `scripts/`: collection, validation, generation, and delivery tools.

This campaign prioritizes clinics offering high-value treatments and prefers
verified demand signals such as active Google Ads or strong Google review
volume. Those signals must be verified before they affect send order; they are
never inferred from clinic size alone. The pilot includes free setup without a
permanent discount. After a successful pilot, request one testimonial,
permission to publish anonymized metrics, and two dentist referrals.

## Refresh all cities

```bash
python3 -m pip install duckdb==2.0.0
python3 campaigns/india-dental-leads/scripts/collect-overture.py
node campaigns/india-dental-leads/scripts/validate-email-domains.mjs
node campaigns/india-dental-leads/scripts/build-organization-targets.mjs
```

The collector refuses to write a city file unless it can produce exactly 1,000
unique clinics with a public address, at least one public contact channel, an
Overture confidence score of at least 0.55, and no blocked non-clinic terms.

Domain validation is only a precheck. An MX record does not prove that a
specific mailbox exists, so the campaign starts with a one-message test,
uses a low daily cap, and suppresses every address already present in Sent
Items. Delivery failures are reported for review before increasing volume.

## Organization review

Every organization starts with `humanReviewStatus: pending` and
`sendEligible: false`. Before outreach, confirm the organization identity,
select one public business address for the appropriate operations contact, and
set both fields to `approved` and `true`. The email workflow fails closed for
unreviewed records and records an organization hash after an attempt so the
same chain is not contacted through another city list.

Target segments are ordered as:

1. `enterprise_chain`
2. `regional_chain`
3. `city_chain`
4. `growing_group`
5. `premium_single_location`

## Cloud email workflow

`Send and monitor dental organization campaign` runs entirely in GitHub Actions, so
the laptop may be off. It supports `preview`, `monitor`, and `send` actions from
the GitHub mobile app or website. Sending is capped at 15 reviewed organizations per day,
processed in batches of no more than five,
deduplicates against campaign messages in Sent Items and a hashed delivery
ledger, performs a fresh live DNS/MX check immediately before sending, saves
messages in Sent Items, and reports replies and delivery failures without
copying reply bodies into GitHub artifacts. DNS validation cannot guarantee
that a specific mailbox exists.

If Microsoft Graph message reads return a transient 429 or 5xx response, a send
run can continue from `delivery-ledger.json`; authentication and permission
errors still fail closed. Each accepted send updates the hashed ledger and the
workflow commits it to `main`, allowing later cloud runs to enforce deduplication
and the daily cap even while mailbox monitoring is degraded.

The workflow fails closed until these repository secrets exist:

- `MICROSOFT_TENANT_ID`
- `MICROSOFT_CLIENT_ID`

`MICROSOFT_CLIENT_SECRET` is supported as a fallback, but GitHub OIDC is
preferred. The Entra application needs application permissions `Mail.Send` and
`Mail.Read`, with admin consent, and its Exchange application access should be
restricted to `premkumar@deskzen.in`. Configure a federated credential for
`repo:premkumar2306/ai-call-agent:ref:refs/heads/main` with audience
`api://AzureADTokenExchange`.

Scheduled monitoring is enabled with repository variable
`DENTAL_MONITOR_ENABLED=true`. Scheduled sending additionally requires
`DENTAL_CAMPAIGN_ENABLED=true`; configure `DENTAL_CAMPAIGN_CITY` and
`DENTAL_CAMPAIGN_DAILY_LIMIT` before enabling it. Keep the daily limit at one
until the first scheduled message is verified in Sent Items. The cloud workflow
retries hourly from 09:30 through 15:30 IST on weekdays; the daily limit
prevents later runs from sending beyond the configured cap.

## Outputs

- `data/cities/bengaluru/targets-1000.json`
- `data/cities/hyderabad/targets-1000.json`
- `data/cities/chennai/targets-1000.json`
- `data/cities/bengaluru/organization-targets.json`
- `data/cities/hyderabad/organization-targets.json`
- `data/cities/chennai/organization-targets.json`
- `data/quality-summary.json`
- `data/organization-summary.json`

## Demo assets

Use **Prepare dental organization campaign assets** in GitHub Actions, or run:

```bash
node campaigns/india-dental-leads/scripts/generate-organization-demo.mjs \
  --city bengaluru \
  --target clove-dental-bengaluru
```

Bengaluru demos use Hindi and English, Chennai uses Tamil and English, and
Hyderabad supports Hindi, Telugu, and English. Audio generation uses Sarvam
when `--audio --engine sarvam` is supplied.
