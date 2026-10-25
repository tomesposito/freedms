import { anonymizationNotice, privacyStatuses, type PrivacyRequest, type CustomerDataExport, type Customer, type OutboxEvent } from '@freedms/shared';
import type { CrmWrite } from './repository.js';
import { randomUUID } from 'node:crypto';
import { complianceChecklist, complianceCheckResults, newestComplianceChecks, type ComplianceAttestation, type ComplianceRecord, type ComplianceCheck, type Deal, type DealCompliance, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice } from './crm-validation.js';
import { invalid, object, onlyKeys, text, version } from './validation.js';
import type { TenantRepository } from './repository.js';
export async function dealCompliance(repo: TenantRepository, deal: Deal): Promise<DealCompliance> {
  const [record, documents, customer, all] = await Promise.all([repo.crmGet('compliance', deal.id), repo.crmList('document'), repo.crmGet('customer', deal.customerId), repo.crmList('compliance-check')]);
  if (!customer) throw missing();
  const checks = newestComplianceChecks(all.filter(c => c.dealId === deal.id || c.customerId === deal.customerId));
  const checklist = complianceChecklist(record ?? null, documents.filter(d => d.dealId === deal.id), customer.consent, checks);
  return {record: record ?? null, checks, checklist, complete: checklist.every(i => i.present)};
}
export async function compliance(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase(), time = now.toISOString();
  if (path === '/compliance/audit') return audit(request, principal, repo);
  if (/^\/compliance\/privacy-requests(\/|$)/.test(path)) return privacy(request, principal, repo, now);
  if (path === '/compliance/checks') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    onlyKeys(request.query ?? {}, ['search']);
    const search = text(request.query?.search ?? '', 'Search', 200, true).toLowerCase();
    return response(200, {data: newestComplianceChecks((await repo.crmList('compliance-check')).filter(c => [c.customerName, c.method, c.initials, c.result].some(v => v.toLowerCase().includes(search))))});
  }
  const match = /^\/deals\/([^/]+)\/(compliance|compliance-checks)$/.exec(path); if (!match) throw missing();
  onlyKeys(request.query ?? {}, []);
  const deal = await repo.crmGet('deal', requireId(match[1])); if (!deal) throw missing();
  const log = match[2] === 'compliance-checks';
  if (!(log ? ['GET', 'POST'] : ['GET', 'POST', 'PUT']).includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (method === 'GET') {
    // This history endpoint is deal-only; the checklist also accepts this customer's other checks.
    return response(200, {data: log ? newestComplianceChecks((await repo.crmList('compliance-check')).filter(c => c.dealId === deal.id)) : await dealCompliance(repo, deal)});
  }
  requireWrite(principal, method);
  const b = parseBody(request.body); let expected = 0, record: ComplianceRecord | ComplianceCheck;
  if (log) {
    onlyKeys(b, ['method', 'result', 'checkedDate', 'initials', 'notes']);
    const checkedDate = text(b.checkedDate, 'Check date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedDate) || !Number.isFinite(Date.parse(checkedDate)) || new Date(checkedDate).toISOString().slice(0, 10) !== checkedDate || checkedDate > time.slice(0, 10)) throw invalid('Provide a real check date, not in the future.');
    const customer = await repo.crmGet('customer', deal.customerId); if (!customer) throw missing();
    record = {kind: 'compliance-check', id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: time, updatedAt: time, dealId: deal.id, customerId: customer.id, customerName: customer.name,
      method: text(b.method, 'List / source used', 120), result: choice(b.result, complianceCheckResults, 'dealer-recorded result'), checkedDate, initials: text(b.initials, 'Initials', 10), notes: text(b.notes === undefined ? '' : b.notes, 'Notes', 2000, true), performedBy: principal.userId, performedAt: time};
  } else {
    onlyKeys(b, ['documentInspected', 'addressDiscrepancy', 'privacyNoticeGiven', ...(method === 'PUT' ? ['version'] : [])]);
    const old = await repo.crmGet('compliance', deal.id);
    if (method === 'POST' && old) throw invalid('A compliance record already exists for this deal.');
    if (method === 'PUT') { if (!old) throw missing(); expected = version(b.version); if (expected !== old.version) throw conflict(); }
    const attest = (key: 'documentInspected' | 'addressDiscrepancy' | 'privacyNoticeGiven'): ComplianceAttestation | null => {
      if (b[key] === undefined) return old?.[key] ?? null;
      if (b[key] === null) return null;
      const a = object(b[key]); onlyKeys(a, ['note']);
      return {by: principal.userId, at: time, note: text(a.note === undefined ? '' : a.note, 'Note', 2000, true)};
    };
    record = {kind: 'compliance', id: deal.id, tenantId: principal.tenantId, version: expected + 1, createdAt: old?.createdAt ?? time, updatedAt: time, dealId: deal.id, customerId: deal.customerId,
      documentInspected: attest('documentInspected'), addressDiscrepancy: attest('addressDiscrepancy'), privacyNoticeGiven: attest('privacyNoticeGiven')};
  }
  await repo.crmWrite([{record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version,
    type: log ? 'compliance-check.created' : expected ? 'compliance.updated' : 'compliance.created', occurredAt: time, deliveryStatus: 'pending'}}]);
  return response(method === 'POST' ? 201 : 200, {data: record});
}


async function audit(request: ApiRequest, principal: Principal, repo: TenantRepository) {
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can read the audit log.');
  if (request.method.toUpperCase() !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Audit events are read-only.');
  const q = request.query ?? {}; onlyKeys(q, ['type', 'actor', 'target', 'search']);
  const filters = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, text(v, k, 200, true).toLowerCase()]));
  // Read the tenant partition first. Filters can only narrow that result.
  const events = (await repo.events()).filter(event =>
    (!filters.type || event.type.toLowerCase().includes(filters.type) || event.action?.toLowerCase().includes(filters.type)) &&
    (!filters.actor || event.actorId.toLowerCase() === filters.actor) &&
    (!filters.target || event.aggregateId.toLowerCase() === filters.target) &&
    (!filters.search || [event.occurredAt, event.actorId, event.type, event.action ?? '', event.aggregateId].join(' ').toLowerCase().includes(filters.search)));
  return response(200, {data: events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id))});
}
async function privacy(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase(), at = now.toISOString();
  onlyKeys(request.query ?? {}, []);
  const root = '/compliance/privacy-requests';
  const match = /^\/compliance\/privacy-requests\/([^/]+)$/.exec(path);
  if (path !== root && !match) throw missing();
  const old = match ? await repo.crmGet('privacy-request', requireId(match[1])) : undefined;
  if (match && !old) throw missing();
  if (method === 'GET') return response(200, {data: old ?? (await repo.crmList('privacy-request')).sort((a, b) => b.createdAt.localeCompare(a.createdAt))});
  if (method !== (old ? 'PUT' : 'POST')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  requireWrite(principal, method);
  const b = parseBody(request.body);
  const write = (record: PrivacyRequest | Customer, expectedVersion: number, action: string): CrmWrite => ({record, expectedVersion, event: {
    id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version,
    type: `${record.kind}.${expectedVersion ? 'updated' : 'created'}`, action, occurredAt: at, deliveryStatus: 'pending'
  } satisfies OutboxEvent});
  if (!old) {
    onlyKeys(b, ['customerId', 'type', 'dueDate']);
    const customerId = requireId(b.customerId);
    if (!await repo.crmGet('customer', customerId)) throw missing();
    const dueDate = text(b.dueDate, 'Due date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate) throw invalid('Provide a real due date.');
    const record: PrivacyRequest = {kind: 'privacy-request', id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: at, updatedAt: at,
      customerId, type: choice(b.type, ['access', 'deletion'] as const, 'request type'), status: 'received', dueDate, receivedBy: principal.userId, receivedAt: at,
      history: [{actor: principal.userId, action: 'received', at, note: 'Request logged'}]};
    await repo.crmWrite([write(record, 0, 'privacy-request.received')]);
    return response(201, {data: record});
  }
  onlyKeys(b, ['version', 'status', 'denialReason']);
  if (version(b.version) !== old.version) throw conflict();
  if (old.status === 'fulfilled' || old.status === 'denied') throw invalid('This request is terminal and cannot change.');
  const status = choice(b.status, privacyStatuses, 'status');
  if (status === 'received' || status === old.status) throw invalid('Choose in progress, fulfilled or denied; requests cannot move backwards.');
  if (status !== 'denied' && b.denialReason !== undefined) throw invalid('A denial reason applies only to denied requests.');
  const customer = await repo.crmGet('customer', old.customerId); if (!customer) throw missing();
  const record: PrivacyRequest = {...old, status, version: old.version + 1, updatedAt: at, history: [...old.history]};
  let note = 'Work started', dataExport: CustomerDataExport | undefined;
  const writes: CrmWrite[] = [];
  if (status === 'denied') {
    record.denialReason = text(b.denialReason, 'Denial reason', 2000);
    record.deniedBy = principal.userId; record.deniedAt = at; note = record.denialReason;
  }
  if (status === 'fulfilled') {
    record.fulfilledBy = principal.userId; record.fulfilledAt = at;
    if (old.type === 'access') {
      const [leads, allDeals, documents] = await Promise.all([repo.crmList('lead'), repo.crmList('deal'), repo.crmList('document')]);
      const deals = allDeals.filter(d => d.customerId === customer.id), ids = new Set(deals.map(d => d.id));
      dataExport = {requestId: old.id, generatedAt: at, generatedBy: principal.userId, customer, leads: leads.filter(l => l.customerId === customer.id), deals, documents: documents.filter(d => ids.has(d.dealId))};
      note = `Data export generated: customer record, ${dataExport.leads.length} leads, ${deals.length} deals, ${dataExport.documents.length} document metadata records (JSON).`;
    } else {
      const anonymized: Customer = {...customer, version: customer.version + 1, updatedAt: at, name: 'Anonymized customer', email: '', phone: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}};
      writes.push(write(anonymized, customer.version, 'customer.anonymized'));
      note = anonymizationNotice;
      record.history.push({actor: principal.userId, action: 'anonymized', at, note});
    }
  }
  record.history.push({actor: principal.userId, action: status, at, note});
  writes.push(write(record, old.version, `privacy-request.${status}`));
  // Request transition, customer anonymization and their outbox events commit together.
  await repo.crmWrite(writes);
  return response(200, {data: {request: record, ...(dataExport ? {export: dataExport} : {})}});
}
