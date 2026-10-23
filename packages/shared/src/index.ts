export * from './mfa.js';
import type { DealDocument, DocumentRetention } from './jacket.js';
export * from './jacket.js';
import type { Deal, WorkspaceSettings } from './desking.js';
export * from './desking.js';
export type Role = 'admin' | 'staff';
export interface Tenant { id: string; name: string; createdAt: string }
export interface User { id: string; name: string }
export interface Membership { tenantId: string; userId: string; role: Role; active: boolean }
export interface Principal { tenantId: string; userId: string; role: Role }
export const vehicleStatuses = ['available', 'reserved', 'sold', 'in recon'] as const;
export type VehicleStatus = typeof vehicleStatuses[number];
export interface ReconItem { description: string; amount: number }
/** All money is integer USD cents. Dates stocked are UTC calendar dates. */
export interface VehicleInput {
  stockNumber: string; vin: string; year: number; make: string; model: string; trim: string;
  status: VehicleStatus; listPrice: number; cost: number; reconCosts: ReconItem[];
  dateStocked: string; location: string; notes: string;
}
export interface Vehicle extends VehicleInput {
  id: string; tenantId: string; version: number; createdAt: string; updatedAt: string;
}
export interface VehicleView extends Vehicle { agingDays: number; reconTotal: number }
export interface OutboxEvent {
  id: string; tenantId: string; actorId: string; aggregateId: string; aggregateVersion: number;
  type: 'retention.created' | 'retention.updated' | 'document.disposed' | 'mfa.setup' | 'mfa.enabled' | 'mfa.disabled' | 'mfa.reset' | 'mfa.recovery_regenerated' | 'mfa.verified' | 'webhook.created' | 'webhook.updated' | 'feed.configured' | 'feed.generated' | 'vehicle.imported' | 'document.created' | 'document.updated' | 'deal.created' | 'deal.updated' | 'settings.created' | 'settings.updated' | 'vehicle.created' | 'vehicle.updated' | 'vehicle.deleted' | 'tenant.created' | 'customer.created' | 'customer.updated' | 'lead.created' | 'lead.updated' | 'intake.created' | 'intake.updated';
  disposal?: {documentId: string; name: string; type: DealDocument['type']; dealId: string; disposedBy: string; disposedAt: string};
  occurredAt: string; deliveryStatus: 'pending';
}
export interface DecodedVin { vin: string; year: number | null; make: string; model: string; trim: string; warnings: string[] }
export type ApiEnvelope<T> = { data: T } | { error: { code: string; message: string } };
export interface AuthClaims { sub: string; 'custom:tenant_id': string; iss: string; aud: string; exp: number; token_use: 'id' }

export const leadSources = ['walk-in', 'phone', 'website', 'marketplace', 'referral', 'other'] as const;
export const leadStages = ['new', 'contacted', 'appointment', 'in-store', 'working-deal', 'sold', 'lost'] as const;
export const communicationTypes = ['call', 'text', 'email', 'visit'] as const;
export type LeadStage = typeof leadStages[number];
export interface Consent { status: 'unknown' | 'granted' | 'revoked'; timestamp: string | null; source: string }
export interface CustomerInput { name: string; phone: string; email: string; address: string; consent: Consent; notes: string }
export interface CrmRecord { id: string; tenantId: string; version: number; createdAt: string; updatedAt: string }
export interface Customer extends CrmRecord, CustomerInput { kind: 'customer' }
export interface FollowUp { id: string; type: typeof communicationTypes[number]; dueAt: string; done: boolean }
export interface Activity { id: string; kind: 'stage' | 'communication' | 'follow-up' | 'assignment'; actorId: string; timestamp: string; summary: string; type?: typeof communicationTypes[number]; direction?: 'inbound' | 'outbound' }
export interface Lead extends CrmRecord {
  kind: 'lead'; customerId: string; vehicleId: string | null; vehicleDescription: string;
  source: typeof leadSources[number]; sourceDetail: string; stage: LeadStage; assigneeId: string | null;
  activities: Activity[]; followUps: FollowUp[];
}
export interface IntakeCredential extends CrmRecord { kind: 'intake'; hash: string }
export type CrmEntity = Customer | Lead | IntakeCredential | Deal | WorkspaceSettings | DealDocument | DocumentRetention;
export interface LeadView extends Lead { customer: Customer; overdue: boolean }
export function isOverdue(task: FollowUp, now: Date): boolean { return !task.done && Date.parse(task.dueAt) < now.getTime(); }
export * from './reports.js';

export * from './quick-entry.js';
export * from './analytics.js';

export * from './import.js';

export * from './feed.js';

export * from './webhooks.js';
