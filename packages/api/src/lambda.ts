import { providerFromEnv } from './ai-provider.js';
import type { AuthClaims } from '@freedms/shared';
import { validateClaims } from './auth.js';
import { DynamoRepositories } from './dynamo.js';
import { createHandler, errorResponse } from './handler.js';
import { NhtsaVinDecoder } from './vin.js';
interface GatewayEvent {
  headers?: Record<string, string>; rawPath: string; body?: string; isBase64Encoded?: boolean; queryStringParameters?: Record<string, string>;
  requestContext: {http: {method: string}; authorizer?: {jwt?: {claims: Record<string, unknown>}}};
}
const repositories = new DynamoRepositories(process.env.TABLE_NAME!);
const handle = createHandler(repositories, new NhtsaVinDecoder(), () => new Date(), undefined, providerFromEnv());
export async function handler(event: GatewayEvent) {
  try {
    // API Gateway verifies signature/issuer/audience. Never decode a caller header as trusted claims.
    const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
    const isIntake = event.rawPath.replace(/\/$/, '') === '/intake/adf' && event.requestContext.http.method === 'POST';
    if (!isIntake) validateClaims(claims, process.env.TOKEN_ISSUER!, process.env.TOKEN_AUDIENCE!);
    return await handle({method: event.requestContext.http.method, path: event.rawPath, query: event.queryStringParameters,
      body: event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body, ...(isIntake ? {intakeToken: (event.headers?.authorization ?? '').replace(/^Bearer /, '')} : {claims: claims as unknown as AuthClaims})});
  } catch (error) { return errorResponse(error); }
}
