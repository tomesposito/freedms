# Scale test: seed generator + latency harness

Issue #49. Local only. This tooling seeds synthetic data through the HTTP
API and measures hot-path latency against pre-set budgets. It reports
budget failures; it does not fix endpoints.

Files: `scripts/scale-lib.ts` (pure profiles, generators, percentile and
budget helpers), `scripts/scale-seed.ts`, `scripts/scale-measure.ts`.
Unit tests for the pure helpers: `packages/api/test/scale.test.ts`.

## Run it

Start the local API first (in-memory stack on `http://127.0.0.1:3001`),
then:

```sh
node --import tsx packages/api/src/local.ts # run in a separate terminal
node --import tsx scripts/scale-seed.ts --profile smoke
node --import tsx scripts/scale-measure.ts --state scale-state.json --out scale-results.json --report scale-report.md
```

The default state path is `scale-state.json` for both local CLIs.
`--state`, `--out` (default `scale-results.json`) and `--report` select
output paths; markdown is always printed.

`npm run scale:seed` / `npm run scale:measure` do the same. Both CLIs
accept `--help`. Base URL: `--base-url` or `FREEDMS_SCALE_BASE_URL`
(default `http://127.0.0.1:3001`). Against a hosted environment, set
`FREEDMS_SCALE_TOKEN` as well; `/local/session` is then never called.
A token seeds/measures only its own tenant; light tenants are skipped.
No credentials are stored. Tokens are supplied through the environment only.

## Profiles

- `--profile full` (default): heavy tenant = 10,000 lifetime vehicles
  (100 left in stock), 150,000 leads, 30,000 customers, 8,000 deals,
  50,000 repair orders, 250 parts, 12 appointments; plus 1,000 light
  tenants with 30 vehicles, 200 leads, 200 repair orders, 20 parts each.
- `--profile smoke`: heavy = 60 vehicles, 120 leads, 15 deals, 40 repair
  orders; 3 light tenants with 10 vehicles, 25 leads, 10 repair orders
  each. Proves the whole pipeline in a couple of minutes.

Count flags, with either `--heavy-` or `--light-` prefixes, are
`vehicles` (alias `lifetime-vehicles`), `in-stock`, `leads`, `customers`,
`deals`, `repair-orders` (alias `ros`), `parts`, and `appointments`.
`--light-tenants` controls tenant count. Every count can be overridden, e.g.
`--heavy-leads 12000 --light-tenants 25 --heavy-repair-orders 500`.
Other flags: `--concurrency <n>` (seed, default 1), `--maxMinutes <n>`
(alias `--max-minutes`; seed soft cap: stops cleanly and still prints/writes actual counts),
`--requests <n>` / `--peak <n>` / `--ten-x <n>` / `--light-sample <n>`
(measure; defaults 100 requests per endpoint per level, peak 5, 10x 50,
up to 5 light tenants sampled).

## How seeding works

Tenants are created with `POST /local/session` using the onboarding
variant (`{onboarding: true, name, email, dealership, address, phone,
dealerType, invites: []}`), deliberately: it stores the admin's email, so
later `POST /local/session {tenantId, email}` re-session works when a
token expires (local tokens last 1 hour; on 401 the client re-sessions
and retries once). The seed CLI writes `scale-state.json` with tenant
ids, admin emails and actual created counts. It never stores or prints
tokens. The measure CLI re-sessions from that state file at run time.

Per tenant, in order: vehicles, a customer pool (roughly leads/5
distinct customers, reused for leads, deals and repair orders), leads,
follow-up tasks on every fifth lead (plus a stage advance on a share via
the lead PUT), deals, parts, repair orders, and a few appointments dated
today for the service board.

Details worth knowing:

- Deal vehicles are sold through deals: create, PUT `approved`, PUT
  `sold` (which writes the GL deal posting). All seeded deals are sold,
  preserving the exact in-stock target.
  Deal counts must not exceed lifetime vehicles minus in-stock vehicles or
  the lead count; leads and service records require a nonempty customer pool.
- Surplus lifetime vehicles (lifetime − in-stock − sold-through-deals)
  are created directly with status `sold`. The vehicle input accepts
  `sold` (it is one of the app's vehicle statuses), so no API was
  invented for this.
- Every second repair order is finalized with PUT status `completed`,
  so service GL postings exist at scale.
- Money is integer cents everywhere. Names and emails are synthetic
  (`Scale Buyer 000123`, `scale-buyer-123@example.test`). No real data.

## Budgets and output

- Read endpoints: p95 < 300 ms. Report endpoints (trial balance,
  department statement, sales/inventory/forecast reports): p95 < 1,000 ms.
- Pencil calculation is a write path (`PUT /deals/:id` on a scratch deal
  the harness creates, changing the working pencil's `down` by a few
  cents). It uses the 300 ms read budget, is labelled `pencil`, and is
  run at the requested concurrency using one scratch deal per worker,
  with sequential version-checked updates within each worker. Setup adds
  up to max(peak, 10x) vehicles, customers and deals, reported separately
  from seed counts. Scratch records remain in the tenant after measurement.
- Percentiles are nearest-rank (in `scale-lib.ts`, unit-tested).
- Any non-200 response counts as an error and fails that endpoint.
- The measure CLI prints a self-contained markdown report (environment,
  dataset actually seeded, per-endpoint p50/p95/max at peak and 10x,
  PASS/FAIL per endpoint, explicit failure list) and writes the same
  results as JSON with `--out`. That markdown is what gets posted on the
  issue. Failures list endpoint, budget and measured p95 so follow-up
  issues can be filed from it.

Measured endpoints on the heavy tenant: `GET /vehicles`,
`GET /reports/inventory`, `GET /leads`, `GET /reports/leads`,
`GET /service/board?date=<today>`, `GET /accounting/trial-balance`,
`GET /accounting/departmental`, `GET /reports/sales`,
`GET /reports/forecasts`, and the
pencil PUT. Accounting, sales and forecast requests use `from=2000-01-01`
and `to=<today>`; other reports use their defaults. Light-tenant samples
run the GET endpoints only. Each endpoint runs 100 requests at each level
before the next endpoint starts; JSON retains every latency and status
(status 0 means a transport failure). Budget failures remain in the output
and do not set a failing exit code; setup failures do.

## Honest limits

- Local seeding cost grows with tenant size: creating records through
  the API on the local in-memory stack gets slower per write as a tenant
  grows (measured before this harness existed at roughly 2 ms per lead
  on an empty tenant and roughly 10 ms each at 3,000 customers). A full
  local seed is therefore a long run — hours, not minutes. Use
  `--profile smoke` or count overrides plus `--maxMinutes` for bounded
  probes; the seed summary always reports actual counts created, and
  the state file records whether a run was truncated.
- The local stack is an in-memory implementation on one machine.
  Numbers from it are a local measurement, not hosted capacity evidence.
  Re-run against a hosted environment with only `--base-url` and
  `FREEDMS_SCALE_TOKEN` changed.
- The harness does not check for cross-tenant reads or unbounded scans
  in endpoint code; it measures latency and errors only.

API-created records have current creation/posting timestamps: the full
profile models ten years of record volume, not ten years of dated history.
Surplus sold vehicles have no associated deal posting; parts lines are
unlinked synthetic charges, with stocked parts seeded separately.

## Inventory pagination (#51)

`GET /vehicles` returns a page (default `limit=100`, maximum 500, default
`offset=0`). The envelope includes `data`, `total`, `limit`, and `offset`;
status/search filters and createdAt descending, id ascending ordering apply
before paging. The unchanged harness measures the bounded first page.
Memory reads clone only that page. Dynamo still queries all tenant VEHICLE#
records before filtering, sorting and slicing; this is not a Dynamo-side
query optimization. Internal repository `list()` callers still receive all matches.

Local check on 2026-10-28 (Node v24.22.1): seeded the smoke profile with
`--heavy-vehicles 10000 --light-tenants 0` (24 customers, 120 leads,
15 deals, 40 repair orders). Ran the unchanged measure CLI with 100 requests
per endpoint, peak 5 and 10x 50. A repeat run after the build finished measured
inventory-list p95 **55.4 ms / 299.0 ms**, with zero errors; both meet 300 ms,
though the 50-worker result has little headroom. Two measurement runs added
100 scratch vehicles in total beyond the 10,000 seeded vehicles. The first
run overlapped the build and measured 93.7 ms / 797.4 ms. This is an inventory
volume probe, not a reproduction of the full Dataset B customer/lead counts;
other endpoint budgets remain separate follow-ups.

## Lead pagination (#52)

`GET /leads` returns `{data, total, limit, offset}` with default `limit=100`,
maximum 500, and default `offset=0`. Stage, assignee (including unassigned),
and joined customer/source/vehicle-description search filters apply before
createdAt descending, id ascending ordering and paging. The board shows pages
of 100; the unchanged harness measures the bounded first page.

Memory reads build a customer lookup from raw rows, join/filter raw references,
and retain at most offset + limit leads in a bounded heap. Only the returned
leads and their customers are cloned. Orphan leads are excluded from matches.
Dynamo still reads every tenant LEAD# and CUSTOMER# query page before joining,
filtering and paging; pagination bounds returned rows, not Dynamo query work.
Internal `crmList('lead')` and `crmList('customer')` callers still receive all rows.

Local check on 2026-10-28 (Node v24.22.1): seeded the smoke profile with
`--heavy-leads 12000 --heavy-customers 2400 --light-tenants 0` (100 vehicles,
10 deals, 40 repair orders; Dataset A's lead count) and ran the unchanged
measure CLI with 100 requests per endpoint, peak 5 and 10x 50.
Lead-pipeline-board measured p95 **107.0 ms at peak — PASS** and
**430.0 ms at 10x — FAIL** against the 300 ms read budget, with zero errors
at both levels. Before this fix, Dataset A measured p95 4,403 ms at peak and
61,815 ms at 10x with 13 transport errors in 100, so the peak budget is now
met and the 10x result is ~144x faster with the error failures gone; a
sequential (unconcurrent) board read at this dataset takes p50 13.7 ms.
The residual 10x miss is per-request CPU: the memory read still scans the
tenant's full lead set to filter and total, and 50 concurrent scans queue
on a single process. That residual is tracked as a separate follow-up;
Dataset B (49,271 leads) was not re-measured in this check. Other endpoint
budgets remain separate follow-ups.

## Lead pipeline summary (#53)

`GET /reports/leads` and its CSV export now count current raw lead rows in a
single pass. Memory iterates the tenant's CRM map without cloning leads or
building a lead array. Dynamo counts each tenant `LEAD#` query page before
requesting the next, retaining only the aggregate counts. All canonical
stages/sources remain present in domain order, including zero counts; unknown
values contribute only to the total. Counts are recomputed on every request.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-leads 12000 --heavy-customers 2400 --light-tenants 0 --state /tmp/issue53-state.json --maxMinutes 20
node --import tsx scripts/scale-measure.ts --state /tmp/issue53-state.json --out /tmp/issue53-results.json --report /tmp/issue53-report.md
```

The seed completed with 12,000 leads, 2,400 customers, 60 vehicles, 15 deals,
40 repair orders, five parts and three appointments, with no light tenants.
Measurement setup added 50 vehicles, customers and scratch deals. With 100
requests per endpoint per level, lead-summary p95 was **20.7 ms at peak
(concurrency 5)** and **124.9 ms at 10x (concurrency 50)**, both below the
1,000 ms budget, with zero errors. This reproduces Dataset A's lead/customer
volume only; it is not a full Dataset A or B reproduction or hosted capacity
measurement. Build completed before measurement; the offline suite finished
during the harness's initial work. The unchanged harness also reported
out-of-scope 10x misses for the lead board (606.4 ms) and pencil calculation
(634.8 ms), against their 300 ms budgets.

## Service board date-bounded read (#54)

`GET /service/board` selects appointments on the requested UTC day, repair
orders created that day or linked to those appointments (once each), signatures
for those repair orders, and all tenant technicians. Final sorting, status
groups, signature views and technician day loads retain the existing response.
Memory scans raw tenant rows once, resolves links and clones only returned rows.
Dynamo filters each page before requesting the next, reading appointments before
repair orders and signatures after repair orders. It still reads every row of
the four kinds: this bounds retained/materialized rows, not Dynamo-side date
query work. Repository ordering remains insertion order in memory and query/SK
order in Dynamo.

Signature loading is lazy outside the board. RO hashes use a bounded cache keyed
by tenant, RO id and version; every RO write increments its version. Signature
records do not affect the hash; signature views/status are rebuilt on board cache
misses and other RO reads.
The response still contains the full day — all 2,500 ROs in the harness dataset.

The board caches the exact serialized JSON body per tenant and UTC day. After
method, query and date validation, each request reads the tenant service-data
epoch; a matching epoch serves the cached body without cloning rows, rebuilding
views or serializing the board again. A miss retains the epoch read before
computation, so a concurrent service write makes that body ineligible on the
next read. Readers, staff and admins share the same body.

Every successful `crmWrite` containing an appointment, repair order, signature
or technician advances the tenant epoch once, including multi-record batches.
Rejected transactions and other kinds (including leads, parts and journals) do
not advance it. Memory increments a counter during the synchronous apply phase.
Dynamo reads `SERVICEBOARD#EPOCH` consistently (missing means zero) and adds one
conditional epoch Put to the same transaction as the business writes. Concurrent
epoch conflicts reject the transaction through the existing conflict handling.
Epochs and invalidation are isolated per tenant.

The process-local body cache evicts oldest insertions when it exceeds 16 entries
or 32 MiB of UTF-8 body bytes. An individual body over that byte cap is returned
without being cached. The response shape and full-day selection are unchanged.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 2000 --heavy-in-stock 100 --heavy-leads 12000 --heavy-customers 2400 --heavy-deals 400 --heavy-repair-orders 2500 --heavy-parts 60 --heavy-appointments 12 --light-tenants 0 --state /tmp/issue54-state.json --maxMinutes 30
node --import tsx scripts/scale-measure.ts --state /tmp/issue54-state.json
```

Dataset A's heavy tenant only; no light tenants. The board returns all
2,500 repair orders (3,370,857 bytes) because the seed creates them the
same day. With 100 requests per endpoint per level, service-board measured
p95 **296.8 ms at peak (concurrency 5) — PASS** and **2,918.2 ms at 10x
(concurrency 50) — FAIL** against the 300 ms read budget, with zero errors
at both levels. Before this fix, the same dataset measured p95 795.2 ms at
peak and 7,099.8 ms at 10x, and a sequential board read took ~93–148 ms;
after the fix a sequential read is ~55 ms computed cold and ~6 ms served
from the epoch cache. The date-bounded read alone (before the cache)
measured p95 443.0 ms at peak and 4,271.7 ms at 10x.

The residual 10x miss is no longer recomputation: warm reads cost the
server ~6 ms sequentially, and a threaded client burst at concurrency 50
measured p95 129.5 ms. What remains is moving and handling ~337 MB of
board JSON per 100-request batch between the Node measure client and the
Node server on this 2-core local box. That residual is tracked as a
separate follow-up; this is a local in-memory measurement, not hosted
(DynamoDB) capacity evidence, and Dataset B was not re-measured.

## Sales report date-bounded read (#55)

`GET /reports/sales` uses `salesReportRows(range)` to retain only sold deals
inside the inclusive UTC `from`/`to` bounds (null means unbounded). Both backends
share selection logic: use the last sold history entry, falling back to
`updatedAt`. Only vehicles and customers referenced by selected deals are loaded,
once per distinct id. Missing selected references or working pencils still fail
with the existing error; excluded deals do not trigger those lookups.

Memory scans raw tenant CRM rows once, resolves vehicle/customer ids from its
maps, and clones only selected deals and referenced rows. Dynamo filters each
deal page before fetching the next and consistently point-gets referenced
vehicles and customers without listing either set. Dynamo still reads every
deal row: the bound is on retained/materialized rows and related vehicle/customer
sets, not Dynamo-side date query work. The complete report, ordering, integer
cent totals, accounting callers and CSV outputs retain their existing contracts.
The #49 scale harness is unchanged; these checks are local and offline, not
hosted capacity evidence.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 2000 --heavy-in-stock 100 --heavy-leads 12000 --heavy-customers 2400 --heavy-deals 400 --heavy-repair-orders 2500 --heavy-parts 60 --heavy-appointments 12 --light-tenants 0 --state /tmp/issue55-state-a.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue55-state-a.json
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 10000 --heavy-in-stock 100 --heavy-leads 1200 --heavy-customers 30000 --heavy-deals 0 --heavy-repair-orders 0 --heavy-parts 0 --heavy-appointments 0 --light-tenants 0 --state /tmp/issue55-state-b.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue55-state-b.json
```

Dataset A (heavy tenant only, no light tenants), 100 requests per level:
sales report p95 **86.0 ms at peak (concurrency 5) — PASS** and **538.1 ms
at 10x (concurrency 50) — PASS** against the 1,000 ms report budget, zero
errors at both levels. Before this fix the same dataset measured p95
202 ms at peak and 1,439 ms at 10x. A sequential full-range read took
30.3 ms and returned all 400 sold deals; a year-2000 range returned zero
rows, and the CSV export carried the same 400 rows.

Dataset B profile for this endpoint (10,000 vehicles, 30,000 customers,
zero deals; 1,200 leads stood in for the original 49,271 because leads do
not touch the sales report's scaffolding): sales report p95 **31.8 ms at
peak — PASS** and **88.4 ms at 10x — PASS**, zero errors. Before this fix
that profile measured p50 570 ms / p95 1,295 ms at peak and p95 3,721 ms
at 10x — the cost was loading 10,000 vehicles and 30,000 customers to
build a report with no rows. The report no longer loads either set.

These are local in-memory measurements on one shared 2-core box, not
hosted (DynamoDB) capacity evidence.

## Forecast date-bounded read (#56)

`GET /reports/forecasts` uses `forecastRows(window)` with the effective
inclusive basis window computed by the report. Both backends share a selector
that counts unsold vehicles, retains only sold dates and non-no-show
appointment timestamps in the window, and projects counter sales and current
stock-applied RO parts lines into part-id/quantity pairs. The parts catalog is
retained for reorder output. Sold history fallback and the full appointment
timestamp cutoff preserve the existing report semantics.

Previously every request cloned all vehicles, deals, appointments, parts sales
and repair orders, including irrelevant history. Memory now scans raw tenant
rows once and clones only the compact result. Dynamo reduces each tenant-prefix
page before fetching the next; it still reads all rows of those prefixes, so
this bounds retained data, not Dynamo-side query work. Usage totals are computed
in one Map pass instead of filtering all usage for each catalog part. Projection
rounding, sample sizes, methods, insufficient-history messages and ordering are
unchanged. The #49 harness is unchanged; validation is local and offline.

Memory caches the compact forecast rows by a per-tenant forecast epoch and basis
window (from/to), retaining at most four entries and evicting the oldest first.
Successful vehicle creates, updates and deletes (including CRM transaction vehicle
updates), and writes to deals, service appointments, parts, parts sales or repair
orders advance that tenant's epoch. Irrelevant kinds such as leads do not advance
it. Returned rows remain detached from the cache. Dynamo has no forecast cache:
its reads already use kind-scoped prefixes, avoiding the irrelevant customer scan
that dominated the memory Dataset B profile.

Selection retains non-no-show appointments throughout the window, including starts
later today. The shared report applies `scheduledStart <= now` on every request
before computing service sample size and weekday demand, so time advancing without
a write cannot freeze the cutoff in a cached result.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 2000 --heavy-in-stock 100 --heavy-leads 12000 --heavy-customers 2400 --heavy-deals 400 --heavy-repair-orders 2500 --heavy-parts 60 --heavy-appointments 12 --light-tenants 0 --state /tmp/issue56-state-a.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue56-state-a.json
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 10000 --heavy-in-stock 100 --heavy-leads 1200 --heavy-customers 30000 --heavy-deals 0 --heavy-repair-orders 0 --heavy-parts 0 --heavy-appointments 0 --light-tenants 0 --state /tmp/issue56-state-b.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue56-state-b.json
```

Dataset A (heavy tenant only, no light tenants), 100 requests per level:
forecasts p95 **11.2 ms at peak (concurrency 5) — PASS** and **83.4 ms
at 10x (concurrency 50) — PASS** against the 1,000 ms report budget, zero
errors at both levels. Before this fix the same dataset measured p95
375 ms at peak and p50 2,172 ms / p95 2,215 ms at 10x. The bounded read
alone (before the epoch cache) measured p95 53.9 ms at peak and 350.0 ms
at 10x on this dataset.

Dataset B profile for this endpoint (10,000 vehicles, 29,317 customers
seeded before the 40-minute cap stopped the run — leads phase not
reached, as in the original B attempt; zero deals/ROs): forecasts p95
**24.3 ms at peak — PASS** and **50.0 ms at 10x — PASS**, zero errors.
Before this fix that profile measured p95 688 ms at peak and p95
1,773 ms at 10x; the bounded read alone measured p95 299.9 ms at peak
and still failed 10x at 1,361.3 ms, because each request still scanned
all 10,000 vehicles and 30,000+ CRM rows. The epoch cache removes that
repeat scan between writes. Dataset B was measured on a fresh server
holding only that tenant; Dataset A was measured after, in the same
process.

These are local in-memory measurements on one shared 2-core box, not
hosted (DynamoDB) capacity evidence.

## Trial balance compact account aggregates (#57)

`GET /accounting/trial-balance` and `GET /accounting/balances` now use
`accountingBalances(range)` after default-account seeding. A shared selector
visits each journal line once and retains only account metadata and per-account
integer-cent debit/credit sums. Memory scans raw tenant CRM rows on a cache miss
and clones only the compact result; neither endpoint loads the full journal or
rescans its lines separately for each account. A no-op default seed reuses its
first account read instead of listing accounts twice.

Memory caches at most four aggregate results by tenant accounting epoch and
from/to range, evicting the oldest entry first. Only successful journal-entry or
gl-account writes advance the epoch. Irrelevant writes and no-op seed checks
preserve cached results; real default seed writes invalidate them. Each returned
result is detached from the cache. Dynamo has no aggregate cache: it queries
only tenant-scoped `GL-ACCOUNT#` and `JOURNAL-ENTRY#` prefixes, reducing each page
before fetching the next. It still reads all pages of those kinds; the change
bounds retained journal data, not Dynamo-side query work.

Entry dates use `date.slice(0, 10)` with inclusive from/to bounds; null bounds
are unbounded. Rows follow the chart's code order, use current account metadata,
and preserve debit-normal balance signs. Trial balance excludes only rows with
both debit and credit zero, while balances retains all chart rows. Totals sum
returned rows and `balanced` remains exact debit/credit equality. Journal,
departmental, commissions, deals, reversal writes and mutation events retain
their existing behavior. Departmental performance remains separate issue #58.
Validation uses offline tests, including guarded reads, cache behavior, exact
response JSON and paginated Dynamo/memory equivalence. The #49 measurement
harness is unchanged.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 2000 --heavy-in-stock 100 --heavy-leads 12000 --heavy-customers 2400 --heavy-deals 400 --heavy-repair-orders 2500 --heavy-parts 60 --heavy-appointments 12 --light-tenants 0 --state /tmp/issue57-state-a.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue57-state-a.json
```

Dataset A (heavy tenant only, no light tenants), 100 requests per level:
trial balance p95 **41.0 ms at peak (concurrency 5) — PASS** and
**143.5 ms at 10x (concurrency 50) — PASS** against the 1,000 ms report
budget, zero errors at both levels. Before this fix the same dataset
measured p95 182 ms at peak and 2,460 ms at 10x. A warm sequential read
took ~10 ms (median of 10) against 1,650 journal entries, and an
independent recomputation from the raw journal matched every trial-balance
row exactly (totals 1,471,025,000 cents debit = credit, balanced).
Dataset B was not re-measured: its journal was empty in the #49 run, so
it carries no trial-balance evidence either way (the issue says the same).

These are local in-memory measurements on one shared 2-core box, not
hosted (DynamoDB) capacity evidence.

## Departmental statement compact balances (#58)

`GET /accounting/departmental` now seeds the default chart and returns early
from `repo.accountingBalances(range)`, before the full-journal load, reversal
annotation and sorting. Department grouping uses compact account rows; the
shared legacy wrapper keeps `/reports/departments` behavior and data loading.

Memory reuses the tenant-local cache of at most four results keyed by accounting
epoch and date bounds. Successful journal-entry or GL-account writes advance
the epoch; returned rows are detached clones. Cache misses visit each journal
line once. Dynamo still reads all tenant-scoped `GL-ACCOUNT#` and
`JOURNAL-ENTRY#` pages, reducing each before fetching the next: retained journal
data is bounded, but Dynamo query work is not bounded independently of journal
size. Default-account seeding still reads the chart.

The response preserves inclusive date-slice bounds, unbounded ranges, current
account metadata, code-ordered income/expense rows with nonzero debit or credit,
debit-normal signs, all four departments in order, and integer-cent totals.
Reversals remain ordinary entries, including zero-net rows with turnover.
Offline tests compare exact legacy JSON and hand-computed groups across memory
and paginated fake Dynamo, including tenant isolation, scope rejection, boundary
dates, unknown accounts and a journal write after a cached departmental read.
Other endpoints, mutation events and the #49 harness are unchanged.

Local check on 2026-10-28 (Node v24.22.1), using the unchanged #49 harness:

```sh
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 2000 --heavy-in-stock 100 --heavy-leads 12000 --heavy-customers 2400 --heavy-deals 400 --heavy-repair-orders 2500 --heavy-parts 60 --heavy-appointments 12 --light-tenants 0 --state /tmp/issue58-state-a.json --maxMinutes 40
node --import tsx scripts/scale-measure.ts --state /tmp/issue58-state-a.json
```

Dataset A (heavy tenant only, no light tenants), 100 requests per level:
department statement p95 **32.3 ms at peak (concurrency 5) — PASS** and
**154.9 ms at 10x (concurrency 50) — PASS** against the 1,000 ms report
budget, zero errors at both levels. Before this fix the same dataset
measured p95 190 ms at peak and 1,330 ms at 10x. A warm sequential read
took ~8 ms (median of 20) against 1,650 journal entries, and an
independent recomputation from the raw journal matched the departmental
statement exactly (totals 813,125,000 cents income, 657,900,000 cents
expenses). The run overlapped an unrelated build on the same box (other
endpoints in the same run measured slower than their own checks), so the
departmental headroom is understated, not overstated. Dataset B was not
re-measured: its journal was empty in the #49 run, so it carries no
departmental evidence either way (the issue says the same).

These are local in-memory measurements on one shared 2-core box, not
hosted (DynamoDB) capacity evidence.

## Pencil calculation (#59)

Memory `crmWrite` previously copied the entire tenant CRM map and scanned all
rows for duplicate part numbers on every transaction, including deal-only
pencil saves. It now maintains a tenant-local part-number-to-part-id index.
Part writes stage releases before reservations, allowing same-transaction
swaps while rejecting duplicate final numbers. All uniqueness, version and
event checks finish before synchronous application of rows and index changes.

Part-number validation and index updates cost O(P) expected time and O(P)
temporary space for P parts in the transaction, using map lookups instead of
scanning tenant records. The persistent index holds one entry per part.
Transactions without parts perform no index work and never copy the CRM map;
work remains proportional to the transaction records and their clone sizes.
Vehicle writes, outbox events and accounting/service-board/forecast epoch
bumps retain their existing behavior. Dynamo already reserves part numbers
transactionally with `PART-NUMBER#` writes and is unchanged.

A second tenant-size scan sat in the same request path: memory `crmList`
materialized every CRM record in the tenant and filtered it by kind, and the
jacket-completion check wrapped around every deal PUT calls
`crmList('document')` twice per request. Memory now keeps a per-kind index
(`crmByKind`) in sync with the CRM map at the only two mutation points
(`crmWrite` and invite acceptance), so `crmList(kind)` reads and clones only
that kind's records, in the same insertion order as before. Dynamo `crmList`
already queries a kind prefix and is unchanged.

Local check on 2026-10-29 (Node v24.22.1): seeded the smoke profile with
`--heavy-vehicles 10000 --heavy-in-stock 100 --heavy-leads 49271
--heavy-customers 30000 --heavy-deals 15 --heavy-repair-orders 40
--heavy-parts 60 --light-tenants 0` (Dataset B's counts: 30,000 customers,
49,271 leads, 9,855 follow-ups, ~89,000 CRM records; seed not truncated) and
ran the unchanged measure CLI with 100 requests per endpoint, peak 5 and
10x 50. With only the part-number index in place, pencil measured p95
**140.5 ms at peak — PASS** and **1,198.1 ms at 10x — FAIL**, with zero
errors; a sequential pencil PUT on the heavy tenant still cost ~20 ms
against ~3.5 ms on a fresh tiny tenant on the same server, which isolated
the `crmList` scan above. With both fixes, pencil measured p95 **9.7 ms at
peak — PASS** and **25.9 ms at 10x — PASS**, zero errors at both levels
(issue's Dataset B measurements: 461 ms peak, 1,163 ms 10x). An in-process
profile at 79,000 CRM records put the handler-level pencil PUT at 0.30 ms
median after both fixes, against 5.23 ms before the `crmList` fix.
The same measure run still failed lead-pipeline-board (peak and 10x) and
inventory-aging-report (10x) against their budgets; those are tracked by
their own follow-up issues (#62, #60), not by this one. This is a local
in-memory measurement, not hosted (DynamoDB) capacity evidence.

## Inventory aging report bounded read (#60)

`GET /reports/inventory` and its CSV export now use tenant-scoped
`inventoryReportRows()` instead of loading and cloning all vehicles before
excluding sold rows. The custom-report inventory dataset shares this read
through `inventoryReport`. Memory scans the raw tenant vehicle map, checks each
row's scope, retains only `status !== 'sold'`, and clones only those retained
rows. Returned vehicles and nested recon costs are detached. There is no cache:
each request reads current vehicle state, and scan work still scales with total
vehicle count while retained/cloned data scales with unsold count.

Dynamo queries every tenant `VEHICLE#` page with consistent reads, checks each
row's scope, and retains only unsold rows before fetching the next page. It
still reads all vehicle pages: this bounds retained data by unsold inventory,
not Dynamo query work or read capacity independently of total vehicle volume.

Response contracts remain unchanged: all unsold statuses, UTC aging boundaries
(0–30, 31–60, 61–90, 91+), descending age then stock-number ordering, optional
trim, integer-cent recon/cost/list-price totals, zero-filled empty buckets, and
CSV formatting. Offline tests compare byte-for-byte legacy JSON and CSV on a
mixed fixture, memory and paginated fake-Dynamo reads, tenant isolation and
scope rejection, detached nested returns, empty reports, and custom inventory
reports. A guarded memory clone verifies that sold rows are never cloned by
this read. The full `npm test` suite passes (375 tests), as does
`npm run typecheck`. The #49 harness is unchanged.

Local vehicle-volume probe on 2026-10-29 (Node v24.22.1), with an empty in-memory
API on loopback port 3001 and external AI/analytics integrations disabled:

```sh
node --import tsx packages/api/src/local.ts
# In another terminal, with FREEDMS_SCALE_BASE_URL and FREEDMS_SCALE_TOKEN unset:
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-vehicles 10000 --heavy-in-stock 100 --light-tenants 0 --state /tmp/issue60-state.json --maxMinutes 30
node --import tsx scripts/scale-measure.ts --state /tmp/issue60-state.json --out /tmp/issue60-results.json --report /tmp/issue60-report.md
```

The seed completed without truncation: 10,000 vehicles (100 in stock), 24
customers, 120 leads, 24 follow-ups, 15 sold deals, 5 parts, 40 repair orders
(20 completed), 3 appointments, and no light tenants. The unchanged measurement
setup adds 50 vehicles, customers and scratch deals. Each endpoint receives
100 requests at each level. Inventory-aging-report results against the
1,000 ms p95 budget:

| Level | Concurrency | Before p50 (ms) | Before p95 (ms) | After p50 (ms) | After p95 (ms) | After result |
|---|---:|---:|---:|---:|---:|---|
| Peak | 5 | 184.3 | 397.1 | 17.2 | 49.2 | PASS |
| 10x | 50 | 2,197.0 | 2,373.5 | 118.2 | 146.7 | PASS |

Before values are the sweep's pre-fix baseline on this machine with the same
probe shape. Both before and after had zero errors at both levels. All endpoints
in the after run passed their budgets with zero errors. The bounded read alone
passes, so no memory epoch cache was added. This is a local vehicle-volume probe,
not a full Dataset B reproduction or hosted (DynamoDB) capacity evidence.

## Lead list page cache (#62)

`GET /leads` now reuses an epoch-validated repository `LeadPage` (leads, joined
customers and total). Memory keeps four pages per tenant; Dynamo keeps four
pages per repository instance, evicting the oldest insertion when full. Keys
include epoch, search, stage, assignee, limit and offset, plus tenant id in
Dynamo. An omitted assignee filter remains distinct from null (unassigned).
Hits return a detached clone; misses store and return separate clones.
Lead/customer writes advance the epoch once per transaction; unrelated writes
do not invalidate pages. Memory misses iterate only the `crmByKind` customer
and lead buckets instead of the entire CRM map.

Dynamo writes one conditional `LEADLIST#EPOCH` Put in the same transaction as
lead/customer rows and outbox events. Every page read first consistently Gets
that epoch. The cache is in-process and warm-instance only: that Get validates
cached pages across instances. A hit costs an epoch Get plus a clone of one
page, with no LEAD#/CUSTOMER# Query. A miss still reads every LEAD#/CUSTOMER#
query page; this does not bound Dynamo read capacity or cold-read work
independently of tenant size. Ordering, filters, orphan exclusion, totals and
the HTTP envelope are unchanged. The handler still computes `overdue` from the
current time on every request; serialized responses are never cached.

Local measurement on 2026-10-29 (Node v24.22.1), using the unchanged #49 harness
against the in-memory API on loopback port 3001:

```sh
node --import tsx packages/api/src/local.ts
# In another terminal:
node --import tsx scripts/scale-seed.ts --profile smoke --heavy-leads 12000 --heavy-customers 2400 --light-tenants 0 --state /tmp/scale62-state.json
node --import tsx scripts/scale-measure.ts --state /tmp/scale62-state.json --out /tmp/scale62-results.json --report /tmp/scale62-report.md
```

The seed completed without truncation: 12,000 leads, 2,400 customers, 2,400
follow-ups, 60 vehicles (45 in stock), 15 sold deals, 5 parts, 40 repair orders
(20 completed), 3 appointments, and no light tenants. These match #52's Dataset
A lead/customer counts. Measurement setup adds 50 vehicles, customers and
scratch deals. Each endpoint receives 100 requests per concurrency level.

| Level | Concurrency | Before p95 (ms) | After p50 (ms) | After p95 (ms) | Errors | Result |
|---|---:|---:|---:|---:|---:|---|
| Peak | 5 | 107.0 | 15.6 | 41.7 | 0 | PASS |
| 10x | 50 | 430.0 | 126.8 | 161.0 | 0 | PASS |

Before values are the issue's post-#52 baseline at the same lead/customer
counts. Both after levels meet the strict 300 ms p95 budget with zero errors;
all other endpoints in this run also passed their budgets with zero errors.
This is local in-memory evidence, not hosted Dynamo capacity evidence. The
full `npm test` suite passes (383 tests), and `npm run typecheck` passes.
