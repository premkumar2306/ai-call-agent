# Browser authentication security

The Pages UI and Worker API are hosted on different sites, so owner sessions use a bearer token rather
than a third-party cookie. The token is stored in per-tab `sessionStorage`, not persistent
`localStorage`; closing the tab removes the browser copy. Operator credentials use the same per-tab
storage boundary.

Owner tokens are short-lived signed JWTs with a dedicated audience and derived signing key. Every
authenticated request also compares the token's session version with the current user row. Logout
increments that version, revoking all outstanding owner tokens immediately.

Cloudflare Pages serves `web/public/_headers`, which denies framing, plugins and arbitrary script
execution. Scripts may load only from the application origin and Razorpay Checkout. API connections
are limited to the application origin, the production Worker, and Razorpay. Inline scripts are not
allowed; inline styles remain enabled because the current React UI uses style objects.

## Deployment checks

After deploying Pages:

1. Inspect the document response and confirm the CSP, referrer, permissions, frame and MIME headers.
2. Sign in, reload the tab and confirm the session survives; close the tab and confirm a new tab asks
   for sign-in again.
3. Confirm owner logout invalidates a copied token.
4. Exercise Razorpay Checkout and microphone-based voice testing while watching the browser CSP log.
5. If the Worker moves to a custom domain, update `connect-src` in `web/public/_headers` in the same release.
