import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Membership, OutboxEvent, Tenant, Vehicle } from '@freedms/shared';
import { assertEvent, assertScope, matches, type RepositoryFactory, type TenantRepository } from './repository.js';
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
    return {
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
