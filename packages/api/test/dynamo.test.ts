import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { OutboxEvent, Vehicle } from '@freedms/shared';
import { DynamoRepositories } from '../src/dynamo.js';
const vehicle: Vehicle = {id: 'v', tenantId: 'A', version: 1, mileage: null, stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 0, cost: 0, reconCosts: [], dateStocked: '2026-10-19', location: '', notes: '', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z'};
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

test('Dynamo CRM reads remain partition-bound and customer/lead/event writes form one conditional transaction', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    commands.push(command);
    if (command instanceof QueryCommand) { pages++; assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A'); return pages === 1 ? {Items: [], LastEvaluatedKey: {PK: 'TENANT#A', SK: 'CUSTOMER#c'}} : {Items: []}; }
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  await repo.crmGet('customer', 'c'); await repo.crmGet('lead', 'l'); await repo.crmGet('intake', 'token'); await repo.crmList('customer');
  assert.equal(pages, 2);
  for (const c of commands) if (c instanceof GetCommand) assert.equal(c.input.Key?.PK, 'TENANT#A');
  const customer = {kind: 'customer' as const, id: 'c', tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, name: 'Test', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown' as const, timestamp: null, source: ''}};
  const lead = {kind: 'lead' as const, id: 'l', tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, customerId: 'c', vehicleId: null, vehicleDescription: '', source: 'website' as const, sourceDetail: '', stage: 'new' as const, assigneeId: null, followUps: [], activities: []};
  const writes = [{record: customer, expectedVersion: 0, event: {...event, id: 'ec', aggregateId: 'c', type: 'customer.created' as const}}, {record: lead, expectedVersion: 0, event: {...event, id: 'el', aggregateId: 'l', type: 'lead.created' as const}}];
  await repo.crmWrite(writes);
  const transaction = commands.at(-1) as TransactWriteCommand;
  assert.equal(transaction.input.TransactItems?.length, 4);
  assert.deepEqual(transaction.input.TransactItems?.map(i => i.Put?.Item?.SK), ['CUSTOMER#c', 'EVENT#ec', 'LEAD#l', 'EVENT#el']);
  assert.ok(transaction.input.TransactItems?.every(i => i.Put?.Item?.PK === 'TENANT#A' && i.Put?.ConditionExpression === 'attribute_not_exists(PK)'));
  await repo.crmWrite([{...writes[1], record: {...lead, version: 2}, expectedVersion: 1, event: {...writes[1].event, aggregateVersion: 2, type: 'lead.updated'}}]);
  const update = commands.at(-1) as TransactWriteCommand;
  assert.equal(update.input.TransactItems?.[0].Put?.ExpressionAttributeValues?.[':v'], 1);
  const count = commands.length;
  await assert.rejects(repo.crmWrite([{...writes[0], record: {...customer, tenantId: 'B'}}]), /scope/);
  await assert.rejects(repo.crmWrite([{...writes[1], event: {...writes[1].event, tenantId: 'B'}}]), /scope/);
  assert.equal(commands.length, count);
});

test('Dynamo desking/settings use scoped keys and mixed sold writes are one conditional transaction', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  await repo.crmGet('deal', 'd'); await repo.crmGet('settings', 'workspace'); await repo.crmList('deal');
  assert.deepEqual(commands.slice(0, 2).map(c => (c as GetCommand).input.Key), [{PK: 'TENANT#A', SK: 'DEAL#d'}, {PK: 'TENANT#A', SK: 'SETTINGS#workspace'}]);
  assert.equal((commands[2] as QueryCommand).input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
  const settings = {id: 'workspace', kind: 'settings' as const, tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, taxRateBps: 625, taxTradeDifference: true, docFee: 25000};
  const settingsWrite = {record: settings, expectedVersion: 0, event: {...event, id: 'settings-event', aggregateId: 'workspace', type: 'settings.created' as const}};
  await repo.crmWrite([settingsWrite]);
  assert.equal((commands.at(-1) as TransactWriteCommand).input.TransactItems?.length, 2);
  const d = {id: 'd', kind: 'deal' as const, tenantId: 'A', version: 3, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, taxRateBps: 0, taxTradeDifference: false, docFee: 0, vehicleId: 'v', customerId: 'c', leadId: 'l', type: 'cash' as const, trade: null, pencils: [{type: 'cash' as const, id: 'p', name: 'Cash', fiSelections: [], lease: null, price: 100, down: 0, term: 36, aprBps: 0}], workingPencilId: 'p', status: 'sold' as const, history: []};
  const l = {id: 'l', kind: 'lead' as const, tenantId: 'A', version: 2, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, customerId: 'c', vehicleId: 'v', vehicleDescription: '', source: 'walk-in' as const, sourceDetail: '', stage: 'sold' as const, assigneeId: null, followUps: [], activities: []};
  const writes = [{record: d, expectedVersion: 2, event: {...event, id: 'ed', aggregateId: 'd', aggregateVersion: 3, type: 'deal.updated' as const}}, {record: l, expectedVersion: 1, event: {...event, id: 'el', aggregateId: 'l', aggregateVersion: 2, type: 'lead.updated' as const}}];
  const vehicles = [{record: {...vehicle, version: 2, status: 'sold' as const}, expectedVersion: 1, event: {...event, id: 'ev', aggregateVersion: 2, type: 'vehicle.updated' as const}}];
  await repo.crmWrite(writes, vehicles);
  const items = (commands.at(-1) as TransactWriteCommand).input.TransactItems!;
  assert.equal(items.length, 6); assert.ok(items.every(i => i.Put?.Item?.PK === 'TENANT#A'));
  assert.deepEqual(items.filter(i => !i.Put?.Item?.SK.startsWith('EVENT#')).map(i => i.Put?.ExpressionAttributeValues?.[':v']), [1, 2, 1]);
  const count = commands.length;
  await assert.rejects(repo.crmWrite([{...settingsWrite, record: {...settings, tenantId: 'B'}}]), /scope/);
  await assert.rejects(repo.crmWrite(writes, [{...vehicles[0], record: {...vehicles[0].record, tenantId: 'B'}}]), /scope/);
  await assert.rejects(repo.crmWrite(writes, [{...vehicles[0], event: {...vehicles[0].event, id: 'ed'}}]), /Invalid/);
  assert.equal(commands.length, count);
});

test('Dynamo MFA saves record and event atomically with scoped keys and conditional versions', async () => {
  const commands: (GetCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: typeof commands[number]) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const record: import('@freedms/shared').MfaRecord = {id: 'user', userId: 'user', tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.createdAt, enabled: false, secret: null, pendingSecret: 'TEST', recoveryHashes: [], failedAttempts: 0, lockedUntil: null, lastTotpStep: null};
  const change: OutboxEvent = {...event, id: 'mfa-event', aggregateId: 'user', type: 'mfa.setup'};
  await repo.saveMfa(record, 0, change);
  await repo.saveMfa({...record, version: 2}, 1, {...change, id: 'next', aggregateVersion: 2});
  await repo.mfa('user');
  const items = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.equal(items.length, 2); assert.deepEqual(items.map(i => i.Put?.Item?.SK), ['MFA#user', 'EVENT#mfa-event']);
  assert.ok(items.every(i => i.Put?.Item?.PK === 'TENANT#A' && i.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  const update = (commands[1] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(update.ConditionExpression, '#d.#v = :v'); assert.deepEqual(update.ExpressionAttributeValues, {':v': 1});
  assert.deepEqual((commands[2] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'MFA#user'});
  assert.equal((commands[2] as GetCommand).input.ConsistentRead, true);
  await assert.rejects(repo.saveMfa({...record, tenantId: 'B'}, 0, change), /scope/);
  await assert.rejects(repo.saveMfa(record, 0, {...change, tenantId: 'B'}), /scope/);
  await assert.rejects(repo.saveMfa(record, 0, {...change, type: 'vehicle.created'}), /outbox/);
  await assert.rejects(repo.saveMfa(record, 0, {...change, aggregateId: 'other'}), /outbox/);
  await assert.rejects(repo.saveMfa(record, 1, change), /version/);
  assert.equal(commands.length, 3);
});

test('Dynamo F&I generic CRM path uses scoped hyphenated keys and conditional versions', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: typeof commands[number]) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  await repo.crmGet('fi-product', 'p'); await repo.crmList('fi-product');
  assert.deepEqual((commands[0] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'FI-PRODUCT#p'});
  assert.equal((commands[1] as QueryCommand).input.ExpressionAttributeValues?.[':prefix'], 'FI-PRODUCT#');
  assert.equal((commands[1] as QueryCommand).input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
  const record: import('@freedms/shared').FiProduct = {id: 'p', kind: 'fi-product', tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, name: 'GAP', category: 'gap', cost: 100, retailPrice: 200, termNotes: '', active: true};
  const change: OutboxEvent = {...event, aggregateId: 'p', type: 'fi-product.created'};
  await repo.crmWrite([{record, expectedVersion: 0, event: change}]);
  let items = (commands.at(-1) as TransactWriteCommand).input.TransactItems!;
  assert.equal(items[0].Put?.Item?.SK, 'FI-PRODUCT#p'); assert.equal(items[0].Put?.Item?.PK, 'TENANT#A');
  assert.equal(items[0].Put?.ConditionExpression, 'attribute_not_exists(PK)'); assert.equal(items[1].Put?.Item?.PK, 'TENANT#A');
  await repo.crmWrite([{record: {...record, version: 2}, expectedVersion: 1, event: {...change, id: 'e2', aggregateVersion: 2, type: 'fi-product.updated'}}]);
  items = (commands.at(-1) as TransactWriteCommand).input.TransactItems!;
  assert.equal(items[0].Put?.ExpressionAttributeValues?.[':v'], 1);
});

test('Treasury records and lock use tenant partitions and atomic versioned outbox transactions offline', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  for (const kind of ['accounting-lock', 'bank-reconciliation'] as const) {
    await repo.crmGet(kind, 'id'); await repo.crmList(kind);
  }
  for (const c of commands) {
    if (c instanceof GetCommand) assert.equal(c.input.Key?.PK, 'TENANT#A');
    if (c instanceof QueryCommand) assert.equal(c.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
  }
  const lock = {id: 'ledger', tenantId: 'A', version: 1, createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt, kind: 'accounting-lock' as const};
  const period = {...lock, id: 'period', kind: 'bank-reconciliation' as const, accountId: 'account-1000', from: '2026-09-01', to: '2026-09-30', opening: 0, closing: 0, status: 'open' as const, lines: []};
  const {treasuryWrite} = await import('../src/treasury.js');
  const principal = {tenantId: 'A', userId: 'user', role: 'admin' as const};
  await repo.crmWrite([treasuryWrite(lock, principal), treasuryWrite(period, principal)]);
  const transaction = commands.at(-1) as TransactWriteCommand;
  assert.equal(transaction.input.TransactItems?.length, 4);
  assert.ok(transaction.input.TransactItems?.every(i => i.Put?.Item?.PK === 'TENANT#A' && i.Put?.ConditionExpression === 'attribute_not_exists(PK)'));
  for (const record of [lock, period]) {
    await assert.rejects(new DynamoRepositories('table', client).forTenant('B').crmWrite([treasuryWrite(record, principal)]), /scope/);
    await assert.rejects(repo.crmWrite([treasuryWrite({...record, tenantId: 'B'}, principal)]), /scope/);
  }
});

test('Audit outbox pagination and privacy reads stay in the authenticated tenant partition', async () => {
  let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand) => {
    if (command instanceof GetCommand) {
      assert.deepEqual(command.input.Key, {PK: 'TENANT#A', SK: 'PRIVACY-REQUEST#foreign-id'}); return {};
    }
    assert.equal(command.input.KeyConditionExpression, 'PK = :pk AND begins_with(SK, :prefix)');
    assert.deepEqual(command.input.ExpressionAttributeValues, {':pk': 'TENANT#A', ':prefix': 'EVENT#'});
    pages++;
    if (pages === 1) return {Items: [{data: event}], LastEvaluatedKey: {PK: 'TENANT#A', SK: 'EVENT#e'}};
    assert.deepEqual(command.input.ExclusiveStartKey, {PK: 'TENANT#A', SK: 'EVENT#e'});
    return {Items: [{data: {...event, id: 'second'}}]};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  assert.equal(await repo.crmGet('privacy-request', 'foreign-id'), undefined);
  assert.deepEqual((await repo.events()).map(e => e.id), ['e', 'second']); assert.equal(pages, 2);
});
