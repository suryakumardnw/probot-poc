# Dependency audit follow-ups

Date: 2026-11-15 · Command: `npm run security:audit`

`npm run security:audit` wraps `npm audit --audit-level=high` and fails CI when
a high or critical advisory is not explicitly allowlisted. The allowlist lives
in [`scripts/npm-audit-allowlist.json`](../scripts/npm-audit-allowlist.json), so
a new advisory cannot be hidden by the existing exemptions. Remove an entry as
soon as its upgrade lands; the script warns about stale entries.

The audit is a dependency-vulnerability gate, not a secret scan. The
`Security` CI job also runs gitleaks.

## Current allowlist

| Advisory | Severity | Affected package | Why it is allowlisted | Follow-up |
|---|---|---|---|---|
| `GHSA-ggr8-5vv4-36mx` | high | `deepmerge-ts` via `@prisma/config` | Prisma 6 CLI dependency; the fix requires Prisma 7. | Upgrade Prisma to 7.x. |
| `GHSA-5gmw-xhrv-c9v3` | critical | `tinypool` via `vitest` | Test-runner only; the fix requires Vitest 5. | Upgrade Vitest to 5.x. |
| `GHSA-85c8-ppgw-ccpr` | critical | `tinypool` via `vitest` | Test-runner only; the fix requires Vitest 5. | Upgrade Vitest to 5.x. |
| `GHSA-mrhx-c7xc-m3w5` | high | `zod` via `@opencode/sdk`'s `gitlab-ai-provider` | Transitive optional provider; npm reports no fix. | Upgrade `@opencode/sdk` when the provider ships a fixed `zod`. |

At the time of writing, `npm audit` reports 43 vulnerabilities in total:
35 moderate, 6 high, and 2 critical. Only the four unique high/critical
advisory IDs above are allowlisted; every moderate and low advisory remains
visible in `npm audit` output but does not cross the `--audit-level=high`
threshold.

## Adding an entry

1. Confirm the advisory has no non-breaking upgrade path.
2. Add the GHSA ID, affected package, reason, and follow-up to
   `scripts/npm-audit-allowlist.json`.
3. Update this table and the `Security` job note in `.github/workflows/ci.yml`.
4. Open a follow-up issue for the upgrade.

Entries without a GHSA ID cannot be allowlisted; the script fails closed.
