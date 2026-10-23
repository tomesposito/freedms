import { randomUUID } from 'node:crypto';
import { documentTypes, type DealDocument, type DocumentRetention, type DocumentSearchResult, type OutboxEvent, type Principal } from '@freedms/shared';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, text, version } from './validation.js';
import { choice } from './crm-validation.js';
import type { TenantRepository } from './repository.js';
import type { DocumentStore } from './document-store.js';

function day(value: string | undefined): string | undefined {
  if (value === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw invalid('Use a valid UTC date (YYYY-MM-DD).');
  return value;
}
export async function documentControls(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, store?: DocumentStore) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const dispose = /^\/documents\/([^/]+)\/dispose$/.exec(path);
  if (!['/documents', '/documents/retention', '/documents/past-retention'].includes(path) && !dispose) throw missing();
  const expectedMethod = dispose ? 'POST' : path === '/documents/retention' && method === 'PUT' ? 'PUT' : 'GET';
  if (method !== expectedMethod) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (path !== '/documents' && principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage document retention and disposal.');
  const q = request.query ?? {};
  onlyKeys(q, path === '/documents' ? ['name', 'type', 'buyer', 'from', 'to'] : []);
  const date = now.toISOString();
  const event = (record: DealDocument | DocumentRetention, type: OutboxEvent['type']): OutboxEvent => ({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type, occurredAt: date, deliveryStatus: 'pending'});
  const settings = await repo.crmGet('retention', 'workspace');
  if (path === '/documents/retention') {
    if (method === 'GET') return response(200, {data: settings ?? {retentionDays: null, version: 0}});
    const b = parseBody(request.body); onlyKeys(b, ['version', 'retentionDays']);
    if (!Number.isSafeInteger(b.version) || (b.version as number) < 0) throw invalid('A nonnegative version is required.');
    if (b.version !== (settings?.version ?? 0)) throw conflict();
    if (b.retentionDays !== null && (typeof b.retentionDays !== 'number' || !Number.isSafeInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > 36500)) throw invalid('Retention must be 1–36500 days, or null to disable.');
    const record: DocumentRetention = {id: 'workspace', kind: 'retention', tenantId: principal.tenantId, version: (settings?.version ?? 0) + 1, createdAt: settings?.createdAt ?? date, updatedAt: date, retentionDays: b.retentionDays as number | null};
    await repo.crmWrite([{record, expectedVersion: record.version - 1, event: event(record, settings ? 'retention.updated' : 'retention.created')}]);
    return response(200, {data: record});
  }
  if (dispose) {
    let doc = await repo.crmGet('document', requireId(dispose[1])); if (!doc) throw missing();
    const b = parseBody(request.body); onlyKeys(b, ['version', 'confirm']);
    if (b.confirm !== true) throw invalid('Explicit confirmation is required. Disposal is irreversible and permanently removes the file.');
    if (version(b.version) !== doc.version || doc.status === 'disposed') throw conflict();
    if (!store) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
    // Persist intent and disable content access before touching bytes. If storage or
    // the final transaction fails, an administrator can explicitly retry this record.
    // Never restore bytes after a failed transaction: another disposal may have won.
    if (!doc.status) {
      const pending: DealDocument = {...doc, status: 'disposal-pending', version: doc.version + 1, updatedAt: date};
      await repo.crmWrite([{record: pending, expectedVersion: doc.version, event: event(pending, 'document.updated')}]);
      doc = pending;
    }
    try { await store.forTenant(principal.tenantId).remove(doc.id); }
    catch { throw new ApiError(503, 'DISPOSAL_PENDING', 'File removal could not finish. Disposal is pending; explicitly retry from Documents.'); }
    const record: DealDocument = {...doc, status: 'disposed', disposedBy: principal.userId, disposedAt: date, version: doc.version + 1, updatedAt: date};
    const audit = {...event(record, 'document.disposed'), disposal: {documentId: doc.id, name: doc.name, type: doc.type, dealId: doc.dealId, disposedBy: principal.userId, disposedAt: date}};
    await repo.crmWrite([{record, expectedVersion: doc.version, event: audit}]);
    return response(200, {data: record});
  }
  const name = q.name === undefined ? '' : text(q.name, 'Name', 160).toLowerCase();
  const buyer = q.buyer === undefined ? '' : text(q.buyer, 'Buyer or deal', 200).toLowerCase();
  const type = q.type === undefined ? undefined : choice(q.type, documentTypes, 'document type');
  const from = day(q.from), to = day(q.to);
  if (from && to && from > to) throw invalid('From date must be on or before to date.');
  const [docs, deals, customers] = await Promise.all([repo.crmList('document'), repo.crmList('deal'), repo.crmList('customer')]);
  const results: DocumentSearchResult[] = [];
  for (const doc of docs) {
    const deal = deals.find(d => d.id === doc.dealId); if (!deal) continue;
    const buyerName = customers.find(c => c.id === deal.customerId)?.name ?? '';
    if (path === '/documents/past-retention') {
      if (doc.status === 'disposed' || (doc.status !== 'disposal-pending' && (settings?.retentionDays == null || Date.parse(doc.uploadedAt) >= now.getTime() - settings.retentionDays * 86400000))) continue;
    } else if (!doc.name.toLowerCase().includes(name) || (type && doc.type !== type) || !`${deal.id} ${buyerName}`.toLowerCase().includes(buyer) || (from && doc.uploadedAt.slice(0, 10) < from) || (to && doc.uploadedAt.slice(0, 10) > to)) continue;
    results.push({...doc, buyerName, dealStatus: deal.status});
  }
  results.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.id.localeCompare(b.id));
  return response(200, {data: results});
}
