import { randomUUID } from 'node:crypto';
import { inventorySizes, type AccessRequest } from '@freedms/shared';
import { ApiError } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from './repository.js';
import { emailAddress } from './users.js';
import { invalid, onlyKeys, text } from './validation.js';

export async function submitAccessRequest(request: ApiRequest, repositories: RepositoryFactory, now: Date): Promise<ApiResponse> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const body = parseBody(request.body, 16 * 1024);
  onlyKeys(body, ['contactName', 'dealershipName', 'email', 'phone', 'inventorySize', 'currentDms', 'message', 'website']);
  if (typeof body.website === 'string' && body.website.trim()) return response(201, {data: {received: true}});
  const contactName = text(body.contactName, 'Contact name', 120);
  const dealershipName = text(body.dealershipName, 'Dealership name', 160);
  const email = emailAddress(body.email);
  const phone = text(body.phone ?? '', 'Phone', 40, true);
  const inventorySize = text(body.inventorySize ?? '', 'Inventory size', 20, true);
  if (inventorySize && !inventorySizes.includes(inventorySize as typeof inventorySizes[number])) throw invalid('Invalid inventory size.');
  const currentDms = text(body.currentDms ?? '', 'Current DMS', 120, true);
  const message = text(body.message ?? '', 'Message', 2000, true);
  const repository = repositories.forTenant(OPERATOR_TENANT_ID);
  const existing = await repository.accessRequest(email);
  const timestamp = now.toISOString();
  const record: AccessRequest = {
    id: existing?.id ?? randomUUID(), tenantId: OPERATOR_TENANT_ID, email,
    contactName, dealershipName, phone, inventorySize, currentDms, message,
    status: existing?.status ?? 'pending', handledAt: existing?.handledAt ?? null,
    version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp
  };
  await repository.saveAccessRequest(record, existing?.version ?? 0);
  return response(201, {data: {received: true}});
}

export async function listAccessRequests(repositories: RepositoryFactory): Promise<AccessRequest[]> {
  return (await repositories.forTenant(OPERATOR_TENANT_ID).accessRequests())
    .filter(record => record.status === 'pending')
    .sort((a, b) => a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
}

export async function markAccessRequestHandled(repositories: RepositoryFactory, email: string, now: Date): Promise<AccessRequest> {
  const repository = repositories.forTenant(OPERATOR_TENANT_ID);
  const existing = await repository.accessRequest(emailAddress(email));
  if (!existing || existing.status !== 'pending') throw new Error('No pending access request for that email.');
  const record: AccessRequest = {...existing, status: 'handled', handledAt: now.toISOString(), updatedAt: now.toISOString(), version: existing.version + 1};
  await repository.saveAccessRequest(record, existing.version);
  return record;
}
