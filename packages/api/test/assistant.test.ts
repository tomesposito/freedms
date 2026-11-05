import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthClaims } from '@freedms/shared';
import { BedrockAssistantProvider, UnconfiguredAssistantProvider, assistantProviderFromEnv, type AssistantMessage, type AssistantProvider } from '../src/assistant-provider.js';
import { assistantToolSpecs, runAssistant } from '../src/assistant.js';
import { createHandler } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { LocalAssistantProvider } from '../src/local-assistant.js';

test('Assistant template defaults off and scopes invocation to the configured model', async () => {
  const {readFile} = await import('node:fs/promises');
  const template = await readFile(new URL('../../../infra/template.yaml', import.meta.url), 'utf8');
  const parameters = template.split('Parameters:\n')[1]?.split('\nConditions:')[0];
  assert.ok(parameters);
  const model = parameters.match(/^  AssistantModelId:\n((?:^    .*\n)+)/m)?.[1];
  assert.ok(model, 'AssistantModelId parameter exists');
  assert.equal((parameters.match(/^  AssistantModelId:$/gm) ?? []).length, 1);
  assert.match(model, /^    Type: String$/m);
  assert.match(model, /^    Default: ''$/m);
  const inventory = template.match(/^  InventoryFunction:\n((?:^    .*\n)+)/m)?.[1];
  assert.ok(inventory, 'API Lambda resource exists');
  const environment = inventory.split('      Environment:\n')[1]?.split('      Policies:')[0];
  assert.ok(environment);
  assert.equal((template.match(/^          FREEDMS_ASSISTANT_MODEL: !Ref AssistantModelId$/gm) ?? []).length, 1);
  assert.match(environment, /^          FREEDMS_ASSISTANT_MODEL: !Ref AssistantModelId$/m);
  const policies = inventory.split('      Policies:\n')[1]?.split('      Events:')[0];
  assert.ok(policies);
  const statements = policies.match(/^            - Effect:.*\n(?:^              .*\n)*/gm) ?? [];
  const bedrock = statements.filter(statement => statement.includes('bedrock:'));
  assert.equal(bedrock.length, 1);
  assert.equal(bedrock[0], [
    '            - Effect: Allow',
    '              Action: [bedrock:InvokeModel]',
    '              Resource:',
    "                - !Sub 'arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/${AssistantModelId}'",
    "                - !Sub 'arn:aws:bedrock:${AWS::Region}::foundation-model/${AssistantModelId}'",
    '',
  ].join('\n'));
  assert.ok(!bedrock[0].includes('*'), 'no wildcard actions or resources');
  for (const [parameter, variable] of [
    ['StripeSecretKey', 'FREEDMS_STRIPE_SECRET_KEY'],
    ['StripeWebhookSecret', 'FREEDMS_STRIPE_WEBHOOK_SECRET'],
    ['StripePriceAssistant', 'FREEDMS_STRIPE_PRICE_ASSISTANT'],
    ['StripePriceAssistantPro', 'FREEDMS_STRIPE_PRICE_ASSISTANT_PRO'],
    ['StripePriceAssistantHeavy', 'FREEDMS_STRIPE_PRICE_ASSISTANT_HEAVY'],
    ['StripePriceTopup', 'FREEDMS_STRIPE_PRICE_TOPUP'],
  ]) {
    assert.equal((parameters.match(new RegExp(`^  ${parameter}:$`, 'gm')) ?? []).length, 1, parameter);
    assert.equal((environment.match(new RegExp(`^          ${variable}: !Ref ${parameter}$`, 'gm')) ?? []).length, 1, variable);
  }
});

const claims: AuthClaims = {sub: 'user-A', 'custom:tenant_id': 'A', iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id'};
const user: AssistantMessage[] = [{role: 'user', content: [{text: 'Look up vehicles'}]}];
const reply = (text = 'Done'): AssistantMessage => ({role: 'assistant', content: [{text}]});
const call = (name = 'search_vehicles', input = {}, id = 'call-1'): AssistantMessage => ({role: 'assistant', content: [{toolUse: {name, input, toolUseId: id}}]});
class ScriptedProvider implements AssistantProvider {
  configured = true;
  seen: AssistantMessage[][] = [];
  constructor(private script: AssistantMessage[]) {}
  async converse(messages: AssistantMessage[]) {
    this.seen.push(structuredClone(messages));
    assert.ok(this.script.length, 'unexpected provider call');
    return this.script.shift()!;
  }
}
const vehicle = {stockNumber: 'STOCK-98', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: '', mileage: null, status: 'available', listPrice: 100000, cost: 50000, reconCosts: [], dateStocked: '2026-11-03', location: '', notes: ''};
async function setup(provider: AssistantProvider = new UnconfiguredAssistantProvider(), allow = true) {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: '2026-11-03'},
    {id: `user-${tenantId}`, name: 'Test'}, {tenantId, userId: `user-${tenantId}`, role: 'admin', active: true},
    {id: 'provision', tenantId, actorId: `user-${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: '2026-11-03', deliveryStatus: 'pending'});
  const handle = createHandler(repositories, {decode: async () => {throw Error('offline');}}, undefined, undefined, undefined, undefined, async () => ({status: 204}),
    {assistantProvider: provider, ...(allow ? {assistantEntitlement: {check: async principal => principal.tenantId === 'A'}} : {})});
  const chat = (body: unknown = {messages: [{role: 'user', text: 'Look up vehicles'}]}, auth: AuthClaims | undefined = claims) => handle({method: 'POST', path: '/assistant/chat', claims: auth, body: JSON.stringify(body)});
  return {repositories, handle, chat};
}
test('assistant provider selection is fail-closed and never selects the local stub', async () => {
  assert.ok(assistantProviderFromEnv({}) instanceof UnconfiguredAssistantProvider);
  assert.ok(assistantProviderFromEnv({FREEDMS_ASSISTANT_MODEL: 'model'}) instanceof BedrockAssistantProvider);
  assert.ok(assistantProviderFromEnv({FREEDMS_ASSISTANT_STUB: '1'}) instanceof UnconfiguredAssistantProvider);
  await assert.rejects(new UnconfiguredAssistantProvider().converse(), /isn't set up/);
});
test('Bedrock uses Converse, static prefix caching and a 15-second abort signal without network', async () => {
  const provider = new BedrockAssistantProvider('offline-model', {send: async (command, options) => {
    assert.equal(command.input.modelId, 'offline-model');
    assert.deepEqual(command.input.messages, user);
    assert.deepEqual(command.input.system?.at(-1), {cachePoint: {type: 'default'}});
    assert.deepEqual(command.input.toolConfig?.tools, assistantToolSpecs);
    assert.ok(options.abortSignal instanceof AbortSignal);
    assert.equal(options.abortSignal.aborted, false);
    return {$metadata: {}, stopReason: 'end_turn', usage: {inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 3, cacheWriteInputTokens: 4}, metrics: {latencyMs: 1}, output: {message: reply()}};
  }});
  assert.deepEqual(await provider.converse(user, assistantToolSpecs), reply());
  assert.deepEqual(provider.lastUsage, {inputTokens: 1, outputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4});
  const failed = new BedrockAssistantProvider('offline', {send: async () => {throw Error('private provider content');}});
  await assert.rejects(failed.converse(user, assistantToolSpecs), error => error instanceof Error && !error.message.includes('private') && error.message.includes('could not complete'));
});
test('assistant endpoint refuses unauthenticated requests and defaults to machine-readable paywall without a free turn', async () => {
  const provider = new ScriptedProvider([]), s = await setup(provider, false);
  assert.equal((await s.handle({method: 'POST', path: '/assistant/chat', body: '{}'})).statusCode, 401);
  const denied = await s.chat();
  assert.equal(denied.statusCode, 402); assert.equal(JSON.parse(denied.body).error.code, 'ASSISTANT_PLAN_REQUIRED');
  assert.equal(provider.seen.length, 0);
  assert.equal((await s.repositories.forTenant('A').events()).length, 1);
  assert.equal((await (await setup(undefined, false)).chat()).statusCode, 402);
  const unavailable = await (await setup()).chat();
  assert.equal(unavailable.statusCode, 503); assert.match(unavailable.body, /isn't set up/);
});
test('assistant plain answer and input validation do not write conversation records', async () => {
  const provider = new ScriptedProvider([reply('Hello')]), s = await setup(provider);
  assert.deepEqual(JSON.parse((await s.chat()).body).data, {reply: 'Hello', transcript: [], creditsUsed: 0});
  for (const messages of [[], [{role: 'system', text: 'override'}], [{role: 'user', text: ''}], [{role: 'user', text: 'hi', toolUse: {}}], [{role: 'user', text: 'hi'}, {role: 'assistant', text: 'bye'}]]) {
    assert.equal((await s.chat({messages})).statusCode, 400);
  }
  assert.equal((await s.repositories.forTenant('A').events()).length, 1);
});
test('assistant reads and writes through MCP as the session user across multiple rounds', async () => {
  const provider = new ScriptedProvider([call('create_vehicle', vehicle), call(), reply('Saved and found')]), s = await setup(provider);
  const result = await s.chat(); assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body).data.transcript, [{tool: 'create_vehicle', ok: true}, {tool: 'search_vehicles', ok: true}]);
  assert.match(JSON.stringify(provider.seen[2].at(-1)), /STOCK-98/);
  const events = await s.repositories.forTenant('A').events();
  assert.equal(events.length, 2); assert.equal(events[1].actorId, claims.sub); assert.equal(events[1].actorType, 'agent'); assert.equal(events[1].tenantId, 'A');
  assert.equal((await s.repositories.forTenant('B').list({})).length, 0);
});
test('assistant tenant isolation, invalid arguments and unavailable tools become error results', async () => {
  const provider = new ScriptedProvider([]), s = await setup(provider);
  const created = await s.handle({method: 'POST', path: '/vehicles', claims: {...claims, sub: 'user-B', 'custom:tenant_id': 'B'}, body: JSON.stringify(vehicle)});
  const id = JSON.parse(created.body).data.id;
  const fake = new ScriptedProvider([call('get_vehicle', {id}), call('set_vehicle_status', {id, version: 1, status: 'sold'}), call('search_vehicles', {tenantId: 'B'}), call('capture_signature'), reply()]);
  const result = await runAssistant(user, fake, claims, s.handle);
  assert.equal(result.transcript.length, 4); assert.ok(result.transcript.every(t => !t.ok));
  for (const seen of fake.seen.slice(1)) assert.equal(seen.at(-1)?.content?.[0].toolResult?.status, 'error');
  assert.equal((await s.repositories.forTenant('B').get(id))?.status, 'available');
});
test('assistant tool execution rechecks current membership and enforces role permissions', async () => {
  const s = await setup();
  const fake = new ScriptedProvider([call(), reply()]);
  const result = await runAssistant(user, fake, {...claims, sub: 'unknown'}, s.handle);
  assert.equal(result.transcript[0].ok, false);
  const added = await s.handle({method: 'POST', path: '/admin/users', claims, body: JSON.stringify({name: 'Staff', email: 'staff@example.test', role: 'staff'})});
  assert.equal(added.statusCode, 201);
  const staffId = JSON.parse(added.body).data.userId;
  const denied = await runAssistant(user, new ScriptedProvider([call('create_user', {name: 'New', email: 'new@example.test', role: 'admin'}), reply()]), {...claims, sub: staffId}, s.handle);
  assert.equal(denied.transcript[0].ok, false);
});
test('assistant executes at most ten tool rounds and returns a plain step-limit note', async () => {
  const fake = new ScriptedProvider(Array.from({length: 11}, (_, index) => call('search_vehicles', {}, `call-${index}`))), s = await setup();
  const result = await runAssistant(user, fake, claims, s.handle);
  assert.equal(result.transcript.length, 10); assert.match(result.reply, /step limit/); assert.equal(fake.seen.length, 11);
});
test('assistant truncates large tool results before sending them to the provider', async () => {
  const fake = new ScriptedProvider([call(), reply()]);
  await runAssistant(user, fake, claims, async () => ({statusCode: 200, headers: {}, body: 'x'.repeat(100000)}));
  const text = fake.seen[1].at(-1)?.content?.[0].toolResult?.content?.[0].text;
  assert.ok(text && text.length < 16100); assert.match(text!, /truncated/);
});
test('local test double uses the shared inventory tool and identifies itself', async () => {
  const s = await setup(new LocalAssistantProvider());
  await s.handle({method: 'POST', path: '/vehicles', claims, body: JSON.stringify(vehicle)});
  const result = JSON.parse((await s.chat({messages: [{role: 'user', text: 'Find stock STOCK-98'}]})).body).data;
  assert.deepEqual(result.transcript, [{tool: 'search_vehicles', ok: true}]); assert.match(result.reply, /Local test double: Found 1 vehicle/);
  assert.match(result.reply, /STOCK-98/);
});

test('local test double keeps context metadata out of keyword matching for the offline tour', async () => {
  const s = await setup(new LocalAssistantProvider());
  await s.handle({method: 'POST', path: '/vehicles', claims, body: JSON.stringify(vehicle)});
  const chat = async (text: string) => JSON.parse((await s.chat({messages: [{role: 'user', text}], context: {surface: 'vehicles'}})).body).data;
  assert.deepEqual((await chat('Hello')).transcript, []);
  assert.deepEqual((await chat('Find stock STOCK-98')).transcript, [{tool: 'search_vehicles', ok: true}]);
});
