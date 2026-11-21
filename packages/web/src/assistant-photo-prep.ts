import { effectiveVehiclePhotos, MAX_VEHICLE_PHOTO_BYTES, MAX_VEHICLE_PHOTOS, PHOTO_PREP_IMAGE_BYTES, vehiclePhotoUrl, type PhotoPrepImage, type PhotoPrepSuggestion, type VehicleView } from '@freedms/shared';
import { escapeHtml as e } from './format';
import { encode, resize } from './vehicle-photos';

export interface PhotoPrepScope {
  vehicle: VehicleView;
  selected: Set<number>;
  mode: 'whole' | 'selected' | 'description';
}
export interface PrepMedia {
  display: string;
  thumb: string;
  hero: string;
  feed: string;
}
export interface PrepReview {
  scope: PhotoPrepScope;
  suggestions: PhotoPrepSuggestion[];
  missing: string[];
  version: number;
  media: Map<number, PrepMedia>;
  order: number[];
  vehiclePhotoCount: number;
}

function photoUrl(vehicle: VehicleView, index: number, size: 'thumb' | 'display') {
  const photo = effectiveVehiclePhotos(vehicle)[index];
  if (!photo) return '';
  if (photo.source === 'url') return /^https?:\/\//i.test(photo.url) ? photo.url : '';
  const base = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
  return vehiclePhotoUrl(photo, vehicle.tenantId, base, size);
}

async function crop(bitmap: ImageBitmap, ratio: number, edge: number, bytes: number) {
  const width = Math.min(bitmap.width, bitmap.height * ratio);
  const height = width / ratio;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - width) / 2, (bitmap.height - height) / 2,
    width, height, 0, 0, canvas.width, canvas.height);
  const cropped = await createImageBitmap(canvas);
  try { return await encode(await resize(cropped, 'image/jpeg', edge, bytes)); }
  finally { cropped.close(); }
}

async function preparePhoto(scope: PhotoPrepScope, index: number): Promise<{image: PhotoPrepImage; media?: PrepMedia}> {
  try {
    const url = photoUrl(scope.vehicle, index, 'display');
    if (!url) throw new Error('Photo unavailable');
    const response = await fetch(url, {credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000)});
    if (!response.ok) throw new Error('Photo unavailable');
    const blob = await response.blob();
    if (blob.size > MAX_VEHICLE_PHOTO_BYTES) throw new Error('Photo is too large');
    const bitmap = await createImageBitmap(blob);
    let jpeg: string, quality: number;
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', {willReadFrequently: true})!;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixel = image.data;
      const sum = [0, 0, 0];
      const levels = new Uint32Array(256);
      let edges = 0, samples = 0;
      for (let y = 0; y < canvas.height; y += 4) {
        for (let x = 0; x < canvas.width; x += 4) {
          const at = (y * canvas.width + x) * 4;
          for (let c = 0; c < 3; c++) sum[c] += pixel[at + c];
          const luminance = Math.round(pixel[at] * 0.2126 + pixel[at + 1] * 0.7152 + pixel[at + 2] * 0.0722);
          levels[luminance]++;
          if (x) edges += Math.abs(pixel[at + 1] - pixel[at - 3]);
          if (y) edges += Math.abs(pixel[at + 1] - pixel[at + 1 - canvas.width * 4]);
          samples++;
        }
      }
      quality = Math.min(50, bitmap.width * bitmap.height / 40_000) + Math.min(50, edges / samples);
      jpeg = await encode(await resize(bitmap, 'image/jpeg', 1200, PHOTO_PREP_IMAGE_BYTES));
      const means = sum.map(value => value / samples);
      const gray = means.reduce((total, value) => total + value, 0) / 3;
      const balance = means.map(value => Math.max(0.85, Math.min(1.15, gray / Math.max(value, 1))));
      let low = 0, high = 255, below = 0, above = 0;
      while (low < 64 && below + levels[low] < samples * 0.02) below += levels[low++];
      while (high > 192 && above + levels[high] < samples * 0.02) above += levels[high--];
      const gain = Math.min(1.2, 255 / (high - low));
      for (let at = 0; at < pixel.length; at += 4) {
        for (let c = 0; c < 3; c++) pixel[at + c] = (pixel[at + c] * balance[c] - low) * gain;
      }
      context.putImageData(image, 0, 0);
      const corrected = await createImageBitmap(canvas);
      try {
        const [display, thumb, hero, feed] = await Promise.all([
          resize(corrected, 'image/jpeg', 1200, PHOTO_PREP_IMAGE_BYTES).then(encode),
          crop(corrected, 1, 480, 24 * 1024),
          crop(corrected, 16 / 9, 1200, 48 * 1024),
          crop(corrected, 4 / 3, 1024, 32 * 1024),
        ]);
        return {image: {index, jpeg, quality}, media: {display, thumb, hero, feed}};
      } finally { corrected.close(); }
    } finally { bitmap.close(); }
  } catch {
    // A linked image may block cross-origin reads. Report that photo as failed.
    return {image: {index}};
  }
}
export async function preparePhotoInputs(scope: PhotoPrepScope) {
  const images: PhotoPrepImage[] = [];
  const media = new Map<number, PrepMedia>();
  if (scope.mode !== 'description') {
    for (const index of scope.selected) {
      const result = await preparePhoto(scope, index);
      images.push(result.image);
      if (result.media) media.set(index, result.media);
    }
  }
  return {images, media};
}

export function scopeHtml(scope: PhotoPrepScope, balance: number, cap: number, overage: number, price: number, busy: boolean) {
  const photos = effectiveVehiclePhotos(scope.vehicle);
  const count = scope.mode === 'description' ? 1 : scope.selected.size;
  const estimate = count * price;
  const tooMuch = estimate > cap || estimate > balance + overage;
  return `<div class="assistant-user">Prep photos for ${e(scope.vehicle.stockNumber)}</div>
    <p>Choose photos to review for cover order, light and color, VIN, mileage, damage, and a listing description.</p>
    <fieldset class="prep-scope" ${busy ? 'disabled' : ''}><legend>Photo prep scope</legend>
    <label><input type="radio" name="prep-scope" value="whole" ${scope.mode === 'whole' ? 'checked' : ''}> Whole vehicle</label>
    <label><input type="radio" name="prep-scope" value="selected" ${scope.mode === 'selected' ? 'checked' : ''}> Selected photos</label>
    <label><input type="radio" name="prep-scope" value="description" ${scope.mode === 'description' ? 'checked' : ''}> Listing description only</label>
    ${scope.mode === 'selected' ? `<div class="prep-pick">${photos.map((_, index) =>
      `<label><img src="${e(photoUrl(scope.vehicle, index, 'thumb'))}" alt=""><span><input type="checkbox" data-prep-photo="${index}" ${scope.selected.has(index) ? 'checked' : ''}> Photo ${index + 1}</span></label>`).join('')}</div>` : ''}
    </fieldset>
    <div class="assistant-note prep-estimate"><strong>${scope.mode === 'description' ? 'Listing description' : `Photo prep · ${count} × ${price}`} = ${estimate} credits</strong><br>
    Your balance is ${e(balance)} credits. Failed photos and deterministic work are free.
    ${tooMuch ? `<br>${estimate > cap ? `This pass exceeds the ${cap}-credit request cap. Choose fewer photos.` : 'Choose fewer photos or add credits.'}` : ''}</div>
    <div class="prep-actions"><button class="primary" type="button" data-prep-run ${busy || tooMuch || !count ? 'disabled' : ''}>Run photo prep · ${estimate} credits</button>
    <button type="button" data-prep-cancel ${busy ? 'disabled' : ''}>Not now</button></div>`;
}

export function reviewHtml(review: PrepReview, index: number, busy: boolean, locked: boolean) {
  if (!review.suggestions.length && !review.missing.length) return '';
  const beforeAfter = (before: string, after: string, labels: [string, string]) => `<div class="prep-comparison">${[before, after].map((url, index) =>
    `<figure><img src="${e(url)}" alt=""><figcaption>${labels[index]}</figcaption></figure>`).join('')}</div>`;
  const disabled = busy || locked ? 'disabled' : '';
  const lightFits = review.vehiclePhotoCount < MAX_VEHICLE_PHOTOS;
  const rows = review.suggestions.map((suggestion, i) => {
    let title: string, body: string;
    let approve = true;
    const vehicle = review.scope.vehicle;
    switch (suggestion.kind) {
      case 'hero':
        title = 'Hero pick';
        body = `<p>Proposed order · ${suggestion.order.map(n => `Photo ${n + 1}`).join(' → ')}</p>` + beforeAfter(photoUrl(vehicle, 0, 'thumb'), photoUrl(vehicle, suggestion.order[0], 'thumb'), ['Current cover', 'Suggested cover']);
        break;
      case 'light': {
        title = `Light & color fix · Photo ${suggestion.index + 1}`;
        const media = review.media.get(suggestion.index);
        approve = !!media && lightFits;
        body = media ? beforeAfter(photoUrl(vehicle, suggestion.index, 'display'), `data:image/jpeg;base64,${media.display}`, ['Before', 'After']) : '<p>Preview unavailable.</p>';
        if (!lightFits) body += '<p>The vehicle has reached its 20-photo limit.</p>';
        break;
      }
      case 'vin':
        title = `VIN plate · Photo ${suggestion.index + 1}`;
        body = `<p>${e(suggestion.vin)} · ${suggestion.matches ? 'Matches record' : `Mismatch with record VIN ${e(vehicle.vin)}`}</p>`;
        approve = false;
        break;
      case 'mileage':
        title = `Odometer · Photo ${suggestion.index + 1}`;
        body = `<p>Read ${e(suggestion.mileage.toLocaleString())} mi · Record ${vehicle.mileage === null ? 'unset' : `${e(vehicle.mileage.toLocaleString())} mi`}</p>`;
        break;
      case 'damage':
        title = `Damage flag · Photo ${suggestion.index + 1}`;
        body = `<p>${e(suggestion.note)}</p><p>Approval adds a note for reconditioning.</p>`;
        break;
      case 'description':
        title = 'Listing description draft';
        body = `<label>Edit description<textarea data-prep-description="${i}" maxlength="5000" rows="4" ${disabled}>${e(suggestion.text)}</textarea></label>`;
        break;
    }
    return `<section class="prep-suggestion"><h3>${e(title)}</h3>${body}<div class="prep-actions">
      ${approve ? `<button type="button" class="primary" data-prep-approve="${i}" ${disabled}>Approve</button>` : ''}
      <button type="button" data-prep-dismiss="${i}" ${busy ? 'disabled' : ''}>Dismiss</button></div></section>`;
  });
  const lights = review.suggestions.filter(s => s.kind === 'light' && review.media.has(s.index)).length;
  const mileage = new Set(review.suggestions.flatMap(s => s.kind === 'mileage' ? [s.mileage] : []));
  const hasApprovable = lights > 0 || review.suggestions.some(s => s.kind !== 'vin' && s.kind !== 'light');
  const canApproveAll = review.vehiclePhotoCount + lights <= MAX_VEHICLE_PHOTOS && mileage.size <= 1 && hasApprovable;
  return `<div class="prep-review" data-prep-review="${index}">${rows.join('')}
    ${review.missing.length ? `<p class="assistant-note">Missing from reviewed photos · ${e(review.missing.join(', '))}</p>` : ''}
    <div class="prep-actions">${canApproveAll ? `<button type="button" class="primary" data-prep-approve-all ${disabled}>Approve all</button>` : ''}
    <button type="button" data-prep-dismiss-all ${busy ? 'disabled' : ''}>Dismiss all</button></div></div>`;
}

export function approvalFields(review: PrepReview, accepted: PhotoPrepSuggestion[]) {
  const index = (value: number) => review.order.indexOf(value);
  const fields: {order?: number[]; mileage?: number; listingDescription?: string; damage: object[]; derivatives: object[]} = {damage: [], derivatives: []};
  for (const row of accepted) {
    switch (row.kind) {
      case 'hero': fields.order = [...row.order, ...review.order.filter(i => !row.order.includes(i))].map(index); break;
      case 'light': {
        const media = review.media.get(row.index);
        if (media) fields.derivatives.push({index: index(row.index), ...media});
        break;
      }
      case 'mileage': fields.mileage = row.mileage; break;
      case 'description': fields.listingDescription = row.text; break;
      case 'damage': fields.damage.push({index: index(row.index), note: row.note}); break;
    }
  }
  return fields;
}
