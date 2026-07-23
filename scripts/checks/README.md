# Checks

Standalone inspection scripts for the AI case-review feature. Each prints
`PASS`/`FAIL` per assertion and exits non-zero on failure — run one to look at
one thing, rather than running a whole suite. They complement the jest tests;
they do not replace them.

```bash
npm run check                      # list available checks
npm run check 02-issue-sync        # run one
```

## Test database

Checks never touch the development database. `npm run check` overrides
`DATABASE_URL` in the child process with `TEST_DATABASE_URL` before any
application module loads — `src/db/client.ts` builds both `systemDb` and every
`createTenantDb` connection from it, so the whole app (RLS tenant connections
included) moves onto the test database with no test-only branch in `src/`.

```bash
npm run test:db:setup    # create the database if absent, then migrate (idempotent)
npm run test:db:clear    # truncate every table, keep the schema
npm run test:db:drop     # drop the database entirely
```

Set `TEST_DATABASE_URL` (or `TEST_DATABASE_NAME`, which is swapped into
`DATABASE_URL`). Setup refuses to run if it resolves to the same database as
`DATABASE_URL`, or with `NODE_ENV=production`.

`test:db:setup` also creates `get_current_organization_id()` and
`get_current_user_id()`. The RLS policies in `src/db/schema/rls.ts` reference
them but no migration creates them, so a fresh database cannot apply the policy
migrations without this step.

Each check seeds a uniquely-named throwaway organization and removes it in a
`finally`, so a passing run leaves nothing behind. Use `test:db:clear` to mop up
after a crash.

## Tiers

| Script | Needs | What it inspects |
|---|---|---|
| `01-case-review-logic` | nothing | Fingerprint identity/revision, normalisation, the date-like gate |
| `02-issue-sync` | Postgres | Diff engine: NEW → UNCHANGED → CHANGED → SUPERSEDED → REOPEN, sweep guard, RLS isolation |
| `03-wire-contract` | Postgres | Request built from a real scenario; wire parity with the Python service |
| `04-live-storage` | R2 | Upload/download round trip, presigned URLs, remove, checksum parity with the Python worker |
| `05-queue` | Postgres + Redis | Producer: job row, coalescing, the payload on the queue. Consumer: cache write, terminal status, idempotency |
| `06-roundtrip` | Postgres + Redis | The real cross-language seam, end to end |

## Tier 2 — the queue round trip

`06-roundtrip` is the only check that crosses the language boundary for real:

```
backend enqueues on `ai-scan`
  → Python worker (real build_handler, stubbed AI clients) consumes it
  → publishes to `ai-scan-results`
  → backend's real result worker consumes and persists
```

It spawns the Python bridge as a subprocess, so it is one command rather than a
three-terminal dance:

```bash
npm run check 06-roundtrip
```

Set `ORAVANTI_AI` if the AI service repo is not a sibling directory. No Google
or R2 calls happen — the bridge stubs the pipeline's three billable
collaborators. Under test is the transport, the payload contract across
languages, and the persistence that follows; not extraction quality.

`05-queue` covers each side separately (and more thoroughly) without involving
Python at all.

## Tier 3 — live checks

`04-live-storage` calls Cloudflare R2 for real. It is gated: without `--live` (or
`ORAVANTI_LIVE=1`) it prints a notice and exits 0.

```bash
npm run check 04-live-storage -- --live
```

Everything it uploads is removed in a `finally`.

It asserts that `computeChecksum` produces a fixed, out-of-band-verified sha256
constant. The Python side asserts the same constant in `01_contract.py`. This
matters because the worker's `read_verified` rejects any document whose bytes do
not hash to the checksum the backend sent — if the two implementations ever
diverged, every scan would fail that guard.

The AI service's own Tier 3 checks (live Document AI, Gemini, and the full
pipeline) live in the `oravanti-ai-detection-server` repo under
`scripts/checks/`.

## Writing a check

Import from `_bootstrap`:

- `withTempFixture(spec, fn)` — seeds org/user/lead/documents/analyses, tears down after.
- `withOrgContext(orgId, userId, fn)` — runs `fn` inside the AsyncLocalStorage
  request context bound to a tenant connection. **Required for anything that
  queries `db`**: outside a context the `db` Proxy falls back to `systemDb`,
  which bypasses RLS, and the check would pass for the wrong reason.
- `check` / `checkEqual` / `section` / `report`.

## Known gap

`02-issue-sync` has one **intentionally failing** assertion: `case_issues`,
`case_issue_documents`, `case_issue_events` and `ai_scan_jobs` have RLS disabled
and zero policies, so another tenant's connection can read them. `leads`,
`cases` and `clients` all have policies. Tenant scoping for these tables is
currently application-level only (the services filter by `organizationId`), so
the API does not leak — but the defence-in-depth layer dev added is missing
here. The assertion stays red until policies are added or the model is
deliberately changed.

`document_analyses` is excluded from that list on purpose: it is a
content-addressed cache keyed on `(checksum, prompt_version, model_version)`
with no organization column, by design.

## Not covered

- **The reconciliation sweep.** `reconcileStuckScans` (jobs that never reported
  back) and `markScanRunning` off the queue's `active` event are not exercised.
- **The deterministic sweep on a schedule.** `sweepDeterministicIssues` is
  covered only through `02-issue-sync`'s `includeScanRules` flag, not as a timed
  job.
- **Real AI in the round trip.** `06-roundtrip` stubs the model calls. The live
  pipeline is covered separately by the AI repo's `07_live_scan.py`; no check
  runs a real scan all the way through the queue.
