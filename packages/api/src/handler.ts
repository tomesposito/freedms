import { randomUUID } from 'node:crypto';
import { vehicleStatuses, type AuthClaims, type OutboxEvent, type Vehicle } from '@freedms/shared';
import { authorize, requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import type { RepositoryFactory } from './repository.js';
import type { VinDecoder } from './vin.js';
import { invalid, object, onlyKeys, text, vehicleInput, version, view, vin } from './validation.js';
export interface ApiRequest { method: string; path: string; query?: Record<string, string | undefined>; body?: string; claims?: AuthClaims }
export interface ApiResponse { statusCode: number; headers: Record<string, string>; body: string }
export function response(statusCode: number, body: unknown): ApiResponse {
  return {statusCode, headers: {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}, body: JSON.stringify(body)};
}
export function errorResponse(error: unknown): ApiResponse {
  if (error instanceof ApiError) return response(error.status, {error: {code: error.code, message: error.message}});
  // Do not log bodies, tokens, VINs, notes or provider responses.
  console.error('API operation failed', error instanceof Error ? error.name : 'UnknownError');
  return response(500, {error: {code: 'INTERNAL', message: 'The operation could not be completed.'}});
}
export function parseBody(body?: string): Record<string, unknown> {
  if (!body || Buffer.byteLength(body) > 64 * 1024) throw invalid('A JSON body of at most 64 KiB is required.');
  try { return object(JSON.parse(body)); } catch (error) { if (error instanceof ApiError) throw error; throw invalid('Invalid JSON body.'); }
}
export function createHandler(repositories: RepositoryFactory, decoder: VinDecoder, now = () => new Date()) {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    try {
      if (!request.claims) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
      const {principal, repository} = await authorize(request.claims, repositories);
      const method = request.method.toUpperCase(); const path = request.path.replace(/\/$/, '');
      if (method === 'GET' && path === '/session') return response(200, {data: {principal, tenant: await repository.tenant()}});
      if (method === 'GET' && path.startsWith('/vin/')) return response(200, {data: await decoder.decode(vin(decodeURIComponent(path.slice(5))))});
      if (path !== '/vehicles' && !/^\/vehicles\/[^/]+$/.test(path)) throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      const id = path === '/vehicles' ? undefined : requireId(path.split('/')[2]);
      if (method === 'GET') {
        if (id) { const vehicle = await repository.get(id); if (!vehicle) throw missing(); return response(200, {data: view(vehicle, now())}); }
        const query = request.query ?? {};
        onlyKeys(query, ['status', 'search']);
        if (query.status && !vehicleStatuses.includes(query.status as typeof vehicleStatuses[number])) throw invalid('Invalid status filter.');
        const vehicles = await repository.list({status: query.status as typeof vehicleStatuses[number] | undefined, search: query.search ? text(query.search, 'Search', 200) : undefined});
        vehicles.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return response(200, {data: vehicles.map(v => view(v, now()))});
      }
      if (!((method === 'POST' && !id) || (['PUT', 'DELETE'].includes(method) && id))) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireWrite(principal, method);
      const body = parseBody(request.body); const date = now();
      const event = (type: OutboxEvent['type'], aggregateId: string, aggregateVersion: number): OutboxEvent => ({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, type, aggregateId, aggregateVersion, occurredAt: date.toISOString(), deliveryStatus: 'pending'});
      if (method === 'POST') {
        const input = vehicleInput(body, date);
        const vehicle: Vehicle = {...input, id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: date.toISOString(), updatedAt: date.toISOString()};
        await repository.create(vehicle, event('vehicle.created', vehicle.id, 1));
        return response(201, {data: view(vehicle, date)});
      }
      const existing = await repository.get(id!); if (!existing) throw missing();
      const expected = version(body.version); if (existing.version !== expected) throw conflict();
      if (method === 'DELETE') {
        onlyKeys(body, ['version']);
        await repository.delete(id!, expected, event('vehicle.deleted', id!, expected + 1));
        return response(200, {data: {id}});
      }
      const {version: _version, ...fields} = body;
      const vehicle: Vehicle = {...vehicleInput(fields, date), id: existing.id, tenantId: principal.tenantId, version: expected + 1, createdAt: existing.createdAt, updatedAt: date.toISOString()};
      await repository.update(vehicle, expected, event('vehicle.updated', id!, vehicle.version));
      return response(200, {data: view(vehicle, date)});
    } catch (error) { return errorResponse(error); }
  };
}
