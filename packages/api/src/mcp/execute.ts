import type { AuthClaims, DealView } from '@freedms/shared';
import { missing, requireId } from '../errors.js';
import { errorResponse, type ApiRequest, type ApiResponse } from '../handler.js';
import { invalid, object, onlyKeys } from '../validation.js';
import { tools, vehicleFields } from './tools.js';
export interface ToolResult { isError: boolean; content: {type: string; text: string}[]; structuredContent?: unknown }
/** Shared in-process adapter; every operation rechecks the user's live membership. */
export async function executeTool(tool: typeof tools[number], arguments_: unknown, claims: AuthClaims,
  execute: (request: ApiRequest) => Promise<ApiResponse>): Promise<ToolResult> {
  try {
    const args = object(arguments_ ?? {}); onlyKeys(args, Object.keys(tool.inputSchema.properties));
    if (tool.inputSchema.required.some(key => args[key] === undefined)) throw invalid('Required tool arguments are missing.');
    const {id: entityId, taskId, documentId, pencilId, ...fields} = args;
    let path = tool.path.includes(':id') ? tool.path.replace(':id', requireId(entityId)) : tool.path;
    if ('taskId' in tool.inputSchema.properties) path = path.replace(':taskId', requireId(taskId));
    if ('documentId' in tool.inputSchema.properties) path = path.replace(':documentId', requireId(documentId));
    const internal: ApiRequest = {method: tool.method, path, claims, agent: true};
    if (tool.method === 'GET') {
      internal.query = {};
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalid('Invalid query argument.');
        internal.query[key] = String(value);
      }
    } else {
      // The inventory UI only confirms deletion, which is deliberately not exposed.
      if (tool.name === 'deactivate_user' || tool.name === 'revoke_invite') {
        if (fields.confirm !== true) throw invalid('Explicit confirmation is required.');
        const {confirm: _confirm, ...body} = fields;
        internal.body = JSON.stringify(body);
      } else if (tool.name === 'set_vehicle_status') {
        const existing = await execute({method: 'GET', path, claims});
        if (existing.statusCode !== 200) return {isError: true, content: [{type: 'text', text: existing.body}]};
        const vehicle = JSON.parse(existing.body).data;
        internal.body = JSON.stringify({...Object.fromEntries(Object.keys(vehicleFields).map(k => [k, vehicle[k]])), ...fields});
      } else if (tool.name === 'update_technician' || tool.name === 'update_labor_rate') {
        // Catalog PUTs require full forms, unlike appointment/RO/part PUTs.
        const existing = await execute({method: 'GET', path, claims});
        if (existing.statusCode !== 200) return {isError: true, content: [{type: 'text', text: existing.body}]};
        const record = JSON.parse(existing.body).data;
        const keys = tool.name === 'update_technician' ? ['name', 'skills'] : ['skill', 'laborRateCents'];
        internal.body = JSON.stringify({...Object.fromEntries(keys.map(key => [key, record[key]])), ...fields});
      } else if (tool.name === 'set_lead_stage' || tool.name === 'assign_lead') {
        const existing = await execute({method: 'GET', path, claims});
        if (existing.statusCode !== 200) return {isError: true, content: [{type: 'text', text: existing.body}]};
        const lead = JSON.parse(existing.body).data;
        internal.body = JSON.stringify({version: fields.version, stage: fields.stage ?? lead.stage,
          assigneeId: 'assigneeId' in fields ? fields.assigneeId : lead.assigneeId, vehicleId: lead.vehicleId});
      } else if (tool.name === 'set_working_pencil') {
        internal.body = JSON.stringify({version: fields.version, workingPencilId: requireId(pencilId)});
      } else if (tool.name === 'create_pencil' || tool.name === 'update_pencil') {
        const existing = await execute({method: 'GET', path, claims});
        if (existing.statusCode !== 200) return {isError: true, content: [{type: 'text', text: existing.body}]};
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
    let structuredContent: unknown;
    try { structuredContent = JSON.parse(result.body); } catch { /* CSV downloads retain their exact text. */ }
    return {isError: result.statusCode >= 400, content: [{type: 'text', text: result.body}], structuredContent};
  } catch (error) {
    return {isError: true, content: [{type: 'text', text: errorResponse(error).body}]};
  }
}
