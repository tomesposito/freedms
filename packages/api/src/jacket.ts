import { randomUUID } from 'node:crypto';
import { documentTypes, maxDocumentBytes, pencilMath, type DealDocument, type DealJacket, type Principal } from '@freedms/shared';
import { ApiError, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, text } from './validation.js';
import { choice } from './crm-validation.js';
import type { TenantRepository } from './repository.js';
import type { DocumentStore } from './document-store.js';
export async function jacket(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, store?: DocumentStore) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const match = /^\/deals\/([^/]+)\/(jacket|documents)(?:\/([^/]+)\/content)?$/.exec(path);
  if (!match || (match[2] === 'jacket' && match[3])) throw missing();
  onlyKeys(request.query ?? {}, []);
  const deal = await repo.crmGet('deal', requireId(match[1])); if (!deal) throw missing();
  if (match[2] === 'jacket') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    if (!['approved', 'sold'].includes(deal.status)) throw invalid('A deal jacket is available only for approved or sold deals.');
    const [vehicle, customer, documents] = await Promise.all([repo.get(deal.vehicleId), repo.crmGet('customer', deal.customerId), repo.crmList('document')]);
    if (!vehicle || !customer) throw missing();
    const pencil = deal.pencils.find(p => p.id === deal.workingPencilId); if (!pencil) throw missing();
    const attached = documents.filter(d => d.dealId === deal.id);
    const data: DealJacket = {deal: {...deal, vehicle, customer}, pencil, numbers: pencilMath(pencil, deal.trade, deal, vehicle, deal.type),
      buyersGuide: {vehicle: {year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vehicle.vin, stockNumber: vehicle.stockNumber}, asIs: true, dealerWarranty: null, manufacturerWarranty: null}, documents: attached,
      checklist: [{key: 'buyers-order', label: "Buyer’s order", present: true}, {key: 'buyers-guide', label: 'Buyers Guide', present: true}, {key: 'id', label: 'Driver’s license / ID', present: attached.some(d => d.type === 'id')}, {key: 'insurance', label: 'Proof of insurance', present: attached.some(d => d.type === 'insurance')}]};
    return response(200, {data});
  }
  if (method === 'GET' && !match[3]) return response(200, {data: (await repo.crmList('document')).filter(d => d.dealId === deal.id)});
  if (method === 'GET' && match[3]) {
    const record = await repo.crmGet('document', requireId(match[3])); if (!record || record.dealId !== deal.id) throw missing();
    if (!store) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
    const bytes = await store.forTenant(principal.tenantId).get(record.id); if (!bytes) throw missing();
    return response(200, {data: {content: Buffer.from(bytes).toString('base64')}});
  }
  if (method !== 'POST' || match[3]) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const b = parseBody(request.body); onlyKeys(b, ['name', 'type', 'content']);
  const name = text(b.name, 'Document name', 160), type = choice(b.type, documentTypes, 'document type');
  if (typeof b.content !== 'string' || !b.content.length || b.content.length > Math.ceil(maxDocumentBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.content)) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
  const bytes = Buffer.from(b.content, 'base64');
  if (bytes.length > maxDocumentBytes || bytes.toString('base64') !== b.content) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
  if (!store) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
  const date = now.toISOString(), id = randomUUID();
  const record: DealDocument = {id, kind: 'document', tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date, dealId: deal.id, name, type, size: bytes.length, uploadedBy: principal.userId, uploadedAt: date};
  const storage = store.forTenant(principal.tenantId);
  await storage.put(id, bytes);
  try { await repo.crmWrite([{record, expectedVersion: 0, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: id, aggregateVersion: 1, type: 'document.created', occurredAt: date, deliveryStatus: 'pending'}}]); }
  catch (error) { await storage.remove(id); throw error; }
  return response(201, {data: record});
}
