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
