import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { requireId } from '../errors.js';
export interface AccessClaims { sub: string; iss: string; exp: number; client_id: string; token_use: string; scope: string }
export interface McpConfig {
  issuer: string; clientId: string; resource: string;
  jwks?: () => Promise<{keys: (JsonWebKey & {kid?: string; alg?: string; use?: string})[]}>;
  now?: () => number;
}
export function accessVerifier(config: McpConfig) {
  const now = config.now ?? Date.now;
  let cache: Awaited<ReturnType<NonNullable<McpConfig['jwks']>>> | undefined, fetched = 0;
  let pending: Promise<NonNullable<typeof cache>> | undefined;
  const fetchKeys = config.jwks ?? (async () => {
    const result = await fetch(`${config.issuer}/.well-known/jwks.json`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
    if (!result.ok) throw Error('Unauthorized');
    return await result.json() as NonNullable<typeof cache>;
  });
  return async (authorization = ''): Promise<AccessClaims> => {
    if (!/^Bearer [^ ]+$/i.test(authorization)) throw Error('Unauthorized');
    const [header, payload, signature, extra] = authorization.slice(7).split('.');
    if (!header || !payload || !signature || extra) throw Error('Unauthorized');
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AccessClaims;
    if (h.alg !== 'RS256' || typeof h.kid !== 'string' || claims.iss !== config.issuer ||
      claims.client_id !== config.clientId || !config.clientId || claims.token_use !== 'access' ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now() / 1000 ||
      typeof claims.scope !== 'string' || !claims.scope.split(' ').some(s => ['freedms/mcp.read', 'freedms/mcp.write'].includes(s))) throw Error('Unauthorized');
    requireId(claims.sub);
    if (!cache || now() - fetched > 300_000) {
      pending ??= fetchKeys();
      try { cache = await pending; fetched = now(); } finally { pending = undefined; }
    }
    const key = cache.keys.find(k => k.kid === h.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!key || !verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({key, format: 'jwk'}), Buffer.from(signature, 'base64url'))) throw Error('Unauthorized');
    return claims;
  };
}
export function mcpConfig(): McpConfig {
  return {issuer: process.env.TOKEN_ISSUER ?? 'http://127.0.0.1:3001/mock-cognito',
    clientId: process.env.MCP_CLIENT_ID ?? 'freedms-local-mcp', resource: process.env.MCP_RESOURCE_URI ?? 'http://127.0.0.1:3001/mcp'};
}
