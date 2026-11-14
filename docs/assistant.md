# AI assistant

`POST /assistant/chat` uses the normal session token and live workspace membership.
The caller sends conversation history on each request; the server does not persist
chat messages. The existing tool handlers retain their usual records and outbox
writes, attributed to the session user with `actorType: agent`.

Request:

```json
{"messages":[{"role":"user","text":"Find stock STOCK-98"}]}
```

Turns alternate user/assistant, start and end with user, and contain only `role`
and `text`. Limits: 50 turns, 16,000 characters per turn, 64 KiB request body.

Success:

```json
{"data":{"reply":"Found the vehicle.","transcript":[{"tool":"search_vehicles","ok":true}],"creditsUsed":1}}
```

The transcript covers tools executed during this request. Tool failures are sent
back to the model as error results and appear with `ok: false`. At most ten tool
rounds execute, with at most twenty calls per round. Each result sent back to the
model is limited to 16,000 characters with an explicit truncation marker. Further
tool requests after ten rounds return a plain step-limit note.

## Turn time limit

Turns stay synchronous. Each turn has a 45-second budget, including a 5-second
reserve for settlement. Model and tool work stops starting after 40 seconds.
Each model call has a 15-second cap, shortened to the work time left in the turn.
This leaves 15 seconds of the API Lambda's 60-second timeout for entitlement,
context loading, and returning the response. A tool already running finishes and
settles before the turn stops. When time runs out, the dealer gets a plain note
asking them to send another message to continue, with the executed-tool transcript
and credits already settled. Completed work stands; the limit adds no answer charge.

The handler uses the #99 credit ledger and entitlement implementation. Reads cost
1 credit and writes 2. A final answer costs 1 only when no action charge settled
during the turn; failed actions stay free. The example above uses 1 credit for
the lookup. With no
active plan, before any provider or tool work, the endpoint returns HTTP 402:

```json
{"error":{"code":"ASSISTANT_PLAN_REQUIRED","message":"An AI assistant plan is required."}}
```

When entitlement is allowed, an unconfigured provider returns HTTP 503 with
`ASSISTANT_UNAVAILABLE`; a provider failure returns HTTP 502 with
`ASSISTANT_PROVIDER_FAILED`. Authentication and membership errors retain their
normal 401/403 responses. An admin-disabled plan returns HTTP 403
`ASSISTANT_DISABLED`; an exhausted pool without overage returns HTTP 402
`ASSISTANT_CREDITS_EXHAUSTED`. `GET /assistant/pool` supplies the plan and balance,
and `GET /assistant/usage` supplies attributed usage without chat content.

Set `FREEDMS_ASSISTANT_MODEL` to the Bedrock model/inference profile ID. The SDK
uses the deployment's AWS credentials and region. Converse requests have a
15-second abort deadline and no automatic retries. The pilot uses NVIDIA Nemotron
3 Super 120B (`nvidia.nemotron-super-3-120b`) through regional on-demand Bedrock.
Nemotron requests omit explicit cache checkpoints, which this model does not
support. Claude requests retain a cache checkpoint after the static system prompt
covering the tools/system prefix, following the
[AWS prompt caching documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
There is no model fallback or content logging. Live model access, IAM permissions,
and cache-hit measurements require deployment verification; tests use no Bedrock
network calls.

For local testing only:

```sh
FREEDMS_ASSISTANT_STUB=1 npm run dev
```

Sign in through the local app, create a vehicle, then open the AI assistant pill
and ask about its stock number (or POST the request above using its session token).
The local test double requests `search_vehicles` for vehicle,
VIN, or stock messages and summarizes the results. Other messages receive a line
identifying the test double. Stub mode also seeds a local paid-plan test record. Both
are selected only in `local.ts`, behind its production/Lambda guard; the Lambda
bundle does not import the test double and ignores `FREEDMS_ASSISTANT_STUB`.
Without stub mode, signed-in local requests return the default paywall.

## Tray and availability

Every signed-in route has an AI assistant pill at the top right. Opening it shows
a 400px tray (full width on mobile) with a scrim. Close, Escape, or the scrim
returns focus to the pill; the dialog contains keyboard focus while open. Enter
sends and Shift+Enter adds a line. The empty state lists capabilities and the
human-only exclusions. The assistant acts as the signed-in user.

The pill mounts immediately. On shell render, on open, and after every completed
turn, the browser requests `/assistant/pool` without blocking the page:

- No plan (`ASSISTANT_PLAN_REQUIRED` or HTTP 402), or a non-active plan: paywall,
  with no working composer. No-plan errors show no balance.
- Active plan with `disabled: true`: admin-disabled copy and locked composer.
- Active, enabled plan with `balanceCredits <= 0` and no overage: exhausted copy,
  locked composer, and the pool's cycle end date. Prior conversation stays visible.
- Otherwise: ready, showing the empty state or the in-memory conversation.
- A pool network/server failure locks the composer with a retry-on-reopen message
  (or preserves an already known locked state) and never produces a page-level error.

There is no provider status endpoint. A chat 503 / `ASSISTANT_UNAVAILABLE` reveals
the unconfigured state and locks the composer for the browser session (reload
after configuration changes). Chat entitlement errors switch to their matching
paywall/disabled/exhausted states and refresh the pool. A 502 leaves the user's
message visible, displays an inline error, and allows an explicit retry.

A working indicator covers the request; tool rows arrive only with the final
response, followed by the reply and `This used N credits` from `creditsUsed`.
The pool refresh updates the pill balance. No streaming or tool progress is
simulated. Tool names have plain-word labels and failed tools remain visible.

Conversation and drafts live only in module-level browser memory, survive route
renders, and reset on reload, sign-out, or a different signed-in identity. Failed
turns remain visible but are omitted from subsequent API history. Requests include
at most the last 24 completed exchanges plus the new message (49 turns).
Neither chat content nor drafts are persisted or logged by the tray.

Account → AI assistant lets admins subscribe, open Stripe's billing portal, and
buy top-ups at 25 cents per credit. The three prices come from shared tier data.
Without billing configuration and with no plan, the page offers a waiting list
instead: the admin picks a tier to be notified when paid plans open, and can
change tiers or leave. Joining grants no plan, credits, or entitlement. The
pilot operator sees all waiting-list entries on the Pilot requests page. Once
billing is configured, Subscribe buttons replace the waiting list. Settings and
existing plans still work.

In hosted Stripe test mode, sandbox billing and paid AI use are restricted to
the app super admin: the exact active admin user and tenant configured by
`PilotOperatorSubject` and `PilotOperatorTenantId`. Checkout and seat changes
can assign only that user. Other dealership admins see the waiting list, even
if an old test plan exists, and staff cannot use sandbox credits. The API
enforces this for billing, chat, skills, usage, and signed payment webhooks;
hiding checkout in the UI is not the access control. Missing operator settings
or unavailable billing secrets do not reopen sandbox access. Explicit live
mode retains normal assigned-user billing and access.

Hosted billing loads a JSON secret from AWS Secrets Manager using `StripeSecretArn`.
The Lambda role can read only that secret. Keys stay out of Lambda environment
variables and release artifacts; the loader refreshes its cache every 60 seconds.
If loading fails, billing is unavailable while the free DMS continues working.
The secret contains `FREEDMS_STRIPE_SECRET_KEY`, `FREEDMS_STRIPE_WEBHOOK_SECRET`,
`FREEDMS_STRIPE_PRICE_ASSISTANT`, `FREEDMS_STRIPE_PRICE_ASSISTANT_PRO`,
`FREEDMS_STRIPE_PRICE_ASSISTANT_HEAVY`, `FREEDMS_STRIPE_PRICE_TOPUP`, and optionally
`FREEDMS_STRIPE_PORTAL_CONFIGURATION`. Local development can supply those names
as environment variables. Hosted Checkout does not need a browser publishable key.

Run `node --import tsx scripts/stripe-setup.ts <secret-arn>` to configure sandbox
products, prices, the billing portal, and webhook, then save their configuration
back to the secret. The operation reuses existing products and lookup keys and
checks amounts before accepting existing prices. Live keys require `--live`;
use a separate secret and catalog for live mode. Never put secret values in Git,
CLI arguments, build variables, or logs. Test mode is visibly labeled in the UI.

Admins explicitly select the active users who receive AI access. Only those
users count toward the monthly subscription quantity and can use the assistant.
The dealership selects one tier. Ordinary user creation grants no AI access or
credits. Initial Checkout defaults to the requesting admin when no selection is
provided. Concurrent retries share a persisted, one-hour Checkout purchase and
Stripe idempotency key. A conflicting open purchase must finish or expire first.

Seat increases and tier upgrades use Stripe pending updates and immediate
proration invoices. Access and additional credits wait for confirmed payment;
failed payments can be resolved in the portal. Seat reductions lower future
charges without refunding this month's payment. Reassigning existing seats does
not create new credits. Plan and seat changes belong in FreeDMS; the portal
supports payment details, invoices, and cancellation at the paid period's end.

Monthly allowances use Stripe's exact paid period timestamps and quantity.
Payment webhooks create the next allowance atomically; reading the pool cannot
renew it. Purchased credits carry forward after included credits are consumed.
Renewal protects the previous cycle version so concurrent usage cannot duplicate
carryover. Paid upgrades grant a prorated increase once, with a capacity high-water
mark to prevent repeated upgrade/downgrade events creating credits. Top-ups cost
25 cents per credit, require at least two credits, and create paid invoices.
Payment validation checks the pre-tax subtotal, configured price, quantity,
currency, and paid state. Automatic tax is not enabled by the setup script;
configure the applicable collection policy before live activation.

The webhook is `POST /assistant/billing/webhook` (hosted URL:
`https://app.freedms.co/api/assistant/billing/webhook`). The SDK and webhook use
Stripe API `2026-10-28.endive`. The setup script registers Checkout completion and
async success, subscription changes and pending updates, invoice payment outcomes,
refunds, and disputes. Customer mappings are server-owned and tenant-bound.
Signature checks use raw bytes. Event/payment receipts, plan changes, credit
changes, and outbox events commit atomically. Conflicts retry through Stripe.

Past-due or expired paid periods pause use. Refunds/disputes place the paid
assistant on a persistent billing-review hold, visible to admins; ordinary
subscription webhooks cannot clear it. The operator must reconcile the payment
and credits before clearing `billingHold` with an audited plan update. This hold
does not cancel a subscription; use Stripe to resolve cancellation/refunds.
Automatic overage is disabled for Stripe-backed plans. No unpaid usage is billed
later. The free DMS remains available throughout billing interruptions.

Offline verification: `npm test` and
`node --import tsx packages/web/test/assistant-tour.mjs`. The tour constructs states
through real handler options and memory repository records, uses the local
provider test double, blocks external requests, and saves eight screenshots to
`~/workspace/tools/screenshots/freedms/assistant/` plus the README conversation
capture at `docs/screenshots/ai-assistant.png`.
