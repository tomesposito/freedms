import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { LocalTokens } from '../src/auth.js';
import { createHandler } from '../src/handler.js';
import { HttpQuickEntryProvider, UnconfiguredProvider, providerFromEnv, type QuickEntryProvider } from '../src/ai-provider.js';
import { bodyLimit, dollarCents, PHOTO_BODY_LIMIT, PHOTO_BASE64_LIMIT, sanitizeLead, sanitizeVehicle } from '../src/quick-entry.js';
const now = new Date('2026-10-20T12:00:00Z');
const rawVehicle = {year: 2019, make: 'Chevrolet', model: 'Silverado', trim: 'LT', cost: 18500, listPrice: '$24,995.29', mileage: '88k miles', tenantId: 'B', status: 'sold'};
const rawLead = {customer: {name: 'John Park', phone: '312-555-0109', consent: {status: 'granted'}}, vehicleDescription: 'blue Tacoma', tradeDescription: '2016 Civic', vehicleId: 'foreign'};
// Canned extraction is test-only; production never falls back to a local parser.
class FakeProvider implements QuickEntryProvider {
  configured = true; supportsVision = true; calls = 0;
  async extractVehicle() { this.calls++; return rawVehicle; }
  async extractLead() { this.calls++; return rawLead; }
  async extractVehiclePhoto() { this.calls++; return rawVehicle; }
}
async function setup(provider: QuickEntryProvider = new FakeProvider()) {
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('quick-entry-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now, undefined, provider);
  const call = async (path: string, body?: unknown, tenant = 'A') => {
    const r = await handler({method: body === undefined ? 'GET' : 'POST', path, body: body === undefined ? undefined : JSON.stringify(body), claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const usage = (tenant = 'A') => repositories.forTenant(tenant).usageForTest();
  const empty = async () => { for (const tenant of ['A', 'B']) {
    for (const path of ['/vehicles', '/customers', '/leads']) assert.deepEqual((await call(path, undefined, tenant)).data, []);
    assert.equal(repositories.eventsForTest(tenant).length, 1);
  }};
  return {repositories, handler, call, usage, empty};
}
const photo = {mediaType: 'image/png', dataBase64: Buffer.from('fake image for fake provider').toString('base64')};
test('quick entry returns vehicle and lead drafts, meters once, and never silently writes', async () => {
  const {call, usage, empty} = await setup();
  const result = await call('/quick-entry/vehicle', {text: 'stock a Silverado'});
  assert.equal(result.status, 200); assert.equal(result.data.draft.cost, 1850000); assert.equal(result.data.draft.listPrice, 2499529);
  assert.equal(result.data.draft.mileage, 88000); assert.equal(result.data.draft.notes, undefined); assert.equal(result.data.draft.tenantId, undefined); assert.equal(result.data.draft.status, undefined);
  let rows = await usage(); assert.equal(rows.length, 1);
  assert.deepEqual({...rows[0], id: 'id'}, {id: 'id', tenantId: 'A', actorId: 'userA', kind: 'vehicle-text', occurredAt: now.toISOString()});
  const lead = await call('/quick-entry/lead', {text: 'new lead John'});
  assert.equal(lead.status, 200); assert.equal(lead.data.draft.vehicleDescription, 'blue Tacoma'); assert.equal(lead.data.draft.customer.notes, 'Trade: 2016 Civic');
  assert.deepEqual(lead.data.draft.customer.consent, {status: 'unknown', timestamp: null, source: ''});
  assert.equal(lead.data.draft.vehicleId, undefined);
  rows = await usage(); assert.equal(rows.length, 2); assert.equal(rows[1].kind, 'lead-text');
  await empty();
});
test('photo drafts and vision unsupported both record one attempt', async () => {
  const fake = new FakeProvider(); const {call, usage, empty} = await setup(fake);
  assert.equal((await call('/quick-entry/vehicle-photo', photo)).data.draft.year, 2019);
  fake.supportsVision = false;
  assert.deepEqual((await call('/quick-entry/status')).data, {configured: true, vision: false});
  const r = await call('/quick-entry/vehicle-photo', photo); assert.equal(r.status, 422); assert.equal(r.error.code, 'AI_VISION_UNSUPPORTED');
  assert.equal(fake.calls, 1); assert.deepEqual((await usage()).map(r => r.kind), ['vehicle-photo', 'vehicle-photo']); await empty();
});
test('unconfigured provider is honest on all endpoints and meters validated attempts consistently', async () => {
  const {call, usage, empty} = await setup(new UnconfiguredProvider());
  assert.deepEqual((await call('/quick-entry/status')).data, {configured: false, vision: false});
  for (const kind of ['vehicle', 'lead', 'vehicle-photo']) {
    const r = await call(`/quick-entry/${kind}`, kind === 'vehicle-photo' ? photo : {text: 'test'});
    assert.equal(r.status, 503); assert.equal(r.error.code, 'AI_UNAVAILABLE'); assert.match(r.error.message, /isn't set up/);
  }
  assert.equal((await usage()).length, 3); await empty();
});
test('tenant usage and drafts are isolated; client tenant overrides and unauthenticated calls are rejected', async () => {
  const {call, usage, repositories, handler, empty} = await setup();
  await call('/quick-entry/vehicle', {text: 'A'}); assert.deepEqual(await usage('B'), []);
  assert.deepEqual((await call('/quick-entry/status', undefined, 'B')).data, {configured: true, vision: true});
  await call('/quick-entry/lead', {text: 'B'}, 'B');
  assert.equal((await usage('B')).length, 1); assert.equal((await usage('B'))[0].actorId, 'userB'); assert.equal((await usage()).length, 1);
  assert.equal((await call('/quick-entry/vehicle', {text: 'B', tenantId: 'A'}, 'B')).status, 400);
  assert.equal((await handler({path: '/quick-entry/vehicle', method: 'POST', body: '{"text":"x"}'})).statusCode, 401);
  await assert.rejects(repositories.forTenant('B').appendUsage((await usage())[0]), /scope/);
  const copy = await usage(); copy[0].actorId = 'changed'; assert.equal((await usage())[0].actorId, 'userA');
  await empty();
});
test('provider failures return 502, preserve metering and leave business records empty', async () => {
  const fake = new FakeProvider(); fake.extractVehicle = fake.extractLead = fake.extractVehiclePhoto = async () => { throw new Error('private provider failure'); };
  const {call, usage, empty} = await setup(fake);
  for (const kind of ['vehicle', 'lead', 'vehicle-photo']) {
    const r = await call(`/quick-entry/${kind}`, kind === 'vehicle-photo' ? photo : {text: 'test'});
    assert.equal(r.status, 502); assert.equal(r.error.code, 'AI_PROVIDER_FAILED'); assert.doesNotMatch(r.error.message, /private/);
  }
  assert.equal((await usage()).length, 3); await empty();
});
test('sanitizers keep only valid extracted facts, preserve notes, and never extract consent', () => {
  for (const [raw, expected] of [[18500, 1850000], ['18,500', 1850000], ['$24,995', 2499500], ['$ 0.29', 29], ['19.99', 1999], [0, 0]] as const) assert.equal(dollarCents(raw), expected);
  for (const raw of [-1, '1,23', '1e4', '2.345', 100000001, {}, null, 'garbage']) assert.equal(dollarCents(raw), undefined);
  assert.deepEqual(sanitizeVehicle({}, now), {}); assert.deepEqual(sanitizeLead({}), {});
  assert.deepEqual(sanitizeVehicle({year: 3000, cost: -1, vin: 'invalid', unknown: 'value'}, now), {});
  assert.deepEqual(sanitizeVehicle({year: '2019', mileage: '88k', notes: 'Clean'}, now), {year: 2019, notes: 'Clean', mileage: 88000});
  assert.deepEqual(sanitizeVehicle({mileage: '88,000 miles'}, now), {mileage: 88000});
  assert.deepEqual(sanitizeVehicle({mileage: '-1', year: null}, now), {});
  assert.deepEqual(sanitizeLead({customer: {phone: 'garbage1234567', email: 'bad', consent: {status: 'granted'}}, source: 'invalid'}), {});
  const lead = sanitizeLead({...rawLead, source: 'website', sourceDetail: 'site', customer: {...rawLead.customer, email: 'A@EXAMPLE.TEST', notes: 'Call tomorrow'}});
  assert.equal(lead.source, 'website'); assert.equal(lead.customer?.email, 'a@example.test'); assert.equal(lead.customer?.notes, 'Call tomorrow\nTrade: 2016 Civic');
  assert.equal(lead.customer?.consent.status, 'unknown');
});
test('photo-only body allowance is bounded; invalid input never reaches provider or meter', async () => {
  const fake = new FakeProvider(); const {call, usage} = await setup(fake);
  assert.equal(bodyLimit('POST', '/quick-entry/vehicle-photo/'), PHOTO_BODY_LIMIT);
  for (const path of ['/vehicles', '/quick-entry/vehicle', '/quick-entry/lead', '/quick-entry/vehicle-photo/extra']) assert.equal(bodyLimit('POST', path), 65536);
  assert.equal(bodyLimit('GET', '/quick-entry/vehicle-photo'), 65536);
  const large = Buffer.alloc(60000).toString('base64');
  assert.equal((await call('/quick-entry/vehicle-photo', {...photo, dataBase64: large})).status, 200);
  for (const body of [{...photo, mediaType: 'text/plain'}, {...photo, dataBase64: 'bad!'}, {...photo, dataBase64: 'A'.repeat(PHOTO_BASE64_LIMIT + 4)}]) assert.equal((await call('/quick-entry/vehicle-photo', body)).status, 400);
  for (const text of ['', 'x'.repeat(2001), 'x'.repeat(70000)]) assert.equal((await call('/quick-entry/vehicle', {text})).status, 400);
  assert.equal(fake.calls, 1); assert.equal((await usage()).length, 1);
});
test('normal create endpoints still validate and save only the reviewed draft', async () => {
  const {call} = await setup(); const draft = (await call('/quick-entry/vehicle', {text: 'stock'})).data.draft;
  assert.equal((await call('/vehicles', draft)).status, 400);
  const saved = await call('/vehicles', {...draft, notes: '', stockNumber: 'S1', vin: '1HGCM82633A004352', status: 'available', dateStocked: '2026-10-20', reconCosts: [], location: '', listPrice: 2500000});
  assert.equal(saved.status, 201); assert.equal(saved.data.listPrice, 2500000); assert.equal(saved.data.mileage, 88000); assert.equal((await call('/vehicles')).data.length, 1);
  const lead = (await call('/quick-entry/lead', {text: 'lead'})).data.draft;
  assert.equal((await call('/leads', {...lead, source: 'walk-in', customer: {address: '', email: '', ...lead.customer}})).status, 201);
});
test('HTTP adapter uses configured endpoint/model and parses JSON without network', async () => {
  const calls: RequestInit[] = [];
  const request: typeof fetch = async (url, init) => { assert.equal(url, 'https://provider.invalid/chat'); calls.push(init!); return new Response(JSON.stringify({choices: [{message: {content: '```json\n{"cost":18500}\n```'}}]})); };
  const provider = new HttpQuickEntryProvider('https://provider.invalid/chat', 'test-key', 'test-model', true, request);
  assert.deepEqual(await provider.extractVehicle('test'), {cost: 18500}); await provider.extractLead('test'); await provider.extractVehiclePhoto(photo);
  const body = JSON.parse(String(calls[0].body)); assert.equal(body.model, 'test-model'); assert.equal(body.messages[1].content, 'test'); assert.ok(calls[0].signal);
  assert.equal(JSON.parse(String(calls[2].body)).messages[1].content[1].image_url.url, `data:image/png;base64,${photo.dataBase64}`);
  for (const response of [new Response('error', {status: 500}), new Response('{"choices":[]}'), new Response(JSON.stringify({choices: [{message: {content: '[]'}}]}))]) {
    const p = new HttpQuickEntryProvider('endpoint', 'key', 'model', false, async () => response);
    await assert.rejects(p.extractVehicle('test'), {code: 'AI_PROVIDER_FAILED'});
    await assert.rejects(p.extractVehiclePhoto(photo), {code: 'AI_VISION_UNSUPPORTED'});
  }
  const p = new HttpQuickEntryProvider('endpoint', 'key', 'model', false, async () => { throw new Error('timeout'); });
  await assert.rejects(p.extractLead('test'), {code: 'AI_PROVIDER_FAILED'});
  for (const env of [{}, {FREEDMS_AI_ENDPOINT: 'url'}, {FREEDMS_AI_API_KEY: 'key'}, {FREEDMS_AI_ENDPOINT: 'url', FREEDMS_AI_API_KEY: 'key'}]) assert.equal(providerFromEnv(env).configured, false);
  assert.equal(providerFromEnv({FREEDMS_AI_ENDPOINT: 'url', FREEDMS_AI_API_KEY: 'key', FREEDMS_AI_MODEL: 'model', FREEDMS_AI_VISION: '1'}).supportsVision, true);
});
test('Dynamo usage uses scoped keys, conditional appends and paginated inspection', async () => {
  let writes = 0, pages = 0;
  const usage = {id: 'usage', tenantId: 'A', actorId: 'userA', kind: 'vehicle-text' as const, occurredAt: now.toISOString()};
  const client = {send: async (command: TransactWriteCommand | QueryCommand) => {
    if (command instanceof TransactWriteCommand) {
      writes++; assert.equal(command.input.TransactItems?.length, 1);
      const put = command.input.TransactItems![0].Put!; assert.equal(put.Item?.PK, 'TENANT#A'); assert.equal(put.Item?.SK, 'USAGE#usage'); assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)'); return {};
    }
    assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A'); assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'USAGE#'); pages++;
    return pages === 1 ? {Items: [{data: usage}], LastEvaluatedKey: {PK: 'TENANT#A', SK: 'USAGE#usage'}} : {Items: []};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A'); await repo.appendUsage(usage);
  await assert.rejects(repo.appendUsage({...usage, tenantId: 'B'}), /scope/); assert.equal(writes, 1);
  assert.deepEqual(await repo.usageForTest(), [usage]); assert.equal(pages, 2);
});
