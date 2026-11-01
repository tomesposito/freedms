import { randomUUID } from 'node:crypto';
import { jacketChecklist, type BehavioralEvent, type Deal, type DealDocument, type Funnel, type FunnelStage, type OutboxEvent, type Principal } from '@freedms/shared';
import { assertScope, type TenantRepository } from './repository.js';
import { object, onlyKeys, invalid } from './validation.js';
import { choice } from './crm-validation.js';
import { ApiError, missing } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { meterQuickEntryOutcome } from './quick-entry.js';

export function behavioralEvent(value: unknown): BehavioralEvent {
  const b = object(value);
  switch (b.event) {
    case 'quick_entry_used':
      onlyKeys(b, ['event', 'surface', 'input', 'outcome']);
      return {event: b.event, surface: choice(b.surface, ['inventory', 'lead'] as const, 'surface'), input: choice(b.input, ['text', 'photo'] as const, 'input'), outcome: choice(b.outcome, ['saved', 'edited', 'discarded'] as const, 'outcome')};
    case 'report_exported':
      onlyKeys(b, ['event', 'report']);
      return {event: b.event, report: choice(b.report, ['aging', 'sales', 'pipeline', 'accounting'] as const, 'report')};
    case 'feed_generated': case 'pencil_grid_viewed': case 'jacket_checklist_completed':
      onlyKeys(b, ['event']); return {event: b.event};
    default: throw invalid('Unknown analytics event.');
  }
}
export type AnalyticsVendor = (tenantId: string, data: BehavioralEvent) => Promise<void>;
export function analyticsFromEnv(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): AnalyticsVendor {
  const key = env.ANALYTICS_VENDOR_KEY?.trim();
  if (env.ANALYTICS_ENABLED !== '1' || !key) return async () => {};
  return async (tenantId, data) => {
    const {event, ...properties} = behavioralEvent(data);
    // One US PostHog project, dealership identity only. No SDK/autocapture/person identification.
    await request('https://us.i.posthog.com/i/v0/e/', {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000), headers: {'content-type': 'application/json'},
      body: JSON.stringify({api_key: key, distinct_id: tenantId, event, properties})});
  };
}
export type Track = (data: BehavioralEvent) => Promise<void>;
/** Validate even internal callers. Keep our log first; vendor failures never escape. */
export async function track(repo: TenantRepository, principal: Principal, now: Date, input: BehavioralEvent, vendor: AnalyticsVendor): Promise<void> {
  const data = behavioralEvent(input);
  await repo.appendAnalytics({id: randomUUID(), tenantId: principal.tenantId, occurredAt: now.toISOString(), data});
  if (data.event === 'quick_entry_used') await meterQuickEntryOutcome(repo, principal, now, data);
  try { await vendor(principal.tenantId, data); } catch { /* No payloads or credentials in logs. */ }
}
const stage = (times: string[]): FunnelStage => ({reached: times.length > 0, firstAt: times.sort()[0] ?? null, count: times.length});
/** Existing outbox is metadata-only. Resolve state from owned records/history, never behavioral claims.
 * Documents currently have create-only commands. A future edit/delete command must retain document
 * type history before historical completeness can be reconstructed for those commands.
 */
export function projectFunnel(tenantId: string, events: OutboxEvent[], deals: Deal[], documents: DealDocument[], cohortStart: string | null = null): Funnel {
  assertScope(tenantId, ...events, ...deals, ...documents);
  const byType = (type: OutboxEvent['type']) => events.filter(e => e.type === type);
  const created = (type: OutboxEvent['type']) => stage([...new Map(byType(type).map(e => [e.aggregateId, e.occurredAt])).values()]);
  const sold: string[] = [], complete: string[] = [];
  for (const deal of deals) {
    const transitions = deal.history.filter(h => events.some(e => e.aggregateId === deal.id && e.type === 'deal.updated' && e.occurredAt === h.timestamp));
    const sale = transitions.find(h => h.status === 'sold' && events.some(e => e.type === 'vehicle.updated' && e.aggregateId === deal.vehicleId && e.occurredAt === h.timestamp));
    if (sale) sold.push(sale.timestamp);
    const eligible = transitions.filter(h => h.status === 'approved' || h.status === 'sold').map(h => h.timestamp).sort()[0];
    if (!eligible) continue;
    const attached = documents.filter(d => d.dealId === deal.id).flatMap(d => {
      const time = events.filter(e => e.aggregateId === d.id && e.type.startsWith('document.')).map(e => e.occurredAt).sort()[0];
      return time ? [{type: d.type, time}] : [];
    }).sort((a, b) => a.time.localeCompare(b.time));
    const prefix: typeof attached = [];
    for (const doc of attached) {
      prefix.push(doc);
      if (jacketChecklist(prefix).every(c => c.present)) {
        const completedAt = [eligible, doc.time].sort()[1];
        const status = deal.history.filter(h => h.timestamp <= completedAt).at(-1)?.status;
        if (status === 'approved' || status === 'sold') complete.push(completedAt);
        break;
      }
    }
  }
  const firstVehicleAt = stage(byType('vehicle.created').map(e => e.occurredAt)).firstAt;
  const firstLeadOrDealAt = stage([...byType('lead.created'), ...byType('deal.created')].map(e => e.occurredAt)).firstAt;
  const inside = (time: string | null) => {
    if (!cohortStart || !time) return false;
    const elapsed = Date.parse(time) - Date.parse(cohortStart);
    return elapsed >= 0 && elapsed <= 7 * 86400000;
  };
  return {activation: {cohortStart, firstVehicleAt, firstLeadOrDealAt, activated: inside(firstVehicleAt) && inside(firstLeadOrDealAt)}, tenantProvisioned: created('tenant.created'), vehicleStocked: created('vehicle.created'), leadCreated: created('lead.created'), pencilCreated: created('deal.created'), sold: stage(sold), jacketComplete: stage(complete)};
}
export async function funnel(repo: TenantRepository, tenantId: string): Promise<Funnel> {
  const [events, deals, documents, tenant] = await Promise.all([repo.events(), repo.crmList('deal'), repo.crmList('document'), repo.tenant()]);
  return projectFunnel(tenantId, events, deals, documents, tenant?.inviteAcceptedAt);
}
export async function analytics(request: ApiRequest, principal: Principal, repo: TenantRepository, record: Track) {
  onlyKeys(request.query ?? {}, []);
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  if (path === '/analytics/funnel') {
    if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return response(200, {data: await funnel(repo, principal.tenantId)});
  }
  if (path !== '/analytics/events') throw missing();
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  await record(behavioralEvent(parseBody(request.body)));
  return response(201, {data: {accepted: true}});
}
