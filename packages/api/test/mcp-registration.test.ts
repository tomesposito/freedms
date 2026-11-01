import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdentityProviderClient, CreateUserPoolClientCommand, DeleteUserPoolClientCommand, type CreateUserPoolClientCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { gatewayHandler } from '../src/gateway.js';
import { localAuth } from '../src/local-auth.js';
import { CognitoRegistrationClients, deleteMcpRegistration, registrationLimit, registrationWindowMs, type RegistrationClients } from '../src/mcp/registration.js';

const fields = {client_name: 'Assistant', redirect_uris: ['https://assistant.example/callback', 'http://localhost:4567/callback', 'http://127.0.0.1:9876'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'freedms/mcp.read freedms/mcp.write'};
const start = new Date('2026-11-01T12:00:00Z');
function setup(repositories = new MemoryRepositories()) {
  let now = start;
  const created: CreateUserPoolClientCommandInput[] = [], deleted: string[] = [];
  const clients: RegistrationClients = {create: async input => { created.push(input); return `client-${created.length}`; }, delete: async (pool, id) => { assert.equal(pool, 'pool'); deleted.push(id); }};
  const config = {poolId: 'pool', clients};
  const handle = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, undefined,
    {registration: config, pilotOperator: {tenantId: 'dealer', userId: 'owner'}});
  const post = (body: unknown = fields, sourceIp = '192.0.2.1') => handle({method: 'POST', path: '/mcp/register', sourceIp, body: JSON.stringify(body)});
  return {repositories, config, created, deleted, handle, post, setNow: (date: Date) => { now = date; }};
}
test('DCR creates distinct public Cognito clients with exact configuration and operator bookkeeping', async () => {
  const s = setup();
  const first = await s.post(); assert.equal(first.statusCode, 201);
  assert.deepEqual(JSON.parse(first.body), {...fields, client_id: 'client-1'});
  assert.deepEqual(s.created[0], {UserPoolId: 'pool', ClientName: fields.client_name, GenerateSecret: false,
    ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: fields.scope.split(' '), SupportedIdentityProviders: ['COGNITO'], CallbackURLs: fields.redirect_uris,
    PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, AccessTokenValidity: 1, TokenValidityUnits: {AccessToken: 'hours'}});
  assert.equal(JSON.parse((await s.post()).body).client_id, 'client-2');
  const repo = s.repositories.forTenant('operator');
  const record = await repo.mcpRegistration('client-1');
  assert.deepEqual(record, {tenantId: 'operator', client_id: 'client-1', client_name: fields.client_name, redirect_uris: fields.redirect_uris, scopes: fields.scope.split(' '), createdAt: start.toISOString()});
  assert.equal((await repo.mcpRegistrations()).length, 2); assert.deepEqual(await repo.events(), []);
  const other = s.repositories.forTenant('dealer');
  assert.equal(await other.mcpRegistration('client-1'), undefined); assert.deepEqual(await other.mcpRegistrations(), []);
  await assert.rejects(other.saveMcpRegistration(record!), /scope/);
  await other.deleteMcpRegistration('client-1'); assert.ok(await repo.mcpRegistration('client-1'));
  record!.client_name = 'mutated'; assert.equal((await repo.mcpRegistration('client-1'))?.client_name, fields.client_name);
});
test('DCR rejects invalid metadata before creating any client', async () => {
  const s = setup();
  const bad = [null, [], {}, {...fields, client_name: ''}, {...fields, tenantId: 'injected'},
    ...['http://example.com/cb', 'https://*.example.com', 'https://example.com/#', 'https://example.com/#fragment', 'https://user:pass@example.com', 'https://@example.com', 'ftp://localhost', 'http://localhost.evil/cb', 'http://127.1/cb', 'https://example.com/%2a', 'https://example.com/a b', 'https://example.com/\\cb'].map(uri => ({...fields, redirect_uris: [uri]})),
    {...fields, redirect_uris: []}, {...fields, scope: 'openid'}, {...fields, scope: 'freedms/mcp.read admin'}, {...fields, scope: ''},
    {...fields, grant_types: ['client_credentials']}, {...fields, grant_types: ['refresh_token']}, {...fields, response_types: ['token']}, {...fields, token_endpoint_auth_method: 'client_secret_basic'}];
  for (const [index, body] of bad.entries()) {
    const result = await s.post(body, `source-${index}`); assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(JSON.parse(result.body).error, 'invalid_client_metadata'); assert.ok(JSON.parse(result.body).error_description);
  }
  for (const body of ['{', 'x'.repeat(17000)]) assert.equal(JSON.parse((await s.handle({method: 'POST', path: '/mcp/register', body})).body).error, 'invalid_client_metadata');
  assert.deepEqual(s.created, []); assert.deepEqual(await s.repositories.forTenant('operator').mcpRegistrations(), []);
});
test('DCR defaults to read scope and public authorization code metadata', async () => {
  const s = setup(); const result = await s.post({client_name: 'Minimal', redirect_uris: ['https://example.com/cb']});
  assert.equal(result.statusCode, 201);
  assert.deepEqual(JSON.parse(result.body), {client_id: 'client-1', client_name: 'Minimal', redirect_uris: ['https://example.com/cb'], scope: 'freedms/mcp.read', grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none'});
});
test('DCR rate limit is per source, shared across handlers, counts failures and resets next window', async () => {
  const s = setup(); const second = setup(s.repositories);
  const results = await Promise.all(Array.from({length: registrationLimit + 3}, (_, i) => (i % 2 ? s : second).post({})));
  assert.equal(results.filter(r => r.statusCode === 400).length, registrationLimit);
  assert.equal(results.filter(r => r.statusCode === 429).length, 3);
  assert.equal(results.find(r => r.statusCode === 429)?.headers['retry-after'], '300');
  assert.equal((await s.post(fields, '192.0.2.2')).statusCode, 201);
  s.setNow(new Date(start.getTime() + registrationWindowMs)); assert.equal((await s.post()).statusCode, 201);
});
test('DCR is public through gateway/local adapters and uses gateway source context', async () => {
  const s = setup(); const gateway = gatewayHandler(s.handle, 'issuer', 'audience');
  const event = {rawPath: '/mcp/register', body: JSON.stringify(fields), headers: {'x-forwarded-for': 'spoof'}, requestContext: {http: {method: 'POST', sourceIp: '192.0.2.10'}}};
  for (let i = 0; i < registrationLimit; i++) assert.equal((await gateway(event)).statusCode, 201);
  assert.equal((await gateway({...event, headers: {'x-forwarded-for': 'other-spoof'}})).statusCode, 429);
  assert.equal((await gateway({...event, requestContext: {http: {method: 'POST', sourceIp: '192.0.2.11'}}})).statusCode, 201);
  assert.ok(localAuth('/mcp/register/', false, '', {verify: () => { throw Error('Must be public'); }}));
  assert.equal((await s.handle({path: '/mcp/register', method: 'GET'})).statusCode, 405);
});
test('operator cleanup deletes Cognito then record, preserves record on failure and restricts route access', async () => {
  const s = setup(); await s.post();
  const repo = s.repositories.forTenant('operator');
  await assert.rejects(deleteMcpRegistration(s.repositories, {...s.config, clients: {...s.config.clients, delete: async () => { throw Error('offline failure'); }}}, 'client-1'), /offline failure/);
  assert.ok(await repo.mcpRegistration('client-1'));
  for (const [tenantId, role] of [['dealer', 'admin'], ['other', 'admin'], ['staff', 'staff']] as const) {
    await s.repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: start.toISOString()}, {id: 'owner', name: 'Owner'}, {tenantId, userId: 'owner', role, active: true}, {id: 'bootstrap', tenantId, actorId: 'owner', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: start.toISOString(), deliveryStatus: 'pending'});
  }
  const claims = (tenantId: string) => ({sub: 'owner', 'custom:tenant_id': tenantId, iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id' as const});
  assert.equal((await s.handle({method: 'DELETE', path: '/admin/mcp-clients/client-1'})).statusCode, 401);
  for (const tenant of ['other', 'staff']) for (const [method, path] of [['GET', '/admin/mcp-clients'], ['DELETE', '/admin/mcp-clients/client-1']]) assert.equal((await s.handle({method, path, claims: claims(tenant)})).statusCode, 403);
  assert.equal(JSON.parse((await s.handle({method: 'GET', path: '/admin/mcp-clients', claims: claims('dealer')})).body).data.length, 1);
  assert.equal((await s.handle({method: 'DELETE', path: '/admin/mcp-clients/client-1', claims: claims('dealer')})).statusCode, 200);
  assert.deepEqual(s.deleted, ['client-1']); assert.equal(await repo.mcpRegistration('client-1'), undefined);
  await assert.rejects(deleteMcpRegistration(s.repositories, s.config, 'unmanaged'), {status: 404});
});
test('record failure compensates by deleting newly created Cognito client', async () => {
  const repos = new MemoryRepositories(); const original = repos.forTenant.bind(repos);
  repos.forTenant = tenant => ({...original(tenant), saveMcpRegistration: async () => { throw Error('Storage failed'); }});
  const s = setup(repos); assert.equal((await s.post()).statusCode, 500); assert.deepEqual(s.deleted, ['client-1']);
});
test('Cognito adapter uses SDK commands, strips secret and tolerates already-deleted clients', async () => {
  const commands: unknown[] = [];
  const client = {send: async (command: unknown) => { commands.push(command); return {UserPoolClient: {ClientId: 'id', ClientSecret: 'never-return'}}; }} as unknown as CognitoIdentityProviderClient;
  const adapter = new CognitoRegistrationClients(client);
  assert.equal(await adapter.create({UserPoolId: 'pool', ClientName: 'name'}), 'id'); await adapter.delete('pool', 'id');
  assert.ok(commands[0] instanceof CreateUserPoolClientCommand); assert.ok(commands[1] instanceof DeleteUserPoolClientCommand);
  assert.deepEqual(commands[1].input, {UserPoolId: 'pool', ClientId: 'id'});
  const missing = new CognitoRegistrationClients({send: async () => { throw Object.assign(Error(), {name: 'ResourceNotFoundException'}); }} as unknown as CognitoIdentityProviderClient);
  await missing.delete('pool', 'id');
});
test('Dynamo registration records use tenant keys and conditional creates, and paginate reads', async () => {
  const s = setup(); await s.post(); const record = (await s.repositories.forTenant('operator').mcpRegistrations())[0];
  const writes: TransactWriteCommand[] = []; let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    if (command instanceof TransactWriteCommand) { writes.push(command); return {}; }
    if (command instanceof GetCommand) { assert.deepEqual(command.input.Key, {PK: 'TENANT#operator', SK: 'MCPCLIENT#client-1'}); return {Item: {data: record}}; }
    assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#operator'); assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'MCPCLIENT#');
    assert.equal(command.input.ConsistentRead, true); pages++;
    return {Items: [{data: record}], ...(pages === 1 ? {LastEvaluatedKey: {PK: 'TENANT#operator', SK: 'MCPCLIENT#client-1'}} : {})};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('operator');
  await repo.saveMcpRegistration(record); assert.deepEqual(await repo.mcpRegistration('client-1'), record); assert.equal((await repo.mcpRegistrations()).length, 2); await repo.deleteMcpRegistration('client-1');
  assert.deepEqual(writes[0].input.TransactItems, [{Put: {TableName: 'table', Item: {PK: 'TENANT#operator', SK: 'MCPCLIENT#client-1', data: record}, ConditionExpression: 'attribute_not_exists(PK)'}}]);
  assert.deepEqual(writes[1].input.TransactItems, [{Delete: {TableName: 'table', Key: {PK: 'TENANT#operator', SK: 'MCPCLIENT#client-1'}}}]);
  await assert.rejects(new DynamoRepositories('table', client).forTenant('other').saveMcpRegistration(record), /scope/);
});
test('Dynamo registration rate limiter retries contention and persists window counts', async () => {
  let stored: {bucket: number; count: number} | undefined, collide = true;
  const client = {send: async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) { assert.deepEqual(command.input.Key, {PK: 'TENANT#operator', SK: 'MCPRATE#source'}); return stored ? {Item: {data: {...stored}}} : {}; }
    const put = command.input.TransactItems![0].Put!;
    if (collide) { collide = false; stored = {bucket: 1, count: 1}; throw Object.assign(Error(), {name: 'TransactionCanceledException', CancellationReasons: [{Code: 'ConditionalCheckFailed'}]}); }
    assert.equal(put.ConditionExpression, '#d.#b = :b AND #d.#c = :c');
    assert.deepEqual(put.ExpressionAttributeValues, {':b': stored!.bucket, ':c': stored!.count});
    stored = put.Item!.data; return {};
  }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('operator');
  assert.equal(await repo.consumeMcpRegistrationAttempt('source', 1, 2), true);
  assert.equal(await repo.consumeMcpRegistrationAttempt('source', 1, 2), false);
  assert.equal(await repo.consumeMcpRegistrationAttempt('source', 2, 2), true); assert.deepEqual(stored, {bucket: 2, count: 1});
});
