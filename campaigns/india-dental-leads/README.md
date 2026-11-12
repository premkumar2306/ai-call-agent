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

## Cloud email workflow

`Send and monitor dental email campaign` runs entirely in GitHub Actions, so
the laptop may be off. It supports `preview`, `monitor`, and `send` actions from
the GitHub mobile app or website. Sending is capped at ten messages per day,
deduplicates against campaign messages in Sent Items, validates each selected
mailbox through ZeroBounce, rejects catch-all results, saves messages in Sent
Items, and reports replies and delivery failures without copying reply bodies
into GitHub artifacts.

The workflow fails closed until these repository secrets exist:

- `MICROSOFT_TENANT_ID`
- `MICROSOFT_CLIENT_ID`
- `ZEROBOUNCE_API_KEY`

`MICROSOFT_CLIENT_SECRET` is supported as a fallback, but GitHub OIDC is
preferred. The Entra application needs application permissions `Mail.Send` and
`Mail.Read`, with admin consent, and its Exchange application access should be
restricted to `premkumar@deskzen.in`. Configure a federated credential for
`repo:premkumar2306/ai-call-agent:ref:refs/heads/main` with audience
`api://AzureADTokenExchange`.

Scheduled monitoring is enabled with repository variable
`DENTAL_MONITOR_ENABLED=true`. Scheduled sending additionally requires
`DENTAL_CAMPAIGN_ENABLED=true`; configure `DENTAL_CAMPAIGN_CITY` and
`DENTAL_CAMPAIGN_DAILY_LIMIT` before enabling it. Leave sending disabled until
the first manual one-message test is verified in Sent Items.

## Outputs

- `bengaluru/targets-1000.json`
- `hyderabad/targets-1000.json`
- `chennai/targets-1000.json`
- `quality-summary.json`
