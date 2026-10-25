import { analyticsFromEnv } from './analytics.js';
import { providerFromEnv } from './ai-provider.js';
import { DynamoRepositories } from './dynamo.js';
import { createHandler } from './handler.js';
import { gatewayHandler } from './gateway.js';
import { S3DocumentStore } from './s3-documents.js';
import { NhtsaVinDecoder } from './vin.js';
if (!process.env.ORIGIN_SECRET || process.env.ORIGIN_SECRET.length < 32) throw new Error('ORIGIN_SECRET is required');
const repositories = new DynamoRepositories(process.env.TABLE_NAME!);
const handle = createHandler(repositories, new NhtsaVinDecoder(), () => new Date(),
  new S3DocumentStore(process.env.DOCUMENTS_BUCKET!), providerFromEnv(), analyticsFromEnv(), undefined, {hosted: true});
export const handler = gatewayHandler(handle, process.env.TOKEN_ISSUER!, process.env.TOKEN_AUDIENCE!, process.env.ORIGIN_SECRET);
