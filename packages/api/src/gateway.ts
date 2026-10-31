import { isMcpPath } from './mcp/server.js';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import type { AuthClaims } from '@freedms/shared';
import { validateClaims } from './auth.js';
import { errorResponse, type ApiRequest, type ApiResponse } from './handler.js';
export interface GatewayEvent {
  headers?: Record<string, string>; rawPath: string; body?: string; isBase64Encoded?: boolean; queryStringParameters?: Record<string, string>;
  requestContext: {http: {method: string}; authorizer?: {jwt?: {claims: Record<string, unknown>}}};
}
export function gatewayHandler(handle: (request: ApiRequest) => Promise<ApiResponse>, issuer: string, audience: string, originSecret?: string) {
  return async (event: GatewayEvent): Promise<ApiResponse> => {
    try {
      if (originSecret) {
        const supplied = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-freedms-origin')?.[1] ?? '';
        const actual = Buffer.from(supplied), expected = Buffer.from(originSecret);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(403, 'ORIGIN_REQUIRED', 'Use the application URL.');
      }
      const path = event.rawPath.replace(/\/$/, ''), method = event.requestContext.http.method.toUpperCase();
      const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
      const intake = path === '/intake/adf' && method === 'POST';
      const publicLink = (method === 'GET' && /^\/(share|invite)\/[^/]+$/.test(path)) ||
        (method === 'POST' && /^\/share\/[^/]+\/(respond|documents)$/.test(path)) ||
        (method === 'POST' && path === '/access-requests');
      // Only API Gateway's verified claims are trusted. Invite acceptance requires Cognito.
      if (!intake && !publicLink && !isMcpPath(path)) validateClaims(claims, issuer, audience);
      const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? '';
      const acceptEncoding = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === 'accept-encoding')?.[1];
      return await handle({method, path, authorization, acceptEncoding, query: event.queryStringParameters,
        body: event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
        ...(intake ? {intakeToken: authorization.replace(/^Bearer /, '')} : publicLink ? {} : {claims: claims as unknown as AuthClaims})});
    } catch (error) { return errorResponse(error); }
  };
}
