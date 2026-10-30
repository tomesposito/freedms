import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { listAccessRequests, markAccessRequestHandled } from '../src/access-requests.js';
import { OPERATOR_TENANT_ID } from '../src/repository.js';
import { localAuth } from '../src/local-auth.js';

const fields = {contactName: 'Test Dealer', dealershipName: 'Test Motors', email: 'dealer@example.com', phone: '555-0100', inventorySize: '26-50', currentDms: 'Manual', message: 'Pilot please'};
const start = new Date('2026-10-30T12:00:00Z');
function setup() {
  const repositories = new MemoryRepositories();
  let now = start;
  const handle = createHandler(repositories, {decode: async () => { throw new Error('Unexpected VIN lookup'); }}, () => now);
  return {repositories, repo: repositories.forTenant(OPERATOR_TENANT_ID), setNow: (date: Date) => { now = date; },
    post: (body: unknown = fields, method = 'POST') => handle({method, path: '/access-requests', body: JSON.stringify(body)})};
}

test('public access capture stores only an operator record, with no membership, tenant or event', async () => {
  const {repositories, repo, post} = setup();
  const result = await post();
  assert.equal(result.statusCode, 201); assert.deepEqual(JSON.parse(result.body), {data: {received: true}});
  const records = await repo.accessRequests(); assert.equal(records.length, 1);
  assert.deepEqual(records[0], {...fields, id: records[0].id, tenantId: 'operator', status: 'pending', handledAt: null, version: 1, createdAt: start.toISOString(), updatedAt: start.toISOString()});
  for (const partition of [repo, repositories.forTenant('real-dealership')]) {
    assert.equal(await partition.tenant(), undefined);
    assert.deepEqual(await partition.users(), []); assert.deepEqual(await partition.workspaceUsers(), []);
    assert.deepEqual(await partition.events(), []); assert.deepEqual(await partition.crmList('invite'), []);
  }
  assert.deepEqual(await repositories.forTenant('real-dealership').accessRequests(), []);
  assert.deepEqual(localAuth('/access-requests/', false, '', {verify: () => { throw new Error('Must be public'); }}), {});
});

test('access capture validates required fields, field types, lengths, inventory and method', async () => {
  const {post, repo} = setup();
  for (const body of [
    {...fields, email: undefined}, {...fields, email: 'bad'}, {...fields, contactName: ''}, {...fields, dealershipName: undefined},
    {...fields, tenantId: 'injected'}, {...fields, inventorySize: '500'}, {...fields, phone: 123},
    {...fields, contactName: 'a'.repeat(121)}, {...fields, dealershipName: 'a'.repeat(161)},
    {...fields, phone: 'a'.repeat(41)}, {...fields, currentDms: 'a'.repeat(121)}, {...fields, message: 'a'.repeat(2001)},
    [], null
  ]) {
    const result = await post(body); assert.equal(result.statusCode, 400); assert.equal(JSON.parse(result.body).error.code, 'VALIDATION');
  }
  assert.equal((await post(fields, 'GET')).statusCode, 405);
  assert.deepEqual(await repo.accessRequests(), []);
});

test('honeypot drops before required validation, but after unknown keys and body limit', async () => {
  const {post, repo} = setup();
  const result = await post({website: ' bot.example '});
  assert.equal(result.statusCode, 201); assert.deepEqual(JSON.parse(result.body), {data: {received: true}});
  assert.equal((await post({website: 'bot', extra: true})).statusCode, 400);
  assert.equal((await post({...fields, website: 'bot', message: 'x'.repeat(16 * 1024)})).statusCode, 400);
  assert.deepEqual(await repo.accessRequests(), []);
});

test('repeated email updates one record and preserves identity, creation and handled status', async () => {
  const {post, repo, repositories, setNow} = setup();
  await post(); const first = (await repo.accessRequests())[0];
  const later = new Date('2026-10-31T12:00:00Z'); setNow(later);
  assert.equal((await post({...fields, email: fields.email.toUpperCase(), contactName: 'Updated'})).statusCode, 201);
  const records = await repo.accessRequests(); assert.equal(records.length, 1);
  assert.equal(records[0].id, first.id); assert.equal(records[0].createdAt, first.createdAt);
  assert.equal(records[0].version, 2); assert.equal(records[0].contactName, 'Updated'); assert.equal(records[0].updatedAt, later.toISOString());
  await markAccessRequestHandled(repositories, fields.email, later);
  await post({...fields, message: 'Again'});
  const handled = (await repo.accessRequests())[0];
  assert.equal(handled.status, 'handled'); assert.equal(handled.handledAt, later.toISOString()); assert.equal(handled.version, 4);
});

test('operator lists pending newest-first with email tie-break and marks handled', async () => {
  const {post, repositories, setNow} = setup();
  await post(); setNow(new Date('2026-10-31T12:00:00Z'));
  await post({...fields, email: 'z@example.com'}); await post({...fields, email: 'a@example.com'});
  assert.deepEqual((await listAccessRequests(repositories)).map(r => r.email), ['a@example.com', 'z@example.com', fields.email]);
  const handled = await markAccessRequestHandled(repositories, 'A@example.com', start);
  assert.equal(handled.status, 'handled'); assert.equal(handled.handledAt, start.toISOString()); assert.equal(handled.version, 2);
  assert.equal((await listAccessRequests(repositories)).length, 2);
  for (const email of ['missing@example.com', 'a@example.com']) await assert.rejects(markAccessRequestHandled(repositories, email, start), {message: 'No pending access request for that email.'});
});

test('memory access request writes reject stale versions and wrong scope and clone records', async () => {
  const {post, repo} = setup(); await post(); const record = (await repo.accessRequests())[0];
  await assert.rejects(repo.saveAccessRequest({...record, version: 2}, 0), /version/);
  await assert.rejects(repo.saveAccessRequest(record, 0), {code: 'CONFLICT'});
  await assert.rejects(repo.saveAccessRequest({...record, tenantId: 'other', version: 2}, 1), /scope/);
  record.message = 'changed'; assert.equal((await repo.accessRequest(fields.email))?.message, fields.message);
});

test('Dynamo access requests use operator keys, conditional writes without events, and paginated prefix queries', async () => {
  const {post, repo} = setup(); await post(); const record = (await repo.accessRequests())[0];
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = []; let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    commands.push(command);
    if (command instanceof GetCommand) return {Item: {data: record}};
    if (command instanceof QueryCommand) {
      pages++; return {Items: [{data: record}], ...(pages === 1 ? {LastEvaluatedKey: {PK: 'TENANT#operator', SK: 'ACCESSREQUEST#dealer@example.com'}} : {})};
    }
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('fake-table', client).forTenant(OPERATOR_TENANT_ID);
  await dynamo.saveAccessRequest(record, 0); await dynamo.saveAccessRequest({...record, version: 2}, 1);
  for (const command of commands as TransactWriteCommand[]) {
    const items = command.input.TransactItems!; assert.equal(items.length, 1);
    assert.equal(items[0].Put?.Item?.PK, 'TENANT#operator'); assert.equal(items[0].Put?.Item?.SK, 'ACCESSREQUEST#dealer@example.com');
  }
  assert.equal((commands[0] as TransactWriteCommand).input.TransactItems![0].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  const update = (commands[1] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(update.ConditionExpression, '#d.#v = :v'); assert.equal(update.ExpressionAttributeValues?.[':v'], 1);
  assert.equal((await dynamo.accessRequest(fields.email.toUpperCase()))?.id, record.id);
  assert.deepEqual((commands[2] as GetCommand).input.Key, {PK: 'TENANT#operator', SK: 'ACCESSREQUEST#dealer@example.com'});
  assert.equal((await dynamo.accessRequests()).length, 2); assert.equal(pages, 2);
  for (const command of commands.filter(c => c instanceof QueryCommand)) {
    assert.deepEqual(command.input.ExpressionAttributeValues, {':pk': 'TENANT#operator', ':prefix': 'ACCESSREQUEST#'});
    assert.equal(command.input.ConsistentRead, true);
  }
  await assert.rejects(dynamo.saveAccessRequest({...record, tenantId: 'other'}, 0), /scope/);
  await assert.rejects(dynamo.saveAccessRequest({...record, version: 3}, 0), /version/);
});

test('access capture refuses oversized UTF-8 bodies before saving', async () => {
  const {post, repo} = setup();
  const result = await post({...fields, message: 'é'.repeat(8192)});
  assert.equal(result.statusCode, 400); assert.equal(JSON.parse(result.body).error.code, 'VALIDATION');
  assert.deepEqual(await repo.accessRequests(), []);
});
