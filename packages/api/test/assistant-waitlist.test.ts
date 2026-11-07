import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AuthClaims, OutboxEvent } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import type { StripeBilling } from '../src/stripe.js';
import type { AssistantProvider } from '../src/assistant-provider.js';

const date = new Date('2026-11-07T12:00:00Z');
async function setup(options: Record<string, unknown> = {}) {
  const repositories = new MemoryRepositories();
  const event = (tenantId: string): OutboxEvent => ({id: randomUUID(), tenantId, actorId: `user-${tenantId}`, type: 'tenant.created', aggregateId: tenantId, aggregateVersion: 1, occurredAt: date.toISOString(), deliveryStatus: 'pending'});
  await repositories.forTenant('A').provision({id: 'A', name: 'Alpha Motors', createdAt: date.toISOString()},
    {id: 'user-A', name: 'Ann Admin', email: 'ann@alpha.example'}, {tenantId: 'A', userId: 'user-A', role: 'admin', active: true}, event('A'));
  await repositories.forTenant('A').saveMember({id: 'staff-A', name: 'Sam Staff', email: 'sam@alpha.example'},
    {tenantId: 'A', userId: 'staff-A', role: 'staff', active: true, version: 1}, 0,
    {id: randomUUID(), tenantId: 'A', actorId: 'user-A', type: 'user.added', aggregateId: 'staff-A', aggregateVersion: 1, occurredAt: date.toISOString(), deliveryStatus: 'pending'});
  await repositories.forTenant('operator').provision({id: 'operator', name: 'Operator', createdAt: date.toISOString()},
    {id: 'op-1', name: 'Operator', email: 'op@example.test'}, {tenantId: 'operator', userId: 'op-1', role: 'admin', active: true}, event('operator'));
  const handle = createHandler(repositories, {decode: async () => {throw Error('offline');}}, () => date, undefined, undefined, undefined, undefined,
    {pilotOperator: {userId: 'op-1', tenantId: 'operator'}, ...options});
  const auth = (tenant: string, user: string): AuthClaims => ({sub: user, 'custom:tenant_id': tenant, iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id'});
  const call = async (method: string, path: string, tenant: string, user: string, body?: unknown) => {
    const result = await handle({method, path, claims: auth(tenant, user), body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  return {repositories, call};
}

test('waiting list routes: admin joins and leaves, staff is refused, bad tier is a 400', async () => {
  const s = await setup();
  const joined = await s.call('POST', '/assistant/admin/waitlist', 'A', 'user-A', {tier: 'assistant-pro'});
  assert.equal(joined.status, 200);
  assert.equal(joined.data.plan, null);
  assert.equal(joined.data.waitlist.tier, 'assistant-pro');
  assert.equal(joined.data.waitlist.requestedByName, 'Ann Admin');
  assert.equal(joined.data.billingConfigured, false);
  const admin = await s.call('GET', '/assistant/admin', 'A', 'user-A');
  assert.equal(admin.data.waitlist.tier, 'assistant-pro');
  assert.equal((await s.call('POST', '/assistant/admin/waitlist', 'A', 'staff-A', {tier: 'assistant'})).status, 403);
  assert.equal((await s.call('POST', '/assistant/admin/waitlist', 'A', 'user-A', {tier: 'deluxe'})).status, 400);
  const left = await s.call('DELETE', '/assistant/admin/waitlist', 'A', 'user-A');
  assert.equal(left.status, 200);
  assert.equal(left.data.waitlist, null);
});

test('operator waiting list spans tenants with names; tenant admins cannot read it', async () => {
  const s = await setup();
  await s.call('POST', '/assistant/admin/waitlist', 'A', 'user-A', {tier: 'assistant-heavy'});
  assert.equal((await s.call('GET', '/admin/assistant-waitlist', 'A', 'user-A')).status, 403);
  const queue = await s.call('GET', '/admin/assistant-waitlist', 'operator', 'op-1');
  assert.equal(queue.status, 200);
  assert.equal(queue.data.length, 1);
  assert.equal(queue.data[0].tenantName, 'Alpha Motors');
  assert.equal(queue.data[0].tier, 'assistant-heavy');
  assert.equal(queue.data[0].requestedByEmail, 'ann@alpha.example');
});

test('joining is refused once billing is configured', async () => {
  const stripe = {configured: true, testMode: true} as unknown as StripeBilling;
  const assistantProvider = {configured: true} as unknown as AssistantProvider;
  const s = await setup({stripe, assistantProvider});
  const refused = await s.call('POST', '/assistant/admin/waitlist', 'A', 'user-A', {tier: 'assistant'});
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, 'ASSISTANT_WAITLIST_UNAVAILABLE');
});
