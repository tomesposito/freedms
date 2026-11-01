import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { canTransitionIdea, ideaStatuses, PRODUCT_VERSION, type AuthClaims, type Idea, type OutboxEvent } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';

const fields = {title: '  Faster stock lookup  ', description: '  Remember my inventory search.  ', surface: '/ideas'};
async function setup() {
  const repositories = new MemoryRepositories();
  let now = new Date('2026-11-01T12:00:00Z');
  for (const tenantId of ['a', 'b', 'ops']) {
    const repo = repositories.forTenant(tenantId);
    await repo.provision({id: tenantId, name: `${tenantId} Motors`, createdAt: now.toISOString()}, {id: 'admin', name: 'Owner'},
      {tenantId, userId: 'admin', role: 'admin', active: true}, {id: 'bootstrap', tenantId, actorId: 'admin', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
    for (const id of ['one', 'two']) await repo.saveMember({id, name: `Member ${id}`, email: `${id}@example.test`}, {tenantId, userId: id, role: 'staff', active: true, version: 1}, 0,
      {id: `member-${id}`, tenantId, actorId: 'admin', aggregateId: id, aggregateVersion: 1, type: 'user.added', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  }
  const handler = createHandler(repositories, {decode: async () => { throw Error('Offline'); }}, () => now, undefined, undefined, undefined, undefined, {pilotOperator: {tenantId: 'ops', userId: 'admin'}});
  const call = async (path = '/ideas', method = 'GET', body?: unknown, tenantId = 'a', userId = 'one') => handler({path, method, body: body === undefined ? undefined : JSON.stringify(body), claims: {sub: userId, 'custom:tenant_id': tenantId} as AuthClaims});
  const submit = async (tenantId = 'a', userId = 'one'): Promise<Idea> => {
    const result = await call('/ideas', 'POST', fields, tenantId, userId); assert.equal(result.statusCode, 201, result.body); return JSON.parse(result.body).data;
  };
  return {repositories, handler, call, submit, advance: () => { now = new Date(now.getTime() + 1000); }};
}
const data = (result: {body: string}) => JSON.parse(result.body).data;

test('Ideas submit trims input, stamps identity/version and emits an atomic metadata-only outbox event', async () => {
  const s = await setup(), idea = await s.submit();
  assert.equal(idea.title, fields.title.trim()); assert.equal(idea.description, fields.description.trim());
  assert.equal(idea.submitter.id, 'one'); assert.equal(idea.submitter.email, 'one@example.test');
  assert.equal(idea.productVersion, PRODUCT_VERSION); assert.equal(idea.status, 'Received');
  assert.deepEqual(data(await s.call()), [idea]);
  const events = (await s.repositories.forTenant('a').events()).filter(e => e.type === 'idea.submitted');
  assert.equal(events.length, 1); assert.equal(events[0].aggregateId, idea.id); assert.equal(events[0].aggregateVersion, 1);
  assert.ok(!JSON.stringify(events).includes(idea.description));
});
test('Ideas member reads are private, dealership reads require admin, and tenants cannot read each other', async () => {
  const s = await setup(); await s.submit(); await s.submit('a', 'two'); await s.submit('b');
  assert.equal(data(await s.call()).length, 1);
  assert.equal(data(await s.call('/ideas', 'GET', undefined, 'a', 'two'))[0].submitter.id, 'two');
  assert.equal((await s.call('/ideas/dealership')).statusCode, 403);
  assert.equal(data(await s.call('/ideas/dealership', 'GET', undefined, 'a', 'admin')).length, 2);
  assert.equal(data(await s.call('/ideas/dealership', 'GET', undefined, 'b', 'admin')).length, 1);
  assert.equal((await s.handler({path: '/ideas', method: 'GET'})).statusCode, 401);
});
test('Ideas queue and status writes require exactly the configured active operator', async () => {
  const s = await setup(), idea = await s.submit();
  const path = `/admin/ideas/a/${idea.id}`;
  for (const [tenant, user] of [['a', 'one'], ['a', 'admin'], ['b', 'admin'], ['ops', 'one']]) {
    assert.equal((await s.call('/admin/ideas', 'GET', undefined, tenant, user)).statusCode, 403);
    assert.equal((await s.call(path, 'PUT', {version: 1, status: 'Accepted'}, tenant, user)).statusCode, 403);
  }
  const queue = data(await s.call('/admin/ideas', 'GET', undefined, 'ops', 'admin'));
  assert.equal(queue.length, 1); assert.equal(queue[0].tenantName, 'a Motors'); assert.equal(queue[0].submitter.id, 'one');
  assert.equal((await s.call(`/ideas/${idea.id}`, 'PUT', {status: 'Shipped'})).statusCode, 404);
  assert.equal((await s.call(`/admin/ideas/b/${idea.id}`, 'PUT', {version: 1, status: 'Accepted'}, 'ops', 'admin')).statusCode, 404);
});
test('Ideas validates required fields, caps, unexpected fields, query scope and supported methods', async () => {
  const s = await setup();
  for (const body of [{...fields, title: ''}, {...fields, description: '  '}, {...fields, title: 'x'.repeat(161)}, {...fields, description: 'x'.repeat(5001)}, {...fields, surface: {}}, {...fields, tenantId: 'b'}, {...fields, status: 'Shipped'}, {...fields, submitter: {id: 'two'}}]) {
    assert.equal((await s.call('/ideas', 'POST', body)).statusCode, 400);
  }
  assert.equal((await s.call('/ideas', 'DELETE')).statusCode, 405);
  assert.equal((await s.handler({path: '/ideas', method: 'GET', query: {tenantId: 'b'}, claims: {sub: 'one', 'custom:tenant_id': 'a'} as AuthClaims})).statusCode, 400);
  assert.deepEqual(data(await s.call()), []);
});
test('Ideas transitions allow operator corrections, but never reset to Received or accept unknown states', () => {
  for (const from of ideaStatuses) for (const to of ideaStatuses) assert.equal(canTransitionIdea(from, to), to !== 'Received');
  assert.equal(canTransitionIdea('Received', 'unknown' as never), false);
});
test('Ideas status changes require decline reasons, persist timestamps and notes, and reject stale writes', async () => {
  const s = await setup(), idea = await s.submit(), path = `/admin/ideas/a/${idea.id}`;
  const update = (body: unknown) => s.call(path, 'PUT', body, 'ops', 'admin');
  assert.equal((await update({version: 1, status: 'Declined'})).statusCode, 400);
  assert.equal((await update({version: 1, status: 'Declined', declineReason: ' '})).statusCode, 400);
  assert.equal((await update({status: 'Accepted'})).statusCode, 400);
  assert.equal((await update({version: 1, status: 'Received'})).statusCode, 400);
  s.advance();
  const declined = data(await update({version: 1, status: 'Declined', declineReason: ' Outside the product vision. '}));
  assert.equal(declined.declineReason, 'Outside the product vision.'); assert.notEqual(declined.updatedAt, idea.updatedAt);
  assert.equal((await update({version: 1, status: 'Accepted'})).statusCode, 409);
  const shipped = data(await update({version: 2, status: 'Shipped', shippedNote: ' Release 0.2 '}));
  assert.equal(shipped.shippedNote, 'Release 0.2'); assert.equal(shipped.declineReason, null);
  assert.deepEqual(data(await s.call()), [shipped]);
  assert.equal(data(await update({version: 3, status: 'Under review'})).shippedNote, null);
  assert.equal(data(await update({version: 4, status: 'Accepted'})).status, 'Accepted');
  assert.equal(data(await update({version: 5, status: 'Shipped'})).shippedNote, null);
  assert.equal((await s.repositories.forTenant('a').events()).filter(e => e.type === 'idea.status_changed').length, 5);
});
test('Ideas memory storage rejects tenant injection and conflicting writes without partial outbox changes', async () => {
  const s = await setup(), idea = await s.submit(), repo = s.repositories.forTenant('a');
  const event: OutboxEvent = {id: 'update', tenantId: 'a', actorId: 'admin', aggregateId: idea.id, aggregateVersion: 2, type: 'idea.status_changed', occurredAt: idea.updatedAt, deliveryStatus: 'pending'};
  await assert.rejects(repo.saveIdea({...idea, tenantId: 'b', version: 2}, 1, event), /scope/);
  await assert.rejects(repo.saveIdea({...idea, version: 3}, 2, {...event, aggregateVersion: 3}), {code: 'CONFLICT'});
  assert.equal((await repo.idea(idea.id))?.version, 1); assert.ok(!(await repo.events()).some(e => e.id === 'update'));
});
test('Ideas Dynamo reads paginate tenant and operator partitions, writes atomically persist row, event and queue', async () => {
  const s = await setup(), idea = await s.submit();
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    commands.push(command);
    if (command instanceof QueryCommand) { pages++; return {Items: [{data: idea}], ...(pages % 2 ? {LastEvaluatedKey: {PK: 'cursor', SK: 'cursor'}} : {})}; }
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const factory = new DynamoRepositories('table', client), repo = factory.forTenant('a');
  await repo.idea(idea.id); assert.equal((commands[0] as GetCommand).input.Key?.PK, 'TENANT#a');
  assert.equal((await repo.ideas()).length, 2); assert.equal((await factory.ideasQueue()).length, 2);
  const queries = commands.filter(c => c instanceof QueryCommand);
  assert.deepEqual(queries.map(c => c.input.ExpressionAttributeValues?.[':pk']), ['TENANT#a', 'TENANT#a', 'OPERATOR#IDEAS', 'OPERATOR#IDEAS']);
  assert.ok(queries[1].input.ExclusiveStartKey); assert.ok(queries[3].input.ExclusiveStartKey);
  const event = (await s.repositories.forTenant('a').events()).find(e => e.type === 'idea.submitted')!;
  await repo.saveIdea(idea, 0, event);
  await repo.saveIdea({...idea, version: 2}, 1, {...event, id: 'changed', aggregateVersion: 2, type: 'idea.status_changed'});
  const writes = commands.filter(c => c instanceof TransactWriteCommand);
  assert.equal(writes[0].input.TransactItems?.length, 3);
  assert.deepEqual(writes[0].input.TransactItems?.map(i => i.Put?.Item?.PK), ['TENANT#a', 'TENANT#a', 'OPERATOR#IDEAS']);
  assert.equal(writes[0].input.TransactItems?.[0].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(writes[1].input.TransactItems?.[0].Put?.ExpressionAttributeValues?.[':v'], 1);
  await assert.rejects(repo.saveIdea({...idea, tenantId: 'b'}, 0, event), /scope/);
});
test('Ideas inherits existing global infrastructure throttles and product version matches the root package', () => {
  const template = readFileSync('infra/template.yaml', 'utf8');
  assert.match(template, /ThrottlingRateLimit: 100/); assert.match(template, /ThrottlingBurstLimit: 200/);
  assert.match(template, /RateBasedStatement: \{Limit: 600, AggregateKeyType: IP, EvaluationWindowSec: 300\}/);
  assert.equal(PRODUCT_VERSION, JSON.parse(readFileSync('package.json', 'utf8')).version);
});
