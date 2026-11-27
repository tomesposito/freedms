import { projectedPhotoUrls } from './vehicle-photos.js';
import type { CarsforsaleFeedRow, FeedOptions, GoogleFeedRow, Vehicle } from '@freedms/shared';
import { feedExclusion, sortedFeedVehicles } from './feed-selection.js';
import { toCsv } from './reports.js';

/** Destinations a dealer can self-serve with a published feed format and no freeDMS partner agreement (#205). */
export const destinationNames = {google: 'Google Vehicle Ads', carsforsale: 'Carsforsale.com'} as const;
/** Named destinations that accept inventory only through partner or approved feed-provider agreements (checked 2026-11-26): Cars.com intake runs through its Inventory Command Center for approved providers, and AutoTrader and CarGurus likewise take inventory only through approved providers. They stay with the parent issue #156. */
export const agreementGatedDestinations = [
  {name: 'Cars.com', note: 'Inventory reaches Cars.com only through its approved provider intake (Inventory Command Center), not a dealer-pulled feed.'},
  {name: 'AutoTrader', note: 'Inventory reaches AutoTrader only through approved feed providers, not a dealer-pulled feed.'},
  {name: 'CarGurus', note: 'Inventory reaches CarGurus only through approved feed providers, not a dealer-pulled feed.'},
] as const;

const title = (v: Vehicle) => [v.year, v.make, v.model, v.trim].filter(String).join(' ');
const description = (v: Vehicle, dealer: string) => v.listingDescription || `${title(v)} for sale at ${dealer}. Stock ${v.stockNumber}.`;
const included = (vehicles: Vehicle[], config: FeedOptions) => sortedFeedVehicles(vehicles).filter(v => v.status !== 'sold' && !feedExclusion(v, config));
/** The dealer site serves a vehicle page only for available vehicles; other included statuses link to the site's inventory page instead of a page that would 404. */
const vehicleLink = (v: Vehicle, tenantId: string, publicBase = '') => v.status === 'available' ? `${publicBase}/public/${tenantId}/site/vehicles/${v.id}` : `${publicBase}/public/${tenantId}/site/inventory`;

export const googleColumns = ['id', 'title', 'description', 'link_template', 'image_link', 'additional_image_link', 'price', 'condition', 'google_product_category', 'vehicle_fulfillment(option:store_code)', 'VIN', 'brand', 'model', 'trim', 'year', 'mileage', 'color'] as const;
export function googleRow(v: Vehicle, tenantId: string, dealer: string, imageUrls: string[], storeCode = '', publicBase = ''): GoogleFeedRow {
  return {id: v.stockNumber, title: title(v), description: description(v, dealer),
    link_template: `${vehicleLink(v, tenantId, publicBase)}?store={store_code}`, image_link: imageUrls[0] ?? '', additional_image_link: imageUrls.slice(1).join(','),
    price: `${(v.listPrice / 100).toFixed(2)} USD`, condition: 'Used', google_product_category: '916', 'vehicle_fulfillment(option:store_code)': `in_store:${storeCode}`,
    VIN: v.vin, brand: v.make, model: v.model, trim: v.trim, year: v.year,
    mileage: v.mileage === null ? '' : `${v.mileage} Miles`, color: ''};
}
export function buildGoogleRows(vehicles: Vehicle[], config: FeedOptions, tenantId: string, dealer: string, photoBase = '', publicBase = ''): GoogleFeedRow[] {
  return included(vehicles, config).map(v => googleRow(v, tenantId, dealer, projectedPhotoUrls(v, photoBase, 'feed'), config.googleStoreCode ?? '', publicBase));
}
export const googleCsv = (rows: GoogleFeedRow[]) => toCsv([[...googleColumns], ...rows.map(row => googleColumns.map(key => String(row[key])))]);

export const carsforsaleColumns = ['stock_number', 'vin', 'year', 'make', 'model', 'trim', 'status', 'price', 'special_price', 'mileage', 'color', 'engine', 'transmission', 'drivetrain', 'description', 'features', 'image_link', 'additional_image_link', 'dealer_name', 'location', 'link'] as const;
export function carsforsaleRow(v: Vehicle, tenantId: string, dealer: string, imageUrls: string[], publicBase = ''): CarsforsaleFeedRow {
  return {stock_number: v.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim, status: v.status,
    price: (v.listPrice / 100).toFixed(2), special_price: '', mileage: v.mileage ?? '', color: '', engine: '', transmission: '', drivetrain: '',
    description: description(v, dealer), features: '',
    image_link: imageUrls[0] ?? '', additional_image_link: imageUrls.slice(1).join(','), dealer_name: dealer, location: v.location,
    link: vehicleLink(v, tenantId, publicBase)};
}
export function buildCarsforsaleRows(vehicles: Vehicle[], config: FeedOptions, tenantId: string, dealer: string, photoBase = '', publicBase = ''): CarsforsaleFeedRow[] {
  return included(vehicles, config).map(v => carsforsaleRow(v, tenantId, dealer, projectedPhotoUrls(v, photoBase, 'feed'), publicBase));
}
export const carsforsaleCsv = (rows: CarsforsaleFeedRow[]) => toCsv([[...carsforsaleColumns], ...rows.map(row => carsforsaleColumns.map(key => String(row[key])))]);
