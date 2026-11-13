import { randomUUID } from 'node:crypto';
import type { McpGrant } from '@freedms/shared';
import { grantEvent } from '../ai-connections.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from '../repository.js';
import type { AccessClaims, McpConfig } from './auth.js';

/** Revocation reads fail closed; grant bookkeeping is best-effort. */
export async function grantRevoked(repositories: RepositoryFactory, tenantId: string, access: AccessClaims, config: McpConfig): Promise<boolean> {
  let existing: McpGrant | undefined;
  let repo;
  try {
    repo = repositories.forTenant(tenantId);
    existing = (await repo.mcpGrants()).find(g => g.userId === access.sub && g.clientId === access.client_id);
  } catch { return true; }
  if (existing?.revokedAt) return true;
  try {
    const now = (config.now ?? Date.now)(), timestamp = new Date(now).toISOString();
    const scopes = access.scope.split(' ').filter(Boolean);
    if (existing) {
      if (now - Date.parse(existing.lastUsedAt) >= 3_600_000) {
        await repo.saveMcpGrant({...existing, lastUsedAt: timestamp, scopes, version: existing.version + 1}, existing.version);
      }
    } else {
      let appName = access.client_id === config.clientId ? 'freeDMS MCP' : 'Unknown app';
      try { appName = (await repositories.forTenant(OPERATOR_TENANT_ID).mcpRegistration(access.client_id))?.client_name ?? appName; } catch { /* Use the plain fallback name. */ }
      const record: McpGrant = {id: randomUUID(), tenantId, userId: access.sub, clientId: access.client_id, appName, scopes,
        firstGrantedAt: timestamp, lastUsedAt: timestamp, revokedAt: null, version: 1};
      await repo.saveMcpGrant(record, 0, grantEvent(record, access.sub, 'mcp-grant.recorded'));
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'CONFLICT') {
      // A revoke may have won the race against this bookkeeping write.
      try {
        return Boolean((await repo.mcpGrants()).find(g => g.userId === access.sub && g.clientId === access.client_id)?.revokedAt);
      } catch { return true; }
    }
    // Other bookkeeping failures do not prevent a tool call.
  }
  return false;
}
