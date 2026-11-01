import { randomUUID } from 'node:crypto';
import type { McpGrant, McpGrantView, OutboxEvent, Principal } from '@freedms/shared';
import { ApiError, missing, requireId } from './errors.js';
import { response, type ApiRequest, type ApiResponse } from './handler.js';
import type { RepositoryFactory } from './repository.js';
import { onlyKeys } from './validation.js';

export const grantEvent = (grant: McpGrant, actorId: string, type: 'mcp-grant.recorded' | 'mcp-grant.revoked'): OutboxEvent => ({
  id: randomUUID(), tenantId: grant.tenantId, actorId, aggregateId: grant.id, aggregateVersion: grant.version,
  type, occurredAt: grant.revokedAt ?? grant.firstGrantedAt, deliveryStatus: 'pending'
});
const view = ({tenantId: _tenant, clientId: _client, ...grant}: McpGrant): McpGrantView => grant;
export async function aiConnections(request: ApiRequest, principal: Principal, repositories: RepositoryFactory, now: Date): Promise<ApiResponse> {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  onlyKeys(request.query ?? {}, []);
  const repo = repositories.forTenant(principal.tenantId);
  if (path === '/ai-connections' || path === '/ai-connections/workspace') {
    const workspace = path.endsWith('/workspace');
    if (workspace && principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can view everyone’s connections.');
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const users = workspace ? await repo.users() : [];
    const grants = (await repo.mcpGrants()).filter(g => workspace || g.userId === principal.userId)
      .sort((a, b) => b.firstGrantedAt.localeCompare(a.firstGrantedAt) || a.id.localeCompare(b.id));
    return response(200, {data: grants.map(g => {
      const owner = users.find(u => u.id === g.userId);
      return {...view(g), ...(workspace ? {ownerName: owner?.name ?? g.userId, ownerEmail: owner?.email ?? null} : {})};
    })});
  }
  const match = /^\/ai-connections\/([^/]+)\/revoke$/.exec(path);
  if (!match) throw missing();
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const existing = await repo.mcpGrant(requireId(match[1]));
  if (!existing) throw missing();
  if (existing.userId !== principal.userId && principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'You can only revoke your own connections.');
  if (existing.revokedAt) return response(200, {data: view(existing)});
  const record = {...existing, revokedAt: now.toISOString(), version: existing.version + 1};
  await repo.saveMcpGrant(record, existing.version, grantEvent(record, principal.userId, 'mcp-grant.revoked'));
  return response(200, {data: view(record)});
}
