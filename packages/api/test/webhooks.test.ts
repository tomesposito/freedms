import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { webhookEventTypes, type OutboxEvent, type WebhookDelivery, type WebhookEndpoint } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { dispatchWebhooks, fetchWebhookSender, MAX_DELIVERIES_PER_PASS, scheduleWebhookDispatch, type WebhookSender } from '../src/webhooks.js';
const now = new Date('2026-10-22T12:00:00Z');
const date = now.toISOString();
const input = {mileage: null, stockNumber: 'S2', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1234567, cost: 990000, reconCosts: [], notes: 'Private note', dateStocked: '2026-10-01', location: 'Lot'};
const event = (tenantId: string, id: string, type: OutboxEvent['type'], aggregateId = id, aggregateVersion = 1): OutboxEvent => ({id, tenantId, actorId: 'user', aggregateId, aggregateVersion, type, occurredAt: date, deliveryStatus: 'pending'});
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'background delivery deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
async function setup(sender: WebhookSender = async () => ({status: 204})) {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B', 'staff']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: date}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: tenantId === 'staff' ? 'staff' : 'admin', active: true}, event(tenantId, 'provision', 'tenant.created', tenantId));
  const handler = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, sender);
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  const call = async (path: string, method = 'GET', body: unknown = {}, tenant = 'A') => {
    const result = await handler({path, method, body: JSON.stringify(body), claims: tokens.verify(tokens.issue('user', tenant))});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const endpoint = async (tenant = 'A', url = 'http://127.0.0.1:1234/hook') => call('/webhooks/endpoints', 'POST', {url, eventTypes: ['vehicle.created']}, tenant);
  const add = async (tenant = 'A') => call('/vehicles', 'POST', input, tenant);
  return {repositories, handler, call, endpoint, add};
}
test('webhook endpoint secrets are revealed once, mutations are admin-only and versioned', async () => {
  const {call, endpoint, repositories} = await setup();
  const created = await endpoint(); assert.equal(created.status, 201); const record = created.data;
  assert.match(record.secret, /^[a-f0-9]{64}$/);
  const listed = await call('/webhooks/endpoints'); assert.ok(!JSON.stringify(listed).includes('secret')); assert.deepEqual(listed.data.eventTypes, webhookEventTypes);
  const updated = await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, url: 'https://example.invalid/hook', eventTypes: ['lead.created'], enabled: false});
  assert.equal(updated.status, 200); assert.equal(updated.data.version, 2); assert.ok(!JSON.stringify(updated).includes('secret'));
  assert.equal((await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, enabled: true})).status, 409);
  const rotated = await call(`/webhooks/endpoints/${record.id}/rotate-secret`, 'POST', {version: 2});
  assert.equal(rotated.status, 200); assert.notEqual(rotated.data.secret, record.secret);
  for (const [path, method, body] of [
    ['/webhooks/endpoints', 'POST', {url: 'http://localhost', eventTypes: ['vehicle.created']}],
    [`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, enabled: false}],
    [`/webhooks/endpoints/${record.id}/rotate-secret`, 'POST', {version: 1}], ['/webhooks/dispatch', 'POST', {}]
  ] as const) assert.equal((await call(path, method, body, 'staff')).status, 403);
  assert.equal((await call('/webhooks/endpoints', 'GET', {}, 'staff')).status, 200);
  assert.equal((await call('/webhooks/deliveries', 'GET', {}, 'staff')).status, 200);
  const events = (await repositories.forTenant('A').events()).filter(e => e.type.startsWith('webhook.'));
  assert.deepEqual(events.map(e => [e.type, e.aggregateVersion]), [['webhook.created', 1], ['webhook.updated', 2], ['webhook.updated', 3]]);
  assert.deepEqual(Object.keys(events[0]).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort());
});
test('real loopback HTTP delivery verifies raw signature, metadata, tenant isolation and dedupe', async t => {
  const requests: {url: string; body: string; headers: import('node:http').IncomingHttpHeaders}[] = [];
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push({url: req.url!, body, headers: req.headers}); res.writeHead(204); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const {call, endpoint, add} = await setup(fetchWebhookSender);
  const a = (await endpoint('A', `${base}/A`)).data; await endpoint('B', `${base}/B`);
  assert.equal((await add()).status, 201); await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 1); assert.equal(requests.length, 1); assert.equal(requests[0].url, '/A');
  const received = requests[0];
  assert.equal(received.headers['x-freedms-signature'], `sha256=${createHmac('sha256', a.secret).update(received.body).digest('hex')}`);
  assert.equal(received.headers['content-type'], 'application/json'); assert.equal(received.headers['x-freedms-event'], 'vehicle.created');
  const payload = JSON.parse(received.body); assert.equal(payload.tenantId, 'A');
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'type', 'tenantId', 'aggregateId', 'aggregateVersion', 'occurredAt', 'actorId'].sort());
  const log = (await call('/webhooks/deliveries')).data;
  assert.equal(log.length, 1); assert.equal(log[0].status, 'delivered'); assert.equal(log[0].attempts, 1); assert.equal(log[0].id, received.headers['x-freedms-delivery']);
  assert.ok(!JSON.stringify(log).includes(a.secret));
  assert.deepEqual((await call('/webhooks/deliveries', 'GET', {}, 'B')).data, []);
  assert.equal((await call(`/webhooks/endpoints/${a.id}`, 'PUT', {version: 1, enabled: false}, 'B')).status, 404);
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 0, delivered: 0, failed: 0}); assert.equal(requests.length, 1);
});
test('failed deliveries retry only three times, sanitize exceptions and remain terminal', async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const {call, endpoint, add, repositories} = await setup(async () => { calls++; if (throws) throw Error('secret response payload'); return {status: 500}; });
    await endpoint(); assert.equal((await add()).status, 201); await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 1); assert.equal(calls, 3);
    const log = (await call('/webhooks/deliveries')).data;
    assert.equal(log.length, 1); assert.equal(log[0].attempts, 3); assert.equal(log[0].status, 'failed');
    assert.equal(log[0].lastStatusCode, throws ? null : 500); assert.equal(log[0].lastError, throws ? 'Network or timeout failure' : 'HTTP failure');
    assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 0, delivered: 0, failed: 0}); assert.equal(calls, 3);
    assert.equal((await repositories.forTenant('A').events()).filter(e => e.type.startsWith('webhook.')).length, 1);
  }
});
test('disable and re-enable delivery, rotate secret and use the new signature', async () => {
  const requests: Parameters<WebhookSender>[1][] = [];
  const {call, endpoint, add} = await setup(async (_url, init) => { requests.push(init); return {status: 200}; });
  const record = (await endpoint()).data;
  await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, enabled: false}); await add(); assert.equal(requests.length, 0);
  await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 2, enabled: true}); assert.equal(requests.length, 0);
  const rotated = (await call(`/webhooks/endpoints/${record.id}/rotate-secret`, 'POST', {version: 3})).data;
  await add(); await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 2); assert.equal(requests.length, 2); // Both previously pending and subsequent subscribed events.
  for (const req of requests) {
    assert.equal(req.headers['x-freedms-signature'], `sha256=${createHmac('sha256', rotated.secret).update(req.body).digest('hex')}`);
    assert.notEqual(req.headers['x-freedms-signature'], `sha256=${createHmac('sha256', record.secret).update(req.body).digest('hex')}`);
  }
  assert.ok(!JSON.stringify(await call('/webhooks/endpoints')).includes(rotated.secret));
});
test('webhook validation rejects invalid URLs, subscriptions, bodies, methods and anonymous access', async () => {
  const {call, endpoint, handler} = await setup();
  const valid = {url: 'https://example.invalid/hook', eventTypes: ['vehicle.created']};
  for (const url of ['', 'not a URL', 'ftp://localhost/hook', 'http://example.invalid', 'https://user:pass@example.invalid', 'http://localhost.evil.invalid']) assert.equal((await call('/webhooks/endpoints', 'POST', {...valid, url})).status, 400);
  for (const eventTypes of [[], ['unknown'], ['webhook.created'], ['webhook.updated'], ['vehicle.created', 'vehicle.created'], 'vehicle.created']) assert.equal((await call('/webhooks/endpoints', 'POST', {...valid, eventTypes})).status, 400);
  for (const body of [{...valid, secret: 'bad'}, {...valid, tenantId: 'B'}, {...valid, url: 'x'.repeat(4096)}]) assert.equal((await call('/webhooks/endpoints', 'POST', body)).status, 400);
  for (const url of ['http://localhost/hook', 'http://127.0.0.1/hook', 'http://[::1]/hook', 'https://example.invalid/hook']) assert.equal((await call('/webhooks/endpoints', 'POST', {...valid, url})).status, 201);
  const record = (await endpoint()).data;
  for (const changes of [{enabled: 'yes'}, {eventTypes: []}, {url: 'http://example.invalid'}, {secret: 'bad'}]) assert.equal((await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, ...changes})).status, 400);
  for (const path of ['/webhooks/endpoints', '/webhooks/deliveries', '/webhooks/dispatch', `/webhooks/endpoints/${record.id}`, `/webhooks/endpoints/${record.id}/rotate-secret`]) {
    assert.equal((await call(path, 'DELETE')).status, 405);
    assert.equal((await handler({path, method: 'GET'})).statusCode, 401);
  }
  assert.equal((await call('/webhooks/unknown')).status, 404);
});
test('manual dispatch summary, no config self-trigger, no GET dispatch and best-effort failure isolation', async () => {
  let calls = 0; const {repositories, call, endpoint, add} = await setup(async () => { calls++; return {status: calls === 1 ? 503 : 200}; });
  await add(); await endpoint(); assert.equal(calls, 0);
  await call('/vehicles'); await call('/webhooks/endpoints'); assert.equal(calls, 0);
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 1, delivered: 1, failed: 0}); assert.equal(calls, 2);
  assert.equal((await call('/webhooks/deliveries')).data[0].attempts, 2);
  const repo = repositories.forTenant('A');
  await dispatchWebhooks({...repo, webhookEndpoints: async () => [], events: async () => { throw Error('Should not load events'); }}, async () => { throw Error('No send'); }, now);
  const broken = {forTenant: (id: string) => ({...repositories.forTenant(id), webhookEndpoints: async () => { throw Error('Unavailable'); }})};
  const handler = createHandler(broken, {decode: async () => { throw Error(); }}, () => now);
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  assert.equal((await handler({method: 'POST', path: '/vehicles', body: JSON.stringify(input), claims: tokens.verify(tokens.issue('user', 'A'))})).statusCode, 201);
});
test('memory webhook repositories reject tenant and event misuse, conflict and clone data', async () => {
  const {repositories, endpoint, add} = await setup(); const record = (await endpoint()).data as WebhookEndpoint;
  const a = repositories.forTenant('A'), b = repositories.forTenant('B');
  const updated = {...record, version: 2}; const change = event('A', 'update', 'webhook.updated', record.id, 2);
  await assert.rejects(b.saveWebhookEndpoint(updated, 1, change), /scope/);
  await assert.rejects(a.saveWebhookEndpoint(updated, 1, {...change, tenantId: 'B'}), /scope/);
  await assert.rejects(a.saveWebhookEndpoint(updated, 1, {...change, aggregateId: 'wrong'}), /outbox/);
  await assert.rejects(a.saveWebhookEndpoint(updated, 1, {...change, type: 'webhook.created'}), /outbox/);
  await a.saveWebhookEndpoint(updated, 1, change);
  await assert.rejects(a.saveWebhookEndpoint(updated, 1, {...change, id: 'again'}), /changed/);
  await add(); await waitFor(async () => (await a.webhookDeliveries()).length === 1); const delivery = (await a.webhookDeliveries())[0];
  await assert.rejects(b.saveWebhookDelivery(delivery), /scope/);
  assert.deepEqual(await b.webhookEndpoints(), []); assert.deepEqual(await b.webhookDeliveries(), []); assert.equal(await b.webhookEndpoint(record.id), undefined);
  const copy = (await a.webhookEndpoints())[0]; copy.secret = 'altered'; assert.notEqual((await a.webhookEndpoint(record.id))!.secret, 'altered');
});
test('Dynamo webhook writes have tenant keys, conditional versions, paired events and delivery upserts', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: typeof commands[number]) => { commands.push(command); return {Items: []}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const record: WebhookEndpoint = {id: 'hook', tenantId: 'A', version: 1, createdAt: date, updatedAt: date, url: 'http://localhost', eventTypes: ['vehicle.created'], enabled: true, secret: 'local-secret'};
  const created = event('A', 'create', 'webhook.created', record.id);
  await repo.saveWebhookEndpoint(record, 0, created);
  await repo.saveWebhookEndpoint({...record, version: 2}, 1, event('A', 'update', 'webhook.updated', record.id, 2));
  const delivery: WebhookDelivery = {id: 'delivery', tenantId: 'A', endpointId: record.id, eventId: 'vehicle', eventType: 'vehicle.created', status: 'delivered', attempts: 1, lastStatusCode: 204, lastError: null, createdAt: date, updatedAt: date};
  await repo.saveWebhookDelivery(delivery); await repo.webhookEndpoint('hook'); await repo.webhookEndpoints(); await repo.webhookDeliveries();
  const first = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(first.map(item => item.Put?.Item?.SK), ['WEBHOOK#hook', 'EVENT#create']);
  assert.ok(first.every(item => item.Put?.Item?.PK === 'TENANT#A' && item.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  const update = (commands[1] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(update.ConditionExpression, '#d.#v = :v'); assert.deepEqual(update.ExpressionAttributeValues, {':v': 1});
  const upsert = (commands[2] as TransactWriteCommand).input.TransactItems!; assert.equal(upsert.length, 1);
  assert.equal(upsert[0].Put?.Item?.PK, 'TENANT#A'); assert.equal(upsert[0].Put?.Item?.SK, 'DELIVERY#delivery'); assert.equal(upsert[0].Put?.ConditionExpression, undefined);
  assert.deepEqual((commands[3] as GetCommand).input.Key, {PK: 'TENANT#A', SK: 'WEBHOOK#hook'});
  assert.deepEqual((commands[4] as QueryCommand).input.ExpressionAttributeValues, {':pk': 'TENANT#A', ':prefix': 'WEBHOOK#'});
  assert.deepEqual((commands[5] as QueryCommand).input.ExpressionAttributeValues, {':pk': 'TENANT#A', ':prefix': 'DELIVERY#'});
  await assert.rejects(repo.saveWebhookEndpoint({...record, tenantId: 'B'}, 0, created), /scope/);
  await assert.rejects(repo.saveWebhookEndpoint(record, 0, {...created, tenantId: 'B'}), /scope/);
  await assert.rejects(repo.saveWebhookDelivery({...delivery, tenantId: 'B'}), /scope/);
  await assert.rejects(repo.saveWebhookEndpoint(record, 1, {...created, type: 'webhook.updated'}), /version/);
  assert.equal(commands.length, 6);
});

test('authenticated ADF intake dispatches only its tenant events; invalid intake never sends', async () => {
  const requests: Parameters<WebhookSender>[1][] = [];
  const {call, handler} = await setup(async (_url, init) => { requests.push(init); return {status: 204}; });
  for (const tenant of ['A', 'B']) {
    assert.equal((await call('/webhooks/endpoints', 'POST', {url: 'http://localhost/hook', eventTypes: ['lead.created']}, tenant)).status, 201);
  }
  const token = (await call('/intake-token', 'POST')).data.token;
  const body = readFileSync(new URL('./fixtures/website.adf.xml', import.meta.url), 'utf8');
  assert.equal((await handler({method: 'POST', path: '/intake/adf', intakeToken: 'invalid', body})).statusCode, 401);
  assert.equal(requests.length, 0);
  assert.equal((await handler({method: 'POST', path: '/intake/adf', intakeToken: token, body})).statusCode, 201);
  await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 1);
  assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0].body).tenantId, 'A');
  assert.deepEqual((await call('/webhooks/deliveries', 'GET', {}, 'B')).data, []);
});
test('manual dispatch reports exhausted failures and later passes do not retry them', async () => {
  let attempts = 0;
  const {call, add, endpoint} = await setup(async () => { attempts++; return {status: 503}; });
  await add(); await endpoint(); assert.equal(attempts, 0);
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 1, delivered: 0, failed: 1});
  assert.equal(attempts, 3);
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 0, delivered: 0, failed: 0});
  assert.equal(attempts, 3);
});


test('mutations return before a blocked sender and active drains pick up later commits', async () => {
  const release = deferred(); const started = deferred();
  let sends = 0;
  const {add, endpoint, call} = await setup(async () => { sends++; started.resolve(); await release.promise; return {status: 204}; });
  await endpoint();
  try {
    let response: Awaited<ReturnType<typeof add>> | undefined;
    void add().then(result => { response = result; });
    await waitFor(async () => response !== undefined);
    assert.equal(response!.status, 201);
    await started.promise;
    assert.equal((await call('/webhooks/deliveries')).data.length, 0);
    assert.equal((await add()).status, 201);
    assert.equal(sends, 1, 'same tenant must have only one active drain');
  } finally { release.resolve(); }
  await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 2);
  assert.equal(sends, 2);
  assert.ok((await call('/webhooks/deliveries')).data.every((d: WebhookDelivery) => d.status === 'delivered'));
});

test('bounded passes order pending pairs and manual dispatch drains all remaining work', async () => {
  const sent: string[] = [];
  const sender: WebhookSender = async (_url, init) => { sent.push(JSON.parse(init.body).id); return {status: 204}; };
  const {repositories, add, endpoint, call} = await setup(sender);
  for (let i = 0; i < MAX_DELIVERIES_PER_PASS + 3; i++) await add();
  await endpoint();
  const repo = repositories.forTenant('A');
  const expected = (await repo.events()).filter(e => e.type === 'vehicle.created').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)).map(e => e.id);
  assert.deepEqual(await dispatchWebhooks(repo, sender, now), {created: MAX_DELIVERIES_PER_PASS, delivered: MAX_DELIVERIES_PER_PASS, failed: 0, remaining: 3});
  assert.deepEqual(sent, expected.slice(0, MAX_DELIVERIES_PER_PASS));
  // Add enough pairs that the manual call itself must loop over multiple passes.
  await endpoint();
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: MAX_DELIVERIES_PER_PASS + 6, delivered: MAX_DELIVERIES_PER_PASS + 6, failed: 0});
  assert.equal((await repo.webhookDeliveries()).length, 2 * expected.length);
});

test('overlapping passes and duplicate scheduling converge on a stable delivery identity', async () => {
  const release = deferred(); const ids: string[] = [];
  const sender: WebhookSender = async (_url, init) => { ids.push(init.headers['x-freedms-delivery']); await release.promise; return {status: 204}; };
  const {repositories, add, endpoint} = await setup(sender);
  await add(); await endpoint();
  const repo = repositories.forTenant('A');
  const passes = [dispatchWebhooks(repo, sender, now), dispatchWebhooks(repo, sender, now)];
  scheduleWebhookDispatch(repo, sender, now);
  scheduleWebhookDispatch(repositories.forTenant('A'), sender, now);
  try { await waitFor(async () => ids.length === 3); }
  finally { release.resolve(); }
  await Promise.all(passes);
  await waitFor(async () => (await repo.webhookDeliveries()).length === 1);
  await dispatchWebhooks(repo, sender, now);
  assert.equal(new Set(ids).size, 1);
  assert.equal((await repo.webhookDeliveries())[0].id, ids[0]);
});

test('scheduling during an empty final pass requests another pass; drain errors are contained', async () => {
  const {repositories, add, endpoint} = await setup();
  await add(); await endpoint();
  const repo = repositories.forTenant('A'); const read = deferred(); const release = deferred();
  let first = true;
  const wrapper = {...repo, events: async () => {
    if (first) { first = false; read.resolve(); await release.promise; return []; }
    return repo.events();
  }};
  scheduleWebhookDispatch(wrapper, async () => ({status: 204}), now);
  await read.promise;
  scheduleWebhookDispatch(wrapper, async () => ({status: 204}), now);
  release.resolve();
  await waitFor(async () => (await repo.webhookDeliveries()).length === 1);
  const logs: unknown[][] = []; const original = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    scheduleWebhookDispatch({...repo, webhookDispatchScope: undefined, webhookEndpoints: async () => { throw Error('secret URL and payload'); }}, async () => ({status: 204}), now);
    await waitFor(async () => logs.length === 1);
    assert.deepEqual(logs, [['Webhook dispatch failed', 'Error']]);
  } finally { console.error = original; }
});
