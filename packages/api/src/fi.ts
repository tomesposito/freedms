import { randomUUID } from 'node:crypto';
import { fiCategories, type FiProduct, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice } from './crm-validation.js';
import { invalid, money, onlyKeys, text, version } from './validation.js';
import type { TenantRepository } from './repository.js';
export async function fiProducts(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  if (path !== '/fi-products' && !/^\/fi-products\/[^/]+$/.test(path)) throw missing();
  const id = path === '/fi-products' ? undefined : requireId(path.split('/')[2]);
  if (!(id ? ['PUT'] : ['GET', 'POST']).includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  if (method === 'GET') return response(200, {data: (await repo.crmList('fi-product')).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))});
  requireWrite(principal, method);
  const b = parseBody(request.body); onlyKeys(b, ['name', 'category', 'cost', 'retailPrice', 'termNotes', 'active', ...(id ? ['version'] : [])]);
  const old = id ? await repo.crmGet('fi-product', id) : undefined;
  if (id && !old) throw missing();
  const expected = id ? version(b.version) : 0;
  if (old && old.version !== expected) throw conflict();
  // Creation defaults active to true; full replacement requires the flag.
  const active = !id && b.active === undefined ? true : b.active;
  if (typeof active !== 'boolean') throw invalid('Active must be boolean.');
  const date = now.toISOString();
  const record: FiProduct = {id: id ?? randomUUID(), kind: 'fi-product', tenantId: principal.tenantId, version: expected + 1, createdAt: old?.createdAt ?? date, updatedAt: date,
    name: text(b.name, 'Name', 120), category: choice(b.category, fiCategories, 'category'), cost: money(b.cost, 'Cost'), retailPrice: money(b.retailPrice, 'Retail price'), termNotes: text(b.termNotes, 'Term/coverage notes', 500, true), active};
  await repo.crmWrite([{record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type: id ? 'fi-product.updated' : 'fi-product.created', occurredAt: date, deliveryStatus: 'pending'}}]);
  return response(id ? 200 : 201, {data: record});
}
