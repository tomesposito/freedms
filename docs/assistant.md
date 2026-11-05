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
{"data":{"reply":"Found the vehicle.","transcript":[{"tool":"search_vehicles","ok":true}],"creditsUsed":2}}
```

The transcript covers tools executed during this request. Tool failures are sent
back to the model as error results and appear with `ok: false`. At most ten tool
rounds execute, with at most twenty calls per round. Each result sent back to the
model is limited to 16,000 characters with an explicit truncation marker. Further
tool requests after ten rounds return a plain step-limit note.

The handler uses the #99 credit ledger and entitlement implementation. Reads cost
1 credit, writes 2, and the final no-tool answer 1; failed actions and failed turns
are not charged. The example above uses 2 credits (lookup plus answer). With no
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
15-second abort deadline and no automatic retries. A cache checkpoint after the
static system prompt covers the tools/system prefix, following the
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
Without billing configuration the page says "Billing isn't set up yet" and
purchase actions are unavailable. Settings and existing plans still work.

Configure `FREEDMS_STRIPE_SECRET_KEY`, `FREEDMS_STRIPE_WEBHOOK_SECRET`, and
`FREEDMS_STRIPE_PRICE_ASSISTANT`, `FREEDMS_STRIPE_PRICE_ASSISTANT_PRO`,
`FREEDMS_STRIPE_PRICE_ASSISTANT_HEAVY`, `FREEDMS_STRIPE_PRICE_TOPUP`.
Prices are created in Stripe: USD monthly per-user prices and a USD 25-cent
one-time per-credit price. Set `FREEDMS_APP_BASE_URL` to the app's absolute URL;
the template uses the app domain, and local development uses its loopback origin.
No trial or promotional credits are granted. Checkout uses the active user count.

The signature-authenticated webhook is `POST /assistant/billing/webhook`
(hosted URL: `/api/assistant/billing/webhook`). Subscribe it to checkout completion
and asynchronous payment success, subscription created/updated/deleted, and invoice
paid/payment_failed/payment_action_required events. Requests use Stripe API version
`2025-03-31.basil`; configure the webhook endpoint to the same version. The adapter
reads subscription item periods and also accepts older subscription-level periods.
Customer linkage is stored before checkout. Webhooks resolve the stored customer
binding and commit receipts, plan changes, credit additions and outbox events
atomically. Payment-session receipts prevent different events crediting one payment
twice. Stripe retries optimistic conflicts; duplicate deliveries are acknowledged.

Past-due subscriptions pause use with `ASSISTANT_PAST_DUE` and a payment note.
Cancellation shows its access-end date; access stops then, or immediately when
Stripe reports an ended subscription. Disabled assistants remain hidden.
Chat content is never persisted or logged.

Offline verification: `npm test` and
`node --import tsx packages/web/test/assistant-tour.mjs`. The tour constructs states
through real handler options and memory repository records, uses the local
provider test double, blocks external requests, and saves eight screenshots to
`~/workspace/tools/screenshots/freedms/assistant/` plus the README conversation
capture at `docs/screenshots/ai-assistant.png`.
