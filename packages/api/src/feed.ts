import { track } from './analytics.js';
import { randomUUID } from 'node:crypto';
import { defaultFeedOptions, vehicleStatuses, type FeedOptions, type FeedRun, type OutboxEvent, type Principal, type Vehicle } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, missing } from './errors.js';
import { csvResponse, parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { toCsv } from './reports.js';
import { invalid, onlyKeys } from './validation.js';
export const FEED_BODY_LIMIT = 4096;
export function feedOptions(b: Record<string, unknown>): FeedOptions {
  onlyKeys(b, ['formats', 'includedStatuses', 'requirePrice', 'schedule']);
  const choices = <T extends string>(value: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(value) || !value.length || value.length > allowed.length || new Set(value).size !== value.length || value.some(v => !allowed.includes(v))) throw invalid('Select distinct supported feed formats/statuses.');
    return value;
  };
  if (typeof b.requirePrice !== 'boolean' || typeof b.schedule !== 'string' || !['manual', 'daily', 'weekly'].includes(b.schedule)) throw invalid('Invalid price requirement or schedule.');
  return {formats: choices(b.formats, ['csv', 'json']), includedStatuses: choices(b.includedStatuses, vehicleStatuses), requirePrice: b.requirePrice, schedule: b.schedule as FeedOptions['schedule']};
}
export function buildFeed(vehicles: Vehicle[], config: FeedOptions): Pick<FeedRun, 'rows' | 'included' | 'excluded' | 'includedCount' | 'excludedCount'> {
  const rows: FeedRun['rows'] = [], included: FeedRun['included'] = [], excluded: FeedRun['excluded'] = [];
  for (const v of [...vehicles].sort((a, b) => a.stockNumber.localeCompare(b.stockNumber) || a.id.localeCompare(b.id))) {
    const identity = {vehicleId: v.id, stockNumber: v.stockNumber};
    if (!config.includedStatuses.includes(v.status)) { excluded.push({...identity, reason: v.status === 'sold' ? 'sold' : 'status_not_included', message: `Status not included: ${v.status}.`}); continue; }
    if (config.requirePrice && v.listPrice <= 0) { excluded.push({...identity, reason: 'missing_price', message: 'Missing price.'}); continue; }
    included.push(identity);
    rows.push({stockNumber: v.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim, status: v.status, listPriceCents: v.listPrice, dateStocked: v.dateStocked, location: v.location});
  }
  return {rows, included, excluded, includedCount: included.length, excludedCount: excluded.length};
}
export function feedCsv(run: Pick<FeedRun, 'rows'>): string {
  return toCsv([['stockNumber', 'vin', 'year', 'make', 'model', 'trim', 'status', 'listPrice', 'dateStocked', 'location'], ...run.rows.map(r => [r.stockNumber, r.vin, String(r.year), r.make, r.model, r.trim, r.status, (r.listPriceCents / 100).toFixed(2), r.dateStocked, r.location])]);
}
export async function feeds(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const download = /^\/feeds\/runs\/([^/]+)\.(csv|json)$/.exec(path);
  if (!download && !['/feeds/config', '/feeds/generate', '/feeds/runs'].includes(path)) throw missing();
  if (!(path === '/feeds/config' ? ['GET', 'PUT'] : path === '/feeds/generate' ? ['POST'] : ['GET']).includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  const local = {generation: 'on-demand', transmission: 'none', schedulerActive: false} as const;
  if (download) {
    const run = await repo.feedRun(download[1]);
    if (!run || !run.formats.includes(download[2] as 'csv' | 'json')) throw missing();
    const result = csvResponse(`feed-${run.id}.${download[2]}`, download[2] === 'csv' ? feedCsv(run) : JSON.stringify(run.rows));
    if (download[2] === 'json') result.headers['content-type'] = 'application/json';
    return result;
  }
  if (path === '/feeds/runs') return response(200, {data: (await repo.feedRuns()).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))});
  const config = await repo.feedConfig();
  if (method === 'GET') return response(200, {data: {config: config ?? null, defaults: defaultFeedOptions, local}});
  requireWrite(principal, method);
  const body = parseBody(request.body, FEED_BODY_LIMIT), date = now.toISOString();
  const event = (type: OutboxEvent['type'], id: string, version = 1): OutboxEvent => ({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, type, aggregateId: id, aggregateVersion: version, occurredAt: date, deliveryStatus: 'pending'});
  if (path === '/feeds/config') {
    const saved = {...feedOptions(body), id: 'feed-config', tenantId: principal.tenantId, version: (config?.version ?? 0) + 1, createdAt: config?.createdAt ?? date, updatedAt: date};
    await repo.saveFeedConfig(saved, config?.version ?? 0, event('feed.configured', saved.id, saved.version));
    return response(200, {data: {config: saved, local}});
  }
  onlyKeys(body, []);
  const options = config ?? defaultFeedOptions;
  const run: FeedRun = {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, createdAt: date, formats: [...options.formats], ...buildFeed(await repo.list({}), options)};
  // Keep the immutable snapshot safely below Dynamo's 400 KB item limit in both adapters.
  if (Buffer.byteLength(JSON.stringify(run)) > 300000) throw invalid('Feed snapshot exceeds the local 300 KB run limit. Narrow the included statuses or reduce inventory before generating.');
  await repo.appendFeedRun(run, event('feed.generated', run.id));
  // Local behavioral log only: no vendor/network sends for listing generation.
  try { await track(repo, principal, now, {event: 'feed_generated'}, async () => {}); } catch { /* Saved downloads remain usable. */ }
  return response(201, {data: run});
}
