# Invite-only pilot deployment

The pilot uses Node 24 Lambda, API Gateway HTTP API, DynamoDB, Cognito, private
S3 buckets, and CloudFront. Deploy `infra/template.yaml` in `us-east-1`.
The apex redirects to `app.<RootDomain>`. The frontend uses `/api`; CloudFront
removes that prefix and adds a private origin header. Lambda rejects direct
origin traffic without that credential. API responses are never cached.

The pilot launched at `https://app.freedms.co/` on October 25, 2026; the apex
redirects there. CloudFormation completed successfully and the CloudFront Free
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
   `VITE_COGNITO_CLIENT_ID` from outputs. Upload hashed assets with long immutable
   caching; upload `index.html` last with `Cache-Control: no-store`. Keep previous
   release assets and a copy of the previous index for rollback.
6. Provision the administrator and optional fictional demo records using the CLI
   below. Verify HTTPS, unauthenticated rejection, login/MFA, tenant isolation,
   documents, and recovery. `PublishSite=false` keeps public app/apex DNS absent;
   `curl --connect-to` can exercise the intended host through the distribution
   before DNS cutover.
7. Update the existing stack with `PublishSite=true`, using previous values for
   unchanged parameters. Verify apex redirect, app login, and the public API path.
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
previous frontend index; keep hashed assets immutable. To withdraw the pilot,
remove public DNS with `PublishSite=false`; CloudFront remains reachable by its
service hostname, so revoke memberships or disable the distribution as well if
access itself must stop. Do not delete retained data as a rollback step.
