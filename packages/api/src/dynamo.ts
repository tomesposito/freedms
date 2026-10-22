import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { CrmEntity, User, Membership, OutboxEvent, Tenant, Vehicle } from '@freedms/shared';
import { assertMfa, assertWebhookEndpoint, assertFeedConfig, assertVehicleWrites, assertCrmWrites, assertEvent, assertScope, matches, type RepositoryFactory, type TenantRepository } from './repository.js';
import { conflict, requireId } from './errors.js';
export class DynamoRepositories implements RepositoryFactory {
  constructor(private table: string, private client = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {}
  forTenant(tenantId: string): TenantRepository {
    requireId(tenantId);
    const PK = `TENANT#${tenantId}`;
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
    return {
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
      crmList: kind => listRows(`${kind.toUpperCase()}#`) as never,
      crmGet: (kind, id) => get<CrmEntity>(`${kind.toUpperCase()}#${requireId(id)}`) as never,
      crmWrite: async (writes, vehicles = []) => {
        assertVehicleWrites(tenantId, vehicles, writes);
        assertCrmWrites(tenantId, writes);
        await transact([...vehicles.flatMap(({record, expectedVersion, event}) => [put(`VEHICLE#${requireId(record.id)}`, record, '#d.#v = :v', expectedVersion), eventPut(event)]), ...writes.flatMap(({record, expectedVersion, event}) => [
          put(`${record.kind.toUpperCase()}#${requireId(record.id)}`, record,
            expectedVersion ? '#d.#v = :v' : 'attribute_not_exists(PK)', expectedVersion || undefined), eventPut(event)])]);
      },
      membership: id => get<Membership>(`MEMBER#${requireId(id)}`),
      tenant: () => get<Tenant>('PROFILE'),
      get: id => get<Vehicle>(`VEHICLE#${requireId(id)}`),
      list: async query => {
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
      },
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
