import { stockedCost } from './fixed-ops.js';
import { repairOrderTotals, type FixedOpsReport } from '@freedms/shared';
import type { Track } from './analytics.js';
import { agingBuckets, pencilMath, type InventoryReport, type LeadReport, type SalesReport, type Vehicle } from '@freedms/shared';
import { ApiError, missing } from './errors.js';
import { csvResponse, response, type ApiRequest } from './handler.js';
import { soldDate, type TenantRepository } from './repository.js';
export { soldDate } from './repository.js';
import { invalid, onlyKeys, view } from './validation.js';

export function toCsv(rows: string[][]): string {
  return rows.map(row => row.map(cell => /[,"\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(',')).join('\r\n') + '\r\n';
}
const dollars = (cents: number) => (cents / 100).toFixed(2);
const description = (v: Vehicle) => `${v.year} ${v.make} ${v.model}`;
export function dateRange(query: ApiRequest['query'] = {}) {
  onlyKeys(query, ['from', 'to']);
  for (const value of [query.from, query.to]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw invalid('Dates must be real calendar dates in YYYY-MM-DD format.');
  }
  if (query.from && query.to && query.from > query.to) throw invalid('From must be on or before to.');
  return {from: query.from ?? null, to: query.to ?? null};
}
export async function inventoryReport(repo: TenantRepository, now: Date): Promise<InventoryReport> {
  const rows = (await repo.inventoryReportRows()).map(vehicle => {
    const v = view(vehicle, now);
    const bucket = agingBuckets[v.agingDays <= 30 ? 0 : v.agingDays <= 60 ? 1 : v.agingDays <= 90 ? 2 : 3];
    return {stockNumber: v.stockNumber, vehicle: [description(v), v.trim].filter(Boolean).join(' '), status: v.status, dateStocked: v.dateStocked, agingDays: v.agingDays, bucket, listPrice: v.listPrice, cost: v.cost, reconTotal: v.reconTotal, totalCost: v.cost + v.reconTotal};
  }).sort((a, b) => b.agingDays - a.agingDays || a.stockNumber.localeCompare(b.stockNumber));
  return {rows, buckets: agingBuckets.map(bucket => ({bucket, count: rows.filter(r => r.bucket === bucket).length, totalCost: rows.filter(r => r.bucket === bucket).reduce((sum, r) => sum + r.totalCost, 0)})),
    totals: {count: rows.length, totalCost: rows.reduce((sum, r) => sum + r.totalCost, 0), totalListPrice: rows.reduce((sum, r) => sum + r.listPrice, 0)}};
}
export async function salesReport(repo: TenantRepository, range: ReturnType<typeof dateRange>): Promise<SalesReport> {
  const {deals, vehicles, customers} = await repo.salesReportRows(range);
  const vehicleMap = new Map(vehicles.map(v => [v.id, v])), customerMap = new Map(customers.map(c => [c.id, c]));
  const rows: SalesReport['rows'] = [];
  for (const deal of deals) {
    const date = soldDate(deal);
    const vehicle = vehicleMap.get(deal.vehicleId), customer = customerMap.get(deal.customerId), pencil = deal.pencils.find(p => p.id === deal.workingPencilId);
    if (!vehicle || !customer || !pencil) throw missing();
    const numbers = pencilMath(pencil, deal.trade, deal, vehicle, pencil.type ?? deal.type);
    rows.push({soldDate: date, dealId: deal.id, buyer: customer.name, vehicle: `${description(vehicle)} (${vehicle.stockNumber})`, price: pencil.price, frontGross: numbers.frontGross, fiGross: numbers.fiGross, fiRetail: numbers.fiRetailTotal,
      cost: vehicle.cost, recon: vehicle.reconCosts.reduce((sum, r) => sum + r.amount, 0), tax: numbers.salesTax, fees: deal.docFee});
  }
  rows.sort((a, b) => a.soldDate.localeCompare(b.soldDate) || a.dealId.localeCompare(b.dealId));
  const totalFrontGross = rows.reduce((sum, r) => sum + r.frontGross, 0);
  return {...range, rows, totals: {dealsSold: rows.length, totalFrontGross, totalFiGross: rows.reduce((sum, r) => sum + r.fiGross, 0), averageGross: rows.length ? Math.round(totalFrontGross / rows.length) : 0}};
}
export async function leadReport(repo: TenantRepository): Promise<LeadReport> {
  return repo.leadSummary();
}
export function inventoryCsv(data: InventoryReport): string {
  return toCsv([['stockNumber', 'vehicle', 'status', 'dateStocked', 'agingDays', 'bucket', 'listPrice', 'cost', 'reconTotal', 'totalCost'], ...data.rows.map(r => [r.stockNumber, r.vehicle, r.status, r.dateStocked, String(r.agingDays), r.bucket, ...[r.listPrice, r.cost, r.reconTotal, r.totalCost].map(dollars)])]);
}
export function salesCsv(data: SalesReport, accounting = false): string {
  return toCsv(accounting ? [['date', 'deal', 'buyer', 'vehicle', 'price', 'cost', 'recon', 'tax', 'fees', 'gross', 'fiGross'], ...data.rows.map(r => [r.soldDate, r.dealId, r.buyer, r.vehicle, ...[r.price, r.cost, r.recon, r.tax, r.fees, r.frontGross, r.fiGross].map(dollars)])]
    : [['soldDate', 'dealId', 'buyer', 'vehicle', 'price', 'frontGross', 'fiGross'], ...data.rows.map(r => [r.soldDate, r.dealId, r.buyer, r.vehicle, dollars(r.price), dollars(r.frontGross), dollars(r.fiGross)])]);
}
export function leadCsv(data: LeadReport): string {
  return toCsv([['dimension', 'value', 'count'], ...data.byStage.map(r => ['stage', r.stage, String(r.count)]), ...data.bySource.map(r => ['source', r.source, String(r.count)]), ['total', 'all', String(data.total)]]);
}
export async function reports(request: ApiRequest, repo: TenantRepository, now: Date, track: Track = async () => {}) {
  const match = /^\/reports\/(inventory|sales|leads|accounting|fixed-ops)(\.csv)?$/.exec(request.path.replace(/\/$/, ''));
  if (!match || (match[1] === 'accounting' && !match[2])) throw missing();
  if (request.method.toUpperCase() !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const name = match[1], csv = Boolean(match[2]);
  const exported = async (filename: string, body: string) => {
    const result = csvResponse(filename, body);
    try { await track({event: 'report_exported', report: name === 'inventory' ? 'aging' : name === 'leads' ? 'pipeline' : name as 'sales' | 'accounting'}); } catch { /* Export remains usable. */ }
    return result;
  };
  if (name === 'fixed-ops') { if (csv) throw missing(); return response(200, {data:await fixedOpsReport(repo, dateRange(request.query))}); }
  if (name === 'sales' || name === 'accounting') {
    const data = await salesReport(repo, dateRange(request.query));
    return csv ? await exported(`${name}.csv`, salesCsv(data, name === 'accounting')) : response(200, {data});
  }
  onlyKeys(request.query ?? {}, []);
  if (name === 'inventory') { const data = await inventoryReport(repo, now); return csv ? await exported('inventory.csv', inventoryCsv(data)) : response(200, {data}); }
  const data = await leadReport(repo); return csv ? await exported('lead-pipeline.csv', leadCsv(data)) : response(200, {data});
}

export async function fixedOpsReport(repo: TenantRepository, range: ReturnType<typeof dateRange>): Promise<FixedOpsReport> {
  // Operational basis: currently finalized ROs and counter sales by creation date; current catalog costs, free-text cost zero.
  const inRange = (r: {createdAt:string}) => (!range.from || r.createdAt.slice(0,10) >= range.from) && (!range.to || r.createdAt.slice(0,10) <= range.to);
  const ros = (await repo.crmList('repair-order')).filter(r => ['completed','picked-up'].includes(r.status) && inRange(r));
  const sales = (await repo.crmList('parts-sale')).filter(inRange);
  let laborCents = 0, partsCents = 0, partsCostCents = 0;
  for (const ro of ros) { const t = repairOrderTotals(ro.lineItems); laborCents += t.laborCents; partsCents += t.partsCents; partsCostCents += await stockedCost(repo, ro); }
  for (const sale of sales) { const part = await repo.crmGet('part',sale.partId); if (!part) throw missing(); partsCostCents += sale.quantity * part.costCents; }
  const counterTotalCents = sales.reduce((s,r) => s+r.totalCents,0);
  return {...range, roCount:ros.length, laborCents, partsCents, roTotalCents:laborCents+partsCents, counterSaleCount:sales.length, counterTotalCents, partsCostCents, laborGrossCents:laborCents, partsGrossCents:partsCents+counterTotalCents-partsCostCents};
}
