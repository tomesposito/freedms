import { IMPORT_BODY_LIMIT } from './import.js';
export { dollarCents } from './validation.js';
import { randomUUID } from 'node:crypto';
import { leadSources, type LeadDraft, type VehicleDraft, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, missing } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { dollarCents, invalid, onlyKeys, text } from './validation.js';
import type { TenantRepository } from './repository.js';
import { providerFailure, unavailable, visionUnsupported, type QuickEntryProvider } from './ai-provider.js';
// At most 5 MiB base64 (about 3.75 MiB decoded); extra room only for JSON metadata.
export const PHOTO_BASE64_LIMIT = 5 * 1024 * 1024;
export const PHOTO_BODY_LIMIT = PHOTO_BASE64_LIMIT + 1024;
export function bodyLimit(method: string, path: string): number {
  if (method.toUpperCase() === 'POST' && (/^\/deals\/[^/]+\/(buyers-order|documents\/[^/]+)\/signatures\/?$/.test(path) || /^\/service\/repair-orders\/[^/]+\/signatures\/?$/.test(path))) return 136 * 1024;
  if (/^\/accounting\/reconciliations\/[^/]+\/(preview|import)\/?$/.test(path)) return IMPORT_BODY_LIMIT;
  if (/^\/vehicles\/imports?(\/|$)/.test(path)) return IMPORT_BODY_LIMIT;
  return method.toUpperCase() === 'POST' && path.replace(/\/$/, '') === '/quick-entry/vehicle-photo' ? PHOTO_BODY_LIMIT : 65536;
}
const clean = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
export function sanitizeVehicle(raw: Record<string, unknown>, now: Date): VehicleDraft {
  const draft: VehicleDraft = {};
  for (const [key, max] of [['make', 120], ['model', 120], ['trim', 120], ['stockNumber', 50], ['location', 200], ['notes', 10000]] as const) {
    const value = clean(raw[key], max); if (value) draft[key] = value;
  }
  const year = typeof raw.year === 'number' ? raw.year : typeof raw.year === 'string' && /^\d{4}$/.test(raw.year) ? Number(raw.year) : NaN;
  if (Number.isInteger(year) && year >= 1886 && year <= now.getUTCFullYear() + 2) draft.year = year;
  const vin = clean(raw.vin, 17)?.toUpperCase(); if (vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) draft.vin = vin;
  for (const key of ['cost', 'listPrice'] as const) { const value = dollarCents(raw[key]); if (value !== undefined) draft[key] = value; }
  const mileage = typeof raw.mileage === 'number' || typeof raw.mileage === 'string' ? String(raw.mileage).trim().match(/^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+)(k)?(?:\s*miles)?$/i) : null;
  if (mileage) {
    const miles = Number(mileage[1].replace(/,/g, '')) * (mileage[2] ? 1000 : 1);
    if (Number.isSafeInteger(miles) && miles >= 0 && miles <= 10_000_000) {
      draft.mileage = miles;
    }
  }
  return draft;
}
export function sanitizeLead(raw: Record<string, unknown>): LeadDraft {
  const draft: LeadDraft = {};
  const c = raw.customer && typeof raw.customer === 'object' && !Array.isArray(raw.customer) ? raw.customer as Record<string, unknown> : {};
  const customer: NonNullable<LeadDraft['customer']> = {consent: {status: 'unknown', timestamp: null, source: ''}};
  for (const [key, max] of [['name', 120], ['address', 1000], ['notes', 10000]] as const) { const value = clean(c[key], max); if (value) customer[key] = value; }
  const phone = clean(c.phone, 50); if (phone && /^[+\d().\s-]+$/.test(phone) && phone.replace(/\D/g, '').length >= 7 && phone.replace(/\D/g, '').length <= 15) customer.phone = phone;
  const email = clean(c.email, 254); if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) customer.email = email.toLowerCase();
  if (Object.keys(customer).length > 1) draft.customer = customer;
  const vehicle = clean(raw.vehicleDescription, 1000), trade = clean(raw.tradeDescription, 1000);
  if (vehicle) draft.vehicleDescription = vehicle;
  if (trade) {
    draft.customer ??= customer;
    draft.customer.notes = [customer.notes?.slice(0, 8990), `Trade: ${trade}`].filter(Boolean).join('\n');
  }
  if (leadSources.includes(raw.source as typeof leadSources[number])) draft.source = raw.source as typeof leadSources[number];
  const detail = clean(raw.sourceDetail, 500); if (detail) draft.sourceDetail = detail;
  return draft;
}
export async function quickEntry(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, provider: QuickEntryProvider) {
  const method = request.method.toUpperCase(), path = request.path.replace(/\/$/, '');
  onlyKeys(request.query ?? {}, []);
  if (path === '/quick-entry/status' && method === 'GET') return response(200, {data: {configured: provider.configured, vision: provider.configured && provider.supportsVision}});
  if (!['/quick-entry/vehicle', '/quick-entry/lead', '/quick-entry/vehicle-photo'].includes(path)) throw missing();
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  requireWrite(principal, method);
  const photo = path.endsWith('vehicle-photo'), lead = path.endsWith('/lead');
  const b = parseBody(request.body, bodyLimit(method, path));
  onlyKeys(b, photo ? ['mediaType', 'dataBase64'] : ['text']);
  let image: {mediaType: string; dataBase64: string} | undefined; let prompt = '';
  if (photo) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(b.mediaType))) throw invalid('Use a JPEG, PNG, WebP or GIF image.');
    const data = b.dataBase64;
    if (typeof data !== 'string' || !data.length || data.length > PHOTO_BASE64_LIMIT || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || Buffer.from(data, 'base64').toString('base64') !== data) throw invalid('Use a base64 image of at most 5 MiB.');
    image = {mediaType: String(b.mediaType), dataBase64: data};
  } else prompt = text(b.text, 'Quick entry text', 2000);
  // Meter every validated attempt, including unavailable/unsupported/failed calls. No content retained.
  await repo.appendUsage({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, kind: photo ? 'vehicle-photo' : lead ? 'lead-text' : 'vehicle-text', occurredAt: now.toISOString()});
  if (!provider.configured) throw unavailable();
  if (photo && !provider.supportsVision) throw visionUnsupported();
  let raw: Record<string, unknown>;
  try { raw = image ? await provider.extractVehiclePhoto(image) : lead ? await provider.extractLead(prompt) : await provider.extractVehicle(prompt); }
  catch { throw providerFailure(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw providerFailure();
  return response(200, {data: {draft: lead ? sanitizeLead(raw) : sanitizeVehicle(raw, now)}});
}

/** Outcome signals share the existing usage ledger; they do not represent billable calls. */
export async function meterQuickEntryOutcome(repo: TenantRepository, principal: Principal, now: Date, signal: Extract<import('@freedms/shared').BehavioralEvent, {event: 'quick_entry_used'}>) {
  await repo.appendUsage({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, kind: signal.surface === 'lead' ? 'lead-text' : signal.input === 'photo' ? 'vehicle-photo' : 'vehicle-text', occurredAt: now.toISOString(), signal});
}
