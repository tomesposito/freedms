import { acceptanceWrite } from './invites.js';
import { validateMemberWrite } from './users.js';
import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import type { Customer, CrmEntity, Membership, OutboxEvent, Tenant, User, Vehicle } from '@freedms/shared';
import { assertMfa, assertWebhookEndpoint, assertFeedConfig, assertVehicleWrites, assertCrmWrites, assertEvent, assertScope, matches, vehiclePage, leadPage, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
interface State { mfa: Map<string, MfaRecord>; webhookEndpoints: Map<string, WebhookEndpoint>; webhookDeliveries: Map<string, WebhookDelivery>; feedConfig?: FeedConfig; feedRuns: Map<string, FeedRun>; imports: Map<string, InventoryImport>; analytics: Map<string, AnalyticsRecord>; usage: Map<string, QuickEntryUsage>; crm: Map<string, CrmEntity>; tenant?: Tenant; users: Map<string, User>; memberships: Map<string, Membership>; vehicles: Map<string, Vehicle>; events: Map<string, OutboxEvent> }
export class MemoryRepositories implements RepositoryFactory {
  private states = new Map<string, State>();
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    let state = this.states.get(tenantId);
    if (!state) { state = {mfa: new Map(), webhookEndpoints: new Map(), webhookDeliveries: new Map(), feedRuns: new Map(), imports: new Map(), analytics: new Map(), usage: new Map(), crm: new Map(), users: new Map(), memberships: new Map(), vehicles: new Map(), events: new Map()}; this.states.set(tenantId, state); }
    const s = state;
    const check = (event: OutboxEvent) => { assertScope(tenantId, event); if (s.events.has(event.id)) throw conflict(); };
    // Synchronous validation followed by synchronous map writes: no interleaved await or partial commits.
    return {
      acceptInvite: async (invite, user, now) => {
        const write = acceptanceWrite(tenantId, s.crm.get(`invite#${invite.id}`) as import('@freedms/shared').Invite | undefined, invite, user, [...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!})), now);
        if (!write) return 'already-member';
        const {record, member, event, memberEvent} = write;
        check(event); check(memberEvent);
        s.crm.set(`invite#${invite.id}`, structuredClone(record)); s.users.set(user.id, structuredClone(user)); s.memberships.set(user.id, structuredClone(member));
        s.events.set(event.id, structuredClone(event)); s.events.set(memberEvent.id, structuredClone(memberEvent));
        return 'accepted';
      },
      workspaceUsers: async () => structuredClone([...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!}))),
      saveMember: async (user, member, expected, event) => {
        assertScope(tenantId, member, event); check(event);
        validateMemberWrite(user, member, expected, event, [...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!})));
        s.users.set(user.id, structuredClone(user)); s.memberships.set(user.id, structuredClone(member)); s.events.set(event.id, structuredClone(event));
      },
      mfa: async userId => structuredClone(s.mfa.get(requireId(userId))),
      saveMfa: async (record, expectedVersion, event) => {
        assertMfa(tenantId, record, expectedVersion, event); requireId(record.id); check(event);
        if ((s.mfa.get(record.id)?.version ?? 0) !== expectedVersion) throw conflict();
        s.mfa.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event));
      },
      webhookEndpoints: async () => structuredClone([...s.webhookEndpoints.values()]),
      webhookEndpoint: async id => structuredClone(s.webhookEndpoints.get(requireId(id))),
      saveWebhookEndpoint: async (record, expectedVersion, event) => {
        assertWebhookEndpoint(tenantId, record, expectedVersion, event); requireId(record.id); check(event);
        if ((s.webhookEndpoints.get(record.id)?.version ?? 0) !== expectedVersion) throw conflict();
        s.webhookEndpoints.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event));
      },
      webhookDeliveries: async () => structuredClone([...s.webhookDeliveries.values()]),
      saveWebhookDelivery: async record => { assertScope(tenantId, record); requireId(record.id); s.webhookDeliveries.set(record.id, structuredClone(record)); },
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
      leadListPage: async query => {
        const customers = new Map<string, Customer>();
        for (const row of s.crm.values()) if (row.kind === 'customer') customers.set(row.id, row);
        return structuredClone(leadPage(s.crm.values(), customers, query));
      },
      crmList: async kind => structuredClone([...s.crm.values()].filter(r => r.kind === kind)) as never,
      crmGet: async (kind, id) => structuredClone(s.crm.get(`${kind}#${requireId(id)}`)) as never,
      crmWrite: async (writes, vehicles = []) => {
        assertVehicleWrites(tenantId, vehicles, writes);
        for (const {record, expectedVersion, event} of vehicles) {
          requireId(record.id); check(event);
          if (s.vehicles.get(record.id)?.version !== expectedVersion) throw conflict();
        }
        assertCrmWrites(tenantId, writes);
        const finalRows = new Map(s.crm);
        for (const {record} of writes) finalRows.set(`${record.kind}#${record.id}`, record);
        const numbers = new Set<string>();
        for (const record of finalRows.values()) if (record.kind === 'part') {
          if (numbers.has(record.partNumber)) throw conflict();
          numbers.add(record.partNumber);
        }
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
      listPage: async query => {
        const page = vehiclePage([...s.vehicles.values()].filter(v => matches(v, query)), query);
        return {...page, vehicles: structuredClone(page.vehicles)};
      },
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
