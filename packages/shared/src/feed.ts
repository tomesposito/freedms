import type { CrmRecord, VehicleStatus } from './index.js';
export type FeedFormat = 'csv' | 'json';
export interface FeedOptions { formats: FeedFormat[]; includedStatuses: VehicleStatus[]; requirePrice: boolean; facebookEnabled: boolean; googleEnabled: boolean; syndicationEnabled: boolean; schedule: 'manual' | 'daily' | 'weekly' }
export interface FeedConfig extends CrmRecord, FeedOptions {}
/** Only available vehicles are sellable by default; reserved and in-recon require explicit opt-in. */
export const defaultFeedOptions: FeedOptions = {formats: ['csv', 'json'], includedStatuses: ['available'], requirePrice: true, facebookEnabled: false, googleEnabled: false, syndicationEnabled: false, schedule: 'manual'};
/** Public listing fields only: no notes, cost, recon, or aging. JSON prices are integer USD cents. */
export interface FeedRow { stockNumber: string; vin: string; year: number; make: string; model: string; trim: string; status: VehicleStatus; listPriceCents: number; dateStocked: string; location: string }
export interface FeedRun {
  id: string; tenantId: string; actorId: string; createdAt: string; formats: FeedFormat[]; includedCount: number; excludedCount: number;
  included: {vehicleId: string; stockNumber: string}[];
  excluded: {vehicleId: string; stockNumber: string; reason: 'sold' | 'status_not_included' | 'missing_price'; message: string}[];
  rows: FeedRow[];
  facebookRows?: FacebookFeedRow[];
  googleRows?: GoogleFeedRow[];
  syndicationRows?: SyndicationFeedRow[];
  /** Fingerprint of the FeedOptions the facebookRows were generated with (#171). The adapters copy it into the bounded published-feed pointer at append time. */
  facebookFingerprint?: string;
  /** Fingerprint of the FeedOptions the destination rows were generated with (#205). Covers every destination flag; any publication-settings change invalidates every published destination feed until regeneration. */
  feedFingerprint?: string;
}

export interface FacebookFeedRow {
  vehicle_id: string; vin: string; title: string; description: string;
  availability: 'in stock' | 'preorder' | 'out of stock'; condition: 'used'; price: string;
  link: string; image_link: string; additional_image_link: string; make: string; model: string;
  year: number; trim: string; mileage_value: number | ''; mileage_unit: 'MI' | '';
  dealer_name: string; location: string;
}
export interface FacebookFeedStatus { enabled: boolean; feedUrl: string; lastGeneratedAt: string | null; vehicleCount: number | null }

/** Published destination feeds beyond the generic listing files (#205). Each destination has its own bounded published-feed pointer, generalizing the Facebook pointer from #171. */
export type FeedDestinationId = 'facebook' | 'google' | 'syndication';
export interface DestinationFeedStatus { id: FeedDestinationId; name: string; enabled: boolean; feedUrl: string; lastGeneratedAt: string | null; vehicleCount: number | null }
/** Destinations freeDMS cannot feed directly: inventory reaches them only through a partner or feed-provider agreement. Named on the Feeds page and left to #156. */
export interface AgreementGatedDestination { name: string; note: string }
/** Google Merchant Center vehicle ads feed row (Google's published vehicle data source specification, checked 2026-11-26). Exact Google attribute names; price is "12345.67 USD"; mileage is "10000 Miles". freeDMS does not record exterior color, so color ships empty and Google may disapprove a row until the dealer's Merchant Center data supplies it. */
export interface GoogleFeedRow {
  id: string; title: string; description: string; link: string; image_link: string; additional_image_link: string;
  price: string; condition: 'Used'; google_product_category: '916'; vehicle_fulfillment: 'online'; VIN: string;
  brand: string; model: string; trim: string; year: number; mileage: string; color: string;
}
/** Standard aggregator inventory CSV row in the field layout dealer feed providers use for Carsforsale.com-style ingestion (#205): VIN, stock, year/make/model/trim, price, mileage, description, photos. Price is USD dollars with two decimals. */
export interface SyndicationFeedRow {
  stock_number: string; vin: string; year: number; make: string; model: string; trim: string; status: VehicleStatus;
  price: string; mileage: number | ''; description: string; image_link: string; additional_image_link: string;
  dealer_name: string; location: string; link: string;
}
