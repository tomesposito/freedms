import { executeTool } from './execute.js';
import { grantRevoked } from './grants.js';
import type { AuthClaims } from '@freedms/shared';
import { authorize } from '../auth.js';
import { ApiError } from '../errors.js';
import { response, errorResponse, type ApiRequest, type ApiResponse } from '../handler.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from '../repository.js';
import { object, onlyKeys } from '../validation.js';
import { accessVerifier, type McpConfig } from './auth.js';
import { tools } from './tools.js';
export const isMcpPath = (path: string) => ['/mcp', '/mcp/register', '/.well-known/oauth-protected-resource'].includes(path.replace(/\/$/, ''));
export function createMcpHandler(repositories: RepositoryFactory, execute: (request: ApiRequest) => Promise<ApiResponse>, config: McpConfig) {
  const verify = accessVerifier({...config,
    isRegisteredClient: async clientId => !!await repositories.forTenant(OPERATOR_TENANT_ID).mcpRegistration(clientId)});
  const metadata = new URL('./.well-known/oauth-protected-resource', config.resource).href;
  const rpc = (id: unknown, result: unknown) => response(200, {jsonrpc: '2.0', id, result});
  const fail = (id: unknown, code: number, message: string) => response(200, {jsonrpc: '2.0', id, error: {code, message}});
  return async (request: ApiRequest): Promise<ApiResponse> => {
    if (request.path.replace(/\/$/, '') === '/.well-known/oauth-protected-resource') return request.method === 'GET'
      ? response(200, {resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['freedms/mcp.read', 'freedms/mcp.write'], bearer_methods_supported: ['header']})
      : response(405, {error: {code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.'}});
    let access;
    try { access = await verify(request.authorization); } catch {
      const result = response(401, {error: {code: 'UNAUTHORIZED', message: 'Sign in to continue.'}});
      result.headers['www-authenticate'] = `Bearer resource_metadata="${metadata}"`; return result;
    }
    if (request.method !== 'POST') return response(405, {error: {code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.'}});
    let raw: unknown;
    if (Buffer.byteLength(request.body ?? '') > 1100 * 1024) return fail(null, -32600, 'Request exceeds the size limit.');
    try { raw = JSON.parse(request.body ?? ''); } catch { return fail(null, -32700, 'Invalid JSON.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(null, -32600, 'Invalid request.');
    const message = raw as Record<string, unknown>, id = message.id;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (id !== undefined && typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) ||
      (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) return fail(null, -32600, 'Invalid request.');
    try {
      // Access tokens contain no tenant attribute. Resolve the subject's immutable binding,
      // then use the exact same live membership/role check as hosted REST sessions.
      const tenantId = await repositories.tenantForSubject?.(access.sub);
      let claims: AuthClaims | undefined;
      if (tenantId) {
        const candidate: AuthClaims = {sub: access.sub, 'custom:tenant_id': tenantId, iss: access.iss, aud: config.clientId, exp: access.exp, token_use: 'id'};
        try { await authorize(candidate, repositories); claims = candidate; } catch (e) { if (!(e instanceof ApiError) || e.status !== 403) throw e; }
      }
      if (claims && await grantRevoked(repositories, tenantId!, access, config)) {
        const result = response(401, {error: {code: 'UNAUTHORIZED', message: 'Sign in to continue.'}});
        result.headers['www-authenticate'] = `Bearer resource_metadata="${metadata}"`; return result;
      }
      if (id === undefined) return {...response(202, null), body: ''};
      if (message.method === 'initialize') {
        const params = message.params as Record<string, unknown> | undefined;
        if (!params || typeof params.protocolVersion !== 'string' || !params.capabilities || !params.clientInfo) return fail(id, -32602, 'Invalid initialization parameters.');
        return rpc(id, {protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'freeDMS', version: '0.1.0'}});
      }
      if (message.method === 'ping') return rpc(id, {});
      if (!['tools/list', 'tools/call'].includes(message.method)) return fail(id, -32601, 'Method not found.');
      const available = claims ? tools.filter(t => t.method === 'GET' || access.scope.split(' ').includes('freedms/mcp.write')) : [];
      if (message.method === 'tools/list') return rpc(id, {tools: available.map(({path: _path, method, ...t}) => ({...t, annotations: {readOnlyHint: method === 'GET', destructiveHint: method !== 'GET', openWorldHint: t.name === 'import_vehicles'}}))});
      const params = object(message.params); onlyKeys(params, ['name', 'arguments']);
      const tool = available.find(t => t.name === params.name);
      if (!tool) return fail(id, -32602, 'Tool unavailable.');
      return rpc(id, await executeTool(tool, params.arguments, claims!, execute));
    } catch (error) {
      const sanitized = JSON.parse(errorResponse(error).body);
      return rpc(id, {isError: true, content: [{type: 'text', text: JSON.stringify(sanitized)}]});
    }
  };
}
