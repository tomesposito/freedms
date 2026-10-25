import { createHash } from 'node:crypto';
import { pencilMath, repairOrderTotals, signatureStatusFor, targetSignatures, type Deal, type DealDocument, type RepairOrder, type SignatureRecord, type SignatureStatus } from '@freedms/shared';
import type { TenantRepository } from './repository.js';
import type { DocumentStore } from './document-store.js';
import { missing } from './errors.js';
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v) ?? 'null').join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Shared assembly for the generated jacket packet and its signing snapshot. */
export async function packetInputs(repo: TenantRepository, deal: Deal) {
  const [vehicle, customer] = await Promise.all([repo.get(deal.vehicleId), repo.crmGet('customer', deal.customerId)]);
  const pencil = deal.pencils.find(p => p.id === deal.workingPencilId);
  if (!vehicle || !customer || !pencil) throw missing();
  return {deal: {...deal, vehicle, customer}, pencil, numbers: pencilMath(pencil, deal.trade, deal, vehicle, deal.type), fiProducts: pencil.fiSelections.filter(s => s.status === 'accepted').map(({name, category, retailPrice, termNotes}) => ({name, category, retailPrice, termNotes}))};
}
export function packetHash(packet: Awaited<ReturnType<typeof packetInputs>>) {
  const {deal: d, pencil, numbers, fiProducts} = packet, c = d.customer, v = d.vehicle;
  return sha256(stableStringify({deal: {id:d.id, status:d.status, type:d.type, docFee:d.docFee, taxRateBps:d.taxRateBps, taxTradeDifference:d.taxTradeDifference, trade:d.trade}, pencil, numbers, customer:{name:c.name, phone:c.phone, email:c.email, address:c.address}, vehicle:{year:v.year, make:v.make, model:v.model, trim:v.trim, vin:v.vin, stockNumber:v.stockNumber}, fiProducts}));
}
export function repairOrderHash(r: RepairOrder) {
  return sha256(stableStringify({id:r.id, customerId:r.customerId, customerName:r.customerName, vehicleDescription:r.vehicleDescription, concern:r.concern, payType:r.payType, lineItems:r.lineItems, totals:repairOrderTotals(r.lineItems)}));
}
export function repairOrderSignatureView(r: RepairOrder, records: SignatureRecord[]) {
  const signatureHash = repairOrderHash(r), signatures = targetSignatures(records, 'repair-order', r.id);
  return {...r, totals:repairOrderTotals(r.lineItems), signatureHash, signatures, signatureStatus:signatureStatusFor(signatures,'repair-order',r.id,signatureHash)};
}
export async function documentSignatureStatus(doc: DealDocument, signatures: SignatureRecord[], store?: DocumentStore): Promise<SignatureStatus> {
  const records = targetSignatures(signatures, 'document', doc.id);
  if (!records.length) return 'awaiting';
  const bytes = await store?.forTenant(doc.tenantId).get(doc.id);
  // Disposed bytes are unavailable: version is the fallback; the UI shows disposal
  // instead of signing status while retaining the complete signature history.
  return records.some(s => s.targetVersion === doc.version && (!bytes || sha256(bytes) === s.targetHash)) ? 'signed' : 'superseded';
}
