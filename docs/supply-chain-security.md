# Supply-chain security

The `Supply chain` GitHub Actions workflow protects the deployable Worker and web application. It runs on pull requests, pushes to `main`, and manual dispatches.

## Controls

- **Production dependency audit:** `npm audit --omit=dev --audit-level=high` runs independently against `worker/package-lock.json` and `web/package-lock.json`. A high or critical production vulnerability fails the job.
- **Software bills of materials:** each application is installed from its lockfile with lifecycle scripts disabled, then `npm sbom` produces a CycloneDX JSON artifact containing production dependencies. The `worker-production-sbom` and `web-production-sbom` artifacts are retained for 30 days.
- **Secret scanning:** Gitleaks scans the complete checked-out Git history and current contents using its maintained default rules plus `.gitleaks.toml`.

Campaign paths are excluded from the application secret gate because they contain recipient and generated campaign data that produces recurring false positives and is governed by separate campaign workflows. Do not use the exclusion to store credentials: campaign automation must continue to obtain credentials from GitHub Actions secrets.

## Remediation

### Dependency findings

1. Confirm the finding affects a production dependency, not only development tooling.
2. Upgrade the direct dependency or refresh the lockfile to a patched transitive version.
3. Run `npm audit --omit=dev --audit-level=high` in the affected application directory and execute that application's tests.
4. If no patched version exists, remove or replace the dependency where practical.

Do not use `npm audit fix --force` without reviewing the resulting major-version changes and running the complete application test suite.

### Secret findings

Treat every detected credential as compromised. Revoke or rotate it first, remove it from the repository and relevant history, then rerun Gitleaks. Removing a value from the latest commit does not make a committed secret safe.

False positives should be suppressed as narrowly as possible in `.gitleaks.toml`, preferably by a rule identifier plus an exact path or value fingerprint. Never allowlist a broad source directory, generic token shape, or real credential. Each exception must include a description explaining why the value is not a secret and should be reviewed with the pull request.

## Exceptions

High or critical production dependency findings are blocking by default. A temporary exception requires a tracked security issue containing:

- the advisory identifier and affected component;
- evidence that the vulnerable behavior is unreachable or otherwise mitigated;
- an owner and expiration date;
- a concrete upgrade, replacement, or removal plan.

Implement an approved audit exception as a narrowly scoped, documented CI step rather than lowering the repository-wide severity threshold. Remove it when the exception expires. Secret findings do not receive risk-acceptance exceptions; rotate and remove the credential.

## Local verification

Run the same dependency checks locally:

```sh
(cd worker && npm audit --omit=dev --audit-level=high)
(cd web && npm audit --omit=dev --audit-level=high)
```

With Gitleaks installed, run:

```sh
gitleaks git --config .gitleaks.toml --redact
```

SBOM generation requires the lockfile dependencies to be installed:

```sh
(cd worker && npm ci --omit=dev --ignore-scripts && npm sbom --omit=dev --sbom-format=cyclonedx > worker-sbom.cdx.json)
(cd web && npm ci --omit=dev --ignore-scripts && npm sbom --omit=dev --sbom-format=cyclonedx > web-sbom.cdx.json)
```

SBOM files are CI artifacts and should not be committed.
