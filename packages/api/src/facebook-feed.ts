import { projectedPhotoUrls } from './vehicle-photos.js';
import type { FacebookFeedRow, FeedOptions, Vehicle } from '@freedms/shared';
import { feedExclusion, sortedFeedVehicles } from './feed-selection.js';
import { toCsv } from './reports.js';
export const facebookColumns = ['vehicle_id', 'vin', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'make', 'model', 'year', 'trim', 'mileage_value', 'mileage_unit', 'dealer_name', 'location'] as const;
export function facebookRow(v: Vehicle, tenantId: string, dealer: string, imageUrls: string[]): FacebookFeedRow {
  const title = [v.year, v.make, v.model, v.trim].filter(String).join(' ');
  return {vehicle_id: v.stockNumber, vin: v.vin, title, description: v.listingDescription || `${title} for sale at ${dealer}. Stock ${v.stockNumber}.`,
    availability: v.status === 'reserved' ? 'preorder' : v.status === 'in recon' ? 'out of stock' : 'in stock', condition: 'used', price: `${(v.listPrice / 100).toFixed(2)} USD`,
    link: `/public/${tenantId}/inventory.html`, image_link: imageUrls[0] ?? '', additional_image_link: imageUrls.slice(1).join(','),
    make: v.make, model: v.model, year: v.year, trim: v.trim, mileage_value: v.mileage ?? '', mileage_unit: v.mileage === null ? '' : 'MI', dealer_name: dealer, location: v.location};
}
export function buildFacebookRows(vehicles: Vehicle[], config: FeedOptions, tenantId: string, dealer: string, photoBase = ''): FacebookFeedRow[] {
  return sortedFeedVehicles(vehicles).filter(v => v.status !== 'sold' && !feedExclusion(v, config)).map(v => facebookRow(v, tenantId, dealer, projectedPhotoUrls(v, photoBase, 'feed')));
}
export const facebookCsv = (rows: FacebookFeedRow[]) => toCsv([[...facebookColumns], ...rows.map(row => facebookColumns.map(key => String(row[key])))]);
/** Stable fingerprint of the publication settings a Facebook feed was generated under (#171). Any change to these settings invalidates the published pointer until the dealer regenerates. */
export const feedOptionsFingerprint = (options: FeedOptions) => JSON.stringify({formats: [...options.formats].sort(), includedStatuses: [...options.includedStatuses].sort(), requirePrice: options.requirePrice, schedule: options.schedule, facebookEnabled: options.facebookEnabled});
