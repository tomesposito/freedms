import { effectiveVehiclePhotos, MAX_VEHICLE_PHOTO_BYTES, MAX_VEHICLE_PHOTOS, VEHICLE_PHOTO_PART_BYTES, vehiclePhotoUrl, type VehiclePhoto, type VehicleView } from '@freedms/shared';
import { escapeHtml as e } from './format';

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type QueuedPhoto = {source: 'queued'; file: File; preview: string};

function src(photo: VehiclePhoto, vehicle: VehicleView, base: string, size: 'display' | 'thumb') {
  const url = vehiclePhotoUrl(photo, vehicle.tenantId, base, size);
  return photo.source === 'upload' || /^https?:\/\//i.test(url) ? url : '';
}
export function inventoryPhoto(vehicle: VehicleView, base: string) {
  const photo = effectiveVehiclePhotos(vehicle)[0];
  const url = photo && src(photo, vehicle, base, 'thumb');
  return url ? `<img class="inventory-photo" src="${e(url)}" alt="" loading="lazy">` : '<span class="inventory-photo">No photo</span>';
}

export const vehiclePhotosCard = '<section class="card vehicle-photos" aria-label="Photos"></section>';

export function encode(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export async function resize(bitmap: ImageBitmap, type: string, edge: number, cap: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const longest = Math.max(bitmap.width, bitmap.height);
  for (let scale = Math.min(1, edge / longest); scale >= Math.min(1, edge / longest) / 8; scale *= 0.7) {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.82));
    if (blob?.type === type && blob.size <= cap) return blob;
  }
  throw new Error('Could not prepare this image.');
}
async function prepare(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > MAX_VEHICLE_PHOTO_BYTES) {
    throw new Error('Choose a JPEG, PNG or WebP file up to 10 MiB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const [display, thumb] = await Promise.all([
      resize(bitmap, file.type, 1600, 512 * 1024),
      resize(bitmap, file.type, 480, 128 * 1024),
    ]);
    return {name: file.name.slice(0, 160), type: file.type,
      display: await encode(display), thumb: await encode(thumb)};
  } finally { bitmap.close(); }
}

export function mountVehiclePhotos(card: HTMLElement, initial: VehicleView | undefined, api: Api, base: string, onChange: (vehicle: VehicleView) => void, prepEntry?: (element: HTMLElement, id: string) => void) {
  let vehicle = initial;
  let photos: (VehiclePhoto | QueuedPhoto)[] = initial ? effectiveVehiclePhotos(initial) : [];
  let busy = false;
  let urlOpen = false;
  let draftPhoto: File | undefined;
  let draftCheckbox: HTMLInputElement | undefined;
  const messages = document.createElement('ul');
  messages.className = 'photo-messages';
  messages.setAttribute('aria-live', 'polite');
  const report = (message: string) => {
    const item = document.createElement('li');
    item.textContent = message;
    messages.append(item);
    return item;
  };
  const accept = (saved: VehicleView) => { vehicle = saved; onChange(saved); };
  const photoSrc = (photo: VehiclePhoto | QueuedPhoto, size: 'display' | 'thumb') =>
    photo.source === 'queued' ? photo.preview : photo.source === 'url' ? (/^https?:\/\//i.test(photo.url) ? photo.url : '') :
      vehicle ? src(photo, vehicle, base, size) : '';
  const setBusy = (value: boolean) => {
    busy = value;
    card.setAttribute('aria-busy', String(value));
    card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(input => {
      input.disabled = value || input.hasAttribute('data-unavailable');
    });
  };
  async function save(next: typeof photos) {
    if (busy) return;
    messages.replaceChildren();
    setBusy(true);
    try {
      if (vehicle) {
        const {id, tenantId, version, createdAt, updatedAt, agingDays, reconTotal, photos: _photos, photoUrls, ...fields} = vehicle;
        accept(await api<VehicleView>(`/vehicles/${id}`, 'PUT', {...fields, version, photos: next}));
        photos = effectiveVehiclePhotos(vehicle);
      } else {
        photos.filter((photo): photo is QueuedPhoto => photo.source === 'queued' && !next.includes(photo))
          .forEach(photo => URL.revokeObjectURL(photo.preview));
        photos = next;
      }
    } catch (error) { report(error instanceof Error ? error.message : 'Could not save photos.'); }
    finally { setBusy(false); render(); }
  }
  async function upload(file: File) {
    const progress = report(`${file.name} · Preparing…`);
    const path = `/vehicles/${vehicle!.id}/photos`;
    const version = vehicle!.version;
    const uploadId = crypto.randomUUID();
    let staged = false;
    try {
      const data = await prepare(file);
      const parts = Math.ceil(file.size / VEHICLE_PHOTO_PART_BYTES);
      for (let part = 0; part < parts; part++) {
        progress.textContent = `${file.name} · Uploading ${part + 1} of ${parts}…`;
        const start = part * VEHICLE_PHOTO_PART_BYTES;
        const bytes = await encode(file.slice(start, start + VEHICLE_PHOTO_PART_BYTES));
        staged = true;
        await api(path, 'POST', {uploadId, version, part, bytes});
      }
      accept(await api<VehicleView>(path, 'POST', {uploadId, version, parts, ...data}));
      progress.textContent = `${file.name} · Uploaded`;
      return true;
    } catch (error) {
      if (staged) await api(path, 'POST', {uploadId, discard: true}).catch(() => {});
      progress.textContent = `${file.name} · ${error instanceof Error ? error.message : 'Upload failed.'}`;
      return false;
    }
  }
  async function addFiles(files: File[]) {
    if (busy || !files.length) return;
    messages.replaceChildren();
    setBusy(true);
    try {
      for (const file of files) {
        if (photos.length >= MAX_VEHICLE_PHOTOS) { report(`${file.name} · The vehicle already has 20 photos.`); continue; }
        if (vehicle) {
          if (await upload(file)) photos = effectiveVehiclePhotos(vehicle);
        } else if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > MAX_VEHICLE_PHOTO_BYTES) {
          report(`${file.name} · Choose a JPEG, PNG or WebP file up to 10 MiB.`);
        } else {
          photos.push({source: 'queued', file, preview: URL.createObjectURL(file)});
        }
      }
    } finally { setBusy(false); render(); }
  }
  function move(from: number, to: number) {
    const next = photos.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    void save(next);
  }
  function render() {
    if (draftCheckbox) draftCheckbox.checked = photos.some(photo => photo.source === 'queued' && photo.file === draftPhoto);
    card.innerHTML = `<h2>Photos</h2>${photos.length ? `
      <a class="vehicle-gallery" href="${e(photoSrc(photos[0], 'display'))}" target="_blank" rel="noopener"><img src="${e(photoSrc(photos[0], 'display'))}" alt="Vehicle cover photo"></a>
      <div class="photo-grid">${photos.map((photo, index) => `
        <div class="photo-tile">
          <a href="${e(photoSrc(photo, 'display'))}" target="_blank" rel="noopener"><img src="${e(photoSrc(photo, 'thumb'))}" alt="Vehicle photo ${index + 1}" loading="lazy"></a>
          ${index === 0 ? '<span class="photo-cover">COVER</span>' : ''}
          <div class="photo-caption">${e(photo.source === 'upload' ? photo.name : photo.source === 'queued' ? photo.file.name : `Photo ${index + 1}`)}</div>
          <div class="photo-tile-actions">
            <button type="button" data-move="${index - 1}" data-index="${index}" aria-label="Move photo ${index + 1} earlier" ${index === 0 ? 'disabled data-unavailable' : ''}>←</button>
            <button type="button" data-move="${index + 1}" data-index="${index}" aria-label="Move photo ${index + 1} later" ${index === photos.length - 1 ? 'disabled data-unavailable' : ''}>→</button>
            ${index ? `<button type="button" data-move="0" data-index="${index}">Set cover</button>` : ''}
            <button type="button" data-delete="${index}" aria-label="Delete photo ${index + 1}">Delete</button>
          </div>
        </div>`).join('')}</div>` : '<p>No photos yet.</p><p class="muted">Cars with photos are the ones shoppers open. Add photos here and they appear on your website and feeds after you save.</p>'}
      <div class="photo-actions">
        <input type="file" accept="image/*" multiple hidden>
        <button type="button" class="primary" data-add>Add photos</button>
        <button type="button" data-url>Add by URL</button>
        ${photos.length && prepEntry ? '<span data-prep-entry></span>' : ''}
      </div>
      ${urlOpen ? '<div class="photo-actions"><label>Photo URL<input type="url" maxlength="2000" placeholder="https://"></label><button type="button" data-save-url>Add URL</button></div>' : ''}
      ${photos.length ? '<p class="muted">Use the arrows to reorder. The first photo is the cover. It leads the inventory list, your website, and the Facebook feed.</p>' : ''}`;
    card.append(messages);
    const entry = card.querySelector<HTMLElement>('[data-prep-entry]');
    if (entry && vehicle) prepEntry?.(entry, vehicle.id);
    const input = card.querySelector<HTMLInputElement>('input[type=file]')!;
    input.onchange = () => void addFiles(Array.from(input.files ?? []));
    card.querySelector<HTMLButtonElement>('[data-add]')!.onclick = () => input.click();
    card.querySelector<HTMLButtonElement>('[data-url]')!.onclick = () => {
      urlOpen = !urlOpen;
      render();
      card.querySelector<HTMLInputElement>('input[type=url]')?.focus();
    };
    card.querySelector<HTMLButtonElement>('[data-save-url]')?.addEventListener('click', () => {
      const field = card.querySelector<HTMLInputElement>('input[type=url]')!;
      const url = field.value.trim();
      if (!field.reportValidity() || !/^https?:\/\//i.test(url)) { report('Enter an HTTP(S) photo URL.'); return; }
      if (photos.length >= MAX_VEHICLE_PHOTOS) { report('The vehicle already has 20 photos.'); return; }
      urlOpen = false;
      void save([...photos, {source: 'url', url}]);
    });
    card.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button =>
      button.onclick = () => move(Number(button.dataset.index), Number(button.dataset.move)));
    card.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(button =>
      button.onclick = () => void save(photos.filter((_, index) => index !== Number(button.dataset.delete))));
  }
  card.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  card.addEventListener('drop', event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    void addFiles(Array.from(event.dataTransfer.files));
  });
  render();
  return {
    offerSourcePhoto(file: File, checkbox: HTMLInputElement) {
      draftPhoto = file;
      draftCheckbox = checkbox;
      photos.unshift({source: 'queued', file, preview: URL.createObjectURL(file)});
      checkbox.addEventListener('change', () => {
        if (busy) { render(); return; }
        const include = checkbox.checked;
        const index = photos.findIndex(photo => photo.source === 'queued' && photo.file === file);
        if (include && index < 0 && photos.length < MAX_VEHICLE_PHOTOS) {
          photos.unshift({source: 'queued', file, preview: URL.createObjectURL(file)});
        } else if (!include && index >= 0) {
          const [removed] = photos.splice(index, 1);
          if (removed.source === 'queued') URL.revokeObjectURL(removed.preview);
        }
        render();
      });
      render();
    },
    busy: () => busy,
    setBusy,
    urlsForCreate: () => photos.filter((photo): photo is Extract<VehiclePhoto, {source: 'url'}> => photo.source === 'url'),
    async finishCreate(saved: VehicleView) {
      const requested = photos.slice();
      const ordered: VehiclePhoto[] = [];
      let failed = false;
      accept(saved);
      if (draftCheckbox) draftCheckbox.closest('label')?.remove();
      setBusy(true);
      try {
        for (const photo of requested) {
          if (photo.source !== 'queued') ordered.push(photo);
          else {
            if (await upload(photo.file)) ordered.push(effectiveVehiclePhotos(vehicle!).at(-1)!);
            else failed = true;
            URL.revokeObjectURL(photo.preview);
          }
        }
        if (requested.some(photo => photo.source === 'url') && requested.some(photo => photo.source === 'queued')) {
          const {id, tenantId, version, createdAt, updatedAt, agingDays, reconTotal, photos: _photos, photoUrls, ...fields} = vehicle!;
          accept(await api<VehicleView>(`/vehicles/${id}`, 'PUT', {...fields, version, photos: ordered}));
        }
        return !failed;
      } finally {
        photos = effectiveVehiclePhotos(vehicle!);
        setBusy(false);
        render();
      }
    },
  };
}
