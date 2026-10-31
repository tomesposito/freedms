import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthClaims, Role } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import { canManageAccessRequests, type PilotOperator } from '../src/access-requests.js';

const operator = {tenantId: 'demo', userId: 'owner'};
const date = new Date('2026-10-31T22:00:00Z');
const fields = {contactName: 'Dealer', dealershipName: 'Test Motors', email: 'dealer@example.test', message: 'Please contact me'};
async function setup(config: PilotOperator | undefined = operator, role: Role = 'admin', active = true) {
  const repositories = new MemoryRepositories();
  for (const [tenantId, userId] of [['demo', 'owner'], ['other', 'owner'], ['third', 'other-admin']]) {
    await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: date.toISOString()}, {id: userId, name: 'Admin'},
      {tenantId, userId, role, active}, {id: 'bootstrap', tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: date.toISOString(), deliveryStatus: 'pending'});
  }
  const handler = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => date, undefined, undefined, undefined, undefined, {hosted: true, pilotOperator: config});
  const claims = (tenantId = 'demo', userId = 'owner'): AuthClaims => ({sub: userId, 'custom:tenant_id': tenantId, iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id'});
  const call = (path = '/admin/access-requests', method = 'GET', body?: unknown, identity = claims(), query?: Record<string, string>) => handler({path, method, claims: identity, query, body: body === undefined ? undefined : JSON.stringify(body)});
  const submit = (body = fields) => handler({path: '/access-requests', method: 'POST', body: JSON.stringify(body)});
  await submit();
  return {handler, call, claims, submit, repositories};
}

test('pilot inbox grants only the configured active operator admin and reports the same session capability', async () => {
  const s = await setup();
  assert.equal((await s.call()).statusCode, 200);
  assert.equal(JSON.parse((await s.call('/session')).body).data.canManagePilotRequests, true);
  for (const claims of [s.claims('other'), s.claims('third', 'other-admin')]) {
    for (const [path, method] of [['/admin/access-requests', 'GET'], ['/admin/access-requests/handled', 'POST']]) {
      assert.equal((await s.call(path, method, {email: fields.email, version: 1}, claims)).statusCode, 403);
    }
    assert.equal(JSON.parse((await s.call('/session', 'GET', undefined, claims)).body).data.canManagePilotRequests, false);
  }
  assert.equal((await s.handler({path: '/admin/access-requests', method: 'GET'})).statusCode, 401);
  assert.equal((await s.handler({path: '/admin/access-requests/handled', method: 'POST', body: '{}'})).statusCode, 401);
  for (const [config, role, active] of [[{}, 'admin', true], [operator, 'staff', true], [operator, 'admin', false]] as const) {
    const denied = await setup(config as PilotOperator, role, active);
    assert.equal((await denied.call()).statusCode, 403);
  }
  assert.equal(canManageAccessRequests({...operator, role: 'admin'}), false);
});

test('operator can review both queues and handle a request without provisioning or cross-tenant writes', async () => {
  const s = await setup();
  const pending = JSON.parse((await s.call()).body).data;
  assert.equal(pending.length, 1); assert.equal(pending[0].message, fields.message);
  const handled = await s.call('/admin/access-requests/handled', 'POST', {email: fields.email, version: pending[0].version});
  assert.equal(handled.statusCode, 200); assert.equal(JSON.parse(handled.body).data.status, 'handled');
  assert.deepEqual(JSON.parse((await s.call()).body).data, []);
  assert.equal(JSON.parse((await s.call('/admin/access-requests', 'GET', undefined, undefined, {status: 'handled'})).body).data.length, 1);
  const global = s.repositories.forTenant('operator');
  assert.equal(await global.tenant(), undefined); assert.deepEqual(await global.users(), []); assert.deepEqual(await global.events(), []);
  assert.deepEqual(await s.repositories.forTenant('demo').accessRequests(), []);
});

test('stale handling cannot overwrite a newer submission or silently handle twice', async () => {
  const s = await setup();
  await s.submit({...fields, message: 'New information'});
  assert.equal((await s.call('/admin/access-requests/handled', 'POST', {email: fields.email, version: 1})).statusCode, 409);
  const saved = await s.repositories.forTenant('operator').accessRequest(fields.email);
  assert.equal(saved?.message, 'New information'); assert.equal(saved?.status, 'pending');
  assert.equal((await s.call('/admin/access-requests/handled', 'POST', {email: fields.email, version: 2})).statusCode, 200);
  assert.equal((await s.call('/admin/access-requests/handled', 'POST', {email: fields.email, version: 2})).statusCode, 409);
});

test('inbox rejects scope injection, invalid status, missing versions, extra fields and unsupported routes', async () => {
  const s = await setup();
  for (const query of [{tenantId: 'other'}, {status: 'all'}] as Record<string, string>[]) assert.equal((await s.call('/admin/access-requests', 'GET', undefined, undefined, query)).statusCode, 400);
  for (const body of [{email: fields.email}, {email: fields.email, version: -1}, {email: 'invalid', version: 1}, {email: fields.email, version: 1, tenantId: 'other'}]) {
    assert.equal((await s.call('/admin/access-requests/handled', 'POST', body)).statusCode, 400);
  }
  assert.equal((await s.call('/admin/access-requests', 'POST', {})).statusCode, 405);
  assert.equal((await s.call('/admin/access-requests/handled')).statusCode, 405);
  assert.equal((await s.call('/admin/access-requests/unknown')).statusCode, 404);
});
