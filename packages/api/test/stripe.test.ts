import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { AuthClaims, OutboxEvent } from '@freedms/shared';
import { createHandler } from '../src/handler.js';
import { gatewayHandler } from '../src/gateway.js';
import { MemoryRepositories } from '../src/memory.js';
import { AssistantBilling } from '../src/assistant-billing.js';
import { billingReturnUrl } from '../src/assistant-stripe.js';
import { HttpStripeBilling, UnconfiguredStripeBilling, stripeBillingFromEnv, verifyStripeSignature,
  type StripeBilling, type StripeBillingEvent, type StripeSubscription, type AssistantTier } from '../src/stripe.js';
const time = new Date('2026-01-01T12:00:00Z'), secret = 'offline-signing-secret';
function signature(raw: string, date = time) { const t = Math.floor(date.getTime() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`; }
class FakeStripe implements StripeBilling {
  configured = true;
  calls: unknown[][] = [];
  script: StripeBillingEvent[] = [];
  async createCustomer(tenant: string) { this.calls.push(['customer', tenant]); return `cus_${tenant}`; }
  async checkoutSubscription(customer: string, tier: AssistantTier, seats: number, url: string) { this.calls.push(['checkout', customer, tier, seats, url]); return {url: 'https://checkout.stripe.com/offline'}; }
  async checkoutTopUp(customer: string, credits: number, url: string) { this.calls.push(['topup', customer, credits, url]); return {url: 'https://checkout.stripe.com/offline'}; }
  async portal(customer: string, url: string) { this.calls.push(['portal', customer, url]); return {url: 'https://billing.stripe.com/offline'}; }
  async verifyEvent(raw: string, header?: string) { verifyStripeSignature(raw, header, secret, time); const event = this.script.shift(); assert.ok(event); return event; }
}
const subscription = (patch: Partial<StripeSubscription> = {}): StripeSubscription => ({id: 'sub_A', customerId: 'cus_A', tier: 'assistant-pro', status: 'active', periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', cancelAtPeriodEnd: false, paid: true, quantity: 2, invoiceId: 'in_A', ...patch});
async function setup(stripe: StripeBilling = new FakeStripe()) {
  const repos = new MemoryRepositories(); let date = time;
  const event = (tenant: string, type: OutboxEvent['type'], aggregateId: string): OutboxEvent => ({id: randomUUID(), tenantId: tenant, actorId: `user-${tenant}`, type, aggregateId, aggregateVersion: 1, occurredAt: time.toISOString(), deliveryStatus: 'pending'});
  for (const tenant of ['A', 'B']) await repos.forTenant(tenant).provision({id: tenant, name: tenant, createdAt: time.toISOString()}, {id: `user-${tenant}`, name: tenant},
    {tenantId: tenant, userId: `user-${tenant}`, active: true, role: 'admin'}, event(tenant, 'tenant.created', tenant));
  await repos.forTenant('A').saveMember({id: 'staff', name: 'Staff', email: 'staff@example.test'}, {tenantId: 'A', userId: 'staff', role: 'staff', active: true, version: 1}, 0, event('A', 'user.added', 'staff'));
  const handle = createHandler(repos, {decode: async () => {throw Error('offline');}}, () => date, undefined, undefined, undefined, undefined,
    {stripe, assistantProvider: {configured: true, converse: async () => ({role: 'assistant', content: [{text: 'Paid answer'}]})}});
  const auth = (tenant = 'A', user = `user-${tenant}`): AuthClaims => ({sub: user, 'custom:tenant_id': tenant, iss: 'offline', aud: 'offline', exp: 9999999999, token_use: 'id'});
  const call = async (path: string, body?: unknown, tenant = 'A', user?: string) => {
    const r = await handle({path, method: body === undefined ? 'GET' : 'POST', claims: auth(tenant, user), body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const deliver = async (event: StripeBillingEvent) => {
    (stripe as FakeStripe).script.push(event);
    const raw = JSON.stringify({id: event.id});
    return handle({path: '/assistant/billing/webhook', method: 'POST', body: raw, stripeSignature: signature(raw)});
  };
  const activate = async () => {
    assert.equal((await call('/assistant/admin/billing/checkout', {tier: 'assistant-pro', userIds: ['user-A', 'staff']})).status, 200);
    assert.equal((await deliver({id: 'evt_activate', customerId: 'cus_A', subscription: subscription()})).statusCode, 200);
  };
  return {repos, handle, stripe, call, deliver, activate, auth, setDate: (value: string) => {date = new Date(value);}};
}
test('Stripe subscribe is paid, idempotent and tenant bound; admin actions enforce roles and quantities', async () => {
  const s = await setup(), fake = s.stripe as FakeStripe;
  for (const action of ['checkout', 'topup', 'portal']) assert.equal((await s.call(`/assistant/admin/billing/${action}`, {}, 'A', 'staff')).status, 403);
  assert.equal(fake.calls.length, 0);
  for (const tier of ['bad', '__proto__', null]) assert.equal((await s.call('/assistant/admin/billing/checkout', {tier})).status, 400);
  assert.equal((await s.call('/assistant/admin/billing/portal', {})).status, 409);
  await s.activate();
  assert.deepEqual(fake.calls[1], ['checkout', 'cus_A', 'assistant-pro', 2, 'http://127.0.0.1:5173/#/account/assistant']);
  const repo = s.repos.forTenant('A'), before = await repo.assistantPlan();
  assert.equal((await s.deliver({id: 'evt_activate', customerId: 'cus_A', subscription: subscription()})).statusCode, 200);
  assert.deepEqual(await repo.assistantPlan(), before);
  assert.equal((await repo.events()).filter(e => e.type === 'assistant-plan.updated').length, 1);
  assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hello'}]})).status, 200);
  assert.equal(await s.repos.forTenant('B').assistantPlan(), undefined);
  assert.equal((await s.call('/assistant/admin', undefined, 'B')).data.plan, null);
  assert.equal((await s.call('/assistant/admin/billing/portal', {})).status, 200);
  assert.equal((await s.call('/assistant/admin/billing/portal', {}, 'B')).status, 409);
  assert.equal((await s.call('/assistant/admin/billing/checkout', {tier: 'assistant'})).status, 409);
  for (const credits of [0, -1, 1.5, 100001, '10']) assert.equal((await s.call('/assistant/admin/billing/topup', {credits})).status, 400);
  assert.equal((await s.call('/assistant/admin/billing/topup', {credits: 50})).status, 200);
  assert.equal((await s.call('/assistant/admin')).data.billingConfigured, true);
});
test('Stripe top-up credits current cycle once across concurrent delivery and distinct event IDs', async () => {
  const s = await setup(); await s.activate(); s.setDate('2026-02-05T00:00:00Z');
  await s.deliver({id: 'evt_renewal', customerId: 'cus_A', subscription: subscription({periodStart: '2026-02-01T00:00:00.000Z', periodEnd: '2026-03-01T00:00:00.000Z', invoiceId: 'in_B'})});
  const event = {id: 'evt_topup', customerId: 'cus_A', payment: {id: 'cs_topup', credits: 40}};
  assert.equal((await s.deliver(event)).statusCode, 200);
  await Promise.all([s.deliver(event), s.deliver({...event, id: 'evt_async'})]);
  const pool = (await s.call('/assistant/pool')).data;
  assert.equal(pool.cycleStart, '2026-02-01T00:00:00.000Z'); assert.equal(pool.topUpCredits, 40); assert.equal(pool.balanceCredits, 390);
  assert.equal(await s.repos.forTenant('B').assistantCycle('2026-02-01'), undefined);
  assert.equal(await s.repos.forTenant('A').stripeEventProcessed('evt_topup'), true);
});
test('Stripe past due pauses chat, paid restores it, cancellation ends at the paid boundary', async () => {
  const s = await setup(); await s.activate();
  await s.deliver({id: 'evt_due', customerId: 'cus_A', subscription: subscription({status: 'past_due', paid: false})});
  const chat = () => s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hello'}]});
  assert.equal((await chat()).error.code, 'ASSISTANT_PAST_DUE');
  assert.equal((await s.call('/assistant/pool')).data.status, 'past_due');
  assert.equal((await s.call('/assistant/admin')).data.plan.status, 'past_due');
  const billing = new AssistantBilling(s.repos.forTenant('A'), () => time);
  assert.equal((await billing.status({tenantId: 'A', userId: 'user-A', role: 'admin'})).status, 'past-due');
  await s.deliver({id: 'evt_paid', customerId: 'cus_A', subscription: subscription()}); assert.equal((await chat()).status, 200);
  await s.deliver({id: 'evt_cancel', customerId: 'cus_A', subscription: subscription({status: 'canceled', cancelAtPeriodEnd: true})});
  assert.equal((await s.call('/assistant/admin')).data.plan.accessUntil, '2026-02-01T00:00:00.000Z');
  assert.equal((await chat()).status, 200);
  s.setDate('2026-02-01T00:00:00Z'); assert.equal((await chat()).error.code, 'ASSISTANT_PLAN_REQUIRED');
  assert.equal((await s.call('/assistant/pool')).data.status, 'cancelled');
});
test('Stripe already-ended subscription stops immediately; unpaid and unknown customers never provision a plan', async () => {
  const s = await setup();
  await s.call('/assistant/admin/billing/checkout', {tier: 'assistant-pro', userIds: ['user-A', 'staff']});
  for (const sub of [subscription({paid: false}), subscription({status: 'trialing'})]) await s.deliver({id: randomUUID(), customerId: 'cus_A', subscription: sub});
  assert.equal(await s.repos.forTenant('A').assistantPlan(), undefined);
  await s.deliver({id: 'evt_unknown', customerId: 'cus_unknown', subscription: subscription()});
  await s.deliver({id: 'evt_mismatch', customerId: 'cus_A', subscription: subscription({customerId: 'cus_B'})});
  assert.equal(await s.repos.forTenant('A').assistantPlan(), undefined);
  await s.activate();
  await s.deliver({id: 'evt_ended', customerId: 'cus_A', subscription: subscription({status: 'canceled', endedAt: '2026-01-01T11:00:00Z'})});
  assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hi'}]})).error.code, 'ASSISTANT_PLAN_REQUIRED');
});
test('Stripe signature rejects missing, bad, stale and modified raw bodies without writes', async () => {
  const s = await setup(), raw = '{ "id": "evt_test" }';
  for (const header of [undefined, 'bad', signature(raw, new Date('2025-12-31')), signature(raw + ' ')]) {
    const r = await s.handle({path: '/assistant/billing/webhook', method: 'POST', body: raw, stripeSignature: header}); assert.equal(r.statusCode, 400);
  }
  assert.equal(await s.repos.forTenant('A').assistantPlan(), undefined);
  assert.equal((await s.repos.forTenant('A').events()).filter(e => e.type.startsWith('assistant')).length, 0);
  assert.throws(() => verifyStripeSignature(raw, signature(raw), '', time), {status: 503});
  verifyStripeSignature(raw, signature(raw), secret, time);
});
test('Stripe unconfigured state refuses actions and webhook, creates nothing, and keeps existing settings', async () => {
  const s = await setup(new UnconfiguredStripeBilling());
  for (const action of ['checkout', 'topup', 'portal']) assert.equal((await s.call(`/assistant/admin/billing/${action}`, {})).status, 503);
  assert.equal((await s.handle({path: '/assistant/billing/webhook', method: 'POST', body: '{}'})).statusCode, 503);
  assert.equal((await s.call('/assistant/admin')).data.billingConfigured, false);
  assert.equal(await s.repos.forTenant('A').assistantBillingLink(), undefined);
  assert.equal(stripeBillingFromEnv({}).configured, false);
  assert.equal(stripeBillingFromEnv({FREEDMS_STRIPE_SECRET_KEY: 'offline'}).configured, false);
});
test('Stripe return URLs use configured app URL or allowlisted local origins', () => {
  assert.equal(billingReturnUrl('https://app.example.test', 'https://evil.test', true), 'https://app.example.test/#/account/assistant');
  assert.equal(billingReturnUrl(undefined, 'http://localhost:5173', false), 'http://localhost:5173/#/account/assistant');
  assert.equal(billingReturnUrl(undefined, 'https://evil.test', false), 'http://127.0.0.1:5173/#/account/assistant');
  assert.throws(() => billingReturnUrl(undefined, undefined, true));
});
test('gateway admits signature-authenticated webhook and preserves base64 raw bytes', async () => {
  const raw = '{ "id": "evt_test" }', sig = signature(raw);
  const gateway = gatewayHandler(async request => {
    assert.equal(request.body, raw); assert.equal(request.stripeSignature, sig); assert.equal(request.claims, undefined);
    return {statusCode: 200, headers: {}, body: '{}'};
  }, 'issuer', 'audience');
  assert.equal((await gateway({rawPath: '/assistant/billing/webhook', body: Buffer.from(raw).toString('base64'), isBase64Encoded: true,
    headers: {'Stripe-Signature': sig}, requestContext: {http: {method: 'POST'}}})).statusCode, 200);
});
test('HTTP Stripe seam uses configured prices, quantities and signed paid payment normalization offline', async () => {
  const prices = {assistant: 'configured-basic', 'assistant-pro': 'configured-pro', 'assistant-heavy': 'configured-heavy', topup: 'configured-topup'};
  const requests: {url: string; fields: URLSearchParams; headers: Headers}[] = [];
  const responses: unknown[] = [{id: 'cus_A'}, {data: []}, {url: 'https://checkout.stripe.com/test'}, {url: 'https://checkout.stripe.com/test'}, {url: 'https://billing.stripe.com/test'},
    {id: 'cs_paid', customer: 'cus_A', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 1100, amount_subtotal: 1000, metadata: {credits: '40'}, line_items: {data: [{price: {id: prices.topup}, quantity: 40}]}}];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({url: String(url), fields: new URLSearchParams(init?.body as URLSearchParams), headers: new Headers(init?.headers)});
    assert.ok(responses.length); return new Response(JSON.stringify(responses.shift()), {status: 200});
  }) as typeof fetch;
  const stripe = new HttpStripeBilling('offline-key', secret, prices, fetcher, () => time);
  await stripe.createCustomer('A'); await stripe.checkoutSubscription('cus_A', 'assistant-heavy', 3, 'https://app.test/#/account/assistant');
  await stripe.checkoutTopUp('cus_A', 40, 'https://app.test/#/account/assistant'); await stripe.portal('cus_A', 'https://app.test/#/account/assistant');
  assert.equal(requests[0].headers.get('idempotency-key'), 'freedms-customer-A');
  assert.equal(requests[2].fields.get('line_items[0][price]'), prices['assistant-heavy']); assert.equal(requests[2].fields.get('line_items[0][quantity]'), '3');
  assert.equal(requests[3].fields.get('line_items[0][price]'), prices.topup); assert.equal(requests[3].fields.get('metadata[credits]'), '40');
  const raw = JSON.stringify({id: 'evt_paid', type: 'checkout.session.completed', data: {object: {id: 'cs_paid'}}});
  assert.deepEqual(await stripe.verifyEvent(raw, signature(raw)), {id: 'evt_paid', customerId: 'cus_A', payment: {id: 'cs_paid', credits: 40}});
  const unknown = JSON.stringify({id: 'evt_unknown', type: 'something.else', data: {object: {}}});
  assert.deepEqual(await stripe.verifyEvent(unknown, signature(unknown)), {id: 'evt_unknown'}); assert.equal(requests.length, 6);
});
test('Stripe receipt, plan, cycle and outbox are atomic in both repositories with scope guards', async () => {
  const s = await setup(); await s.activate(); await s.call('/assistant/pool');
  const repo = s.repos.forTenant('A'), old = (await repo.assistantPlan())!, cycle = (await repo.assistantCycle('2026-01-01T00:00:00.000Z'))!;
  const plan = {...old, version: old.version + 1};
  const event: OutboxEvent = {id: 'outbox-payment', tenantId: 'A', actorId: 'stripe', type: 'assistant-plan.updated', aggregateId: plan.id, aggregateVersion: plan.version, occurredAt: time.toISOString(), deliveryStatus: 'pending'};
  const commit = {eventId: 'evt_atomic', paymentId: 'cs_atomic', plan, cycle: {...cycle, topUpCredits: 5, version: cycle.version + 1}, event};
  const results = await Promise.allSettled([repo.commitStripeEvent(commit), repo.commitStripeEvent({...commit, event: {...event, id: 'other'}})]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await repo.assistantCycle(cycle.id))!.topUpCredits, 5);
  await assert.rejects(repo.commitStripeEvent({...commit, eventId: 'evt_stale', paymentId: 'cs_stale', event: {...event, id: 'stale'}}));
  assert.equal(await repo.stripeEventProcessed('evt_stale'), false);
  await assert.rejects(s.repos.forTenant('B').commitStripeEvent(commit), /scope/);
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, TransactWriteCommand} = await import('@aws-sdk/lib-dynamodb');
  const commands: any[] = [];
  const client = {send: async (command: unknown) => {commands.push(command); return {};}} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('offline', client), d = dynamo.forTenant('A');
  await d.commitStripeEvent(commit);
  const transaction = commands[0]; assert.ok(transaction instanceof TransactWriteCommand);
  const writes = transaction.input.TransactItems!; assert.equal(writes.length, 5);
  for (const write of writes) {assert.equal(write.Put!.Item!.PK, 'TENANT#A'); assert.ok(write.Put!.ConditionExpression);}
  assert.equal(writes[2].Put!.ExpressionAttributeValues![':v'], old.version);
  assert.equal(writes[3].Put!.ExpressionAttributeValues![':v'], cycle.version);
  await d.stripeEventProcessed('evt_atomic'); await dynamo.tenantForStripeCustomer('cus_A');
  for (const command of commands.slice(1)) {assert.ok(command instanceof GetCommand); assert.equal(command.input.ConsistentRead, true);}
  await assert.rejects(dynamo.forTenant('B').commitStripeEvent(commit), /scope/);
  assert.equal(commands.length, 3);
});
test('HTTP Stripe subscription reads current paid state and item periods; unpaid topups never credit', async () => {
  const prices = {assistant: 'configured-basic', 'assistant-pro': 'configured-pro', 'assistant-heavy': 'configured-heavy', topup: 'configured-topup'};
  const sub = {id: 'sub_A', customer: 'cus_A', status: 'past_due', cancel_at_period_end: false,
    latest_invoice: {status: 'open', amount_paid: 0}, items: {data: [{price: {id: prices.assistant}, current_period_start: 1767225600, current_period_end: 1769904000}]}};
  let next: unknown = sub, count = 0;
  const stripe = new HttpStripeBilling('offline', secret, prices, (async () => {count++; return new Response(JSON.stringify(next));}) as typeof fetch, () => time);
  const raw = JSON.stringify({id: 'evt_sub', type: 'customer.subscription.updated', data: {object: {id: 'sub_A', status: 'active'}}});
  const normalized = await stripe.verifyEvent(raw, signature(raw));
  assert.equal(normalized.subscription?.status, 'past_due'); assert.equal(normalized.subscription?.paid, false);
  assert.equal(normalized.subscription?.periodStart, '2026-01-01T00:00:00.000Z');
  assert.equal(normalized.subscription?.periodEnd, '2026-02-01T00:00:00.000Z');
  const checkout = JSON.stringify({id: 'evt_checkout', type: 'checkout.session.completed', data: {object: {id: 'cs_unpaid'}}});
  next = {id: 'cs_unpaid', customer: 'cus_A', mode: 'payment', payment_status: 'unpaid', metadata: {credits: '100'}};
  assert.equal((await stripe.verifyEvent(checkout, signature(checkout))).payment, undefined);
  next = {id: 'cs_badprice', customer: 'cus_A', mode: 'payment', payment_status: 'paid', amount_total: 2500, currency: 'usd', metadata: {credits: '100'},
    line_items: {data: [{price: {id: 'unrecognized'}, quantity: 100}]}};
  assert.equal((await stripe.verifyEvent(checkout, signature(checkout))).payment, undefined);
  assert.equal(count, 3);
  const missingSecret = new HttpStripeBilling('offline', '', prices, (async () => {assert.fail('No fetch before signature authentication');}) as typeof fetch);
  await assert.rejects(missingSecret.verifyEvent(raw, signature(raw)), {status: 503});
});

test('only assigned AI users consume paid seats; ordinary members never grant credits', async () => {
  const s = await setup();
  assert.equal((await s.call('/assistant/admin/billing/checkout', {tier: 'assistant'})).status, 200);
  assert.equal((s.stripe as FakeStripe).calls[1][3], 1);
  await s.deliver({id: 'evt_one_seat', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 1})});
  assert.equal((await s.call('/assistant/pool')).data.allotmentCredits, 75);
  assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hi'}]}, 'A', 'staff')).error.code, 'ASSISTANT_UNASSIGNED');
  assert.equal((await s.call('/assistant/admin/settings', {overageEnabled: true})).status, 404); // Settings are PUT-only.
  const billing = new AssistantBilling(s.repos.forTenant('A'), () => time);
  await assert.rejects(billing.updateSettings({tenantId: 'A', userId: 'user-A', role: 'admin'}, {overageEnabled: true}), /Overage billing is unavailable/);
  assert.equal((await s.call('/assistant/admin/billing/topup', {credits: 1})).status, 400);
  assert.equal((await s.call('/assistant/admin/billing/checkout', {tier: 'assistant', userIds: ['user-B']})).status, 409);
});

test('concurrent checkout retries share one persisted purchase; another selection is rejected', async () => {
  const s = await setup(); const attempts: string[] = [];
  (s.stripe as FakeStripe).checkoutSubscription = async (_customer, _tier, _seats, _url, purchase?: {id: string; expiresAt: number}) => {
    attempts.push(purchase!.id); return {url: 'https://checkout.stripe.com/offline'};
  };
  const result = await Promise.all([s.call('/assistant/admin/billing/checkout', {tier: 'assistant'}), s.call('/assistant/admin/billing/checkout', {tier: 'assistant'})]);
  assert.ok(result.every(row => row.status === 200)); assert.equal(new Set(attempts).size, 1);
  assert.equal((await s.call('/assistant/admin/billing/checkout', {tier: 'assistant-heavy'})).status, 409);
});

test('credits wait for the exact paid renewal and purchased credits carry forward once', async () => {
  const s = await setup();
  await s.call('/assistant/admin/billing/checkout', {tier: 'assistant', userIds: ['user-A']});
  const sub = subscription({tier: 'assistant', quantity: 1, periodStart: '2026-01-01T12:00:00.000Z', periodEnd: '2026-02-01T12:00:00.000Z'});
  await s.deliver({id: 'evt_start_exact', customerId: 'cus_A', subscription: sub});
  await s.deliver({id: 'evt_topup_exact', customerId: 'cus_A', payment: {id: 'cs_exact', credits: 20}});
  s.setDate('2026-02-01T11:59:59Z');
  assert.equal((await s.call('/assistant/pool')).data.balanceCredits, 95);
  s.setDate('2026-02-01T12:00:00Z');
  assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hi'}]})).error.code, 'ASSISTANT_PAST_DUE');
  assert.equal(await s.repos.forTenant('A').assistantCycle('2026-02-01T12:00:00.000Z'), undefined);
  const renewal = {...sub, periodStart: sub.periodEnd, periodEnd: '2026-03-01T12:00:00.000Z', invoiceId: 'in_renewal'};
  await s.deliver({id: 'evt_renew_exact', customerId: 'cus_A', subscription: renewal});
  await s.deliver({id: 'evt_renew_repeat', customerId: 'cus_A', subscription: renewal});
  const pool = (await s.call('/assistant/pool')).data;
  assert.equal(pool.allotmentCredits, 75); assert.equal(pool.topUpCredits, 20); assert.equal(pool.balanceCredits, 95);
});

test('unpaid upgrades and delayed older periods cannot grant or rewind credits', async () => {
  const s = await setup(); await s.activate();
  const before = (await s.call('/assistant/pool')).data.allotmentCredits;
  s.setDate('2026-01-16T12:00:00Z');
  await s.deliver({id: 'evt_unpaid_upgrade', customerId: 'cus_A', subscription: subscription({tier: 'assistant-heavy', paid: false, pending: true})});
  assert.equal((await s.call('/assistant/pool')).data.allotmentCredits, before);
  await s.deliver({id: 'evt_paid_upgrade', customerId: 'cus_A', subscription: subscription({tier: 'assistant-heavy', invoiceId: 'in_upgrade', changedAt: '2026-01-16T12:00:00.000Z'})});
  assert.equal((await s.call('/assistant/pool')).data.allotmentCredits, 525);
  await s.deliver({id: 'evt_repeat_upgrade', customerId: 'cus_A', subscription: subscription({tier: 'assistant-heavy', invoiceId: 'in_upgrade'})});
  assert.equal((await s.call('/assistant/pool')).data.allotmentCredits, 525);
  await s.deliver({id: 'evt_next_period', customerId: 'cus_A', subscription: subscription({periodStart: '2026-02-01T00:00:00.000Z', periodEnd: '2026-03-01T00:00:00.000Z', invoiceId: 'in_next'})});
  await s.deliver({id: 'evt_old_period', customerId: 'cus_A', subscription: subscription()});
  assert.equal((await s.repos.forTenant('A').assistantPlan())!.paidInvoiceId, 'in_next');
});

test('seat changes do not enable users until Stripe confirms the paid quantity', async () => {
  const s = await setup();
  await s.call('/assistant/admin/billing/checkout', {tier: 'assistant'});
  await s.deliver({id: 'evt_single', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 1})});
  const stripe = s.stripe as FakeStripe & {updateSubscription: NonNullable<StripeBilling['updateSubscription']>};
  stripe.updateSubscription = async (_id, seats) => {assert.equal(seats, 2); return subscription({tier: 'assistant', quantity: 1, pending: true, paid: false});};
  assert.equal((await s.call('/assistant/admin/billing/seats', {userIds: ['staff', 'user-A']})).status, 200);
  assert.deepEqual((await s.repos.forTenant('A').assistantPlan())!.licensedUserIds, ['user-A']);
  await s.deliver({id: 'evt_two_paid', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 2, invoiceId: 'in_seats'})});
  assert.deepEqual((await s.repos.forTenant('A').assistantPlan())!.licensedUserIds, ['staff', 'user-A']);
  assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hi'}]}, 'A', 'staff')).status, 200);
});

test('refunds and disputes pause assistant access and ordinary subscription events do not clear review', async () => {
  for (const hold of ['refund', 'dispute'] as const) {
    const s = await setup(); await s.activate();
    await s.deliver({id: `evt_${hold}`, customerId: 'cus_A', hold});
    await s.deliver({id: `evt_paid_after_${hold}`, customerId: 'cus_A', subscription: subscription()});
    assert.equal((await s.call('/assistant/chat', {messages: [{role: 'user', text: 'Hi'}]})).error.code, 'ASSISTANT_BILLING_REVIEW');
    assert.equal((await s.call('/assistant/admin/billing/topup', {credits: 20})).status, 402);
  }
});

test('secret loading caches and rotates credentials without exposing them or breaking core availability', async () => {
  const {createBillingLoader} = await import('../src/billing-secrets.js');
  let reads = 0, timeMs = 0;
  const configuration = {FREEDMS_STRIPE_SECRET_KEY: 'sk_test_offline', FREEDMS_STRIPE_WEBHOOK_SECRET: 'whsec_offline',
    FREEDMS_STRIPE_PRICE_ASSISTANT: 'a', FREEDMS_STRIPE_PRICE_ASSISTANT_PRO: 'b', FREEDMS_STRIPE_PRICE_ASSISTANT_HEAVY: 'c', FREEDMS_STRIPE_PRICE_TOPUP: 'd'};
  const load = createBillingLoader({FREEDMS_STRIPE_SECRET_ARN: 'offline'}, async () => {reads++; return JSON.stringify(configuration);}, () => timeMs);
  assert.equal((await load()).configured, true); assert.equal((await load()).testMode, true); assert.equal(reads, 1);
  timeMs = 60001; await load(); assert.equal(reads, 2);
  const broken = createBillingLoader({FREEDMS_STRIPE_SECRET_ARN: 'offline'}, async () => {throw new Error('private error');});
  assert.equal((await broken()).configured, false);
  const {FREEDMS_STRIPE_WEBHOOK_SECRET: _missing, ...incomplete} = configuration;
  assert.equal(stripeBillingFromEnv(incomplete).configured, false);
});

test('a later subscription event cannot undo reassignment of already paid seats', async () => {
  const s = await setup();
  await s.call('/assistant/admin/billing/checkout', {tier: 'assistant'});
  await s.deliver({id: 'evt_first_assignment', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 1})});
  const repo = s.repos.forTenant('A'), old = (await repo.assistantBillingLink())!;
  const change = {...old, seatChange: {id: 'completed-change', userIds: ['user-A'], tier: 'assistant' as const, requestedAt: time.toISOString()}, version: old.version + 1};
  await repo.updateAssistantBillingLink(change, old.version, {id: randomUUID(), tenantId: 'A', actorId: 'user-A', aggregateId: 'assistant-billing', aggregateVersion: change.version, type: 'assistant-billing.updated', occurredAt: time.toISOString(), deliveryStatus: 'pending'});
  await s.deliver({id: 'evt_assignment_applied', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 1})});
  (s.stripe as FakeStripe & {updateSubscription: NonNullable<StripeBilling['updateSubscription']>}).updateSubscription = async () => {throw Error('Reassignment must not change Stripe');};
  assert.equal((await s.call('/assistant/admin/billing/seats', {userIds: ['staff']})).status, 200);
  await s.deliver({id: 'evt_later_subscription', customerId: 'cus_A', subscription: subscription({tier: 'assistant', quantity: 1})});
  assert.deepEqual((await repo.assistantPlan())!.licensedUserIds, ['staff']);
});
