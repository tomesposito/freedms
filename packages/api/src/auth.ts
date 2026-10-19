import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthClaims, Principal } from '@freedms/shared';
import type { RepositoryFactory, TenantRepository } from './repository.js';
import { ApiError, requireId } from './errors.js';
export const LOCAL_ISSUER = 'freedms-local';
export const LOCAL_AUDIENCE = 'freedms-local-web';
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
export class LocalTokens {
  constructor(private secret: string, private now = () => Date.now()) { if (secret.length < 32) throw new Error('Local token secret must be at least 32 characters'); }
  issue(userId: string, tenantId: string): string {
    const claims: AuthClaims = {sub: requireId(userId), 'custom:tenant_id': requireId(tenantId), iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, exp: Math.floor(this.now() / 1000) + 3600, token_use: 'id'};
    const data = `${Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${data}.${this.sign(data)}`;
  }
  private sign(data: string) { return createHmac('sha256', this.secret).update(data).digest('base64url'); }
  verify(token: string): AuthClaims {
    try {
      const [header, payload, signature, extra] = token.split('.');
      if (!header || !payload || !signature || extra || JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') throw unauthorized();
      const expected = Buffer.from(this.sign(`${header}.${payload}`)); const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unauthorized();
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AuthClaims;
      validateClaims(claims, LOCAL_ISSUER, LOCAL_AUDIENCE, this.now()); return claims;
    } catch { throw unauthorized(); }
  }
}
export function validateClaims(claims: Record<string, unknown>, issuer: string, audience: string, now = Date.now()): void {
  if (claims.iss !== issuer || claims.aud !== audience || claims.token_use !== 'id' || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now / 1000) throw unauthorized();
  try { requireId(claims.sub); requireId(claims['custom:tenant_id']); } catch { throw unauthorized(); }
}
export async function authorize(claims: AuthClaims, repositories: RepositoryFactory): Promise<{ principal: Principal; repository: TenantRepository }> {
  const repository = repositories.forTenant(claims['custom:tenant_id']);
  const member = await repository.membership(claims.sub);
  if (!member?.active || member.tenantId !== claims['custom:tenant_id'] || member.userId !== claims.sub || !['admin', 'staff'].includes(member.role))
    throw new ApiError(403, 'FORBIDDEN', 'An active dealership membership is required.');
  return {principal: {tenantId: member.tenantId, userId: member.userId, role: member.role}, repository};
}
export function requireWrite(principal: Principal, method: string): void {
  if (method === 'DELETE' ? principal.role !== 'admin' : !['admin', 'staff'].includes(principal.role))
    throw new ApiError(403, 'FORBIDDEN', 'Administrator permission is required to delete vehicles.');
}
