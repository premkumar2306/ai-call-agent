# Documentation

Use this page to find the right guide. The project overview and local-development
instructions remain in the [root README](../README.md).

## Start here

- [Production readiness](production-readiness.md) — services, secrets, health checks, and
  the go-live sequence.
- [First live calls](live-test-checklist.md) — end-to-end checks with real providers.

## Deployment and operations

- [Isolated staging environment](staging-environment.md)
- [Database migration policy](database-migrations.md)
- [Browser authentication security](authentication-security.md)
- [Atomic rate limiting](rate-limiting.md)
- [Supply-chain security](supply-chain-security.md)

## Provider setup

- [Plivo](plivo-setup.md) — Indian phone numbers and voice webhooks.
- [WhatsApp](whatsapp-setup.md) — Meta business setup, webhooks, and templates.
- [Razorpay](razorpay-setup.md) — subscriptions, payments, and billing webhooks.

## India compliance

- [DPDP and AI-call disclosure](compliance-india.md)
- [Privacy notice template](privacy-notice-template.md)

These documents summarize implementation considerations and are not legal advice.

## Maintenance

- Keep setup instructions next to the system they describe and link them from this index.
- Prefer updating an existing guide over creating a second document for the same workflow.
- Never include credentials, access tokens, customer data, or unredacted production output.
