import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AuthClaims } from '@freedms/shared';
import { createHandler } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from '../src/repository.js';
import { grantEvent } from '../src/ai-connections.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'offline', alg: 'RS256'};
const data = (r: {body: string}) => JSON.parse(r.body).data;
async function setup() {
  let time = Date.parse('2026-11-01T12:00:00Z');
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) {
    const userId = `admin-${tenantId}`, repo = repositories.forTenant(tenantId);
    await repo.provision({id: tenantId, name: tenantId, createdAt: new Date(time).toISOString()}, {id: userId, name: 'Owner'}, {tenantId, userId, active: true, role: 'admin'},
      {id: 'provision', tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: new Date(time).toISOString(), deliveryStatus: 'pending'});
    await repo.saveMember({id: `staff-${tenantId}`, name: 'Staff', email: 'staff@example.test'}, {tenantId, userId: `staff-${tenantId}`, active: true, role: 'staff', version: 1}, 0,
      {id: 'member', tenantId, actorId: userId, aggregateId: `staff-${tenantId}`, aggregateVersion: 1, type: 'user.added', occurredAt: new Date(time).toISOString(), deliveryStatus: 'pending'});
  }
  const config = {issuer: 'https://issuer.example.test/pool', clientId: 'mcp-client', resource: 'https://app.example.test/api/mcp', now: () => time, jwks: async () => ({keys: [jwk]})};
  const handler = (repos: RepositoryFactory = repositories, clientId = config.clientId) => createHandler(repos, {decode: async () => {throw Error('Offline');}}, () => new Date(time), undefined, undefined, undefined, undefined, {mcp: {...config, clientId}});
  const handle = handler();
  const use = async (sub = 'staff-A', scope = 'freedms/mcp.read', clientId = config.clientId, run = handle, method = 'tools/list') => {
    const payload = [{alg: 'RS256', kid: 'offline'}, {sub, iss: config.issuer, client_id: clientId, token_use: 'access', scope, exp: time / 1000 + 3600}].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
    return run({method: 'POST', path: '/mcp', authorization: `Bearer ${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method})});
  };
  const rest = (path = '/ai-connections', method = 'GET', userId = 'staff-A', tenantId = 'A') => handle({path, method, claims: {sub: userId, 'custom:tenant_id': tenantId} as AuthClaims});
  return {repositories, config, use, rest, handler, advance: (ms: number) => {time += ms;}};
}
test('MCP grants snapshot registered names and scopes on first use and refresh only hourly', async () => {
  const s = await setup(), repo = s.repositories.forTenant('A');
  await s.repositories.forTenant(OPERATOR_TENANT_ID).saveMcpRegistration({tenantId: OPERATOR_TENANT_ID, client_id: s.config.clientId, client_name: 'My assistant', redirect_uris: ['https://example.test/callback'], scopes: ['freedms/mcp.read'], createdAt: new Date(s.config.now()).toISOString()});
  await s.use(); const [first] = await repo.mcpGrants();
  assert.equal(first.appName, 'My assistant'); assert.deepEqual(first.scopes, ['freedms/mcp.read']);
  assert.equal(first.firstGrantedAt, '2026-11-01T12:00:00.000Z'); assert.equal(first.lastUsedAt, first.firstGrantedAt);
  s.advance(60_000); await s.use('staff-A', 'freedms/mcp.write'); assert.deepEqual(await repo.mcpGrant(first.id), first);
  s.advance(3_540_000); await s.use('staff-A', 'freedms/mcp.write');
  const updated = (await repo.mcpGrant(first.id))!; assert.equal(updated.version, 2); assert.equal(updated.lastUsedAt, '2026-11-01T13:00:00.000Z'); assert.deepEqual(updated.scopes, ['freedms/mcp.write']);
  assert.equal(updated.firstGrantedAt, first.firstGrantedAt);
  const events = (await repo.events()).filter(e => e.type === 'mcp-grant.recorded'); assert.equal(events.length, 1); assert.equal(events[0].actorId, 'staff-A'); assert.equal(events[0].actorType, undefined);
});
test('MCP template fallback and simultaneous first uses produce one grant', async () => {
  const s = await setup(); await Promise.all([s.use(), s.use(), s.use()]);
  const grants = await s.repositories.forTenant('A').mcpGrants(); assert.equal(grants.length, 1); assert.equal(grants[0].appName, 'freeDMS MCP');
});
test('AI connections enforce own/workspace visibility, owner/admin revoke, audit attribution and tenant isolation', async () => {
  const s = await setup(); await s.use(); s.advance(1000); await s.use('admin-A');
  const own = data(await s.rest()); assert.equal(own.length, 1); assert.equal(own[0].userId, 'staff-A');
  assert.ok(!JSON.stringify(own).includes('clientId')); assert.ok(!JSON.stringify(own).includes('tenantId'));
  assert.equal((await s.rest('/ai-connections/workspace')).statusCode, 403);
  const all = data(await s.rest('/ai-connections/workspace', 'GET', 'admin-A')); assert.equal(all.length, 2); assert.equal(all[0].userId, 'admin-A'); assert.equal(all[1].ownerName, 'Staff');
  const revoke = (id: string, user = 'staff-A', tenant = 'A') => s.rest(`/ai-connections/${id}/revoke`, 'POST', user, tenant);
  assert.equal((await revoke(all[0].id)).statusCode, 403);
  assert.deepEqual(data(await s.rest('/ai-connections/workspace', 'GET', 'admin-B', 'B')), []);
  assert.equal((await revoke(own[0].id, 'admin-B', 'B')).statusCode, 404);
  const revoked = await revoke(own[0].id); assert.equal(revoked.statusCode, 200); assert.ok(data(revoked).revokedAt);
  assert.deepEqual(data(await revoke(own[0].id)), data(revoked));
  // A separate handler keeps the single-client token validation rule intact.
  await s.use('staff-A', 'freedms/mcp.read', 'second-client', s.handler(undefined, 'second-client'));
  const second = (await s.repositories.forTenant('A').mcpGrants()).find(g => g.clientId === 'second-client')!;
  assert.equal((await revoke(second.id, 'admin-A')).statusCode, 200);
  const events = (await s.repositories.forTenant('A').events()).filter(e => e.type === 'mcp-grant.revoked');
  assert.deepEqual(events.map(e => e.actorId), ['staff-A', 'admin-A']);
});
test('Revoked grant refuses the next MCP tool request with exact challenge while another client works', async () => {
  const s = await setup(); await s.use(); const [grant] = data(await s.rest());
  await s.rest(`/ai-connections/${grant.id}/revoke`, 'POST');
  const denied = await s.use(); assert.equal(denied.statusCode, 401);
  assert.deepEqual(JSON.parse(denied.body), {error: {code: 'UNAUTHORIZED', message: 'Sign in to continue.'}});
  assert.equal(denied.headers['www-authenticate'], 'Bearer resource_metadata="https://app.example.test/api/.well-known/oauth-protected-resource"');
  assert.equal((await s.use('staff-A', 'freedms/mcp.read', s.config.clientId, undefined, 'ping')).statusCode, 401);
  const other = await s.use('staff-A', 'freedms/mcp.read', 'other-client', s.handler(undefined, 'other-client'));
  assert.ok(JSON.parse(other.body).result.tools.length > 0);
  const repo = s.repositories.forTenant('A');
  const revoked = (await repo.mcpGrant(grant.id))!;
  assert.equal(revoked.version, 2);
  await assert.rejects(repo.saveMcpGrant({...revoked, revokedAt: null, version: 2}, 1), {code: 'CONFLICT'});
  assert.ok((await repo.mcpGrant(grant.id))?.revokedAt);
});
test('Grant save/read and registration lookup failures are best effort; unauthorized users record nothing', async () => {
  const s = await setup();
  for (const method of ['saveMcpGrant', 'mcpGrants', 'mcpRegistration']) {
    const repos: RepositoryFactory = {tenantForSubject: sub => s.repositories.tenantForSubject(sub), forTenant: tenant => ({...s.repositories.forTenant(tenant), [method]: async () => {throw Error('Storage unavailable');}})};
    const result = await s.use('staff-A', 'freedms/mcp.read', s.config.clientId, s.handler(repos));
    assert.ok(JSON.parse(result.body).result.tools.length > 0);
  }
  const result = await s.use('unknown'); assert.deepEqual(JSON.parse(result.body).result.tools, []);
  assert.ok(!(await s.repositories.forTenant('A').mcpGrants()).some(g => g.userId === 'unknown'));
});
test('Grant repositories reject scope/conflicting writes; Dynamo writes grants and audit atomically and refreshes without audit', async () => {
  const s = await setup(); await s.use(); const repo = s.repositories.forTenant('A'), [grant] = await repo.mcpGrants();
  const event = grantEvent(grant, grant.userId, 'mcp-grant.recorded');
  await assert.rejects(repo.saveMcpGrant({...grant, tenantId: 'B'}, 0, event), /scope/);
  await assert.rejects(repo.saveMcpGrant({...grant, id: 'duplicate'}, 0, {...event, aggregateId: 'duplicate'}), {code: 'CONFLICT'});
  const commands: (QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: QueryCommand | TransactWriteCommand) => {commands.push(command); return command instanceof QueryCommand ? {Items: [{data: grant}]} : {};}} as unknown as DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('table', client).forTenant('A');
  assert.deepEqual(await dynamo.mcpGrants(), [grant]);
  assert.equal((commands[0] as QueryCommand).input.ConsistentRead, true);
  assert.equal((commands[0] as QueryCommand).input.ExpressionAttributeValues?.[':prefix'], 'MCPGRANT#');
  await dynamo.saveMcpGrant(grant, 0, event);
  await dynamo.saveMcpGrant({...grant, version: 2}, 1);
  const writes = commands.filter(c => c instanceof TransactWriteCommand);
  assert.equal(writes[0].input.TransactItems?.length, 3); assert.equal(writes[1].input.TransactItems?.length, 1);
  assert.equal(writes[0].input.TransactItems?.[0].Put?.Item?.PK, 'TENANT#A');
  assert.equal(writes[1].input.TransactItems?.[0].Put?.ExpressionAttributeValues?.[':v'], 1);
  await assert.rejects(dynamo.saveMcpGrant({...grant, tenantId: 'B'}, 0, event), /scope/);
});
