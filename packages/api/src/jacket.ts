import { packetInputs, packetHash, documentSignatureStatus } from './signature-targets.js';
import { signatureStatusFor } from '@freedms/shared';
import { dealCompliance } from './compliance.js';
import { randomUUID } from 'node:crypto';
import { jacketChecklist, documentTypes, maxDocumentBytes, type DealDocument, type DealJacket, type Principal } from '@freedms/shared';
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
    const packet = await packetInputs(repo, deal), {deal: {vehicle}} = packet;
    const documents = await repo.crmList('document');
    const signatures = (await repo.crmList('signature')).filter(s => s.dealId === deal.id).sort((a,b) => a.signedAt.localeCompare(b.signedAt) || a.id.localeCompare(b.id));
    const hash = packetHash(packet), status = signatureStatusFor(signatures, 'buyers-order', deal.id, hash);
    const attached = await Promise.all(documents.filter(d => d.dealId === deal.id).map(async d => ({...d, signatureStatus: await documentSignatureStatus(d, signatures, store)})));
    const application = (await repo.crmList('credit-application')).find(a => a.dealId === deal.id);
    const payoffQuotes = (await repo.crmList('payoff-quote')).filter(q => q.dealId === deal.id).sort((a, b) => a.quotedAt.localeCompare(b.quotedAt) || a.id.localeCompare(b.id));
    const compliance = await dealCompliance(repo, deal);
    const data: DealJacket = {
      compliance: {checklist: compliance.checklist, complete: compliance.complete, checks: compliance.checks.filter(c => c.dealId === deal.id)},
      credit: application ? {status: application.status, decisionOutcome: application.decision?.outcome ?? null, lenderName: application.decision?.lenderName ?? null, applicantSsnLast4: application.applicant.ssnLast4} : null,
      adverseAction: application?.decision?.outcome === 'declined' ? {applicantName: application.applicant.fullName, decidedAt: application.decision.decidedAt, lenderName: application.decision.lenderName, reasons: application.decision.adverseReasons} : null,
      payoffQuotes, ...packet, signatures, buyersOrderSignature: {status, hash},
      buyersGuide: {vehicle: {year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vehicle.vin, stockNumber: vehicle.stockNumber}, asIs: true, dealerWarranty: null, manufacturerWarranty: null}, documents: attached,
      checklist: jacketChecklist(attached).map(item => item.key === 'buyers-order' ? {...item, signatureStatus: status} : item)};
    return response(200, {data});
  }
  if (method === 'GET' && !match[3]) return response(200, {data: (await repo.crmList('document')).filter(d => d.dealId === deal.id)});
  if (method === 'GET' && match[3]) {
    const record = await repo.crmGet('document', requireId(match[3])); if (!record || record.dealId !== deal.id) throw missing();
    if (record.status) throw new ApiError(410, 'DOCUMENT_DISPOSED', 'This document was disposed or is awaiting disposal.');
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

/** Observe the transition around a successful domain command, including approval after uploads.
 * This signal is best effort; the outbox-backed projection remains authoritative.
 */
export async function observeJacketCompletion<T>(repo: TenantRepository, dealId: string, track: import('./analytics.js').Track, command: () => Promise<T>): Promise<T> {
  const complete = async () => {
    const [deal, docs] = await Promise.all([repo.crmGet('deal', dealId), repo.crmList('document')]);
    return !!deal && ['approved', 'sold'].includes(deal.status) && jacketChecklist(docs.filter(d => d.dealId === dealId)).every(c => c.present);
  };
  let before: boolean | undefined;
  try { before = await complete(); } catch { /* Observation must not block the command. */ }
  const result = await command();
  try { if (before === false && await complete()) await track({event: 'jacket_checklist_completed'}); } catch { /* Preserve the committed response. */ }
  return result;
}
