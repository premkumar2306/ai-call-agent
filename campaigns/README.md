# Campaign workspace

DeskZen campaigns are account-based research packages. Shared infrastructure is
vertical-neutral; niche-specific ICPs, proof, language, offer details, and copy
live inside each campaign.

## Layout

```text
campaigns/
  shared/                         reusable schemas, scripts, templates
  india-regional-diagnostics/     proposed next campaign (held)
  india-dental-leads/             historical/current campaign (monitor only)
  bengaluru-dental-pilot/         preserved historical campaign
  sites/                          independently deployed demo sites
```

Never delete or rewrite a historical target list, delivery ledger, sent status,
or suppression record. New research belongs in a new campaign folder. Do not
copy secrets, mailbox contents, or private personal data into campaign files.

## Required contact states

`domainValidity` and `mailboxVerification` are separate facts:

- Domain valid means only that the domain is usable or its official HTTPS site
  was retrieved. It says nothing about whether a mailbox exists.
- Mailbox verified requires mailbox-level evidence from a reputable verifier,
  an explicit successful delivery, or a direct human confirmation.
- A public address printed on a website is `public_listed`, not `verified`.
- MX records alone can never upgrade a mailbox to `verified`.

Run the shared validator before reviewing a batch:

```bash
node campaigns/shared/scripts/validate-targets.mjs \
  campaigns/india-regional-diagnostics/data/targets.json
```

## Approval and sending

Every new campaign starts `held_monitoring_only`. Research, previews, reply and
bounce monitoring are allowed. Sending requires Prem to change the campaign's
approval block after reviewing the exact batch. Cold WhatsApp automation and
cold attachments are prohibited. One human follow-up is allowed 2–3 business
days after the first email; then stop unless the prospect engages.
