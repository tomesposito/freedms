import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Invite } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { LocalTokens } from '../src/auth.js';
import { localSession } from '../src/local-session.js';
import { localAuth } from '../src/local-auth.js';
import { createHandler } from '../src/handler.js';
const now = new Date('2026-10-25T12:00:00Z');
const payload = () => ({onboarding: true, name: 'Owner', email: 'OWNER@example.test', dealership: 'Test Motors', address: '123 Main Street', phone: '555-0100', dealerType: 'independent', invites: [{name: 'Staff', email: 'staff@example.test', role: 'staff'}, {name: 'Admin', email: 'admin@example.test', role: 'admin'}]});
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('local-test-secret-at-least-32-characters', () => now.getTime());
  let clock = now;
  const handler = createHandler(repositories, {decode: async () => { throw Error('Offline only'); }}, () => clock);
  const create = async () => {
    const result = await localSession(JSON.stringify(payload()), repositories, tokens, now);
    assert.equal(result.statusCode, 201);
    return JSON.parse(result.body).data as {token: string; invites: Invite[]};
  };
  const call = async (path: string, token = '', method = 'GET', body?: unknown) => {
    const result = await handler({path, method, body: body === undefined ? undefined : JSON.stringify(body), ...localAuth(path, false, token, tokens)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  return {repositories, tokens, create, call, advance: (date: Date) => { clock = date; }};
}
test('wizard provisions the profile, admin email and seven-day pending invites with metadata-only outbox events', async () => {
  const s = await setup(), created = await s.create(), claims = s.tokens.verify(created.token);
  const repo = s.repositories.forTenant(claims['custom:tenant_id']);
  assert.deepEqual(await repo.tenant(), {id: claims['custom:tenant_id'], name: 'Test Motors', address: '123 Main Street', phone: '555-0100', dealerType: 'independent', createdAt: now.toISOString()});
  const users = await repo.workspaceUsers(); assert.equal(users.length, 1); assert.equal(users[0].user.email, 'owner@example.test'); assert.equal(users[0].membership.role, 'admin');
  assert.equal(created.invites.length, 2);
  for (const invite of created.invites) {
    assert.equal(invite.status, 'pending'); assert.equal(invite.expiresAt, '2026-11-01T12:00:00.000Z');
    assert.equal(invite.tokenHash, createHash('sha256').update(invite.token).digest('hex'));
    assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: true, dealership: 'Test Motors', inviter: 'Owner', name: invite.name, email: invite.email, role: invite.role});
  }
  const events = (await repo.events()).filter(e => e.type === 'invite.created'); assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.aggregateId), created.invites.map(i => i.id));
  assert.ok(!JSON.stringify(events).includes('token')); assert.ok(!JSON.stringify(events).includes('example.test'));
  assert.equal((await repo.list({})).length, 0);
});
test('invalid wizard payloads never access a repository or provision a tenant', async () => {
  const s = await setup();
  const invalid = [{invites: [{name: 'X', email: 'bad', role: 'staff'}]}, {invites: [payload().invites[0], {...payload().invites[0], email: ' STAFF@example.test '}]}, {invites: [{name: 'Me', email: 'owner@example.test', role: 'admin'}]}, {dealerType: 'unknown'}, {email: 'bad'}, {address: ''}, {phone: ''}, {invites: Array(11).fill(payload().invites[0])}];
  for (const patch of invalid) await assert.rejects(localSession(JSON.stringify({...payload(), ...patch}), {forTenant: () => { assert.fail('Validation must precede repository access'); }}, s.tokens, now), error => (error as {status: number}).status === 400);
});
test('invite lists and mutations isolate tenants and forbid staff', async () => {
  const s = await setup(), a = await s.create(), b = await s.create();
  assert.deepEqual((await s.call('/admin/invites', a.token)).data.map((i: Invite) => i.id).sort(), a.invites.map(i => i.id).sort());
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`/admin/invites/${b.invites[0].id}/${action}`, a.token, 'POST', {version: 1})).status, 404);
  const staff = (await s.call('/admin/users', a.token, 'POST', {name: 'Staff', email: 'member@example.test', role: 'staff'})).data;
  const token = s.tokens.issue(staff.userId, s.tokens.verify(a.token)['custom:tenant_id']);
  assert.equal((await s.call('/admin/invites', token)).status, 403);
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`/admin/invites/${a.invites[0].id}/${action}`, token, 'POST', {version: 1})).status, 403);
});
test('reissue rotates credentials, stale writes fail, revoke is final, and mutations emit events', async () => {
  const s = await setup(), a = await s.create(), old = a.invites[0];
  const path = `/admin/invites/${old.id}`;
  const reissued = await s.call(`${path}/reissue`, a.token, 'POST', {version: 1}); assert.equal(reissued.status, 200);
  assert.notEqual(reissued.data.token, old.token);
  assert.equal((await s.call(`/invite/${old.token}`)).data.valid, false);
  assert.equal((await s.call(`/invite/${reissued.data.token}`)).data.valid, true);
  assert.equal((await s.call(`${path}/revoke`, a.token, 'POST', {version: 1})).status, 409);
  const revoked = await s.call(`${path}/revoke`, a.token, 'POST', {version: 2}); assert.equal(revoked.status, 200);
  assert.equal(revoked.data.token, ''); assert.equal(revoked.data.tokenHash, ''); assert.equal(revoked.data.status, 'revoked');
  assert.equal((await s.call(`/invite/${reissued.data.token}`)).data.valid, false);
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`${path}/${action}`, a.token, 'POST', {version: 3})).status, 409);
  const events = await s.repositories.forTenant(old.tenantId).events();
  assert.deepEqual(events.filter(e => e.type === 'invite.updated').map(e => e.aggregateVersion), [2, 3]);
});
test('expired, malformed and unknown public tokens return 200 invalid through local auth', async () => {
  const s = await setup(), a = await s.create();
  s.advance(new Date('2026-11-01T12:00:00Z'));
  for (const token of [a.invites[0].token, '', 'bad', '%.oops', `unknown.${'a'.repeat(64)}`, `${a.invites[0].tenantId}.${'b'.repeat(64)}`]) {
    const result = await s.call(`/invite/${token}`); assert.equal(result.status, 200); assert.deepEqual(result.data, token === a.invites[0].token ? {valid: false, reason: 'expired'} : {valid: false});
  }
  assert.deepEqual(localAuth('/invite/token', false, '', {verify: () => { throw Error('Must not verify'); }}), {});
  assert.throws(() => localAuth('/admin/invites', false, '', s.tokens));
});
test('acceptance is atomic, single-use, role-fixed, isolated and signs in as staff', async () => {
  const s = await setup(), a = await s.create(), b = await s.create(), invite = a.invites[0];
  const repo = s.repositories.forTenant(invite.tenantId), other = s.repositories.forTenant(b.invites[0].tenantId);
  const before = await other.workspaceUsers(), otherInvites = await other.crmList('invite');
  const path = `/invite/${invite.token}/accept`, body = {name: 'New Name', email: 'STAFF@example.test'};
  for (const extra of [{role: 'admin'}, {tenantId: b.invites[0].tenantId}]) assert.equal((await s.call(path, '', 'POST', {...body, ...extra})).status, 400);
  assert.equal((await s.call(path, '', 'POST', {...body, email: 'wrong@example.test'})).data.outcome, 'email-mismatch');
  assert.equal((await repo.workspaceUsers()).length, 1);
  assert.equal((await s.call(`/invite/${b.invites[0].tenantId}.${invite.token.split('.')[1]}/accept`, '', 'POST', body)).data.outcome, 'refused');
  const results = await Promise.all([s.call(path, '', 'POST', body), s.call(path, '', 'POST', body)]);
  assert.equal(results.filter(r => r.data.outcome === 'accepted').length, 1);
  assert.equal(results.filter(r => r.data.outcome === 'refused').length, 1);
  const accepted = (await repo.crmGet('invite', invite.id))!;
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.acceptedAt, now.toISOString()); assert.equal(accepted.acceptedName, 'New Name');
  assert.equal(accepted.token, ''); assert.equal(accepted.tokenHash, '');
  const rows = await repo.workspaceUsers(); assert.equal(rows.length, 2);
  assert.equal(rows[1].user.id, accepted.acceptedUserId); assert.equal(rows[1].membership.role, 'staff'); assert.equal(rows[1].membership.active, true);
  assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: false, reason: 'accepted'});
  assert.equal((await s.call(path, '', 'POST', body)).data.reason, 'accepted');
  const signed = await localSession(JSON.stringify({tenantId: invite.tenantId, email: invite.email}), s.repositories, s.tokens, now);
  const token = JSON.parse(signed.body).data.token;
  for (const route of ['/admin/users', '/admin/invites']) assert.equal((await s.call(route, token)).status, 403);
  const events = (await repo.events()).filter(e => ['invite.accepted', 'user.added'].includes(e.type));
  assert.deepEqual(events.map(e => e.type), ['invite.accepted', 'user.added']);
  assert.ok(!JSON.stringify(events).includes(invite.token)); assert.ok(!JSON.stringify(events).includes('@'));
  assert.deepEqual(await other.workspaceUsers(), before); assert.deepEqual(await other.crmList('invite'), otherInvites);
  assert.equal((await s.call(`/admin/invites/${invite.id}/reissue`, a.token, 'POST', {version: 2})).status, 409);
});
test('revoked, expired and unknown acceptance links refuse; existing members keep pending invites', async () => {
  const s = await setup(), a = await s.create(), [invite, expiring] = a.invites;
  const accept = (i: Invite) => s.call(`/invite/${i.token}/accept`, '', 'POST', {name: i.name, email: i.email});
  await s.call('/admin/users', a.token, 'POST', {name: 'Existing', email: invite.email, role: 'staff'});
  assert.equal((await accept(invite)).data.outcome, 'already-member');
  const repo = s.repositories.forTenant(invite.tenantId);
  assert.equal((await repo.crmGet('invite', invite.id))!.status, 'pending'); assert.equal((await repo.workspaceUsers()).length, 2);
  await s.call(`/admin/invites/${invite.id}/revoke`, a.token, 'POST', {version: 1});
  assert.equal((await accept(invite)).data.reason, 'revoked');
  assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: false, reason: 'revoked'});
  s.advance(new Date('2026-11-01T12:00:00Z'));
  assert.equal((await accept(expiring)).data.reason, 'expired');
  assert.equal((await s.call('/invite/bad/accept', '', 'POST', {name: 'Name', email: invite.email})).data.outcome, 'refused');
});
test('Dynamo acceptance conditions invite and membership guard in the same transaction as identity and both events', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, QueryCommand, TransactWriteCommand} = await import('@aws-sdk/lib-dynamodb');
  const s = await setup(), a = await s.create(), invite = a.invites[0];
  const rows = await s.repositories.forTenant(invite.tenantId).workspaceUsers();
  const commands: any[] = [];
  const client = {send: async (command: any) => {
    commands.push(command);
    if (command instanceof GetCommand) return command.input.Key?.SK === 'MEMBERSHIP_GUARD' ? {Item: {data: {version: 4}}} : {Item: {data: invite}};
    if (command instanceof QueryCommand) return {Items: rows.map(r => ({data: command.input.ExpressionAttributeValues?.[':prefix'] === 'USER#' ? r.user : r.membership}))};
    return {};
  }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant(invite.tenantId);
  const user = {id: 'new-user', name: 'New Name', email: invite.email};
  assert.equal(await repo.acceptInvite(invite, user, now), 'accepted');
  assert.equal(commands[0].input.Key.SK, 'MEMBERSHIP_GUARD');
  const items = (commands.at(-1) as InstanceType<typeof TransactWriteCommand>).input.TransactItems!;
  assert.equal(items.length, 6); assert.ok(items.every(i => i.Put?.Item?.PK === `TENANT#${invite.tenantId}`));
  assert.equal(items[0].Put?.ExpressionAttributeValues?.[':v'], 4);
  assert.equal(items[1].Put?.ExpressionAttributeValues?.[':v'], invite.version);
  assert.equal(items[1].Put?.ConditionExpression, '#d.#v = :v');
  assert.equal(items[1].Put?.Item?.data.status, 'accepted');
  assert.equal(items[3].Put?.Item?.data.role, 'staff');
  assert.deepEqual(items.slice(4).map(i => i.Put?.Item?.data.type), ['invite.accepted', 'user.added']);
  await assert.rejects(repo.acceptInvite({...invite, tenantId: 'other'}, user, now));
  invite.status = 'revoked'; await assert.rejects(repo.acceptInvite(invite, user, now));
});
