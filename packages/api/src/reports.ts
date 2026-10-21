import type { Track } from './analytics.js';
import { agingBuckets, leadSources, leadStages, pencilMath, type Deal, type InventoryReport, type LeadReport, type SalesReport, type Vehicle } from '@freedms/shared';
import { ApiError, missing } from './errors.js';
import { csvResponse, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { invalid, onlyKeys, view } from './validation.js';

export function toCsv(rows: string[][]): string {
  return rows.map(row => row.map(cell => /[,"\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(',')).join('\r\n') + '\r\n';
}
const dollars = (cents: number) => (cents / 100).toFixed(2);
const description = (v: Vehicle) => `${v.year} ${v.make} ${v.model}`;
export function soldDate(deal: Deal): string {
  const timestamp = [...deal.history].reverse().find(h => h.status === 'sold')?.timestamp ?? deal.updatedAt;
  return new Date(timestamp).toISOString().slice(0, 10);
}
export function dateRange(query: ApiRequest['query'] = {}) {
  onlyKeys(query, ['from', 'to']);
  for (const value of [query.from, query.to]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw invalid('Dates must be real calendar dates in YYYY-MM-DD format.');
  }
  if (query.from && query.to && query.from > query.to) throw invalid('From must be on or before to.');
  return {from: query.from ?? null, to: query.to ?? null};
}
export async function inventoryReport(repo: TenantRepository, now: Date): Promise<InventoryReport> {
  const rows = (await repo.list({})).filter(v => v.status !== 'sold').map(vehicle => {
    const v = view(vehicle, now);
    const bucket = agingBuckets[v.agingDays <= 30 ? 0 : v.agingDays <= 60 ? 1 : v.agingDays <= 90 ? 2 : 3];
    return {stockNumber: v.stockNumber, vehicle: [description(v), v.trim].filter(Boolean).join(' '), status: v.status, dateStocked: v.dateStocked, agingDays: v.agingDays, bucket, listPrice: v.listPrice, cost: v.cost, reconTotal: v.reconTotal, totalCost: v.cost + v.reconTotal};
  }).sort((a, b) => b.agingDays - a.agingDays || a.stockNumber.localeCompare(b.stockNumber));
  return {rows, buckets: agingBuckets.map(bucket => ({bucket, count: rows.filter(r => r.bucket === bucket).length, totalCost: rows.filter(r => r.bucket === bucket).reduce((sum, r) => sum + r.totalCost, 0)})),
    totals: {count: rows.length, totalCost: rows.reduce((sum, r) => sum + r.totalCost, 0), totalListPrice: rows.reduce((sum, r) => sum + r.listPrice, 0)}};
}
export async function salesReport(repo: TenantRepository, range: ReturnType<typeof dateRange>): Promise<SalesReport> {
  const [deals, vehicles, customers] = await Promise.all([repo.crmList('deal'), repo.list({}), repo.crmList('customer')]);
  const vehicleMap = new Map(vehicles.map(v => [v.id, v])), customerMap = new Map(customers.map(c => [c.id, c]));
  const rows: SalesReport['rows'] = [];
  for (const deal of deals.filter(d => d.status === 'sold')) {
    const date = soldDate(deal);
    if ((range.from && date < range.from) || (range.to && date > range.to)) continue;
    const vehicle = vehicleMap.get(deal.vehicleId), customer = customerMap.get(deal.customerId), pencil = deal.pencils.find(p => p.id === deal.workingPencilId);
    if (!vehicle || !customer || !pencil) throw missing();
    const numbers = pencilMath(pencil, deal.trade, deal, vehicle, deal.type);
    rows.push({soldDate: date, dealId: deal.id, buyer: customer.name, vehicle: `${description(vehicle)} (${vehicle.stockNumber})`, price: pencil.price, frontGross: numbers.frontGross,
      cost: vehicle.cost, recon: vehicle.reconCosts.reduce((sum, r) => sum + r.amount, 0), tax: numbers.salesTax, fees: deal.docFee});
  }
  rows.sort((a, b) => a.soldDate.localeCompare(b.soldDate) || a.dealId.localeCompare(b.dealId));
  const totalFrontGross = rows.reduce((sum, r) => sum + r.frontGross, 0);
  return {...range, rows, totals: {dealsSold: rows.length, totalFrontGross, averageGross: rows.length ? Math.round(totalFrontGross / rows.length) : 0}};
}
export async function leadReport(repo: TenantRepository): Promise<LeadReport> {
  const leads = await repo.crmList('lead');
  return {byStage: leadStages.map(stage => ({stage, count: leads.filter(l => l.stage === stage).length})), bySource: leadSources.map(source => ({source, count: leads.filter(l => l.source === source).length})), total: leads.length};
}
export function inventoryCsv(data: InventoryReport): string {
  return toCsv([['stockNumber', 'vehicle', 'status', 'dateStocked', 'agingDays', 'bucket', 'listPrice', 'cost', 'reconTotal', 'totalCost'], ...data.rows.map(r => [r.stockNumber, r.vehicle, r.status, r.dateStocked, String(r.agingDays), r.bucket, ...[r.listPrice, r.cost, r.reconTotal, r.totalCost].map(dollars)])]);
}
export function salesCsv(data: SalesReport, accounting = false): string {
  return toCsv(accounting ? [['date', 'deal', 'buyer', 'vehicle', 'price', 'cost', 'recon', 'tax', 'fees', 'gross'], ...data.rows.map(r => [r.soldDate, r.dealId, r.buyer, r.vehicle, ...[r.price, r.cost, r.recon, r.tax, r.fees, r.frontGross].map(dollars)])]
    : [['soldDate', 'dealId', 'buyer', 'vehicle', 'price', 'frontGross'], ...data.rows.map(r => [r.soldDate, r.dealId, r.buyer, r.vehicle, dollars(r.price), dollars(r.frontGross)])]);
}
export function leadCsv(data: LeadReport): string {
  return toCsv([['dimension', 'value', 'count'], ...data.byStage.map(r => ['stage', r.stage, String(r.count)]), ...data.bySource.map(r => ['source', r.source, String(r.count)]), ['total', 'all', String(data.total)]]);
}
export async function reports(request: ApiRequest, repo: TenantRepository, now: Date, track: Track = async () => {}) {
  const match = /^\/reports\/(inventory|sales|leads|accounting)(\.csv)?$/.exec(request.path.replace(/\/$/, ''));
  if (!match || (match[1] === 'accounting' && !match[2])) throw missing();
  if (request.method.toUpperCase() !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const name = match[1], csv = Boolean(match[2]);
  const exported = async (filename: string, body: string) => {
    const result = csvResponse(filename, body);
    try { await track({event: 'report_exported', report: name === 'inventory' ? 'aging' : name === 'leads' ? 'pipeline' : name as 'sales' | 'accounting'}); } catch { /* Export remains usable. */ }
    return result;
  };
  if (name === 'sales' || name === 'accounting') {
    const data = await salesReport(repo, dateRange(request.query));
    return csv ? await exported(`${name}.csv`, salesCsv(data, name === 'accounting')) : response(200, {data});
  }
  onlyKeys(request.query ?? {}, []);
  if (name === 'inventory') { const data = await inventoryReport(repo, now); return csv ? await exported('inventory.csv', inventoryCsv(data)) : response(200, {data}); }
  const data = await leadReport(repo); return csv ? await exported('lead-pipeline.csv', leadCsv(data)) : response(200, {data});
}
