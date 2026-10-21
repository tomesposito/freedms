import type { CrmRecord, DealView, Pencil, Vehicle } from './index.js';
import type { pencilMath } from './desking.js';
export const documentTypes = ['id', 'insurance', 'title', 'registration', 'signed-form', 'other'] as const;
export const maxDocumentBytes = 40 * 1024;
export interface DealDocument extends CrmRecord {
  kind: 'document'; dealId: string; name: string; type: typeof documentTypes[number]; size: number; uploadedBy: string; uploadedAt: string;
}
export interface DealJacket {
  deal: DealView; pencil: Pencil; numbers: ReturnType<typeof pencilMath>;
  buyersGuide: {vehicle: Pick<Vehicle, 'year' | 'make' | 'model' | 'vin' | 'stockNumber'>; asIs: true; dealerWarranty: null; manufacturerWarranty: null};
  documents: DealDocument[];
  checklist: {key: string; label: string; present: boolean}[];
}

export function jacketChecklist(attached: Pick<DealDocument, 'type'>[]): DealJacket['checklist'] {
  return [{key: 'buyers-order', label: "Buyer’s order", present: true}, {key: 'buyers-guide', label: 'Buyers Guide', present: true}, {key: 'id', label: 'Driver’s license / ID', present: attached.some(d => d.type === 'id')}, {key: 'insurance', label: 'Proof of insurance', present: attached.some(d => d.type === 'insurance')}];
}
