import type { CrmRecord, Lead, VehicleStatus } from './index.js';
export const agingBuckets = ['0-30', '31-60', '61-90', '91+'] as const;
export type AgingBucket = typeof agingBuckets[number];
export interface InventoryReport {
  rows: {stockNumber: string; vehicle: string; status: VehicleStatus; dateStocked: string; agingDays: number; bucket: AgingBucket; listPrice: number; cost: number; reconTotal: number; totalCost: number}[];
  buckets: {bucket: AgingBucket; count: number; totalCost: number}[];
  totals: {count: number; totalCost: number; totalListPrice: number};
}
export interface SalesReport {
  from: string | null; to: string | null;
  rows: {soldDate: string; dealId: string; buyer: string; vehicle: string; price: number; frontGross: number; fiGross: number; fiRetail: number; cost: number; recon: number; tax: number; fees: number}[];
  totals: {dealsSold: number; totalFrontGross: number; totalFiGross: number; averageGross: number};
}
export interface LeadReport {
  byStage: {stage: Lead['stage']; count: number}[];
  bySource: {source: Lead['source']; count: number}[];
  total: number;
}

export interface TurnReport {
  from: string | null; to: string | null; soldInPeriod: number; averageDaysToSale: number; periodDays: number; turnRate: number;
}
/** UTC calendar days; invalid negative durations are excluded from every metric. */
export function inventoryTurn(sales: {soldDate: string; dateStocked: string}[], unsold: number, range: {from: string | null; to: string | null}): TurnReport {
  const days = (end: string, start: string) => (Date.parse(end) - Date.parse(start)) / 86400000;
  const valid = sales.filter(s => days(s.soldDate, s.dateStocked) >= 0);
  const dates = valid.map(s => s.soldDate).sort(), soldInPeriod = valid.length;
  const periodDays = range.from && range.to ? days(range.to, range.from) + 1 : dates.length ? days(dates[dates.length - 1], dates[0]) + 1 : 0;
  const stockBase = unsold + soldInPeriod;
  // Annualized estimate: round(soldInPeriod * 365 / (periodDays * stockBase), 2).
  return {...range, soldInPeriod, periodDays, averageDaysToSale: soldInPeriod ? Math.round(valid.reduce((sum, s) => sum + days(s.soldDate, s.dateStocked), 0) / soldInPeriod * 10) / 10 : 0,
    turnRate: soldInPeriod && periodDays && stockBase ? Math.round(soldInPeriod * 365 / (periodDays * stockBase) * 100) / 100 : 0};
}
export interface FiReport {
  from: string | null; to: string | null; dealsSold: number; dealsWithFi: number; penetrationBps: number;
  totalFiGross: number; totalFiRetail: number; totalFiCost: number; fiGrossPerDeal: number;
  perProduct: {productId: string; name: string; category: string; deals: number; units: number; retail: number; cost: number; gross: number}[];
}
type ColumnType = 'text' | 'number' | 'money';
const columns = (text: string[], money: string[] = [], numeric: string[] = []): {key: string; label: string; type: ColumnType}[] =>
  [...text.map(key => ({key, label: key, type: 'text' as const})), ...money.map(key => ({key, label: key, type: 'money' as const})), ...numeric.map(key => ({key, label: key, type: 'number' as const}))];
export const reportDatasets = {
  technicians: {columns: columns(['technicianId', 'technician', 'flaggedHours', 'efficiencyPercent'], [], ['soldHours', 'missingFlaggedLines', 'roCount']), groupings: []},
  departments: {columns: columns(['department'], ['income', 'expenses', 'grossProfit']), groupings: []},
  locations: {columns: columns(['location'], ['laborCents', 'servicePartsCents', 'counterCents'], ['roCount', 'counterSaleCount']), groupings: []},
  inventory: {columns: columns(['stockNumber', 'vehicle', 'status', 'dateStocked', 'bucket'], ['listPrice', 'cost', 'reconTotal', 'totalCost'], ['agingDays']), groupings: ['status', 'bucket']},
  sales: {columns: columns(['soldDate', 'dealId', 'buyer', 'vehicle'], ['price', 'frontGross', 'fiGross']), groupings: ['buyer', 'vehicle']},
  leads: {columns: columns(['leadId', 'customer', 'source', 'stage', 'vehicleDescription', 'createdAt']), groupings: ['source', 'stage']},
  fi: {columns: columns(['soldDate', 'dealId', 'buyer', 'productId', 'product', 'category'], ['retail', 'cost', 'gross']), groupings: ['product', 'category', 'buyer']},
} as const;
export type ReportDataset = keyof typeof reportDatasets;
export interface ReportDefinition {dataset: ReportDataset; columns: string[]; from?: string; to?: string; groupBy?: string}
export interface SavedReport extends CrmRecord {kind: 'saved-report'; name: string; definition: ReportDefinition}
export interface CustomReport {dataset: ReportDataset; columns: {key: string; label: string}[]; rows: string[][]}
