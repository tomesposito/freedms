import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AssistantPlan, AuthClaims, OutboxEvent } from '@freedms/shared';
import { AssistantBilling, assistantCycleDates, proratedAssistantCredits, priceForTool, PHOTO_PRICE } from '../src/assistant-billing.js';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import { tools } from '../src/mcp/tools.js';
import { LocalAssistantProvider } from '../src/local-assistant.js';
import type { AssistantProvider, AssistantMessage } from '../src/assistant-provider.js';
const reply: AssistantMessage = {role: 'assistant', content: [{text: 'Done'}]};
function calls(...names: string[]): AssistantMessage {
  return {role: 'assistant', content: names.map((name, i): NonNullable<AssistantMessage['content']>[number] => ({toolUse: {name, toolUseId: `call-${i}`, input: name === 'create_customer' ? {name: 'Test', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}} : {}}}))};
}
class Fake implements AssistantProvider {
  configured = true;
  lastUsage = {inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2};
  count = 0;
  constructor(public script: (AssistantMessage | Error)[] = [reply]) {}
  async converse() { this.count++; const next = this.script.shift(); if (next instanceof Error) throw next; assert.ok(next); return next; }
}
async function setup(provider: AssistantProvider = new Fake(), seed = false, hosted = false) {
  const repositories = new MemoryRepositories();
  let date = new Date('2026-01-01T12:00:00Z');
  const event = (tenantId: string, type: OutboxEvent['type'], id: string, version = 1): OutboxEvent => ({id: randomUUID(), tenantId, actorId: `user-${tenantId}`, type, aggregateId: id, aggregateVersion: version, occurredAt: date.toISOString(), deliveryStatus: 'pending'});
  for (const tenant of ['A', 'B']) await repositories.forTenant(tenant).provision({id: tenant, name: tenant, createdAt: date.toISOString()},
    {id: `user-${tenant}`, name: 'Test'}, {tenantId: tenant, userId: `user-${tenant}`, role: 'admin', active: true}, event(tenant, 'tenant.created', tenant));
  const handle = createHandler(repositories, {decode: async () => {throw Error('offline');}}, () => date, undefined, undefined, undefined, undefined,
    {assistantProvider: provider, assistantSeedLocalPlan: seed, hosted});
  const auth = (tenant = 'A', user = `user-${tenant}`): AuthClaims => ({sub: user, 'custom:tenant_id': tenant, iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id'});
  const get = async (path: string, tenant = 'A', user?: string) => {
    const result = await handle({method: 'GET', path, claims: auth(tenant, user)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const chat = async (tenant = 'A', user?: string) => {
    const result = await handle({method: 'POST', path: '/assistant/chat', claims: auth(tenant, user), body: JSON.stringify({messages: [{role: 'user', text: 'Find stock TEST'}]})});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const plan = async (patch: Partial<AssistantPlan> = {}, tenant = 'A') => {
    const repo = repositories.forTenant(tenant), old = await repo.assistantPlan();
    const record: AssistantPlan = {id: 'assistant-plan', tenantId: tenant, tier: 'assistant', status: 'active', cycleAnchor: '2026-01-01', disabled: false, overageEnabled: false, overageCapCredits: 500, perRequestCreditCap: 25, ...old, ...patch, version: (old?.version ?? 0) + 1};
    await repo.saveAssistantPlan(record, record.version - 1, event(tenant, 'assistant-plan.updated', record.id, record.version));
  };
  const repo = repositories.forTenant('A');
  const billing = new AssistantBilling(repo, () => date);
  const actor = {tenantId: 'A', userId: 'user-A', role: 'admin' as const};
  const balance = async (credits: number) => {
    await billing.pool(actor);
    const cycle = (await repo.assistantCycle('2026-01-01'))!;
    await repo.saveAssistantCycle({...cycle, allotmentCredits: credits, version: cycle.version + 1}, cycle.version);
  };
  const member = async (id: string, active = true) => {
    const old = await repo.membership(id), version = (old?.version ?? 0) + 1;
    await repo.saveMember({id, name: id, email: `${id}@example.test`}, {tenantId: 'A', userId: id, role: 'staff', active, version}, version - 1,
      event('A', old ? (active ? 'user.reactivated' : 'user.deactivated') : 'user.added', id, version));
  };
  const settings = async (body: unknown, tenant = 'A', user?: string) => {
    const result = await handle({method: 'PUT', path: '/assistant/admin/settings', claims: auth(tenant, user), body: JSON.stringify(body)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  return {repositories, repo, billing, actor, plan, chat, get, balance, member, settings, date: (value: string) => {date = new Date(value);}};
}
test('assistant billing prices derive from registry methods and reserve photo pricing', () => {
  for (const tool of tools) assert.deepEqual(priceForTool(tool.name), {actionClass: tool.method === 'GET' ? 'read' : 'write', credits: tool.method === 'GET' ? 1 : 2});
  assert.equal(priceForTool('unknown'), undefined); assert.deepEqual(PHOTO_PRICE, {actionClass: 'photo', credits: 3});
});
test('assistant billing debits read, write and answer exactly and attributes round tokens once', async () => {
  const s = await setup(new Fake([calls('search_vehicles', 'create_customer', 'search_vehicles'), reply])); await s.plan();
  const result = await s.chat(); assert.equal(result.status, 200); assert.equal(result.data.creditsUsed, 5);
  assert.ok(result.data.transcript.every((r: {ok: boolean}) => r.ok));
  const rows = await s.repo.assistantLedger('2026-01-01');
  assert.deepEqual(rows.map(r => r.credits), [1, 2, 1, 1]);
  assert.deepEqual(rows.map(r => r.inputTokens), [10, 0, 0, 10]);
  for (const [key, total] of Object.entries({inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, cacheWriteTokens: 4})) assert.equal(rows.reduce((sum, row) => sum + row[key as 'inputTokens'], 0), total);
  assert.ok(rows.every(row => !('messages' in row) && !('input' in row)));
  assert.equal((await s.get('/assistant/pool')).data.balanceCredits, 70);
});
test('assistant billing failed tools are free and failed turns discard all pending debits', async () => {
  const s = await setup(new Fake([calls('unknown', 'get_vehicle', 'search_vehicles'), reply])); await s.plan();
  const result = await s.chat(); assert.equal(result.data.creditsUsed, 2);
  assert.deepEqual(result.data.transcript.map((r: {ok: boolean}) => r.ok), [false, false, true]);
  const failed = await setup(new Fake([calls('search_vehicles'), new Error('offline failure')])); await failed.plan();
  assert.equal((await failed.chat()).status, 500); assert.deepEqual(await failed.repo.assistantLedger('2026-01-01'), []);
});
test('assistant pool exhaustion stops mid-round and refuses the next turn before provider invocation', async () => {
  const fake = new Fake([calls('search_vehicles', 'search_vehicles', 'create_customer', 'search_vehicles')]);
  const s = await setup(fake); await s.plan(); await s.balance(2);
  const result = await s.chat(); assert.equal(result.data.creditsUsed, 2); assert.equal(result.data.transcript.length, 2); assert.match(result.data.reply, /pool is exhausted/);
  assert.equal((await s.repo.crmList('customer')).length, 0);
  assert.equal((await s.chat()).error.code, 'ASSISTANT_CREDITS_EXHAUSTED'); assert.equal(fake.count, 1);
});
test('assistant never exposes an unpaid final answer at pool or request cap', async () => {
  for (const cap of [false, true]) {
    const s = await setup(new Fake([calls('search_vehicles'), reply])); await s.plan(cap ? {perRequestCreditCap: 1} : {});
    if (!cap) await s.balance(1);
    const result = await s.chat(); assert.equal(result.data.creditsUsed, 1); assert.notEqual(result.data.reply, 'Done');
    assert.match(result.data.reply, cap ? /credit cap/ : /pool is exhausted/);
  }
});
test('assistant default 25-credit cap and custom caps stop before remaining actions execute', async () => {
  for (const cap of [25, 3]) {
    const s = await setup(new Fake([calls(...Array(20).fill('search_vehicles')), calls(...Array(20).fill('search_vehicles'))]));
    await s.plan({perRequestCreditCap: cap}); const result = await s.chat();
    assert.equal(result.data.creditsUsed, cap); assert.equal(result.data.transcript.length, cap); assert.match(result.data.reply, /credit cap/);
  }
});
test('assistant overage allows negative balances and readouts show overage used', async () => {
  const s = await setup(new Fake([calls('search_vehicles', 'search_vehicles'), reply])); await s.plan({overageEnabled: true}); await s.balance(0);
  assert.equal((await s.chat()).data.creditsUsed, 3);
  const pool = (await s.get('/assistant/pool')).data; assert.equal(pool.balanceCredits, -3); assert.equal(pool.overageCreditsUsed, 3);
});
test('assistant UTC anniversaries clamp month ends without drifting and prorate per added user', () => {
  assert.deepEqual(assistantCycleDates('2026-01-31T23:59:00Z', new Date('2026-02-28')), {cycleStart: '2026-02-28', cycleEnd: '2026-03-31'});
  assert.deepEqual(assistantCycleDates('2024-01-31', new Date('2024-02-28')), {cycleStart: '2024-01-31', cycleEnd: '2024-02-29'});
  assert.deepEqual(assistantCycleDates('2026-01-31', new Date('2026-12-31')), {cycleStart: '2026-12-31', cycleEnd: '2027-01-31'});
  assert.equal(proratedAssistantCredits(75, 2, '2026-01-01', '2026-02-01', new Date('2026-01-16T23:00:00Z')), 76);
});
test('assistant cycle snapshots, prorated additions, removal high-water mark and rollover', async () => {
  const s = await setup(); await s.plan(); assert.equal((await s.get('/assistant/pool')).data.allotmentCredits, 75);
  await s.chat(); s.date('2026-01-16T12:00:00Z'); await s.member('staff');
  assert.equal((await s.get('/assistant/pool')).data.allotmentCredits, 113);
  await s.member('staff', false); assert.equal((await s.get('/assistant/pool')).data.allotmentCredits, 113);
  s.date('2026-02-01T00:00:00Z'); const next = (await s.get('/assistant/pool')).data;
  assert.equal(next.allotmentCredits, 75); assert.equal(next.usedCredits, 0); assert.equal(next.balanceCredits, 75);
  assert.equal((await s.repo.assistantLedger('2026-01-01')).length, 1);
});
test('assistant entitlement matrix enforces plan status, disable setting, exhausted pool and configured provider', async () => {
  const s = await setup();
  for (const path of ['/assistant/pool', '/assistant/usage']) assert.equal((await s.get(path)).error.code, 'ASSISTANT_PLAN_REQUIRED');
  assert.equal((await s.chat()).error.code, 'ASSISTANT_PLAN_REQUIRED');
  for (const status of ['past_due', 'cancelled'] as const) {await s.plan({status}); assert.equal((await s.chat()).error.code, status === 'past_due' ? 'ASSISTANT_PAST_DUE' : 'ASSISTANT_PLAN_REQUIRED');}
  await s.plan({status: 'active', disabled: true}); assert.equal((await s.chat()).status, 403); assert.equal((await s.chat()).error.code, 'ASSISTANT_DISABLED');
  await s.plan({disabled: false}); await s.balance(0); assert.equal((await s.chat()).error.code, 'ASSISTANT_CREDITS_EXHAUSTED');
  await s.plan({overageEnabled: true}); assert.equal((await s.chat()).status, 200);
  const unconfigured = await setup({configured: false, converse: async () => {throw Error('must not run');}}); await unconfigured.plan(); assert.equal((await unconfigured.chat()).status, 503);
});
test('assistant pool, ledger and usage isolate tenants and usage is limited by caller role', async () => {
  const s = await setup(new Fake([reply, reply])); await s.plan(); await s.plan({}, 'B'); await s.member('staff');
  await s.chat(); await s.chat('A', 'staff');
  assert.equal((await s.get('/assistant/usage')).data.byUser.length, 2);
  assert.deepEqual((await s.get('/assistant/usage', 'A', 'staff')).data.byUser.map((row: {userId: string}) => row.userId), ['staff']);
  assert.deepEqual((await s.get('/assistant/usage', 'B')).data.byUser, []);
  assert.equal((await s.get('/assistant/pool', 'B')).data.balanceCredits, 75);
  const b = s.repositories.forTenant('B'); assert.deepEqual(await b.assistantLedger('2026-01-01'), []);
  await assert.rejects(b.appendAssistantLedger((await s.repo.assistantLedger('2026-01-01'))[0]), /scope/);
  const plan = (await s.repo.assistantPlan())!;
  await assert.rejects(b.saveAssistantPlan(plan, 0, {id: 'x', tenantId: 'A', actorId: 'user-A', aggregateId: plan.id, aggregateVersion: 1, type: 'assistant-plan.updated', occurredAt: '2026-01-01', deliveryStatus: 'pending'}), /scope/);
  await assert.rejects(b.saveAssistantCycle((await s.repo.assistantCycle('2026-01-01'))!, 0), /scope/);
});
test('local stub seeds only with explicit local option and burns the entire seeded pool', async () => {
  const s = await setup(new LocalAssistantProvider(), true);
  let total = 0;
  for (let i = 0; i < 38; i++) { const result = await s.chat(); assert.equal(result.status, 200); total += result.data.creditsUsed; }
  assert.equal(total, 75); assert.equal((await s.chat()).error.code, 'ASSISTANT_CREDITS_EXHAUSTED');
  assert.equal((await s.get('/assistant/pool')).data.balanceCredits, 0);
  assert.equal((await s.repo.assistantPlan())?.perRequestCreditCap, 25);
  for (const hosted of [false, true]) {
    const off = await setup(new LocalAssistantProvider(), hosted, hosted); assert.equal((await off.chat()).status, 402); assert.equal(await off.repo.assistantPlan(), undefined);
  }
});

test('assistant completed-turn commits are atomic, immutable and reject stale billing snapshots', async () => {
  const s = await setup(); await s.plan(); await s.balance(1);
  const first = await s.billing.meter(s.actor), concurrent = await s.billing.meter(s.actor);
  first.charge('answer', {actionClass: 'answer', credits: 1});
  concurrent.charge('answer', {actionClass: 'answer', credits: 1});
  assert.equal(await first.finish(), 1);
  await assert.rejects(concurrent.finish(), {code: 'CONFLICT'});
  await assert.rejects(first.finish(), {code: 'CONFLICT'});
  assert.equal((await s.repo.assistantLedger('2026-01-01')).length, 1);
  assert.equal((await s.get('/assistant/pool')).data.balanceCredits, 0);
  const rows = await s.repo.assistantLedger('2026-01-01'); rows[0].credits = 999;
  assert.equal((await s.repo.assistantLedger('2026-01-01'))[0].credits, 1);
});

test('assistant Dynamo billing keys, pagination, conditional writes and atomic turn batches work offline', async () => {
  const { DynamoRepositories } = await import('../src/dynamo.js');
  const { GetCommand, QueryCommand, TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
  type Command = InstanceType<typeof GetCommand> | InstanceType<typeof QueryCommand> | InstanceType<typeof TransactWriteCommand>;
  const commands: Command[] = [];
  const s = await setup(); await s.plan(); await s.chat();
  const plan = (await s.repo.assistantPlan())!, cycle = (await s.repo.assistantCycle('2026-01-01'))!, row = (await s.repo.assistantLedger('2026-01-01'))[0];
  let pages = 0;
  const client = {send: async (command: Command) => {
    commands.push(command);
    if (command instanceof QueryCommand) {
      pages++;
      return {Items: [{data: pages === 1 ? row : {entries: [{...row, id: 'batch-entry'}]}}], ...(pages === 1 ? {LastEvaluatedKey: {PK: 'TENANT#A', SK: 'cursor'}} : {})};
    }
    return {};
  }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const repo = new DynamoRepositories('offline', client).forTenant('A');
  await repo.assistantPlan(); await repo.assistantCycle(cycle.cycleStart);
  assert.equal((await repo.assistantLedger(cycle.cycleStart)).length, 2);
  await repo.saveAssistantPlan(plan, 0, {id: 'plan-event', tenantId: 'A', actorId: 'user-A', aggregateId: plan.id, aggregateVersion: 1, type: 'assistant-plan.updated', occurredAt: '2026-01-01', deliveryStatus: 'pending'});
  await repo.saveAssistantCycle({...cycle, version: 1}, 0);
  await repo.saveAssistantCycle({...cycle, version: 2}, 1);
  await repo.appendAssistantLedger(row);
  await repo.commitAssistantLedger(Array.from({length: 201}, (_, i) => ({...row, id: `debit-${i}`})), cycle, plan.version);
  for (const command of commands) {
    if (command instanceof GetCommand) {assert.equal(command.input.Key?.PK, 'TENANT#A'); assert.equal(command.input.ConsistentRead, true);}
    if (command instanceof QueryCommand) {assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A'); assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'ASSISTANTLEDGER#2026-01-01#'); assert.equal(command.input.ConsistentRead, true);}
    if (command instanceof TransactWriteCommand) for (const item of command.input.TransactItems!) {
      assert.equal((item.Put?.Item ?? item.ConditionCheck?.Key)?.PK, 'TENANT#A');
      assert.ok(item.Put?.ConditionExpression || item.ConditionCheck?.ConditionExpression);
    }
  }
  const transaction = (commands.at(-1) as InstanceType<typeof TransactWriteCommand>).input.TransactItems!;
  assert.equal(transaction.length, 3);
  assert.equal(transaction[1].Put?.ExpressionAttributeValues?.[':v'], cycle.version);
  assert.equal(transaction[2].Put?.Item?.data.entries.length, 201);
  const count = commands.length;
  await assert.rejects(repo.appendAssistantLedger({...row, tenantId: 'B'}), /scope/);
  await assert.rejects(repo.commitAssistantLedger([{...row, tenantId: 'B'}], cycle, 1), /scope/);
  assert.equal(commands.length, count);
});

test('assistant admin readout, active seats, authorization, missing plan and validation', async () => {
  const s = await setup();
  assert.deepEqual((await s.get('/assistant/admin')).data, {plan: null, billingConfigured: false});
  assert.equal((await s.settings({disabled: true})).error.code, 'ASSISTANT_PLAN_REQUIRED');
  await s.plan({tier: 'assistant-pro'});
  let data = (await s.get('/assistant/admin')).data;
  assert.equal(data.plan.tierName, 'Assistant Pro'); assert.equal(data.plan.monthlyTotalCents, 2900);
  assert.equal(data.plan.billedUserCount, 1); assert.equal(data.plan.renewalDate, '2026-02-01');
  await s.member('staff'); await s.member('inactive'); await s.member('inactive', false);
  data = (await s.get('/assistant/admin')).data;
  assert.equal(data.plan.billedUserCount, 2); assert.equal(data.plan.monthlyTotalCents, 5800);
  for (const result of [await s.get('/assistant/admin', 'A', 'staff'), await s.settings({disabled: true}, 'A', 'staff')]) {
    assert.equal(result.status, 403); assert.equal(result.error.code, 'FORBIDDEN');
  }
  for (const body of [null, [], {perRequestCreditCap: 1.5}, {perRequestCreditCap: 0}, {perRequestCreditCap: 1001}, {overageCapCredits: -1}, {overageCapCredits: 100001}, {overageCapCredits: null}, {disabled: 'true'}, {overageEnabled: 1}, {tier: 'assistant-heavy'}]) assert.equal((await s.settings(body)).status, 400);
});
test('admin switch isolates tenants, blocks every member and restores use with audited updates', async () => {
  const s = await setup(new Fake([reply, reply, reply])); await s.plan(); await s.plan({}, 'B'); await s.member('staff');
  const before = await s.repositories.forTenant('B').assistantPlan();
  assert.equal((await s.settings({disabled: true})).status, 200);
  assert.equal((await s.repo.assistantPlan())!.disabled, true);
  const event = (await s.repo.events()).find(row => row.type === 'assistant-plan.updated' && row.aggregateVersion === 2)!;
  assert.equal(event.actorId, 'user-A'); assert.equal(event.tenantId, 'A');
  for (const user of ['user-A', 'staff']) assert.equal((await s.chat('A', user)).error.code, 'ASSISTANT_DISABLED');
  assert.equal((await s.chat('B')).status, 200);
  assert.deepEqual(await s.repositories.forTenant('B').assistantPlan(), before);
  assert.equal((await s.settings({disabled: false})).status, 200);
  for (const user of ['user-A', 'staff']) assert.equal((await s.chat('A', user)).status, 200);
  const rows = (await s.get('/assistant/usage')).data.byUser;
  assert.equal(rows.find((row: {userId: string}) => row.userId === 'user-A').name, 'Test');
  assert.ok(rows.every((row: {lastUsedAt: string}) => row.lastUsedAt === '2026-01-01T12:00:00.000Z'));
});
test('admin caps are enforced by the loop, exhaustion clears when monthly cap increases', async () => {
  const s = await setup(new Fake([calls('search_vehicles', 'search_vehicles')])); await s.plan();
  await s.settings({perRequestCreditCap: 1});
  const result = await s.chat(); assert.equal(result.data.creditsUsed, 1); assert.match(result.data.reply, /credit cap/);
  const o = await setup(new Fake([calls('search_vehicles', 'search_vehicles', 'search_vehicles'), reply]));
  await o.plan(); await o.balance(0); await o.settings({overageEnabled: true, overageCapCredits: 2});
  const exhausted = await o.chat(); assert.equal(exhausted.data.creditsUsed, 2); assert.match(exhausted.data.reply, /monthly overage cap/);
  assert.equal((await o.billing.status(o.actor)).status, 'exhausted');
  assert.equal((await o.chat()).error.code, 'ASSISTANT_CREDITS_EXHAUSTED');
  await o.settings({overageCapCredits: 3}); assert.equal((await o.chat()).data.creditsUsed, 1);
  await o.settings({overageCapCredits: 0}); assert.equal((await o.billing.status(o.actor)).status, 'exhausted');
});
test('legacy plan normalizes missing overage cap and repository rejects invalid present caps', async () => {
  const s = await setup(); await s.plan({overageCapCredits: undefined});
  assert.equal((await s.get('/assistant/pool')).data.overageCapCredits, 500);
  assert.equal((await s.get('/assistant/admin')).data.controls.overageCapCredits, 500);
  for (const value of [-1, 1.5, NaN]) await assert.rejects(s.plan({overageCapCredits: value}), /Invalid assistant plan/);
});
