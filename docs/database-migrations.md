# Database migration policy

This runbook covers D1 schema changes in `worker/drizzle`. Production migrations run before the
new Worker is deployed, so every migration must be safe while the currently deployed Worker is
still serving traffic.

## Expand-contract policy

Use two or more releases for an incompatible schema change:

1. **Expand:** add nullable columns, tables, or indexes. Do not rename or remove objects, tighten
   constraints, or change the meaning of existing values. Defaults must preserve current behavior.
2. **Transition:** deploy code that can read both representations and writes both when necessary.
   Backfill in bounded, restartable batches and measure completion before proceeding.
3. **Contract:** only after all deployed code uses the new representation and the backfill is
   verified, remove compatibility code and obsolete schema objects in a later migration.

SQLite table rebuilds, destructive DML, column renames, `NOT NULL` changes, and uniqueness changes
require a written rollout and recovery plan in the pull request. Prefer creating a replacement table,
dual-writing, backfilling, and switching reads over an in-place destructive change.

## Authoring rules

- Never edit or reorder a migration after it has been applied to any shared environment.
- Name files `NNNN_lowercase_description.sql` with a unique four-digit sequence. Gaps are allowed;
  sequence reuse is not.
- Keep `worker/schema.sql` as the fresh-database baseline. A new migration must apply after that
  baseline and after every existing migration.
- Make expansion migrations safe for the old Worker and safe if the new Worker deployment fails.
- Separate schema expansion, data backfill, and contraction when any step can be long-running.
- Do not put production-only assumptions or credentials in migrations.

## Local validation

From `worker`, install dependencies and run:

```sh
npm run db:validate
```

The command checks migration naming, unique ordering, and non-empty SQL. It then creates a disposable
local D1 state directory, loads `schema.sql`, applies all migrations in order, and applies them a second
time to verify there are no pending migrations. It deletes the temporary database afterward and never
uses `--remote` or production credentials.

Run `npm run db:validate`, `npm run type-check`, and `npm test` before merging a schema change.

## Production rollout

1. Review the migration as an expand, transition, or contract step and record its compatibility window.
2. Confirm `npm run db:validate` and Worker checks pass from a clean checkout.
3. Merge only when the existing production Worker tolerates the migration. The deployment workflow
   applies D1 migrations before uploading the new Worker.
4. After deployment, verify `/health?deep=1`, migration status, and the affected user flow.
5. Keep compatibility reads/writes until the backfill and rollback window are complete.

## Failure and recovery

D1 migrations are forward-only. Do not rename a failed migration or attempt to make production history
match a local rewrite.

- **Migration fails before deployment:** stop the release. Inspect the D1 error and migration status,
  then add a new corrective migration or fix the unapplied migration if it has never reached a shared
  environment.
- **Migration succeeds but Worker deployment fails:** keep the existing Worker running. Expansion
  compatibility makes the added schema inert. Fix the deployment and roll forward.
- **New Worker is unhealthy:** redeploy the previous Worker version only if it remains compatible with
  the expanded schema; otherwise deploy a corrective Worker. Do not reverse schema changes in place.
- **Backfill fails:** stop the backfill, preserve its checkpoint, correct the job, and resume. Reads must
  continue supporting both representations until completion is verified.
- **Contract step causes failure:** deploy a corrective migration and compatible Worker. Restore data
  from the approved D1 backup/time-travel procedure when data was removed or corrupted.

For every incident, capture the last successfully applied migration, Worker version, timestamps, and
health-check output before taking corrective action.
