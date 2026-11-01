import { MemoryDocumentStore, type DocumentStore } from '../src/document-store.js';
import type { QuickEntryProvider } from '../src/ai-provider.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
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
async function setup(provider?: QuickEntryProvider, clock: () => Date = () => now, store?: DocumentStore) {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) {
    const userId = `admin-${tenantId}`;
    await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: userId, name: 'Admin'}, {tenantId, userId, active: true, role: 'admin'},
      {id: 'provision', tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
    await seedDemo(repositories, tenantId, userId, now);
  }
  const handle = createHandler(repositories, {decode: async () => {throw Error('Network forbidden');}}, clock, store, provider, undefined, async () => ({status: 204}), {mcp: config});
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
  assert.equal((await s.request('tools/list')).result.tools.length, 130);
  const reads = (await s.request('tools/list', {}, token({scope: 'freedms/mcp.read'}))).result.tools;
  assert.equal(reads.length, 51); assert.ok(reads.every((t: {annotations: {readOnlyHint: boolean}}) => t.annotations.readOnlyHint));
  assert.equal((await s.request('tools/call', {name: 'create_vehicle', arguments: {}}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
  for (const sub of ['unknown', 'admin-C']) assert.deepEqual((await s.request('tools/list', {}, token({sub}))).result.tools, []);
  const metadata = await s.handle({method: 'GET', path: '/.well-known/oauth-protected-resource'});
  assert.deepEqual(JSON.parse(metadata.body).authorization_servers, [config.issuer]); assert.equal(JSON.parse(metadata.body).resource, config.resource);
  const gateway = gatewayHandler(s.handle, 'web-issuer', 'web-audience');
  const result = await gateway({rawPath: '/mcp', requestContext: {http: {method: 'POST'}}, headers: {Authorization: `Bearer ${token()}`}, body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/list'})});
  assert.equal(JSON.parse(result.body).result.tools.length, 130);
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
test('original fourteen MCP reads preserve REST resources and tenant isolation', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A');
  const ids: Record<string, string> = {get_vehicle: (await repo.list({}))[0].id, get_lead: (await repo.crmList('lead'))[0].id, get_customer: (await repo.crmList('customer'))[0].id, get_deal: (await repo.crmList('deal'))[0].id};
  const before = (await repo.events()).length;
  for (const tool of tools.filter(t => t.method === 'GET' && !deskingReads.includes(t.name) && !accountingTools.includes(t) && !parityTools.includes(t))) {
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
  const callbackParameter = template.match(/^  McpCallbackURLs:\n((?:^    .*\n)+)/m)?.[1];
  assert.ok(callbackParameter, 'McpCallbackURLs parameter exists');
  assert.match(callbackParameter, /^    Type: CommaDelimitedList$/m);
  const callbackDefault = callbackParameter.match(/^    Default: '([^']*)'$/m)?.[1];
  assert.equal(callbackDefault, 'https://agent.meta.ai/api/hatch/oauth/callback');
  assert.deepEqual(callbackDefault.match(/https?:\/\/[^,\s]+/g), ['https://agent.meta.ai/api/hatch/oauth/callback']);
  assert.ok(template.includes("  McpRegistered: !Not [!Equals [!Join ['', !Ref McpCallbackURLs], '']]\n"));
  const mcpClient = template.match(/^  McpClient:\n((?:^    .*\n)+)/m)?.[1];
  assert.ok(mcpClient, 'McpClient resource exists');
  assert.ok(mcpClient.includes('      AllowedOAuthFlowsUserPoolClient: !If [McpRegistered, true, false]\n'));
  assert.ok(mcpClient.includes("      AllowedOAuthFlows: !If [McpRegistered, [code], !Ref 'AWS::NoValue']\n"));
  assert.ok(mcpClient.includes("      CallbackURLs: !If [McpRegistered, !Ref McpCallbackURLs, !Ref 'AWS::NoValue']\n"));
  assert.match(template, /AllowedOAuthScopes: !If \[McpRegistered, \[freedms\/mcp.read, freedms\/mcp.write\]/);
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

const customerInput = {name: 'MCP Customer', phone: '', email: '', address: '', notes: '',
  consent: {status: 'granted', timestamp: now.toISOString(), source: 'Dealer intake form'}};
const crmTools = ['create_lead', 'update_lead', 'set_lead_stage', 'assign_lead', 'add_lead_note', 'schedule_follow_up',
  'update_follow_up', 'create_customer', 'update_customer', 'quick_entry_draft', 'quick_entry_confirm'];
function data(result: any) {
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return result.structuredContent.data;
}
function refused(result: any, code: string) {
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, code);
}
test('CRM MCP writes preserve consent, lead fields, follow-up actions and agent attribution', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A');
  const before = (await repo.events()).length;
  const customer = data(await s.call('create_customer', customerInput)).customer;
  assert.deepEqual((await repo.crmGet('customer', customer.id))?.consent, customerInput.consent);
  const consent = {...customerInput.consent, status: 'revoked'};
  const updated = data(await s.call('update_customer', {...customerInput, id: customer.id, version: 1, consent}));
  assert.equal(updated.version, 2);
  assert.deepEqual((await repo.crmGet('customer', customer.id))?.consent, consent);
  const vehicleId = (await repo.list({}))[0].id;
  const inline = data(await s.call('create_lead', {customer: customerInput, source: 'website', vehicleId, assigneeId: 'admin-A'})).lead;
  const existing = data(await s.call('create_lead', {customerId: customer.id, source: 'phone'})).lead;
  assert.equal(existing.customerId, customer.id); assert.equal(inline.stage, 'new');
  const id = inline.id;
  let lead = data(await s.call('update_lead', {id, version: 1, stage: 'contacted', assigneeId: 'admin-A', vehicleId}));
  assert.equal(lead.version, 2); assert.equal(lead.stage, 'contacted');
  lead = data(await s.call('set_lead_stage', {id, version: 2, stage: 'appointment'}));
  assert.equal(lead.stage, 'appointment'); assert.equal(lead.assigneeId, 'admin-A'); assert.equal(lead.vehicleId, vehicleId);
  lead = data(await s.call('assign_lead', {id, version: 3, assigneeId: null}));
  assert.equal(lead.assigneeId, null); assert.equal(lead.stage, 'appointment'); assert.equal(lead.vehicleId, vehicleId);
  lead = data(await s.call('assign_lead', {id, version: 4, assigneeId: 'admin-A'}));
  assert.equal(lead.assigneeId, 'admin-A'); assert.equal(lead.stage, 'appointment'); assert.equal(lead.vehicleId, vehicleId);
  lead = data(await s.call('assign_lead', {id, version: 5, assigneeId: null}));
  assert.equal(lead.assigneeId, null);
  const note = {type: 'call', direction: 'inbound', summary: 'Asked about a test drive', timestamp: now.toISOString()};
  lead = data(await s.call('add_lead_note', {id, version: 6, ...note}));
  assert.deepEqual(lead.activities.at(-1), {...note, id: lead.activities.at(-1).id, kind: 'communication', actorId: 'admin-A'});
  lead = data(await s.call('schedule_follow_up', {id, version: 7, type: 'visit', dueAt: now.toISOString()}));
  const taskId = lead.followUps[0].id;
  assert.deepEqual(lead.followUps[0], {id: taskId, type: 'visit', dueAt: now.toISOString(), done: false});
  lead = data(await s.call('update_follow_up', {id, taskId, version: 8, done: true}));
  assert.equal(lead.followUps[0].done, true);
  refused(await s.call('update_follow_up', {id, taskId, version: 9, done: false, dismissed: true}), 'VALIDATION');
  lead = data(await s.call('update_follow_up', {id, taskId, version: 9, done: false}));
  assert.equal(lead.followUps[0].done, false);
  lead = data(await s.call('update_follow_up', {id, taskId, version: 10, dueAt: '2026-11-01T12:00:00.000Z'}));
  assert.equal(lead.followUps[0].dueAt, '2026-11-01T12:00:00.000Z');
  lead = data(await s.call('update_follow_up', {id, taskId, version: 11, dismissed: true}));
  assert.equal(lead.followUps[0].dismissed, true);
  refused(await s.call('update_follow_up', {id, taskId: '../invalid', version: 12, done: true}), 'INVALID_ID');
  refused(await s.call('update_lead', {id, version: 1, stage: 'new', assigneeId: null, vehicleId: null}), 'CONFLICT');
  refused(await s.call('update_customer', {...customerInput, id: customer.id, version: 1}), 'CONFLICT');
  const events = (await repo.events()).slice(before);
  assert.equal(events.length, 16);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A' && e.tenantId === 'A'));
  refused(await s.call('get_lead', {id}, token({sub: 'admin-B'})), 'NOT_FOUND');
});

test('CRM MCP tools enforce scope, tenant isolation and REST validation', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B');
  const lead = (await other.crmList('lead'))[0], customer = (await other.crmList('customer'))[0];
  const before = (await repo.events()).length, otherBefore = (await other.events()).length;
  const cases: [string, Record<string, unknown>][] = [
    ['get_lead', {id: lead.id}], ['get_customer', {id: customer.id}],
    ['update_lead', {id: lead.id, version: lead.version, stage: 'new', assigneeId: null, vehicleId: null}],
    ['set_lead_stage', {id: lead.id, version: lead.version, stage: 'new'}],
    ['assign_lead', {id: lead.id, version: lead.version, assigneeId: null}],
    ['add_lead_note', {id: lead.id, version: lead.version, type: 'call', direction: 'inbound', summary: 'Note', timestamp: now.toISOString()}],
    ['schedule_follow_up', {id: lead.id, version: lead.version, type: 'call', dueAt: now.toISOString()}],
    ['update_follow_up', {id: lead.id, taskId: 'foreign-task', version: lead.version, done: true}],
    ['update_customer', {...customerInput, id: customer.id, version: customer.version}],
    ['create_lead', {customerId: customer.id, source: 'phone'}],
  ];
  for (const [name, args] of cases) refused(await s.call(name, args), 'NOT_FOUND');
  const foreignVehicle = (await other.list({}))[0].id;
  for (const name of ['create_lead', 'quick_entry_confirm']) {
    refused(await s.call(name, {customer: customerInput, source: 'phone', vehicleId: foreignVehicle}), 'VALIDATION');
  }
  for (const name of crmTools) {
    assert.equal((await s.request('tools/call', {name, arguments: {}}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
    refused(await s.call(name, {tenantId: 'B'}), 'VALIDATION');
  }
  const localCustomer = (await repo.crmList('customer'))[0];
  for (const args of [{customerId: localCustomer.id, customer: customerInput, source: 'phone'}, {customer: customerInput, source: 'invalid'}]) {
    refused(await s.call('create_lead', args), 'VALIDATION');
  }
  refused(await s.call('create_customer', {...customerInput, consent: {...customerInput.consent, timestamp: null}}), 'VALIDATION');
  refused(await s.call('quick_entry_draft', {text: 'New lead'}), 'AI_UNAVAILABLE');
  assert.equal((await repo.events()).length, before); assert.equal((await other.events()).length, otherBefore);
});

test('CRM quick-entry MCP draft saves nothing and confirm saves the reviewed fields', async () => {
  const provider: QuickEntryProvider = {
    configured: true, supportsVision: false,
    async extractVehicle() { throw Error('Unexpected vehicle extraction'); },
    async extractVehiclePhoto() { throw Error('Unexpected photo extraction'); },
    async extractLead() { return {customer: {...customerInput, tenantId: 'B'}, source: 'website', vehicleDescription: 'Blue sedan', tenantId: 'B', vehicleId: 'foreign'}; },
  };
  const s = await setup(provider), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B');
  const leads = await repo.crmList('lead'), customers = await repo.crmList('customer'), before = (await repo.events()).length;
  const draft = data(await s.call('quick_entry_draft', {text: 'Customer looking for a blue sedan'})).draft;
  assert.deepEqual(draft.customer.consent, {status: 'unknown', timestamp: null, source: ''});
  assert.equal(draft.tenantId, undefined); assert.equal(draft.vehicleId, undefined); assert.equal(draft.customer.tenantId, undefined);
  assert.deepEqual(await repo.crmList('lead'), leads); assert.deepEqual(await repo.crmList('customer'), customers);
  assert.equal((await repo.events()).length, before);
  assert.equal((await repo.usageForTest()).length, 1); assert.equal((await other.usageForTest()).length, 0);
  const lead = data(await s.call('quick_entry_confirm', {...draft, customer: {...customerInput, ...draft.customer}})).lead;
  assert.equal(lead.vehicleDescription, 'Blue sedan'); assert.deepEqual(lead.customer.consent, draft.customer.consent);
  assert.equal((await repo.crmList('lead')).length, leads.length + 1); assert.equal((await repo.crmList('customer')).length, customers.length + 1);
  const events = (await repo.events()).slice(before); assert.equal(events.length, 2);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A' && e.tenantId === 'A'));
  refused(await s.call('get_lead', {id: lead.id}, token({sub: 'admin-B'})), 'NOT_FOUND');
  refused(await s.call('get_customer', {id: lead.customerId}, token({sub: 'admin-B'})), 'NOT_FOUND');
});

const deskingReads = ['list_fi_products', 'get_credit_application', 'get_deal_jacket'];
const deskingWrites = ['create_deal', 'update_deal', 'set_deal_status', 'create_pencil', 'update_pencil', 'set_working_pencil',
  'create_fi_product', 'update_fi_product', 'create_credit_application', 'update_credit_application'];
const fiInput = {name: 'Coverage', category: 'service-contract', cost: 10000, retailPrice: 30000, termNotes: '36 months', active: true};
const person = {fullName: 'Test Buyer', dateOfBirth: '1990-01-01', ssn: '123-45-6789', address: '123 Main St',
  phone: '', email: '', employerName: '', jobTitle: '', otherIncomeSource: '', housingStatus: 'rent', monthlyHousingPayment: 100000, yearsAtAddress: 2, yearsEmployed: 3, grossMonthlyIncome: 500000, otherMonthlyIncome: 0};
const creditInput = {applicant: person, coApplicant: null, consentAt: now.toISOString()};
const pencilInput = {name: 'Finance', type: 'finance', price: 2000000, down: 200000, term: 60, aprBps: 500};
const leaseInput = {msrp: 2500000, residualPercentBps: 5000, moneyFactorMicro: 2000, acquisitionFee: 50000, securityDeposit: 20000, milesPerYear: 12000};
const restClaims = {sub: 'admin-A', 'custom:tenant_id': 'A', iss: '', aud: '', exp: 1, token_use: 'id' as const};
test('desking MCP happy paths preserve pencils, product snapshots, credit privacy and agent attribution', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), before = (await repo.events()).length;
  const createArgs = {vehicleId: (await repo.list({})).find(v => v.status === 'available')!.id, customerId: (await repo.crmList('customer'))[0].id, type: 'finance'};
  let deal = data(await s.call('create_deal', createArgs));
  const id = deal.id;
  refused(await s.call('get_deal_jacket', {id}), 'VALIDATION');
  const accepted = data(await s.call('create_fi_product', fiInput));
  const declined = data(await s.call('create_fi_product', {...fiInput, name: 'Declined coverage'}));
  data(await s.call('update_fi_product', {...fiInput, id: accepted.id, version: 1, retailPrice: 40000}));
  const selections = [{productId: accepted.id, status: 'accepted'}, {productId: declined.id, status: 'declined'}];
  const pencilId = randomUUID(), leaseId = randomUUID();
  deal = data(await s.call('create_pencil', {id, version: deal.version, pencilId, ...pencilInput, fiSelections: selections}));
  deal = data(await s.call('create_pencil', {id, version: deal.version, pencilId: leaseId, ...pencilInput, type: 'lease', lease: leaseInput}));
  // Re-saving a different pencil normalizes both stored snapshots and both stored residual values.
  deal = data(await s.call('update_pencil', {id, version: deal.version, pencilId, ...pencilInput, price: 2100000}));
  const finance = deal.pencils.find((p: any) => p.id === pencilId);
  assert.equal(finance.price, 2100000); assert.equal(finance.down, 200000); assert.equal(finance.term, 60); assert.equal(finance.aprBps, 500);
  assert.deepEqual(finance.fiSelections.map((p: any) => ({productId: p.productId, status: p.status})), selections);
  assert.equal(finance.fiSelections[0].name, fiInput.name); assert.equal(finance.fiSelections[0].cost, fiInput.cost);
  assert.equal(finance.fiSelections[0].retailPrice, 40000);
  assert.equal(deal.pencils.find((p: any) => p.id === leaseId).lease.residualAmount, 1250000);
  deal = data(await s.call('set_working_pencil', {id, version: deal.version, pencilId}));
  assert.equal(deal.workingPencilId, pencilId);
  const pencils = deal.pencils;
  deal = data(await s.call('update_deal', {id, version: deal.version, docFee: 12345, trade: null}));
  assert.deepEqual(deal.pencils, pencils); assert.equal(deal.docFee, 12345);
  deal = data(await s.call('set_deal_status', {id, version: deal.version, status: 'approved'}));
  assert.equal(deal.status, 'approved');
  const application = data(await s.call('create_credit_application', {id, ...creditInput}));
  assert.equal(application.applicant.ssnLast4, '6789'); assert.equal(application.applicant.ssn, undefined);
  const {ssn: _ssn, ...withoutSsn} = person;
  const updated = data(await s.call('update_credit_application', {id, version: 1, ...creditInput, applicant: {...withoutSsn, yearsAtAddress: 3}}));
  assert.equal(updated.applicant.ssnLast4, '6789'); assert.equal(updated.consentAt, creditInput.consentAt); assert.equal(updated.status, 'draft');
  assert.ok(!JSON.stringify(await repo.crmGet('credit-application', id)).includes(person.ssn));
  for (const name of deskingReads) data(await s.call(name, name === 'list_fi_products' ? {} : {id}, token({scope: 'freedms/mcp.read'})));
  const events = (await repo.events()).slice(before);
  assert.equal(events.length, 12);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
  assert.ok(!JSON.stringify(events).includes(person.ssn));
  const restBefore = (await repo.events()).length;
  for (const [path, body] of [['/deals', createArgs], ['/fi-products', fiInput]] as const) {
    assert.equal((await s.handle({method: 'POST', path, claims: restClaims, body: JSON.stringify(body)})).statusCode, 201);
  }
  assert.equal((await s.handle({method: 'PUT', path: `/deals/${id}/credit-application`, claims: restClaims, body: JSON.stringify({...creditInput, version: 2, status: 'ready'})})).statusCode, 200);
  assert.ok((await repo.events()).slice(restBefore).every(e => !('actorType' in e)));
  assert.equal(data(await s.call('update_credit_application', {id, version: 3, ...creditInput})).status, 'ready');
});

test('desking MCP validation, tenant isolation, scope and role refusals', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B');
  const deal = data(await s.call('create_deal', {vehicleId: (await repo.list({})).find(v => v.status === 'available')!.id,
    customerId: (await repo.crmList('customer'))[0].id, type: 'finance'}));
  const id = deal.id, version = deal.version, pencilId = deal.pencils[0].id;
  const otherDeal = (await other.crmList('deal'))[0];
  const foreignProduct = data(await s.call('create_fi_product', fiInput, token({sub: 'admin-B'})));
  const foreignCases: [string, Record<string, unknown>][] = [
    ['get_credit_application', {id: otherDeal.id}], ['get_deal_jacket', {id: otherDeal.id}],
    ['update_deal', {id: otherDeal.id, version: 1}], ['set_deal_status', {id: otherDeal.id, version: 1, status: 'approved'}],
    ['create_pencil', {id: otherDeal.id, version: 1, pencilId: randomUUID(), ...pencilInput}],
    ['update_pencil', {id: otherDeal.id, version: 1, pencilId, ...pencilInput}],
    ['set_working_pencil', {id: otherDeal.id, version: 1, pencilId}],
    ['update_fi_product', {id: foreignProduct.id, version: 1, ...fiInput}],
    ['create_credit_application', {id: otherDeal.id, ...creditInput}],
    ['update_credit_application', {id: otherDeal.id, version: 1, ...creditInput}],
  ];
  const before = (await repo.events()).length, otherBefore = (await other.events()).length;
  for (const [name, args] of foreignCases) refused(await s.call(name, args), 'NOT_FOUND');
  // Collection creates validate foreign references using the existing REST vocabulary.
  refused(await s.call('create_deal', {vehicleId: otherDeal.vehicleId, customerId: otherDeal.customerId, type: 'cash'}), 'VALIDATION');
  for (const name of [...deskingWrites, ...deskingReads]) {
    if (deskingWrites.includes(name)) assert.equal((await s.request('tools/call', {name}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
    assert.equal((await s.request('tools/call', {name}, token({sub: 'unknown'}))).error.message, 'Tool unavailable.');
  }
  for (const role of ['viewer', 'inactive']) {
    const factory = {tenantForSubject: async () => 'A', forTenant: () => ({...repo, membership: async () => ({tenantId: 'A', userId: 'admin-A', active: role !== 'inactive', role: (role === 'inactive' ? 'admin' : 'viewer') as 'admin'})})};
    const handle = createHandler(factory, {decode: async () => {throw Error('Network forbidden');}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
    for (const name of [...deskingReads, ...deskingWrites]) {
      const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name}})});
      assert.equal(JSON.parse(response.body).error.message, 'Tool unavailable.');
    }
  }
  refused(await s.call('set_deal_status', {id, version, status: 'sold'}), 'VALIDATION');
  refused(await s.call('set_working_pencil', {id, version, pencilId: randomUUID()}), 'VALIDATION');
  refused(await s.call('create_pencil', {id, version, pencilId, ...pencilInput}), 'VALIDATION');
  refused(await s.call('update_pencil', {id, version, pencilId: randomUUID(), ...pencilInput}), 'NOT_FOUND');
  for (const productId of [foreignProduct.id, randomUUID()]) refused(await s.call('update_pencil', {id, version, pencilId, ...pencilInput, fiSelections: [{productId, status: 'accepted'}]}), 'VALIDATION');
  for (const fields of [{price: -1}, {term: 0}]) refused(await s.call('update_pencil', {id, version, pencilId, ...pencilInput, ...fields}), 'VALIDATION');
  refused(await s.call('create_credit_application', {id, ...creditInput, applicant: {...person, ssn: 'invalid'}}), 'VALIDATION');
  for (const name of ['create_credit_application', 'update_credit_application']) for (const extra of [{status: 'ready'}, {decision: {outcome: 'approved'}}]) {
    refused(await s.call(name, {id, version: 1, ...creditInput, ...extra}), 'VALIDATION');
  }
  refused(await s.call('update_deal', {id, version, status: 'approved'}), 'VALIDATION');
  assert.equal((await repo.events()).length, before); assert.equal((await other.events()).length, otherBefore);
  data(await s.call('update_deal', {id, version, docFee: 20000}));
  for (const [name, args] of [['update_deal', {}], ['set_deal_status', {status: 'approved'}], ['create_pencil', {pencilId: randomUUID(), ...pencilInput}],
    ['update_pencil', {pencilId, ...pencilInput}], ['set_working_pencil', {pencilId}]] as const) refused(await s.call(name, {id, version, ...args}), 'CONFLICT');
  data(await s.call('create_credit_application', {id, ...creditInput}));
  data(await s.call('update_credit_application', {id, version: 1, ...creditInput}));
  refused(await s.call('update_credit_application', {id, version: 1, ...creditInput}), 'CONFLICT');
  const product = data(await s.call('create_fi_product', fiInput));
  data(await s.call('update_fi_product', {id: product.id, version: 1, ...fiInput}));
  refused(await s.call('update_fi_product', {id: product.id, version: 1, ...fiInput}), 'CONFLICT');
});

const servicePartsWrites = ['create_appointment', 'update_appointment', 'create_repair_order', 'update_repair_order', 'set_repair_order_status',
  'create_technician', 'update_technician', 'create_labor_rate', 'update_labor_rate', 'create_part', 'update_part', 'record_part_sale',
  'create_purchase_order', 'receive_purchase_order', 'fulfill_special_order', 'create_part_return', 'update_pricing_matrix', 'create_part_reservation', 'release_part_reservation'];
const partInput = {partNumber: 'MCP-PART', description: 'Filter', binLocation: 'A1', location: 'Main', costCents: 123, retailPriceCents: 456, quantityOnHand: 10, reorderPoint: 2};
const partsLine = (partId: string, quantity = 1) => ({kind: 'parts', description: 'Filter', partId, quantity, unitPriceCents: 456, laborHoursHundredths: null, laborRateCents: null});
const appointmentInput = {scheduledStart: '2026-11-01T10:00:00Z', scheduledEnd: '2026-11-01T11:00:00Z', concern: 'Oil change'};

test('service MCP creates and partially updates appointments, catalogs and repair orders with agent attribution', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), customerId = (await repo.crmList('customer'))[0].id;
  const before = (await repo.events()).length;
  const tech = data(await s.call('create_technician', {name: 'MCP Tech', skills: ['brakes']}));
  const updatedTech = data(await s.call('update_technician', {id: tech.id, version: 1, name: 'Renamed'}));
  assert.deepEqual(updatedTech.skills, ['brakes']);
  refused(await s.call('update_technician', {id: tech.id, version: 1, name: 'Stale'}), 'CONFLICT');
  // Remove no seed data: choose an unconfigured skill for the create path.
  const configured = await repo.crmList('labor-rate');
  const skill = ['general', 'brakes', 'diesel', 'electrical', 'diagnostics', 'engine', 'transmission', 'suspension', 'hvac', 'tires'].find(k => !configured.some(r => r.skill === k))!;
  assert.ok(skill);
  const rate = data(await s.call('create_labor_rate', {skill, laborRateCents: 10001}));
  assert.equal(rate.id, skill);
  assert.equal(data(await s.call('update_labor_rate', {id: rate.id, version: 1, laborRateCents: 12001})).skill, skill);
  refused(await s.call('update_labor_rate', {id: rate.id, version: 1, laborRateCents: 12002}), 'CONFLICT');
  refused(await s.call('update_labor_rate', {id: rate.id, version: 2, skill: skill === 'brakes' ? 'general' : 'brakes'}), 'VALIDATION');
  const appointment = data(await s.call('create_appointment', {customerId, ...appointmentInput, technicianId: tech.id, requiredSkill: 'brakes'}));
  const changed = data(await s.call('update_appointment', {id: appointment.id, version: 1, status: 'checked-in'}));
  assert.equal(changed.concern, appointmentInput.concern); assert.equal(changed.scheduledStart, appointment.scheduledStart);
  refused(await s.call('update_appointment', {id: appointment.id, version: 1, concern: 'Stale'}), 'CONFLICT');
  refused(await s.call('update_appointment', {id: appointment.id, version: 2, requiredSkill: 'diesel'}), 'VALIDATION');
  assert.equal(data(await s.call('update_appointment', {id: appointment.id, version: 2, requiredSkill: 'diesel', acknowledgeSkillMismatch: true})).skillMismatchWarning.acknowledgedBy, 'admin-A');
  const part = data(await s.call('create_part', partInput));
  const labor = {kind: 'labor', description: 'Labor', skill, laborHoursHundredths: 100, quantity: null, unitPriceCents: null, partId: null};
  let ro = data(await s.call('create_repair_order', {appointmentId: appointment.id, payType: 'customer-pay', lineItems: [labor, partsLine(part.id)]}));
  assert.equal(ro.customerId, customerId); assert.equal(ro.lineItems[0].laborRateCents, 12001);
  const originalLabor = ro.lineItems[0];
  ro = data(await s.call('update_repair_order', {id: ro.id, version: ro.version, lineItems: [originalLabor, partsLine(part.id, 2)]}));
  assert.deepEqual(ro.lineItems[0], originalLabor); assert.equal(ro.lineItems.length, 2); assert.equal(ro.lineItems[1].quantity, 2);
  assert.equal(ro.payType, 'customer-pay'); assert.equal(ro.concern, appointmentInput.concern);
  refused(await s.call('update_repair_order', {id: ro.id, version: 1, concern: 'Stale'}), 'CONFLICT');
  ro = data(await s.call('set_repair_order_status', {id: ro.id, version: ro.version, status: 'completed'}));
  assert.equal(ro.status, 'completed'); assert.equal((await repo.crmGet('part', part.id))!.quantityOnHand, 8);
  assert.equal((await repo.crmGet('service-appointment', appointment.id))!.status, 'done');
  const events = (await repo.events()).slice(before);
  assert.ok(events.length > 10); assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
});

test('parts MCP sales, receiving, special fulfillment, returns, matrix and RO reservations preserve stock semantics', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), customerId = (await repo.crmList('customer'))[0].id;
  const before = (await repo.events()).length;
  const part = data(await s.call('create_part', partInput));
  const updated = data(await s.call('update_part', {id: part.id, version: 1, description: 'Updated filter'}));
  assert.equal(updated.costCents, 123); assert.equal(updated.quantityOnHand, 10); assert.equal(updated.partNumber, partInput.partNumber);
  refused(await s.call('update_part', {id: part.id, version: 1, description: 'Stale'}), 'CONFLICT');
  const stock = async (onHand: number, reserved: number) => {
    const p = (await repo.crmGet('part', part.id))!; assert.equal(p.quantityOnHand, onHand); assert.equal(p.quantityReserved, reserved);
  };
  assert.equal(data(await s.call('record_part_sale', {partId: part.id, quantity: 2})).unitPriceCents, 456); await stock(8, 0);
  let ro = data(await s.call('create_repair_order', {customerId, payType: 'customer-pay', lineItems: [partsLine(part.id, 2)]}));
  const po = data(await s.call('create_purchase_order', {vendorName: 'Vendor', lines: [{partId: part.id, quantityOrdered: 3, costCents: 125, specialOrder: {customerId, repairOrderId: ro.id}}]}));
  const received = data(await s.call('receive_purchase_order', {id: po.id, version: 1, lines: [{lineId: po.lines[0].id, quantity: 3}]}));
  assert.equal(received.status, 'received'); await stock(11, 3);
  refused(await s.call('receive_purchase_order', {id: po.id, version: 1, lines: [{lineId: po.lines[0].id, quantity: 1}]}), 'CONFLICT');
  data(await s.call('fulfill_special_order', {id: po.id, version: 2, lineId: po.lines[0].id})); await stock(8, 0);
  refused(await s.call('fulfill_special_order', {id: po.id, version: 2, lineId: po.lines[0].id}), 'CONFLICT');
  data(await s.call('create_part_return', {partId: part.id, vendorName: 'Vendor', quantity: 1, reason: 'Damaged', purchaseOrderId: po.id})); await stock(7, 0);
  const matrix = (await repo.crmGet('pricing-matrix', 'pricing-matrix'));
  const pricing = {version: matrix?.version ?? 0, enabled: true, brackets: [{maxCostCents: 500, markupBps: 5000}, {maxCostCents: null, markupBps: 2500}]};
  assert.deepEqual(data(await s.call('update_pricing_matrix', pricing)).brackets, pricing.brackets);
  refused(await s.call('update_pricing_matrix', pricing), 'CONFLICT');
  const reservation = data(await s.call('create_part_reservation', {partId: part.id, repairOrderId: ro.id, quantity: 3}));
  assert.equal(reservation.customerId, customerId); await stock(7, 3);
  data(await s.call('release_part_reservation', {id: reservation.id, version: 1, quantity: 1})); await stock(7, 2);
  refused(await s.call('release_part_reservation', {id: reservation.id, version: 1}), 'CONFLICT');
  ro = data(await s.call('set_repair_order_status', {id: ro.id, version: ro.version, status: 'completed'})); await stock(5, 0);
  assert.equal((await repo.crmGet('parts-reservation', reservation.id))!.quantityConsumed, 2);
  ro = data(await s.call('set_repair_order_status', {id: ro.id, version: ro.version, status: 'open'})); await stock(7, 2);
  const restored = (await repo.crmGet('parts-reservation', reservation.id))!;
  assert.equal(restored.quantityConsumed, 0);
  data(await s.call('release_part_reservation', {id: reservation.id, version: restored.version})); await stock(7, 0);
  const events = (await repo.events()).slice(before);
  assert.ok(events.length > 20); assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
});

test('MCP reserved-stock and negative-stock overrides require explicit acknowledgement and record the OAuth actor', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), customerId = (await repo.crmList('customer'))[0].id;
  const part = data(await s.call('create_part', {...partInput, quantityOnHand: 0}));
  const owner = data(await s.call('create_repair_order', {customerId, payType: 'customer-pay'}));
  const po = data(await s.call('create_purchase_order', {vendorName: 'Vendor', lines: [{partId: part.id, quantityOrdered: 2, costCents: 123, specialOrder: {repairOrderId: owner.id}}]}));
  data(await s.call('receive_purchase_order', {id: po.id, version: 1, lines: [{lineId: po.lines[0].id, quantity: 2}]}));
  const ro = data(await s.call('create_repair_order', {customerId, payType: 'customer-pay', lineItems: [partsLine(part.id, 2)]}));
  const args = {id: ro.id, version: 1, status: 'completed'};
  const before = (await repo.events()).length;
  refused(await s.call('set_repair_order_status', args), 'VALIDATION');
  refused(await s.call('set_repair_order_status', {...args, acknowledgeReservedStock: false}), 'VALIDATION');
  assert.equal((await repo.events()).length, before);
  const completed = data(await s.call('set_repair_order_status', {...args, acknowledgeReservedStock: true}));
  assert.equal(completed.reservedStockWarning.acknowledgedBy, 'admin-A');
  assert.ok((await repo.events()).slice(before).some(e => e.action?.startsWith('repair-order.reserved-stock-acknowledged') && e.actorType === 'agent' && e.actorId === 'admin-A'));
  const empty = data(await s.call('create_part', {...partInput, partNumber: 'EMPTY', quantityOnHand: 0}));
  const sale = {partId: empty.id, quantity: 1};
  refused(await s.call('record_part_sale', sale), 'VALIDATION');
  assert.equal(data(await s.call('record_part_sale', {...sale, allowNegativeStock: true})).stockNegative, true);
  assert.equal((await repo.crmGet('part', empty.id))!.quantityOnHand, -1);
  const negativeRo = data(await s.call('create_repair_order', {customerId, payType: 'customer-pay', lineItems: [partsLine(empty.id)]}));
  const transition = {id: negativeRo.id, version: 1, status: 'completed'};
  refused(await s.call('set_repair_order_status', transition), 'VALIDATION');
  data(await s.call('set_repair_order_status', {...transition, allowNegativeStock: true}));
  assert.equal((await repo.crmGet('part', empty.id))!.quantityOnHand, -2);
});

test('all service/parts MCP writes enforce scopes, roles and tenant isolation without side effects', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B'), jwt = token({sub: 'admin-B'});
  const customerId = (await other.crmList('customer'))[0].id;
  const part = data(await s.call('create_part', partInput, jwt));
  const appointment = data(await s.call('create_appointment', {customerId, ...appointmentInput}, jwt));
  const ro = data(await s.call('create_repair_order', {customerId, payType: 'customer-pay'}, jwt));
  const tech = data(await s.call('create_technician', {name: 'Foreign', skills: ['general']}, jwt));
  const configured = await repo.crmList('labor-rate');
  const skill = ['general', 'brakes', 'diesel', 'electrical', 'diagnostics', 'engine', 'transmission', 'suspension', 'hvac', 'tires'].find(k => !configured.some(r => r.skill === k))!;
  data(await s.call('create_labor_rate', {skill, laborRateCents: 100}, jwt));
  const po = data(await s.call('create_purchase_order', {vendorName: 'Foreign', lines: [{partId: part.id, quantityOrdered: 1, costCents: 123}]}, jwt));
  const reservation = data(await s.call('create_part_reservation', {partId: part.id, repairOrderId: ro.id, quantity: 1}, jwt));
  const cases: [string, Record<string, unknown>, string][] = [
    ['create_appointment', {customerId, ...appointmentInput}, 'VALIDATION'],
    ['update_appointment', {id: appointment.id, version: 1, concern: 'Foreign'}, 'NOT_FOUND'],
    ['create_repair_order', {customerId, payType: 'customer-pay'}, 'VALIDATION'],
    ['update_repair_order', {id: ro.id, version: 1, concern: 'Foreign'}, 'NOT_FOUND'],
    ['set_repair_order_status', {id: ro.id, version: 1, status: 'completed'}, 'NOT_FOUND'],
    ['update_technician', {id: tech.id, version: 1, name: 'Foreign'}, 'NOT_FOUND'],
    ['update_labor_rate', {id: skill, version: 1, laborRateCents: 200}, 'NOT_FOUND'],
    ['update_part', {id: part.id, version: 1, description: 'Foreign'}, 'NOT_FOUND'],
    ['record_part_sale', {partId: part.id, quantity: 1}, 'VALIDATION'],
    ['create_purchase_order', {vendorName: 'Foreign', lines: [{partId: part.id, quantityOrdered: 1, costCents: 123}]}, 'VALIDATION'],
    ['receive_purchase_order', {id: po.id, version: 1, lines: [{lineId: po.lines[0].id, quantity: 1}]}, 'NOT_FOUND'],
    ['fulfill_special_order', {id: po.id, version: 1, lineId: po.lines[0].id}, 'NOT_FOUND'],
    ['create_part_return', {partId: part.id, vendorName: 'Foreign', quantity: 1, reason: 'Return'}, 'VALIDATION'],
    ['create_part_reservation', {partId: part.id, repairOrderId: ro.id, quantity: 1}, 'VALIDATION'],
    ['release_part_reservation', {id: reservation.id, version: 1}, 'NOT_FOUND'],
  ];
  const before = (await repo.events()).length, otherBefore = (await other.events()).length;
  for (const [name, args, code] of cases) refused(await s.call(name, args), code);
  const reads = (await s.request('tools/list', {}, token({scope: 'freedms/mcp.read'}))).result.tools;
  const listed = (await s.request('tools/list')).result.tools;
  assert.equal(servicePartsWrites.length, 19);
  for (const name of servicePartsWrites) {
    assert.ok(listed.some((t: any) => t.name === name)); assert.ok(!reads.some((t: any) => t.name === name));
    assert.equal((await s.request('tools/call', {name}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
    refused(await s.call(name, {tenantId: 'B'}), 'VALIDATION');
  }
  for (const role of ['viewer', 'inactive']) {
    const factory = {tenantForSubject: async () => 'A', forTenant: () => ({...repo, membership: async () => ({tenantId: 'A', userId: 'admin-A', active: role !== 'inactive', role: (role === 'inactive' ? 'admin' : 'viewer') as 'admin'})})};
    const handle = createHandler(factory, {decode: async () => {throw Error('Network forbidden');}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
    for (const name of servicePartsWrites) {
      const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: cases.find(c => c[0] === name)?.[1] ?? {}}})});
      assert.equal(JSON.parse(response.body).error.message, 'Tool unavailable.', name);
    }
  }
  assert.ok(!tools.some(t => /signatures|photos/.test(t.path) || t.method === 'DELETE'));
  assert.equal((await repo.events()).length, before); assert.equal((await other.events()).length, otherBefore);
  // Creates and singleton updates without foreign IDs always remain in the OAuth tenant.
  data(await s.call('create_part', partInput));
  data(await s.call('create_technician', {name: 'Local', skills: []}));
  data(await s.call('create_labor_rate', {skill, laborRateCents: 300}));
  data(await s.call('update_pricing_matrix', {version: (await repo.crmGet('pricing-matrix', 'pricing-matrix'))?.version ?? 0, enabled: false, brackets: []}));
  assert.equal((await other.events()).length, otherBefore);
  assert.equal((await other.crmGet('labor-rate', skill))!.laborRateCents, 100);
  const restBefore = (await repo.events()).length;
  for (const [path, body] of [['/parts', {...partInput, partNumber: 'REST-PART'}], ['/service/technicians', {name: 'REST Tech', skills: []}]] as const) {
    assert.equal((await s.handle({method: 'POST', path, claims: restClaims, body: JSON.stringify(body)})).statusCode, 201);
  }
  const restEvents = (await repo.events()).slice(restBefore);
  assert.equal(restEvents.length, 2); assert.ok(restEvents.every(e => !('actorType' in e)));
});

const accountingTools = tools.filter(t => t.path.startsWith('/accounting/') && t.name !== 'get_trial_balance');
const billInput = {amount: 10000, party: 'Vendor', reference: 'MCP bill', dueDate: '2026-11-01', offsetAccountId: 'account-5000', vehicleId: null};
const periodInput = {from: '2026-10-01', to: '2026-10-29', opening: 0, closing: 0};
const statementCsv = 'id,date,description,amountCents\nimported,2026-10-28,Withdrawal,-100';
const manualLine = {id: 'manual', date: '2026-10-28', description: 'Payment', amount: -4000};
function balanced(entry: any) {
  assert.ok(entry.lines.every((l: any) => Number.isSafeInteger(l.debit) && Number.isSafeInteger(l.credit)));
  assert.equal(entry.lines.reduce((n: number, l: any) => n + l.debit, 0), entry.lines.reduce((n: number, l: any) => n + l.credit, 0));
}

test('accounting MCP accounts, AP/AR, reversals and reports preserve REST rules and attribution', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), before = (await repo.events()).length;
  const account = data(await s.call('create_gl_account', {code: '5999', name: 'Expense', type: 'expense', active: true}));
  assert.equal(account.id, 'account-5999');
  const update = {id: account.id, version: 1, name: 'Renamed expense', active: true};
  assert.equal(data(await s.call('update_gl_account', update)).name, update.name);
  refused(await s.call('update_gl_account', update), 'CONFLICT');
  refused(await s.call('create_gl_account', {code: '5999', name: 'Duplicate', type: 'expense'}), 'CONFLICT');
  for (const extra of [{code: '5998'}, {type: 'asset'}]) {
    refused(await s.call('update_gl_account', {...update, version: 2, ...extra}), 'VALIDATION');
    const rest = await s.handle({method: 'PUT', path: `/accounting/accounts/${account.id}`, claims: restClaims, body: JSON.stringify({version: 2, name: 'No change', active: true, ...extra})});
    assert.equal(JSON.parse(rest.body).error.code, 'VALIDATION');
  }
  const cash = data(await s.call('create_cash_account', {code: '1099', name: 'MCP bank'}));
  assert.deepEqual(data(await s.call('get_cash_register', {id: cash.id})), []);
  for (const kind of ['ap', 'ar']) {
    const input = {...billInput, offsetAccountId: kind === 'ap' ? account.id : 'account-4000'};
    const entry = data(await s.call(kind === 'ap' ? 'create_ap_bill' : 'create_ar_invoice', input)); balanced(entry);
    const report = data(await s.call(`get_${kind}_aging`, {asOf: '2026-10-30'}));
    const item = report.rows.find((r: any) => r.id === entry.lines[0].itemId); assert.ok(item); assert.equal(item.balance, 10000);
    const payment = {id: item.id, amount: 4000, cashAccountId: cash.id, reference: 'Partial payment'};
    refused(await s.call(`record_${kind}_payment`, {...payment, amount: 10001}), 'VALIDATION');
    balanced(data(await s.call(`record_${kind}_payment`, payment)));
    assert.equal(data(await s.call(`get_${kind}_aging`)).rows.find((r: any) => r.id === item.id).balance, 6000);
    for (const amount of [-1, 1.5, 0]) refused(await s.call(kind === 'ap' ? 'create_ap_bill' : 'create_ar_invoice', {...input, amount}), 'VALIDATION');
  }
  refused(await s.call('create_ap_bill', {...billInput, offsetAccountId: 'account-4000'}), 'VALIDATION');
  const original = data(await s.call('list_journal_entries')).find((e: any) => e.source === 'ap');
  const reversal = data(await s.call('reverse_journal_entry', {id: original.id})); balanced(reversal);
  assert.deepEqual(reversal.lines.map((l: any) => [l.debit, l.credit]), original.lines.map((l: any) => [l.credit, l.debit]));
  assert.equal(data(await s.call('list_journal_entries')).find((e: any) => e.id === original.id).reversed, true);
  refused(await s.call('reverse_journal_entry', {id: original.id}), 'CONFLICT');
  refused(await s.call('reverse_journal_entry', {id: reversal.id}), 'CONFLICT');
  const period = data(await s.call('create_reconciliation', {accountId: cash.id, ...periodInput}));
  const events = (await repo.events()).slice(before); assert.ok(events.length > 10);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
  const readBefore = (await repo.events()).length;
  for (const t of accountingTools.filter(t => t.method === 'GET')) {
    const args = t.name === 'get_deal_accounting' ? {id: (await repo.crmList('deal'))[0].id} : t.name === 'get_cash_register' ? {id: cash.id} : t.name === 'get_reconciliation' ? {id: period.id} : {};
    const result = await s.call(t.name, args, token({scope: 'freedms/mcp.read'})); data(result);
    const rest = await s.handle({method: 'GET', path: t.path.replace(':id', args.id!), claims: restClaims});
    assert.deepEqual(result.structuredContent, JSON.parse(rest.body), t.name);
  }
  for (const [name, query] of [['list_journal_entries', {from: '2026-10-01', to: '2026-10-30', accountId: cash.id}], ['get_departmental_statement', {from: '2026-10-01', to: '2026-10-29'}], ['get_commissions', {from: '2026-10-01', to: '2026-10-29'}]] as const) {
    const t = tools.find(t => t.name === name)!;
    const rest = await s.handle({method: 'GET', path: t.path, query, claims: restClaims});
    assert.deepEqual((await s.call(name, query)).structuredContent, JSON.parse(rest.body));
  }
  assert.equal((await repo.events()).length, readBefore);
  const rest = await s.handle({method: 'POST', path: '/accounting/cash', claims: restClaims, body: JSON.stringify({code: '1096', name: 'REST bank'})});
  assert.equal(rest.statusCode, 201);
  const restEvents = (await repo.events()).slice(readBefore);
  assert.equal(restEvents.length, 2); assert.ok(restEvents.every(e => !('actorType' in e)));
});

test('accounting MCP reconciliation preview/import, signed amounts, matching and closing use service invariants', async () => {
  let date = new Date('2026-10-28T12:00:00Z');
  const s = await setup(undefined, () => date), repo = s.repositories.forTenant('A'), before = (await repo.events()).length;
  const cash = data(await s.call('create_cash_account', {code: '1098', name: 'Reconciliation bank'}));
  const bill = data(await s.call('create_ap_bill', billInput));
  data(await s.call('record_ap_payment', {id: bill.lines[0].itemId, amount: 4000, cashAccountId: cash.id, reference: 'Withdrawal'}));
  const register = data(await s.call('get_cash_register', {id: cash.id})); assert.equal(register[0].amount, -4000);
  date = now;
  refused(await s.call('create_reconciliation', {accountId: cash.id, ...periodInput, to: '2026-10-30'}), 'VALIDATION');
  refused(await s.call('create_reconciliation', {accountId: cash.id, ...periodInput, opening: -100}), 'VALIDATION');
  let period = data(await s.call('create_reconciliation', {accountId: cash.id, ...periodInput, closing: -4000}));
  const previewBefore = (await repo.events()).length;
  const preview = data(await s.call('preview_reconciliation_statement', {id: period.id, csv: statementCsv}));
  assert.equal(preview.validCount, 1); assert.equal((await repo.events()).length, previewBefore);
  const importArgs = {id: period.id, version: period.version, csv: statementCsv, previewToken: preview.previewToken};
  refused(await s.call('import_reconciliation_statement', {...importArgs, previewToken: 'wrong'}), 'CONFLICT');
  period = data(await s.call('import_reconciliation_statement', importArgs));
  refused(await s.call('import_reconciliation_statement', importArgs), 'CONFLICT');
  for (const csv of [statementCsv, 'id,date,description,amountCents\nbad,2026-10-30,Bad,1']) {
    const p = data(await s.call('preview_reconciliation_statement', {id: period.id, csv}));
    refused(await s.call('import_reconciliation_statement', {id: period.id, version: period.version, csv, previewToken: p.previewToken}), 'VALIDATION');
  }
  period = data(await s.call('add_reconciliation_line', {id: period.id, version: period.version, line: manualLine}));
  refused(await s.call('close_reconciliation', {id: period.id, version: period.version}), 'VALIDATION');
  refused(await s.call('add_reconciliation_line', {id: period.id, version: 1, line: {...manualLine, id: 'stale'}}), 'CONFLICT');
  refused(await s.call('match_reconciliation_line', {id: period.id, version: period.version, lineId: 'imported', registerId: register[0].id}), 'VALIDATION');
  const match = (registerId: string | null) => s.call('match_reconciliation_line', {id: period.id, version: period.version, lineId: manualLine.id, registerId});
  period = data(await match(register[0].id)); assert.equal(period.lines.find((l: any) => l.id === 'manual').registerId, register[0].id);
  refused(await s.call('match_reconciliation_line', {id: period.id, version: 1, lineId: 'manual', registerId: null}), 'CONFLICT');
  period = data(await match(null)); assert.equal(period.lines.find((l: any) => l.id === 'manual').registerId, null);
  period = data(await match(register[0].id));
  period = data(await s.call('amend_reconciliation', {id: period.id, version: period.version, closing: -4100}));
  refused(await s.call('amend_reconciliation', {id: period.id, version: 1, closing: -4000}), 'CONFLICT');
  refused(await s.call('remove_reconciliation_line', {id: period.id, version: 1, lineId: 'imported'}), 'CONFLICT');
  period = data(await s.call('remove_reconciliation_line', {id: period.id, version: period.version, lineId: 'imported'}));
  refused(await s.call('close_reconciliation', {id: period.id, version: period.version}), 'VALIDATION');
  period = data(await s.call('amend_reconciliation', {id: period.id, version: period.version, closing: -4000}));
  assert.equal(period.difference, 0); assert.equal(period.statementDifference, 0); assert.equal(period.unmatchedCount, 0);
  refused(await s.call('close_reconciliation', {id: period.id, version: 1}), 'CONFLICT');
  period = data(await s.call('close_reconciliation', {id: period.id, version: period.version})); assert.equal(period.status, 'reconciled');
  refused(await s.call('amend_reconciliation', {id: period.id, version: period.version, closing: 0}), 'CONFLICT');
  refused(await s.call('create_reconciliation', {accountId: cash.id, from: '2026-10-29', to: '2026-10-29', opening: -4000, closing: -4000}), 'VALIDATION');
  const events = (await repo.events()).slice(before); assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
});

test('every accounting MCP tool enforces scope, membership and tenant isolation without refused-call events', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B'), jwt = token({sub: 'admin-B'});
  const cash = data(await s.call('create_cash_account', {code: '1097', name: 'Foreign bank'}, jwt));
  const gl = data(await s.call('create_gl_account', {code: '5997', name: 'Foreign expense', type: 'expense'}, jwt));
  const bill = data(await s.call('create_ap_bill', billInput, jwt));
  const invoice = data(await s.call('create_ar_invoice', {...billInput, offsetAccountId: 'account-4000'}, jwt));
  const period = data(await s.call('create_reconciliation', {accountId: cash.id, ...periodInput}, jwt));
  const cases: [string, Record<string, unknown>, string][] = [
    ['update_gl_account', {id: gl.id, version: 1, name: 'Foreign', active: true}, 'NOT_FOUND'],
    ['get_cash_register', {id: cash.id}, 'NOT_FOUND'],
    ['reverse_journal_entry', {id: bill.id}, 'NOT_FOUND'],
    ['get_deal_accounting', {id: (await other.crmList('deal'))[0].id}, 'NOT_FOUND'],
    ['record_ap_payment', {id: bill.lines[0].itemId, amount: 1, cashAccountId: cash.id, reference: 'Foreign'}, 'NOT_FOUND'],
    ['record_ar_payment', {id: invoice.lines[0].itemId, amount: 1, cashAccountId: cash.id, reference: 'Foreign'}, 'NOT_FOUND'],
    ['create_ap_bill', {...billInput, offsetAccountId: gl.id}, 'NOT_FOUND'],
    ['create_ar_invoice', {...billInput, offsetAccountId: gl.id}, 'NOT_FOUND'],
    ['create_reconciliation', {accountId: cash.id, ...periodInput}, 'NOT_FOUND'],
    ['get_reconciliation', {id: period.id}, 'NOT_FOUND'],
    ['preview_reconciliation_statement', {id: period.id, csv: statementCsv}, 'NOT_FOUND'],
    ['import_reconciliation_statement', {id: period.id, version: 1, csv: statementCsv, previewToken: 'foreign'}, 'NOT_FOUND'],
    ['add_reconciliation_line', {id: period.id, version: 1, line: manualLine}, 'NOT_FOUND'],
    ['amend_reconciliation', {id: period.id, version: 1, closing: 0}, 'NOT_FOUND'],
    ['remove_reconciliation_line', {id: period.id, version: 1, lineId: 'foreign'}, 'NOT_FOUND'],
    ['match_reconciliation_line', {id: period.id, version: 1, lineId: 'foreign', registerId: null}, 'NOT_FOUND'],
    ['close_reconciliation', {id: period.id, version: 1}, 'NOT_FOUND'],
  ];
  const before = (await repo.events()).length, otherBefore = (await other.events()).length;
  for (const [name, args, code] of cases) refused(await s.call(name, args), code);
  const reads = (await s.request('tools/list', {}, token({scope: 'freedms/mcp.read'}))).result.tools;
  const listed = (await s.request('tools/list')).result.tools;
  assert.equal(accountingTools.length, 28);
  for (const t of accountingTools) {
    assert.ok(listed.some((r: any) => r.name === t.name));
    assert.equal(reads.some((r: any) => r.name === t.name), t.method === 'GET', t.name);
    if (t.method !== 'GET') assert.equal((await s.request('tools/call', {name: t.name}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
    refused(await s.call(t.name, {tenantId: 'B'}), 'VALIDATION');
  }
  for (const role of ['viewer', 'inactive']) {
    const factory = {tenantForSubject: async () => 'A', forTenant: () => ({...repo, membership: async () => ({tenantId: 'A', userId: 'admin-A', active: role !== 'inactive', role: (role === 'inactive' ? 'admin' : 'viewer') as 'admin'})})};
    const handle = createHandler(factory, {decode: async () => {throw Error('Network forbidden');}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
    for (const t of accountingTools) {
      const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: t.name}})});
      assert.equal(JSON.parse(response.body).error.message, 'Tool unavailable.', t.name);
    }
  }
  for (const t of accountingTools.filter(t => t.method === 'GET' && !t.path.includes(':id'))) {
    const result = await s.call(t.name); data(result);
    assert.ok(!result.content[0].text.includes('"tenantId":"B"'));
    for (const id of [cash.id, gl.id, bill.id, invoice.id, period.id]) assert.ok(!result.content[0].text.includes(id), t.name);
  }
  assert.equal((await repo.events()).length, before); assert.equal((await other.events()).length, otherBefore);
});

// Issue #76 tools occupy the first contiguous block of the registry.
const parityTools = tools.slice(0, tools.findIndex(t => t.name === 'list_gl_accounts'));
const documentInput = {name: 'Proof.txt', type: 'other', content: Buffer.from('offline document').toString('base64')};
const userInput = {name: 'New user', email: 'new@example.test', role: 'staff'};
const webhookInput = {url: 'https://receiver.example.test/events', eventTypes: ['vehicle.created']};
const feedInput = {formats: ['csv', 'json'], includedStatuses: ['available'], requirePrice: true, schedule: 'manual'};
const reportInput = {name: 'Inventory', dataset: 'inventory', columns: ['stockNumber', 'vehicle'], from: '2020-01-01', to: '2026-10-30'};
async function staffToken(s: Awaited<ReturnType<typeof setup>>) {
  const user = data(await s.call('create_user', {...userInput, email: 'staff76@example.test'}));
  return token({sub: user.userId});
}

test('documents MCP upload, search, content, retention and confirmed disposal reuse storage and audit', async () => {
  const store = new MemoryDocumentStore(), s = await setup(undefined, undefined, store), repo = s.repositories.forTenant('A');
  const staff = await staffToken(s), id = (await repo.crmList('deal'))[0].id, before = (await repo.events()).length;
  const doc = data(await s.call('upload_document', {id, ...documentInput}, staff));
  assert.deepEqual(await repo.crmGet('document', doc.id), doc);
  assert.equal(Buffer.from((await store.forTenant('A').get(doc.id))!).toString(), 'offline document');
  assert.equal(data(await s.call('get_document_content', {id, documentId: doc.id})).content, documentInput.content);
  const query = {name: 'Proof', type: 'other', buyer: id, from: '2026-10-30', to: '2026-10-30'};
  assert.deepEqual(data(await s.call('search_documents', query)).map((d: any) => d.id), [doc.id]);
  assert.equal(data(await s.call('search_documents', {...query, name: 'missing'})).length, 0);
  const retention = data(await s.call('get_document_retention'));
  data(await s.call('update_document_retention', {version: retention.version, retentionDays: 1}));
  assert.equal((await repo.crmGet('retention', 'workspace'))!.retentionDays, 1);
  refused(await s.call('update_document_retention', {version: retention.version, retentionDays: null}), 'CONFLICT');
  data(await s.call('update_document_retention', {version: retention.version + 1, retentionDays: null}));
  assert.equal((await repo.crmGet('retention', 'workspace'))!.retentionDays, null);
  data(await s.call('list_past_retention_documents'));
  const unchanged = (await repo.events()).length;
  for (const confirm of [undefined, false, 'true']) refused(await s.call('dispose_document', {id: doc.id, version: 1, confirm}), 'VALIDATION');
  refused(await s.call('upload_document', {id, ...documentInput, content: Buffer.alloc(40961).toString('base64')}), 'VALIDATION');
  assert.equal((await repo.events()).length, unchanged); assert.ok(await store.forTenant('A').get(doc.id));
  const disposed = data(await s.call('dispose_document', {id: doc.id, version: 1, confirm: true}));
  assert.equal(disposed.status, 'disposed'); assert.deepEqual(await repo.crmGet('document', doc.id), disposed);
  assert.equal(await store.forTenant('A').get(doc.id), undefined);
  refused(await s.call('get_document_content', {id, documentId: doc.id}), 'DOCUMENT_DISPOSED');
  const events = (await repo.events()).slice(before); assert.equal(events.length, 5);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === (e.type === 'document.created' ? JSON.parse(Buffer.from(staff.split('.')[1], 'base64url').toString()).sub : 'admin-A')));
  const noStore = await setup(), r = noStore.repositories.forTenant('A'), deal = (await r.crmList('deal'))[0];
  refused(await noStore.call('upload_document', {id: deal.id, ...documentInput}), 'STORAGE_UNAVAILABLE');
  const existing = {...doc, dealId: deal.id};
  await r.crmWrite([{record: existing, expectedVersion: 0, event: {id: randomUUID(), tenantId: 'A', actorId: 'admin-A', aggregateId: existing.id, aggregateVersion: 1, type: 'document.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'}}]);
  refused(await noStore.call('dispose_document', {id: existing.id, version: existing.version, confirm: true}), 'STORAGE_UNAVAILABLE');
});

test('admin MCP user and invite mutations preserve confirmations, last admin and conflicts', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), before = (await repo.events()).length;
  const admin = (await repo.membership('admin-A'))!;
  refused(await s.call('set_user_role', {id: 'admin-A', version: admin.version ?? 0, role: 'staff'}), 'LAST_ADMIN');
  refused(await s.call('deactivate_user', {id: 'admin-A', version: admin.version ?? 0, confirm: true}), 'LAST_ADMIN');
  assert.equal((await repo.events()).length, before);
  let user = data(await s.call('create_user', userInput));
  assert.equal((await repo.membership(user.userId))!.role, 'staff');
  refused(await s.call('create_user', userInput), 'DUPLICATE_EMAIL');
  user = data(await s.call('set_user_role', {id: user.userId, version: user.version, role: 'admin'}));
  assert.equal((await repo.membership(user.userId))!.role, 'admin');
  const unchanged = (await repo.events()).length;
  for (const confirm of [undefined, false, 'true']) refused(await s.call('deactivate_user', {id: user.userId, version: user.version, confirm}), 'VALIDATION');
  refused(await s.call('set_user_role', {id: user.userId, version: user.version, role: 'staff', active: false}), 'VALIDATION');
  assert.equal((await repo.events()).length, unchanged);
  user = data(await s.call('deactivate_user', {id: user.userId, version: user.version, confirm: true}));
  assert.equal((await repo.membership(user.userId))!.active, false);
  user = data(await s.call('reactivate_user', {id: user.userId, version: user.version}));
  assert.equal((await repo.membership(user.userId))!.active, true);
  const input = {...userInput, email: 'invite@example.test'};
  let invite = data(await s.call('invite_user', input)); assert.ok(invite.token);
  assert.deepEqual(await repo.crmGet('invite', invite.id), invite);
  refused(await s.call('invite_user', input), 'CONFLICT');
  refused(await s.call('invite_user', userInput), 'CONFLICT');
  const oldToken = invite.token;
  invite = data(await s.call('reissue_invite', {id: invite.id, version: invite.version}));
  assert.notEqual(invite.token, oldToken); assert.deepEqual(await repo.crmGet('invite', invite.id), invite);
  const revokeBefore = (await repo.events()).length;
  for (const confirm of [undefined, false, 'true']) refused(await s.call('revoke_invite', {id: invite.id, version: invite.version, confirm}), 'VALIDATION');
  assert.equal((await repo.events()).length, revokeBefore);
  invite = data(await s.call('revoke_invite', {id: invite.id, version: invite.version, confirm: true}));
  assert.equal((await repo.crmGet('invite', invite.id))!.status, 'revoked');
  refused(await s.call('reissue_invite', {id: invite.id, version: invite.version}), 'CONFLICT');
  const events = (await repo.events()).slice(before); assert.equal(events.length, 7);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === 'admin-A'));
  const direct = await s.handle({method: 'POST', path: '/admin/users', claims: restClaims, body: JSON.stringify({...userInput, email: 'rest76@example.test'})});
  assert.equal(direct.statusCode, 201); assert.ok(!('actorType' in (await repo.events()).at(-1)!));
});

test('settings MCP preserves versions, webhook secret visibility, stub dispatch and feed snapshots', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), staff = await staffToken(s), before = (await repo.events()).length;
  const settings = data(await s.call('get_workspace_settings'));
  const input = {version: settings.version, taxRateBps: 600, taxTradeDifference: true, docFee: 10000, commissionRateBps: 1000, shareExpiryDays: 7};
  const updated = data(await s.call('update_workspace_settings', input));
  assert.deepEqual(await repo.crmGet('settings', 'workspace'), updated);
  refused(await s.call('update_workspace_settings', input), 'CONFLICT');
  const endpoint = data(await s.call('create_webhook_endpoint', webhookInput)); assert.ok(endpoint.secret);
  assert.equal((await repo.webhookEndpoint(endpoint.id))!.secret, endpoint.secret);
  assert.ok(!JSON.stringify(data(await s.call('list_webhook_endpoints'))).includes(endpoint.secret));
  assert.ok(!('secret' in data(await s.call('update_webhook_endpoint', {id: endpoint.id, version: 1, url: 'https://receiver.example.test/updated', enabled: true}))));
  assert.equal((await repo.webhookEndpoint(endpoint.id))!.url, 'https://receiver.example.test/updated');
  const rotated = data(await s.call('rotate_webhook_secret', {id: endpoint.id, version: 2}));
  assert.notEqual(rotated.secret, endpoint.secret); assert.equal((await repo.webhookEndpoint(endpoint.id))!.secret, rotated.secret);
  const dispatch = data(await s.call('dispatch_webhooks')); assert.ok(dispatch.delivered > 0);
  assert.equal((await repo.webhookDeliveries()).length, dispatch.delivered);
  data(await s.call('update_feed_config', feedInput, staff));
  assert.deepEqual((await repo.feedConfig())!.includedStatuses, ['available']);
  const run = data(await s.call('generate_feed', {}, staff));
  assert.deepEqual(await repo.feedRun(run.id), run);
  assert.ok(run.rows.length > 0); assert.ok(run.rows.every((r: any) => r.status === 'available' && r.listPriceCents > 0));
  for (const format of ['csv', 'json']) {
    const result = await s.call(`download_feed_run_${format}`, {id: run.id});
    const rest = await s.handle({method: 'GET', path: `/feeds/runs/${run.id}.${format}`, claims: restClaims});
    assert.equal(result.isError, false); assert.equal(result.content[0].text, rest.body);
    if (format === 'csv') assert.ok(!('structuredContent' in result)); else assert.deepEqual(result.structuredContent, run.rows);
  }
  const events = (await repo.events()).slice(before); assert.equal(events.length, 6);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId === (e.type.startsWith('feed.') ? run.actorId : 'admin-A')));
});

test('reports MCP saves definitions and exports every CSV byte for byte as REST', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A'), staff = await staffToken(s), before = (await repo.events()).length;
  let saved = data(await s.call('create_saved_report', reportInput, staff));
  assert.deepEqual(await repo.crmGet('saved-report', saved.id), saved);
  const update = {...reportInput, name: 'Renamed', id: saved.id, version: 1};
  saved = data(await s.call('update_saved_report', update, staff));
  assert.deepEqual(await repo.crmGet('saved-report', saved.id), saved);
  refused(await s.call('update_saved_report', update, staff), 'CONFLICT');
  refused(await s.call('create_saved_report', {...reportInput, columns: ['invalid']}), 'VALIDATION');
  assert.deepEqual(data(await s.call('get_saved_report', {id: saved.id})), saved);
  for (const t of parityTools.filter(t => t.name.startsWith('export_'))) {
    const args = t.name === 'export_custom_report_csv' ? {...saved.definition, columns: saved.definition.columns.join(',')} : ['export_inventory_report_csv', 'export_lead_report_csv'].includes(t.name) ? {} : {from: '2026-01-01', to: '2026-10-30'};
    const result = await s.call(t.name, args, token({scope: 'freedms/mcp.read'}));
    const rest = await s.handle({method: 'GET', path: t.path, query: args, claims: restClaims});
    assert.equal(rest.statusCode, 200, t.name); assert.equal(result.isError, false, t.name);
    assert.equal(result.content[0].text, rest.body, t.name); assert.ok(!('structuredContent' in result));
  }
  const events = (await repo.events()).slice(before); assert.equal(events.length, 2);
  assert.ok(events.every(e => e.actorType === 'agent' && e.actorId !== 'admin-A'));
});

test('all parity MCP tools enforce scopes and membership; admin tools refuse staff without mutations', async () => {
  const s = await setup(undefined, undefined, new MemoryDocumentStore()), repo = s.repositories.forTenant('A'), staff = await staffToken(s);
  const deal = (await repo.crmList('deal'))[0], doc = data(await s.call('upload_document', {id: deal.id, ...documentInput}));
  const settings = data(await s.call('get_workspace_settings'));
  const cases: [string, Record<string, unknown>][] = [
    ['list_users', {}], ['list_invites', {}], ['list_past_retention_documents', {}], ['get_document_retention', {}],
    ['create_user', userInput], ['invite_user', userInput], ['set_user_role', {id: 'admin-A', version: 1, role: 'staff'}],
    ['deactivate_user', {id: 'admin-A', version: 1, confirm: true}], ['reactivate_user', {id: 'admin-A', version: 1}],
    ['reissue_invite', {id: 'missing', version: 1}], ['revoke_invite', {id: 'missing', version: 1, confirm: true}],
    ['update_document_retention', {version: 0, retentionDays: 30}], ['dispose_document', {id: doc.id, version: doc.version, confirm: true}],
    ['update_workspace_settings', {version: settings.version, taxRateBps: 0, taxTradeDifference: false, docFee: 0, commissionRateBps: 0, shareExpiryDays: 7}],
    ['create_webhook_endpoint', webhookInput], ['update_webhook_endpoint', {id: 'missing', version: 1, enabled: false}],
    ['rotate_webhook_secret', {id: 'missing', version: 1}], ['dispatch_webhooks', {}],
  ];
  const before = (await repo.events()).length;
  for (const [name, args] of cases) refused(await s.call(name, args, staff), 'FORBIDDEN');
  const reads = (await s.request('tools/list', {}, token({scope: 'freedms/mcp.read'}))).result.tools;
  assert.equal(parityTools.length, 41); assert.equal(parityTools.filter(t => t.method === 'GET').length, 22);
  for (const t of parityTools) {
    assert.equal(reads.some((r: any) => r.name === t.name), t.method === 'GET', t.name);
    if (t.method !== 'GET') assert.equal((await s.request('tools/call', {name: t.name}, token({scope: 'freedms/mcp.read'}))).error.message, 'Tool unavailable.');
    refused(await s.call(t.name, {tenantId: 'B'}), 'VALIDATION');
  }
  for (const role of ['viewer', 'inactive']) {
    const factory = {tenantForSubject: async () => 'A', forTenant: () => ({...repo, membership: async () => ({tenantId: 'A', userId: 'admin-A', active: role !== 'inactive', role: (role === 'inactive' ? 'admin' : 'viewer') as 'admin'})})};
    const handle = createHandler(factory, {decode: async () => {throw Error('Network forbidden');}}, () => now, undefined, undefined, undefined, undefined, {mcp: config});
    for (const t of parityTools) {
      const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token()}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: t.name}})});
      assert.equal(JSON.parse(response.body).error.message, 'Tool unavailable.', t.name);
    }
  }
  assert.equal((await repo.events()).length, before);
  assert.ok(deal.id); assert.ok(!parityTools.some(t => /signature|mfa|terms|credit/.test(t.path)));
});

test('parity MCP foreign IDs refuse without events and collection reads match tenant-scoped REST', async () => {
  const s = await setup(undefined, undefined, new MemoryDocumentStore()), repo = s.repositories.forTenant('A'), other = s.repositories.forTenant('B'), jwt = token({sub: 'admin-B'});
  const deal = (await other.crmList('deal'))[0], localDeal = (await repo.crmList('deal'))[0];
  const doc = data(await s.call('upload_document', {id: deal.id, ...documentInput}, jwt));
  const user = data(await s.call('create_user', userInput, jwt));
  const invite = data(await s.call('invite_user', {...userInput, email: 'foreign@example.test'}, jwt));
  const endpoint = data(await s.call('create_webhook_endpoint', webhookInput, jwt));
  const saved = data(await s.call('create_saved_report', reportInput, jwt));
  data(await s.call('update_feed_config', feedInput, jwt));
  const run = data(await s.call('generate_feed', {}, jwt));
  const cases: [string, Record<string, unknown>][] = [
    ['upload_document', {id: deal.id, ...documentInput}],
    ['get_document_content', {id: deal.id, documentId: doc.id}], ['get_document_content', {id: localDeal.id, documentId: doc.id}],
    ['dispose_document', {id: doc.id, version: 1, confirm: true}],
    ['set_user_role', {id: user.userId, version: 1, role: 'admin'}],
    ['deactivate_user', {id: user.userId, version: 1, confirm: true}], ['reactivate_user', {id: user.userId, version: 1}],
    ['reissue_invite', {id: invite.id, version: 1}], ['revoke_invite', {id: invite.id, version: 1, confirm: true}],
    ['update_webhook_endpoint', {id: endpoint.id, version: 1, enabled: false}], ['rotate_webhook_secret', {id: endpoint.id, version: 1}],
    ['get_saved_report', {id: saved.id}], ['update_saved_report', {id: saved.id, version: 1, ...reportInput}],
    ['download_feed_run_csv', {id: run.id}], ['download_feed_run_json', {id: run.id}],
  ];
  const before = await repo.events(), otherBefore = await other.events();
  for (const [name, args] of cases) refused(await s.call(name, args), 'NOT_FOUND');
  for (const t of parityTools.filter(t => t.method === 'GET' && !t.path.includes(':') && !t.name.startsWith('export_'))) {
    const result = await s.call(t.name, {}, token({scope: 'freedms/mcp.read'})); data(result);
    const rest = await s.handle({method: 'GET', path: t.path, claims: restClaims});
    assert.deepEqual(result.structuredContent, JSON.parse(rest.body), t.name);
    for (const id of [doc.id, user.userId, invite.id, endpoint.id, saved.id, run.id]) assert.ok(!result.content[0].text.includes(id), t.name);
  }
  assert.deepEqual(await repo.events(), before); assert.deepEqual(await other.events(), otherBefore);
  assert.deepEqual(await other.crmGet('document', doc.id), doc); assert.deepEqual(await other.crmGet('invite', invite.id), invite);
  assert.deepEqual(await other.webhookEndpoint(endpoint.id), endpoint); assert.deepEqual(await other.crmGet('saved-report', saved.id), saved);
  assert.equal((await other.membership(user.userId))!.active, true); assert.deepEqual(await other.feedRun(run.id), run);
  // ID-free writes and singleton settings always bind to A, even when B has the same email/config.
  data(await s.call('create_user', userInput)); data(await s.call('invite_user', {...userInput, email: 'foreign@example.test'}));
  data(await s.call('update_feed_config', {...feedInput, includedStatuses: ['sold']})); data(await s.call('generate_feed'));
  assert.deepEqual((await other.feedConfig())!.includedStatuses, ['available']); assert.deepEqual(await other.events(), otherBefore);
});
