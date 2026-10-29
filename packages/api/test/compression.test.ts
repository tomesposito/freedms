import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { compressResponse } from '../src/compression.js';
import { createHandler, response, type ApiRequest } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { LocalTokens } from '../src/auth.js';
import { gatewayHandler } from '../src/gateway.js';

const large = response(200, {message: 'é'.repeat(1024)});
const decode = (body: string) => gunzipSync(Buffer.from(body, 'base64')).toString('utf8');

test('Compression requires an acceptable gzip coding', () => {
  for (const encoding of [undefined, '', 'br', 'xgzip', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=0, gzip', '*;q=0', 'gzip;q=invalid', 'gzip;q=1.1']) {
    assert.strictEqual(compressResponse(large, encoding), large, encoding);
  }
  for (const encoding of ['gzip', 'br, gzip;q=0.5', '  GZiP ; Q = 0.500  ', '*;q=0.5', 'gzip;q=0.5, *;q=0']) {
    const compressed = compressResponse(large, encoding);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.equal(compressed.isBase64Encoded, true);
    assert.equal(decode(compressed.body), large.body);
  }
  assert.equal(large.headers['content-encoding'], undefined);
});

test('Compression respects byte threshold, content type, existing encoding and bodyless statuses', () => {
  for (const original of [
    {...large, body: 'x'.repeat(1023)},
    {...large, headers: {'content-type': 'text/html'}},
    {...large, headers: {...large.headers, 'Content-Encoding': 'br'}},
    {...large, statusCode: 204}, {...large, statusCode: 304},
  ]) assert.strictEqual(compressResponse(original, 'gzip'), original);
  for (const contentType of ['application/json; charset=utf-8', 'text/csv; charset=utf-8']) {
    const original = {...large, body: 'é'.repeat(512), headers: {'Content-Type': contentType, 'Content-Length': '1024'}};
    const compressed = compressResponse(original, 'gzip');
    assert.equal(decode(compressed.body), original.body);
    assert.equal(compressed.headers['Content-Length'], undefined);
  }
});

test('Repeated large bodies reuse identical memoized output and survive entry eviction', () => {
  const first = compressResponse(large, 'gzip'), second = compressResponse(large, 'gzip');
  assert.equal(first.body, second.body);
  assert.equal(decode(first.body), large.body);
  assert.equal(decode(second.body), large.body);
  for (let i = 0; i < 10; i++) {
    const original = response(200, {i, message: 'x'.repeat(1024)});
    assert.equal(decode(compressResponse(original, 'gzip').body), original.body);
  }
  assert.equal(decode(compressResponse(large, 'gzip').body), large.body);
});

test('Service board through createHandler preserves the complete payload under gzip', async () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('compression-test-secret-at-least-32-characters', () => now.getTime());
  await repositories.forTenant('A').provision(
    {id: 'A', name: 'A', createdAt: now.toISOString()}, {id: 'userA', name: 'A'},
    {tenantId: 'A', userId: 'userA', role: 'staff', active: true},
    {id: 'provision', tenantId: 'A', actorId: 'userA', aggregateId: 'A', aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'},
  );
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const claims = tokens.verify(tokens.issue('userA', 'A'));
  const call = (request: Omit<ApiRequest, 'claims'>) => handler({...request, claims});
  const lead = await call({method: 'POST', path: '/leads', body: JSON.stringify({customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in'})});
  assert.equal(lead.statusCode, 201);
  const customerId = JSON.parse(lead.body).data.lead.customerId;
  for (let i = 0; i < 4; i++) {
    const created = await call({method: 'POST', path: '/service/repair-orders', body: JSON.stringify({customerId, vehicleId: null, vehicleDescription: 'Customer vehicle', advisorId: 'userA', payType: 'customer-pay', lineItems: []})});
    assert.equal(created.statusCode, 201);
  }
  const identity = await call({method: 'GET', path: '/service/board'});
  const compressed = await call({method: 'GET', path: '/service/board', acceptEncoding: 'gzip'});
  assert.equal(identity.statusCode, 200);
  assert.equal(compressed.statusCode, 200);
  assert.ok(Buffer.byteLength(identity.body) >= 1024);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.isBase64Encoded, true);
  assert.equal(decode(compressed.body), identity.body);
  assert.deepEqual(JSON.parse(decode(compressed.body)), JSON.parse(identity.body));
});

test('Gateway forwards case-insensitive Accept-Encoding and preserves binary response metadata', async () => {
  const gateway = gatewayHandler(async request => compressResponse(large, request.acceptEncoding), 'issuer', 'audience');
  const result = await gateway({rawPath: '/share/token', headers: {'AcCePt-EnCoDiNg': 'gzip'}, requestContext: {http: {method: 'GET'}}});
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, true);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(decode(result.body), large.body);
});
