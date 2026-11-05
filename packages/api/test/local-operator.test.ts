import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERMS_VERSION, PRIVACY_VERSION } from '@freedms/shared';
import { LocalTokens } from '../src/auth.js';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, errorResponse } from '../src/handler.js';
import { localAuth } from '../src/local-auth.js';
import { localSession } from '../src/local-session.js';
import { localOperatorResolver } from '../src/local-operator.js';

const data = (result: {body: string}) => JSON.parse(result.body).data;
async function setup(enabled = true, operator = {userId: '', tenantId: ''}) {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('local-operator-test-secret-at-least-32-characters');
  const resolve = localOperatorResolver(repositories, tokens, operator, enabled);
  const handler = createHandler(repositories, {decode: async () => { throw Error('Offline'); }}, () => new Date(), undefined, undefined, undefined, undefined, {pilotOperator: operator});
  const signup = async (name: string) => {
    const result = await localSession(JSON.stringify({name, dealership: `${name} Motors`, acceptance: {termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION}}), repositories, tokens);
    assert.equal(result.statusCode, 201);
    return data(result).token as string;
  };
  const call = async (token: string, path: string, method = 'GET', body?: unknown) => {
    try {
      const credentials = localAuth(path, false, token, tokens);
      if ('claims' in credentials) await resolve(token);
      return await handler({path, method, body: body === undefined ? undefined : JSON.stringify(body), ...credentials});
    } catch (error) { return errorResponse(error); }
  };
  const dealer = await signup('Dealer'), admin = await signup('Operator');
  const tenantId = tokens.verify(dealer)['custom:tenant_id'];
  const repo = repositories.forTenant(tenantId);
  await repo.saveMember({id: 'staff', name: 'Staff', email: 'staff@example.test'}, {tenantId, userId: 'staff', role: 'staff', active: true, version: 1}, 0,
    {id: 'staff-added', tenantId, actorId: tokens.verify(dealer).sub, aggregateId: 'staff', aggregateVersion: 1, type: 'user.added', occurredAt: new Date().toISOString(), deliveryStatus: 'pending'});
  const staff = data(await localSession(JSON.stringify({tenantId, email: 'staff@example.test'}), repositories, tokens)).token as string;
  return {repositories, tokens, operator, resolve, signup, call, dealer, admin, staff, tenantId};
}

test('local J13: submit, operator queue, review, required decline reason, and submitter status', async () => {
  const s = await setup();
  const submitted = await s.call(s.staff, '/ideas', 'POST', {title: 'Faster stock lookup', description: 'Remember my inventory search.'});
  assert.equal(submitted.statusCode, 201, submitted.body);
  const idea = data(submitted), path = `/admin/ideas/${s.tenantId}/${idea.id}`;
  assert.equal(data(await s.call(s.admin, '/session')).canManagePilotRequests, true);
  const queue = await s.call(s.admin, '/admin/ideas');
  assert.equal(queue.statusCode, 200, queue.body);
  assert.equal(data(queue)[0].id, idea.id);
  assert.deepEqual(data(await s.call(s.admin, '/ideas')), []);
  const reviewed = await s.call(s.admin, path, 'PUT', {version: 1, status: 'Under review'});
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(data(reviewed).status, 'Under review');
  for (const declineReason of [undefined, ' ']) {
    assert.equal((await s.call(s.admin, path, 'PUT', {version: 2, status: 'Declined', declineReason})).statusCode, 400);
  }
  const declineReason = 'Outside the current product scope.';
  assert.equal((await s.call(s.admin, path, 'PUT', {version: 2, status: 'Declined', declineReason})).statusCode, 200);
  const own = data(await s.call(s.staff, '/ideas'));
  assert.equal(own.length, 1);
  assert.equal(own[0].status, 'Declined');
  assert.equal(own[0].declineReason, declineReason);
  assert.equal((await s.call(s.staff, '/admin/ideas')).statusCode, 403);
  assert.equal((await s.call(s.staff, path, 'PUT', {version: 3, status: 'Accepted'})).statusCode, 403);
  assert.equal(data(await s.call(s.staff, '/session')).canManagePilotRequests, false);
  assert.deepEqual(s.operator, {userId: '', tenantId: ''});
  const events = await s.repositories.forTenant(s.tenantId).events();
  assert.equal(events.filter(e => e.type === 'idea.status_changed').length, 2);
});

test('local operator follows admins across workspaces on every request', async () => {
  const s = await setup(), third = await s.signup('Third');
  for (const token of [s.admin, s.dealer, third, s.admin]) {
    assert.equal((await s.call(token, '/admin/ideas')).statusCode, 200);
    const claims = s.tokens.verify(token);
    assert.deepEqual(s.operator, {userId: claims.sub, tenantId: claims['custom:tenant_id']});
    assert.equal((await s.call(token, '/admin/access-requests')).statusCode, 200);
  }
});

test('local operator setting off preserves admin denial', async () => {
  const s = await setup(false);
  for (const token of [s.admin, s.dealer]) {
    assert.equal((await s.call(token, '/admin/ideas')).statusCode, 403);
    assert.equal((await s.call(token, '/admin/access-requests')).statusCode, 403);
  }
  assert.deepEqual(s.operator, {userId: '', tenantId: ''});
});

test('either static operator field prevents dynamic overrides', async () => {
  for (const config of [{userId: 'fixed', tenantId: ''}, {userId: '', tenantId: 'fixed'}, {userId: 'fixed', tenantId: 'fixed'}]) {
    const s = await setup(true, {...config});
    for (const token of [s.admin, s.dealer, s.staff]) {
      assert.equal((await s.call(token, '/admin/ideas')).statusCode, 403);
      assert.deepEqual(s.operator, config);
    }
  }
});

test('local operator requires a verified token and active membership in the claimed tenant', async () => {
  const s = await setup();
  for (const token of ['garbage', s.tokens.issue('missing', s.tenantId), s.tokens.issue(s.tokens.verify(s.admin).sub, s.tenantId)]) {
    await assert.rejects(s.resolve(token));
    assert.deepEqual(s.operator, {userId: '', tenantId: ''});
  }
  const claims = s.tokens.verify(s.dealer), repo = s.repositories.forTenant(s.tenantId);
  await repo.saveMember({id: 'staff', name: 'Staff', email: 'staff@example.test'}, {tenantId: s.tenantId, userId: 'staff', role: 'admin', active: true, version: 2}, 1,
    {id: 'promoted', tenantId: s.tenantId, actorId: claims.sub, aggregateId: 'staff', aggregateVersion: 2, type: 'user.role_changed', occurredAt: new Date().toISOString(), deliveryStatus: 'pending'});
  await repo.saveMember({id: claims.sub, name: 'Dealer'}, {tenantId: s.tenantId, userId: claims.sub, role: 'admin', active: false, version: 1}, 0,
    {id: 'deactivated', tenantId: s.tenantId, actorId: claims.sub, aggregateId: claims.sub, aggregateVersion: 1, type: 'user.deactivated', occurredAt: new Date().toISOString(), deliveryStatus: 'pending'});
  await assert.rejects(s.resolve(s.dealer), {status: 403});
  assert.deepEqual(s.operator, {userId: '', tenantId: ''});
});
