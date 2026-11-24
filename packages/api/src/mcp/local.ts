/** Loopback development only. Never imported by Lambda.
 * Lets the local stack exercise MCP with the same session token the web app
 * uses: the token is verified by LocalTokens, then mapped to MCP access
 * claims. Tenant resolution stays with the MCP server (tenantForSubject +
 * the live authorize() membership check), so a local token reaches exactly
 * the records its REST session could reach. */
import { LOCAL_ISSUER, type LocalTokens } from '../auth.js';
import type { RepositoryFactory } from '../repository.js';
import { mcpConfig, type AccessClaims, type McpConfig } from './auth.js';

export const LOCAL_MCP_CLIENT_ID = 'freedms-local-mcp';

export function localMcpConfig(tokens: Pick<LocalTokens, 'verify'>, repositories: RepositoryFactory): McpConfig {
  return {...mcpConfig(), verifyLocalToken: async (token: string): Promise<AccessClaims> => {
    const claims = tokens.verify(token);
    if (claims.iss !== LOCAL_ISSUER) throw Error('Unauthorized');
    // Write scope follows the membership role, mirroring REST requireWrite:
    // admin/staff may write, anything else reads only. When the subject has
    // no resolvable membership the MCP server returns an empty tool list.
    let scope = 'freedms/mcp.read';
    try {
      const tenantId = await repositories.tenantForSubject?.(claims.sub);
      const member = tenantId ? await repositories.forTenant(tenantId).membership(claims.sub) : undefined;
      if (member?.active && ['admin', 'staff'].includes(member.role)) scope += ' freedms/mcp.write';
    } catch { /* Keep the read-only scope; authorize() still gates every call. */ }
    return {sub: claims.sub, iss: claims.iss, exp: claims.exp, client_id: LOCAL_MCP_CLIENT_ID, token_use: 'access', scope};
  }};
}
