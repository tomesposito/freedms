import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { OutboxEvent, Vehicle } from '@freedms/shared';
import { DynamoRepositories } from '../src/dynamo.js';
const vehicle: Vehicle = {id: 'v', tenantId: 'A', version: 1, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 0, cost: 0, reconCosts: [], dateStocked: '2026-10-19', location: '', notes: '', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z'};
const event: OutboxEvent = {id: 'e', tenantId: 'A', actorId: 'user', aggregateId: 'v', aggregateVersion: 1, type: 'vehicle.created', occurredAt: vehicle.createdAt, deliveryStatus: 'pending'};
test('Dynamo uses tenant partition keys for every read and follows all list pages', async () => {
  let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand) => {
    if (command instanceof GetCommand) { assert.equal(command.input.Key?.PK, 'TENANT#A'); assert.equal(command.input.ConsistentRead, true); return {}; }
    assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
    assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'VEHICLE#'); pages++;
    return {Items: [{data: {...vehicle, id: String(pages)}}], ...(pages === 1 ? {LastEvaluatedKey: {PK: 'TENANT#A', SK: 'VEHICLE#1'}} : {})};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  await repo.get('v'); await repo.membership('user'); await repo.tenant();
  assert.equal((await repo.list({})).length, 2); assert.equal(pages, 2);
});
test('Dynamo mutations send the business row and event together, with optimistic conditions', async () => {
  const commands: TransactWriteCommand[] = [];
  const client = {send: async (command: TransactWriteCommand) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  await repo.create(vehicle, event);
  await repo.update({...vehicle, version: 2}, 1, {...event, id: 'e2', aggregateVersion: 2, type: 'vehicle.updated'});
  await repo.delete('v', 2, {...event, id: 'e3', aggregateVersion: 3, type: 'vehicle.deleted'});
  for (const command of commands) {
    assert.ok(command instanceof TransactWriteCommand); const items = command.input.TransactItems!; assert.equal(items.length, 2);
    assert.equal(items[1].Put?.Item?.PK, 'TENANT#A'); assert.match(items[1].Put?.Item?.SK, /^EVENT#/);
    assert.equal((items[0].Put?.Item ?? items[0].Delete?.Key)?.PK, 'TENANT#A');
  }
  assert.equal(commands[0].input.TransactItems![0].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(commands[1].input.TransactItems![0].Put?.ExpressionAttributeValues?.[':v'], 1);
  assert.equal(commands[2].input.TransactItems![0].Delete?.ExpressionAttributeValues?.[':v'], 2);
  await assert.rejects(repo.create({...vehicle, tenantId: 'B'}, event), /scope/);
  await assert.rejects(repo.create(vehicle, {...event, tenantId: 'B'}), /scope/);
  assert.equal(commands.length, 3);
});
test('transaction conditional failures become conflicts, infrastructure failures stay failures', async () => {
  const cancellation = Object.assign(new Error('cancelled'), {name: 'TransactionCanceledException', CancellationReasons: [{Code: 'ConditionalCheckFailed'}]});
  const client = {send: async () => { throw cancellation; }} as unknown as DynamoDBDocumentClient;
  await assert.rejects(new DynamoRepositories('table', client).forTenant('A').create(vehicle, event), {code: 'CONFLICT'});
});
