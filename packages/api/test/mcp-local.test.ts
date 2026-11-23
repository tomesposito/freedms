import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import { seedDemo } from '../src/demo-seed.js';
import { LocalTokens } from '../src/auth.js';
import { localMcpConfig, LOCAL_MCP_CLIENT_ID } from '../src/mcp/local.js';
import { accessVerifier } from '../src/mcp/auth.js';

const now = new Date('2026-11-23T12:00:00Z');
const secret = 'mcp-local-test-secret-at-least-32-characters';

async function setup() {
  const repositories = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) {
    const userId = `admin-${tenantId}`;
    await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: userId, name: 'Admin'}, {tenantId, userId, active: true, role: 'admin'},
      {id: `provision-${tenantId}`, tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
    await seedDemo(repositories, tenantId, userId, now);
  }
  const tokens = new LocalTokens(secret, () => now.getTime());
  // Built exactly the way local.ts builds it: the local MCP config is the
  // only difference from a hosted handler.
  const handle = createHandler(repositories, {decode: async () => { throw Error('Network forbidden'); }}, () => now, undefined, undefined, undefined, undefined,
    {mcp: localMcpConfig(tokens, repositories)});
  const request = async (method: string, params: unknown = {}, token = tokens.issue('admin-A', 'A')) => {
    const response = await handle({method: 'POST', path: '/mcp', authorization: `Bearer ${token}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
    return {response, ...JSON.parse(response.body || '{}')};
  };
  const call = async (name: string, args: unknown = {}, token?: string) => (await request('tools/call', {name, arguments: args}, token)).result;
  return {repositories, tokens, handle, request, call};
}

test('local session token initializes MCP, lists tools and reads its own tenant records', async () => {
  const s = await setup();
  const initialized = await s.request('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'offline', version: '1'}});
  assert.equal(initialized.response.statusCode, 200);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  // Admin membership carries write scope, so the full surface is listed.
  assert.equal((await s.request('tools/list')).result.tools.length, 130);
  const found = await s.call('search_vehicles', {});
  assert.equal(found.isError, false);
  const vehicles = found.structuredContent.data as {id: string; tenantId?: string}[];
  assert.ok(vehicles.length > 0);
  const own = await s.repositories.forTenant('A').list({});
  assert.deepEqual(vehicles.map(v => v.id).sort(), own.map(v => v.id).sort());
  const one = await s.call('get_vehicle', {id: own[0].id});
  assert.equal(one.isError, false);
  assert.equal(one.structuredContent.data.id, own[0].id);
});

test('a second tenant local token cannot read the first tenant records over MCP', async () => {
  const s = await setup();
  const tokenB = s.tokens.issue('admin-B', 'B');
  const foundB = await s.call('search_vehicles', {}, tokenB);
  assert.equal(foundB.isError, false);
  const idsB = (foundB.structuredContent.data as {id: string}[]).map(v => v.id);
  const ownA = await s.repositories.forTenant('A').list({});
  const ownB = await s.repositories.forTenant('B').list({});
  assert.deepEqual(idsB.sort(), ownB.map(v => v.id).sort());
  assert.ok(!idsB.includes(ownA[0].id));
  const cross = await s.call('get_vehicle', {id: ownA[0].id}, tokenB);
  assert.equal(cross.structuredContent.error.code, 'NOT_FOUND');
});

test('invalid, expired and foreign local tokens still get the 401 resource challenge', async () => {
  const s = await setup();
  const expired = new LocalTokens(secret, () => now.getTime() - 7_200_000).issue('admin-A', 'A');
  const foreign = new LocalTokens('a-different-secret-that-is-also-long-enough', () => now.getTime()).issue('admin-A', 'A');
  for (const token of ['', 'garbage', expired, foreign]) {
    const r = await s.request('tools/list', {}, token);
    assert.equal(r.response.statusCode, 401);
    assert.match(r.response.headers['www-authenticate'], /^Bearer resource_metadata=/);
  }
});

test('a handler without the local verifier (the hosted path) rejects local session tokens', async () => {
  const s = await setup();
  const hosted = createHandler(s.repositories, {decode: async () => { throw Error('Network forbidden'); }}, () => now);
  const response = await hosted({method: 'POST', path: '/mcp', authorization: `Bearer ${s.tokens.issue('admin-A', 'A')}`,
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})});
  assert.equal(response.statusCode, 401);
});

test('local verifier maps claims and gates write scope on the membership role', async () => {
  const s = await setup();
  const verify = accessVerifier(localMcpConfig(s.tokens, s.repositories));
  const claims = await verify(`Bearer ${s.tokens.issue('admin-A', 'A')}`);
  assert.equal(claims.sub, 'admin-A');
  assert.equal(claims.client_id, LOCAL_MCP_CLIENT_ID);
  assert.equal(claims.token_use, 'access');
  assert.equal(claims.scope, 'freedms/mcp.read freedms/mcp.write');
  // A subject with no membership gets read scope only, and the MCP server's
  // authorize() check then yields an empty tool list for it.
  const unknown = await verify(`Bearer ${s.tokens.issue('nobody', 'A')}`);
  assert.equal(unknown.scope, 'freedms/mcp.read');
  const listed = await s.request('tools/list', {}, s.tokens.issue('nobody', 'A'));
  assert.deepEqual(listed.result.tools, []);
});
