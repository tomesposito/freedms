import { effectiveVehiclePhotos, vehiclePhotoUrl, vehicleStatuses, type VehicleInput, type VehicleView, type Vehicle } from '@freedms/shared';
import { ApiError } from './errors.js';
export const invalid = (message: string) => new ApiError(400, 'VALIDATION', message);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const unexpected = Object.keys(value).filter(key => !keys.includes(key));
  // Name the offending fields and the allowed set (#195): a bare "unexpected
  // field" leaves API and MCP callers guessing which key to drop.
  if (unexpected.length) throw invalid(`Unexpected field${unexpected.length > 1 ? 's' : ''} in request: ${unexpected.join(', ')}. Allowed fields: ${keys.length ? keys.join(', ') : '(none)'}.`);
}
export function text(value: unknown, name: string, max = 120, optional = false): string {
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim())) throw invalid(`${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
export function vin(value: unknown): string {
  const result = text(value, 'VIN', 17).toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(result)) throw invalid('VIN must contain 17 letters or digits, excluding I, O and Q.');
  return result;
}
export function money(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000_000_00) throw invalid(`${name} must be nonnegative integer cents, at most $100,000,000.`);
  return value;
}
export function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid('A positive record version is required.');
  return value;
}
export function vehicleInput(value: unknown, now: Date): VehicleInput {
  const b = object(value);
  onlyKeys(b, ['photoUrls', 'listingDescription', 'stockNumber', 'vin', 'year', 'mileage', 'make', 'model', 'trim', 'status', 'listPrice', 'cost', 'reconCosts', 'dateStocked', 'location', 'notes']);
  if (typeof b.year !== 'number' || !Number.isInteger(b.year) || b.year < 1886 || b.year > now.getUTCFullYear() + 2) throw invalid('Invalid model year.');
  if (!vehicleStatuses.includes(b.status as VehicleInput['status'])) throw invalid(`Invalid vehicle status: expected one of ${vehicleStatuses.join(', ')}.`);
  const mileage = b.mileage ?? null;
  if (mileage !== null && (typeof mileage !== 'number' || !Number.isSafeInteger(mileage) || mileage < 0 || mileage > 10_000_000)) throw invalid('Mileage must be an integer from 0 to 10,000,000.');
  const dateStocked = text(b.dateStocked, 'Date stocked', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStocked) || !Number.isFinite(Date.parse(dateStocked)) || new Date(dateStocked).toISOString().slice(0, 10) !== dateStocked || dateStocked > now.toISOString().slice(0, 10)) throw invalid('Date stocked must be a valid date no later than today (UTC).');
  if (!Array.isArray(b.reconCosts) || b.reconCosts.length > 100) throw invalid('Recon costs must be an array with at most 100 line items.');
  const reconCosts = b.reconCosts.map(value => { const row = object(value); onlyKeys(row, ['description', 'amount']); return {description: text(row.description, 'Recon description', 200), amount: money(row.amount, 'Recon amount')}; });
  const photos = b.photoUrls;
  if (photos !== undefined && (!Array.isArray(photos) || photos.length > 20 || photos.some(url => typeof url !== 'string' || url.length > 2000 || !/^https?:\/\//i.test(url)))) throw invalid('Photos must be at most 20 HTTP(S) URLs.');
  return {...(b.listingDescription === undefined ? {} : {listingDescription: text(b.listingDescription, 'Listing description', 5000, true)}), ...(photos === undefined ? {} : {photoUrls: photos as string[]}), stockNumber: text(b.stockNumber, 'Stock number', 50), vin: vin(b.vin), year: b.year, mileage,
    make: text(b.make, 'Make'), model: text(b.model, 'Model'), trim: text(b.trim, 'Trim', 120, true), status: b.status as VehicleInput['status'],
    listPrice: money(b.listPrice, 'List price'), cost: money(b.cost, 'Cost'), reconCosts, dateStocked,
    location: text(b.location, 'Location', 200, true), notes: text(b.notes, 'Notes', 10000, true)};
}
export function view(vehicle: Vehicle, now: Date, photoBase = ''): VehicleView {
  // The photo surface is always explicit (#194): project on read so a vehicle
  // with no photos returns photoUrls: [] and photoCount: 0 instead of omitting
  // both fields, which left MCP agents unable to tell "no photos" from
  // "photos stripped". Same projection as the write paths (display size,
  // effective photos); the public serving gate (#169) is unchanged.
  const photoUrls = effectiveVehiclePhotos(vehicle).map(photo => vehiclePhotoUrl(photo, vehicle.tenantId, photoBase));
  return {...vehicle, photoUrls, photoCount: photoUrls.length, mileage: vehicle.mileage ?? null, reconTotal: vehicle.reconCosts.reduce((sum, item) => sum + item.amount, 0),
    agingDays: Math.max(0, Math.floor((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(vehicle.dateStocked)) / 86400000))};
}

export function dollarCents(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const s = String(value).trim().replace(/^\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return;
  const amount = Math.round(Number(s.replace(/,/g, '')) * 100);
  return Number.isSafeInteger(amount) && amount <= 100_000_000_00 ? amount : undefined;
}

export function pageNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw invalid('Invalid pagination parameter.');
  return Number(value);
}
