import type { TermsAcceptance } from './legal.js';
export * from './legal.js';
import type { SignatureRecord } from './signatures.js';
export * from './signatures.js';
import type { PartsReservation, Part, PartsSale, PartsPurchaseOrder, PartsReturn, PricingMatrix } from './parts.js';
export * from './parts.js';
import type { Technician, LaborRate, ServiceAppointment, RepairOrder } from './service.js';
export * from './service.js';
import type { ComplianceRecord, ComplianceCheck, PrivacyRequest } from './compliance.js';
export * from './compliance.js';
import type { SavedReport } from './reports.js';
import type { DealShare, ShareResponse } from './retail.js';
export * from './retail.js';
import type { AccountingLock, BankReconciliation } from './treasury.js';
export * from './treasury.js';
import type { CreditApplication, PayoffQuote } from './credit.js';
export * from './credit.js';
import type { GlAccount, JournalEntry } from './accounting.js';
export * from './accounting.js';
export * from './mfa.js';
import type { DealDocument, DocumentRetention } from './jacket.js';
export * from './jacket.js';
import type { Deal, WorkspaceSettings } from './desking.js';
export * from './desking.js';
export type Role = 'admin' | 'staff';
export interface Tenant { id: string; name: string; createdAt: string; address?: string; phone?: string; dealerType?: 'independent' | 'franchise' | 'other' }
export interface User { id: string; name: string; email?: string }
export interface Membership { tenantId: string; userId: string; role: Role; active: boolean; version?: number }
export interface SessionUser { id: string; name: string; email: string | null }
export interface Session { canManagePilotRequests?: boolean; principal: Principal; tenant: Tenant | undefined; mfaEnabled: boolean; user: SessionUser | null }
export interface Principal { tenantId: string; userId: string; role: Role }
export const vehicleStatuses = ['available', 'reserved', 'sold', 'in recon'] as const;
export type VehicleStatus = typeof vehicleStatuses[number];
export interface ReconItem { description: string; amount: number }
/** All money is integer USD cents. Dates stocked are UTC calendar dates. */
export interface VehicleInput {
  stockNumber: string; vin: string; year: number; make: string; model: string; trim: string;
  mileage: number | null;
  status: VehicleStatus; listPrice: number; cost: number; reconCosts: ReconItem[];
  dateStocked: string; location: string; notes: string;
}
export interface Vehicle extends VehicleInput {
  id: string; tenantId: string; version: number; createdAt: string; updatedAt: string;
}
export interface VehicleView extends Vehicle { agingDays: number; reconTotal: number }
export interface OutboxEvent {
  actorType?: 'agent';
  id: string; tenantId: string; actorId: string; aggregateId: string; aggregateVersion: number;
  type: 'terms-acceptance.created' | 'parts-reservation.created' | 'parts-reservation.updated' | 'privacy-request.created' | 'privacy-request.updated' | 'signature.created' | 'parts-po.created' | 'parts-po.updated' | 'parts-return.created' | 'pricing-matrix.created' | 'pricing-matrix.updated' | 'technician.created' | 'technician.updated' | 'labor-rate.created' | 'labor-rate.updated' | 'invite.created' | 'invite.updated' | 'invite.accepted' | 'part.created' | 'part.updated' | 'parts-sale.created' | 'service-appointment.created' | 'service-appointment.updated' | 'repair-order.created' | 'repair-order.updated' | 'compliance.created' | 'compliance.updated' | 'compliance-check.created' | 'saved-report.created' | 'saved-report.updated' | 'deal-share.created' | 'deal-share.updated' | 'share-response.created' | 'user.added' | 'user.role_changed' | 'user.deactivated' | 'user.reactivated' | 'accounting-lock.created' | 'accounting-lock.updated' | 'bank-reconciliation.created' | 'bank-reconciliation.updated' | 'credit-application.created' | 'credit-application.updated' | 'payoff-quote.created' | 'gl-account.created' | 'gl-account.updated' | 'journal-entry.created' | 'fi-product.created' | 'fi-product.updated' | 'retention.created' | 'retention.updated' | 'document.disposed' | 'mfa.setup' | 'mfa.enabled' | 'mfa.disabled' | 'mfa.reset' | 'mfa.recovery_regenerated' | 'mfa.verified' | 'webhook.created' | 'webhook.updated' | 'feed.configured' | 'feed.generated' | 'vehicle.imported' | 'document.created' | 'document.updated' | 'deal.created' | 'deal.updated' | 'settings.created' | 'settings.updated' | 'vehicle.created' | 'vehicle.updated' | 'vehicle.deleted' | 'tenant.created' | 'customer.created' | 'customer.updated' | 'lead.created' | 'lead.updated' | 'intake.created' | 'intake.updated';
  causeId?: string;
  action?: string;
  disposal?: {documentId: string; name: string; type: DealDocument['type']; dealId: string; disposedBy: string; disposedAt: string};
  occurredAt: string; deliveryStatus: 'pending';
}
export interface DecodedVin { vin: string; year: number | null; make: string; model: string; trim: string; warnings: string[] }
export type ApiEnvelope<T> = { data: T; total?: number; limit?: number; offset?: number } | { error: { code: string; message: string } };
export interface AuthClaims { email?: string; email_verified?: boolean | string; sub: string; 'custom:tenant_id': string; iss: string; aud: string; exp: number; token_use: 'id' }

export const leadSources = ['walk-in', 'phone', 'website', 'marketplace', 'referral', 'other'] as const;
export const leadStages = ['new', 'contacted', 'appointment', 'in-store', 'working-deal', 'sold', 'lost'] as const;
export const communicationTypes = ['call', 'text', 'email', 'visit'] as const;
export type LeadStage = typeof leadStages[number];
export interface Consent { status: 'unknown' | 'granted' | 'revoked'; timestamp: string | null; source: string }
export interface CustomerInput { name: string; phone: string; email: string; address: string; consent: Consent; notes: string }
export interface CrmRecord { id: string; tenantId: string; version: number; createdAt: string; updatedAt: string }
export interface Customer extends CrmRecord, CustomerInput { kind: 'customer' }
export interface FollowUp { id: string; type: typeof communicationTypes[number]; dueAt: string; done: boolean; origin?: 'manual' | 'ownership-cycle'; cycleKey?: string; dismissed?: boolean }
export interface Activity { id: string; kind: 'stage' | 'communication' | 'follow-up' | 'assignment'; actorId: string; timestamp: string; summary: string; type?: typeof communicationTypes[number]; direction?: 'inbound' | 'outbound' }
export interface Lead extends CrmRecord {
  kind: 'lead'; customerId: string; vehicleId: string | null; vehicleDescription: string;
  source: typeof leadSources[number]; sourceDetail: string; stage: LeadStage; assigneeId: string | null;
  activities: Activity[]; followUps: FollowUp[];
}
export interface IntakeCredential extends CrmRecord { kind: 'intake'; hash: string }
export * from './fi.js';
import type { FiProduct } from './fi.js';
export interface Invite extends CrmRecord { kind: 'invite'; name: string; email: string; role: Role; token: string; tokenHash: string; expiresAt: string; status: 'pending' | 'revoked' | 'accepted'; closedTokenHash?: string; acceptedAt?: string; acceptedUserId?: string; acceptedName?: string }
export type CrmEntity = TermsAcceptance | PartsReservation | PrivacyRequest | SignatureRecord | PartsPurchaseOrder | PartsReturn | PricingMatrix | Technician | LaborRate | Invite | Part | PartsSale | ServiceAppointment | RepairOrder | ComplianceRecord | ComplianceCheck | SavedReport | DealShare | ShareResponse | AccountingLock | BankReconciliation | CreditApplication | PayoffQuote | GlAccount | JournalEntry | FiProduct | Customer | Lead | IntakeCredential | Deal | WorkspaceSettings | DealDocument | DocumentRetention;
export interface LeadView extends Lead { customer: Customer; overdue: boolean }
export function isOverdue(task: FollowUp, now: Date): boolean { return !task.done && !task.dismissed && Date.parse(task.dueAt) < now.getTime(); }
export * from './reports.js';

export * from './quick-entry.js';
export * from './analytics.js';

export * from './import.js';

export * from './feed.js';

export * from './webhooks.js';

export * from './users.js';

export * from './ownership.js';
export * from './reports-p3.js';

export const inventorySizes = ['1-25', '26-50', '51-100', '101-200', '201+'] as const;
export interface AccessRequest {
  id: string; tenantId: string; email: string;
  contactName: string; dealershipName: string;
  phone: string; inventorySize: string; currentDms: string; message: string;
  status: 'pending' | 'handled'; handledAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
