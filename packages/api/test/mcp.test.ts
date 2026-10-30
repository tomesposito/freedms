import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createHandler } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { seedDemo } from '../src/demo-seed.js';
import { vehicleFields, tools } from '../src/mcp/tools.js';
import { gatewayHandler } from '../src/gateway.js';
import { localAuth } from '../src/local-auth.js';
import { accessVerifier } from '../src/mcp/auth.js';
const now = new Date('2026-10-30T12:00:00Z');
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'offline', alg: 'RS256'};
const config = {issuer: 'https://issuer.example.test/pool', clientId: 'mcp-client', resource: 'https://app.example.test/api/mcp', now: () => now.getTime(), jwks: async () => ({keys: [jwk]})};
function token(overrides: Record<string, unknown> = {}, header = {alg: 'RS256', kid: 'offline'}) {
  const data = [header, {sub: 'admin-A', iss: config.issuer, client_id: config.clientId, token_use: 'access', scope: 'freedms/mcp.write', exp: now.getTime() / 1000 + 3600, ...overrides}].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
async function setup() {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) {
    const userId = `admin-${tenantId}`;
    await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: userId, name: 'Admin'}, {tenantId, userId, active: true, role: 'admin'},
      {id: 'provision', tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
    await seedDemo(repositories, tenantId, userId, now);
  }
  const handle = createHandler(repositories, {decode: async () => {throw Error('Network forbidden');}}, () => now, undefined, undefined, undefined, async () => ({status: 204}), {mcp: config});
  const request = async (method: string, params: unknown = {}, jwt = token()) => {
    const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${jwt}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
    return {response, ...JSON.parse(response.body)};
  };
  const call = async (name: string, args: unknown = {}, jwt = token()) => (await request('tools/call', {name, arguments: args}, jwt)).result;
  return {repositories, handle, request, call};
}
test('MCP initialize, ping, scoped tool discovery, metadata and adapter dispatch', async () => {
  const s = await setup();
  const initialized = await s.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'offline', version: '1'}});
  assert.equal(initialized.result.protocolVersion, '2025-11-25'); assert.ok(initialized.result.capabilities.tools);
  assert.deepEqual((await s.request('ping')).result, {});
  assert.equal((await s.request('tools/list')).result.tools.length, 18);
  const reads = (await s.request('tools/list', {}, token({scope: 'freedms/mcp.read'}))).result.tools;
  assert.equal(reads.length, 14); assert.ok(reads.every((t: {annotations: {readOnlyHint: boolean}}) => t.annotations.readOnlyHint));
  assert.equal((await s.request('tools/call', {name: 'create_vehicle', arguments: {}}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
  for (const sub of ['unknown', 'admin-C']) assert.deepEqual((await s.request('tools/list', {}, token({sub}))).result.tools, []);
  const metadata = await s.handle({method: 'GET', path: '/.well-known/oauth-protected-resource'});
  assert.deepEqual(JSON.parse(metadata.body).authorization_servers, [config.issuer]); assert.equal(JSON.parse(metadata.body).resource, config.resource);
  const gateway = gatewayHandler(s.handle, 'web-issuer', 'web-audience');
  const result = await gateway({rawPath: '/mcp', requestContext: {http: {method: 'POST'}}, headers: {Authorization: `Bearer ${token()}`}, body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/list'})});
  assert.equal(JSON.parse(result.body).result.tools.length, 18);
  assert.deepEqual(localAuth('/mcp', false, 'access-token', {verify: () => {throw Error('Must not verify as ID token');}}), {authorization: 'Bearer access-token'});
});
test('MCP rejects invalid access tokens with a resource challenge and caches offline JWKS', async () => {
  const s = await setup();
  for (const jwt of ['', 'broken', token({client_id: 'web-client'}), token({scope: 'openid'}), token({exp: 1}), token({iss: 'wrong'}), token({token_use: 'id'}), token({}, {alg: 'HS256', kid: 'offline'}), token({}, {alg: 'RS256', kid: 'unknown'}), token().slice(0, -10) + 'invalid']) {
    const r = (await s.request('tools/list', {}, jwt)).response;
    assert.equal(r.statusCode, 401); assert.equal(r.headers['www-authenticate'], 'Bearer resource_metadata="https://app.example.test/api/.well-known/oauth-protected-resource"');
  }
  let fetches = 0;
  const verify = accessVerifier({...config, jwks: async () => {fetches++; return {keys: [jwk]};}});
  await Promise.all([verify(`Bearer ${token()}`), verify(`Bearer ${token()}`)]); await verify(`Bearer ${token()}`); assert.equal(fetches, 1);
  const failing = createHandler(s.repositories, {decode: async () => {throw Error();}}, () => now, undefined, undefined, undefined, undefined, {mcp: {...config, jwks: async () => {throw Error('private network detail');}}});
  assert.equal((await failing({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`})).statusCode, 401);
});
test('all fourteen MCP reads preserve REST resources and tenant isolation', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A');
  const ids: Record<string, string> = {get_vehicle: (await repo.list({}))[0].id, get_lead: (await repo.crmList('lead'))[0].id, get_customer: (await repo.crmList('customer'))[0].id, get_deal: (await repo.crmList('deal'))[0].id};
  const before = (await repo.events()).length;
  for (const tool of tools.filter(t => t.method === 'GET')) {
    const args = ids[tool.name] ? {id: ids[tool.name]} : {};
    const result = await s.call(tool.name, args); assert.equal(result.isError, false, tool.name);
    const rest = await s.handle({method: 'GET', path: tool.path.replace(':id', ids[tool.name]), claims: {sub: 'admin-A', 'custom:tenant_id': 'A', iss: '', aud: '', exp: 1, token_use: 'id'}});
    assert.deepEqual(result.structuredContent, JSON.parse(rest.body), tool.name);
    assert.ok(!result.content[0].text.includes('"tenantId":"B"'), tool.name);
  }
  assert.equal((await repo.events()).length, before, 'reads do not create audit events');
  for (const [name, kind] of [['get_lead', 'lead'], ['get_customer', 'customer'], ['get_deal', 'deal']] as const) {
    const id = (await s.repositories.forTenant('B').crmList(kind))[0].id;
    assert.equal((await s.call(name, {id})).structuredContent.error.code, 'NOT_FOUND');
  }
  const page = await s.call('search_vehicles', {limit: 1, offset: 1, search: 'Toyota'}); assert.equal(page.structuredContent.limit, 1);
  const leadPage = await s.call('list_leads', {limit: 1, offset: 0}); assert.equal(leadPage.structuredContent.limit, 1);
  const injected = await s.call('search_vehicles', {tenantId: 'B'}); assert.equal(injected.isError, true);
});
test('inventory MCP writes reuse validation, versions, user roles and agent outbox attribution', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A');
  const original = (await repo.list({}))[0];
  const fields = Object.fromEntries(Object.keys(vehicleFields).map(k => [k, original[k as keyof typeof original]]));
  const before = (await repo.events()).length;
  const created = await s.call('create_vehicle', {...fields, stockNumber: 'MCP-1', vin: '1HGCM82633A004352'});
  assert.equal(created.isError, false); const id = created.structuredContent.data.id;
  assert.equal((await s.call('update_vehicle', {...fields, id, version: 1, stockNumber: 'MCP-1', vin: '1HGCM82633A004352', cost: 100001})).isError, false);
  assert.equal((await s.call('set_vehicle_status', {id, version: 2, status: 'sold'})).structuredContent.data.status, 'sold');
  assert.equal((await s.call('set_vehicle_status', {id, version: 1, status: 'available'})).isError, true);
  assert.equal((await s.call('create_vehicle', {...fields, cost: 1.5})).isError, true);
  const imported = await s.call('import_vehicles', {csv: 'vin,year,make,model,cost,listPrice\n1HGCM82633A004353,2003,Honda,Accord,1000.01,1500.02'});
  assert.equal(imported.isError, false); assert.equal(imported.structuredContent.data.importedCount, 1);
  assert.equal((await repo.get(imported.structuredContent.data.importedVehicleIds[0]))?.cost, 100001);
  const events = (await repo.events()).slice(before); assert.equal(events.length, 5);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A' && e.tenantId === 'A'));
  const otherId = (await s.repositories.forTenant('B').list({}))[0].id;
  for (const name of ['get_vehicle', 'set_vehicle_status', 'update_vehicle']) {
    const args = name === 'get_vehicle' ? {id: otherId} : name === 'set_vehicle_status' ? {id: otherId, version: 1, status: 'sold'} : {...fields, id: otherId, version: 1};
    assert.equal((await s.call(name, args)).isError, true);
  }
  // Staff has the same inventory rights as the UI; unsupported/inactive roles get none.
  const member = (await repo.membership('admin-A'))!;
  await repo.saveMember({id: 'staff-A', name: 'Staff', email: 'staff@example.test'}, {...member, userId: 'staff-A', role: 'staff', version: 1}, 0,
    {id: 'staff-event', tenantId: 'A', actorId: 'admin-A', aggregateId: 'staff-A', aggregateVersion: 1, type: 'user.added', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  assert.equal((await s.call('set_vehicle_status', {id, version: 3, status: 'available'}, token({sub: 'staff-A'}))).isError, false);
  const inactive = new Proxy(s.repositories, {get(target, key) {
    if (key === 'forTenant') return (tenant: string) => ({...target.forTenant(tenant), membership: async () => ({...member, active: false})});
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const handle = createHandler(inactive, {decode: async () => {throw Error();}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
  const denied = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'create_vehicle', arguments: fields}})});
  assert.equal(JSON.parse(denied.body).error.message, 'Tool unavailable.');
});
test('MCP malformed frames and notifications are sanitized and stateless', async () => {
  const s = await setup();
  for (const [body, code] of [['{', -32700], ['[]', -32600], ['null', -32600], ['{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600]] as const) {
    const r = await s.handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body}); assert.equal(JSON.parse(r.body).error.code, code);
  }
  const notification = await s.handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})});
  assert.equal(notification.statusCode, 202); assert.equal(notification.body, ''); assert.ok(!('mcp-session-id' in notification.headers));
  assert.equal((await s.request('unknown')).error.code, -32601);
  assert.equal((await s.request('tools/call', {name: 'signature_capture'})).error.message, 'Tool unavailable.');
});

test('Dynamo MCP subject bindings are conditional, atomic, and resolved without scanning', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, TransactWriteCommand} = await import('@aws-sdk/lib-dynamodb');
  const commands: (InstanceType<typeof GetCommand> | InstanceType<typeof TransactWriteCommand>)[] = [];
  const client = {send: async (command: typeof commands[number]) => {
    commands.push(command);
    if (command instanceof GetCommand) return {Item: {data: {tenantId: 'A'}}};
    return {};
  }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const repo = new DynamoRepositories('offline', client, true);
  const member = {tenantId: 'A', userId: 'subject', role: 'admin' as const, active: true};
  await repo.forTenant('A').provision({id: 'A', name: 'A', createdAt: now.toISOString()}, {id: 'subject', name: 'Admin'}, member,
    {id: 'event', tenantId: 'A', actorId: 'subject', aggregateId: 'A', aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const items = (commands[0] as InstanceType<typeof TransactWriteCommand>).input.TransactItems!;
  assert.equal(items.length, 5); assert.equal(items[0].Put?.Item?.PK, 'SUBJECT#subject');
  assert.equal(items[0].Put?.ExpressionAttributeValues?.[':tenant'], 'A'); assert.ok(items[0].Put?.ConditionExpression?.includes('attribute_not_exists'));
  assert.ok(items.some(i => i.Put?.Item?.SK === 'MEMBER#subject')); assert.ok(items.some(i => i.Put?.Item?.SK === 'EVENT#event'));
  assert.equal(await repo.tenantForSubject('subject'), 'A');
  assert.deepEqual((commands[1] as InstanceType<typeof GetCommand>).input.Key, {PK: 'SUBJECT#subject', SK: 'TENANT'});
  await repo.bindSubject('A', 'subject');
  const migration = (commands[2] as InstanceType<typeof TransactWriteCommand>).input.TransactItems!;
  assert.equal(migration[0].ConditionCheck?.Key?.SK, 'MEMBER#subject'); assert.ok(migration[1].Put?.ConditionExpression);
  await assert.rejects(repo.tenantForSubject('../other'));
});

test('MCP template embeds repository logo bytes and keeps dedicated scope/client routes', async () => {
  const {readFile} = await import('node:fs/promises');
  const template = await readFile(new URL('../../../infra/template.yaml', import.meta.url), 'utf8');
  const logo = await readFile(new URL('../../web/src/assets/logo.svg', import.meta.url));
  const images = [...template.matchAll(/Bytes: ([A-Za-z0-9+/=]+)/g)]; assert.equal(images.length, 2);
  for (const [, encoded] of images) assert.deepEqual(Buffer.from(encoded, 'base64'), logo);
  assert.equal((template.match(/Type: AWS::Cognito::ManagedLoginBranding/g) ?? []).length, 2);
  assert.match(template, /AllowedOAuthScopes: \[freedms\/mcp.read, freedms\/mcp.write\]/);
  assert.match(template, /Path: \/mcp\n\s+Method: POST\n\s+Auth: \{Authorizer: NONE\}/);
  assert.match(template, /Path: \/.well-known\/oauth-protected-resource\n\s+Method: GET\n\s+Auth: \{Authorizer: NONE\}/);
});

test('MCP ignores token tenant hints and refuses a subject without its resolved membership', async () => {
  const s = await setup();
  const b = await s.call('search_vehicles', {}, token({sub: 'admin-B', 'custom:tenant_id': 'A'}));
  assert.ok(b.structuredContent.data.length); assert.ok(b.structuredContent.data.every((v: {tenantId: string}) => v.tenantId === 'B'));
  for (const mode of ['wrong-tenant', 'unsupported-role']) {
    const factory = {
      tenantForSubject: async () => 'A',
      forTenant: (tenant: string) => {
        const repo = s.repositories.forTenant(tenant);
        return mode === 'wrong-tenant' ? repo : {...repo, membership: async () => ({tenantId: 'A', userId: 'admin-B', active: true, role: 'viewer' as 'admin'})};
      },
    };
    const handle = createHandler(factory, {decode: async () => {throw Error();}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
    const result = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token({sub: 'admin-B'})}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})});
    assert.equal(result.statusCode, 200); assert.deepEqual(JSON.parse(result.body).result.tools, []);
  }
});
