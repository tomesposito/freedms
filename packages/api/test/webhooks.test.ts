import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { webhookEventTypes, type OutboxEvent, type WebhookDelivery, type WebhookEndpoint } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { drainWebhooks, dispatchWebhooks, fetchWebhookSender, hostedWebhookSender, MAX_DELIVERIES_PER_PASS, scheduleWebhookDispatch, type WebhookSender } from '../src/webhooks.js';
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
async function setup(sender: WebhookSender | undefined = async () => ({status: 204}), hosted = false) {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B', 'staff']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: date}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: tenantId === 'staff' ? 'staff' : 'admin', active: true}, event(tenantId, 'provision', 'tenant.created', tenantId));
  const handler = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, sender, {hosted});
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
  assert.equal((await add()).status, 201); await waitFor(async () => (await call('/webhooks/deliveries')).data[0]?.status === 'delivered'); assert.equal(requests.length, 1); assert.equal(requests[0].url, '/A');
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
  assert.deepEqual(first.map(item => item.Put?.Item?.SK), ['WEBHOOK#hook', 'EVENT#create', 'A#hook']);
  assert.ok(first.slice(0, 2).every(item => item.Put?.Item?.PK === 'TENANT#A' && item.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  const update = (commands[1] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(update.ConditionExpression, '#d.#v = :v'); assert.deepEqual(update.ExpressionAttributeValues, {':v': 1});
  const upsert = (commands[2] as TransactWriteCommand).input.TransactItems!; assert.equal(upsert.length, 2);
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
    assert.equal((await call('/webhooks/deliveries')).data[0].status, 'pending');
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
  const passes = [dispatchWebhooks({...repo, webhookDispatchScope: undefined}, sender, now), dispatchWebhooks({...repositories.forTenant('A'), webhookDispatchScope: undefined}, sender, now)];
  scheduleWebhookDispatch(repo, sender, now);
  scheduleWebhookDispatch(repositories.forTenant('A'), sender, now);
  try { await waitFor(async () => ids.length === 1); }
  finally { release.resolve(); }
  await Promise.all(passes);
  await waitFor(async () => (await repo.webhookDeliveries()).length === 1);
  await dispatchWebhooks(repo, sender, now);
  assert.equal(ids.length, 1); assert.equal(new Set(ids).size, 1);
  assert.equal((await repo.webhookDeliveries())[0].id, ids[0]);
});

test('scheduling during an empty final pass requests another pass; drain errors are contained', async () => {
  const {repositories, add, endpoint} = await setup();
  await add(); await endpoint();
  const repo = repositories.forTenant('A'); const read = deferred(); const release = deferred();
  let first = true;
  const wrapper = {...repo, webhookDispatchCandidates: async (...args: Parameters<typeof repo.webhookDispatchCandidates>) => {
    if (first) { first = false; read.resolve(); await release.promise; return []; }
    return repo.webhookDispatchCandidates(...args);
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

const blockedHostedUrls = [
  'http://127.0.0.1/hook', 'https://127.0.0.1/hook', 'https://localhost/hook',
  'https://foo.localhost/hook', 'https://LOCALHOST./hook', 'https://foo.localhost./hook',
  'https://10.0.0.5/hook', 'https://172.16.0.9/hook', 'https://192.168.1.1/hook',
  'https://169.254.169.254/latest', 'https://[::1]/hook', 'https://[fe80::1]/hook',
  'https://[fc00::1]/hook', 'https://0.0.0.0/hook', 'https://100.64.0.1/hook',
  'https://192.0.0.1/hook', 'https://192.0.2.1/hook', 'https://198.51.100.1/hook',
  'https://203.0.113.1/hook', 'https://198.18.0.1/hook', 'https://198.19.255.255/hook',
  'https://240.0.0.1/hook', 'https://224.0.0.1/hook', 'https://192.88.99.1/hook',
  'https://[::]/hook', 'https://[ff02::1]/hook', 'https://[2001:db8::1]/hook',
  'https://[::ffff:127.0.0.1]/hook', 'https://[::ffff:192.168.1.1]/hook',
  'https://0x7f.0.0.1/hook', 'https://2130706433/hook', 'https://0177.0.0.1/hook',
  'http://example.invalid/hook', 'https://user:pass@example.invalid/hook', 'ftp://example.invalid/hook', 'bad URL'
];
test('hosted create and update reject non-public destinations after URL normalization', async () => {
  const {call, endpoint} = await setup(undefined, true);
  const record = (await endpoint('A', 'https://example.invalid/hook')).data;
  assert.ok(record.id);
  for (const url of blockedHostedUrls) {
    assert.equal((await endpoint('A', url)).status, 400, url);
    assert.equal((await call(`/webhooks/endpoints/${record.id}`, 'PUT', {version: 1, url})).status, 400, url);
  }
  for (const url of ['https://8.8.8.8/hook', 'https://[2606:4700:4700::1111]/hook', 'https://[::ffff:8.8.8.8]/hook']) assert.equal((await endpoint('A', url)).status, 201, url);
  for (const host of ['0x7f.0.0.1', '2130706433', '0177.0.0.1']) assert.equal(new URL(`https://${host}`).hostname, '127.0.0.1');
});

function fakeHttps(status: number, inspect: (url: URL, options: import('node:https').RequestOptions, body: string) => void): typeof httpsRequest {
  return ((url: URL, options: import('node:https').RequestOptions, callback: (res: unknown) => void) => {
    const req = new EventEmitter();
    return Object.assign(req, {end: (body: string) => {
      inspect(url, options, body);
      queueMicrotask(() => callback({statusCode: status, destroy() {}}));
    }});
  }) as typeof httpsRequest;
}

test('hosted resolution rejects any non-public answer and sanitizes recorded failures offline', async () => {
  for (const answers of [
    [{address: '10.0.0.5', family: 4}], [{address: '::1', family: 6}],
    [{address: '8.8.8.8', family: 4}, {address: '169.254.169.254', family: 4}],
    [{address: '::ffff:192.168.1.1', family: 6}], [], [{address: 'invalid', family: 4}]
  ]) {
    let connections = 0;
    const sender = hostedWebhookSender({resolve: async () => answers, request: fakeHttps(204, () => { connections++; })});
    const {endpoint, add, call} = await setup(sender, true);
    await endpoint('A', 'https://example.invalid/hook'); await add();
    await waitFor(async () => (await call('/webhooks/deliveries')).data.length === 1);
    const delivery = (await call('/webhooks/deliveries')).data[0];
    assert.equal(connections, 0); assert.equal(delivery.status, 'failed');
    assert.equal(delivery.lastError, 'Network or timeout failure'); assert.equal(delivery.lastStatusCode, null);
  }
});

test('hosted HTTPS pins the checked address with original TLS hostname and no second resolution', async () => {
  let resolutions = 0, connections = 0;
  const sender = hostedWebhookSender({
    resolve: async hostname => { assert.equal(hostname, 'example.invalid'); resolutions++; return [{address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4}]; },
    request: fakeHttps(204, (url, options, body) => {
      connections++;
      assert.equal(url.hostname, 'example.invalid'); assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, undefined); assert.equal(options.servername, undefined);
      assert.equal(options.method, 'POST'); assert.ok(options.signal); assert.ok(JSON.parse(body).id);
      // Exercise both Node lookup callback shapes; neither can re-resolve the name.
      const lookup = options.lookup!;
      lookup('example.invalid', {all: true}, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{address: '8.8.8.8', family: 4}]); });
      lookup('example.invalid', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    })
  });
  const {endpoint, add, call} = await setup(sender, true);
  await add(); await endpoint('A', 'https://example.invalid/hook');
  assert.deepEqual((await call('/webhooks/dispatch', 'POST')).data, {created: 1, delivered: 1, failed: 0});
  assert.equal(resolutions, 1); assert.equal(connections, 1);
});

test('hosted stored private endpoints never reach even an injected sender on automatic or manual dispatch', async () => {
  for (const manual of [false, true]) {
    let calls = 0;
    const {repositories, endpoint, add, call} = await setup(async () => { calls++; return {status: 204}; }, true);
    if (manual) await add();
    const record = (await endpoint('A', 'https://example.invalid/hook')).data;
    const repo = repositories.forTenant('A');
    await repo.saveWebhookEndpoint({...record, url: 'https://10.0.0.5/hook', version: 2}, 1, event('A', 'unsafe-update', 'webhook.updated', record.id, 2));
    if (manual) await call('/webhooks/dispatch', 'POST'); else await add();
    await waitFor(async () => (await repo.webhookDeliveries()).length === 1);
    assert.equal(calls, 0); assert.equal((await repo.webhookDeliveries())[0].lastError, 'Network or timeout failure');
  }
});

test('hosted rejects redirects, DNS failures and times out unresolved DNS without connecting', async () => {
  const init = {headers: {}, body: '{}'};
  const redirect = hostedWebhookSender({resolve: async () => [{address: '8.8.8.8', family: 4}], request: fakeHttps(302, () => {})});
  await assert.rejects(redirect('https://example.invalid', init));
  const dnsFailure = hostedWebhookSender({resolve: async () => { throw Error('private DNS detail'); }, request: fakeHttps(204, () => assert.fail('No connection'))});
  await assert.rejects(dnsFailure('https://example.invalid', init));
  let release!: (addresses: {address: string; family: number}[]) => void;
  const timeout = hostedWebhookSender({resolve: () => new Promise(resolve => { release = resolve; }), request: fakeHttps(204, () => assert.fail('No late connection'))});
  await assert.rejects(timeout('https://example.invalid', init), /timeout/);
  release([{address: '8.8.8.8', family: 4}]);
  await new Promise(resolve => setImmediate(resolve));
});


test('pending claims skip live owners and recover only after fifteen minutes with the same ID', async () => {
  const {repositories, add, endpoint} = await setup();
  await add(); await endpoint();
  const repo = repositories.forTenant('A');
  // A failed final write models an invocation dying after its durable claim.
  let id = '';
  await assert.rejects(dispatchWebhooks({...repo, saveWebhookDelivery: async () => { throw Error('invocation died'); }}, async (_url, init) => {
    id = init.headers['x-freedms-delivery']; return {status: 204};
  }, now), /invocation died/);
  assert.equal((await repo.webhookDeliveries())[0].status, 'pending');
  const sender: WebhookSender = async (_url, init) => { assert.equal(init.headers['x-freedms-delivery'], id); return {status: 204}; };
  assert.equal((await dispatchWebhooks(repo, () => { assert.fail('fresh claim must not send'); }, new Date(now.getTime() + 15 * 60_000))).created, 0);
  const later = new Date(now.getTime() + 15 * 60_000 + 1);
  const passes = await Promise.all([dispatchWebhooks(repo, sender, later), dispatchWebhooks(repositories.forTenant('A'), sender, later)]);
  assert.equal(passes.reduce((sum, pass) => sum + pass.created, 0), 1);
  assert.equal((await repo.webhookDeliveries())[0].status, 'delivered');
  await assert.rejects(repositories.forTenant('B').claimWebhookDelivery({... (await repo.webhookDeliveries())[0], status: 'pending'}), /scope/);
});

test('scheduled drain shares a bounded budget across tenants and resumes on the next run', async () => {
  const {repositories, add, endpoint} = await setup();
  for (const tenant of ['A', 'B']) { await add(tenant); await add(tenant); await endpoint(tenant); }
  const sent: string[] = [];
  const sender: WebhookSender = async (_url, init) => { sent.push(JSON.parse(init.body).tenantId); return {status: 204}; };
  assert.deepEqual(await repositories.webhookTenantIds(), ['A', 'B']);
  assert.deepEqual(await drainWebhooks(repositories, sender, now, 3), {created: 3, delivered: 3, failed: 0});
  assert.deepEqual(sent, ['A', 'B', 'A']);
  assert.deepEqual(await drainWebhooks(repositories, sender, now, 3), {created: 1, delivered: 1, failed: 0});
  assert.deepEqual(sent, ['A', 'B', 'A', 'B']);
});

test('scheduled drain advances B on every run while A is continually replenished', async () => {
  const {repositories, add, endpoint} = await setup();
  for (let i = 0; i < 3; i++) await add('B');
  await endpoint('A'); await endpoint('B');
  const sent: string[] = [];
  const sender: WebhookSender = async (_url, init) => { sent.push(JSON.parse(init.body).tenantId); return {status: 204}; };
  const total = {created: 0, delivered: 0, failed: 0};
  for (let run = 0; run < 3; run++) {
    for (let i = 0; i < 3; i++) {
      const id = `replenished-${run}-${i}`;
      await repositories.forTenant('A').create({...input, status: 'available', id, tenantId: 'A', version: 1, createdAt: date, updatedAt: date}, event('A', id, 'vehicle.created'));
    }
    const pass = await drainWebhooks(repositories, sender, now, 3);
    assert.deepEqual(pass, {created: 3, delivered: 3, failed: 0});
    total.created += pass.created; total.delivered += pass.delivered; total.failed += pass.failed;
    const b = await repositories.forTenant('B').webhookDeliveries();
    assert.equal(b.length, run + 1, 'B progresses starting with the first drain');
    assert.ok(b.every(delivery => delivery.status === 'delivered'));
    assert.ok((await repositories.forTenant('A').webhookDispatchCandidates(await repositories.forTenant('A').webhookEndpoints(), now)).length > 0);
  }
  assert.deepEqual(total, {created: 9, delivered: 9, failed: 0});
  assert.equal(sent.filter(tenant => tenant === 'A').length, 6);
  assert.equal(sent.filter(tenant => tenant === 'B').length, 3);
});

test('scheduled drain allocates rounds fairly across three backlogged tenants', async () => {
  const {repositories, add, endpoint} = await setup();
  await repositories.forTenant('C').provision({id: 'C', name: 'C', createdAt: date}, {id: 'user', name: 'Test'}, {tenantId: 'C', userId: 'user', role: 'admin', active: true}, event('C', 'provision', 'tenant.created', 'C'));
  for (const tenant of ['A', 'B', 'C']) {
    for (let i = 0; i < 4; i++) await add(tenant);
    await endpoint(tenant);
  }
  const sent: string[] = [];
  assert.deepEqual(await drainWebhooks(repositories, async (_url, init) => {
    sent.push(JSON.parse(init.body).tenantId); return {status: 204};
  }, now, 5), {created: 5, delivered: 5, failed: 0});
  assert.deepEqual(sent, ['A', 'B', 'C', 'A', 'B']);
  const counts = ['A', 'B', 'C'].map(tenant => sent.filter(id => id === tenant).length);
  assert.ok(Math.min(...counts) >= 1);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test('scheduled drain stops after a full round of lost claims and skips empty tenants', {timeout: 2000}, async () => {
  const {repositories, add, endpoint} = await setup();
  await endpoint('A'); // Registered but empty; must not block B or consume budget.
  await add('B'); await endpoint('B');
  const original = repositories.forTenant.bind(repositories);
  let claims = 0;
  repositories.forTenant = tenant => ({...original(tenant), claimWebhookDelivery: async () => {
    assert.ok(++claims <= 2, 'must stop after a zero-progress round'); return false;
  }});
  assert.deepEqual(await drainWebhooks(repositories, async () => { assert.fail('lost claims must not send'); }, now, 3), {created: 0, delivered: 0, failed: 0});
  assert.equal(claims, 1);
  repositories.forTenant = original;
  assert.deepEqual(await drainWebhooks(repositories, async () => ({status: 204}), now, 3), {created: 1, delivered: 1, failed: 0});
});

test('hosted mutation awaits the inline attempt and preserves commits when delivery fails', async () => {
  const started = deferred(), release = deferred();
  const {endpoint, add, repositories} = await setup(async () => { started.resolve(); await release.promise; return {status: 204}; }, true);
  await endpoint('A', 'https://example.invalid/hook');
  let returned = false;
  const mutation = add().then(result => { returned = true; return result; });
  await started.promise;
  try { assert.equal(returned, false); assert.equal((await repositories.forTenant('A').webhookDeliveries())[0].status, 'pending'); }
  finally { release.resolve(); }
  assert.equal((await mutation).status, 201);
  assert.equal((await repositories.forTenant('A').webhookDeliveries())[0].status, 'delivered');
  let attempts = 0;
  const failing = await setup(async () => { attempts++; throw Error('receiver failed'); }, true);
  await failing.endpoint('A', 'https://example.invalid/hook');
  assert.equal((await failing.add()).status, 201);
  assert.equal(attempts, 3);
  assert.equal((await failing.repositories.forTenant('A').webhookDeliveries())[0].status, 'failed');
  const broken = failing.repositories.forTenant.bind(failing.repositories);
  failing.repositories.forTenant = tenant => ({...broken(tenant), claimWebhookDelivery: async () => { throw Error('storage unavailable'); }});
  assert.equal((await failing.add()).status, 201);
});

test('Dynamo claims condition creation and exact stale timestamps, and propagate storage failures', async () => {
  const commands: TransactWriteCommand[] = [];
  let failure: Error | undefined;
  const client = {send: async (command: TransactWriteCommand) => { commands.push(command); if (failure) throw failure; return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const record: WebhookDelivery = {id: 'delivery', tenantId: 'A', endpointId: 'hook', eventId: 'vehicle', eventType: 'vehicle.created', status: 'pending', attempts: 0, lastStatusCode: null, lastError: null, createdAt: date, updatedAt: date};
  assert.equal(await repo.claimWebhookDelivery(record), true);
  const put = commands[0].input.TransactItems![0].Put!;
  assert.equal(put.ConditionExpression, 'attribute_not_exists(PK)');
  assert.deepEqual([put.Item!.PK, put.Item!.SK], ['TENANT#A', 'DELIVERY#delivery']);
  const stale = new Date(now.getTime() - 15 * 60_000 - 1).toISOString();
  assert.equal(await repo.claimWebhookDelivery(record, stale), true);
  assert.equal(commands[1].input.TransactItems![0].Put!.ConditionExpression, '#d.#status = :pending AND #d.#updated = :updated');
  assert.deepEqual(commands[1].input.TransactItems![0].Put!.ExpressionAttributeValues, {':pending': 'pending', ':updated': stale});
  assert.equal(await repo.claimWebhookDelivery(record, date), false);
  failure = Object.assign(Error('lost race'), {name: 'TransactionCanceledException', CancellationReasons: [{Code: 'ConditionalCheckFailed'}]});
  assert.equal(await repo.claimWebhookDelivery(record), false);
  failure = Error('storage unavailable');
  await assert.rejects(repo.claimWebhookDelivery(record), /storage unavailable/);
});

test('Dynamo webhook tenant registry paginates without scanning after migration', async () => {
  const commands: QueryCommand[] = [];
  const cursor = {PK: 'OPERATOR#WEBHOOKS', SK: 'A#hook'};
  const client = {send: async (command: QueryCommand) => {
    assert.ok(command instanceof QueryCommand); commands.push(command);
    return commands.length === 1 ? {Items: [{SK: 'MIGRATED'}, {data: {tenantId: 'A'}}], LastEvaluatedKey: cursor}
      : {Items: [{data: {tenantId: 'A'}}, {data: {tenantId: 'B'}}]};
  }} as unknown as DynamoDBDocumentClient;
  assert.deepEqual(await new DynamoRepositories('table', client).webhookTenantIds(), ['A', 'B']);
  assert.deepEqual(commands[0].input.ExpressionAttributeValues, {':pk': 'OPERATOR#WEBHOOKS'});
  assert.deepEqual(commands[1].input.ExclusiveStartKey, cursor);
});

test('pre-registry endpoints backfill once, including paginated scans and empty migrations', async () => {
  for (const empty of [false, true]) {
    const registry = new Map<string, Record<string, unknown>>(); let scans = 0;
    const cursor = {PK: 'TENANT#A', SK: 'WEBHOOK#one'};
    const client = {send: async (command: QueryCommand | ScanCommand | TransactWriteCommand) => {
      if (command instanceof QueryCommand) return {Items: [...registry.values()]};
      if (command instanceof ScanCommand) {
        scans++;
        if (empty) return {Items: []};
        if (scans === 1) return {Items: [{data: {tenantId: 'A', id: 'one', version: 1}}], LastEvaluatedKey: cursor};
        assert.deepEqual(command.input.ExclusiveStartKey, cursor);
        return {Items: [{data: {tenantId: 'A', id: 'two', version: 1}}, {data: {tenantId: 'B', id: 'three', version: 2}}]};
      }
      for (const item of command.input.TransactItems ?? []) if (item.Put) registry.set(item.Put.Item!.SK, item.Put.Item!);
      return {};
    }} as unknown as DynamoDBDocumentClient;
    const repositories = new DynamoRepositories('table', client);
    assert.deepEqual(await repositories.webhookTenantIds(), empty ? [] : ['A', 'B']);
    const firstScans = scans;
    assert.deepEqual(await repositories.webhookTenantIds(), empty ? [] : ['A', 'B']);
    assert.equal(scans, firstScans); assert.equal(scans, empty ? 1 : 2);
    assert.ok([...registry.values()].every(item => !JSON.stringify(item).includes('secret')));
  }
});

test('hosted schedule routes through the API Lambda to the bounded drain without gateway auth', () => {
  const template = readFileSync('infra/template.yaml', 'utf8');
  const lambda = readFileSync('packages/api/src/lambda.ts', 'utf8');
  assert.match(template, /Handler: lambda\.handler/);
  assert.match(template, /WebhookDrain:\s+Type: Schedule\s+Properties:\s+Schedule: rate\(5 minutes\)/);
  assert.match(template, /Timeout: 60/);
  assert.match(template, /dynamodb:Scan/);
  assert.ok(lambda.indexOf("event.source === 'aws.events'") < lambda.indexOf('const handle = createHandler'));
  assert.match(lambda, /return webhookDrainHandler\(\)/);
  assert.match(lambda, /webhookDrainHandler = async \(\) => drainWebhooks\(repositories, hostedWebhookSender\(\), new Date\(\)\)/);
});

test('hosted agent write returns before webhook sender and leaves durable drainable delivery', {timeout: 2000}, async () => {
  const started = deferred(), release = deferred();
  let attempts = 0;
  const {endpoint, handler, repositories} = await setup(async () => {
    attempts++; started.resolve(); await release.promise; return {status: 204};
  }, true);
  await endpoint('A', 'https://example.invalid/hook');
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  const result = await handler({method: 'POST', path: '/vehicles', agent: true,
    claims: tokens.verify(tokens.issue('user', 'A')), body: JSON.stringify(input)});
  assert.equal(result.statusCode, 201);
  const repo = repositories.forTenant('A');
  assert.equal((await repo.events()).filter(event => event.type === 'vehicle.created').length, 1);
  assert.equal((await repositories.forTenant('B').webhookDeliveries()).length, 0);
  await started.promise;
  assert.equal(attempts, 1);
  assert.equal((await repo.webhookDeliveries())[0].status, 'pending');
  release.resolve();
  await waitFor(async () => (await repo.webhookDeliveries())[0]?.status === 'delivered');
  await dispatchWebhooks(repo, async () => { assert.fail('Durable delivery must not be repeated'); }, now);
  assert.equal((await repo.webhookDeliveries())[0].status, 'delivered');
});

test('dispatch transfers only pending pairs with hundreds of terminal and unrelated events', async () => {
  const {repositories, add, endpoint} = await setup(undefined);
  for (let i = 0; i < 320; i++) await add();
  await endpoint();
  const repo = repositories.forTenant('A');
  const original = (await repo.webhookEndpoints())[0];
  for (let i = 0; i < 320; i++) await repo.saveWebhookEndpoint({...original, version: i + 2}, i + 1, event('A', `config${i}`, 'webhook.updated', original.id, i + 2));
  // Drain historical pairs without triggering handler scheduling.
  while ((await dispatchWebhooks(repo, async () => ({status: 204}), now)).remaining) {}
  for (let i = 0; i < 4; i++) {
    const id = `pending${i}`;
    await repo.create({...input, status: 'available', id, tenantId: 'A', version: 1, createdAt: date, updatedAt: date}, event('A', id, 'vehicle.created'));
  }
  let events = 0, deliveries = 0;
  const counted = {...repo,
    events: async () => { assert.fail('full event history read'); },
    webhookDeliveries: async () => { assert.fail('full delivery history read'); },
    webhookDispatchCandidates: async (...args: Parameters<typeof repo.webhookDispatchCandidates>) => {
      const candidates = await repo.webhookDispatchCandidates(...args);
      events += candidates.length; deliveries += candidates.filter(pair => pair.previous).length;
      return candidates;
    }
  };
  assert.deepEqual(await dispatchWebhooks(counted, async () => ({status: 204}), now, {maxDeliveries: 2}), {created: 2, delivered: 2, failed: 0, remaining: 2});
  assert.equal(events, 4); assert.equal(deliveries, 0);
});

test('Dynamo candidate queries filter types and terminal pairs server-side and page only pending results', async () => {
  const queries: QueryCommand[] = []; let gets = 0;
  const client = {send: async (command: QueryCommand | GetCommand) => {
    if (command instanceof GetCommand) { gets++; return {}; }
    queries.push(command);
    assert.equal(command.input.Limit, 100);
    assert.match(command.input.FilterExpression!, /attribute_not_exists\(#done0\).*#d\.#type IN/);
    assert.equal(command.input.ExpressionAttributeNames!['#done0'], 'DONE#hook');
    assert.equal(command.input.ExpressionAttributeValues![':pk'], 'TENANT#A');
    assert.equal(command.input.ExpressionAttributeValues![':t0_0'], 'vehicle.created');
    if (queries.length === 1) return {Items: [], LastEvaluatedKey: {PK: 'TENANT#A', SK: 'EVENT#old'}};
    return {Items: [{data: event('A', 'pending', 'vehicle.created')}]};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const endpoint: WebhookEndpoint = {id: 'hook', tenantId: 'A', version: 1, createdAt: date, updatedAt: date, url: 'http://localhost', eventTypes: ['vehicle.created'], enabled: true, secret: 'secret'};
  assert.equal((await repo.webhookDispatchCandidates([endpoint], now)).length, 1);
  assert.equal(queries.length, 2); assert.equal(gets, 1);
});

test('registry stays enabled-only across multiple endpoints, disable, enable and secret rotation', async () => {
  const {repositories, endpoint, call} = await setup();
  const first = (await endpoint()).data, second = (await endpoint()).data;
  assert.deepEqual(await repositories.webhookTenantIds(), ['A']);
  await call(`/webhooks/endpoints/${first.id}`, 'PUT', {version: 1, enabled: false});
  assert.deepEqual(await repositories.webhookTenantIds(), ['A']);
  await call(`/webhooks/endpoints/${second.id}`, 'PUT', {version: 1, enabled: false});
  assert.deepEqual(await repositories.webhookTenantIds(), []);
  await call(`/webhooks/endpoints/${first.id}/rotate-secret`, 'POST', {version: 2});
  assert.deepEqual(await repositories.webhookTenantIds(), []);
  await call(`/webhooks/endpoints/${first.id}`, 'PUT', {version: 3, enabled: true});
  assert.deepEqual(await repositories.webhookTenantIds(), ['A']);
});

test('Dynamo endpoint registry changes share the endpoint and event transaction, without secrets', async () => {
  const commands: TransactWriteCommand[] = [];
  const client = {send: async (command: TransactWriteCommand) => { commands.push(command); return {}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  for (const [i, enabled] of [true, false, false, true].entries()) {
    const record: WebhookEndpoint = {id: 'hook', tenantId: 'A', version: i + 1, createdAt: date, updatedAt: date, url: 'http://localhost', eventTypes: ['vehicle.created'], enabled, secret: `secret${i}`};
    await repo.saveWebhookEndpoint(record, i, event('A', `config${i}`, i ? 'webhook.updated' : 'webhook.created', 'hook', i + 1));
    const items = commands[i].input.TransactItems!;
    assert.equal(items.length, 3);
    assert.equal(items[0].Put!.Item!.data.version, i + 1);
    assert.equal(items[1].Put!.Item!.SK, `EVENT#config${i}`);
    if (enabled) assert.deepEqual(items[2].Put!.Item, {PK: 'OPERATOR#WEBHOOKS', SK: 'A#hook', data: {tenantId: 'A', endpointId: 'hook'}});
    else assert.deepEqual(items[2].Delete!.Key, {PK: 'OPERATOR#WEBHOOKS', SK: 'A#hook'});
  }
});

test('legacy terminal pair point lookup backfills completion and is never transferred again', async () => {
  let done = false, gets = 0, transfers = 0;
  const client = {send: async (command: QueryCommand | GetCommand | TransactWriteCommand) => {
    if (command instanceof QueryCommand) {
      const items = done ? [] : [{data: event('A', 'old', 'vehicle.created')}]; transfers += items.length;
      return {Items: items};
    }
    if (command instanceof GetCommand) {
      gets++;
      return {Item: {data: {id: 'delivery', tenantId: 'A', endpointId: 'hook', eventId: 'old', status: 'delivered', updatedAt: date}}};
    }
    const update = command.input.TransactItems![0].Update!;
    assert.deepEqual(update.Key, {PK: 'TENANT#A', SK: 'EVENT#old'});
    assert.equal(update.ExpressionAttributeNames!['#done'], 'DONE#hook');
    done = true; return {};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const endpoint: WebhookEndpoint = {id: 'hook', tenantId: 'A', version: 1, createdAt: date, updatedAt: date, url: 'http://localhost', eventTypes: ['vehicle.created'], enabled: true, secret: 'secret'};
  assert.deepEqual(await repo.webhookDispatchCandidates([endpoint], now), []);
  assert.deepEqual(await repo.webhookDispatchCandidates([endpoint], now), []);
  assert.equal(gets, 1); assert.equal(transfers, 1);
});
