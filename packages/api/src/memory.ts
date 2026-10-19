import type { CrmEntity, Membership, OutboxEvent, Tenant, User, Vehicle } from '@freedms/shared';
import { assertCrmWrites, assertEvent, assertScope, matches, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
interface State { crm: Map<string, CrmEntity>; tenant?: Tenant; users: Map<string, User>; memberships: Map<string, Membership>; vehicles: Map<string, Vehicle>; events: Map<string, OutboxEvent> }
export class MemoryRepositories implements RepositoryFactory {
  private states = new Map<string, State>();
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    let state = this.states.get(tenantId);
    if (!state) { state = {crm: new Map(), users: new Map(), memberships: new Map(), vehicles: new Map(), events: new Map()}; this.states.set(tenantId, state); }
    const s = state;
    const check = (event: OutboxEvent) => { assertScope(tenantId, event); if (s.events.has(event.id)) throw conflict(); };
    // Synchronous validation followed by synchronous map writes: no interleaved await or partial commits.
    return {
      users: async () => structuredClone([...s.users.values()].filter(u => s.memberships.get(u.id)?.active)),
      crmList: async kind => structuredClone([...s.crm.values()].filter(r => r.kind === kind)) as never,
      crmGet: async (kind, id) => structuredClone(s.crm.get(`${kind}#${requireId(id)}`)) as never,
      crmWrite: async writes => {
        assertCrmWrites(tenantId, writes);
        for (const {record, expectedVersion, event} of writes) {
          requireId(record.id); check(event);
          if ((s.crm.get(`${record.kind}#${record.id}`)?.version ?? 0) !== expectedVersion) throw conflict();
        }
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
