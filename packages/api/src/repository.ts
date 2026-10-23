import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import type { CrmEntity } from '@freedms/shared';
import type { Membership, OutboxEvent, Tenant, User, Vehicle, VehicleStatus } from '@freedms/shared';
export interface VehicleQuery { status?: VehicleStatus; search?: string }
/** An instance is permanently bound to ONE tenant; no method accepts an alternate tenant. */
export interface TenantRepository {
  workspaceUsers(): Promise<import('@freedms/shared').WorkspaceUser[]>;
  saveMember(user: User, membership: Membership, expectedVersion: number, event: OutboxEvent): Promise<void>;
  mfa(userId: string): Promise<MfaRecord | undefined>;
  saveMfa(record: MfaRecord, expectedVersion: number, event: OutboxEvent): Promise<void>;
  webhookEndpoints(): Promise<WebhookEndpoint[]>;
  webhookEndpoint(id: string): Promise<WebhookEndpoint | undefined>;
  saveWebhookEndpoint(record: WebhookEndpoint, expectedVersion: number, event: OutboxEvent): Promise<void>;
  webhookDeliveries(): Promise<WebhookDelivery[]>;
  saveWebhookDelivery(record: WebhookDelivery): Promise<void>;
  feedConfig(): Promise<FeedConfig | undefined>;
  saveFeedConfig(record: FeedConfig, expectedVersion: number, event: OutboxEvent): Promise<void>;
  appendFeedRun(record: FeedRun, event: OutboxEvent): Promise<void>;
  feedRuns(): Promise<FeedRun[]>;
  feedRun(id: string): Promise<FeedRun | undefined>;
  appendImport(record: InventoryImport, event: OutboxEvent): Promise<void>;
  imports(): Promise<InventoryImport[]>;
  events(): Promise<OutboxEvent[]>;
  appendAnalytics(record: AnalyticsRecord): Promise<void>;
  analytics(): Promise<AnalyticsRecord[]>;
  appendUsage(usage: QuickEntryUsage): Promise<void>;
  usageForTest(): Promise<QuickEntryUsage[]>;
  users(): Promise<User[]>;
  crmList<K extends CrmEntity['kind']>(kind: K): Promise<Extract<CrmEntity, {kind: K}>[]>;
  crmGet<K extends CrmEntity['kind']>(kind: K, id: string): Promise<Extract<CrmEntity, {kind: K}> | undefined>;
  crmWrite(writes: CrmWrite[], vehicles?: VehicleWrite[]): Promise<void>;
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

export interface CrmWrite { record: CrmEntity; expectedVersion: number; event: OutboxEvent }
export function assertCrmWrites(tenantId: string, writes: CrmWrite[]): void {
  const keys = new Set<string>(); const events = new Set<string>();
  if (!writes.length || writes.length > 10) throw new Error('Invalid CRM transaction');
  for (const {record, expectedVersion, event} of writes) {
    assertScope(tenantId, record, event);
    if (['journal-entry', 'payoff-quote'].includes(record.kind) && expectedVersion !== 0) throw new Error('Journal entries and payoff quotes are immutable');
    assertEvent(record.id, expectedVersion + 1, event, record.kind === 'payoff-quote' ? 'payoff-quote.created' : record.kind === 'journal-entry' ? 'journal-entry.created' : record.kind === 'document' && record.status === 'disposed' ? 'document.disposed' : `${record.kind}.${expectedVersion ? 'updated' : 'created'}`);
    if (record.version !== expectedVersion + 1 || expectedVersion < 0 || !Number.isInteger(expectedVersion)) throw new Error('Invalid CRM version');
    const key = `${record.kind}#${record.id}`;
    if (keys.has(key) || events.has(event.id)) throw new Error('Duplicate CRM transaction item');
    keys.add(key); events.add(event.id);
  }
}

export interface VehicleWrite { record: Vehicle; expectedVersion: number; event: OutboxEvent }
export function assertVehicleWrites(tenantId: string, writes: VehicleWrite[], crm: CrmWrite[]): void {
  const ids = new Set<string>(); const events = new Set(crm.map(w => w.event.id));
  if (writes.length > 1) throw new Error('Invalid vehicle transaction');
  for (const {record, expectedVersion, event} of writes) {
    assertScope(tenantId, record, event);
    assertEvent(record.id, expectedVersion + 1, event, 'vehicle.updated');
    if (record.version !== expectedVersion + 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || ids.has(record.id) || events.has(event.id)) throw new Error('Invalid vehicle transaction');
    ids.add(record.id); events.add(event.id);
  }
}

export function assertFeedConfig(tenantId: string, record: FeedConfig, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  assertEvent(record.id, record.version, event, 'feed.configured');
  if (record.id !== 'feed-config' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid feed config version');
}

export function assertWebhookEndpoint(tenantId: string, record: WebhookEndpoint, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  assertEvent(record.id, record.version, event, expectedVersion ? 'webhook.updated' : 'webhook.created');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid webhook endpoint version');
}

export function assertMfa(tenantId: string, record: MfaRecord, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  if (!['mfa.setup', 'mfa.enabled', 'mfa.disabled', 'mfa.reset', 'mfa.recovery_regenerated', 'mfa.verified'].includes(event.type)) throw new Error('Invalid MFA outbox event');
  assertEvent(record.userId, record.version, event, event.type);
  if (record.id !== record.userId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid MFA version');
}
