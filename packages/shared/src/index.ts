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
  type: 'vehicle.created' | 'vehicle.updated' | 'vehicle.deleted' | 'tenant.created';
  occurredAt: string; deliveryStatus: 'pending';
}
export interface DecodedVin { vin: string; year: number | null; make: string; model: string; trim: string; warnings: string[] }
export type ApiEnvelope<T> = { data: T } | { error: { code: string; message: string } };
export interface AuthClaims { sub: string; 'custom:tenant_id': string; iss: string; aud: string; exp: number; token_use: 'id' }
