import { acceptanceWrite } from './invites.js';
import { validateMemberWrite } from './users.js';
import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Customer, Lead, CrmEntity, User, Membership, OutboxEvent, Tenant, Vehicle } from '@freedms/shared';
import { assertMfa, assertWebhookEndpoint, assertFeedConfig, assertVehicleWrites, assertCrmWrites, assertEvent, assertScope, matches, vehiclePage, leadPage, countLeads, serviceBoardKinds, serviceBoardSelection, salesReportSelection, forecastSelection, type VehicleQuery, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
export class DynamoRepositories implements RepositoryFactory {
  constructor(private table: string, private client = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {}
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    const PK = `TENANT#${tenantId}`;
    const list = async (query: VehicleQuery): Promise<Vehicle[]> => {
      const vehicles: Vehicle[] = [];
      let cursor: Record<string, unknown> | undefined;
      do {
        const result = await this.client.send(new QueryCommand({TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {':pk': PK, ':prefix': 'VEHICLE#'}, ConsistentRead: true, ExclusiveStartKey: cursor}));
        vehicles.push(...(result.Items ?? []).map(item => item.data as Vehicle).filter(v => matches(v, query)));
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return vehicles;
    };
    const key = (SK: string) => ({PK, SK});
    const get = async <T>(SK: string): Promise<T | undefined> => {
      const result = await this.client.send(new GetCommand({TableName: this.table, Key: key(SK), ConsistentRead: true}));
      return result.Item?.data as T | undefined;
    };
    const put = (SK: string, data: unknown, condition = 'attribute_not_exists(PK)', version?: number) => ({Put: {
      TableName: this.table, Item: {...key(SK), data}, ConditionExpression: condition,
      ...(version === undefined ? {} : {ExpressionAttributeNames: {'#d': 'data', '#v': 'version'}, ExpressionAttributeValues: {':v': version}})
    }});
    const eventPut = (event: OutboxEvent) => { assertScope(tenantId, event); return put(`EVENT#${event.id}`, event); };
    const transact = async (items: TransactWriteCommandInput['TransactItems']) => {
      try { await this.client.send(new TransactWriteCommand({TransactItems: items})); }
      catch (error) {
        if (error instanceof Error && error.name === 'TransactionCanceledException' &&
          (error as Error & {CancellationReasons?: {Code?: string}[]}).CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed')) throw conflict();
        throw error;
      }
    };
    const listRows = async <T>(prefix: string): Promise<T[]> => {
      const rows: T[] = []; let cursor: Record<string, unknown> | undefined;
      do {
        const result = await this.client.send(new QueryCommand({TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {':pk': PK, ':prefix': prefix}, ConsistentRead: true, ExclusiveStartKey: cursor}));
        rows.push(...(result.Items ?? []).map(item => item.data as T)); cursor = result.LastEvaluatedKey;
      } while (cursor);
      return rows;
    };
    const workspaceUsers = async () => {
      const [users, members] = await Promise.all([listRows<User>('USER#'), listRows<Membership>('MEMBER#')]);
      return members.map(membership => ({membership, user: users.find(u => u.id === membership.userId)!}));
    };
    return {
      acceptInvite: async (invite, user, now) => {
        const guard = await get<{version: number}>('MEMBERSHIP_GUARD');
        const current = await get<import('@freedms/shared').Invite>(`INVITE#${requireId(invite.id)}`);
        const write = acceptanceWrite(tenantId, current, invite, user, await workspaceUsers(), now);
        if (!write) return 'already-member';
        const {record, member, event, memberEvent} = write;
        await transact([
          put('MEMBERSHIP_GUARD', {version: (guard?.version ?? 0) + 1}, guard ? '#d.#v = :v' : 'attribute_not_exists(PK)', guard?.version),
          put(`INVITE#${invite.id}`, record, '#d.#v = :v', invite.version),
          put(`USER#${requireId(user.id)}`, user), put(`MEMBER#${user.id}`, member), eventPut(event), eventPut(memberEvent)
        ]);
        return 'accepted';
      },
      workspaceUsers,
      saveMember: async (user, member, expected, event) => {
        assertScope(tenantId, member, event);
        // Read the guard BEFORE the snapshot. Every membership writer advances it,
        // making last-admin and duplicate-email checks serializable, including legacy rows.
        const guard = await get<{version: number}>('MEMBERSHIP_GUARD');
        validateMemberWrite(user, member, expected, event, await workspaceUsers());
        await transact([
          put('MEMBERSHIP_GUARD', {version: (guard?.version ?? 0) + 1}, guard ? '#d.#v = :v' : 'attribute_not_exists(PK)', guard?.version),
          {Put: {TableName: this.table, Item: {...key(`USER#${requireId(user.id)}`), data: user}}},
          {Put: {TableName: this.table, Item: {...key(`MEMBER#${requireId(member.userId)}`), data: member}}}, eventPut(event)
        ]);
      },
      mfa: userId => get<MfaRecord>(`MFA#${requireId(userId)}`),
      saveMfa: async (record, expectedVersion, event) => {
        assertMfa(tenantId, record, expectedVersion, event);
        await transact([put(`MFA#${requireId(record.id)}`, record, expectedVersion ? '#d.#v = :v' : 'attribute_not_exists(PK)', expectedVersion || undefined), eventPut(event)]);
      },
      webhookEndpoints: () => listRows<WebhookEndpoint>('WEBHOOK#'),
      webhookEndpoint: id => get<WebhookEndpoint>(`WEBHOOK#${requireId(id)}`),
      saveWebhookEndpoint: async (record, expectedVersion, event) => {
        assertWebhookEndpoint(tenantId, record, expectedVersion, event);
        await transact([put(`WEBHOOK#${requireId(record.id)}`, record, expectedVersion ? '#d.#v = :v' : 'attribute_not_exists(PK)', expectedVersion || undefined), eventPut(event)]);
      },
      webhookDeliveries: () => listRows<WebhookDelivery>('DELIVERY#'),
      saveWebhookDelivery: async record => {
        assertScope(tenantId, record);
        await transact([{Put: {TableName: this.table, Item: {...key(`DELIVERY#${requireId(record.id)}`), data: record}}}]);
      },
      feedConfig: () => get<FeedConfig>('FEEDCONFIG#feed-config'),
      saveFeedConfig: async (record, expectedVersion, event) => { assertFeedConfig(tenantId, record, expectedVersion, event); await transact([put('FEEDCONFIG#feed-config', record, expectedVersion ? '#d.#v = :v' : 'attribute_not_exists(PK)', expectedVersion || undefined), eventPut(event)]); },
      appendFeedRun: async (record, event) => { assertScope(tenantId, record); assertEvent(record.id, 1, event, 'feed.generated'); await transact([put(`FEEDRUN#${requireId(record.id)}`, record), eventPut(event)]); },
      feedRuns: () => listRows<FeedRun>('FEEDRUN#'),
      feedRun: id => get<FeedRun>(`FEEDRUN#${requireId(id)}`),
      appendImport: async (record, event) => { assertScope(tenantId, record); assertEvent(record.id, 1, event, 'vehicle.imported'); await transact([put(`IMPORT#${requireId(record.id)}`, record), eventPut(event)]); },
      imports: () => listRows<InventoryImport>('IMPORT#'),
      events: () => listRows<OutboxEvent>('EVENT#'),
      appendAnalytics: async record => { assertScope(tenantId, record); await transact([put(`ANALYTICS#${requireId(record.id)}`, record)]); },
      analytics: () => listRows<AnalyticsRecord>('ANALYTICS#'),
      appendUsage: async usage => { assertScope(tenantId, usage); await transact([put(`USAGE#${requireId(usage.id)}`, usage)]); },
      usageForTest: () => listRows<QuickEntryUsage>('USAGE#'),
      users: async () => {
        const [users, members] = await Promise.all([listRows<User>('USER#'), listRows<Membership>('MEMBER#')]);
        return users.filter(u => members.some(m => m.userId === u.id && m.active));
      },
      serviceBoardEpoch: async () => (await get<{version: number}>('SERVICEBOARD#EPOCH'))?.version ?? 0,
      serviceBoard: async day => {
        const selection = serviceBoardSelection(day, true);
        // Still reads every row of these kinds; only retained rows are date-bounded.
        for (const prefix of ['SERVICE-APPOINTMENT#', 'REPAIR-ORDER#', 'SIGNATURE#', 'TECHNICIAN#']) {
          let cursor: Record<string, unknown> | undefined;
          do {
            const result = await this.client.send(new QueryCommand({TableName: this.table,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: {':pk': PK, ':prefix': prefix}, ConsistentRead: true, ExclusiveStartKey: cursor}));
            selection.add((function* () { for (const item of result.Items ?? []) yield item.data as CrmEntity; })());
            cursor = result.LastEvaluatedKey;
          } while (cursor);
        }
        return selection.finish();
      },
      forecastRows: async (window, now) => {
        const selection = forecastSelection(window, now);
        // Page through tenant prefixes; discard excluded rows before fetching the next page.
        for (const prefix of ['VEHICLE#', 'DEAL#', 'SERVICE-APPOINTMENT#', 'PART#', 'PARTS-SALE#', 'REPAIR-ORDER#']) {
          let cursor: Record<string, unknown> | undefined;
          do {
            const result = await this.client.send(new QueryCommand({TableName: this.table,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: {':pk': PK, ':prefix': prefix}, ConsistentRead: true, ExclusiveStartKey: cursor}));
            const records = (function* () {
              for (const item of result.Items ?? []) {
                const row = item.data as Vehicle | CrmEntity;
                assertScope(tenantId, row);
                yield row;
              }
            })();
            if (prefix === 'VEHICLE#') selection.addVehicles(records as Iterable<Vehicle>);
            else selection.add(records as Iterable<CrmEntity>);
            cursor = result.LastEvaluatedKey;
          } while (cursor);
        }
        return selection.finish();
      },
      salesReportRows: async range => {
        const selection = salesReportSelection(range);
        let cursor: Record<string, unknown> | undefined;
        // Read every deal page, but retain only in-range sold deals and their references.
        do {
          const result = await this.client.send(new QueryCommand({TableName: this.table,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: {':pk': PK, ':prefix': 'DEAL#'}, ConsistentRead: true, ExclusiveStartKey: cursor}));
          selection.add((function* () { for (const item of result.Items ?? []) yield item.data as CrmEntity; })());
          cursor = result.LastEvaluatedKey;
        } while (cursor);
        const vehicles: Vehicle[] = [], customers: Customer[] = [];
        for (const id of selection.vehicleIds) {
          const row = await get<Vehicle>(`VEHICLE#${requireId(id)}`);
          if (row) vehicles.push(row);
        }
        for (const id of selection.customerIds) {
          const row = await get<Customer>(`CUSTOMER#${requireId(id)}`);
          if (row) customers.push(row);
        }
        return {deals: selection.deals, vehicles, customers};
      },
      leadSummary: async () => {
        const summary = countLeads([]);
        let cursor: Record<string, unknown> | undefined;
        do {
          const result = await this.client.send(new QueryCommand({TableName: this.table,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: {':pk': PK, ':prefix': 'LEAD#'}, ConsistentRead: true, ExclusiveStartKey: cursor}));
          countLeads((function* () { for (const item of result.Items ?? []) yield item.data as Lead; })(), summary);
          cursor = result.LastEvaluatedKey;
        } while (cursor);
        return summary;
      },
      leadListPage: async query => {
        // Still reads every LEAD#/CUSTOMER# query page; pagination only bounds returned rows.
        const [leads, customers] = await Promise.all([listRows<Lead>('LEAD#'), listRows<Customer>('CUSTOMER#')]);
        return leadPage(leads, new Map(customers.map(c => [c.id, c])), query);
      },
      crmList: kind => listRows(`${kind.toUpperCase()}#`) as never,
      crmGet: (kind, id) => get<CrmEntity>(`${kind.toUpperCase()}#${requireId(id)}`) as never,
      crmWrite: async (writes, vehicles = []) => {
        assertVehicleWrites(tenantId, vehicles, writes);
        assertCrmWrites(tenantId, writes);
        // Reserve part numbers in the same transaction, including concurrent creates/renames.
        const reservations: NonNullable<TransactWriteCommandInput['TransactItems']> = [];
        for (const {record, expectedVersion} of writes) if (record.kind === 'part') {
          const old = expectedVersion ? await get<Extract<CrmEntity, {kind: 'part'}>>(`PART#${record.id}`) : undefined;
          if (!old || old.partNumber !== record.partNumber) {
            reservations.push(put(`PART-NUMBER#${record.partNumber}`, {id:record.id}));
            if (old) reservations.push({Delete:{TableName:this.table,Key:key(`PART-NUMBER#${old.partNumber}`),ConditionExpression:'#d.#id = :id',ExpressionAttributeNames:{'#d':'data','#id':'id'},ExpressionAttributeValues:{':id':record.id}}});
          }
        }
        if (writes.some(({record}) => serviceBoardKinds.has(record.kind))) {
          const epoch = await get<{version: number}>('SERVICEBOARD#EPOCH');
          reservations.push(put('SERVICEBOARD#EPOCH', {version: (epoch?.version ?? 0) + 1},
            epoch ? '#d.#v = :v' : 'attribute_not_exists(PK)', epoch?.version));
        }
        await transact([...reservations, ...vehicles.flatMap(({record, expectedVersion, event}) => [put(`VEHICLE#${requireId(record.id)}`, record, '#d.#v = :v', expectedVersion), eventPut(event)]), ...writes.flatMap(({record, expectedVersion, event}) => [
          put(`${record.kind.toUpperCase()}#${requireId(record.id)}`, record,
            expectedVersion ? '#d.#v = :v' : 'attribute_not_exists(PK)', expectedVersion || undefined), eventPut(event)])]);
      },
      membership: id => get<Membership>(`MEMBER#${requireId(id)}`),
      tenant: () => get<Tenant>('PROFILE'),
      get: id => get<Vehicle>(`VEHICLE#${requireId(id)}`),
      list,
      // Still reads every VEHICLE# query page; pagination only bounds the returned rows.
      listPage: async query => vehiclePage(await list(query), query),
      create: async (v, event) => {
        assertScope(tenantId, v); assertEvent(v.id, v.version, event, 'vehicle.created');
        await transact([put(`VEHICLE#${requireId(v.id)}`, v), eventPut(event)]);
      },
      update: async (v, version, event) => {
        assertScope(tenantId, v); assertEvent(v.id, version + 1, event, 'vehicle.updated');
        if (v.version !== version + 1) throw conflict();
        await transact([put(`VEHICLE#${requireId(v.id)}`, v, '#d.#v = :v', version), eventPut(event)]);
      },
      delete: async (id, version, event) => {
        assertEvent(id, version + 1, event, 'vehicle.deleted');
        await transact([{Delete: {TableName: this.table, Key: key(`VEHICLE#${requireId(id)}`),
          ConditionExpression: '#d.#v = :v', ExpressionAttributeNames: {'#d': 'data', '#v': 'version'}, ExpressionAttributeValues: {':v': version}}}, eventPut(event)]);
      },
      provision: async (tenant, user, membership, event) => {
        assertScope(tenantId, membership); assertEvent(tenantId, 1, event, 'tenant.created');
        if (tenant.id !== tenantId || membership.userId !== user.id) throw new Error('Invalid provisioning scope');
        await transact([put('PROFILE', tenant), put(`USER#${requireId(user.id)}`, user), put(`MEMBER#${user.id}`, membership), eventPut(event)]);
      }
    };
  }
}
