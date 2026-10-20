import type { Lead, VehicleStatus } from './index.js';
export const agingBuckets = ['0-30', '31-60', '61-90', '91+'] as const;
export type AgingBucket = typeof agingBuckets[number];
export interface InventoryReport {
  rows: {stockNumber: string; vehicle: string; status: VehicleStatus; dateStocked: string; agingDays: number; bucket: AgingBucket; listPrice: number; cost: number; reconTotal: number; totalCost: number}[];
  buckets: {bucket: AgingBucket; count: number; totalCost: number}[];
  totals: {count: number; totalCost: number; totalListPrice: number};
}
export interface SalesReport {
  from: string | null; to: string | null;
  rows: {soldDate: string; dealId: string; buyer: string; vehicle: string; price: number; frontGross: number; cost: number; recon: number; tax: number; fees: number}[];
  totals: {dealsSold: number; totalFrontGross: number; averageGross: number};
}
export interface LeadReport {
  byStage: {stage: Lead['stage']; count: number}[];
  bySource: {source: Lead['source']; count: number}[];
  total: number;
}
