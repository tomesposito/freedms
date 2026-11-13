import { drainWebhooks, hostedWebhookSender } from './webhooks.js';
import { createBillingLoader } from './billing-secrets.js';
import type { GatewayEvent } from './gateway.js';
import { assistantProviderFromEnv } from './assistant-provider.js';
import { CognitoRegistrationClients } from './mcp/registration.js';
import { turnstileVerifierFromEnv } from './turnstile.js';
import { mailSenderFromEnv } from './mail.js';
import { analyticsFromEnv } from './analytics.js';
import { providerFromEnv } from './ai-provider.js';
import { DynamoRepositories } from './dynamo.js';
import { createHandler } from './handler.js';
import { gatewayHandler } from './gateway.js';
import { S3DocumentStore } from './s3-documents.js';
import { NhtsaVinDecoder } from './vin.js';
if (!process.env.ORIGIN_SECRET || process.env.ORIGIN_SECRET.length < 32) throw new Error('ORIGIN_SECRET is required');
const repositories = new DynamoRepositories(process.env.TABLE_NAME!, undefined, true);
const loadBilling = createBillingLoader();
export const webhookDrainHandler = async () => drainWebhooks(repositories, hostedWebhookSender(), new Date());
export const handler = async (event: GatewayEvent | {source: 'aws.events'; 'detail-type': 'Scheduled Event'}) => {
  if ('source' in event && event.source === 'aws.events' && event['detail-type'] === 'Scheduled Event') return webhookDrainHandler();
  const handle = createHandler(repositories, new NhtsaVinDecoder(), () => new Date(),
    new S3DocumentStore(process.env.DOCUMENTS_BUCKET!), providerFromEnv(), analyticsFromEnv(), undefined, {stripe: await loadBilling(), appBaseUrl: process.env.FREEDMS_APP_BASE_URL, hosted: true, assistantProvider: assistantProviderFromEnv(), registration: {poolId: new URL(process.env.TOKEN_ISSUER!).pathname.slice(1), clients: new CognitoRegistrationClients()}, pilotOperator: {userId: process.env.PILOT_OPERATOR_SUBJECT ?? '', tenantId: process.env.PILOT_OPERATOR_TENANT_ID ?? ''}, turnstile: turnstileVerifierFromEnv(), mail: {sender: mailSenderFromEnv(), notifyTo: process.env.ACCESS_REQUEST_NOTIFY_TO}});
  return gatewayHandler(handle, process.env.TOKEN_ISSUER!, process.env.TOKEN_AUDIENCE!, process.env.ORIGIN_SECRET)(event as GatewayEvent);
};
