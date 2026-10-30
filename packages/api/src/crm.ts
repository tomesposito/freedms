import { addOwnershipMonths, ownershipLead, ownershipSignals, saleDate, type EquityMiningEntry, type CustomerTimelineEntry } from '@freedms/shared';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isOverdue, type Activity, type CrmEntity, type Customer, type CustomerInput, type Lead, type LeadView, type OutboxEvent, type Principal } from '@freedms/shared';
import type { CrmWrite, RepositoryFactory, TenantRepository } from './repository.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest, type ApiResponse } from './handler.js';
import { pageNumber, invalid, onlyKeys, text, version } from './validation.js';
import { choice, communicationType, customerInput, normalizedPhone, source, stage, timestamp } from './crm-validation.js';
import { parseAdf } from './adf.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
function context(principal: Principal, now: Date, agent = false) {
  const date = now.toISOString();
  const base = () => ({id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: date, updatedAt: date});
  const write = (record: Exclude<CrmEntity, {kind: 'terms-acceptance' | 'signature' | 'parts-return' | 'parts-sale' | 'compliance-check' | 'journal-entry' | 'payoff-quote' | 'share-response'}>, expectedVersion = 0): CrmWrite => ({record, expectedVersion, event: {
    id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, ...(agent ? {actorType: 'agent' as const} : {}), aggregateId: record.id,
    aggregateVersion: record.version, type: `${record.kind}.${expectedVersion ? 'updated' : 'created'}`,
    occurredAt: date, deliveryStatus: 'pending'
  } satisfies OutboxEvent});
  const activity = (kind: Activity['kind'], summary: string): Activity => ({id: randomUUID(), kind, actorId: principal.userId, timestamp: date, summary});
  return {date, base, write, activity};
}
async function duplicates(repo: TenantRepository, input: CustomerInput): Promise<string[]> {
  return (await repo.crmList('customer')).filter(c =>
    (input.phone && normalizedPhone(c.phone) === normalizedPhone(input.phone)) || (input.email && c.email.toLowerCase() === input.email.toLowerCase()))
    .map(c => c.id);
}
async function leadView(repo: TenantRepository, lead: Lead, now: Date): Promise<LeadView> {
  const customer = await repo.crmGet('customer', lead.customerId); if (!customer) throw missing();
  return {...lead, customer, overdue: lead.followUps.some(t => isOverdue(t, now))};
}
async function references(repo: TenantRepository, vehicle: unknown, assignee: unknown) {
  const vehicleId = vehicle === null || vehicle === undefined || vehicle === '' ? null : requireId(vehicle);
  const assigneeId = assignee === null || assignee === undefined || assignee === '' ? null : requireId(assignee);
  if (vehicleId && !await repo.get(vehicleId)) throw invalid('Vehicle must belong to this workspace.');
  if (assigneeId && !(await repo.membership(assigneeId))?.active) throw invalid('Assignee must be an active workspace user.');
  return {vehicleId, assigneeId};
}
export async function createLead(repo: TenantRepository, principal: Principal, b: Record<string, unknown>, now: Date, agent = false) {
  onlyKeys(b, ['customerId', 'customer', 'vehicleId', 'vehicleDescription', 'source', 'sourceDetail', 'assigneeId']);
  if (!!b.customerId === !!b.customer) throw invalid('Choose an existing customer or supply a new customer.');
  const ctx = context(principal, now, agent); const writes: CrmWrite[] = []; let customer: Customer; let duplicateIds: string[] = [];
  if (b.customerId) { const existing = await repo.crmGet('customer', requireId(b.customerId)); if (!existing) throw missing(); customer = existing; }
  else { const input = customerInput(b.customer); duplicateIds = await duplicates(repo, input); customer = {...ctx.base(), kind: 'customer', ...input}; writes.push(ctx.write(customer)); }
  const refs = await references(repo, b.vehicleId, b.assigneeId);
  const lead: Lead = {...ctx.base(), kind: 'lead', customerId: customer.id, ...refs,
    vehicleDescription: text(b.vehicleDescription ?? '', 'Vehicle description', 1000, true), source: source(b.source), sourceDetail: text(b.sourceDetail ?? '', 'Source detail', 500, true),
    stage: 'new', activities: [ctx.activity('stage', 'Lead created: new')], followUps: []};
  writes.push(ctx.write(lead)); await repo.crmWrite(writes);
  return {lead: await leadView(repo, lead, now), duplicateCustomerIds: duplicateIds};
}
export async function intake(request: ApiRequest, repositories: RepositoryFactory, now: Date): Promise<ApiResponse> {
  const token = request.intakeToken ?? ''; const [tenantId, secret, extra] = token.split('.');
  const unauthorized = () => new ApiError(401, 'INTAKE_UNAUTHORIZED', 'A valid intake token is required.');
  if (!tenantId || !secret || extra || !/^[\w-]{1,128}$/.test(tenantId) || !/^[a-f0-9]{64}$/.test(secret)) throw unauthorized();
  const repo = repositories.forTenant(tenantId); const credential = await repo.crmGet('intake', 'token');
  if (!credential || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(credential.hash))) throw unauthorized();
  onlyKeys(request.query ?? {}, []);
  const parsed = parseAdf(request.body ?? '');
  const vehicles = await repo.list({});
  const matches = vehicles.filter(v => (parsed.vin && v.vin === parsed.vin) || (!parsed.vin && parsed.stockNumber && v.stockNumber === parsed.stockNumber));
  const data = await createLead(repo, {tenantId, userId: 'intake', role: 'staff'}, {...parsed.input, vehicleId: matches.length === 1 ? matches[0].id : null}, now);
  return response(201, {data});
}
export async function crm(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date): Promise<ApiResponse> {
  const method = request.method.toUpperCase(); const path = request.path.replace(/\/$/, ''); const parts = path.split('/').slice(1);
  const ctx = context(principal, now, request.agent); const query = request.query ?? {};
  if (path === '/equity-mining' && method === 'GET') {
    onlyKeys(query, ['search']); const search = text(query.search ?? '', 'Search', 200, true).toLowerCase();
    const [deals, customers, leads, vehicles] = await Promise.all([repo.crmList('deal'), repo.crmList('customer'), repo.crmList('lead'), repo.list({})]);
    const entries: EquityMiningEntry[] = [];
    for (const deal of deals.filter(d => d.status === 'sold')) {
      const customer = customers.find(c => c.id === deal.customerId); if (!customer || !customer.name.toLowerCase().includes(search)) continue;
      const vehicle = vehicles.find(v => v.id === deal.vehicleId), signals = ownershipSignals(deal, vehicle, now);
      if (!signals.reasons.length) continue;
      entries.push({...signals, customer: {id: customer.id, name: customer.name}, customerId: customer.id, dealId: deal.id,
        leadId: ownershipLead(deal, leads)?.id ?? null, vehicle: vehicle ? {id: vehicle.id, year: vehicle.year, make: vehicle.make, model: vehicle.model, stockNumber: vehicle.stockNumber} : null,
        dealType: deal.type, tradeRecorded: !!deal.trade, tradeAllowance: deal.trade?.allowance ?? 0, tradePayoff: deal.trade?.payoff ?? 0,
        saleNetEquityCents: (deal.trade?.allowance ?? 0) - (deal.trade?.payoff ?? 0), mileageBand: null});
    }
    entries.sort((a, b) => b.monthsOwned - a.monthsOwned || a.customer.name.localeCompare(b.customer.name) || a.dealId.localeCompare(b.dealId));
    return response(200, {data: entries});
  }
  if (path === '/ownership-cycle/generate' && method === 'POST') {
    onlyKeys(query, []); onlyKeys(parseBody(request.body), []);
    const [deals, leads] = await Promise.all([repo.crmList('deal'), repo.crmList('lead')]);
    let created = 0, skippedDeals = 0, leadsUpdated = 0;
    const changed = new Map<string, Lead>();
    for (const deal of deals.filter(d => d.status === 'sold').sort((a, b) => a.id.localeCompare(b.id))) {
      const lead = ownershipLead(deal, leads); if (!lead) { skippedDeals++; continue; }
      for (const [months, type, suffix] of [[11, 'visit', 'service-11'], [35, 'call', 'trade-35']] as const) {
        const cycleKey = `ownership:${deal.id}:${suffix}`;
        if (lead.followUps.some(t => t.cycleKey === cycleKey)) continue;
        const dueAt = addOwnershipMonths(saleDate(deal), months);
        const task = {id: randomUUID(), type, dueAt, done: false, origin: 'ownership-cycle' as const, cycleKey};
        const activity = ctx.activity('follow-up', `Ownership cycle: scheduled ${type}: ${dueAt}`);
        const candidate = {...lead, version: lead.version + 1, updatedAt: ctx.date, followUps: [...lead.followUps, task], activities: [...lead.activities, activity]};
        if (candidate.followUps.length > 200 || candidate.activities.length > 400 || Buffer.byteLength(JSON.stringify(candidate)) > 250000) { skippedDeals++; break; }
        lead.followUps.push(task); lead.activities.push(activity); changed.set(lead.id, lead); created++;
      }
    }
    // One versioned write per changed lead, within the repository's transaction size limit.
    for (const lead of changed.values()) {
      const expected = lead.version; lead.version++; lead.updatedAt = ctx.date;
      await repo.crmWrite([ctx.write(lead, expected)]); leadsUpdated++;
    }
    return response(200, {data: {created, skippedDeals, leadsUpdated}});
  }
  if (path === '/users' && method === 'GET') { onlyKeys(query, []); return response(200, {data: await repo.users()}); }
  if (path === '/intake-token' && method === 'POST') {
    if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can rotate the intake token.');
    onlyKeys(parseBody(request.body), []); onlyKeys(query, []);
    const old = await repo.crmGet('intake', 'token'); const token = `${principal.tenantId}.${randomBytes(32).toString('hex')}`;
    const record = {...ctx.base(), id: 'token', kind: 'intake' as const, hash: hash(token), version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? ctx.date};
    await repo.crmWrite([ctx.write(record, old?.version ?? 0)]); return response(201, {data: {token}});
  }
  const [collection, rawId, action, taskId] = parts;
  if (!['customers', 'leads'].includes(collection) || parts.length > 4) throw missing();
  const id = rawId ? requireId(rawId) : undefined;
  if (method === 'GET' && !action) {
    if (id) {
      onlyKeys(query, []);
      if (collection === 'customers') {
        const customer = await repo.crmGet('customer', id); if (!customer) throw missing();
        const communications = (await repo.crmList('lead')).filter(l => l.customerId === id).flatMap(l => l.activities.filter(a => a.kind === 'communication').map(a => ({...a, leadId: l.id}))).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const leads = (await repo.crmList('lead')).filter(l => l.customerId === id);
        const timeline: CustomerTimelineEntry[] = leads.flatMap(l => l.activities.map(a => ({timestamp: a.timestamp, kind: a.kind, summary: a.summary, leadId: l.id, ...(a.type ? {type: a.type} : {}), ...(a.direction ? {direction: a.direction} : {})})));
        for (const deal of (await repo.crmList('deal')).filter(d => d.customerId === id)) {
          const vehicle = await repo.get(deal.vehicleId); const label = vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : 'vehicle';
          timeline.push(...deal.history.map(h => ({timestamp: h.timestamp, kind: 'deal' as const, summary: `Deal ${h.status}: ${label}`, dealId: deal.id})));
        }
        timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return response(200, {data: {...customer, communications, timeline}});
      }
      const lead = await repo.crmGet('lead', id); if (!lead) throw missing(); return response(200, {data: await leadView(repo, lead, now)});
    }
    if (collection === 'customers') { onlyKeys(query, ['search']); const search = text(query.search ?? '', 'Search', 200, true).toLowerCase(); return response(200, {data: (await repo.crmList('customer')).filter(c => [c.name, c.email, c.phone].join(' ').toLowerCase().includes(search))}); }
    onlyKeys(query, ['search', 'stage', 'assignee', 'limit', 'offset']);
    const stageFilter = query.stage ? stage(query.stage) : undefined;
    if (query.assignee && query.assignee !== 'unassigned') requireId(query.assignee);
    const search = text(query.search ?? '', 'Search', 200, true).toLowerCase();
    const limit = pageNumber(query.limit, 100, 1, 500), offset = pageNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const {leads, customers, total} = await repo.leadListPage({search, stage: stageFilter,
      assignee: query.assignee === 'unassigned' ? null : query.assignee || undefined, limit, offset});
    return response(200, {data: leads.map((lead, i) => ({...lead, customer: customers[i], overdue: lead.followUps.some(t => isOverdue(t, now))})), total, limit, offset});
  }
  onlyKeys(query, []);
  if (!['POST', 'PUT'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const b = parseBody(request.body);
  if (method === 'POST' && !id) {
    if (collection === 'leads') return response(201, {data: await createLead(repo, principal, b, now, request.agent)});
    const input = customerInput(b); const duplicateCustomerIds = await duplicates(repo, input);
    const customer: Customer = {...ctx.base(), kind: 'customer', ...input}; await repo.crmWrite([ctx.write(customer)]);
    return response(201, {data: {customer, duplicateCustomerIds}});
  }
  if (!id) throw missing();
  if (collection === 'customers' && method === 'PUT' && !action) {
    const old = await repo.crmGet('customer', id); if (!old) throw missing(); const expected = version(b.version); if (old.version !== expected) throw conflict();
    const {version: _, ...fields} = b; const customer = {...old, ...customerInput(fields), version: expected + 1, updatedAt: ctx.date};
    await repo.crmWrite([ctx.write(customer, expected)]); return response(200, {data: customer});
  }
  if (collection !== 'leads') throw missing();
  const lead = await repo.crmGet('lead', id); if (!lead) throw missing(); const expected = version(b.version); if (lead.version !== expected) throw conflict();
  if (!action && method === 'PUT') {
    onlyKeys(b, ['version', 'stage', 'assigneeId', 'vehicleId']);
    const next = stage(b.stage); const refs = await references(repo, b.vehicleId, b.assigneeId);
    if (next !== lead.stage) lead.activities.push(ctx.activity('stage', `${lead.stage} → ${next}`));
    if (refs.assigneeId !== lead.assigneeId) lead.activities.push(ctx.activity('assignment', refs.assigneeId ? `Assigned to ${refs.assigneeId}` : 'Unassigned'));
    Object.assign(lead, refs, {stage: next});
  } else if (action === 'follow-ups' && method === 'POST' && !taskId) {
    onlyKeys(b, ['version', 'type', 'dueAt']); const task = {id: randomUUID(), type: communicationType(b.type), dueAt: timestamp(b.dueAt, 'Due date'), done: false};
    lead.followUps.push(task); lead.activities.push(ctx.activity('follow-up', `Scheduled ${task.type}: ${task.dueAt}`));
  } else if (action === 'follow-ups' && method === 'PUT' && taskId) {
    onlyKeys(b, ['version', 'done', 'dueAt', 'dismissed']);
    if (['done', 'dueAt', 'dismissed'].filter(key => key in b).length !== 1) throw invalid('Supply exactly one follow-up action.');
    const task = lead.followUps.find(t => t.id === requireId(taskId)); if (!task) throw missing();
    if ('done' in b) {
      if (typeof b.done !== 'boolean') throw invalid('Done must be a boolean.');
      if (task.done !== b.done) lead.activities.push(ctx.activity('follow-up', `${b.done ? 'Completed' : 'Reopened'} ${task.type}: ${task.dueAt}`)); task.done = b.done;
    } else if ('dueAt' in b) {
      const dueAt = timestamp(b.dueAt, 'Due date');
      lead.activities.push(ctx.activity('follow-up', `Snoozed ${task.type}: ${task.dueAt} → ${dueAt}`)); task.dueAt = dueAt;
    } else {
      if (typeof b.dismissed !== 'boolean') throw invalid('Dismissed must be a boolean.');
      if (!!task.dismissed !== b.dismissed) lead.activities.push(ctx.activity('follow-up', `${b.dismissed ? 'Dismissed' : 'Restored'} ${task.type}: ${task.dueAt}`)); task.dismissed = b.dismissed;
    }
  } else if (action === 'communications' && method === 'POST' && !taskId) {
    onlyKeys(b, ['version', 'type', 'direction', 'summary', 'timestamp']);
    lead.activities.push({...ctx.activity('communication', text(b.summary, 'Summary', 2000)), type: communicationType(b.type), direction: choice(b.direction, ['inbound', 'outbound'] as const, 'direction'), timestamp: timestamp(b.timestamp, 'Communication timestamp')});
  } else throw missing();
  if (lead.activities.length > 400 || lead.followUps.length > 200 || Buffer.byteLength(JSON.stringify(lead)) > 250000) throw invalid('This lead has reached its activity limit.');
  lead.version++; lead.updatedAt = ctx.date; await repo.crmWrite([ctx.write(lead, expected)]);
  return response(200, {data: await leadView(repo, lead, now)});
}
