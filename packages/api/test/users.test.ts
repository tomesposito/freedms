import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { localSession } from '../src/local-session.js';
import { totp } from '../src/totp.js';
const now = new Date('2026-10-23T12:00:00Z');
async function setup(distinctOwners = false) {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('local-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: 'admin', name: distinctOwners && tenantId === 'B' ? 'Other Owner' : 'Admin', ...(distinctOwners && tenantId === 'B' ? {email: 'other@example.test'} : {})}, {tenantId, userId: 'admin', role: 'admin', active: true}, {id: 'bootstrap', tenantId, actorId: 'admin', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, async () => { throw Error('No network'); });
  const call = async (path = '/admin/users', method = 'GET', body: unknown = {}, tenant = 'A', user = 'admin', query?: Record<string, string>) => {
    const result = await handler({path, method, body: JSON.stringify(body), claims: tokens.verify(tokens.issue(user, tenant)), query});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const add = (email = 'staff@example.test', role = 'staff', tenant = 'A') => call('/admin/users', 'POST', {name: 'New User', email, role}, tenant);
  const change = (id: string, action: string, version: number, role?: string, tenant = 'A', actor = 'admin') => call(`/admin/users/${id}/${action}`, 'POST', {version, ...(role ? {role} : {})}, tenant, actor);
  return {repositories, tokens, handler, call, add, change};
}
test('user management isolates tenant lists, IDs, query/body scope and shared user IDs', async () => {
  const s = await setup(); const b = (await s.add('b@example.test', 'staff', 'B')).data;
  assert.deepEqual((await s.call()).data.map((u: {userId: string}) => u.userId), ['admin']);
  for (const id of [b.userId, 'unknown']) for (const action of ['role', 'deactivate', 'reactivate']) assert.equal((await s.change(id, action, 1, action === 'role' ? 'admin' : undefined)).status, 404);
  assert.equal((await s.call('/admin/users', 'GET', {}, 'A', 'admin', {tenantId: 'B'})).status, 400);
  assert.equal((await s.call('/admin/users', 'POST', {name: 'X', email: 'x@example.test', role: 'staff', tenantId: 'B'})).status, 400);
  assert.equal((await s.call(`/admin/users/${b.userId}`)).status, 404);
  assert.equal((await s.call('/admin/users', 'GET', {}, 'B')).data.length, 2);
  assert.equal((await s.repositories.forTenant('B').membership('admin'))?.role, 'admin');
});
test('staff is forbidden on every user management route and anonymous callers need auth', async () => {
  const s = await setup(); const staff = (await s.add()).data;
  for (const [path, method] of [['/admin/users', 'GET'], ['/admin/users', 'POST'], ...['role', 'deactivate', 'reactivate'].map(a => [`/admin/users/admin/${a}`, 'POST'])]) assert.equal((await s.call(path, method, {}, 'A', staff.userId)).status, 403);
  assert.equal((await s.handler({path: '/admin/users', method: 'GET'})).statusCode, 401);
});
test('last active admin cannot deactivate or self-demote; inactive admins do not count', async () => {
  const s = await setup();
  for (const action of ['role', 'deactivate']) assert.equal((await s.change('admin', action, 0, action === 'role' ? 'staff' : undefined)).error.code, 'LAST_ADMIN');
  const other = (await s.add('other@example.test', 'admin')).data;
  assert.equal((await s.change(other.userId, 'deactivate', 1)).status, 200);
  assert.equal((await s.change('admin', 'role', 0, 'staff')).error.code, 'LAST_ADMIN');
  assert.equal((await s.change(other.userId, 'reactivate', 2)).status, 200);
  assert.equal((await s.change('admin', 'role', 0, 'staff')).status, 200);
  assert.equal((await s.call()).status, 403);
  assert.equal((await s.change(other.userId, 'deactivate', 3, undefined, 'A', other.userId)).error.code, 'LAST_ADMIN');
});
test('added user signs in locally; the same token stops on deactivation and works on reactivation', async () => {
  const s = await setup(); const user = (await s.add()).data;
  const signed = await localSession(JSON.stringify({tenantId: 'A', email: 'STAFF@example.test'}), s.repositories, s.tokens, now);
  const claims = s.tokens.verify(JSON.parse(signed.body).data.token);
  const request = () => s.handler({path: '/session', method: 'GET', claims});
  assert.equal((await request()).statusCode, 200);
  assert.equal((await s.change(user.userId, 'deactivate', 1)).status, 200);
  assert.equal((await request()).statusCode, 403);
  assert.equal((await s.call('/users')).data.length, 1);
  assert.equal((await s.call()).data.length, 2);
  await assert.rejects(localSession(JSON.stringify({tenantId: 'A', email: 'staff@example.test'}), s.repositories, s.tokens, now), /active dealership/);
  assert.equal((await s.change(user.userId, 'reactivate', 2)).status, 200);
  assert.equal((await request()).statusCode, 200);
  await assert.rejects(localSession(JSON.stringify({tenantId: 'B', email: 'staff@example.test'}), s.repositories, s.tokens, now), /active dealership/);
});
test('existing local sign-in enforces MFA and management list exposes only enabled status', async () => {
  const s = await setup(); const user = (await s.add()).data;
  const secret = (await s.call('/account/mfa/setup', 'POST', {}, 'A', user.userId)).data.secret;
  const enabled = await s.call('/account/mfa/enable', 'POST', {code: totp(secret, now)}, 'A', user.userId);
  assert.equal(enabled.status, 200);
  const list = await s.call(); assert.equal(list.data[1].mfaEnabled, true);
  assert.ok(!JSON.stringify(list).includes(secret)); assert.ok(!JSON.stringify(list).includes('recovery'));
  await assert.rejects(localSession(JSON.stringify({tenantId: 'A', email: 'staff@example.test'}), s.repositories, s.tokens, now));
  assert.equal((await localSession(JSON.stringify({tenantId: 'A', email: 'staff@example.test', code: enabled.data.recoveryCodes[0]}), s.repositories, s.tokens, now)).statusCode, 200);
});
test('validation, normalized duplicate emails including inactive users, stale versions and no-op writes', async () => {
  const s = await setup();
  for (const patch of [{name: ''}, {email: 'bad'}, {role: 'owner'}, {email: ''}, {active: false}]) assert.equal((await s.call('/admin/users', 'POST', {name: 'Name', email: 'x@example.test', role: 'staff', ...patch})).status, 400);
  const user = (await s.add(' STAFF@example.test ')).data;
  assert.equal(user.email, 'staff@example.test');
  assert.equal((await s.add()).error.code, 'DUPLICATE_EMAIL');
  assert.equal((await s.change(user.userId, 'deactivate', 0)).status, 409);
  assert.equal((await s.change(user.userId, 'role', 1, 'staff')).status, 409);
  assert.equal((await s.change(user.userId, 'deactivate', 1)).status, 200);
  assert.equal((await s.add()).error.code, 'DUPLICATE_EMAIL');
  assert.equal((await s.add('staff@example.test', 'staff', 'B')).status, 201);
  assert.equal((await s.call('/admin/users', 'PUT')).status, 405);
});
test('membership events are metadata-only and emitted once for every successful mutation', async () => {
  const s = await setup(); const user = (await s.add()).data;
  await s.change(user.userId, 'role', 1, 'admin'); await s.change(user.userId, 'deactivate', 2); await s.change(user.userId, 'reactivate', 3);
  const events = (await s.repositories.forTenant('A').events()).filter(e => e.type.startsWith('user.'));
  assert.deepEqual(events.map(e => e.type), ['user.added', 'user.role_changed', 'user.deactivated', 'user.reactivated']);
  for (const [i, e] of events.entries()) {
    assert.deepEqual(Object.keys(e).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort());
    assert.equal(e.aggregateId, user.userId); assert.equal(e.actorId, 'admin'); assert.equal(e.aggregateVersion, i + 1);
  }
  assert.ok(!JSON.stringify(events).includes('example.test')); assert.ok(!JSON.stringify(events).includes('New User'));
});
test('concurrent last-admin removals and duplicate additions fail closed in memory', async () => {
  const s = await setup(); const other = (await s.add('other@example.test', 'admin')).data;
  const results = await Promise.all([s.change('admin', 'role', 0, 'staff'), s.change(other.userId, 'deactivate', 1)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await s.repositories.forTenant('A').workspaceUsers()).filter(r => r.membership.active && r.membership.role === 'admin').length, 1);
  const t = await setup(); const added = await Promise.all([t.add(), t.add()]); assert.equal(added.filter(r => r.status === 201).length, 1);
});
test('Dynamo membership writes use tenant keys, guard-before-snapshot and an atomic conditional outbox transaction', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const s = await setup(); const repo = s.repositories.forTenant('A');
  const rows = await repo.workspaceUsers();
  const client = {send: async (command: typeof commands[number]) => {
    commands.push(command);
    if (command instanceof QueryCommand) return {Items: rows.map(r => ({data: command.input.ExpressionAttributeValues?.[':prefix'] === 'USER#' ? r.user : r.membership}))};
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('table', client).forTenant('A');
  const user = {id: 'new', name: 'New', email: 'new@example.test'};
  const member = {userId: user.id, tenantId: 'A', role: 'staff' as const, active: true, version: 1};
  const event = {id: 'event', tenantId: 'A', actorId: 'admin', aggregateId: user.id, aggregateVersion: 1, type: 'user.added' as const, occurredAt: now.toISOString(), deliveryStatus: 'pending' as const};
  await dynamo.saveMember(user, member, 0, event);
  assert.deepEqual((commands[0] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'MEMBERSHIP_GUARD'});
  for (const c of commands.slice(1, 3) as QueryCommand[]) { assert.equal(c.input.ConsistentRead, true); assert.equal(c.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A'); }
  const items = (commands.at(-1) as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(items.map(i => i.Put?.Item?.SK), ['MEMBERSHIP_GUARD', 'USER#new', 'MEMBER#new', 'EVENT#event']);
  assert.ok(items.every(i => i.Put?.Item?.PK === 'TENANT#A'));
  assert.equal(items[0].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(items[3].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  await assert.rejects(dynamo.saveMember(user, {...member, tenantId: 'B'}, 0, event), /scope/);
  await assert.rejects(repo.saveMember(user, {...member, tenantId: 'B'}, 0, event), /scope/);
  const rejecting = {send: async (command: typeof commands[number]) => {
    if (command instanceof GetCommand) return {Item: {data: {version: 2}}};
    if (command instanceof TransactWriteCommand) {
      assert.equal(command.input.TransactItems![0].Put?.ExpressionAttributeValues?.[':v'], 2);
      throw Object.assign(Error('race'), {name: 'TransactionCanceledException', CancellationReasons: [{Code: 'ConditionalCheckFailed'}]});
    }
    return client.send(command as never);
  }} as unknown as DynamoDBDocumentClient;
  await assert.rejects(new DynamoRepositories('table', rejecting).forTenant('A').saveMember(user, member, 0, event), /changed/);
});

test('session exposes only the caller identity, with nullable email and tenant isolation', async () => {
  const s = await setup(true);
  const staff = (await s.add()).data;
  const events = await s.repositories.forTenant('A').events();
  const owner = await s.call('/session');
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.data.user, {id: 'admin', name: 'Admin', email: null});
  assert.deepEqual((await s.call('/session', 'GET', {}, 'A', staff.userId)).data.user, {id: staff.userId, name: 'New User', email: 'staff@example.test'});
  assert.deepEqual((await s.call('/session', 'GET', {}, 'B')).data.user, {id: 'admin', name: 'Other Owner', email: 'other@example.test'});
  assert.equal((await s.call('/session', 'GET', {}, 'B', staff.userId)).status, 403);
  assert.deepEqual(await s.repositories.forTenant('A').events(), events);
});
test('session remains available when the caller user row is missing', async () => {
  const s = await setup();
  const handler = createHandler({forTenant: id => ({...s.repositories.forTenant(id), users: async () => [{id: 'someone-else', name: 'Other user'}]})}, {decode: async () => { throw Error('No network'); }});
  const result = await handler({path: '/session', method: 'GET', claims: s.tokens.verify(s.tokens.issue('admin', 'A'))});
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).data.user, null);
});
