import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import type { CrmEntity, Membership, OutboxEvent, Tenant, User, Vehicle } from '@freedms/shared';
import { assertFeedConfig, assertVehicleWrites, assertCrmWrites, assertEvent, assertScope, matches, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
interface State { feedConfig?: FeedConfig; feedRuns: Map<string, FeedRun>; imports: Map<string, InventoryImport>; analytics: Map<string, AnalyticsRecord>; usage: Map<string, QuickEntryUsage>; crm: Map<string, CrmEntity>; tenant?: Tenant; users: Map<string, User>; memberships: Map<string, Membership>; vehicles: Map<string, Vehicle>; events: Map<string, OutboxEvent> }
export class MemoryRepositories implements RepositoryFactory {
  private states = new Map<string, State>();
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    let state = this.states.get(tenantId);
    if (!state) { state = {feedRuns: new Map(), imports: new Map(), analytics: new Map(), usage: new Map(), crm: new Map(), users: new Map(), memberships: new Map(), vehicles: new Map(), events: new Map()}; this.states.set(tenantId, state); }
    const s = state;
    const check = (event: OutboxEvent) => { assertScope(tenantId, event); if (s.events.has(event.id)) throw conflict(); };
    // Synchronous validation followed by synchronous map writes: no interleaved await or partial commits.
    return {
      feedConfig: async () => structuredClone(s.feedConfig),
      saveFeedConfig: async (record, expectedVersion, event) => { assertFeedConfig(tenantId, record, expectedVersion, event); check(event); if ((s.feedConfig?.version ?? 0) !== expectedVersion) throw conflict(); s.feedConfig = structuredClone(record); s.events.set(event.id, structuredClone(event)); },
      appendFeedRun: async (record, event) => { assertScope(tenantId, record); requireId(record.id); check(event); assertEvent(record.id, 1, event, 'feed.generated'); if (s.feedRuns.has(record.id)) throw conflict(); s.feedRuns.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event)); },
      feedRuns: async () => structuredClone([...s.feedRuns.values()]),
      feedRun: async id => structuredClone(s.feedRuns.get(requireId(id))),
      appendImport: async (record, event) => { assertScope(tenantId, record); requireId(record.id); check(event); assertEvent(record.id, 1, event, 'vehicle.imported'); if (s.imports.has(record.id)) throw conflict(); s.imports.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event)); },
      imports: async () => structuredClone([...s.imports.values()]),
      events: async () => structuredClone([...s.events.values()]),
      appendAnalytics: async record => { assertScope(tenantId, record); requireId(record.id); if (s.analytics.has(record.id)) throw conflict(); s.analytics.set(record.id, structuredClone(record)); },
      analytics: async () => structuredClone([...s.analytics.values()]),
      appendUsage: async usage => { assertScope(tenantId, usage); requireId(usage.id); if (s.usage.has(usage.id)) throw conflict(); s.usage.set(usage.id, structuredClone(usage)); },
      usageForTest: async () => structuredClone([...s.usage.values()]),
      users: async () => structuredClone([...s.users.values()].filter(u => s.memberships.get(u.id)?.active)),
      crmList: async kind => structuredClone([...s.crm.values()].filter(r => r.kind === kind)) as never,
      crmGet: async (kind, id) => structuredClone(s.crm.get(`${kind}#${requireId(id)}`)) as never,
      crmWrite: async (writes, vehicles = []) => {
        assertVehicleWrites(tenantId, vehicles, writes);
        for (const {record, expectedVersion, event} of vehicles) {
          requireId(record.id); check(event);
          if (s.vehicles.get(record.id)?.version !== expectedVersion) throw conflict();
        }
        assertCrmWrites(tenantId, writes);
        for (const {record, expectedVersion, event} of writes) {
          requireId(record.id); check(event);
          if ((s.crm.get(`${record.kind}#${record.id}`)?.version ?? 0) !== expectedVersion) throw conflict();
        }
        for (const {record, event} of vehicles) { s.vehicles.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event)); }
        for (const {record, event} of writes) {
          s.crm.set(`${record.kind}#${record.id}`, structuredClone(record)); s.events.set(event.id, structuredClone(event));
        }
      },
      membership: async id => structuredClone(s.memberships.get(id)),
      tenant: async () => structuredClone(s.tenant),
      list: async query => structuredClone([...s.vehicles.values()].filter(v => matches(v, query))),
      get: async id => structuredClone(s.vehicles.get(id)),
      create: async (v, event) => {
        assertScope(tenantId, v); check(event); assertEvent(v.id, v.version, event, 'vehicle.created');
        if (s.vehicles.has(v.id)) throw conflict();
        s.vehicles.set(v.id, structuredClone(v)); s.events.set(event.id, structuredClone(event));
      },
      update: async (v, version, event) => {
        assertScope(tenantId, v); check(event); assertEvent(v.id, version + 1, event, 'vehicle.updated');
        if (s.vehicles.get(v.id)?.version !== version || v.version !== version + 1) throw conflict();
        s.vehicles.set(v.id, structuredClone(v)); s.events.set(event.id, structuredClone(event));
      },
      delete: async (id, version, event) => {
        check(event); assertEvent(id, version + 1, event, 'vehicle.deleted');
        if (s.vehicles.get(id)?.version !== version) throw conflict();
        s.vehicles.delete(id); s.events.set(event.id, structuredClone(event));
      },
      provision: async (tenant, user, membership, event) => {
        assertScope(tenantId, membership); check(event); assertEvent(tenantId, 1, event, 'tenant.created');
        if (tenant.id !== tenantId || membership.userId !== user.id) throw new Error('Invalid provisioning scope');
        if (s.tenant) throw conflict();
        s.tenant = structuredClone(tenant); s.users.set(user.id, structuredClone(user));
        s.memberships.set(user.id, structuredClone(membership)); s.events.set(event.id, structuredClone(event));
      }
    };
  }
  /** Test-only inspection; never exposed by the API. */
  eventsForTest(tenantId: string): OutboxEvent[] { return structuredClone([...this.states.get(tenantId)?.events.values() ?? []]); }
}
