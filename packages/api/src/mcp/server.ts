import type { AuthClaims, DealView } from '@freedms/shared';
import { authorize } from '../auth.js';
import { ApiError, missing, requireId } from '../errors.js';
import { response, errorResponse, type ApiRequest, type ApiResponse } from '../handler.js';
import type { RepositoryFactory } from '../repository.js';
import { invalid, object, onlyKeys } from '../validation.js';
import { accessVerifier, type McpConfig } from './auth.js';
import { tools, vehicleFields } from './tools.js';
export const isMcpPath = (path: string) => ['/mcp', '/.well-known/oauth-protected-resource'].includes(path.replace(/\/$/, ''));
export function createMcpHandler(repositories: RepositoryFactory, execute: (request: ApiRequest) => Promise<ApiResponse>, config: McpConfig) {
  const verify = accessVerifier(config);
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
    if (id === undefined) return {...response(202, null), body: ''};
    if (message.method === 'initialize') {
      const params = message.params as Record<string, unknown> | undefined;
      if (!params || typeof params.protocolVersion !== 'string' || !params.capabilities || !params.clientInfo) return fail(id, -32602, 'Invalid initialization parameters.');
      return rpc(id, {protocolVersion: ['2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'freeDMS', version: '0.1.0'}});
    }
    if (message.method === 'ping') return rpc(id, {});
    if (!['tools/list', 'tools/call'].includes(message.method)) return fail(id, -32601, 'Method not found.');
    try {
      // Access tokens contain no tenant attribute. Resolve the subject's immutable binding,
      // then use the exact same live membership/role check as hosted REST sessions.
      const tenantId = await repositories.tenantForSubject?.(access.sub);
      let claims: AuthClaims | undefined;
      if (tenantId) {
        const candidate: AuthClaims = {sub: access.sub, 'custom:tenant_id': tenantId, iss: access.iss, aud: config.clientId, exp: access.exp, token_use: 'id'};
        try { await authorize(candidate, repositories); claims = candidate; } catch (e) { if (!(e instanceof ApiError) || e.status !== 403) throw e; }
      }
      const available = claims ? tools.filter(t => t.method === 'GET' || access.scope.split(' ').includes('freedms/mcp.write')) : [];
      if (message.method === 'tools/list') return rpc(id, {tools: available.map(({path: _path, method, ...t}) => ({...t, annotations: {readOnlyHint: method === 'GET', destructiveHint: method !== 'GET', openWorldHint: t.name === 'import_vehicles'}}))});
      const params = object(message.params); onlyKeys(params, ['name', 'arguments']);
      const tool = available.find(t => t.name === params.name);
      if (!tool) return fail(id, -32602, 'Tool unavailable.');
      const args = object(params.arguments ?? {}); onlyKeys(args, Object.keys(tool.inputSchema.properties));
      if (tool.inputSchema.required.some(key => args[key] === undefined)) throw invalid('Required tool arguments are missing.');
      const {id: entityId, taskId, pencilId, ...fields} = args;
      let path = tool.path.includes(':id') ? tool.path.replace(':id', requireId(entityId)) : tool.path;
      if ('taskId' in tool.inputSchema.properties) path = path.replace(':taskId', requireId(taskId));
      const internal: ApiRequest = {method: tool.method, path, claims, agent: true};
      if (tool.method === 'GET') {
        internal.query = {};
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalid('Invalid query argument.');
          internal.query[key] = String(value);
        }
      } else {
        // The inventory UI only confirms deletion, which is deliberately not exposed.
        if (tool.name === 'set_vehicle_status') {
          const existing = await execute({method: 'GET', path, claims});
          if (existing.statusCode !== 200) return rpc(id, {isError: true, content: [{type: 'text', text: existing.body}]});
          const vehicle = JSON.parse(existing.body).data;
          internal.body = JSON.stringify({...Object.fromEntries(Object.keys(vehicleFields).map(k => [k, vehicle[k]])), ...fields});
        } else if (tool.name === 'set_lead_stage' || tool.name === 'assign_lead') {
          const existing = await execute({method: 'GET', path, claims});
          if (existing.statusCode !== 200) return rpc(id, {isError: true, content: [{type: 'text', text: existing.body}]});
          const lead = JSON.parse(existing.body).data;
          internal.body = JSON.stringify({version: fields.version, stage: fields.stage ?? lead.stage,
            assigneeId: 'assigneeId' in fields ? fields.assigneeId : lead.assigneeId, vehicleId: lead.vehicleId});
        } else if (tool.name === 'set_working_pencil') {
          internal.body = JSON.stringify({version: fields.version, workingPencilId: requireId(pencilId)});
        } else if (tool.name === 'create_pencil' || tool.name === 'update_pencil') {
          const existing = await execute({method: 'GET', path, claims});
          if (existing.statusCode !== 200) return rpc(id, {isError: true, content: [{type: 'text', text: existing.body}]});
          const deal: DealView = JSON.parse(existing.body).data;
          const pencils = deal.pencils.map(({id, type, name, price, down, term, aprBps, lease, fiSelections}) => ({
            id, type, name, price, down, term, aprBps,
            // Stored leases contain both residual values; REST accepts exactly one driver.
            lease: lease ? {msrp: lease.msrp, residualAmount: lease.residualAmount, moneyFactorMicro: lease.moneyFactorMicro,
              acquisitionFee: lease.acquisitionFee, securityDeposit: lease.securityDeposit, milesPerYear: lease.milesPerYear} : null,
            fiSelections: fiSelections.map(({productId, status}) => ({productId, status})),
          }));
          const key = requireId(pencilId), saved = pencils.find(p => p.id === key);
          const create = tool.name === 'create_pencil';
          if (create && saved) throw invalid('Pencil IDs must be unique.');
          if (!create && !saved) throw missing();
          const {version, ...input} = fields;
          const pencil = {id: key, fiSelections: create ? [] : saved!.fiSelections, ...input};
          internal.body = JSON.stringify({version, pencils: create ? [...pencils, pencil] : pencils.map(p => p.id === key ? pencil : p)});
        } else internal.body = JSON.stringify(fields);
      }
      // Direct in-process REST operation dispatch: no HTTP self-call. Reads are not audited
      // by REST. Writes retain its atomic outbox and add actorType=agent with the real user ID.
      const result = await execute(internal);
      return rpc(id, {isError: result.statusCode >= 400, content: [{type: 'text', text: result.body}], structuredContent: JSON.parse(result.body)});
    } catch (error) {
      const sanitized = JSON.parse(errorResponse(error).body);
      return rpc(id, {isError: true, content: [{type: 'text', text: JSON.stringify(sanitized)}]});
    }
  };
}
