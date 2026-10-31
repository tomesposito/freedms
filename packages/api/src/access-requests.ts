import type { TurnstileVerifier } from './turnstile.js';
import { randomUUID } from 'node:crypto';
import { inventorySizes, type AccessRequest } from '@freedms/shared';
import type { MailSender } from './mail.js';
import { ApiError } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from './repository.js';
import { emailAddress } from './users.js';
import { invalid, onlyKeys, text } from './validation.js';

export interface AccessRequestMail {
  sender: MailSender;
  notifyTo?: string;
}

export async function submitAccessRequest(request: ApiRequest, repositories: RepositoryFactory, now: Date, mail?: AccessRequestMail, turnstile?: TurnstileVerifier): Promise<ApiResponse> {
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const body = parseBody(request.body, 16 * 1024);
  onlyKeys(body, ['contactName', 'dealershipName', 'email', 'phone', 'inventorySize', 'currentDms', 'message', 'website', 'turnstileToken']);
  if (typeof body.website === 'string' && body.website.trim()) return response(201, {data: {received: true}});
  if (turnstile?.configured) {
    let verified = false;
    if (typeof body.turnstileToken === 'string' && body.turnstileToken.trim()) {
      try { verified = await turnstile.verify(body.turnstileToken); } catch { /* Fail closed without logging credentials. */ }
    }
    if (!verified) throw invalid('Please complete the verification challenge and try again.');
  }
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
  const notifyTo = mail?.notifyTo?.trim();
  if (!existing && mail?.sender.configured && notifyTo) {
    try {
      await mail.sender.send({
        to: notifyTo, replyTo: record.email,
        subject: `New freeDMS pilot access request — ${record.dealershipName}`,
        text: [
          `Contact name: ${record.contactName}`, `Dealership name: ${record.dealershipName}`,
          `Email: ${record.email}`, `Phone: ${record.phone}`, `Inventory size: ${record.inventorySize}`,
          `Current DMS: ${record.currentDms}`, `Message: ${record.message}`, `Submitted: ${record.createdAt}`
        ].join('\n')
      });
    } catch (error) {
      console.error('Access request notification failed:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
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
