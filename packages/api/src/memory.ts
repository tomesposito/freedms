import type { McpRegistration } from './mcp/registration.js';
import type { Idea } from '@freedms/shared';
import type { AccessRequest } from '@freedms/shared';
import type { AccountBalance } from '@freedms/shared';
import { acceptanceWrite } from './invites.js';
import { validateMemberWrite } from './users.js';
import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import type { Customer, CrmEntity, Membership, OutboxEvent, Tenant, User, Vehicle } from '@freedms/shared';
import { assertIdea, assertMfa, assertWebhookEndpoint, assertFeedConfig, assertVehicleWrites, assertCrmWrites, assertEvent, assertScope, matches, vehiclePage, leadPage, countLeads, serviceBoardKinds, serviceBoardSelection, salesReportSelection, forecastSelection, accountingBalanceSelection, type ForecastRows, type LeadPage, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
const forecastKinds = new Set<CrmEntity['kind']>(['deal', 'service-appointment', 'part', 'parts-sale', 'repair-order']);
interface State { mcpRegistrations: Map<string, McpRegistration>; mcpAttempts: Map<string, {bucket: number; count: number}>; ideas: Map<string, Idea>; accessRequests: Map<string, AccessRequest>; leadPageEpoch: number; leadPageCache: Map<string, LeadPage>; accountingEpoch: number; accountingCache: Map<string, AccountBalance[]>; forecastEpoch: number; forecastCache: Map<string, ForecastRows>; serviceBoardEpoch: number; mfa: Map<string, MfaRecord>; webhookEndpoints: Map<string, WebhookEndpoint>; webhookDeliveries: Map<string, WebhookDelivery>; feedConfig?: FeedConfig; feedRuns: Map<string, FeedRun>; imports: Map<string, InventoryImport>; analytics: Map<string, AnalyticsRecord>; usage: Map<string, QuickEntryUsage>; crm: Map<string, CrmEntity>; crmByKind: Map<CrmEntity['kind'], Map<string, CrmEntity>>; partNumbers: Map<string, string>; tenant?: Tenant; users: Map<string, User>; memberships: Map<string, Membership>; vehicles: Map<string, Vehicle>; events: Map<string, OutboxEvent> }
export class MemoryRepositories implements RepositoryFactory {
  private states = new Map<string, State>();
  async ideasQueue(): Promise<Idea[]> {
    return structuredClone([...this.states.values()].flatMap(state => [...state.ideas.values()]));
  }
  async tenantForSubject(subject: string): Promise<string | undefined> {
    const matches = [...this.states].filter(([, state]) => state.memberships.has(subject));
    return matches.length === 1 ? matches[0][0] : undefined;
  }
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    let state = this.states.get(tenantId);
    if (!state) { state = {mcpRegistrations: new Map(), mcpAttempts: new Map(), ideas: new Map(), accessRequests: new Map(), leadPageEpoch: 0, leadPageCache: new Map(), accountingEpoch: 0, accountingCache: new Map(), forecastEpoch: 0, forecastCache: new Map(), serviceBoardEpoch: 0, mfa: new Map(), webhookEndpoints: new Map(), webhookDeliveries: new Map(), feedRuns: new Map(), imports: new Map(), analytics: new Map(), usage: new Map(), crm: new Map(), crmByKind: new Map(), partNumbers: new Map(), users: new Map(), memberships: new Map(), vehicles: new Map(), events: new Map()}; this.states.set(tenantId, state); }
    const s = state;
    const storeCrm = (record: CrmEntity) => {
      const stored = structuredClone(record);
      let bucket = s.crmByKind.get(record.kind);
      if (!bucket) { bucket = new Map(); s.crmByKind.set(record.kind, bucket); }
      // Both maps share the stored clone; replacing a key preserves insertion order.
      s.crm.set(`${record.kind}#${record.id}`, stored);
      bucket.set(record.id, stored);
    };
    const check = (event: OutboxEvent) => { assertScope(tenantId, event); if (s.events.has(event.id)) throw conflict(); };
    // Synchronous validation followed by synchronous map writes: no interleaved await or partial commits.
    return {
      webhookDispatchScope: {owner: this, tenantId},
      acceptInvite: async (invite, user, now) => {
        const write = acceptanceWrite(tenantId, s.crm.get(`invite#${invite.id}`) as import('@freedms/shared').Invite | undefined, invite, user, [...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!})), now, s.tenant);
        if (!write) return 'already-member';
        const {record, member, event, memberEvent, tenant} = write;
        check(event); check(memberEvent);
        s.tenant = structuredClone(tenant);
        storeCrm(record); s.users.set(user.id, structuredClone(user)); s.memberships.set(user.id, structuredClone(member));
        s.events.set(event.id, structuredClone(event)); s.events.set(memberEvent.id, structuredClone(memberEvent));
        return 'accepted';
      },
      workspaceUsers: async () => structuredClone([...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!}))),
      saveMember: async (user, member, expected, event) => {
        assertScope(tenantId, member, event); check(event);
        validateMemberWrite(user, member, expected, event, [...s.memberships.values()].map(membership => ({membership, user: s.users.get(membership.userId)!})));
        s.users.set(user.id, structuredClone(user)); s.memberships.set(user.id, structuredClone(member)); s.events.set(event.id, structuredClone(event));
      },
      ideas: async () => structuredClone([...s.ideas.values()]),
      idea: async id => structuredClone(s.ideas.get(requireId(id))),
      saveIdea: async (record, expectedVersion, event) => {
        assertIdea(tenantId, record, expectedVersion, event); requireId(record.id); check(event);
        if ((s.ideas.get(record.id)?.version ?? 0) !== expectedVersion) throw conflict();
        s.ideas.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event));
      },
      mcpRegistration: async id => structuredClone(s.mcpRegistrations.get(requireId(id))),
      mcpRegistrations: async () => structuredClone([...s.mcpRegistrations.values()]),
      saveMcpRegistration: async record => {
        assertScope(tenantId, record); requireId(record.client_id);
        if (s.mcpRegistrations.has(record.client_id)) throw conflict();
        s.mcpRegistrations.set(record.client_id, structuredClone(record));
      },
      deleteMcpRegistration: async id => { s.mcpRegistrations.delete(requireId(id)); },
      consumeMcpRegistrationAttempt: async (source, bucket, limit) => {
        const old = s.mcpAttempts.get(source);
        const count = old?.bucket === bucket ? old.count : 0;
        if (count >= limit) return false;
        s.mcpAttempts.set(source, {bucket, count: count + 1}); return true;
      },
      accessRequest: async email => structuredClone(s.accessRequests.get(email.toLowerCase())),
      accessRequests: async () => structuredClone([...s.accessRequests.values()]),
      saveAccessRequest: async (record, expectedVersion) => {
        assertScope(tenantId, record);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid access request version');
        const email = record.email.toLowerCase();
        if ((s.accessRequests.get(email)?.version ?? 0) !== expectedVersion) throw conflict();
        s.accessRequests.set(email, structuredClone(record));
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
      serviceBoardEpoch: async () => s.serviceBoardEpoch,
      serviceBoard: async day => {
        const selection = serviceBoardSelection(day);
        selection.add(s.crm.values());
        return structuredClone(selection.finish());
      },
      accountingBalances: async range => {
        const key = JSON.stringify([s.accountingEpoch, range.from, range.to]);
        const cached = s.accountingCache.get(key);
        if (cached) return structuredClone(cached);
        const selection = accountingBalanceSelection(range);
        selection.add((function* () {
          for (const row of s.crm.values()) { assertScope(tenantId, row); yield row; }
        })());
        const rows = selection.finish();
        s.accountingCache.set(key, rows);
        if (s.accountingCache.size > 4) s.accountingCache.delete(s.accountingCache.keys().next().value!);
        return structuredClone(rows);
      },
      inventoryReportRows: async () => {
        const rows: Vehicle[] = [];
        for (const row of s.vehicles.values()) {
          assertScope(tenantId, row);
          if (row.status !== 'sold') rows.push(row);
        }
        return structuredClone(rows);
      },
      forecastRows: async window => {
        const key = JSON.stringify([s.forecastEpoch, window.from, window.to]);
        const cached = s.forecastCache.get(key);
        if (cached) return structuredClone(cached);
        const selection = forecastSelection(window);
        function* scoped<T extends {tenantId: string}>(rows: Iterable<T>) {
          for (const row of rows) { assertScope(tenantId, row); yield row; }
        }
        selection.addVehicles(scoped(s.vehicles.values()));
        selection.add(scoped(s.crm.values()));
        const rows = structuredClone(selection.finish());
        s.forecastCache.set(key, rows);
        if (s.forecastCache.size > 4) s.forecastCache.delete(s.forecastCache.keys().next().value!);
        return structuredClone(rows);
      },
      salesReportRows: async range => {
        const selection = salesReportSelection(range);
        selection.add(s.crm.values());
        const vehicles: Vehicle[] = [], customers: Customer[] = [];
        for (const id of selection.vehicleIds) {
          const row = s.vehicles.get(id);
          if (row) vehicles.push(row);
        }
        for (const id of selection.customerIds) {
          const row = s.crm.get(`customer#${id}`);
          if (row?.kind === 'customer') customers.push(row);
        }
        return structuredClone({deals: selection.deals, vehicles, customers});
      },
      leadSummary: async () => countLeads(s.crm.values()),
      leadListPage: async query => {
        // false distinguishes an omitted assignee filter from null (unassigned).
        const key = JSON.stringify([s.leadPageEpoch, query.search, query.stage, query.assignee === undefined ? false : query.assignee, query.limit, query.offset]);
        const cached = s.leadPageCache.get(key);
        if (cached) return structuredClone(cached);
        const customers = new Map<string, Customer>();
        for (const row of s.crmByKind.get('customer')?.values() ?? []) if (row.kind === 'customer') customers.set(row.id, row);
        const page = structuredClone(leadPage(s.crmByKind.get('lead')?.values() ?? [], customers, query));
        s.leadPageCache.set(key, page);
        if (s.leadPageCache.size > 4) s.leadPageCache.delete(s.leadPageCache.keys().next().value!);
        return structuredClone(page);
      },
      crmList: async kind => structuredClone([...(s.crmByKind.get(kind)?.values() ?? [])]) as never,
      crmGet: async (kind, id) => structuredClone(s.crm.get(`${kind}#${requireId(id)}`)) as never,
      crmWrite: async (writes, vehicles = []) => {
        assertVehicleWrites(tenantId, vehicles, writes);
        for (const {record, expectedVersion, event} of vehicles) {
          requireId(record.id); check(event);
          if (s.vehicles.get(record.id)?.version !== expectedVersion) throw conflict();
        }
        assertCrmWrites(tenantId, writes);
        const parts = writes.flatMap(({record}) => record.kind === 'part' ? [record] : []);
        let partNumbers: Map<string, string | undefined> | undefined;
        if (parts.length) {
          // Stage releases before reservations so final-state swaps remain valid.
          partNumbers = new Map();
          for (const record of parts) {
            const old = s.crm.get(`part#${record.id}`);
            if (old?.kind === 'part') partNumbers.set(old.partNumber, undefined);
          }
          for (const record of parts) {
            const owner = partNumbers.has(record.partNumber) ? partNumbers.get(record.partNumber) : s.partNumbers.get(record.partNumber);
            if (owner !== undefined && owner !== record.id) throw conflict();
            partNumbers.set(record.partNumber, record.id);
          }
        }
        for (const {record, expectedVersion, event} of writes) {
          requireId(record.id); check(event);
          if ((s.crm.get(`${record.kind}#${record.id}`)?.version ?? 0) !== expectedVersion) throw conflict();
        }
        if (partNumbers) for (const [number, id] of partNumbers) {
          if (id === undefined) s.partNumbers.delete(number);
          else s.partNumbers.set(number, id);
        }
        for (const {record, event} of vehicles) { s.vehicles.set(record.id, structuredClone(record)); s.events.set(event.id, structuredClone(event)); }
        for (const {record, event} of writes) {
          storeCrm(record); s.events.set(event.id, structuredClone(event));
        }
        if (writes.some(({record}) => record.kind === 'lead' || record.kind === 'customer')) s.leadPageEpoch++;
        if (writes.some(({record}) => record.kind === 'journal-entry' || record.kind === 'gl-account')) s.accountingEpoch++;
        if (writes.some(({record}) => serviceBoardKinds.has(record.kind))) s.serviceBoardEpoch++;
        if (vehicles.length || writes.some(({record}) => forecastKinds.has(record.kind))) s.forecastEpoch++;
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
        s.forecastEpoch++;
      },
      update: async (v, version, event) => {
        assertScope(tenantId, v); check(event); assertEvent(v.id, version + 1, event, 'vehicle.updated');
        if (s.vehicles.get(v.id)?.version !== version || v.version !== version + 1) throw conflict();
        s.vehicles.set(v.id, structuredClone(v)); s.events.set(event.id, structuredClone(event));
        s.forecastEpoch++;
      },
      delete: async (id, version, event) => {
        check(event); assertEvent(id, version + 1, event, 'vehicle.deleted');
        if (s.vehicles.get(id)?.version !== version) throw conflict();
        s.vehicles.delete(id); s.events.set(event.id, structuredClone(event));
        s.forecastEpoch++;
      },
      provision: async (tenant, user, membership, event, acceptance) => {
        if (acceptance) assertCrmWrites(tenantId, [acceptance]);
        assertScope(tenantId, membership); check(event); assertEvent(tenantId, 1, event, 'tenant.created');
        if (tenant.id !== tenantId || membership.userId !== user.id) throw new Error('Invalid provisioning scope');
        if (s.tenant) throw conflict();
        if (acceptance) { check(acceptance.event); storeCrm(acceptance.record); s.events.set(acceptance.event.id, structuredClone(acceptance.event)); }
        s.tenant = structuredClone(tenant); s.users.set(user.id, structuredClone(user));
        s.memberships.set(user.id, structuredClone(membership)); s.events.set(event.id, structuredClone(event));
      }
    };
  }
  /** Test-only inspection; never exposed by the API. */
  eventsForTest(tenantId: string): OutboxEvent[] { return structuredClone([...this.states.get(tenantId)?.events.values() ?? []]); }
}
