import { ensureDefaultAccounts, dealPosting } from './accounting.js';
import { randomUUID } from 'node:crypto';
import { defaultShareExpiryDays, defaultLeaseTerms, residualFromPercent, residualPercentFromAmount, moneyFactorToAprBps, defaultSettings, dealStatuses, pencilMath, type CrmEntity, type Deal, type DealView, type Pencil, type Principal, type TaxSettings, type Trade, type WorkspaceSettings } from '@freedms/shared';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, money, object, onlyKeys, text, version } from './validation.js';
import { choice } from './crm-validation.js';
import type { CrmWrite, TenantRepository, VehicleWrite } from './repository.js';
function integer(value: unknown, max: number, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(`Invalid ${label}.`);
  return value;
}
function taxInput(b: Record<string, unknown>): TaxSettings {
  if (typeof b.taxTradeDifference !== 'boolean') throw invalid('Trade tax toggle must be boolean.');
  return {taxRateBps: integer(b.taxRateBps, 10000, 'tax rate'), taxTradeDifference: b.taxTradeDifference, docFee: money(b.docFee, 'Doc fee')};
}
function tradeInput(value: unknown): Trade | null {
  if (value === null) return null;
  const b = object(value); onlyKeys(b, ['year', 'make', 'model', 'vin', 'allowance', 'payoff', 'actualCashValue']);
  return {year: text(b.year, 'Trade year', 20), make: text(b.make, 'Trade make'), model: text(b.model, 'Trade model'), vin: text(b.vin, 'Trade VIN', 100, true), allowance: money(b.allowance, 'Allowance'), payoff: money(b.payoff, 'Payoff'), actualCashValue: money(b.actualCashValue, 'Actual cash value')};
}
async function pencilInput(value: unknown, repo: TenantRepository, old: Deal, effectiveType: Deal['type']): Promise<Pencil> {
  const b = object(value); onlyKeys(b, ['type', 'id', 'name', 'price', 'down', 'term', 'aprBps', 'fiSelections', 'sourcePencilId', 'lease']);
  // Pencils are full replacements: an omitted menu is empty.
  const selections = b.fiSelections === undefined ? [] : b.fiSelections;
  if (!Array.isArray(selections) || selections.length > 50) throw invalid('Choose at most 50 F&I products.');
  const existing = old.pencils.find(p => p.id === b.id);
  // Preserve typed snapshots for older clients; new/legacy pencils use the effective deal type.
  const type = b.type === undefined ? existing?.type ?? effectiveType : choice(b.type, ['cash', 'finance', 'lease'] as const, 'pencil type');
  const sourceId = b.sourcePencilId === undefined ? undefined : requireId(b.sourcePencilId);
  const source = sourceId ? old.pencils.find(p => p.id === sourceId) : existing;
  if (sourceId && (!source || existing)) throw invalid('Copy source must be a saved pencil and the copy must have a new ID.');
  const seen = new Set<string>();
  const fiSelections = await Promise.all(selections.map(async value => {
    const s = object(value); onlyKeys(s, ['productId', 'status']);
    const productId = requireId(s.productId), status = choice(s.status, ['accepted', 'declined'] as const, 'F&I status');
    if (seen.has(productId)) throw invalid('F&I products must be unique.'); seen.add(productId);
    const product = await repo.crmGet('fi-product', productId);
    if (!product) throw invalid('F&I product must belong to this workspace.');
    // Inactive products remain valid. Preserve this pencil's saved snapshot, including on a copy.
    const saved = source?.fiSelections.find(s => s.productId === productId);
    const {name, category, cost, retailPrice, termNotes} = saved ?? product;
    return {productId, name, category, cost, retailPrice, termNotes, status};
  }));
  let lease = null;
  if (type === 'lease') {
    const l = object(b.lease); onlyKeys(l, ['msrp', 'residualPercentBps', 'residualAmount', 'moneyFactorMicro', 'acquisitionFee', 'securityDeposit', 'milesPerYear']);
    const msrp = money(l.msrp, 'MSRP');
    const percent = l.residualPercentBps != null, amount = l.residualAmount != null;
    if (percent === amount) throw invalid('Choose exactly one residual driver.');
    const residualAmount = percent ? residualFromPercent(msrp, integer(l.residualPercentBps, 10000, 'residual percent')) : money(l.residualAmount, 'Residual');
    if (residualAmount > msrp) throw invalid('Residual cannot exceed MSRP.');
    const residualPercentBps = percent ? Number(l.residualPercentBps) : residualPercentFromAmount(msrp, residualAmount);
    lease = {msrp, residualAmount, residualPercentBps, moneyFactorMicro: integer(l.moneyFactorMicro, 10000, 'money factor'), acquisitionFee: money(l.acquisitionFee, 'Acquisition fee'), securityDeposit: money(l.securityDeposit, 'Security deposit'), milesPerYear: integer(l.milesPerYear, 100000, 'miles per year')};
  }
  return {type, lease, fiSelections, id: requireId(b.id), name: text(b.name, 'Pencil name', 80), price: money(b.price, 'Price'), down: money(b.down, 'Down payment'), term: integer(b.term, 120, 'term', 1), aprBps: lease ? moneyFactorToAprBps(lease.moneyFactorMicro) : integer(b.aprBps, 10000, 'APR')};
}
async function view(repo: TenantRepository, d: Deal): Promise<DealView> {
  const [vehicle, customer] = await Promise.all([repo.get(d.vehicleId), repo.crmGet('customer', d.customerId)]);
  if (!vehicle || !customer) throw missing();
  return {...d, pencils: d.pencils.map(p => ({...p, type: p.type ?? d.type})), vehicle, customer};
}
export async function desking(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, agent = false) {
  const method = request.method.toUpperCase(), path = request.path.replace(/\/$/, ''), query = request.query ?? {};
  const date = now.toISOString();
  const base = () => ({id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date});
  const write = (record: Exclude<CrmEntity, {kind: 'terms-acceptance'}>, expectedVersion = 0): CrmWrite => ({record, expectedVersion, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, ...(agent ? {actorType: 'agent' as const} : {}), aggregateId: record.id, aggregateVersion: record.version, type: record.kind === 'signature' ? 'signature.created' : record.kind === 'parts-return' ? 'parts-return.created' : record.kind === 'parts-sale' ? 'parts-sale.created' : record.kind === 'compliance-check' ? 'compliance-check.created' : record.kind === 'share-response' ? 'share-response.created' : record.kind === 'payoff-quote' ? 'payoff-quote.created' : record.kind === 'journal-entry' ? 'journal-entry.created' : `${record.kind}.${expectedVersion ? 'updated' : 'created'}`, occurredAt: date, deliveryStatus: 'pending'}});
  if (path === '/settings') {
    onlyKeys(query, []);
    const old = await repo.crmGet('settings', 'workspace');
    if (method === 'GET') return response(200, {data: {...(old ?? {...defaultSettings, version: 0}), commissionRateBps: old?.commissionRateBps ?? 0, shareExpiryDays: old?.shareExpiryDays ?? defaultShareExpiryDays}});
    if (method !== 'PUT') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can change workspace settings.');
    const b = parseBody(request.body); onlyKeys(b, ['version', 'taxRateBps', 'taxTradeDifference', 'docFee', 'commissionRateBps', 'shareExpiryDays']);
    const expected = integer(b.version, Number.MAX_SAFE_INTEGER, 'version'); if ((old?.version ?? 0) !== expected) throw conflict();
    const record: WorkspaceSettings = {...base(), ...taxInput(b), shareExpiryDays: b.shareExpiryDays === undefined ? old?.shareExpiryDays ?? defaultShareExpiryDays : integer(b.shareExpiryDays, 90, 'share link expiry days', 1), commissionRateBps: b.commissionRateBps === undefined ? old?.commissionRateBps ?? 0 : integer(b.commissionRateBps, 10000, 'commission rate'), id: 'workspace', kind: 'settings', version: expected + 1, createdAt: old?.createdAt ?? date};
    await repo.crmWrite([write(record, expected)]); return response(200, {data: record});
  }
  if (path !== '/deals' && !/^\/deals\/[^/]+$/.test(path)) throw missing();
  const id = path === '/deals' ? undefined : requireId(path.split('/')[2]);
  if (method === 'GET') {
    onlyKeys(query, id ? [] : ['status']);
    if (id) { const d = await repo.crmGet('deal', id); if (!d) throw missing(); return response(200, {data: await view(repo, d)}); }
    if (query.status) choice(query.status, dealStatuses, 'status');
    const deals = (await repo.crmList('deal')).filter(d => !query.status || d.status === query.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return response(200, {data: await Promise.all(deals.map(d => view(repo, d)))});
  }
  onlyKeys(query, []); const b = parseBody(request.body);
  if (method === 'POST' && !id) {
    onlyKeys(b, ['vehicleId', 'customerId', 'leadId', 'type']);
    const vehicleId = requireId(b.vehicleId), customerId = requireId(b.customerId), leadId = b.leadId ? requireId(b.leadId) : null;
    const vehicle = await repo.get(vehicleId), customer = await repo.crmGet('customer', customerId);
    if (!vehicle || !customer) throw invalid('Vehicle and buyer must belong to this workspace.');
    if (vehicle.status === 'sold') throw invalid('This vehicle is already sold.');
    if (leadId) { const lead = await repo.crmGet('lead', leadId); if (!lead || lead.customerId !== customerId || (lead.vehicleId && lead.vehicleId !== vehicleId)) throw invalid('Originating lead must match the buyer and vehicle.'); }
    const settings = await repo.crmGet('settings', 'workspace') ?? defaultSettings;
    const type = choice(b.type, ['cash', 'finance', 'lease'] as const, 'deal type');
    const pencil: Pencil = {type, lease: type === 'lease' ? defaultLeaseTerms(vehicle.listPrice) : null, id: randomUUID(), name: 'Initial pencil', fiSelections: [], price: vehicle.listPrice, down: 0, term: 36, aprBps: 0};
    const deal: Deal = {...base(), kind: 'deal', vehicleId, customerId, leadId, type, trade: null,
      taxRateBps: settings.taxRateBps, taxTradeDifference: settings.taxTradeDifference, docFee: settings.docFee,
      pencils: [pencil], workingPencilId: pencil.id, status: 'working', history: [{status: 'working', actorId: principal.userId, timestamp: date}]};
    await repo.crmWrite([write(deal)]); return response(201, {data: await view(repo, deal)});
  }
  if (method !== 'PUT' || !id) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(b, ['version', 'type', 'trade', 'docFee', 'pencils', 'workingPencilId', 'status']);
  const old = await repo.crmGet('deal', id); if (!old) throw missing();
  const expected = version(b.version); if (old.version !== expected) throw conflict();
  if (old.status === 'sold' || old.status === 'dead') throw invalid('Closed deals cannot be changed.');
  const status = b.status === undefined ? old.status : choice(b.status, dealStatuses, 'status');
  if (status !== old.status && !(old.status === 'working' ? ['approved', 'dead'] : ['sold', 'dead']).includes(status)) throw invalid('Invalid deal status transition.');
  const type = b.type === undefined ? old.type : choice(b.type, ['cash', 'finance', 'lease'] as const, 'deal type');
  let pencils = old.pencils.map(p => ({...p, type: p.type ?? old.type, lease: (p.type ?? old.type) === 'lease' ? p.lease : null}));
  if (b.pencils !== undefined) {
    if (!Array.isArray(b.pencils) || !b.pencils.length || b.pencils.length > 20) throw invalid('Save between 1 and 20 pencils.');
    pencils = await Promise.all(b.pencils.map(p => pencilInput(p, repo, old, type))); if (new Set(pencils.map(p => p.id)).size !== pencils.length) throw invalid('Pencil IDs must be unique.');
  }
  const workingPencilId = b.workingPencilId === undefined ? old.workingPencilId : requireId(b.workingPencilId);
  if (!pencils.some(p => p.id === workingPencilId)) throw invalid('Choose a saved working pencil.');
  if (b.pencils === undefined && b.type !== undefined) {
    const vehicle = await repo.get(old.vehicleId); if (!vehicle) throw missing();
    pencils = pencils.map(p => p.id === workingPencilId ? {...p, type, lease: type === 'lease' ? p.lease ?? defaultLeaseTerms(vehicle.listPrice) : null} : p);
  }
  const deal: Deal = {...old, version: expected + 1, updatedAt: date, pencils, workingPencilId, status,
    type: pencils.find(p => p.id === workingPencilId)!.type,
    trade: b.trade === undefined ? old.trade : tradeInput(b.trade), docFee: b.docFee === undefined ? old.docFee : money(b.docFee, 'Doc fee'),
    history: status === old.status ? old.history : [...old.history, {status, actorId: principal.userId, timestamp: date}]};
  const result = await view(repo, deal);
  try { for (const p of pencils) pencilMath(p, deal.trade, deal, result.vehicle, p.type); }
  catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid pencil.'); }
  const writes = [write(deal, expected)]; const vehicles: VehicleWrite[] = [];
  if (status === 'sold') {
    const vehicle = result.vehicle; if (vehicle.status === 'sold') throw conflict();
    const record = {...vehicle, status: 'sold' as const, version: vehicle.version + 1, updatedAt: date};
    vehicles.push({record, expectedVersion: vehicle.version, event: {...write(deal).event, id: randomUUID(), aggregateId: vehicle.id, aggregateVersion: record.version, type: 'vehicle.updated'}});
    const accounts = await ensureDefaultAccounts(repo, principal, now);
    if (!(await repo.crmList('journal-entry')).some(e => e.dealId === deal.id && e.source === 'deal-posting')) writes.push(write(dealPosting(result, accounts, now)));
    result.vehicle = record;
    if (deal.leadId) {
      const lead = await repo.crmGet('lead', deal.leadId); if (!lead) throw missing();
      const soldLead = {...lead, stage: 'sold' as const, version: lead.version + 1, updatedAt: date, activities: [...lead.activities, {id: randomUUID(), kind: 'stage' as const, actorId: principal.userId, timestamp: date, summary: `Deal ${deal.id} sold: ${lead.stage} → sold`}]};
      if (soldLead.activities.length > 400 || Buffer.byteLength(JSON.stringify(soldLead)) > 250000) throw invalid('This lead has reached its activity limit.');
      writes.push(write(soldLead, lead.version));
    }
  }
  await repo.crmWrite(writes, vehicles); return response(200, {data: result});
}
