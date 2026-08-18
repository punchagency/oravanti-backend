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
| `02-issue-sync` | Postgres | Diff engine: NEW → UNCHANGED → CHANGED → SUPERSEDED → REOPEN, sweep guard |
| `03-wire-contract` | Postgres | Request built from a real scenario; wire parity with the Python service |
| `04-live-storage` | R2 | Upload/download round trip, presigned URLs, remove, checksum parity with the Python worker |
| `05-queue` | Postgres + Redis | Producer: job row, coalescing, the payload on the queue. Consumer: cache write, terminal status, idempotency |
| `06-roundtrip` | Postgres + Redis | The real cross-language seam, end to end |
| `07-rls` | Postgres | Proves tenant isolation using a role RLS applies to; audits policy coverage |
| `08-reconcile-sweep` | Postgres | Stuck-job reconciliation and the time-driven deterministic sweep |
| `09-live-roundtrip` | Everything | The whole system with nothing stubbed |
| `14-confido-sandbox` | Confido sandbox token | Firm onboarding + trust/operating payment routing. Network only — touches no tables |
| `15-confido-partial-payment` | Confido sandbox token + a browser | How Confido splits a **partial** payment across the trust and operating legs |
| `16-confido-onboarding` | Postgres | The concurrency and idempotency behind firm onboarding. No network |
| `17-confido-payments` | Confido sandbox token + Postgres | The three shapes a payment can land in, and that the legs sum to what was paid |

## Tier 3 — Confido Legal sandbox

`14-confido-sandbox` is a throwaway spike, not a permanent regression test. It
answers the questions Confido's docs leave open before we design schema around
them — above all whether one client payment really splits between a trust and an
operating bank account, and how many `Transaction` rows that produces.

```bash
CONFIDO_PARTNER_TOKEN=p_secret_sandbox_… npm run check 14-confido-sandbox
```

It refuses to run against a token whose prefix is not `sandbox`, since every
mutation it makes either creates a firm or moves money. Sandbox firms cannot be
deleted, so each run stamps what it creates with a short run id. Findings are
printed as a `NOTE` block at the end; delete the script once the real provider
lands. See `confido_legal_integration.md` in the repo root.

`15-confido-partial-payment` answers the one question `14` cannot. A partial
payment can only be made by a real payer choosing their own amount on the hosted
page — `recordManualPaymentOnPaymentLink` requires an explicit allocation, so the
API only ever returns the split we asked for. It runs in two phases:

```bash
npm run check 15-confido-partial-payment -- create      # prints a link to pay in a browser
npm run check 15-confido-partial-payment -- inspect     # reports which rule Confido used
npm run check 15-confido-partial-payment -- ach-return  # settles an ACH leg, then returns it
```

`create` builds a deliberately lopsided link ($500 trust / $1,500 operating) and
asks for a $200 payment — less than the trust leg alone, so trust-first,
operating-first and pro-rata each give a visibly different answer. `inspect`
compares what actually happened against all three and says whether the processor
agrees with our trust-first policy. Pass `--new` to start a fresh firm.

`ach-return` answers the question that decides the refund schema. It settles an
`achPayment` leg (`FUNDS_IN_TRANSIT` → `DEPOSITED`) before returning it, because
returns happen to money that has already landed — firing at a `PENDING`
transaction would test something that does not occur in production. It then
reports what the return did: only the returned leg unwinds, the original flips to
`RETURNED`, and a **separate `achReturn` row with a positive amount** points back
at it. Needs an ACH payment on the link first.

State lives in `.confido-partial.json` (gitignored, `0600` — it holds a firm API
token). Delete it to start over.

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

## RLS

`07-rls` is the authority here, and it is worth reading its header before
trusting any claim about tenant isolation.

Postgres skips row-level security for superusers, for roles with `BYPASSRLS`,
and for a table's owner unless `FORCE ROW LEVEL SECURITY` is set. The
application's role is all three, so **no policy engages on the connection the
app uses** — verified empirically, not assumed. `07-rls` therefore connects as
`oravanti_rls_probe` (created by `test:db:setup`: NOSUPERUSER, NOBYPASSRLS, not
the owner) to prove the policies themselves are correct, and separately reports
that the app role is exempt.

This is why `02-issue-sync` does not assert isolation: on the app connection
that would measure the role exemption, not the policy.

Policies must be **permissive**, not restrictive. Restrictive policies are AND-ed
with permissive ones, and a table whose only policy is restrictive matches
nothing at all. `07-rls` audits this each run and names any restrictive-only
table.

`document_analyses` is deliberately uncovered: it is a content-addressed cache
keyed on `(checksum, prompt_version, model_version)` with no organization
column, by design.

## Not covered

- **Extraction accuracy.** Every check asserts shape and configuration. Whether
  Gemini reads a given field *correctly* is not asserted and cannot be without a
  labelled corpus.
- **Multi-page OCR.** `imageless_mode` raises the ceiling to 30 pages; every
  sample is single-page.
- **RLS in production.** `07-rls` proves the policies are correct, but the
  application connects as a superuser/owner with BYPASSRLS, so none of them
  engage. See the warning that check prints.
- **`leads`, `lead_events`, `lead_notes` are restrictive-only** and will deny all
  access the moment RLS does engage. Reported by `07-rls`, not fixed here — they
  are dev's policies.
