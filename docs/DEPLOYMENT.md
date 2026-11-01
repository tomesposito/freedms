# Invite-only pilot deployment

The pilot uses Node 24 Lambda, API Gateway HTTP API, DynamoDB, Cognito, private
S3 buckets, and CloudFront. Deploy `infra/template.yaml` in `us-east-1`.
The apex serves the marketing site from `site/`; `app.<RootDomain>` serves the
invite-only application. Both use the same private S3 bucket and CloudFront Free
subscription. The application frontend uses `/api`; CloudFront
removes that prefix and adds a private origin header. Lambda rejects direct
origin traffic without that credential. API responses are never cached.

The pilot launched at `https://app.freedms.co/` on October 25, 2026. The marketing
site is published at `https://freedms.co/`. CloudFormation completed successfully and the CloudFront Free
subscription was verified active with this distribution, WAF, and DNS zone.
The release passed 292 automated tests plus live checks of password change,
required authenticator enrollment, authenticated access, tenant isolation, buyer
sharing, document upload/download, S3 version recovery, and database backup/restore.
Temporary verification accounts, records, objects, and restore resources were
removed before creating the administrator and fictional demo workspace.

## Access model

Only the operator creates Cognito identities. Self-registration is disabled.
The first administrator is provisioned directly; additional users receive an
operator-created account and a single-use dealership invitation. Acceptance
requires a verified Cognito ID token with the invitation's email and immutable
tenant ID. Membership uses the Cognito subject, never a generated local identity.
The operator verifies the recipient before creating an account and shares the
initial password privately. The CLI suppresses invitation emails. Cognito requires
a new password and authenticator enrollment on first sign-in.

Admins can change roles and deactivate/reactivate members in Users. Every API
request checks active membership, so deactivation blocks existing sessions.
Adding identities and recovering authenticators remain operator responsibilities.
Hosted account screens do not expose the independent local-development MFA system.

## Access-request email

Verify your sender address or domain in SES in the deployment region and publish
its DKIM DNS records. Set the template parameters `MailFrom` (your verified sender
address) and `AccessRequestNotifyTo` (your operator inbox); these supply `MAIL_FROM`
and `ACCESS_REQUEST_NOTIFY_TO` to the API. Both default to empty. With either value
unset, submissions are still stored and no email is attempted.

SES starts in the sandbox, where recipients must also be verified. Verifying your
own operator inbox is enough for the pilot. Request SES production access when
you want to send to unverified recipients; filing that request is an operator step.
Only new requests trigger email; repeat submissions update the stored record.
Mail failures leave the saved request intact for the operator readout.

## Pilot request inbox

Set `PilotOperatorSubject` to the operator's immutable Cognito subject and
`PilotOperatorTenantId` to their workspace ID. Both default to empty, which
disables the inbox. An active administrator membership in that exact workspace
is required on every request; dealership administrators do not receive access
to the global queue. Do not use an email address or a client-supplied role as
the operator identity.

The configured operator sees **Pilot requests** in the sidebar. The inbox lists
pending and handled requests with contact details and messages. **Mark handled**
uses the displayed record version so a newer submission cannot be silently
overwritten. It does not send email, create an account, or issue an invitation.
The existing operator CLI remains available for reviewing and handling requests.

## Access-request CAPTCHA

Create a Cloudflare Turnstile widget in Tom's Cloudflare account for `freedms.co`.
Set its public site key as `TURNSTILE_SITE_KEY` in the environment of the marketing
release build (for example, `TURNSTILE_SITE_KEY=your-public-site-key node ops/releases/package.mjs`
with the usual release environment). Set the matching secret in the stack parameter
`TurnstileSecret`, which supplies `TURNSTILE_SECRET` to the API. The secret is
`NoEcho` and must never go in the site build.

Both settings are optional. With neither set, the form retains honeypot-only
protection; without a site key the packager removes the widget and script.
Without the secret the API does not require a challenge. If the site key is unset
while the secret is configured, requests fail closed with a retryable error;
clear the secret as well to return to honeypot-only mode. Configure both halves
together to enable CAPTCHA protection.

## Local verification

Use Node 24 (`.nvmrc`), then:

```sh
npm ci
npm run build
npm test
python3 -m venv .venv
.venv/bin/pip install aws-sam-cli cfn-lint
sam validate --lint --template-file infra/template.yaml
```

Some SAM/cfn-lint releases predate `AWS::PricingPlanManager::Subscription`. If the
only lint error is its missing schema, obtain the public schema from the selected
AWS region and validate against it rather than ignoring resource validation:

```sh
mkdir -p .pilot/schemas
aws cloudformation describe-type --type RESOURCE \
  --type-name AWS::PricingPlanManager::Subscription --query Schema --output text \
  > .pilot/schemas/pricing-plan.json
.venv/bin/cfn-lint --registry-schemas .pilot/schemas --template infra/template.yaml
```

`.pilot/`, `.venv/`, build output, and `.aws-sam/` are ignored. Keep operator files
mode 0600 inside a mode 0700 directory. Never commit credentials, tokens, emails,
account IDs, or generated stack outputs. Runtime dependencies use Apache-2.0/MIT.

## Deploy and publish

1. Verify `aws sts get-caller-identity`, region, existing DNS, remaining provisioned
   DynamoDB allowance, and CloudFront Free-plan slots. The template allocates
   **5 RCU and 5 WCU**, with no automatic scaling. These allowances are shared with
   other applications; this allocation is not independently guaranteed free.
2. Build, then package with SAM. Use a private artifact bucket or `sam package
   --resolve-s3 --s3-prefix freedms-pilot --template-file infra/template.yaml
   --output-template-file .pilot/packaged.yaml --region us-east-1`.
3. Supply `RootDomain`, the existing `HostedZoneId`, `AlertEmail`, a random
   `OriginSecret` of at least 32 characters, and a unique `CognitoDomainPrefix`.
   Set `PublishSite=false`. Pass parameters in a private file, not shell arguments.
   Create and inspect a CloudFormation change set with `CAPABILITY_IAM`, then execute
   it. Keep the origin credential out of logs, frontend variables, and output files
   intended for sharing.
4. Read stack outputs. Confirm the pricing subscription is `ACTIVE`, its tier is
   `FREE`, and its associated resources are this distribution, WAF ACL, and DNS zone.
   Do not publish if that check fails. The template explicitly selects the Free plan;
   WAF/DNS may accrue standard charges if subscription creation fails.
5. Build the web app with `VITE_API_URL=/api`, `VITE_COGNITO_DOMAIN`, and
   `VITE_COGNITO_CLIENT_ID` from outputs. Set `VITE_COGNITO_USER_POOL_ID` from
   the `CognitoUserPoolId` output to enable in-app SRP sign-in.
   `VITE_AUTH_FLOW=redirect` selects the retained hosted UI for rollback; without
   a pool ID the app also falls back to redirect. `VITE_COGNITO_REGION` optionally
   overrides the region derived from the pool ID. `VITE_COGNITO_ENDPOINT` is only
   for the offline test harness and must be unset for production. Live SRP
   verification happens after the operator deploys the template auth-flow change.
   Upload hashed assets with long immutable
   caching; upload `index.html` last with `Cache-Control: no-store`. Keep previous
   release assets and a copy of each previous index for rollback. Package the marketing
   site with `ops/releases/marketing.mjs`: upload its content-addressed screenshots
   under `marketing/assets/` and its page as `marketing/index.html` in the same
   frontend bucket. The viewer function maps apex requests to that prefix. Upload
   these files before enabling the marketing route; never overwrite the app index
   with the marketing page. Both indexes use `Cache-Control: no-store`.
6. Provision the administrator and optional fictional demo records using the CLI
   below. Verify HTTPS, unauthenticated rejection, login/MFA, tenant isolation,
   documents, and recovery. `PublishSite=false` keeps public app/apex DNS absent;
   `curl --connect-to` can exercise the intended host through the distribution
   before DNS cutover.
7. Update the existing stack with `PublishSite=true`, using previous values for
   unchanged parameters. Verify the apex marketing page, app login, and the public API path.
   Confirm the SNS subscription email to receive operational alarms.

The API entry point receives only verified API Gateway claims. Public routes are
limited to buyer share view/respond/upload, invitation lookup, and ADF intake.
Their existing token checks still apply. Use AWS-managed cache, origin-request,
and response-header policies: custom policies are not eligible for the Free plan.
Invitation acceptance remains Cognito protected. No local session route is deployed.

## Operator CLI

Create a private JSON file containing these fields (values below are examples):

```json
{
  "accountId": "YOUR_ACCOUNT_ID",
  "region": "us-east-1",
  "stackName": "freedms-pilot",
  "tenantId": "A_NEW_UUID",
  "name": "Pilot Administrator",
  "email": "administrator@example.test",
  "dealership": "Demo Dealership",
  "demo": true,
  "accessFile": "/absolute/private/admin-access.json"
}
```

```sh
npm run pilot -- bootstrap /absolute/private/operator.json
npm run pilot -- demo /absolute/private/operator.json
```

Bootstrap can be retried for the same administrator without replacing existing
records. It saves the temporary credential before making the Cognito write so an
interrupted write can be recovered. Do not rerun with a different person or reuse
an access file for another person. The credential expires after Cognito's temporary
password validity period; resetting it is a separate operator action.

For another user, use a separate config/access file with the same tenant ID,
`actorId` set to the existing administrator's subject, and `role` set to `staff`
or `admin`. Run `npm run pilot -- invite /absolute/private/invite.json`. Privately
share the generated invitation URL and initial credential. No email is sent.
The Cognito email identity belongs to one dealership in this pilot.

The demo loader is never bundled into Lambda or invoked at startup. It checks for
an empty workspace and no webhook destinations, then creates synthetic inventory,
customers with `example.test` addresses, leads, deals, accounting entries, parts,
and service records through the application handlers. Run once before admitting
users. A partial failure stops; inspect the partial records rather than deleting
or blindly rerunning. Never export synthetic VINs to live services.

## Costs and operational limits

- CloudFront subscription: Free, with WAF and this existing DNS zone associated.
- DynamoDB: fixed 5/5 capacity and standard storage; shared account allowances apply.
  Imports and reporting can exhaust burst capacity; monitor throttles before growth.
- Lambda: 256 MB, ARM64, two concurrent invocations, 15-second timeout.
- API Gateway: 5 requests/second and burst 10; requests can incur usage charges.
- Cognito Lite: required software-token MFA; no SMS or paid advanced security tier.
- Documents: encrypted S3, versioning, 30-day noncurrent version expiry. Current
  documents are deleted only by explicit application actions.
- DynamoDB point-in-time recovery: one day. This is separately billed; retained
  storage, backup storage, S3 requests, email, and AI are not guaranteed free.
- Logs: 14 days. No request bodies, bearer tokens, or customer content in access logs.
- The $10 monthly budget is **account-wide**, with actual-cost and forecast alerts.
  It includes other applications and is an alert, not a spending cap.
- SNS alarms cover API errors, Lambda failures, and DynamoDB write throttling. No always-on
  compute, NAT gateway, load balancer, or provisioned Lambda concurrency is created.

## Recovery and rollback

DynamoDB, document storage, frontend storage, and Cognito are retained across stack
removal. Retention prevents accidental deletion but can continue to incur charges.
Restore DynamoDB to a **new** table with point-in-time recovery, verify tenant
records and totals, then explicitly repoint the Lambda/table IAM policy. Never
replace the live table before verifying the restore. S3 deleted objects can be
recovered from retained versions within 30 days. Keep application metadata and
object versions consistent when restoring an attachment.

For application rollback, restore the previous Lambda artifact/template and
previous application and marketing indexes; keep hashed assets immutable. To withdraw the pilot,
remove public DNS with `PublishSite=false`; CloudFront remains reachable by its
service hostname, so revoke memberships or disable the distribution as well if
access itself must stop. Do not delete retained data as a rollback step.

## GitHub Actions releases

`freeDMS CI and release` tests every pull request. Pushes to `master` and manual
runs on `master` also publish `build-<full-source-sha>` with `api.zip`,
`web.tar.gz`, a manifest binding every file, and GitHub build provenance.
Publishing does not deploy. The public repository has no AWS trust or access keys.
The build uses repository variables `VITE_COGNITO_DOMAIN` and
`VITE_COGNITO_CLIENT_ID`, plus optional `VITE_COGNITO_USER_POOL_ID`
(format `us-east-1_xxx`) and `VITE_AUTH_FLOW=redirect` for rollback; these are public browser configuration, not credentials.
The release workflow defaults to `VITE_AUTH_FLOW=inapp` and requires the pool ID.
The manifest configuration digest binds both the pool ID and selected login flow;
switching either requires an independently verified operator baseline update before
approval. Production packaging rejects test Cognito endpoints and region overrides
outside `us-east-1`. The in-app page supports initial authenticator enrollment as
well as password changes and existing authenticator challenges; MFA remains required.
Every release also packages `site/` with content-addressed screenshots under
`marketing/` in `web.tar.gz`. The version-2 manifest binds both frontends. The
marketing page describes the invite-only pilot and links sign-in to the app;
legacy apex `/signup` links point to the pilot information section and `/login`
redirects to the app. Only `POST /api/access-requests` reaches the API on the apex; other unknown apex paths (including other `/api/*` paths) return 404.

Application branding lives in `packages/web/src/assets/` and is referenced through
`src/brand.ts` or the HTML favicon link. Vite emits versioned SVG files under
`assets/`; marketing branding uses the same immutable naming convention under
`marketing/assets/`. Keep static assets out of the web public directory: root-level
files are rejected by the packager and controller and are outside the deployment
role's S3 permissions. Changed logos get new URLs so old releases remain recoverable.

The one-time marketing cutover updates only the CloudFront viewer function in the
pilot stack, using its existing packaged template to preserve the Lambda artifact.
An operator must stage the marketing files first, inspect the change set, verify
both hosts and the Free subscription, then record the new infrastructure digest,
`marketingUrl`, and live `marketingIndexSha256` in the private release baseline.
The release-access stack additionally grants read/write access only to
`marketing/index.html` and `marketing/assets/*`; its reviewed controller pin must
match the version-2 controller. Version-1 builds require an operator migration and
are not accepted by this controller.

The private `tomesposito/freedms-deploy` repository contains a manual
`Deploy approved freeDMS release` workflow. Its reusable controller is pinned to a
reviewed commit, and AWS OIDC trust binds that commit, the private repository's
numeric identity, owner identity, `master`, and the dispatch event. Credentials
last 15 minutes. The deployment role can update only this application's Lambda
code, application and marketing indexes/assets, and private release records. It cannot write its own
approvals/configuration, change IAM, deploy infrastructure, provision users, or
access the database/document bucket directly. Deploying code can exercise the
application's runtime permissions, so source review remains required.

### Release an application change

The SEO marketing rollout also requires a one-time operator migration. Stage the
five marketing documents (`robots.txt`, `sitemap.xml`, `llms.txt`, `dms-cost.html`,
and `free-dealer-management-software.html`) and their immutable assets from an
attested release before enabling their CloudFront routes. Preserve the live Lambda
artifact when updating the viewer function. Grant the release role access to only
these five additional keys, pin the updated private controller, verify public
routes and the Free subscription, and record the infrastructure digest and each
document digest under `marketingDocumentsSha256` in the release baseline.

Every subsequent release checks those digests, snapshots all five documents,
uses conditional writes, and restores them with the Lambda and both indexes if
promotion fails. External edits stop recovery and retain the durable lock.
Adding or removing a document path requires another operator baseline migration.

1. Merge the reviewed change into `master` and wait for the public build to pass.
2. Download `release.json` from `build-<full-source-sha>` and calculate its SHA-256.
   Review backward compatibility, especially stored records, authorization, and
   request/response contracts. The release path supports compatible application
   changes only. It rejects changes to `infra/template.yaml` or hosted frontend
   configuration; infrastructure and data migrations require a separate operator
   deployment and explicit baseline update.
3. From an independently authenticated AWS operator session, approve the exact
   source and manifest. Use GitHub CLI authenticated for public artifact/provenance
   reads (`FREEDMS_GH_BINARY` can select its installed path):

   ```sh
   python3 ops/releases/release_operator.py approve /private/release-operator.json \
     --source FULL_SOURCE_SHA --manifest MANIFEST_SHA256
   ```

   The private operator JSON contains `accountId`, `operatorArn`, and
   `operationsBucket`. Approval verifies the trusted master-build provenance,
   archive/file digests, live application, and current deployment record. It
   expires after four hours and is bound to the exact current state/configuration.
4. Run the private workflow from `master` with `mode=preflight`, that source, and
   that manifest digest. Then run it with `mode=deploy` and the same values.
   `mode=probe` checks OIDC access and the current application without changing it.
5. A successful deployment checks the actual Lambda code digest, both S3 indexes, every
   public application and marketing file, anonymous API rejection, and invalid-share rejection.
   The private current-release record is updated only after those checks pass.
   `release_operator.py status /private/release-operator.json` reads that record and checks
   the live Lambda and both indexes again. These are public smoke checks, not a fresh
   authenticated end-to-end business transaction.

The controller downloads data artifacts only; it never checks out or executes the
requested public source with AWS credentials. Existing frontend assets are kept
and never overwritten with different bytes. The previous Lambda ZIP and both indexes are
saved before promotion. Ordinary failures attempt recovery and verify it; failed
recovery or a lost runner leaves a durable lock that blocks further deployments.

### Interrupted releases and rollback

To return to an earlier compatible published build, independently approve that
build and deploy it through the same workflow. Approval cannot be replayed after
the current release changes. A recovered failed release also changes the current
record, requiring a fresh approval before retrying.

If a job disappears or recovery fails, **do not simply rerun or delete the lock**.
Using independent operator credentials, read `state/lock.json`, its matching
`history/<operation>/snapshot.json`, and the actual Lambda and both indexes. Confirm no job
is running. Restore the snapshot's `api.zip` with Lambda's current `RevisionId`,
wait for the update, restore its `index.html` and `marketing.html` to the application
`index.html` and `marketing/index.html` keys with `Cache-Control: no-store`, and
verify all three hashes against `snapshot.previous`. Write a new current record based
on `snapshot.previous` with a recovery timestamp, then conditionally delete the
observed lock. The snapshot and lock survive cancellation; there is no unattended
watchdog that can guarantee recovery after the runner is lost.

Release access is managed by the separate `infra/release-access.yaml` stack.
Changing the controller requires a new reviewed private commit, updated wrapper
pin, and an independently applied AWS trust change. For emergency shutoff, an
operator can attach an explicit deny-all inline policy to the dedicated deploy
role to block existing sessions, then remove its OIDC trust to block new sessions.
This does not disable runtime roles or alter the shared OpenSight OIDC provider.

GitHub-hosted public builds and the account's included private Actions allowance
avoid an always-on runner. Private minutes, artifact/release retention, S3 release
snapshots, and normal AWS requests remain subject to account quotas and charges.

## AI connection grants

After tenant binding and authorization succeed, MCP requests record a
user/app grant in the dealership partition. The registered app name is saved
with its scopes; last-used time and scopes refresh at most once an hour.
Recording is best effort. Creation and revocation emit atomic outbox events.
Members can revoke their own grants in AI connections; administrators can revoke
any grant in their dealership. Revocation takes effect on the next MCP
request: already-issued access tokens are checked against the grant record on
every call, and token values are never stored. A read revoked grant
returns the normal 401 resource-metadata challenge. Storage errors fall back to
allowing the request; revocation does not provide an outage-time guarantee.
Revoked grants are terminal; re-consent is not implemented here.

## MCP connector

The stateless Streamable HTTP endpoint is `https://app.<RootDomain>/api/mcp`.
Protected Resource Metadata is served at
`https://app.<RootDomain>/api/.well-known/oauth-protected-resource`; unauthenticated
requests advertise that URL in the Bearer challenge. CloudFront strips `/api`;
the API routes are `POST /mcp` and `GET /.well-known/oauth-protected-resource`.
`MCP_RESOURCE_URI` supplies the canonical endpoint and `TOKEN_ISSUER` the Cognito
pool issuer. Local defaults use `http://127.0.0.1:3001/mcp` and a mock issuer.
The local adapter mounts the same handler; offline tests inject RSA JWKS and a
clock rather than contacting Cognito. Local web ID tokens are not MCP credentials.

The template creates an MCP client with OAuth enabled by default because Muse's callback is pre-registered in `McpCallbackURLs`. Operators can override `McpCallbackURLs`; an empty value disables OAuth flows again. `McpLogoutURLs` is optional.

The registration bridge accepts `POST /mcp/register` (public application URL:
`https://app.<RootDomain>/api/mcp/register`). Consumers that accept an explicit
registration URL can send `client_name`, `redirect_uris`, `grant_types`
(`authorization_code`, optionally `refresh_token`), `response_types` (`code`),
`token_endpoint_auth_method` (`none`), and a space-delimited `scope`. Omitted
OAuth metadata defaults to authorization code, code response, no client secret,
and `freedms/mcp.read`. The response is HTTP 201 with the new client ID and
accepted metadata, never a secret. The consumer handles the ID; dealers connect
by signing in and consenting, without copying IDs or registering callbacks.
Self-registration replaces the operator's console app-client creation and
callback entry for these consumers. The ChatGPT manual callback procedure below
remains the fallback for consumers that cannot use this registration address.
Cognito discovery does not advertise `registration_endpoint`; a metadata facade
is outside this change.

The API role adds only `cognito-idp:CreateUserPoolClient` and
`cognito-idp:DeleteUserPoolClient`, scoped to `UserPool.Arn`. The pool ID is derived
from the existing `TOKEN_ISSUER`; no new pool, secret, or SDK dependency is needed.
The bridge creates public authorization-code clients using the template's MCP
settings, including one-hour access tokens and token revocation. Consumers must
send PKCE `code_challenge_method=S256` and its verifier on exchange; Cognito's
app-client configuration has no setting that mandates PKCE.

Redirects must be HTTPS, or HTTP on literal `localhost` / `127.0.0.1` with any
valid port. Wildcards, fragments and credentials are rejected. Unknown scopes
and unsupported grants, response types or authentication methods return HTTP 400
`invalid_client_metadata`. Registration attempts, including invalid requests,
are limited to 10 per five-minute fixed window per API Gateway source IP, with
HTTP 429 and `Retry-After`. Conditional DynamoDB writes share the limit across
Lambda instances. Source addresses are hashed in one reusable operator counter
row per source; caller-supplied forwarding headers are ignored. Behind a proxy,
Gateway's source IP may group multiple consumers, making this limit conservative.
The existing CloudFront WAF limit (600 requests per viewer IP per five minutes)
also applies, as it does to ideas and access requests.

Records live under `TENANT#operator` / `MCPCLIENT#<client_id>` and contain the
client ID, name, redirect URIs, scopes and creation timestamp. Like access-request
bookkeeping, they do not create dealership outbox events. The configured active
pilot operator admin can list them with `GET /admin/mcp-clients` and clean up with
`DELETE /admin/mcp-clients/<client_id>`. Cleanup deletes Cognito first, then the
record; upstream failure retains the record for retry, and an already-missing
Cognito client is safe to retry. Failed record creation triggers compensating
Cognito deletion. If both storage and compensation fail, an operator must reconcile
the orphaned app client in Cognito.

Integration boundary: this bridge registers consumers but does not change #71's
token validation. The MCP server still accepts only access tokens for the configured
`MCP_CLIENT_ID`, never web-client ID tokens. A newly registered client therefore
requires separate client-bound handler configuration before its tokens can call
MCP; registration alone is not an end-to-end connection. Registered-client trust
and grant enforcement need subsequent integration without relaxing token or tenant
validation. There is no RFC 8707 resource-indicator enforcement in this profile.
Scopes are `freedms/mcp.read` and `freedms/mcp.write`; write implies
read. The latter does not grant rights beyond the user's active membership.

Hosted membership writers atomically maintain an immutable
`SUBJECT#<cognito-sub>` / `TENANT` binding in the existing table. The handler
resolves this binding and rechecks the existing tenant membership on every tool
request. Unknown, inactive, ambiguous (local), or unsupported-role users receive
no tools. Existing hosted records need the scoped operator migration before use:
`TABLE_NAME=<table> node --import tsx packages/api/src/mcp-backfill.ts <tenant-id>`.
Run once for each known dealership; it verifies membership and refuses to move
an already-bound subject. Run the migration only for verified existing dealership memberships before enabling an MCP consumer.

Available reads are `search_vehicles`, `get_vehicle`, `list_leads`, `get_lead`,
`list_customers`, `get_customer`, `list_deals`, `get_deal`, `get_service_board`,
`list_parts`, `get_sales_report`, `get_inventory_aging`, `get_trial_balance`, and
`get_lead_summary`. Inventory writes are `create_vehicle`, `update_vehicle`,
`set_vehicle_status`, and `import_vehicles`. Inputs retain REST filters, bounds,
optimistic versions, and integer-cent money. The existing CSV import format is
an explicit exception at the text boundary: dollar cells are converted by the
shared importer to cents; stored values and returned resources remain cents.

These tools invoke the same handler operations in-process. Reads create no new
audit records, matching REST. Every inventory mutation/import outbox event keeps
`actorId` equal to the connecting user and adds `actorType: agent`. The inventory
UI asks for confirmation only on deletion; deletion is not exposed, so none of
these four writes has a `confirm` argument. No token minting, attestation,
signature, compliance sign-off, terms acceptance, or credit certification tools
are exposed. Those actions remain human-only.

When `EnableManagedLoginBranding=true`, both app clients have `AWS::Cognito::ManagedLoginBranding` resources with navy
`#0B1F2C`, orange `#FF6A00`, rounded inputs/buttons and an embedded base64 copy of
`packages/web/src/assets/logo.svg`. SVG is supported, so no raster conversion or
external image hosting is necessary. Settings follow the
[AWS branding schema example](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-managedloginbranding.html).
The schema does not expose arbitrary font loading; Inter is not forced. Layout
remains Cognito's, not a custom page. **Activation prerequisite:** the current
LITE pool/classic domain must be moved to a managed-login-capable tier and domain
version before applying these branding resources. The flag defaults to false so the Lite pool and custom in-app login can be deployed without those prerequisites. MCP OAuth works with the classic hosted UI and does not require enabling managed-login branding.

For Muse (`custom.freedms`), `https://agent.meta.ai/api/hatch/oauth/callback` is pre-registered by default in the template. The only remaining operator registration step is a stack deploy/update with a reviewed stack parameter update. For an existing stack with an explicit `McpCallbackURLs` value, include Muse's callback in that value; an override replaces the default, so include every callback you intend to retain.

For ChatGPT, create a custom MCP server at `https://app.<RootDomain>/api/mcp` using OAuth and the dedicated client ID. Copy the exact production redirect URI from its management screen into `McpCallbackURLs`; do not guess a callback ID or use a wildcard. New connections can use callback-specific URLs when the issuer does not advertise RFC 9207 support. See [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth). Register the callback with a reviewed stack parameter update, then sign in and approve the requested scopes in ChatGPT. Public endpoint checks alone do not verify the final OAuth connection.
