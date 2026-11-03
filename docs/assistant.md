# Assistant core

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
{"data":{"reply":"Found the vehicle.","transcript":[{"tool":"search_vehicles","ok":true}]}}
```

The transcript covers tools executed during this request. Tool failures are sent
back to the model as error results and appear with `ok: false`. At most ten tool
rounds execute, with at most twenty calls per round. Each result sent back to the
model is limited to 16,000 characters with an explicit truncation marker. Further
tool requests after ten rounds return a plain step-limit note.

The `AssistantEntitlement.check(principal)` seam denies by default. There is no
plan store, credit metering, or usage ledger in this issue. Before any provider or
tool work, the endpoint returns HTTP 402:

```json
{"error":{"code":"ASSISTANT_PLAN_REQUIRED","message":"An AI assistant plan is required."}}
```

When entitlement is allowed, an unconfigured provider returns HTTP 503 with
`ASSISTANT_UNAVAILABLE`; a provider failure returns HTTP 502 with
`ASSISTANT_PROVIDER_FAILED`. Authentication and membership errors retain their
normal 401/403 responses. Issue #99 supplies the real entitlement implementation.

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

Sign in through the local app, create a vehicle, then POST the request above using
its session token. The local test double requests `search_vehicles` for vehicle,
VIN, or stock messages and summarizes the results. Other messages receive a line
identifying the test double. Stub mode also allows local entitlement checks. Both
are selected only in `local.ts`, behind its production/Lambda guard; the Lambda
bundle does not import the test double and ignores `FREEDMS_ASSISTANT_STUB`.
Without stub mode, signed-in local requests return the default paywall.

No deployment, UI tray, billing, credit records, or other #99–#103 work is included.
