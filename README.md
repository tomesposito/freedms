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

Phase 1 builds 1–2 implement tenancy/auth foundations, inventory, and leads/CRM
end to end locally. [SOLUTION_DESIGN.md](SOLUTION_DESIGN.md) remains the living design document.
Desking, deal jackets, and reporting remain future builds.

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
`VEHICLE#<id>`, `CUSTOMER#<id>`, `LEAD#<id>`, `INTAKE#token`, and `EVENT#<uuid>`
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

Desking/pencils, deal jackets/documents UI, report/export, integrations,
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
