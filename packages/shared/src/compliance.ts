import type { Consent, CrmRecord, DealDocument } from './index.js';
export const complianceCheckResults = ['clear', 'potential-match', 'match'] as const;
export type ComplianceCheckResult = typeof complianceCheckResults[number];
export const complianceCheckResultLabels: Record<ComplianceCheckResult, string> = {clear: 'Clear', 'potential-match': 'Potential match', match: 'Match'};
export interface ComplianceAttestation { by: string; at: string; note: string }
export interface ComplianceRecord extends CrmRecord {
  kind: 'compliance'; dealId: string; customerId: string;
  documentInspected: ComplianceAttestation | null; addressDiscrepancy: ComplianceAttestation | null; privacyNoticeGiven: ComplianceAttestation | null;
}
export interface ComplianceCheck extends CrmRecord {
  kind: 'compliance-check'; dealId: string | null; customerId: string; customerName: string; method: string;
  result: ComplianceCheckResult; checkedDate: string; initials: string; notes: string; performedBy: string; performedAt: string;
}
export interface ComplianceChecklistItem {
  key: string; label: string; present: boolean; source: 'attestation' | 'document' | 'record' | 'missing'; by?: string; at?: string; detail?: string;
}
export interface DealCompliance { record: ComplianceRecord | null; checks: ComplianceCheck[]; checklist: ComplianceChecklistItem[]; complete: boolean }
export function newestComplianceChecks(checks: ComplianceCheck[]): ComplianceCheck[] {
  return [...checks].sort((a, b) => b.checkedDate.localeCompare(a.checkedDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
/** Checks from this deal OR this customer qualify; callers provide only that scope.
 * A recorded result documents the dealer's process, not clearance or verification by freeDMS.
 */
export function complianceChecklist(record: ComplianceRecord | null, documents: DealDocument[], consent: Consent, checks: ComplianceCheck[]): ComplianceChecklistItem[] {
  const manual = (key: string, label: string, a: ComplianceAttestation | null | undefined): ComplianceChecklistItem =>
    ({key, label, present: !!a, source: a ? 'attestation' : 'missing', ...(a ? {by: a.by, at: a.at, detail: a.note} : {})});
  const document = manual('document-inspected', 'Identity document inspected / attached', record?.documentInspected);
  const id = documents.find(d => d.type === 'id' && !d.status);
  if (!document.present && id) Object.assign(document, {present: true, source: 'document', by: id.uploadedBy, at: id.uploadedAt, detail: id.name});
  const latest = newestComplianceChecks(checks)[0];
  return [document, manual('address-discrepancy', 'Address discrepancy handled', record?.addressDiscrepancy),
    {key: 'ofac-check', label: 'Dealer-recorded OFAC / identity check', present: !!latest, source: latest ? 'record' : 'missing', ...(latest ? {by: latest.performedBy, at: latest.performedAt, detail: `${latest.method} · ${latest.checkedDate} · ${complianceCheckResultLabels[latest.result]} · ${latest.initials}`} : {})},
    manual('privacy-notice', 'Privacy notice given', record?.privacyNoticeGiven),
    {key: 'consent-on-file', label: 'Consent on file', present: consent.status === 'granted', source: consent.status === 'granted' ? 'record' : 'missing', ...(consent.status === 'granted' ? {at: consent.timestamp ?? undefined, detail: consent.source} : {})}];
}

export const privacyStatuses = ['received', 'in_progress', 'fulfilled', 'denied'] as const;
export interface PrivacyStep { actor: string; action: string; at: string; note: string }
export interface PrivacyRequest extends CrmRecord {
  kind: 'privacy-request'; customerId: string; type: 'access' | 'deletion';
  status: typeof privacyStatuses[number]; dueDate: string; receivedBy: string; receivedAt: string;
  history: PrivacyStep[]; denialReason?: string; deniedBy?: string; deniedAt?: string;
  fulfilledBy?: string; fulfilledAt?: string;
}
export interface CustomerDataExport {
  requestId: string; generatedAt: string; generatedBy: string;
  customer: import('./index.js').Customer; leads: import('./index.js').Lead[];
  deals: import('./index.js').Deal[]; documents: DealDocument[];
}
export const anonymizationNotice = 'Personal fields were anonymized and financial records the dealer must legally keep (deals, GL) were preserved.';
