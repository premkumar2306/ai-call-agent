# Isolated staging environment

Staging uses dedicated Cloudflare Worker, D1, KV, Durable Object, and Pages resources. It deploys from
the `staging` branch or a manual **Deploy Staging** workflow run. No staging identifier or provider
credential is committed to the repository.

## Provision Cloudflare resources

Create these resources in the staging Cloudflare account (or in the production account with names and
access tokens scoped only to staging):

```sh
npx wrangler d1 create mogi-platform-staging
npx wrangler kv namespace create mogi-cache-staging
npx wrangler kv namespace create mogi-cart-staging
npx wrangler pages project create avery-admin-staging --production-branch staging
```

Choose a unique Worker name such as `mogi-platform-staging`. Durable Object storage is isolated by the
Worker name and is created during the first deployment. The staging config intentionally declares no
cron triggers, preventing unattended billing, retention, reminders, and provider checks.

Create a Cloudflare API token limited to the account and staging resources. It needs Workers Scripts,
D1, Workers KV, and Pages edit permissions. Do not reuse the production deployment token.

## Configure the GitHub staging environment

Create a protected GitHub environment named `staging`. Add approval rules if staging can contact real
providers. Configure these environment **variables**:

| Variable | Purpose |
| --- | --- |
| `STAGING_WORKER_NAME` | Unique Worker script name |
| `STAGING_WORKER_URL` | Deployed Worker base URL, HTTPS only |
| `STAGING_D1_DATABASE_NAME` | Dedicated D1 database name |
| `STAGING_D1_DATABASE_ID` | Dedicated D1 database UUID |
| `STAGING_CACHE_KV_ID` | Dedicated cache KV namespace ID |
| `STAGING_CART_KV_ID` | Dedicated cart KV namespace ID |
| `STAGING_PAGES_PROJECT` | Dedicated Pages project name |
| `STAGING_WEB_URL` | Stable Pages/custom-domain URL used by the smoke test |

Configure these environment **secrets**:

| Secret | Purpose |
| --- | --- |
| `STAGING_CLOUDFLARE_ACCOUNT_ID` | Account containing staging resources |
| `STAGING_CLOUDFLARE_API_TOKEN` | Staging-scoped deployment token |
| `STAGING_WORKER_SECRETS_JSON` | Required JSON object uploaded with `wrangler secret bulk` |

`STAGING_WORKER_SECRETS_JSON` must contain staging-only values. At minimum, configure every secret
required by the fail-closed production mode for the flows under test. For example:

```json
{
  "TOKEN_SECRET": "replace-with-a-long-random-staging-value",
  "CUSTOMER_HASH_SALT": "replace-with-a-different-staging-value",
  "ADMIN_SECRET": "replace-with-a-staging-admin-value"
}
```

Add provider keys only for integrations intentionally exercised in staging. Use provider sandbox/test
accounts and staging webhook URLs. Never copy production signing keys, customer data, or database IDs.

## Deployment and migration safety

The workflow in `.github/workflows/deploy-staging.yml` performs these gates in order:

1. Runs the reusable repository CI workflow.
2. Validates every resource input and rejects known production default names.
3. Runs `npm run db:validate` against disposable local D1 state.
4. Renders `worker/wrangler.staging.toml` with the isolated resource IDs.
5. Applies forward-only migrations to the staging D1 database.
6. Deploys the Worker, then synchronizes staging-only Worker secrets.
7. Requires `/health?deep=1` to report D1 and KV healthy.
8. Builds Pages with the staging Worker URL, deploys it, and requires an HTTP 2xx response.

Deployments are serialized and cannot be cancelled in progress. Migrations still must follow the
expand-contract policy in `docs/database-migrations.md`; a successful staging migration does not make a
destructive migration safe for production. Because D1 migrations are forward-only, correct failures
with a new migration rather than rewriting a migration already applied to staging.

## Validate and operate staging

Before the first deployment, verify that every staging ID differs from production and that both URLs
resolve to the intended resources. Run the workflow manually from GitHub Actions, or push the reviewed
commit to the `staging` branch.

After deployment:

```sh
curl --fail --show-error "$STAGING_WORKER_URL/health?deep=1"
curl --fail --show-error --head "$STAGING_WEB_URL"
```

Confirm the Worker response contains `"db":"ok"` and `"kv":"ok"`. Exercise login and one non-billable
test flow in the UI. When enabling a provider, validate its webhook against the staging Worker URL and
confirm no production phone number, billing account, recipient list, or calendar is connected.

For rollback, redeploy a previously healthy Worker commit only when it remains compatible with all
applied staging migrations. Otherwise roll forward with a corrective Worker or migration. Pages can be
rolled back independently in the Cloudflare dashboard after confirming its API target remains staging.
