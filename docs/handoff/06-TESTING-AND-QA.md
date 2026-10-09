# 6. Testing and QA

Three layers of checks protect the system: **automated tests** on every code change, **secret scanning** on every
commit, and a **live smoke test** against the real deployment.

| Layer | Count | Runs |
|---|---|---|
| Unit tests (web app) | **54** tests in 7 files | Every push (GitHub Actions) and locally: `cd web && npm test` |
| Database checks | **77** checks | Every push, against Supabase's own Postgres image; locally: `bash supabase/tests/run.sh` (needs Docker) |
| Type checks and production build | Web app and HubSpot card | Every push |
| Secret scan | Full git history | Every push (CI), and on every commit (local hook) |
| Live smoke test | 16 checks | On demand: `node scripts/smoke-test.mjs --yes` |

> The first release candidate had 51 unit tests and 71 database checks. On 9 October 2026, 3 unit tests and 6
> database checks were added with the fixes from the first smoke test (described below).

## What the unit tests cover (54)

| Area | What is proven |
|---|---|
| **Request signatures** (7) | Valid HubSpot v3 signatures are accepted for GET and POST. Tampered queries, stale or future timestamps, missing headers and wrong-length signatures are rejected. Internal endpoints accept only the exact secret. |
| **HubSpot client** (7) | Rate limits are honoured (`Retry-After`). 5xx and network errors are retried up to 3 times. Other 4xx errors fail permanently. Find-or-create never overwrites an existing contact, and a parallel create is resolved to the winner. |
| **HubSpot → database** (12) | The echo rule drops the app's own writes; other integrations' writes are processed. Current state is fetched rather than trusting the event. Non-demo contacts are never stored. Deletes, merges and 404s are handled, and the de-duplication key is correct. |
| **Database → HubSpot** (7) | Roll-ups patch the three properties correctly. Unlinked customers wait (with a 24-hour safety limit). Linking never overwrites a HubSpot name. Out-of-domain customers are refused. |
| **Job runner** (2) | Successes finish; errors fail as permanent or retryable; rows that cannot start before the deadline are handed back. |
| **Quote form** (9) | Validation (demo emails only), duplicate detection, step-by-step resume after failure, reuse of a deal created by an earlier attempt, and no HubSpot calls for a completed duplicate. |
| **Daily job** (3) | Paging through recent contacts, resolving missing ones, isolating a failing contact, pruning even when out of time. |
| **Routes** (7) | Every endpoint rejects unauthenticated requests before touching the database. The webhook logs duplicates as ignored. |

## What the database checks cover (77)

| Area | What is proven |
|---|---|
| **Access control** | The public (`anon`) role cannot read data or call functions; only the server role can. |
| **Queueing** | App-created customers queue a link job; HubSpot-mirrored ones queue nothing (loop safety). A burst of order changes merges into one job. Customers with orders cannot be hard-deleted. |
| **Job lifecycle** | Claiming, no double claims, reclaiming stale work, back-off, parking after the final attempt, re-queue and release. |
| **Contact sync rules** | Insert, update, stale (older) data ignored, unchanged data only advances the timestamp, linking by email, email conflicts, soft delete clears personal data, restore, merge, and a late delete never overriding a later restore. |
| **Roll-ups and card** | Cancelled orders are excluded; the card query pages correctly. |
| **Form and rate limits** | Duplicate submissions, in-progress protection, resume timing, 24-hour window, rate-limit blocking. |
| **Scheduler and Vault** | The work signal uses the Vault address and secret, is a silent no-op without them, and is scheduled every minute. |
| **Retention, reset and seed** | Pruning old rows; the demo reset leaves nothing behind; seeding queues one roll-up per customer and no link work. |

## Continuous integration and secret scanning

- **`ci` workflow** (GitHub Actions, every push and pull request): unit tests, type check and production build of the
  web app; type check of the HubSpot card; migrations and database checks against `supabase/postgres:17.11.0.004`.
- **`secret-scan` workflow:** gitleaks 8.30.1 scans the **entire git history** and prints any findings redacted.
- **Local pre-commit hook:** gitleaks scans staged changes before every commit
  (`git config core.hooksPath scripts/hooks`).
- **Latest results:** commit `7706ac3` (9 October 2026, 04:45 UTC): `ci` **passed** and `secret-scan` **passed**. The
  three previous commits passed both workflows too.

## Live smoke test results

Full evidence: [docs/SMOKE-TEST.md](../SMOKE-TEST.md).

### Run 1: 9 October 2026, 04:20–04:25 UTC. **PASS (5 of 5 steps)**

| Check | Result |
|---|---|
| A human edit in HubSpot (phone number) reached the database once, with no write back to HubSpot | PASS (database updated 3.4 s after the edit) |
| One new order caused exactly one HubSpot update of the three totals, one history entry each, and no echo | PASS |
| Replaying an already-processed webhook was de-duplicated; a stale signature was refused | PASS |
| Demo reset restored the seed state | PASS |

This run found four improvements (not defects): duplicates were invisible on `/activity`, `/activity` used different
IDs per direction, contact rows were rewritten without change, and there was no repeatable smoke script. All four were
fixed, tested and deployed the same day.

### Run 2, after the fixes: 9 October 2026, 04:42–04:45 UTC. **PASS (16 of 16 checks)**

Run with the new `scripts/smoke-test.mjs` against production (commit `2a5f802`):

| Step | Result |
|---|---|
| 1. HubSpot UI edit (last name) → database | 5/5: one event, database updated, shown on `/activity`, zero outbound jobs, zero HubSpot writes |
| 2. New order → HubSpot | 6/6: one roll-up job, correct values (3 → 4 orders, 1080.29 → 1203.74), one history entry each, no echo, `/activity` shows the HubSpot contact ID, cleanup restored the totals |
| 3. Idempotency | 5/5: replay accepted but not stored again, "1 duplicate ignored" on `/activity`, nothing re-processed, stale signature refused (401) |
| Restore | Demo reset completed, 0 parked jobs |

## How to re-test after any change

1. `cd web && npm test && npm run typecheck`
2. `bash supabase/tests/run.sh` (if SQL changed; apply with `bash scripts/migrate.sh`)
3. Push, and confirm both GitHub Actions workflows pass.
4. `node scripts/smoke-test.mjs --yes`, then `node scripts/demo-reset.mjs --yes`.
