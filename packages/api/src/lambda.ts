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
const handle = createHandler(repositories, new NhtsaVinDecoder(), () => new Date(),
  new S3DocumentStore(process.env.DOCUMENTS_BUCKET!), providerFromEnv(), analyticsFromEnv(), undefined, {hosted: true, registration: {poolId: new URL(process.env.TOKEN_ISSUER!).pathname.slice(1), clients: new CognitoRegistrationClients()}, pilotOperator: {userId: process.env.PILOT_OPERATOR_SUBJECT ?? '', tenantId: process.env.PILOT_OPERATOR_TENANT_ID ?? ''}, turnstile: turnstileVerifierFromEnv(), mail: {sender: mailSenderFromEnv(), notifyTo: process.env.ACCESS_REQUEST_NOTIFY_TO}});
export const handler = gatewayHandler(handle, process.env.TOKEN_ISSUER!, process.env.TOKEN_AUDIENCE!, process.env.ORIGIN_SECRET);
