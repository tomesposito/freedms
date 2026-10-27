import { packetInputs, packetHash, documentSignatureStatus } from './signature-targets.js';
import { signatureStatusFor } from '@freedms/shared';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { defaultShareExpiryDays, documentTypes, maxDocumentBytes, pencilMath, leaseMath, paymentGrid, type BuyerDealView, type Deal, type DealShare, type ShareResponse, type DealDocument, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, text } from './validation.js';
import { choice } from './crm-validation.js';
import type { CrmWrite, RepositoryFactory, TenantRepository } from './repository.js';
import type { DocumentStore } from './document-store.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new ApiError(404, 'SHARE_UNAVAILABLE', 'This link is no longer available.');
const wrongMethod = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
function write(record: DealShare | ShareResponse | DealDocument, actorId: string, expectedVersion = 0): CrmWrite {
  return {record, expectedVersion, event: {id: randomUUID(), tenantId: record.tenantId, actorId, aggregateId: record.id, aggregateVersion: record.version, type: record.kind === 'share-response' ? 'share-response.created' : record.kind === 'document' ? 'document.created' : `deal-share.${expectedVersion ? 'updated' : 'created'}`, occurredAt: record.updatedAt, deliveryStatus: 'pending'}};
}
const active = (s: DealShare, now: Date) => !s.revokedAt && s.expiresAt > now.toISOString();
export async function dealerShare(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const match = /^\/deals\/([^/]+)\/share(\/revoke)?$/.exec(request.path.replace(/\/$/, ''));
  if (!match) throw missing();
  const method = request.method.toUpperCase();
  if (!(method === 'POST' || method === 'GET' && !match[2])) throw wrongMethod();
  onlyKeys(request.query ?? {}, []);
  const deal = await repo.crmGet('deal', requireId(match[1])); if (!deal) throw missing();
  const shares = (await repo.crmList('deal-share')).filter(s => s.dealId === deal.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.id.localeCompare(a.id));
  const share = shares[0];
  if (method === 'GET') {
    const responses = share ? (await repo.crmList('share-response')).filter(r => r.shareId === share.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) : [];
    return response(200, {data: {share: share ? {id: share.id, createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt, active: active(share, now) && ['working', 'approved'].includes(deal.status)} : null, responses}});
  }
  requireWrite(principal, method); onlyKeys(parseBody(request.body), []);
  const date = now.toISOString();
  const revoke = (s: DealShare) => write({...s, revokedAt: date, updatedAt: date, version: s.version + 1}, principal.userId, s.version);
  const current = shares.filter(s => active(s, now));
  if (match[2]) {
    if (!current.length) throw missing();
    await repo.crmWrite(current.map(revoke));
    return response(200, {data: {id: current[0].id, revokedAt: date}});
  }
  if (!['working', 'approved'].includes(deal.status)) throw invalid('Closed deals cannot be shared.');
  const days = (await repo.crmGet('settings', 'workspace'))?.shareExpiryDays ?? defaultShareExpiryDays;
  const token = `${principal.tenantId}.${randomBytes(32).toString('hex')}`;
  const record: DealShare = {id: randomUUID(), kind: 'deal-share', tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date, dealId: deal.id, tokenHash: hash(token), expiresAt: new Date(now.getTime() + days * 86400000).toISOString(), revokedAt: null, createdBy: principal.userId};
  await repo.crmWrite([...current.map(revoke), write(record, principal.userId)]);
  return response(201, {data: {token, shareId: record.id, expiresAt: record.expiresAt, path: `/share/${token}`}});
}
async function buyerView(repo: TenantRepository, deal: Deal, share: DealShare, store?: DocumentStore): Promise<BuyerDealView> {
  const [vehicle, customer, tenant] = await Promise.all([repo.get(deal.vehicleId), repo.crmGet('customer', deal.customerId), repo.tenant()]);
  const p = deal.pencils.find(p => p.id === deal.workingPencilId);
  if (!vehicle || !customer || !tenant || !p) throw unavailable();
  const m = pencilMath(p, deal.trade, deal, vehicle, p.type ?? deal.type), l = deal.type === 'lease' ? leaseMath(p, deal.trade, deal, vehicle) : null;
  const signatures = await repo.crmList('signature');
  const buyersOrderSignature = signatureStatusFor(signatures, 'buyers-order', deal.id, packetHash(await packetInputs(repo, deal)));
  const docs = (await repo.crmList('document')).filter(d => d.dealId === deal.id && !d.status);
  const documentsAwaitingSignature = (await Promise.all(docs.map(d => documentSignatureStatus(d, signatures, store)))).filter(s => s !== 'signed').length;
  // Lease maps adjusted capitalized balance to amountFinanced, rent to financeCharge,
  // monthly payment times term to totalPayments, and drive-off to cashDue.
  return {
    buyersOrderSignature, documentsAwaitingSignature, dealershipName: tenant.name, customerName: customer.name, dealType: deal.type,
    vehicle: {year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim, vin: vehicle.vin, stockNumber: vehicle.stockNumber},
    price: p.price, docFee: deal.docFee, salesTax: m.salesTax,
    fiProducts: p.fiSelections.filter(s => s.status === 'accepted').map(s => ({name: s.name, retailPrice: s.retailPrice, termNotes: s.termNotes})), fiRetailTotal: m.fiRetailTotal,
    trade: deal.trade ? {year: deal.trade.year, make: deal.trade.make, model: deal.trade.model, allowance: deal.trade.allowance, payoff: deal.trade.payoff, netEquity: m.netEquity} : null,
    down: p.down, amountFinanced: l?.adjustedCapCost ?? m.amountFinanced, monthlyPayment: l?.monthlyPayment ?? m.payment, totalPayments: l ? l.monthlyPayment * p.term : m.totalPayments, financeCharge: l?.totalRentCharge ?? m.financeCharge, cashDue: l?.driveOff ?? m.cashDue, aprBps: p.aprBps, termMonths: p.term, expiresAt: share.expiresAt,
    paymentOptions: deal.type === 'finance' ? paymentGrid(p, deal.trade, deal, vehicle).flatMap(row => row.options.map(o => ({id: `${row.term}-${o.down}`, kind: 'finance' as const, termMonths: row.term, down: o.down, monthlyPayment: o.payment, amountDue: null}))) : [{id: deal.type, kind: deal.type, termMonths: l ? p.term : null, down: p.down, monthlyPayment: l?.monthlyPayment ?? null, amountDue: l?.driveOff ?? m.cashDue}]
  };
}
// LOCAL-ONLY development surface served by the same local API. Malformed, unknown,
// revoked, expired and closed-deal tokens deliberately return one identical 404.
export async function publicShare(request: ApiRequest, repositories: RepositoryFactory, now: Date, store?: DocumentStore) {
  const match = /^\/share\/([^/]+)(?:\/(respond|documents))?$/.exec(request.path.replace(/\/$/, ''));
  if (!match) throw missing();
  const method = request.method.toUpperCase();
  if (method !== (match[2] ? 'POST' : 'GET')) throw wrongMethod();
  const token = match[1], parts = token.split('.');
  if (parts.length !== 2 || !/^[\w-]{1,128}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) throw unavailable();
  const repo = repositories.forTenant(parts[0]), digest = Buffer.from(hash(token));
  const share = (await repo.crmList('deal-share')).find(s => /^[a-f0-9]{64}$/.test(s.tokenHash) && timingSafeEqual(digest, Buffer.from(s.tokenHash)));
  if (!share || !active(share, now)) throw unavailable();
  const deal = await repo.crmGet('deal', share.dealId);
  if (!deal || !['working', 'approved'].includes(deal.status)) throw unavailable();
  onlyKeys(request.query ?? {}, []);
  if (!match[2]) return {result: response(200, {data: await buyerView(repo, deal, share, store)}), tenantId: parts[0]};
  const b = parseBody(request.body), date = now.toISOString();
  const base = {id: randomUUID(), tenantId: parts[0], version: 1, createdAt: date, updatedAt: date, dealId: deal.id};
  if (match[2] === 'respond') {
    onlyKeys(b, ['optionId', 'message']);
    if (('optionId' in b) === ('message' in b)) throw invalid('Choose one payment option or send a message.');
    const record: ShareResponse = {...base, kind: 'share-response', shareId: share.id, responseKind: 'change-request', optionId: null, termMonths: null, down: 0, monthlyPayment: null, amountDue: null, message: ''};
    if ('optionId' in b) {
      const option = (await buyerView(repo, deal, share, store)).paymentOptions.find(o => o.id === b.optionId);
      if (!option) throw invalid('Choose an available payment option.');
      Object.assign(record, {responseKind: 'payment-choice', optionId: option.id, termMonths: option.termMonths, down: option.down, monthlyPayment: option.monthlyPayment, amountDue: option.amountDue});
    } else record.message = text(b.message, 'Message', 1000);
    await repo.crmWrite([write(record, 'customer')]);
    return {result: response(201, {data: {received: true}}), tenantId: parts[0]};
  }
  onlyKeys(b, ['name', 'type', 'content']);
  const name = text(b.name, 'Document name', 160), type = choice(b.type, documentTypes, 'document type');
  if (typeof b.content !== 'string' || !b.content.length || b.content.length > Math.ceil(maxDocumentBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.content)) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
  const bytes = Buffer.from(b.content, 'base64');
  if (bytes.length > maxDocumentBytes || bytes.toString('base64') !== b.content) throw invalid('Provide valid base64 content, at most 40 KiB decoded.');
  if (!store) throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
  const record: DealDocument = {...base, kind: 'document', name, type, size: bytes.length, uploadedBy: 'customer', uploadedAt: date, customerUploaded: true};
  const storage = store.forTenant(parts[0]); await storage.put(record.id, bytes);
  try { await repo.crmWrite([write(record, 'customer')]); } catch (error) { await storage.remove(record.id); throw error; }
  return {result: response(201, {data: {name, type, size: bytes.length}}), tenantId: parts[0]};
}
