import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3DocumentStore } from '../src/s3-documents.js';
import { gatewayHandler, type GatewayEvent } from '../src/gateway.js';
import { createHandler, response } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { bootstrapPilot, invitePilot, CognitoPilotIdentity } from '../src/pilot-provision.js';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { seedDemo } from '../src/demo-seed.js';
import type { AuthClaims } from '@freedms/shared';
import { readFileSync } from 'node:fs';
import { vehiclePhotoPartKeys } from '../src/vehicle-photos.js';
const now = new Date();
const claims = (sub = 'admin', tenant = 'A'): AuthClaims => ({sub, 'custom:tenant_id': tenant,
  email: `${sub}@example.test`, email_verified: true, iss: 'issuer', aud: 'audience', exp: now.getTime() / 1000 + 3600, token_use: 'id'});
const event = (rawPath: string, method = 'GET', trusted?: AuthClaims): GatewayEvent => ({rawPath,
  requestContext: {http: {method}, ...(trusted ? {authorizer: {jwt: {claims: {...trusted}}}} : {})}});
test('S3 documents isolate prefixes and preserve bytes; only missing keys become absent', async () => {
  const rows = new Map<string, Uint8Array>(), commands: unknown[] = [];
  const client = {send: async (command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) => {
    commands.push(command);
    const key = command.input.Key!;
    if (command instanceof PutObjectCommand) { rows.set(key, command.input.Body as Uint8Array); return {}; }
    if (command instanceof DeleteObjectCommand) { rows.delete(key); return {}; }
    if (key.endsWith('/denied')) throw Object.assign(new Error(), {name: 'AccessDenied'});
    if (!rows.has(key)) throw Object.assign(new Error(), {name: 'NoSuchKey'});
    return {Body: {transformToByteArray: async () => rows.get(key)}};
  }} as unknown as S3Client;
  const store = new S3DocumentStore('private-documents', client), a = store.forTenant('A'), b = store.forTenant('B');
  await a.put('file', Uint8Array.from([0, 255, 34]));
  assert.deepEqual(await a.get('file'), Uint8Array.from([0, 255, 34])); assert.equal(await b.get('file'), undefined);
  await b.put('file', Uint8Array.from([17])); await a.remove('file');
  assert.equal(await a.get('file'), undefined); assert.deepEqual(await b.get('file'), Uint8Array.from([17]));
  assert.throws(() => store.forTenant('../B')); await assert.rejects(a.get('../B/file'));
  await assert.rejects(a.get('denied'), {name: 'AccessDenied'});
  assert.equal((commands[0] as PutObjectCommand).input.ServerSideEncryption, 'AES256');
});
test('gateway permits only narrow token routes and never trusts a caller JWT header', async () => {
  const gateway = gatewayHandler(async request => response(200, request), 'issuer', 'audience');
  for (const [path, method] of [['/share/token', 'GET'], ['/share/token/respond', 'POST'], ['/share/token/documents', 'POST'], ['/invite/token', 'GET'], ['/intake/adf', 'POST']])
    assert.equal((await gateway(event(path, method))).statusCode, 200);
  for (const [path, method] of [['/vehicles', 'GET'], ['/invite/token/accept', 'POST'], ['/share/token/anything', 'POST'], ['/share/token', 'DELETE'], ['/local/session', 'POST']]) {
    const request = event(path, method); request.headers = {Authorization: 'Bearer forged.jwt.value'};
    assert.equal((await gateway(request)).statusCode, 401);
  }
  assert.equal((await gateway(event('/session', 'GET', claims()))).statusCode, 200);
  const wrong = {...claims(), aud: 'other'};
  assert.equal((await gateway(event('/session', 'GET', wrong))).statusCode, 401);
  const protectedOrigin = gatewayHandler(async () => response(200, {}), 'issuer', 'audience', 'secret');
  assert.equal((await protectedOrigin(event('/share/token'))).statusCode, 403);
  assert.equal((await protectedOrigin({...event('/share/token'), headers: {'X-FreeDMS-Origin': 'secret'}})).statusCode, 200);
});
test('hosted public routes allow only inventory reads and dealer inquiries, with origin protection', async () => {
  const template = readFileSync('infra/template.yaml', 'utf8');
  const configured = [...template.matchAll(/Path: '(\/public\/[^']+)'\s+Method: (GET|POST)\s+Auth: \{Authorizer: NONE\}/g)]
    .map(([, path, method]) => `${method} ${path}`);
  const reads = ['inventory.json', 'inventory.html', 'llms.txt', 'facebook.csv', 'google.csv', 'carsforsale.csv', 'photos/{photoId}',
    'site', 'site/inventory', 'site/about', 'site/contact', 'site/vehicles/{vehicleId}'];
  const expected = [...reads.map(path => `GET /public/{tenantId}/${path}`),
    'POST /public/{tenantId}/site/contact', 'POST /public/{tenantId}/site/vehicles/{vehicleId}'];
  assert.deepEqual(configured.sort(), expected.sort());
  let handled = 0;
  const gateway = gatewayHandler(async () => { handled++; return response(200, {}); }, 'issuer', 'audience', 'origin');
  for (const route of expected) {
    const [method, pattern] = route.split(' '), path = pattern.replaceAll(/\{\w+\}/g, 'valid-id');
    assert.equal((await gateway(event(path, method))).statusCode, 403);
    assert.equal((await gateway({...event(path, method), headers: {'x-freedms-origin': 'origin'}})).statusCode, 200);
  }
  const before = handled;
  for (const [path, method] of [['/public/A/admin', 'GET'], ['/public/A/site/admin', 'GET'],
    ['/public/A/inventory.json', 'POST'], ['/public/A/site', 'POST'], ['/public/A/site/contact', 'DELETE'], ['/vehicles', 'GET']]) {
    assert.equal((await gateway({...event(path, method), headers: {'x-freedms-origin': 'origin'}})).statusCode, 401);
  }
  assert.equal(handled, before);
});
test('temporary photo parts expire separately from final photos and tenant documents', async () => {
  const objects = new Map<string, Uint8Array>();
  const client = {send: async (command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) => {
    const key = command.input.Key!;
    if (command instanceof PutObjectCommand) { objects.set(key, command.input.Body as Uint8Array); return {}; }
    if (command instanceof DeleteObjectCommand) { objects.delete(key); return {}; }
    if (!objects.has(key)) throw Object.assign(new Error(), {name: 'NoSuchKey'});
    return {Body: {transformToByteArray: async () => objects.get(key)}};
  }} as unknown as S3Client;
  const store = new S3DocumentStore('documents', client);
  const part = vehiclePhotoPartKeys('vehicle', 'owner', '12345678-1234-1234-1234-123456789abc')[0];
  const a = store.forTenant('A'), b = store.forTenant('B'), bytes = Uint8Array.from([1, 2, 3]);
  await a.put(part, bytes); await b.put(part, bytes);
  await a.put('vehicle_12345678-1234-1234-1234-123456789abc-display', bytes); await a.put('deal-document', bytes);
  assert.equal([...objects.keys()].filter(key => key.startsWith('temporary/vehicle-photo-parts/')).length, 2);
  assert.deepEqual(await a.get(part), bytes);
  await a.remove(part); assert.equal(await a.get(part), undefined); assert.deepEqual(await b.get(part), bytes);
  assert.ok(objects.has('tenants/A/vehicle_12345678-1234-1234-1234-123456789abc-display'));
  assert.ok(objects.has('tenants/A/deal-document'));
  const template = readFileSync('infra/template.yaml', 'utf8');
  assert.match(template, /Prefix: temporary\/vehicle-photo-parts\/\s+ExpirationInDays: 1\s+NoncurrentVersionExpiration: \{NoncurrentDays: 1\}/);
  assert.match(template, /Prefix: temporary\/vehicle-photo-parts\/\s+ExpiredObjectDeleteMarker: true/);
  assert.match(template, /NoncurrentVersionExpiration: \{NoncurrentDays: 30\}/);
});
async function workspace() {
  const repositories = new MemoryRepositories();
  const identity = {ensure: async (p: {email: string}) => p.email.split('@')[0]};
  const input = {tenantId: 'A', name: 'Admin', email: 'admin@example.test', dealership: 'Fictional Demo Dealer'};
  await bootstrapPilot(repositories, identity, input, now);
  const handle = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, async () => ({status: 204}), {hosted: true});
  return {repositories, identity, input, handle, gateway: gatewayHandler(handle, 'issuer', 'audience')};
}
test('hosted invitations bind verified email, tenant and Cognito subject; membership is required afterward', async () => {
  const s = await workspace();
  const invite = await invitePilot(s.repositories, s.identity, {tenantId: 'A', name: 'Staff', email: 'staff@example.test', actorId: 'admin', role: 'staff'}, now);
  assert.ok('token' in invite && typeof invite.token === 'string');
  const stored = (await s.repositories.forTenant('A').crmGet('invite', invite.id))!;
  assert.equal('token' in stored, false);
  assert.equal(stored.tokenHash, (await import('node:crypto')).createHash('sha256').update(invite.token).digest('hex'));
  const again = await invitePilot(s.repositories, s.identity, {tenantId: 'A', name: 'Staff', email: 'staff@example.test', actorId: 'admin', role: 'staff'}, now);
  assert.equal('token' in again, false);
  const path = `/invite/${invite.token}/accept`;
  const accept = (trusted?: AuthClaims) => s.gateway({...event(path, 'POST', trusted), body: JSON.stringify({name: 'Staff', email: 'staff@example.test'})});
  assert.equal((await s.gateway(event('/session', 'GET', claims('staff')))).statusCode, 403);
  assert.equal((await accept()).statusCode, 401);
  for (const c of [claims('other'), claims('staff', 'B'), {...claims('staff'), email_verified: false}]) assert.equal((await accept(c)).statusCode, 403);
  const accepted = await accept(claims('staff')); assert.equal(accepted.statusCode, 200); assert.equal(JSON.parse(accepted.body).data.outcome, 'accepted');
  assert.equal((await s.repositories.forTenant('A').membership('staff'))?.role, 'staff');
  assert.equal((await s.gateway(event('/session', 'GET', claims('staff')))).statusCode, 200);
  assert.equal(JSON.parse((await accept(claims('staff'))).body).data.outcome, 'refused');
  await s.handle({path: '/admin/users/staff/deactivate', method: 'POST', claims: claims(), body: JSON.stringify({version: 1})});
  assert.equal((await s.gateway(event('/session', 'GET', claims('staff')))).statusCode, 403);
  for (const path of ['/admin/users', '/account/mfa/setup', '/admin/mfa/staff/reset'])
    assert.equal((await s.handle({path, method: 'POST', claims: claims(), body: '{}'})).statusCode, 403);
});
test('pilot bootstrap is repeatable without overwriting memberships or other tenants', async () => {
  const s = await workspace();
  assert.deepEqual(await bootstrapPilot(s.repositories, s.identity, s.input), {tenantId: 'A', userId: 'admin'});
  assert.equal((await s.repositories.forTenant('A').events()).length, 1);
  await assert.rejects(bootstrapPilot(s.repositories, s.identity, {...s.input, dealership: 'Different'}));
  await assert.rejects(invitePilot(s.repositories, s.identity, {tenantId: 'B', actorId: 'admin', name: 'No', email: 'no@example.test', role: 'staff'}));
});
test('Cognito operator suppresses email and saves recoverable credentials before creating an identity', async () => {
  let saved = false, created = false;
  const client = {send: async (command: {constructor: {name: string}; input: Record<string, unknown>}) => {
    if (command.constructor.name === 'AdminGetUserCommand') throw Object.assign(new Error(), {name: 'UserNotFoundException'});
    assert.ok(saved); assert.equal(command.input.MessageAction, 'SUPPRESS'); assert.ok(command.input.TemporaryPassword); created = true;
    return {User: {Attributes: [{Name: 'sub', Value: 'new-user'}]}};
  }} as unknown as CognitoIdentityProviderClient;
  const identity = new CognitoPilotIdentity('pool', async () => { saved = true; }, client);
  assert.equal(await identity.ensure({tenantId: 'A', email: 'a@example.test', name: 'A'}), 'new-user'); assert.ok(created);
});
test('demo creates a coherent fictional dealership once and refuses existing business records', async () => {
  const s = await workspace();
  assert.deepEqual(await seedDemo(s.repositories, 'A', 'admin', now), {vehicles: 6, customers: 4, leads: 4, deals: 3, parts: 3, repairOrders: 1, appointments: 1});
  const repo = s.repositories.forTenant('A');
  assert.equal((await repo.list({})).filter(v => v.status === 'sold').length, 1);
  assert.ok((await repo.crmList('customer')).every(c => c.email.endsWith('@example.test')));
  assert.ok((await repo.crmList('journal-entry')).length > 0);
  const events = (await repo.events()).length;
  await assert.rejects(seedDemo(s.repositories, 'A', 'admin', now), /empty workspace/);
  assert.equal((await repo.events()).length, events);
  assert.equal((await s.repositories.forTenant('B').list({})).length, 0);
});
