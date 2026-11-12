# India dental lead lists

This campaign dataset contains 1,000 review-ready dental clinic locations for
each of Bengaluru, Hyderabad, and Chennai. Records come from the public
Overture Maps Places dataset and are ranked by source confidence, contact-field
coverage, and address completeness.

These are research leads, not an automatic send list. Every record starts with
`sendEligible: false`. An address must pass syntax, MX-domain, mailbox-level,
duplicate-recipient, opt-out, and human relevance checks before outreach.

## Refresh all cities

```bash
python3 -m pip install duckdb==2.0.0
python3 campaigns/india-dental-leads/scripts/collect-overture.py
node campaigns/india-dental-leads/scripts/validate-email-domains.mjs
```

The collector refuses to write a city file unless it can produce exactly 1,000
unique clinics with a public address, at least one public contact channel, an
Overture confidence score of at least 0.55, and no blocked non-clinic terms.

Domain validation is only a precheck. An MX record does not prove that a
specific mailbox exists, and catch-all domains must remain `sendEligible:
false` until a mailbox-validation service or a verified reply confirms them.

## Outputs

- `bengaluru/targets-1000.json`
- `hyderabad/targets-1000.json`
- `chennai/targets-1000.json`
- `quality-summary.json`
