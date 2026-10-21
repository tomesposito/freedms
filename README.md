# freeDMS

Free, open-source dealer management software (DMS) for car dealerships.

## Vision

Every dealer pays for a DMS. The big three — CDK, Reynolds & Reynolds, Dealertrack —
charge thousands of dollars per rooftop per month, toll third-party integrations,
and sell back reporting as add-ons. Independents and upstart dealers get the scraps.

freeDMS is a freemium, cloud-native DMS that starts with the dealers everyone else
ignores: independents and upstarts. The free tier aims to do more than any existing
DMS — inventory, CRM, desking, F&I, service, parts, accounting — without the per-seat
ransom. We make money two honest ways: aggregated, anonymized industry analytics,
and consumption-based AI and agentic-AI features.

## Model

- **Free tier:** full DMS functionality, no per-user fees, zero integration tolls.
  In exchange, anonymized and aggregated dealer data feeds industry benchmarks and
  better product recommendations for everyone. Baked into the terms of service from
  day one.
- **Paid tier:** everything in free, plus the option to restrict data sharing
  (enterprise-style), and advanced analytics.
- **AI:** agentic AI built in from the start — priced on consumption, not seats.

## Status

Phase 1 builds 1–3 implement tenancy/auth foundations, inventory, leads/CRM, and
cash/finance desking, printable deal jackets, and core reporting/CSV exports end to end locally. [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md) remains the living design document.
Deal jackets include generated buyer documents, attachments, and a derived completeness checklist.

## License

MIT — see [LICENSE](LICENSE).

## Local development

Use Node **20.19+** and npm 10 (`.nvmrc` selects Node 20):

```sh
nvm use
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Enter your dealership name and your name to create
an empty local workspace. Add a vehicle, decode its VIN if desired, enter pricing
and recon costs, then save. Search/filter the inventory list, open a vehicle to
view aging and costs, edit it, or delete it as an administrator.

The API listens only on `127.0.0.1:3001`; Vite proxies `/api` to it. Local setup
creates a real, user-entered dealership and admin membership, never demo vehicles.
Local tokens are signed, expire in one hour, and use the same identity claims as
Cognito (`sub`, `custom:tenant_id`, `iss`, `aud`, `exp`, `token_use`). This is a
loopback-only development shim, **not production account authentication**.

Storage and the signing key are in memory. API restart clears all records and
invalidates tokens. Signing out or losing the tab session loses access to that
workspace; creating another session creates a new empty dealership. Use separate
browser sessions to exercise independent workspaces. `Ctrl+C` stops both servers.
VIN decoding alone requires internet access; manual entry works offline.

```sh
npm run build      # type-check all packages; bundle Lambda and static web
npm test           # complete suite; no AWS credentials or network required
npm run typecheck
```

Tests use isolated, synthetic fixtures; there is no runtime seed script or demo
dataset. VIN responses and the DynamoDB transport are mocked. Coverage includes
cross-tenant reads/writes, roles, inactive membership, token tampering/expiry,
validation, concurrency conflicts, atomic event writes, DynamoDB partition keys
and pagination, decoder failures, safe HTML rendering, and exact money conversion.

## Repository structure

- `packages/shared`: domain types and API envelopes.
- `packages/api`: one shared request handler, domain validation, auth, `VinDecoder`,
  tenant-bound repository interfaces, memory and DynamoDB adapters, local server.
- `packages/web`: framework-free Vite/TypeScript client; built assets in `dist`.
- `infra/template.yaml`: Cognito, authenticated HTTP API, inventory Lambda,
  on-demand DynamoDB table, private encrypted document bucket, bounded log retention.

## API contract

User routes require a bearer ID token. The local-only `POST /local/session` creates
a session; `POST /intake/adf` instead requires a separate intake bearer token.
Success: `{ "data": ... }`; failure: `{ "error": { "code": "...", "message": "..." } }`.
No route accepts tenant identity in the URL, body, or query. The authenticated
principal's immutable tenant claim selects a repository; an active membership
record must match its subject and tenant. Roles come from that membership, not
client fields. Admin and staff can create/update; only admin can delete.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/session` | Current dealership and effective principal |
| GET | `/vehicles?status=available&search=...` | Search stock, VIN, make/model/trim, location; optional status |
| GET | `/vehicles/{id}` | Vehicle with derived aging and recon total |
| POST | `/vehicles` | Create from `VehicleInput` |
| PUT | `/vehicles/{id}` | Full replacement of editable fields, plus current `version` |
| DELETE | `/vehicles/{id}` | JSON body with current `version` |
| GET | `/vin/{vin}` | Decode through NHTSA; return partial-data warnings explicitly |

`VehicleInput` is defined in `packages/shared/src/index.ts`. Money is nonnegative
**integer USD cents**; the form displays dollars. Status is `available`, `reserved`,
`sold`, or `in recon`. VINs must have 17 characters (I/O/Q excluded); this slice does
not support pre-standard VINs. Date stocked is an ISO UTC date no later than today.
Aging counts UTC calendar days; recon total sums line items. Decoded attributes
are editable for corrections and incomplete NHTSA results. The server validates
them on save, but does not claim NHTSA verified manually entered attributes.

DynamoDB stores `PK=TENANT#<id>` with `PROFILE`, `USER#<sub>`, `MEMBER#<sub>`,
`VEHICLE#<id>`, `CUSTOMER#<id>`, `LEAD#<id>`, `INTAKE#token`, `DEAL#<id>`, `SETTINGS#workspace`, `DOCUMENT#<id>`, and `EVENT#<uuid>`
sort keys. Every business mutation and its minimal,
attributable event commit together via `TransactWriteItems`; conditional writes
prevent stale edits. Events contain IDs, action, version, actor, and timestamp,
not VINs or notes. Outbox delivery remains pending; no worker pretends to deliver
integrations. Inventory queries read all tenant vehicle pages, then filter; this
first slice is intended for small independent lots, with API pagination/indexing
left for scale. Stock numbers and VINs are not uniqueness-constrained in this build.

## AWS packaging and operator setup

Nothing is deployed automatically. Build first, then use an installed SAM CLI:

```sh
npm run build
sam validate --lint --template-file infra/template.yaml
sam build --template-file infra/template.yaml
# Deploy only in your chosen AWS account when ready:
sam deploy --guided
```

Provide an exact HTTPS `WebOrigin`, `WebCallbackUrl` (ending in `/`), and unique
`CognitoDomainPrefix`. The document bucket is private and is not the web host.
Publish `packages/web/dist` to a separately configured static host (including
S3 behind an HTTPS delivery layer). Hash routes need no server-side route rewrites.
Build the web client with these values from stack outputs:

```sh
VITE_API_URL="$API_URL" \
VITE_COGNITO_DOMAIN="$COGNITO_DOMAIN" \
VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID" \
npm run build -w @freedms/web
```

Cognito sign-in uses authorization code + PKCE, session-only token storage, and
software-token MFA. Self-signup is disabled. An operator creates the first Cognito
user with an immutable `custom:tenant_id` attribute (an opaque UUID), obtains its
`sub`, and provisions the matching dealership/membership:

```sh
TABLE_NAME="$TABLE_NAME" npm run provision -w @freedms/api -- \
  "$TENANT_ID" "$COGNITO_SUB" "$DEALERSHIP_NAME" "$USER_NAME"
```

The bootstrap is conditional and cannot overwrite an existing dealership. It is
an operator command, not an API endpoint; use separately authorized AWS credentials.
The app client cannot write `custom:tenant_id`. The Lambda has only GetItem, Query,
PutItem, and DeleteItem permissions on its table (transaction operations authorize
against those underlying actions), and no document permissions. HTTP API validates
JWT signatures/issuer/audience; Lambda checks claim shape and membership again.
There is no production local-token fallback. Staff membership administration,
self-service onboarding, and account management UI are outside this build.

**Runtime constraint:** the requested template targets `nodejs20.x` exactly. AWS
now lists Node 20 as deprecated; check its current creation/update restrictions
before deployment and approve a supported-runtime migration for production.
See [AWS Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html).

**Cost model:** no always-on server, provisioned concurrency, NAT gateway, or
provisioned database capacity is configured. On-demand requests, retained storage,
logs, and auth can still incur charges; free-tier eligibility is account-dependent.
DynamoDB's provisioned-capacity free allowance is not a promise of free on-demand
requests. See [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/). Retained
tables and buckets survive stack deletion; review their storage when cleaning up.

The direct libraries use MIT or Apache-2.0 licenses. Vite's transitive toolchain
also includes permissive BSD/ISC-licensed packages; see `package-lock.json` for the
resolved license metadata. No heavy frontend framework is included.

## Deliberately outside this build

Lease desking, F&I menus, lender submission, integrations,
AI, analytics, outbox delivery workers, imports, price history UI, and seeded/demo
inventory. These are working local slices, not the complete Phase 1 product.
Cloud deployment, live Cognito/DynamoDB integration, backup/restore exercises, and
production operational readiness have not been established by the offline tests.

## Leads and CRM (build 2)

Open **Leads** in the top navigation. An empty workspace has no customers or leads.
Use **Add lead** to create a customer or pick an existing one, select an optional
inventory vehicle, choose a source, and assign an active workspace user. Local
onboarding creates one admin user; additional membership management is still out
of scope. A matching normalized phone or case-insensitive email produces a warning
after creation, never blocks creation or silently merges customers.

The detail page shows customer contact/address/notes and TCPA consent (unknown,
granted, revoked, with timestamp and source). Use **Edit customer / consent** to
update it. Intake always records unknown consent; receiving a lead is not evidence
of permission. Manual communication entries do not send calls, texts, or emails.
Customer communication history spans all of that customer's leads.

Stages are `new`, `contacted`, `appointment`, `in-store`, `working-deal`, `sold`, and
`lost`. Every change records the old/new stage, actor, and server timestamp. Staff
may skip stages or reopen a sold/lost lead to correct the pipeline. Assignment
changes also appear in the timeline. Stage changes do not change inventory status.
Follow-ups have a call/text/email/visit type, due timestamp, and done flag. An open
task strictly before the current time is overdue. Forms display local time and
send UTC timestamps; list overdue flags refresh when the list is loaded.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/users` | Active users in the authenticated workspace |
| GET / POST | `/customers` | List/search customers; create with duplicate warnings |
| GET / PUT | `/customers/{id}` | Read with communication history; replace editable fields + `version` |
| GET | `/leads?stage=new&assignee=USER_ID&search=...` | Filter leads; `assignee=unassigned` is supported |
| POST | `/leads` | Atomic customer + lead create, or use `customerId` |
| GET / PUT | `/leads/{id}` | Detail; update `stage`, `assigneeId`, `vehicleId` + `version` |
| POST | `/leads/{id}/follow-ups` | `type`, `dueAt` (UTC ISO timestamp), lead `version` |
| PUT | `/leads/{id}/follow-ups/{taskId}` | `done` boolean + current lead `version` |
| POST | `/leads/{id}/communications` | `type`, `direction` (inbound/outbound), `summary`, `timestamp`, lead `version` |
| POST | `/intake-token` | Admin only; empty JSON body generates/rotates the workspace token |
| POST | `/intake/adf` | ADF 1.0 XML using intake bearer authentication |

Customer input is `{name, phone, email, address, notes, consent: {status,
timestamp, source}}`; unknown consent may have a null timestamp. Granted/revoked
consent requires a timestamp and source. Lead creation accepts exactly one of
`customer` (that object) or `customerId`, plus `source`, optional `sourceDetail`,
`vehicleId`, `vehicleDescription`, and `assigneeId`. Sources are `walk-in`, `phone`,
`website`, `marketplace`, `referral`, and `other`. Customer/lead create responses
contain `{customer|lead, duplicateCustomerIds}` inside `data`.

### Local ADF intake

In **Leads → ADF intake**, click **Generate / rotate intake token** as the workspace
admin. Copy the token shown once. Rotation immediately invalidates the old token.
Only a SHA-256 hash is stored; the token is separate from the browser's user token
and carries no user privileges. Tokens last until rotation or local API restart.
Treat them as credentials; do not put them in URLs or source control.

Submit your own ADF file (the test fixtures are never loaded into the app):

```sh
read -rs INTAKE_TOKEN
# Paste the generated token, then press Enter.
curl -sS http://127.0.0.1:3001/intake/adf \
  -H "Authorization: Bearer $INTAKE_TOKEN" \
  -H 'Content-Type: application/xml' \
  --data-binary @/path/to/your-lead.xml
unset INTAKE_TOKEN
```

The token resolves the workspace; neither a vendor ID in the XML nor a tenant
field/query can select a different workspace. A bad token returns 401. Malformed
XML or invalid contact fields return 400 with no customer, lead, or outbox writes.
The customer, lead, and their two events commit together. Intake attribution is
`intake`. User tokens cannot be used as intake tokens, or vice versa.

The endpoint accepts one `adf/prospect` per request, up to 64 KiB. It reads customer
contact names, preferred phone/email, postal address, comments, vehicle fields,
and provider/vendor names. Website is the intake source; original provider,
service, and vendor names remain in `sourceDetail`. A unique same-workspace VIN
match (or stock number when VIN is absent) links an inventory vehicle; otherwise
vehicle details remain visible as text. DTD/entity declarations and malformed XML
are rejected. Batch prospects, intake deduplication/idempotency, automatic routing,
and real message sending are deliberately outside this build. Replaying a payload
creates another lead and returns duplicate-customer warnings.

CRM reads all tenant rows before filtering, matching the small-lot inventory
approach. A lead embeds its timeline/tasks so changes and their outbox event are
atomic with optimistic version checks. The current limit is 400 activities, 200
tasks, and 250 KB per lead; further writes return a validation error. Pagination,
archiving, automatic reminders, token expiry policies, and customer merging are
future work. Restarting the local API clears all records and intake credentials.

Offline tests include realistic handwritten ADF fixtures, parser failure cases,
intake token isolation/rotation, customer/lead/follow-up isolation, assignment and
stage filtering, stage history, overdue boundaries, and atomic transaction failures.
The only new runtime library is MIT-licensed `@xmldom/xmldom` (no dependencies).
The SAM proxy already covers CRM user routes; `/intake/adf` explicitly bypasses
Cognito only to perform its separate intake-token authentication in the handler.
No AWS resources were changed or deployed by this build.


## Desking / the pencil (build 3)

Open **Deals**. As an admin, use **Workspace settings** to set sales tax (up to
100%, in 0.01% increments), the trade-difference toggle, and default doc fee.
New deals copy these settings; later settings changes never reprice existing deals.
The initial defaults are zero tax and zero doc fee, with trade-difference off.

Add a vehicle and a customer through **Leads → Add lead**, then **Start deal**
from the vehicle, lead, or Deals page. Choose cash or finance. A lead-based start
links the buyer and originating lead; a vehicle-based start lets you choose a buyer.
Vehicle list price defaults the first pencil's selling price. Enter an optional
trade (free-text year/make/model/VIN, allowance, payoff, actual cash value), cash
down, doc fee, APR, and term. No VIN decode or external service is needed.

Totals and the 3 × 3 payment grid recalculate on every numeric change. Unsaved
changes are labeled, and invalid input clears computed values. **Save worksheet**
updates the working scenario. **Save as new pencil** preserves its previously
saved numbers and saves the draft as a new working scenario (up to 20 per deal).
Pencils compare side by side; **Use pencil** switches the draft selection, then
save to persist it. Trade, tax, and doc fee are shared by all pencils on the deal.

Calculation rules are intentionally simple and visible:

- Money is integer USD cents; tax and APR are integer basis points (600 = 6%).
- Taxable base is selling price, or max(0, price − trade allowance). Doc fees,
  payoff, and down payment do not affect tax. Tax rounds half up to cents.
- Net equity = allowance − payoff. Finance principal = max(0, price + doc fee +
  tax − net equity − cash down). Cash deals show the remaining cash due instead.
  Excess down/equity appears separately as credit due.
- Monthly payment uses standard amortization with exact rational arithmetic,
  rounding half up to cents. Zero APR divides principal by term. Terms are 1–120
  months and APR is 0–100%. Total payments = rounded payment × term; this is a
  worksheet estimate, and a lender's final payment may differ due to rounding.
- Total cost = price + doc fee + tax + finance charge, before down/trade equity.
  Front gross = price − vehicle cost − recon − (trade allowance − actual cash value).
- The payment grid uses the current term and nearby 12-month terms (three distinct
  terms at the boundaries) and three cash-down options $500 apart. It is never stored.

Status follows **working → approved → sold**, or **dead** from working/approved.
Every transition records actor and server timestamp. Sold atomically changes the
vehicle and linked lead to sold, with an outbox event for each changed record.
Competing sales or stale versions conflict without partial writes. Dead changes
only the deal. Sold/dead deals are read only. Inventory referenced by a deal cannot
be deleted. No lease, F&I menu, lender submission, documents, or reporting is included.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/deals?status=working` | Tenant-scoped deals with vehicle/buyer; optional status |
| POST | `/deals` | Required `vehicleId`, `customerId`, `type`; optional `leadId` |
| GET | `/deals/{id}` | Worksheet data and saved pencils |
| PUT | `/deals/{id}` | Required `version`; optional `type`, `trade`, `docFee`, `pencils`, `workingPencilId`, `status` |
| GET | `/settings` | Tenant defaults; version 0 before first settings save |
| PUT | `/settings` | Admin only: `version`, `taxRateBps`, `taxTradeDifference`, `docFee` |

Pencil input is `{id, name, price, down, term, aprBps}`; trade input is null or
`{year, make, model, vin, allowance, payoff, actualCashValue}` with string identity
fields. Deal references and snapshotted tax rules are immutable. Like inventory
and CRM, list queries read all tenant rows before filtering. Local storage remains
ephemeral. This build adds no dependencies, deployment changes, runtime seed data,
or network-dependent tests.


### Deal jackets and attachments (local build)

| Method | Path | Contract |
|---|---|---|
| GET | `/deals/{id}/jacket` | Approved/sold only; deal with buyer/vehicle, working pencil, `pencilMath` numbers, AS IS Buyers Guide data, documents and checklist |
| GET | `/deals/{id}/documents` | Attachment metadata list; any deal status |
| POST | `/deals/{id}/documents` | `{name, type, content}`; canonical base64 content, nonempty, at most 40 KiB decoded |
| GET | `/deals/{id}/documents/{documentId}/content` | `{data: {content}}` containing base64 bytes; owning tenant and matching deal only |

Names are required (160 characters maximum). Types are `id`, `insurance`, `title`,
`registration`, `signed-form`, and `other`. The existing 64 KiB JSON request cap
still applies. Unknown keys, malformed base64 and oversize files return 400;
foreign/missing deals or documents return 404. Working/dead jackets return 400
with an explanation; those deals may still collect attachments.

`document` metadata records and minimal `document.created` outbox events commit
through `crmWrite`. The shared event union also permits `document.updated` for the
generic repository contract; there is no attachment update/delete endpoint.
File bytes never enter business records or events. `DocumentStore.forTenant`
binds storage to authenticated tenant claims; its in-memory implementation is
explicitly injected into the local handler and tests. Files, like other local
records, disappear on restart. Failed metadata commits remove staged local bytes.
Production S3 wiring is deferred: without an injected store, upload/content
requests return 503 rather than pretending files are durable. No infrastructure
or deployment changes are part of this build.

The checklist derives generated buyer’s order and Buyers Guide as present,
plus ID and insurance as present only when matching attachment categories exist.
It checks presence, not document validity. No ID or insurance documents are generated.
The worksheet links to the jacket once approved/sold. Browser printing includes
only the buyer’s order and Buyers Guide, keeping attachment management and the
checklist off buyer paperwork. Attachments download separately as binary files.
The buyer’s order uses the saved working pencil and deal tax/doc-fee snapshot,
shows cash or finance fields as appropriate, and excludes front gross and vehicle
cost. The guide defaults to AS IS with unfilled warranty fields; no warranty terms
are inferred. Signatures, PDFs, retention/search and production storage remain
outside this local slice.


### Reporting and exports (local build)

Open **Reports** at `#/reports` from the main navigation. A new workspace shows
empty inventory and sales, with an honest zero-count lead snapshot. Inventory
includes every vehicle except sold stock, with UTC aging buckets `0-30`, `31-60`,
`61-90`, and `91+`, ordered oldest first then stock number. Bucket costs and total
inventory cost include acquisition cost plus recon; list price totals are separate.

| Method | Path | Contract |
|---|---|---|
| GET | `/reports/inventory` | `{data: {rows, buckets, totals: {count, totalCost, totalListPrice}}}` |
| GET | `/reports/sales?from&to` | `{data: {from, to, rows, totals: {dealsSold, totalFrontGross, averageGross}}}` |
| GET | `/reports/leads` | `{data: {byStage, bySource, total}}`; current snapshot, all domain stages/sources in order, zero-filled |
| GET | `/reports/inventory.csv` | Inventory table as `inventory.csv` |
| GET | `/reports/sales.csv?from&to` | Sales table as `sales.csv` |
| GET | `/reports/leads.csv` | Stage/source counts and total as `lead-pipeline.csv` |
| GET | `/reports/accounting.csv?from&to` | Sold deals as `accounting.csv`; columns exactly `date,deal,buyer,vehicle,price,cost,recon,tax,fees,gross` |

Sales and accounting use the UTC calendar date of the last sold history entry,
falling back to `updatedAt` if no sold entry exists. Only currently sold deals
are included, sorted by sold date then deal ID. Optional `from` and `to` are real
`YYYY-MM-DD` dates, inclusive at both ends; an omitted bound is open-ended, both
omitted means all time (JSON returns null bounds). Invalid dates, reversed ranges,
and unknown query keys return 400. Inventory and leads accept no query keys.
The Reports date controls apply only to sales and accounting, with Clear restoring
all time. Lead counts are explicitly a current snapshot.

Money in JSON remains integer USD cents. Sales rows include the working pencil
price and `pencilMath` front gross using that deal's trade, tax/doc-fee snapshot,
and vehicle. Average gross rounds total front gross divided by count to the nearest
cent, or zero for no sales. Accounting uses those same computed sales rows,
including acquisition cost, recon, sales tax and snapshotted doc fee. Missing
buyer/vehicle/working-pencil references fail closed with 404, never partial totals.

Each CSV serializes the same report structure used by JSON; no separate report
math is used. CSVs have a header, RFC 4180 conditional quoting/doubled quotes,
CRLF line endings including the final line, and plain two-decimal dollar amounts.
They return `text/csv; charset=utf-8`, an attachment filename, `cache-control:
no-store`, and `x-content-type-options: nosniff`. Browser downloads fetch with the
same bearer authentication as JSON and surface API errors on the page.

All report reads use the authenticated tenant repository, create no records or
outbox events, and require authentication for JSON and CSV alike. Offline tests
create fixtures through the public handler and reconcile reports and exports,
including date boundaries, escaping, isolation, and unchanged records/events.
The accounting CSV is the P1 QuickBooks bridge; GL posting, QuickBooks API
integration, custom reporting and cloud deployment remain outside this build.

## AI quick entry (local build)

Inventory and Leads offer plain-language intake into a draft. Review and edit the
existing add form, then save explicitly; extraction never creates or updates a
vehicle, customer, or lead. Mileage is kept in vehicle notes and trade details in
customer notes. Extraction never supplies outreach consent.

Configure `FREEDMS_AI_ENDPOINT` (the full OpenAI-compatible chat-completions URL),
`FREEDMS_AI_API_KEY`, and `FREEDMS_AI_MODEL` on the API process. No vendor or model
is assumed. Missing configuration shows “AI quick entry isn't set up”; there is
no simulated extraction or local parser fallback. Requests time out after 15 seconds.
Behavioral analytics always retains accepted events in the tenant-scoped own log.
Vendor delivery is off by default. Set `ANALYTICS_ENABLED=1` and
`ANALYTICS_VENDOR_KEY` to the project token for the single freeDMS US PostHog
project to opt in; unset either to disable delivery. Project creation is manual.
Only typed categorical properties and dealership identity go to the
[PostHog capture API](https://posthog.com/docs/api/capture); no customer content,
user IDs, VINs, or economics. `GET /analytics/funnel` derives milestones from the
owned outbox joined to deal history and document metadata. Client signals use
`POST /analytics/events` and never determine funnel milestones. Quick-entry
outcomes are usage signals only, with no billing or pricing behavior.

Set `FREEDMS_AI_VISION=1` only for a vision-capable provider to enable vehicle photo
intake. Otherwise the photo control explains that it is unsupported.

Photos accept JPEG, PNG, WebP, or GIF, up to 5 MiB of base64 (3.75 MiB decoded).
Only `POST /quick-entry/vehicle-photo` allows the larger JSON body (5 MiB + 1 KiB
metadata); other routes retain the 64 KiB cap. Text is limited to 2,000 characters.
Text/images are sent to the configured provider; prompts and responses are not
logged. Drafts stay in browser memory until consumed by the review form.

Authenticated endpoints: `GET /quick-entry/status` returns `{configured, vision}`;
`POST /quick-entry/vehicle` and `/quick-entry/lead` accept `{text}`;
`POST /quick-entry/vehicle-photo` accepts `{mediaType, dataBase64}`. Responses use
the normal `{data: ...}` envelope and extraction returns `{draft}`. Unconfigured,
vision-unsupported, and provider failures return honest 503, 422, and 502 errors.
Every validated extraction attempt records a tenant-scoped usage entry with actor,
kind, and timestamp, including unavailable, unsupported, and failed attempts.
Invalid input and unauthenticated requests are not metered. This is a metering stub
only: no billing, prices, credits, or spend limits. Usage contains no prompt/image
content and has no public listing endpoint. Offline tests use injected fakes.
