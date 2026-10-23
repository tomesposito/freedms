import type { CrmRecord, DealView, Pencil, Vehicle } from './index.js';
import type { pencilMath } from './desking.js';
export const documentTypes = ['id', 'insurance', 'title', 'registration', 'signed-form', 'other'] as const;
export const maxDocumentBytes = 40 * 1024;
export interface DealDocument extends CrmRecord {
  kind: 'document'; dealId: string; name: string; type: typeof documentTypes[number]; size: number; uploadedBy: string; uploadedAt: string;
  status?: 'disposal-pending' | 'disposed'; disposedAt?: string; disposedBy?: string;
}
export interface DealJacket {
  credit: {status: import('./credit.js').CreditStatus; decisionOutcome: import('./credit.js').DecisionOutcome | null; lenderName: string | null; applicantSsnLast4: string} | null;
  adverseAction: {applicantName: string; decidedAt: string; lenderName: string; reasons: import('./credit.js').AdverseActionReason[]} | null;
  payoffQuotes: import('./credit.js').PayoffQuote[];

  deal: DealView; pencil: Pencil; numbers: ReturnType<typeof pencilMath>;
  buyersGuide: {vehicle: Pick<Vehicle, 'year' | 'make' | 'model' | 'vin' | 'stockNumber'>; asIs: true; dealerWarranty: null; manufacturerWarranty: null};
  fiProducts: Pick<import('./desking.js').FiSelection, 'name' | 'category' | 'retailPrice' | 'termNotes'>[];
  documents: DealDocument[];
  checklist: {key: string; label: string; present: boolean; status?: 'present' | 'missing' | 'disposed' | 'disposal-pending'}[];
}

export interface DocumentRetention extends CrmRecord { kind: 'retention'; retentionDays: number | null }
export interface DocumentSearchResult extends DealDocument { buyerName: string; dealStatus: DealView['status'] }
export function jacketChecklist(attached: Pick<DealDocument, 'type' | 'status'>[]): DealJacket['checklist'] {
  const item = (type: 'id' | 'insurance', label: string): DealJacket['checklist'][number] => {
    const docs = attached.filter(d => d.type === type);
    const status = docs.some(d => !d.status) ? 'present' : docs.some(d => d.status === 'disposal-pending') ? 'disposal-pending' : docs.length ? 'disposed' : 'missing';
    return {key: type, label, present: docs.length > 0, status};
  };
  return [{key: 'buyers-order', label: 'Buyer’s order', present: true}, {key: 'buyers-guide', label: 'Buyers Guide', present: true}, item('id', 'Driver’s license / ID'), item('insurance', 'Proof of insurance')];
}
