import { createHash, randomUUID } from 'node:crypto';
import { effectiveVehiclePhotos, MAX_VEHICLE_PHOTO_BYTES, MAX_VEHICLE_PHOTOS, VEHICLE_PHOTO_PART_BYTES, vehiclePhotoUrl, type Vehicle, type VehiclePhoto, type VehiclePhotoType } from '@freedms/shared';
import type { DocumentStore } from './document-store.js';
import { ApiError, missing } from './errors.js';
import type { ApiResponse } from './handler.js';
import type { TenantRepository } from './repository.js';
import { invalid, object, onlyKeys, text } from './validation.js';

export const VEHICLE_PHOTO_BODY_LIMIT = VEHICLE_PHOTO_PART_BYTES / 3 * 4 + 1024;
export const vehiclePhotoBase = (appBaseUrl?: string) => appBaseUrl ? `${appBaseUrl.replace(/\/$/, '')}/api` : '';
export const projectedPhotoUrls = (vehicle: Vehicle, base = '', size: 'display' | 'thumb' = 'display') =>
  effectiveVehiclePhotos(vehicle).map(photo => vehiclePhotoUrl(photo, vehicle.tenantId, base, size));

export function selectVehiclePhotos(input: unknown, existing?: Vehicle): VehiclePhoto[] {
  if (!Array.isArray(input) || input.length > MAX_VEHICLE_PHOTOS) throw invalid('Use at most 20 vehicle photos.');
  const uploads = new Map(effectiveVehiclePhotos(existing ?? {}).flatMap(photo => photo.source === 'upload' ? [[photo.id, photo]] : []));
  return input.map(value => {
    const photo = object(value);
    if (photo.source === 'url') {
      onlyKeys(photo, ['source', 'url']);
      if (typeof photo.url !== 'string' || photo.url.length > 2000 || !/^https?:\/\//i.test(photo.url)) throw invalid('Use an HTTP(S) photo URL.');
      return {source: 'url', url: photo.url};
    }
    if (photo.source !== 'upload' || typeof photo.id !== 'string') throw invalid('Invalid vehicle photo.');
    const upload = uploads.get(photo.id);
    if (!upload) throw invalid('Select an uploaded photo from this vehicle.');
    uploads.delete(photo.id);
    return upload;
  });
}

function decodeBytes(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw invalid('Invalid photo data or size.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) throw invalid('Invalid photo data or size.');
  return bytes;
}

function verifyPhotoType(bytes: Buffer, type: VehiclePhotoType): Buffer {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'image/jpeg' ? !jpeg : type === 'image/png' ? !png : !webp) throw invalid('Photo data must match its JPEG, PNG or WebP file type and size limit.');
  return bytes;
}

type TenantDocuments = ReturnType<DocumentStore['forTenant']>;
const maxParts = Math.ceil(MAX_VEHICLE_PHOTO_BYTES / VEHICLE_PHOTO_PART_BYTES);

export function vehiclePhotoPartKeys(vehicleId: string, userId: string, uploadId: unknown) {
  if (typeof uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(uploadId)) throw invalid('Invalid upload ID.');
  // Hash the scope to keep keys under DocumentStore's identifier limit.
  const scope = createHash('sha256').update(JSON.stringify([vehicleId, userId, uploadId])).digest('hex');
  return Array.from({length: maxParts}, (_, index) => `vehicle-photo-part-${scope}-${index}`);
}
export async function clearVehiclePhotoParts(store: TenantDocuments, keys: string[]) {
  const results = await Promise.allSettled(keys.map(key => store.remove(key)));
  if (results.some(result => result.status === 'rejected')) console.error('Vehicle photo part cleanup failed');
}

export async function readVehiclePhotoUpload(input: Record<string, unknown>, vehicleId: string, date: Date, store: TenantDocuments, keys: string[]) {
  onlyKeys(input, ['version', 'uploadId', 'name', 'type', 'parts', 'display', 'thumb']);
  const name = text(input.name, 'Photo name', 160);
  const type = input.type;
  if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp') throw invalid('Use JPEG, PNG or WebP photos.');
  const count = input.parts;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > maxParts) throw invalid('Invalid upload part count.');
  const parts = await Promise.all(keys.slice(0, count).map(key => store.get(key)));
  const buffers: Uint8Array[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part || (index < count - 1 && part.length !== VEHICLE_PHOTO_PART_BYTES)) throw invalid('Upload is incomplete.');
    buffers.push(part);
  }
  const original = verifyPhotoType(Buffer.concat(buffers), type);
  if (original.length > MAX_VEHICLE_PHOTO_BYTES) throw invalid('Use a photo up to 10 MiB.');
  const display = verifyPhotoType(decodeBytes(input.display, 512 * 1024), type);
  const thumb = verifyPhotoType(decodeBytes(input.thumb, 128 * 1024), type);
  const id = `${vehicleId}_${randomUUID()}`;
  const photo: VehiclePhoto = {id, source: 'upload', name, type, size: original.length, createdAt: date.toISOString()};
  return {photo, files: [[id, original], [`${id}-display`, display], [`${id}-thumb`, thumb]] as const};
}

export async function stageVehiclePhotoPart(store: TenantDocuments, keys: string[], input: Record<string, unknown>) {
  onlyKeys(input, ['version', 'uploadId', 'part', 'bytes']);
  const index = input.part;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= maxParts) throw invalid('Invalid upload part.');
  await store.put(keys[index], decodeBytes(input.bytes, VEHICLE_PHOTO_PART_BYTES));
}

export async function removeVehiclePhotos(store: ReturnType<DocumentStore['forTenant']> | undefined, previous: Vehicle, next?: Vehicle) {
  if (!store) return;
  const retained = new Set(next?.photos?.flatMap(photo => photo.source === 'upload' ? [photo.id] : []));
  const keys = previous.photos?.flatMap(photo => photo.source === 'upload' && !retained.has(photo.id)
    ? [photo.id, `${photo.id}-display`, `${photo.id}-thumb`] : []) ?? [];
  const results = await Promise.allSettled(keys.map(key => store.remove(key)));
  if (results.some(result => result.status === 'rejected')) console.error('Vehicle photo storage cleanup failed');
}

export async function serveVehiclePhoto(repo: TenantRepository, id: string, store?: ReturnType<DocumentStore['forTenant']>): Promise<ApiResponse> {
  const originalId = id.replace(/-thumb$/, '');
  const match = /^([\w-]+)_[a-f0-9-]{36}$/.exec(originalId);
  if (!match) throw missing();
  const vehicle = await repo.get(match[1]);
  const photo = vehicle?.photos?.find(photo => photo.source === 'upload' && photo.id === originalId);
  if (!photo || photo.source !== 'upload') throw missing();
  const key = id !== originalId ? id : `${id}-display`;
  const bytes = await store?.get(key);
  if (!bytes) throw missing();
  return {statusCode: 200, headers: {'content-type': photo.type, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff'},
    body: Buffer.from(bytes).toString('base64'), isBase64Encoded: true};
}
export function requireVehiclePhotoStore(documents: DocumentStore | undefined, tenantId: string) {
  if (!documents) throw new ApiError(503, 'UNAVAILABLE', 'Vehicle photo storage is unavailable.');
  return documents.forTenant(tenantId);
}
