import { dealerShare, publicShare } from './retail.js';
import { manageUsers } from './users.js';
import { credit } from './credit.js';
import { accounting } from './accounting.js';
import { fiProducts } from './fi.js';
import { documentControls } from './documents.js';
import { mfa } from './mfa.js';
import { dispatchWebhooks, fetchWebhookSender, webhooks, type WebhookSender } from './webhooks.js';
import { feeds } from './feed.js';
import { inventoryImport } from './import.js';
import { analytics, analyticsFromEnv, track, type AnalyticsVendor } from './analytics.js';
import { quickEntry } from './quick-entry.js';
import { UnconfiguredProvider, type QuickEntryProvider } from './ai-provider.js';
import { reports } from './reports.js';
import { jacket, observeJacketCompletion } from './jacket.js';
import type { DocumentStore } from './document-store.js';
import { desking } from './desking.js';
import { crm, intake } from './crm.js';
import { randomUUID } from 'node:crypto';
import { vehicleStatuses, type AuthClaims, type OutboxEvent, type Vehicle } from '@freedms/shared';
import { authorize, requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import type { RepositoryFactory } from './repository.js';
import type { VinDecoder } from './vin.js';
import { invalid, object, onlyKeys, text, vehicleInput, version, view, vin } from './validation.js';
export interface ApiRequest { method: string; path: string; query?: Record<string, string | undefined>; body?: string; claims?: AuthClaims; intakeToken?: string }
export interface ApiResponse { statusCode: number; headers: Record<string, string>; body: string }
export function response(statusCode: number, body: unknown): ApiResponse {
  return {statusCode, headers: {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}, body: JSON.stringify(body)};
}
export function csvResponse(filename: string, body: string): ApiResponse {
  return {statusCode: 200, headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}, body};
}
export function errorResponse(error: unknown): ApiResponse {
  if (error instanceof ApiError) return response(error.status, {error: {code: error.code, message: error.message}});
  // Do not log bodies, tokens, VINs, notes or provider responses.
  console.error('API operation failed', error instanceof Error ? error.name : 'UnknownError');
  return response(500, {error: {code: 'INTERNAL', message: 'The operation could not be completed.'}});
}
export function parseBody(body?: string, limit = 64 * 1024): Record<string, unknown> {
  if (!body || Buffer.byteLength(body) > limit) throw invalid(`A JSON body of at most ${limit} bytes is required.`);
  try { return object(JSON.parse(body)); } catch (error) { if (error instanceof ApiError) throw error; throw invalid('Invalid JSON body.'); }
}
export function createHandler(repositories: RepositoryFactory, decoder: VinDecoder, now = () => new Date(), documents?: DocumentStore, provider: QuickEntryProvider = new UnconfiguredProvider(), vendor: AnalyticsVendor = analyticsFromEnv({}), webhookSender: WebhookSender = fetchWebhookSender) {
  return async (request: ApiRequest): Promise<ApiResponse> => {
    try {
      if (request.method.toUpperCase() === 'POST' && request.path.replace(/\/$/, '') === '/intake/adf') {
        const result = await intake(request, repositories, now());
        // Intake has authenticated its tenant token before returning a successful mutation.
        if (result.statusCode >= 200 && result.statusCode < 300) {
          try { await dispatchWebhooks(repositories.forTenant(request.intakeToken!.split('.')[0]), webhookSender, now()); } catch { /* Preserve the committed intake. */ }
        }
        return result;
      }
      if (request.path.replace(/\/$/, '').startsWith('/share/')) {
        const {result, tenantId} = await publicShare(request, repositories, now(), documents);
        if (request.method.toUpperCase() === 'POST' && result.statusCode >= 200 && result.statusCode < 300) {
          try { await dispatchWebhooks(repositories.forTenant(tenantId), webhookSender, now()); } catch { /* Preserve the committed buyer mutation. */ }
        }
        return result;
      }
      if (!request.claims) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue.');
      const {principal, repository} = await authorize(request.claims, repositories);
      const method = request.method.toUpperCase(); const path = request.path.replace(/\/$/, '');
      const execute = async (): Promise<ApiResponse> => {
        if (/^\/documents(\/|$)/.test(path)) return await documentControls(request, principal, repository, now(), documents);
        if (/^\/admin\/users(\/|$)/.test(path)) return await manageUsers(request, principal, repository, now());
        if (/^\/(account|admin)\/mfa(\/|$)/.test(path)) return await mfa(request, principal, repository, now());
        if (/^\/webhooks(\/|$)/.test(path)) return await webhooks(request, principal, repository, now(), webhookSender);
        const record = (data: import('@freedms/shared').BehavioralEvent) => track(repository, principal, now(), data, vendor);
        if (/^\/analytics(\/|$)/.test(path)) return await analytics(request, principal, repository, record);
        if (/^\/quick-entry(\/|$)/.test(path)) return await quickEntry(request, principal, repository, now(), provider);
        if (/^\/accounting(\/|$)/.test(path)) return await accounting(request, principal, repository, now());
        if (/^\/fi-products(\/|$)/.test(path)) return await fiProducts(request, principal, repository, now());
        if (/^\/feeds(\/|$)/.test(path)) return await feeds(request, principal, repository, now());
        if (/^\/reports(\/|$)/.test(path)) return await reports(request, repository, now(), record);
        if (/^\/(deals|settings)(\/|$)/.test(path)) {
          const command = () => /^\/deals\/[^/]+\/share(\/|$)/.test(path) ? dealerShare(request, principal, repository, now()) : /^\/deals\/[^/]+\/(credit-application|payoff-quotes)(\/|$)/.test(path) ? credit(request, principal, repository, now()) : /^\/deals\/[^/]+\/(jacket|documents)(\/|$)/.test(path)
            ? jacket(request, principal, repository, now(), documents)
            : desking(request, principal, repository, now());
          return ['POST', 'PUT'].includes(method) && path.startsWith('/deals/')
            ? await observeJacketCompletion(repository, requireId(path.split('/')[2]), record, command)
            : await command();
        }
        if (/^\/(customers|leads|users|intake-token|equity-mining|ownership-cycle)(\/|$)/.test(path)) return await crm(request, principal, repository, now());
        if (method === 'GET' && path === '/session') return response(200, {data: {principal, tenant: await repository.tenant(), mfaEnabled: (await repository.mfa(principal.userId))?.enabled ?? false}});
        if (method === 'GET' && path.startsWith('/vin/')) return response(200, {data: await decoder.decode(vin(decodeURIComponent(path.slice(5))))});
        if (/^\/vehicles\/imports?(\/|$)/.test(path)) return await inventoryImport(request, principal, repository, now(), decoder);
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
          if ((await repository.crmList('deal')).some(d => d.vehicleId === id)) throw conflict();
          await repository.delete(id!, expected, event('vehicle.deleted', id!, expected + 1));
          return response(200, {data: {id}});
        }
        const {version: _version, ...fields} = body;
        const vehicle: Vehicle = {...vehicleInput(fields, date), id: existing.id, tenantId: principal.tenantId, version: expected + 1, createdAt: existing.createdAt, updatedAt: date.toISOString()};
        await repository.update(vehicle, expected, event('vehicle.updated', id!, vehicle.version));
        return response(200, {data: view(vehicle, date)});
      };
      const result = await execute();
      if (result.statusCode >= 200 && result.statusCode < 300 && ['POST', 'PUT', 'DELETE'].includes(method) && !/^\/webhooks(\/|$)/.test(path) && !/^\/(account|admin)\/mfa(\/|$)/.test(path)) {
        try { await dispatchWebhooks(repository, webhookSender, now()); } catch { /* Delivery failures must never fail a committed mutation. */ }
      }
      return result;
    } catch (error) { return errorResponse(error); }
  };
}
