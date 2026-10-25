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
    assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: true, dealership: 'Test Motors', role: invite.role});
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
    const result = await s.call(`/invite/${token}`); assert.equal(result.status, 200); assert.deepEqual(result.data, {valid: false});
  }
  assert.deepEqual(localAuth('/invite/token', false, '', {verify: () => { throw Error('Must not verify'); }}), {});
  assert.throws(() => localAuth('/admin/invites', false, '', s.tokens));
});
