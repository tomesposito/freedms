import { vehicleStatuses, type VehicleInput, type VehicleView, type Vehicle } from '@freedms/shared';
import { ApiError } from './errors.js';
export const invalid = (message: string) => new ApiError(400, 'VALIDATION', message);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object.');
  return value as Record<string, unknown>;
}
export function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw invalid('Unexpected field in request.');
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
  onlyKeys(b, ['stockNumber', 'vin', 'year', 'make', 'model', 'trim', 'status', 'listPrice', 'cost', 'reconCosts', 'dateStocked', 'location', 'notes']);
  if (typeof b.year !== 'number' || !Number.isInteger(b.year) || b.year < 1886 || b.year > now.getUTCFullYear() + 2) throw invalid('Invalid model year.');
  if (!vehicleStatuses.includes(b.status as VehicleInput['status'])) throw invalid('Invalid vehicle status.');
  const dateStocked = text(b.dateStocked, 'Date stocked', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStocked) || !Number.isFinite(Date.parse(dateStocked)) || new Date(dateStocked).toISOString().slice(0, 10) !== dateStocked || dateStocked > now.toISOString().slice(0, 10)) throw invalid('Date stocked must be a valid date no later than today (UTC).');
  if (!Array.isArray(b.reconCosts) || b.reconCosts.length > 100) throw invalid('Recon costs must be an array with at most 100 line items.');
  const reconCosts = b.reconCosts.map(value => { const row = object(value); onlyKeys(row, ['description', 'amount']); return {description: text(row.description, 'Recon description', 200), amount: money(row.amount, 'Recon amount')}; });
  return {stockNumber: text(b.stockNumber, 'Stock number', 50), vin: vin(b.vin), year: b.year,
    make: text(b.make, 'Make'), model: text(b.model, 'Model'), trim: text(b.trim, 'Trim', 120, true), status: b.status as VehicleInput['status'],
    listPrice: money(b.listPrice, 'List price'), cost: money(b.cost, 'Cost'), reconCosts, dateStocked,
    location: text(b.location, 'Location', 200, true), notes: text(b.notes, 'Notes', 10000, true)};
}
export function view(vehicle: Vehicle, now: Date): VehicleView {
  return {...vehicle, reconTotal: vehicle.reconCosts.reduce((sum, item) => sum + item.amount, 0),
    agingDays: Math.max(0, Math.floor((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(vehicle.dateStocked)) / 86400000))};
}

export function dollarCents(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const s = String(value).trim().replace(/^\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return;
  const amount = Math.round(Number(s.replace(/,/g, '')) * 100);
  return Number.isSafeInteger(amount) && amount <= 100_000_000_00 ? amount : undefined;
}
