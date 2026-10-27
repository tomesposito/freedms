import { technicianMetrics, departmentReport } from './reports-p3.js';
import { randomUUID } from 'node:crypto';
import { inventoryTurn, reportDatasets, pencilMath, type CustomReport, type FiReport, type Principal, type ReportDefinition, type ReportDataset, type SavedReport, type TurnReport } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { csvResponse, parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { invalid, onlyKeys, text, version } from './validation.js';
import { dateRange, inventoryReport, salesReport, soldDate, toCsv } from './reports.js';
const dollars = (n: number) => (n / 100).toFixed(2);
const inRange = (date: string, range: ReturnType<typeof dateRange>) => (!range.from || date >= range.from) && (!range.to || date <= range.to);
async function soldRecords(repo: TenantRepository, range: ReturnType<typeof dateRange>) {
  const [deals, vehicles, customers] = await Promise.all([repo.crmList('deal'), repo.list({}), repo.crmList('customer')]);
  return deals.filter(d => d.status === 'sold' && inRange(soldDate(d), range)).map(deal => {
    const vehicle = vehicles.find(v => v.id === deal.vehicleId), customer = customers.find(c => c.id === deal.customerId), pencil = deal.pencils.find(p => p.id === deal.workingPencilId);
    if (!vehicle || !customer || !pencil) throw missing();
    return {deal, vehicle, customer, pencil, date: soldDate(deal)};
  }).sort((a, b) => a.date.localeCompare(b.date) || a.deal.id.localeCompare(b.deal.id));
}
export async function turnReport(repo: TenantRepository, range: ReturnType<typeof dateRange>) {
  const [sold, vehicles] = await Promise.all([soldRecords(repo, range), repo.list({})]);
  return inventoryTurn(sold.map(s => ({soldDate: s.date, dateStocked: s.vehicle.dateStocked})), vehicles.filter(v => v.status !== 'sold').length, range);
}
export function turnCsv(data: TurnReport) {
  return toCsv([['from', 'to', 'soldInPeriod', 'averageDaysToSale', 'periodDays', 'turnRate'], [data.from ?? '', data.to ?? '', ...[data.soldInPeriod, data.averageDaysToSale, data.periodDays, data.turnRate].map(String)]]);
}
export async function fiReport(repo: TenantRepository, range: ReturnType<typeof dateRange>): Promise<FiReport> {
  const sold = await soldRecords(repo, range);
  const data: FiReport = {...range, dealsSold: sold.length, dealsWithFi: 0, penetrationBps: 0, totalFiGross: 0, totalFiRetail: 0, totalFiCost: 0, fiGrossPerDeal: 0, perProduct: []};
  const products = new Map<string, FiReport['perProduct'][number]>();
  for (const {deal, vehicle, pencil} of sold) {
    const selections = (pencil.fiSelections ?? []).filter(s => s.status === 'accepted');
    if (selections.length) data.dealsWithFi++;
    const math = pencilMath(pencil, deal.trade, deal, vehicle, pencil.type ?? deal.type);
    data.totalFiGross += math.fiGross; data.totalFiRetail += math.fiRetailTotal; data.totalFiCost += math.fiCostTotal;
    const seen = new Set<string>();
    for (const s of selections) {
      const p = products.get(s.productId) ?? {productId: s.productId, name: s.name, category: s.category, deals: 0, units: 0, retail: 0, cost: 0, gross: 0};
      p.units++; if (!seen.has(s.productId)) p.deals++; seen.add(s.productId);
      p.retail += s.retailPrice; p.cost += s.cost; p.gross += s.retailPrice - s.cost; products.set(s.productId, p);
    }
  }
  data.perProduct = [...products.values()].sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId));
  data.penetrationBps = data.dealsSold ? Math.round(data.dealsWithFi * 10000 / data.dealsSold) : 0;
  data.fiGrossPerDeal = data.dealsSold ? Math.round(data.totalFiGross / data.dealsSold) : 0;
  return data;
}
export function fiCsv(data: FiReport) {
  return toCsv([['productId', 'name', 'category', 'deals', 'units', 'retail', 'cost', 'gross'], ...data.perProduct.map(p => [p.productId, p.name, p.category, String(p.deals), String(p.units), dollars(p.retail), dollars(p.cost), dollars(p.gross)])]);
}
export function reportDefinition(b: Record<string, unknown>): ReportDefinition {
  if (typeof b.dataset !== 'string' || !Object.hasOwn(reportDatasets, b.dataset)) throw invalid('Unknown dataset.');
  const dataset = b.dataset as ReportDataset, spec = reportDatasets[dataset];
  if (!Array.isArray(b.columns) || !b.columns.length || b.columns.some(c => typeof c !== 'string' || ![...spec.columns.map(c => c.key), 'count'].includes(c)) || new Set(b.columns).size !== b.columns.length) throw invalid('Invalid columns.');
  if (b.groupBy !== undefined && (typeof b.groupBy !== 'string' || !(spec.groupings as readonly string[]).includes(b.groupBy))) throw invalid('Invalid grouping.');
  if ([b.from, b.to].some(v => v !== undefined && typeof v !== 'string')) throw invalid('Invalid dates.');
  dateRange({from: b.from as string | undefined, to: b.to as string | undefined});
  return {dataset, columns: b.columns as string[], ...(b.from !== undefined ? {from: b.from as string} : {}), ...(b.to !== undefined ? {to: b.to as string} : {}), ...(b.groupBy !== undefined ? {groupBy: b.groupBy as string} : {})};
}
export async function customReport(repo: TenantRepository, now: Date, definition: ReportDefinition): Promise<CustomReport> {
  const {dataset, groupBy} = definition, range = dateRange({from: definition.from, to: definition.to});
  let rows: Record<string, string | number>[];
  if (dataset === 'technicians') rows = (await technicianMetrics(repo,range)).rows.map(r => ({technicianId:r.technicianId, technician:r.technician, soldHours:r.soldHoursHundredths/100, flaggedHours:r.flaggedHoursHundredths === null ? '—' : String(r.flaggedHoursHundredths/100), efficiencyPercent:r.efficiencyPercent === null ? '—' : String(r.efficiencyPercent), missingFlaggedLines:r.missingFlaggedLines, roCount:r.roCount}));
  else if (dataset === 'departments') rows = (await departmentReport(repo,range)).departments.filter(d => d.rows.length).map(({department,income,expenses,grossProfit}) => ({department,income,expenses,grossProfit}));
  else if (dataset === 'locations') rows = (await departmentReport(repo,range)).locations;
  else if (dataset === 'inventory') rows = (await inventoryReport(repo, now)).rows.filter(r => inRange(r.dateStocked, range));
  else if (dataset === 'sales') rows = (await salesReport(repo, range)).rows;
  else if (dataset === 'leads') {
    const [leads, customers] = await Promise.all([repo.crmList('lead'), repo.crmList('customer')]);
    rows = leads.filter(l => inRange(l.createdAt.slice(0, 10), range)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(l => {
      const customer = customers.find(c => c.id === l.customerId); if (!customer) throw missing();
      return {leadId: l.id, customer: customer.name, source: l.source, stage: l.stage, vehicleDescription: l.vehicleDescription, createdAt: l.createdAt.slice(0, 10)};
    });
  } else rows = (await soldRecords(repo, range)).flatMap(({deal, customer, pencil, date}) => (pencil.fiSelections ?? []).filter(s => s.status === 'accepted').map(s => ({soldDate: date, dealId: deal.id, buyer: customer.name, productId: s.productId, product: s.name, category: s.category, retail: s.retailPrice, cost: s.cost, gross: s.retailPrice - s.cost})));
  const specs = [...reportDatasets[dataset].columns, {key: 'count', label: 'count', type: 'number' as const}];
  rows = rows.map(r => ({...r, count: 1}));
  // Group key retained; numeric fields summed; other text blank. Count counts source rows.
  if (groupBy) {
    const groups = new Map<string, Record<string, string | number>>();
    for (const row of rows) {
      const key = String(row[groupBy]), group = groups.get(key) ?? Object.fromEntries(specs.map(c => [c.key, c.type === 'text' ? '' : 0]));
      group[groupBy] = key;
      for (const c of specs) if (c.type !== 'text') group[c.key] = Number(group[c.key]) + Number(row[c.key]);
      groups.set(key, group);
    }
    rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
  }
  const selected = definition.columns.map(key => specs.find(c => c.key === key)!);
  return {dataset, columns: selected.map(({key, label}) => ({key, label})), rows: rows.map(r => selected.map(c => c.type === 'money' ? dollars(Number(r[c.key])) : String(r[c.key])))};
}
export const customCsv = (data: CustomReport) => toCsv([data.columns.map(c => c.label), ...data.rows]);
export async function reportsP2(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const saved = /^\/reports\/saved(?:\/([^/]+))?$/.exec(path);
  if (saved) {
    const id = saved[1] ? requireId(saved[1]) : undefined;
    if (!(id ? ['GET', 'PUT'] : ['GET', 'POST']).includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    onlyKeys(request.query ?? {}, []);
    const old = id ? await repo.crmGet('saved-report', id) : undefined;
    if (id && !old) throw missing();
    if (method === 'GET') return response(200, {data: id ? old : (await repo.crmList('saved-report')).sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))});
    requireWrite(principal, method);
    const b = parseBody(request.body); onlyKeys(b, ['name', 'dataset', 'columns', 'from', 'to', 'groupBy', ...(id ? ['version'] : [])]);
    const definition = reportDefinition(b), expected = id ? version(b.version) : 0;
    if (old && old.version !== expected) throw conflict();
    const date = now.toISOString();
    const record: SavedReport = {id: id ?? randomUUID(), tenantId: principal.tenantId, kind: 'saved-report', name: text(b.name, 'Name', 120), definition, version: expected + 1, createdAt: old?.createdAt ?? date, updatedAt: date};
    await repo.crmWrite([{record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type: id ? 'saved-report.updated' : 'saved-report.created', occurredAt: date, deliveryStatus: 'pending'}}]);
    return response(id ? 200 : 201, {data: record});
  }
  const match = /^\/reports\/(turn|fi|custom)(\.csv)?$/.exec(path); if (!match) throw missing();
  if (method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const name = match[1], csv = !!match[2];
  if (name === 'custom') {
    const q = request.query ?? {}; onlyKeys(q, ['dataset', 'columns', 'from', 'to', 'groupBy']);
    const data = await customReport(repo, now, reportDefinition({...q, columns: q.columns?.split(',')}));
    return csv ? csvResponse('custom.csv', customCsv(data)) : response(200, {data});
  }
  const range = dateRange(request.query);
  if (name === 'turn') { const data = await turnReport(repo, range); return csv ? csvResponse('turn.csv', turnCsv(data)) : response(200, {data}); }
  const data = await fiReport(repo, range); return csv ? csvResponse('fi.csv', fiCsv(data)) : response(200, {data});
}
