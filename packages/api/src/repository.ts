import type { Membership, OutboxEvent, Tenant, User, Vehicle, VehicleStatus } from '@freedms/shared';
export interface VehicleQuery { status?: VehicleStatus; search?: string }
/** An instance is permanently bound to ONE tenant; no method accepts an alternate tenant. */
export interface TenantRepository {
  membership(userId: string): Promise<Membership | undefined>;
  tenant(): Promise<Tenant | undefined>;
  list(query: VehicleQuery): Promise<Vehicle[]>;
  get(id: string): Promise<Vehicle | undefined>;
  create(vehicle: Vehicle, event: OutboxEvent): Promise<void>;
  update(vehicle: Vehicle, expectedVersion: number, event: OutboxEvent): Promise<void>;
  delete(id: string, expectedVersion: number, event: OutboxEvent): Promise<void>;
  provision(tenant: Tenant, user: User, membership: Membership, event: OutboxEvent): Promise<void>;
}
export interface RepositoryFactory { forTenant(tenantId: string): TenantRepository }
export function matches(vehicle: Vehicle, query: VehicleQuery): boolean {
  return (!query.status || vehicle.status === query.status) && (!query.search ||
    [vehicle.stockNumber, vehicle.vin, vehicle.make, vehicle.model, vehicle.trim, vehicle.location]
      .join(' ').toLowerCase().includes(query.search.toLowerCase()));
}
export function assertScope(tenantId: string, ...rows: {tenantId: string}[]): void {
  if (rows.some(row => row.tenantId !== tenantId)) throw new Error('Repository tenant scope violation');
}
export function assertEvent(vehicleId: string, version: number, event: OutboxEvent, type: OutboxEvent['type']): void {
  if (event.aggregateId !== vehicleId || event.aggregateVersion !== version || event.type !== type) throw new Error('Invalid outbox event');
}
