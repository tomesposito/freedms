import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { AuthClaims, OutboxEvent } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import { UnconfiguredStripeBilling, verifyStripeSignature, type StripeBilling, type StripeBillingEvent, type StripeSubscription } from '../src/stripe.js';

const now = new Date('2026-11-07T12:00:00Z'), signing = 'offline-signing-secret';
const owner = {tenantId: 'demo', userId: 'owner'}, admin = {...owner, userId: 'admin'}, staff = {...owner, userId: 'staff'};
const dealer = {tenantId: 'dealer', userId: 'dealer'}, wrongTenant = {...dealer, userId: 'owner'};
const sub = (tenant = 'demo'): StripeSubscription => ({id: `sub_${tenant}`, customerId: `cus_${tenant}`, tier: 'assistant', status: 'active',
  periodStart: now.toISOString(), periodEnd: '2026-12-07T12:00:00.000Z', quantity: 1, paid: true, invoiceId: `in_${tenant}`, cancelAtPeriodEnd: false});
async function setup({live = false, operator = owner, unavailable = false} = {}) {
  const repos = new MemoryRepositories(); let stripeCalls = 0, modelCalls = 0, delivery: StripeBillingEvent;
  const event = (tenantId: string, type: OutboxEvent['type'], aggregateId: string): OutboxEvent => ({id: randomUUID(), tenantId, actorId: tenantId === 'demo' ? 'owner' : 'dealer', type, aggregateId, aggregateVersion: 1, occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  for (const who of [owner, dealer]) await repos.forTenant(who.tenantId).provision({id: who.tenantId, name: who.tenantId, createdAt: now.toISOString()},
    {id: who.userId, name: who.userId, email: `${who.userId}@example.test`}, {...who, role: 'admin', active: true}, event(who.tenantId, 'tenant.created', who.tenantId));
  for (const who of [admin, staff, wrongTenant]) await repos.forTenant(who.tenantId).saveMember({id: who.userId, name: who.userId, email: `${who.userId}@example.test`},
    {...who, role: who === staff ? 'staff' : 'admin', active: true, version: 1}, 0, event(who.tenantId, 'user.added', who.userId));
  const stripe: StripeBilling = {
    configured: true, testMode: !live,
    createCustomer: async tenant => {stripeCalls++; return `cus_${tenant}`;},
    checkoutSubscription: async (_customer, _tier, seats) => {stripeCalls++; assert.equal(seats, 1); return {url: 'https://checkout.stripe.com/offline'};},
    checkoutTopUp: async () => {stripeCalls++; return {url: 'https://checkout.stripe.com/offline'};},
    portal: async () => {stripeCalls++; return {url: 'https://billing.stripe.com/offline'};},
    updateSubscription: async () => {stripeCalls++; return sub();},
    verifyEvent: async (raw, header) => {verifyStripeSignature(raw, header, signing, now); return delivery;},
  };
  const handle = createHandler(repos, {decode: async () => {throw Error('offline');}}, () => now, undefined, undefined, undefined, undefined,
    {hosted: true, pilotOperator: operator, appBaseUrl: 'https://app.example.test', stripe: unavailable ? new UnconfiguredStripeBilling() : stripe,
      assistantProvider: {configured: true, converse: async () => {modelCalls++; return {role: 'assistant', content: [{text: 'Paid answer'}]};}}});
  const call = async (who: typeof owner, method: string, path: string, body?: unknown) => {
    const claims: AuthClaims = {sub: who.userId, 'custom:tenant_id': who.tenantId, iss: 'offline', aud: 'offline', exp: 9999999999, token_use: 'id'};
    const r = await handle({method, path, claims, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const seed = async (who = owner) => {
    const repo = repos.forTenant(who.tenantId), subscription = sub(who.tenantId);
    if (!await repo.assistantBillingLink()) await repo.saveAssistantBillingLink({tenantId: who.tenantId, customerId: subscription.customerId, userIds: [who.userId], version: 1}, event(who.tenantId, 'assistant-billing.updated', 'assistant-billing'));
    await repo.saveAssistantPlan({id: 'assistant-plan', tenantId: who.tenantId, tier: 'assistant', status: 'active', cycleAnchor: subscription.periodStart,
      paidPeriodStart: subscription.periodStart, paidPeriodEnd: subscription.periodEnd, stripeCustomerId: subscription.customerId, stripeSubscriptionId: subscription.id,
      paidSeats: 3, licensedUserIds: [who.userId, 'admin', 'staff'], disabled: false, overageEnabled: false, overageCapCredits: 0, perRequestCreditCap: 25, version: 1},
    0, event(who.tenantId, 'assistant-plan.updated', 'assistant-plan'));
    await repo.saveAssistantCycle({id: subscription.periodStart, tenantId: who.tenantId, cycleStart: subscription.periodStart, cycleEnd: subscription.periodEnd,
      billedUserCount: 1, allotmentCredits: 75, topUpCredits: 0, version: 1}, 0);
  };
  const deliver = async (value: StripeBillingEvent) => {
    delivery = value; const raw = JSON.stringify({id: value.id}), t = Math.floor(now.getTime() / 1000);
    return handle({method: 'POST', path: '/assistant/billing/webhook', body: raw, stripeSignature: `t=${t},v1=${createHmac('sha256', signing).update(`${t}.${raw}`).digest('hex')}`});
  };
  return {repos, handle, call, seed, deliver, calls: () => ({stripeCalls, modelCalls})};
}
const chat = {messages: [{role: 'user', text: 'Hello'}]};
test('hosted sandbox offers checkout only to the exact operator, with only their own seat', async () => {
  const s = await setup(), view = (await s.call(owner, 'GET', '/assistant/admin')).data;
  assert.equal(view.billingConfigured, true); assert.equal(view.billingTestMode, true);
  assert.deepEqual(view.users.map((u: {userId: string}) => u.userId), ['owner']);
  for (const userIds of [['admin'], ['owner', 'staff'], [], 'owner']) {
    assert.equal((await s.call(owner, 'POST', '/assistant/admin/billing/checkout', {tier: 'assistant', userIds})).status, 403);
    assert.equal((await s.call(owner, 'POST', '/assistant/admin/billing/seats', {userIds})).status, 403);
  }
  assert.equal(s.calls().stripeCalls, 0);
  assert.equal((await s.call(owner, 'POST', '/assistant/admin/billing/checkout', {tier: 'assistant'})).status, 200);
  assert.deepEqual((await s.repos.forTenant('demo').assistantBillingLink())?.purchase?.userIds, ['owner']);
});
test('other admins get the waiting list even with legacy test plans, without revealing or changing them', async () => {
  const s = await setup(); await s.seed(); await s.seed(dealer);
  for (const who of [admin, dealer, wrongTenant]) {
    const repo = s.repos.forTenant(who.tenantId), before = await repo.assistantPlan();
    const view = (await s.call(who, 'GET', '/assistant/admin')).data;
    assert.equal(view.billingConfigured, false); assert.equal(view.billingTestMode, false);
    assert.equal(view.plan, null); assert.deepEqual(view.users, []); assert.equal(view.pool, undefined);
    const joined = await s.call(who, 'POST', '/assistant/admin/waitlist', {tier: 'assistant-pro'});
    assert.equal(joined.status, 200); assert.equal(joined.data.waitlist.tier, 'assistant-pro');
    assert.equal((await s.call(who, 'POST', '/assistant/admin/waitlist', {tier: 'constructor'})).status, 400);
    assert.equal((await s.call(who, 'DELETE', '/assistant/admin/waitlist')).data.waitlist, null);
    assert.deepEqual(await repo.assistantPlan(), before);
  }
});
test('all nonoperator billing and assistant routes reject direct calls before Stripe or model use', async () => {
  const s = await setup(); await s.seed(); await s.seed(dealer);
  for (const who of [admin, dealer, wrongTenant, staff]) for (const [method, path] of [
    ...['checkout', 'topup', 'portal', 'seats'].map(action => ['POST', `/assistant/admin/billing/${action}`]),
    ['PUT', '/assistant/admin/settings'], ['GET', '/assistant/pool'], ['GET', '/assistant/usage'], ['POST', '/assistant/chat'],
    ['GET', '/assistant/skills'], ['POST', '/assistant/skills/run'], ['POST', '/assistant/skills/apply'],
  ]) {
    const result = await s.call(who, method, path, chat);
    assert.equal(result.status, 403, `${who.userId}/${who.tenantId} ${path}`);
    assert.equal(result.error.code, 'ASSISTANT_SANDBOX_RESTRICTED');
  }
  assert.equal((await s.call(staff, 'POST', '/assistant/admin/waitlist', {tier: 'assistant'})).status, 403);
  assert.deepEqual(s.calls(), {stripeCalls: 0, modelCalls: 0});
});
test('operator billing, paid AI and signed topups work while other tenants receive no webhook credits', async () => {
  const s = await setup(); await s.seed(); await s.seed(dealer);
  for (const [action, body] of [['portal', {}], ['topup', {credits: 20}], ['seats', {userIds: ['owner']}]] as const)
    assert.equal((await s.call(owner, 'POST', `/assistant/admin/billing/${action}`, body)).status, 200);
  assert.equal((await s.call(owner, 'PUT', '/assistant/admin/settings', {perRequestCreditCap: 10})).status, 200);
  assert.equal((await s.call(owner, 'POST', '/assistant/chat', chat)).data.creditsUsed, 1);
  for (const who of [owner, dealer]) assert.equal((await s.deliver({id: `evt_${who.tenantId}`, customerId: `cus_${who.tenantId}`, payment: {id: `cs_${who.tenantId}`, credits: 20}})).statusCode, 200);
  assert.equal((await s.call(owner, 'GET', '/assistant/pool')).data.balanceCredits, 94);
  assert.equal((await s.repos.forTenant('dealer').assistantCycle(now.toISOString()))?.topUpCredits, 0);
});
test('sandbox webhooks filter old seat assignments and require an active operator membership', async () => {
  const s = await setup(); await s.seed();
  assert.equal((await s.deliver({id: 'evt_paid', customerId: 'cus_demo', subscription: {...sub(), quantity: 3}})).statusCode, 200);
  const repo = s.repos.forTenant('demo'), plan = await repo.assistantPlan();
  assert.deepEqual(plan?.licensedUserIds, ['owner']);
  const member = (await repo.membership('owner'))!;
  await repo.saveMember({id: 'owner', name: 'owner', email: 'owner@example.test'}, {...member, active: false, version: (member.version ?? 0) + 1}, member.version ?? 0,
    {id: randomUUID(), tenantId: 'demo', actorId: 'owner', type: 'user.deactivated', aggregateId: 'owner', aggregateVersion: (member.version ?? 0) + 1, occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  assert.equal((await s.deliver({id: 'evt_inactive', customerId: 'cus_demo', payment: {id: 'cs_inactive', credits: 20}})).statusCode, 200);
  assert.equal((await repo.assistantCycle(now.toISOString()))?.topUpCredits, 0);
  assert.equal((await s.call(owner, 'POST', '/assistant/chat', chat)).status, 403);
  assert.equal((await s.handle({method: 'POST', path: '/assistant/billing/webhook', body: '{}'})).statusCode, 400);
});
test('missing operator and failed secret loading cannot reopen legacy sandbox entitlements', async () => {
  for (const options of [{operator: {userId: '', tenantId: ''}}, {unavailable: true}]) {
    const s = await setup(options); await s.seed(dealer);
    assert.equal((await s.call(dealer, 'POST', '/assistant/chat', chat)).error.code, 'ASSISTANT_SANDBOX_RESTRICTED');
    assert.equal((await s.call(dealer, 'GET', '/assistant/admin')).data.billingConfigured, false);
    assert.deepEqual(s.calls(), {stripeCalls: 0, modelCalls: 0});
    if (!options.unavailable) {
      await s.deliver({id: 'evt_missing', customerId: 'cus_dealer', payment: {id: 'cs_missing', credits: 20}});
      assert.equal((await s.repos.forTenant('dealer').assistantCycle(now.toISOString()))?.topUpCredits, 0);
    }
  }
});
test('explicit live mode keeps normal dealership billing and assigned-user access', async () => {
  const s = await setup({live: true}); await s.seed(); await s.seed(dealer);
  assert.equal((await s.call(dealer, 'GET', '/assistant/admin')).data.billingConfigured, true);
  assert.equal((await s.call(dealer, 'GET', '/assistant/admin')).data.billingTestMode, false);
  assert.equal((await s.call(dealer, 'POST', '/assistant/admin/billing/portal', {})).status, 200);
  assert.equal((await s.call(staff, 'POST', '/assistant/chat', chat)).status, 200);
  assert.equal((await s.call(staff, 'POST', '/assistant/admin/billing/portal', {})).status, 403);
  await s.deliver({id: 'evt_live', customerId: 'cus_dealer', payment: {id: 'cs_live', credits: 20}});
  assert.equal((await s.repos.forTenant('dealer').assistantCycle(now.toISOString()))?.topUpCredits, 20);
});
