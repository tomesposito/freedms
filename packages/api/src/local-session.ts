/** Loopback development only. Never imported by Lambda. */
import { randomUUID } from 'node:crypto';
import type { RepositoryFactory } from './repository.js';
import { LocalTokens, authorize } from './auth.js';
import { ApiError, requireId } from './errors.js';
import { parseBody, response } from './handler.js';
import { onlyKeys, text } from './validation.js';
import { emailAddress } from './users.js';
import { mfa } from './mfa.js';
export async function localSession(body: string, repositories: RepositoryFactory, tokens: LocalTokens, now = new Date()) {
  const input = parseBody(body);
  if ('tenantId' in input) {
    onlyKeys(input, ['tenantId', 'email', 'code']);
    const tenantId = requireId(input.tenantId), email = emailAddress(input.email);
    const repo = repositories.forTenant(tenantId);
    const row = (await repo.workspaceUsers()).find(r => r.user.email === email && r.membership.active);
    if (!row) throw new ApiError(403, 'FORBIDDEN', 'An active dealership membership is required.');
    const {principal} = await authorize({sub: row.user.id, 'custom:tenant_id': tenantId, iss: '', aud: '', exp: 0, token_use: 'id'}, repositories);
    if ((await repo.mfa(row.user.id))?.enabled) await mfa({path: '/account/mfa/verify', method: 'POST', body: JSON.stringify({code: input.code})}, principal, repo, now);
    return response(200, {data: {token: tokens.issue(row.user.id, tenantId)}});
  }
  onlyKeys(input, ['dealership', 'name']);
  const name = text(input.name, 'Your name'), dealership = text(input.dealership, 'Dealership');
  const tenantId = randomUUID(), userId = randomUUID(), createdAt = now.toISOString();
  await repositories.forTenant(tenantId).provision({id: tenantId, name: dealership, createdAt}, {id: userId, name},
    {tenantId, userId, role: 'admin', active: true}, {id: randomUUID(), tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: createdAt, deliveryStatus: 'pending'});
  return response(201, {data: {token: tokens.issue(userId, tenantId)}});
}
