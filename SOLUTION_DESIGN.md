# freeDMS — Solution Design

> **Living document.** The source of truth for product direction, architecture,
> and significant decisions. Fixed owner decisions are distinguished from proposals.
>
> - **Status:** Phase 1 builds 1–2 implemented locally: scaffold, tenancy/auth, inventory, and leads/CRM with ADF intake. Later modules remain planned.
> - **Domain:** freeDMS.co.
> - **License today:** MIT, as recorded in LICENSE; alternatives remain draft D-1.
> - **Decision process:** IDDs D-1 onward record context, options, and a recommendation.
>   D-1, D-3, and D-4 were **DECIDED by the owner on 2026-10-19** (recorded in each
>   IDD below). D-2 and D-5–D-8 remain **DRAFT — awaiting the owner's pick**.

## 1. Vision & positioning

freeDMS is an open-source, freemium, cloud-native dealer management system for
car dealerships. Start with independent and upstart dealers. The free tier must
offer more features than any existing DMS today: a full operating system for the
dealership, with open integrations, complete data portability, and AI agents built
into the architecture from the beginning.

That is the product requirement, not a claim about the current scaffold or the
first release. Build toward it through usable phases and maintain a feature
comparison against the research baseline. Do not turn unfinished modules into
paid-only features or advertise full parity before workflows work end to end.

The supplied **DMS Market Research Report**, labeled research conducted 2026-10-19,
is the market evidence for this design. References below use its Q1–Q7 sections;
the source file is
`/home/hatch/workspace/research_notes/freedms-market-research-20261019-0231/report.md`.
Its estimates and `index` findings are directional, not independently verified
market facts. Its stated research date is later than this drafting session's
2026-10-18 date; preserve that provenance without implying a new research pass.

- **Entrenchment:** Q1 attributes roughly 80% of the US franchised market to CDK,
  Reynolds & Reynolds, and Dealertrack, citing Emergen Research (`index`). Other
  share estimates use different scopes. This supports starting outside franchises.
- **Cost:** the brief's roughly $2,000–$8,000 per rooftop per month describes the
  competitive price context, not a universal quote. Q2 reports roughly
  $2,000–$6,000+ for core DMS in its summary, Dealertrack estimates of
  $2,500–$8,000, and CDK/Reynolds estimates extending to $15,000+. Franchise pricing
  is quote-only, often dealer-reported or estimated, with add-ons and migration costs.
- **White space:** Q7 found no dedicated open-source DMS and no free franchise DMS
  tier. It did find free independent-dealer tools. There is no basis for claiming
  that all segments have zero free competitors.
- **Wedge:** Q4 identifies zero integration fees and full access/export of dealer
  data as central opportunities. Tekion demonstrates the value of open integration
  access; freeDMS makes both zero integration fees and full export explicit promises.
- **Why now:** Q7 describes cloud migration and AI entering everyday dealer work.
  Q5 records data-access disputes and outage concerns. An open, portable system
  can address those pains while returning useful aggregate insights to contributors.

**Fixed direction:** freemium; independents first; open source from day one; AI and
agentic AI first-class; monetization through anonymized aggregate data/analytics and
AI consumption; sharing rights in the initial ToS; a paid option to restrict sharing.
Never sell identifiable dealer or consumer data. These choices are not reopened below.

## 2. Target customers

**First:** independent used-car dealers and new dealerships whose staff need one
place for vehicles, leads, deals, documents, and operating reports. Their initial
needs are simple onboarding, imports from existing tools, reliable daily workflows,
clear permissions, and affordable access without separate CRM or integration fees.

Q2's published independent-tool price examples span $0–$129/month: Desk2Deal Free
(capped), DealerVLO at $29, tools around $79–$99, and Frazer Desktop at $129. These
are the report's examples, not a ceiling: it also lists DealerCenter bundles at
$298. Competing on price alone will not displace a free tool; completeness and
portability must make switching worthwhile.

**Next:** independents with service bays, parts operations, buy-here-pay-here needs,
and multiple rooftops. Expand only as their workflows can be supported reliably.
**Later:** franchised dealers, after accounting, fixed operations, OEM connectivity,
and migration quality justify adoption. OEM certification is a delivery dependency,
not something an open API automatically supplies.

## 3. Business model

| Offering | What the dealer receives | Economic role |
|---|---|---|
| Free hosted tier | Full baseline DMS functionality as it ships; basic CRM, core reporting, APIs/integrations, complete export, documents, security, and self-serve onboarding without freeDMS integration or per-user fees | Broad adoption and authorized contributions to anonymized aggregate insights |
| Paid tier | Everything in free, with an option to restrict contribution to shared data products; advanced analytics products | Funds a service whose customers can limit data participation; boundaries in D-6 |
| AI consumption | Optional assistants and agents available across tiers, with visible usage and spend controls | Charge for consumed AI work, not seats; meter and rates remain D-7 |
| Data and analytics products | Privacy-reviewed benchmarks and, if approved later, richer aggregates for dealers and other buyers | Monetizes aggregate insight, never access to identifiable records |

Most hosted plans assume data participation under the ToS. Basic benchmarks and
recommendations flow back to participating dealers, segmented by dealer size,
makeup (such as inventory mix and business model), and region when safe. Paid
analytics can offer deeper analysis without withholding ordinary operating reports.

External credit bureaus, messaging carriers, listing sites, signature providers,
and OEMs may charge for their services. Disclose those costs separately and allow
dealer-provided accounts where practical; do not disguise a freeDMS integration
toll as a provider charge. Ordinary manual workflows remain usable without buying AI.

Open-source software and hosted-service terms are distinct. Self-hosting does not
automatically contribute data: any contribution requires an explicit connection
and applicable agreement. Hosted analytics datasets are not made public by publishing
source code. Unit economics remain unproven: measure hosting, support, onboarding,
provider costs, AI margin, and actual analytics demand before claiming sustainability.
Do not assume aggregate-data revenue before safe cohorts exist.

## 4. Data strategy & ToS

### Separation and permitted uses

Operational records belong to the dealer's workspace and stay isolated. The shared
analytics pipeline accepts only allowlisted fields for approved purposes. Remove
dealer/customer identifiers, VINs, exact addresses, contact details, credit records,
and free text or documents from data-product inputs. Hashing an identifier alone
is not anonymization. Generalize dates, geography, vehicle attributes, and unusual
transactions where combinations could identify a person or dealership.

Use aggregated inventory aging, turn, realized price distributions, and operating
metrics as candidate products. Historical benchmarks should help dealers evaluate
their own operations; do not expose competitor-specific prices or coordinate pricing.
No consumer lead lists, dealer-level resale, raw transaction feeds, or reidentifiable
records. **Never sell identifiable dealer or consumer data.**

### Publication rules and minimum cohorts

Every release, including an in-product benchmark, must satisfy approved minimum
counts of **distinct contributing dealers** and **underlying observations** for each
cell. Dealer-group ownership must be considered so affiliated rooftops do not create
false diversity. Also bound contributor dominance, suppress sparse cells and
revealing totals, coarsen narrow segments, and prevent repeated queries or successive
releases from revealing suppressed values. A minimum count alone is insufficient.

The research supplies no defensible numeric cohort minimum. Do not invent one:
D-5 must set the minimums, dominance rules, and release controls after a privacy
assessment. **Until those values are approved and enforced, publish no shared
benchmarks or external data products.** Return “insufficient cohort” or a broader
approved segment instead. Record lineage, rule versions, contribution eligibility,
and review evidence for every release. Contracts prohibit reidentification and onward
use that defeats these controls; technical controls must not rely on contracts alone.

### Terms from day one

Initial hosted ToS and privacy notices must explain what is collected, service uses,
aggregate-data uses, buyer categories, retention, security responsibilities, export,
and the sharing restriction available on the paid tier. Record the accepted terms
version and effective sharing policy. Dealer assent does not replace consumer rights
or permission the dealer lacks. Material changes need a defined notice/acceptance path.

Proposed opt-out behavior: stop new contributions at the policy's effective time,
exclude eligible source rows from pending releases, and remove them from retained
contribution datasets subject to legal retention requirements. Previously distributed,
truly anonymous aggregates may be impossible to recall; disclose that limitation.
Do not promise retroactive erasure from every published statistic. Essential service
processing continues under the restricted plan; it does not authorize resale or shared
model training. D-6 settles the precise boundary and benchmark access.

### Compliance constraints

The report's Q5 identifies FTC Safeguards/GLBA, state privacy laws, and TCPA as
constraints. Product controls support dealer obligations; ToS assent does not remove
them. Legal applicability and contracts require review before live customer data.

- **FTC Safeguards Rule / GLBA:** financing or leasing dealers may be covered
  financial institutions, with service-provider oversight obligations. Design for
  access controls, MFA, encryption, security monitoring, auditability, incident
  response, and vendor oversight. Use a retention/disposal schedule with applicable
  exceptions and legal holds rather than treating the report's shorthand disposal
  period as a universal deletion rule.
  [FTC automobile-dealer Safeguards FAQs](https://www.ftc.gov/business-guidance/resources/automobile-dealers-ftcs-safeguards-rule-frequently-asked-questions).
- **GLBA Privacy Rule:** nonpublic personal financial information has distinct
  disclosure and reuse constraints. Dealer authorization alone is not a blanket
  license to reuse finance data in analytics.
  [FTC automobile-dealer Privacy FAQs](https://www.ftc.gov/business-guidance/resources/ftcs-privacy-rule-auto-dealers-faqs).
- **State privacy:** map applicable access, deletion, correction, and opt-out rights
  and service-provider restrictions by jurisdiction. Do not assume calling data
  “aggregated” establishes a legal exemption; validate deidentification and treatment
  of source records. California is a starting point, not the full state-law inventory.
  [California Attorney General CCPA guidance](https://oag.ca.gov/privacy/ccpa).
- **TCPA:** record outreach consent and its scope, enforce suppression/revocation,
  and check permission before automated calls or texts. Data-sharing assent is not
  marketing consent. Agents must use the same checks as staff.
  [FCC consent and revocation order](https://docs.fcc.gov/public/attachments/FCC-24-24A1_Rcd.pdf).

Q3 additionally calls for Red Flags, OFAC/credit workflows, and audit evidence.
Validate those workflows for each supported jurisdiction and provider. Security
controls belong in free; do not imply SOC or ISO certification before it is earned.

## 5. Product scope

All baseline modules below are **free as delivered**. Paid access adds sharing
restrictions and advanced aggregate analytics; AI execution is metered separately.
Phases are proposals from §7, not dates or commitments to provider availability.
The checklist follows research Q3–Q4, including features beyond the first release.

| Module | Free baseline checklist and proposed phase | Paid / consumption boundary |
|---|---|---|
| Inventory | P1: stocking/status/location, VIN decode, price history, aging, recon costs, import/export and listing-feed interfaces. P2: appraisals/book-value connectors. P4: OEM incentive/price feeds | Optional AI appraisal/pricing assistance metered; licensed provider data may cost extra |
| CRM/leads | P1: customer record, ADF/XML lead intake, routing, pipeline, communication history, follow-ups and consent. P2: loyalty, equity mining and ownership-cycle workflows | AI summaries/drafts/agents metered; basic CRM and rules remain free |
| Desking | P1: cash/finance pencils, trade values, supported tax/fees, deal log/jacket. P2: lease structuring, remote negotiation, secure upload and digital retailing | Optional AI assistance metered; core calculators free |
| F&I | P2: product menus, credit-application/lender connectors, decisions, eContracting/signatures, payoff and adverse-action documentation | Provider transaction fees disclosed; menus and connector access free |
| Service | P3: scheduling/check-in, repair orders, skill-based dispatch, labor grids, photo/video inspections, recommendations and history. P4: OEM warranty claims/reimbursement and lane-device adapters | AI scheduling/inspection assistance metered |
| Parts | P3: catalogs, stock/bin/multi-location lookup, reorder rules, purchase/special orders, returns, RO depletion, counter sales, matrix pricing and vendor ordering. P4: OEM parts programs | AI demand forecasting metered; ordinary ordering rules free |
| Accounting | P1: cost/deal summaries and accounting export. P2: GL, AP/AR, cash, bank reconciliation, deal posting/packs and commissions. P3: service/parts posting, departmental statements, multi-rooftop consolidation and payroll/timekeeping integration | Optional AI reconciliation assistance metered; ledger and ordinary consolidation free |
| Reporting | P1: core KPI dashboards, drill-down and export. P2: custom reports, inventory turn and F&I metrics. P3: departmental/multi-location reports, technician metrics and forecasting. P4: OEM reports | Advanced shared-data analytics paid; AI analysis metered; core reporting free |
| Documents | P1: deal jackets, scanning/upload, search, retention/disposal controls and basic signature workflow. P2: integrated deal/eContract signatures. P3: RO/service documents | Third-party signature services may charge; document access/export free |
| OEM integrations | P1: open connector/API framework. P4: certified bidirectional feeds, inventory/sales, incentives, warranty/spec validation, parts programs and digital-retailing certifications | No freeDMS integration fee; certification/access depends on OEM agreements |
| Compliance | P1: roles, MFA, encryption, audit logs, retention controls, consent and privacy-request workflows, vendor/incident evidence. P2: supported Red Flags, OFAC, credit and F&I compliance workflows; extend through P4 | No security or compliance paywall; specialist services may be external |
| Cross-cutting wedge | P1: documented API/webhooks, zero integration fees, full structured data and document export, import preview, self-serve onboarding, basic CRM and core reporting | No export fee or paid prerequisite |

### Integrations: plug in vs build in

"Integration" hides two different things. Some are other parties' networks or
licensed data — no amount of building replaces plugging in. The rest are features
incumbents sell as modules or toll as integrations; those we build natively and
give away. Our own API stays open with zero integration fees either way.

**Plug in — networks and licensed data, required to compete:**

- **Lender rails** — Dealertrack and RouteOne carry credit applications to
  lenders; F&I needs at least one, both for coverage.
- **Credit bureaus** — Experian / Equifax / TransUnion pulls.
- **Vehicle history** — Carfax and AutoCheck reports.
- **Listing syndication** — outbound inventory feeds to Cars.com, Autotrader,
  CarGurus, Facebook Marketplace.
- **Lead intake** — ADF/XML is the industry standard; conforming intake is
  mandatory, the parser is ours.
- **Floorplan lenders** — NextGear, AFC, Westlake; how independents finance
  inventory.
- **DMV / title** — registration, title, and temp tags via state aggregators
  (e.g., Vitu, Dealertrack RTS).
- **Payments processing** — service, parts, and BHPH collections.
- **Book values** — KBB / Black Book / J.D. Power on day one; our own
  aggregated data is the long-term replacement.
- **Messaging transport** — TCPA-compliant SMS/email carriers under the CRM.
- **QuickBooks export** — many independents keep their books there; the P1
  accounting export is the bridge.

**Build in — features, not integrations:** CRM, desking calculators, F&I menu
tooling, digital retailing, reporting and BI, pricing and appraisal workflows,
VIN decode (the federal NHTSA vPIC database is free), service scheduling and
repair orders, parts inventory, document management, and the FTC Buyers Guide
and state forms.

OEM certified integrations stay in P4 — they are the franchise barrier to
entry, not the beachhead's price of admission.

Buy-here-pay-here servicing/collections is a P2 candidate from Q4, contingent on
scope and regulatory review. No initial claim of full BHPH support. Likewise,
accounting export is not a general ledger, and a connector framework is not a
certified lender or OEM connection. Track those distinctions in release documentation.

## 6. Architecture sketch

Use a cloud-native, multi-tenant service with a web client and documented APIs.
The first build is a TypeScript modular application on Node 20, with a Vite static
client, AWS SAM, Lambda, HTTP API, DynamoDB on-demand, S3, and Cognito under D-4.
Storage is behind tenant-bound repository interfaces; local development uses an
empty in-memory implementation. The earlier relational-database proposal is
superseded by D-4. Outbox delivery workers belong to a later build.

All mutations enter through authorized domain commands. Commit business changes
and durable event/outbox entries together; workers deliver integrations and agent
jobs with retries, idempotency, and visible failure handling. An event log supports
audit, subscriptions, and agent context without requiring full event sourcing.
Keep sensitive documents and unnecessary personal fields out of event payloads;
retention/deletion must also cover logs, backups, and derived stores.

Tenant identity comes from authenticated membership, never a client-supplied ID
alone. Enforce tenant scope in database access and authorization, object access,
search, caches, queues, exports, integrations, and agent tools. Test cross-tenant
access denial. Isolate privileged support access and record its use. Backups,
restore exercises, reconciliation, and observable jobs are part of operating the SaaS.

Agents are first-class API clients with scoped identities, attributable actions,
usage metering, and revocable permissions. They cannot bypass domain validation,
consent, or financial controls. Start with read/summarize/draft actions; require
human approval for outbound communications, financial postings, or contractual
submissions under proposed D-8. Treat imported documents and messages as untrusted
content, not tool instructions. Provider contracts and payload filtering must keep
operational customer data out of unauthorized training or reuse.

A separate analytics pipeline reads eligible, allowlisted operational inputs,
applies deidentification and cohort controls, then publishes approved aggregates.
External analytics consumers cannot query production tenant records. Shared
recommendations combine safe aggregates with a dealer's own authorized context;
they must not expose another dealer's records. No cross-tenant model training is
implied by making agents first-class.

## 7. Phased plan — proposals

| Phase | Proposed delivery | Evidence needed to move outward |
|---|---|---|
| P0 — Define and validate | Resolve initial IDDs; interview independent dealers; map workflows, imports, provider dependencies, ToS and privacy rules | Owner-selected first slice; explicit feature comparison and acceptance examples; hosting cost model and data-handling review |
| P1 — Independent core | Inventory → lead → pencil → deal jacket → report/export; tenant/security foundations; API/events; a metered AI summary/draft slice | Dealers complete the supported workflow; imports and exports reconcile; isolation, restore and consent checks work; AI costs are visible |
| P2 — Complete the sale and books | F&I, supported lender/signature connections, digital retailing, full accounting, richer CRM; assess BHPH | Partner access secured; deals and ledger reconcile; jurisdiction-specific workflows validated. Launch benchmarks only if D-5 release gates are met |
| P3 — Fixed operations and groups | Service, parts, connected accounting, multi-rooftop operations; expand approved AI actions and analytics | Repair order through parts/labor/accounting works; multi-location permissions and reporting reconcile; aggregate products pass release review |
| P4 — Franchise expansion | OEM integrations/certifications, warranty and parts programs, deeper franchise reporting and migration | OEM access/certification and operational depth demonstrated; feature comparison supports broader adoption claims |

No dates, revenue projections, or assumed safe cohort sizes are committed. Early
product usefulness must stand on its own while network benchmarks are unavailable.
The free-tier breadth requirement remains the destination throughout these phases.

## 8. Open decisions — draft IDDs

### D-1 — Open-source license

**Status: DECIDED — owner, 2026-10-19: retain MIT (the recommendation).**

**Context:** the public scaffold is MIT. Open source is fixed; whether competitors
must share modifications to a hosted version is unresolved.

**Options:** retain MIT for permissive adoption and integration; use AGPL for future
covered code to require corresponding source for modified network-served versions;
or evaluate dual licensing with contribution-rights implications.

**Recommendation:** retain MIT initially to reduce integration/adoption friction and
match the existing scaffold. Compete on the hosted service and aggregate products.
If network copyleft is preferred, settle it before outside contributions; already
released MIT code remains available under its original license.

### D-2 — Data-product granularity

**Status: DRAFT — awaiting the owner's pick.**

**Context:** aggregate-data monetization is fixed, but richer filters increase
identification risk and the chance of exposing commercially sensitive behavior.

**Options:** predefined historical benchmarks only; richer aggregate datasets/APIs
with controlled dimensions; staged expansion from benchmarks to richer aggregates.
Identifiable data sales are outside all options.

**Recommendation:** staged expansion, beginning with predefined benchmarks by size,
makeup, and broad region where cohorts permit. Require a fresh release-risk review
before adding dimensions, custom queries, or external aggregate downloads.

### D-3 — First-module scope

**Status: DECIDED — owner, 2026-10-19: the middle option (the recommendation) —
the P1 end-to-end independent sales slice.**

**Context:** independents need usable workflows, but full accounting, F&I, service,
and OEM depth cannot be assumed in the first delivery.

**Options:** inventory alone; inventory plus CRM, basic desking, documents and
report/export; a full sales-to-ledger suite before onboarding dealers.

**Recommendation:** the middle option, as P1: an end-to-end independent sales slice
with accounting export and explicit unsupported workflows. Include API/events,
security, and a useful AI summary/draft capability from that first slice.

### D-4 — Hosting platform

**Status: DECIDED — owner, 2026-10-19: AWS Lambda + serverless on free tiers.
This overrides the recommendation below.**

**Owner's reasoning:** stay on AWS free tiers to start, as with OpenSight's
hosted setup — Lambda and serverless, so the product costs nothing while there
is no activity and no revenue. Reassess if and when real traffic arrives; the
first problem is shipping something that costs nothing to run idle.

**Context:** SaaS must support isolation, durable transactions, background work,
restores, and an affordable free tier without prematurely becoming an infrastructure project.

**Decision (owner, 2026-10-19):** AWS serverless — Lambda, API Gateway, DynamoDB,
S3, Cognito — on free tiers, pay only on activity. Implementation detail within
that decision: DynamoDB is the data store because it is AWS's always-free,
zero-idle-cost option; the design sketch's relational database would bill while
idle (Aurora Serverless minimum capacity), which the owner's zero-cost rule
rules out. The data layer sits behind an interface so storage can change when
traffic justifies it.

**Options:** managed application hosting with managed Postgres/object storage;
AWS managed containers/database/queues; a serverless application/database platform.

**Recommendation:** start with managed application hosting, managed Postgres,
object storage, and durable workers. Select the named provider after comparing
security controls, residency, recovery, portability, and measured operating costs.
No provider, spending, or deployment is authorized by this draft.

### D-5 — Minimum cohorts and release policy

**Status: DRAFT — awaiting the owner's pick.**

**Context:** the report gives no safe numeric minimum; dealer count alone does not
prevent inference from rare vehicles, dominant contributors, or overlapping queries.

**Options:** fixed dealer/observation minimums with suppression and dominance limits;
risk-adjusted minimums by metric and segment; those controls plus statistical noise
and a formal query/privacy budget.

**Recommendation:** begin with predefined releases, conservative fixed minimums,
dominance limits and suppression, tested against inference attacks. Have privacy
review establish the actual minimum dealer and observation counts and allowable
segment widths before the owner's selection is finalized. No publication while
those values are unset; defer interactive queries until their risks are controlled.

### D-6 — Paid sharing restriction and analytics access

**Status: DRAFT — awaiting the owner's pick.**

**Context:** a paid option to restrict sharing is fixed. Its scope, effective date,
source-data deletion behavior, and access to shared benchmarks need a clear contract.

**Options:** complete exclusion from shared analytics contributions; configurable
metric exclusions; restricted contribution plus a separate benchmark subscription.

**Recommendation:** offer complete exclusion as the first paid restriction, with
essential service processing retained and future contributions stopped at its
effective time. Keep shared benchmark access separately priced/defined; do not imply
historical anonymous publications can be recalled. Resolve retained source datasets,
derived artifacts, and transition behavior explicitly in the ToS.

### D-7 — AI consumption unit and budget controls

**Status: DRAFT — awaiting the owner's pick.**

**Context:** consumption pricing is fixed, but raw inference usage and a completed
agent task can differ because of retries, tool calls, and provider failures.

**Options:** bill tokens/provider usage; bill completed tasks; publish task credits
backed by documented usage categories.

**Recommendation:** published task credits with a pre-run estimate, usage receipts,
hard dealer-set spending limits, and a defined failure/retry policy. Set actual rates
only after measuring representative workflows and margins; no invented price here.

### D-8 — Initial agent authority

**Status: DRAFT — awaiting the owner's pick.**

**Context:** first-class agents need useful tools, but a suggested reply and an
executed financing submission have very different consequences.

**Options:** read/draft only; human-approved writes; bounded autonomous workflows
selected by dealer administrators.

**Recommendation:** read/draft plus explicit human-approved writes initially.
Record who approved what, recheck permission and current record state at execution,
and make cancellation/revocation effective. Add bounded autonomy only after a
specific workflow has demonstrated correctness, consent enforcement, and recoverability.
