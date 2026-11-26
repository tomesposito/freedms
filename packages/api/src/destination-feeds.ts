import { projectedPhotoUrls } from './vehicle-photos.js';
import type { FeedOptions, GoogleFeedRow, SyndicationFeedRow, Vehicle } from '@freedms/shared';
import { feedExclusion, sortedFeedVehicles } from './feed-selection.js';
import { toCsv } from './reports.js';

/** Destinations a dealer can self-serve with a published feed format and no freeDMS partner agreement (#205). */
export const destinationNames = {google: 'Google Vehicle Ads', syndication: 'Syndication CSV'} as const;
/** Named destinations that accept inventory only through partner or approved feed-provider agreements (checked 2026-11-26): Cars.com intake runs through its Inventory Command Center for approved providers, and AutoTrader and CarGurus likewise take inventory only through approved providers. They stay with the parent issue #156. */
export const agreementGatedDestinations = [
  {name: 'Cars.com', note: 'Inventory reaches Cars.com only through its approved provider intake (Inventory Command Center), not a dealer-pulled feed.'},
  {name: 'AutoTrader', note: 'Inventory reaches AutoTrader only through approved feed providers, not a dealer-pulled feed.'},
  {name: 'CarGurus', note: 'Inventory reaches CarGurus only through approved feed providers, not a dealer-pulled feed.'},
] as const;

const title = (v: Vehicle) => [v.year, v.make, v.model, v.trim].filter(String).join(' ');
const description = (v: Vehicle, dealer: string) => v.listingDescription || `${title(v)} for sale at ${dealer}. Stock ${v.stockNumber}.`;
const included = (vehicles: Vehicle[], config: FeedOptions) => sortedFeedVehicles(vehicles).filter(v => v.status !== 'sold' && !feedExclusion(v, config));

export const googleColumns = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price', 'condition', 'google_product_category', 'vehicle_fulfillment', 'VIN', 'brand', 'model', 'trim', 'year', 'mileage', 'color'] as const;
export function googleRow(v: Vehicle, tenantId: string, dealer: string, imageUrls: string[]): GoogleFeedRow {
  return {id: v.stockNumber, title: title(v), description: description(v, dealer),
    link: `/public/${tenantId}/site/vehicles/${v.id}`, image_link: imageUrls[0] ?? '', additional_image_link: imageUrls.slice(1).join(','),
    price: `${(v.listPrice / 100).toFixed(2)} USD`, condition: 'Used', google_product_category: '916', vehicle_fulfillment: 'online',
    VIN: v.vin, brand: v.make, model: v.model, trim: v.trim, year: v.year,
    mileage: v.mileage === null ? '' : `${v.mileage} Miles`, color: ''};
}
export function buildGoogleRows(vehicles: Vehicle[], config: FeedOptions, tenantId: string, dealer: string, photoBase = ''): GoogleFeedRow[] {
  return included(vehicles, config).map(v => googleRow(v, tenantId, dealer, projectedPhotoUrls(v, photoBase, 'feed')));
}
export const googleCsv = (rows: GoogleFeedRow[]) => toCsv([[...googleColumns], ...rows.map(row => googleColumns.map(key => String(row[key])))]);

export const syndicationColumns = ['stock_number', 'vin', 'year', 'make', 'model', 'trim', 'status', 'price', 'mileage', 'description', 'image_link', 'additional_image_link', 'dealer_name', 'location', 'link'] as const;
export function syndicationRow(v: Vehicle, tenantId: string, dealer: string, imageUrls: string[]): SyndicationFeedRow {
  return {stock_number: v.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim, status: v.status,
    price: (v.listPrice / 100).toFixed(2), mileage: v.mileage ?? '', description: description(v, dealer),
    image_link: imageUrls[0] ?? '', additional_image_link: imageUrls.slice(1).join(','), dealer_name: dealer, location: v.location,
    link: `/public/${tenantId}/site/vehicles/${v.id}`};
}
export function buildSyndicationRows(vehicles: Vehicle[], config: FeedOptions, tenantId: string, dealer: string, photoBase = ''): SyndicationFeedRow[] {
  return included(vehicles, config).map(v => syndicationRow(v, tenantId, dealer, projectedPhotoUrls(v, photoBase, 'feed')));
}
export const syndicationCsv = (rows: SyndicationFeedRow[]) => toCsv([[...syndicationColumns], ...rows.map(row => syndicationColumns.map(key => String(row[key])))]);
