import type { CrmRecord } from './index.js';
export type SignatureTargetType = 'buyers-order' | 'document' | 'repair-order';
export type SignatureMethod = 'drawn' | 'typed';
export type SignatureStatus = 'signed' | 'awaiting' | 'superseded';
export interface SignatureRecord extends CrmRecord {
  kind: 'signature'; targetType: SignatureTargetType;
  dealId: string | null; documentId: string | null; repairOrderId: string | null;
  targetLabel: string; targetVersion: number; targetHash: string;
  signerName: string; method: SignatureMethod; signatureData: string; consentText: string;
  signedAt: string; capturedBy: string; estimateCents?: number;
}
export const DEAL_SIGNATURE_CONSENT = 'I have reviewed this document as shown and I sign it in the dealership. My signature is captured and stored with this document as an auditable record. This is not a third-party e-signature service and makes no claim of legal e-signature compliance.';
export const SERVICE_SIGNATURE_CONSENT = 'I authorize the dealership to perform the work described and agree to the estimate shown. I sign in the dealership. My signature is captured and stored with this repair order as an auditable record. This is not a third-party e-signature service and makes no claim of legal e-signature compliance.';
export function targetSignatures(signatures: SignatureRecord[], targetType: SignatureTargetType, targetId: string): SignatureRecord[] {
  return signatures.filter(s => s.targetType === targetType && (targetType === 'document' ? s.documentId : targetType === 'repair-order' ? s.repairOrderId : s.dealId) === targetId).sort((a,b) => a.signedAt.localeCompare(b.signedAt) || a.id.localeCompare(b.id));
}
export function signatureStatusFor(signatures: SignatureRecord[], targetType: SignatureTargetType, targetId: string, currentHash: string): SignatureStatus {
  const records = targetSignatures(signatures, targetType, targetId);
  return records.some(s => s.targetHash === currentHash) ? 'signed' : records.length ? 'superseded' : 'awaiting';
}
