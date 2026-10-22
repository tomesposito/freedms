import type { CrmRecord, VehicleStatus } from './index.js';
export type FeedFormat = 'csv' | 'json';
export interface FeedOptions { formats: FeedFormat[]; includedStatuses: VehicleStatus[]; requirePrice: boolean; schedule: 'manual' | 'daily' | 'weekly' }
export interface FeedConfig extends CrmRecord, FeedOptions {}
/** Only available vehicles are sellable by default; reserved and in-recon require explicit opt-in. */
export const defaultFeedOptions: FeedOptions = {formats: ['csv', 'json'], includedStatuses: ['available'], requirePrice: true, schedule: 'manual'};
/** Public listing fields only: no notes, cost, recon, or aging. JSON prices are integer USD cents. */
export interface FeedRow { stockNumber: string; vin: string; year: number; make: string; model: string; trim: string; status: VehicleStatus; listPriceCents: number; dateStocked: string; location: string }
export interface FeedRun {
  id: string; tenantId: string; actorId: string; createdAt: string; formats: FeedFormat[]; includedCount: number; excludedCount: number;
  included: {vehicleId: string; stockNumber: string}[];
  excluded: {vehicleId: string; stockNumber: string; reason: 'sold' | 'status_not_included' | 'missing_price'; message: string}[];
  rows: FeedRow[];
}
