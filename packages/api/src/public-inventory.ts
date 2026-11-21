import type { DocumentStore } from './document-store.js';
import { projectedPhotoUrls, serveVehiclePhoto } from './vehicle-photos.js';
import { facebookCsv, newestFacebookRun } from './facebook-feed.js';
import type { Vehicle } from '@freedms/shared';
import { ApiError, missing } from './errors.js';
import { response, type ApiRequest, type ApiResponse } from './handler.js';
import type { RepositoryFactory } from './repository.js';

export function buildPublicInventory(dealer: string, vehicles: Vehicle[], photoBase = '') {
  return {
    '@context': 'https://schema.org', '@type': 'ItemList', name: `${dealer} — Inventory`,
    numberOfItems: vehicles.filter(v => v.status === 'available').length,
    itemListElement: vehicles.filter(v => v.status === 'available')
      .sort((a, b) => a.stockNumber.localeCompare(b.stockNumber) || a.id.localeCompare(b.id))
      .map((v, i) => {
        const image = projectedPhotoUrls(v, photoBase);
        return {
          '@type': 'ListItem', position: i + 1,
          item: {
            '@type': 'Offer', availability: 'https://schema.org/InStock',
            itemCondition: 'https://schema.org/UsedCondition', price: v.listPrice / 100, priceCurrency: 'USD',
            seller: {'@type': 'AutoDealer', name: dealer},
            itemOffered: {
              '@type': 'Car', name: [v.year, v.make, v.model, v.trim].filter(String).join(' '),
              vehicleIdentificationNumber: v.vin, modelDate: v.year,
              brand: {'@type': 'Brand', name: v.make}, model: v.model, vehicleModelDate: v.year,
              ...(v.mileage === null ? {} : {mileageFromOdometer: {'@type': 'QuantitativeValue', value: v.mileage, unitCode: 'SMI'}}),
              sku: v.stockNumber,
              ...(image.length ? {image} : {}),
            },
          },
        };
      }),
  };
}
export const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
export function publicInventoryHtml(dealer: string, document: ReturnType<typeof buildPublicInventory>): string {
  const list = document.itemListElement.map(({item: offer}) => {
    const car = offer.itemOffered;
    return `<li><h2>${escapeHtml(car.name)}</h2><p>$${escapeHtml(offer.price.toFixed(2))}</p>${car.mileageFromOdometer ? `<p>Mileage: ${escapeHtml(car.mileageFromOdometer.value)} miles</p>` : ''}<p>VIN: ${escapeHtml(car.vehicleIdentificationNumber)}</p><p>Stock number: ${escapeHtml(car.sku)}</p></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(document.name)}</title><script type="application/ld+json">${JSON.stringify(document).replace(/</g, '\\u003c')}</script></head><body><h1>${escapeHtml(dealer)}</h1>${list ? `<ul>${list}</ul>` : '<p>No vehicles are currently available.</p>'}</body></html>`;
}

export function createPublicInventoryHandler(documents?: DocumentStore, photoBase = '') {
  // Best-effort per-process protection only: Lambda instances do not share buckets.
  const buckets = new Map<string, {start: number; count: number}>();
  return async (request: ApiRequest, repositories: RepositoryFactory, now: Date): Promise<ApiResponse> => {
    const match = /^\/public\/([\w-]{1,128})\/(inventory\.json|inventory\.html|llms\.txt|facebook\.csv|photos\/([\w-]{1,128}))$/.exec(request.path);
    if (!match || Object.keys(request.query ?? {}).length) throw missing();
    if (request.method.toUpperCase() !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const [, tenantId, format, photoId] = match;
    const repo = repositories.forTenant(tenantId), tenant = await repo.tenant();
    if (!tenant) throw missing();
    const time = now.getTime();
    // Expire idle keys so public traffic cannot accumulate buckets indefinitely.
    for (const [key, bucket] of buckets) if (time - bucket.start >= 60000) buckets.delete(key);
    const key = `${tenantId}:${request.sourceIp ?? 'shared'}`;
    const bucket = buckets.get(key) ?? {start: time, count: 0};
    buckets.set(key, bucket);
    if (++bucket.count > 120) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    if (photoId) return serveVehiclePhoto(repo, photoId, documents?.forTenant(tenantId));
    if (format === 'facebook.csv') {
      if (!(await repo.feedConfig())?.facebookEnabled) throw missing();
      const latest = newestFacebookRun(await repo.feedRuns());
      if (!latest) throw missing();
      const result = response(200, null);
      result.headers['content-type'] = 'text/csv; charset=utf-8';
      result.body = facebookCsv(latest.facebookRows!);
      return result;
    }
    const document = buildPublicInventory(tenant.name, await repo.list({}), photoBase);
    const result = response(200, document);
    if (format === 'inventory.html') {
      result.headers['content-type'] = 'text/html; charset=utf-8';
      result.body = publicInventoryHtml(tenant.name, document);
    } else if (format === 'llms.txt') {
      result.headers['content-type'] = 'text/plain; charset=utf-8';
      result.body = `# ${tenant.name}\n\nInventory:\n- /public/${tenantId}/inventory.json\n- /public/${tenantId}/inventory.html\n- /public/${tenantId}/site/\n`;
    }
    return result;
  };
}
