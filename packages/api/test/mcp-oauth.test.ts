import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {createMcpOAuth} from '../src/mcp/oauth.js';
import {digest, DynamoOAuthStore, type OAuthRow, type OAuthStore, type OAuthWrite} from '../src/mcp/oauth-store.js';
import {MemoryRepositories} from '../src/memory.js';
import {OPERATOR_TENANT_ID} from '../src/repository.js';
import {grantEvent} from '../src/ai-connections.js';
import {grantRevoked} from '../src/mcp/grants.js';
import {gatewayHandler} from '../src/gateway.js';
import {createHandler, type ApiRequest} from '../src/handler.js';
import {consentHtml} from '../../web/src/mcp-oauth.js';
const resource = 'https://app.example.test/api/mcp', origin = new URL(resource).origin;
class Store implements OAuthStore {
  rows = new Map<string, OAuthRow<unknown>>();
  async get<T>(kind: string, id: string) {return structuredClone(this.rows.get(kind + digest(id))) as OAuthRow<T> | undefined;}
  async put(...rows: OAuthWrite[]) {for (const r of rows) {assert.ok(!this.rows.has(r.kind + digest(r.id))); this.rows.set(r.kind + digest(r.id), structuredClone({data: r.data, expiresAt: r.expiresAt}));}}
  async consume(kind: string, id: string) {const row = this.rows.get(kind + digest(id)); if (!row || row.consumed || row.expiresAt <= Date.now()/1000) return false; row.consumed = true; return true;}
}
async function setup() {
  const repositories = new MemoryRepositories(), store = new Store(), repo = repositories.forTenant('A');
  await repo.provision({id: 'A', name: 'Demo Motors', createdAt: new Date().toISOString()}, {id: 'admin-A', name: 'Demo Admin'}, {tenantId: 'A', userId: 'admin-A', active: true, role: 'admin'},
    {id: 'provision', tenantId: 'A', actorId: 'admin-A', aggregateId: 'A', aggregateVersion: 1, type: 'tenant.created', occurredAt: new Date().toISOString(), deliveryStatus: 'pending'});
  await repositories.forTenant(OPERATOR_TENANT_ID).saveMcpRegistration({tenantId: OPERATOR_TENANT_ID, client_id: 'client', client_name: 'Test assistant', redirect_uris: ['http://127.0.0.1:42800/callback'], scopes: ['freedms/mcp.read', 'freedms/mcp.write'], createdAt: new Date().toISOString()});
  const service = createMcpOAuth(repositories, store, {resource, clientId: 'dedicated', redirectUris: ['https://assistant.example/callback'], verifyIdentity: async jwt => {
    if (jwt !== 'verified-identity') throw Error('Bad signature');
    return {sub: 'admin-A', 'custom:tenant_id': 'A', iss: 'issuer', aud: 'web', exp: Date.now()/1000+3600, token_use: 'id'};
  }});
  let cookie = '';
  const json = async (path: string, body: unknown, overrides: Partial<ApiRequest> = {}) => {
    const r = await service.handle({method: 'POST', path: '/mcp/oauth/' + path, origin, contentType: 'application/json', cookie, body: JSON.stringify(body), ...overrides});
    if (r.cookies) cookie = r.cookies[0].split(';')[0];
    return {r, data: JSON.parse(r.body)};
  };
  const verifier = randomBytes(32).toString('base64url');
  const params = {client_id: 'client', response_type: 'code', redirect_uri: 'http://127.0.0.1:42800/callback', state: 'browser-state', scope: 'freedms/mcp.read freedms/mcp.write', resource, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')};
  const begin = async (overrides = {}) => json('interaction', {...params, ...overrides});
  const approve = async (i: {id: string; csrf: string}, overrides: Partial<ApiRequest> = {}) => json('authorize', {id: i.id, csrf: i.csrf, action: 'allow'}, {authorization: 'Bearer verified-identity', ...overrides});
  const token = async (body: Record<string, string>, overrides: Partial<ApiRequest> = {}) => {
    const r = await service.handle({method: 'POST', path: '/mcp/oauth/token', contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(body).toString(), ...overrides});
    return {r, data: JSON.parse(r.body)};
  };
  const exchange = (code: string, extra = {}) => token({grant_type: 'authorization_code', client_id: 'client', code, code_verifier: verifier, redirect_uri: params.redirect_uri, resource, ...extra});
  const connect = async () => {
    const i = await begin(); assert.equal(i.r.statusCode, 200, JSON.stringify(i.data));
    const a = await approve(i.data); assert.equal(a.r.statusCode, 200, JSON.stringify(a.data));
    const redirect = new URL(a.data.redirect); assert.equal(redirect.searchParams.get('state'), params.state);
    const code = redirect.searchParams.get('code')!; assert.ok(code);
    const t = await exchange(code); assert.equal(t.r.statusCode, 200, JSON.stringify(t.data));
    return {...t.data, code, interaction: i.data};
  };
  return {repositories, repo, store, service, json, begin, approve, params, token, exchange, connect};
}
test('branded OAuth code + S256, resource binding, one-time consent, opaque storage and MCP integration', async () => {
  const s = await setup(), t = await s.connect();
  assert.equal(t.token_type, 'Bearer'); assert.ok(t.access_token.startsWith('fdm_at_')); assert.ok(t.refresh_token.startsWith('fdm_rt_'));
  const claims = await s.service.verifyAccess(t.access_token); assert.equal(claims.sub, 'admin-A');
  const disk = JSON.stringify([...s.store.rows]);
  for (const secret of [t.code, t.access_token, t.refresh_token, 'verified-identity', t.interaction.csrf, t.interaction.id]) assert.ok(!disk.includes(secret));
  assert.equal((await s.approve(t.interaction)).r.statusCode, 400);
  const config = {resource, clientId: 'dedicated', issuer: 'issuer', customOAuth: true};
  const handler = createHandler(s.repositories, {decode: async () => {throw Error();}}, undefined, undefined, undefined, undefined, undefined, {oauth: s.service, mcp: config});
  const result = await handler({method: 'POST', path: '/mcp', authorization: `Bearer ${t.access_token}`, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})});
  assert.equal(result.statusCode, 200); assert.equal(JSON.parse(result.body).result.tools.length, 130);
  const metadata = JSON.parse((await handler({method: 'GET', path: '/.well-known/oauth-authorization-server'})).body);
  assert.equal(metadata.authorization_endpoint, origin+'/?mcp_oauth=1'); assert.equal(metadata.token_endpoint, resource+'/oauth/token');
});
test('rejects unregistered redirects, clients, wrong resource, invalid scopes, duplicate parameters and missing S256', async () => {
  const s = await setup();
  for (const overrides of [{client_id: 'unknown'}, {redirect_uri: 'https://evil.example'}, {resource: 'https://evil.example'}, {scope: 'openid'}, {scope: ''}, {code_challenge_method: 'plain'}, {code_challenge: 'short'}, {state: ''}, {response_type: 'token'}, {extra: 'value'}]) assert.equal((await s.begin(overrides)).r.statusCode, 400);
  assert.equal((await s.json('interaction', s.params, {origin: 'https://evil.example'})).r.statusCode, 400);
  const i = (await s.begin()).data;
  assert.equal((await s.approve(i, {cookie: ''})).r.statusCode, 400);
  assert.equal((await s.approve({...i, csrf: 'bad'})).r.statusCode, 400);
  assert.equal((await s.approve(i, {authorization: 'Bearer forged'})).r.statusCode, 400);
  const a = await s.approve(i), code = new URL(a.data.redirect).searchParams.get('code')!;
  assert.equal((await s.exchange(code, {resource: 'https://evil.example'})).r.statusCode, 400);
  assert.equal((await s.exchange(code, {client_id: 'dedicated'})).r.statusCode, 400);
  assert.equal((await s.token({}, {body: 'client_id=client&client_id=other'})).r.statusCode, 400);
  assert.equal((await s.exchange(code)).r.statusCode, 200);
});
test('wrong verifier burns code; reuse and concurrent exchange revoke the authorization family', async () => {
  const s = await setup(), i = (await s.begin()).data, a = await s.approve(i), code = new URL(a.data.redirect).searchParams.get('code')!;
  assert.equal((await s.exchange(code, {code_verifier: 'a'.repeat(43)})).r.statusCode, 400);
  assert.equal((await s.exchange(code)).r.statusCode, 400);
  const t = await s.connect(); assert.equal((await s.exchange(t.code)).r.statusCode, 400); await assert.rejects(s.service.verifyAccess(t.access_token));
  const j = (await s.begin()).data, b = await s.approve(j), c = new URL(b.data.redirect).searchParams.get('code')!;
  const results = await Promise.all([s.exchange(c), s.exchange(c)]);
  assert.ok(results.filter(r => r.r.statusCode === 200).length <= 1);
  for (const r of results) if (r.r.statusCode === 200) await assert.rejects(s.service.verifyAccess(r.data.access_token));
});
test('refresh rotates, cannot widen scope, and reuse revokes descendant access and refresh tokens', async () => {
  const s = await setup(), t = await s.connect();
  const refresh = (value: string, extra = {}) => s.token({grant_type: 'refresh_token', client_id: 'client', refresh_token: value, resource, ...extra});
  assert.equal((await refresh(t.refresh_token, {scope: 'openid'})).r.statusCode, 400);
  assert.equal((await refresh(t.refresh_token, {client_id: 'dedicated'})).r.statusCode, 400);
  const next = await refresh(t.refresh_token, {scope: 'freedms/mcp.read'}); assert.equal(next.r.statusCode, 200); assert.notEqual(next.data.refresh_token, t.refresh_token);
  assert.equal((await s.service.verifyAccess(next.data.access_token)).scope, 'freedms/mcp.read');
  assert.equal((await refresh(t.refresh_token)).r.statusCode, 400);
  await assert.rejects(s.service.verifyAccess(next.data.access_token)); assert.equal((await refresh(next.data.refresh_token)).r.statusCode, 400);
});
test('app revocation, reconnect generation and legacy tokens never revive old credentials', async () => {
  const s = await setup(), old = await s.connect(), g = (await s.repo.mcpGrants())[0];
  const revoked = {...g, revokedAt: new Date().toISOString(), version: g.version+1};
  await s.repo.saveMcpGrant(revoked, g.version, grantEvent(revoked, 'admin-A', 'mcp-grant.revoked'));
  await assert.rejects(s.service.verifyAccess(old.access_token));
  const fresh = await s.connect(); assert.ok(await s.service.verifyAccess(fresh.access_token)); await assert.rejects(s.service.verifyAccess(old.access_token));
  const oldRefresh = old.refresh_token;
  assert.equal((await s.token({grant_type: 'refresh_token', client_id: 'client', refresh_token: oldRefresh})).r.statusCode, 400);
  assert.equal(await grantRevoked(s.repositories, 'A', {sub:'admin-A',client_id:'client',scope:'freedms/mcp.read',iss:'issuer',exp:9999999999,token_use:'access'}, {issuer:'issuer',clientId:'dedicated',resource}), true);
  await s.repositories.forTenant(OPERATOR_TENANT_ID).deleteMcpRegistration('client'); await assert.rejects(s.service.verifyAccess(fresh.access_token));
});
test('deny returns state only to registered redirect; expiry checked independently of TTL cleanup', async () => {
  const s = await setup(), i = (await s.begin()).data;
  const d = await s.json('authorize', {...i, action: 'deny'}); assert.equal(new URL(d.data.redirect).searchParams.get('error'), 'access_denied'); assert.equal((await s.repo.mcpGrants()).length, 0);
  const j = (await s.begin()).data; s.store.rows.get('interaction'+digest(j.id))!.expiresAt = 1; assert.equal((await s.approve(j)).r.statusCode, 400);
  const t = await s.connect(); s.store.rows.get('access'+digest(t.access_token))!.expiresAt = 1; await assert.rejects(s.service.verifyAccess(t.access_token));
  s.store.rows.get('refresh'+digest(t.refresh_token))!.expiresAt = 1; assert.equal((await s.token({grant_type:'refresh_token',client_id:'client',refresh_token:t.refresh_token})).r.statusCode, 400);
});
test('revocation is client-bound and does not widen the existing browser origin policy', async () => {
  const s = await setup(), t = await s.connect();
  const revoke = (id: string) => s.service.handle({method:'POST',path:'/mcp/oauth/revoke',contentType:'application/x-www-form-urlencoded',body:new URLSearchParams({token:t.refresh_token,client_id:id}).toString()});
  assert.equal((await revoke('dedicated')).statusCode, 200); assert.ok(await s.service.verifyAccess(t.access_token));
  assert.equal((await revoke('client')).statusCode, 200); await assert.rejects(s.service.verifyAccess(t.access_token));
  assert.equal((await s.service.handle({method:'OPTIONS',path:'/mcp/oauth/token'})).headers['access-control-allow-origin'], undefined);
  assert.equal((await s.service.handle({method:'OPTIONS',path:'/mcp/oauth/authorize'})).headers['access-control-allow-origin'], undefined);
});
test('Gateway forwards browser binding and never accepts an untrusted origin bypass', async () => {
  let received: ApiRequest | undefined;
  const gateway = gatewayHandler(async r => {received=r;return {statusCode:200,headers:{},body:'',cookies:['safe']};}, 'issuer','audience','x'.repeat(32));
  const event = {rawPath:'/mcp/oauth/authorize',cookies:['a=b','c=d'],headers:{'x-freedms-origin':'x'.repeat(32),origin, 'content-type':'application/json',authorization:'Bearer identity'},requestContext:{http:{method:'POST'}},body:'{}'};
  assert.deepEqual((await gateway(event)).cookies,['safe']); assert.equal(received?.cookie,'a=b; c=d'); assert.equal(received?.origin,origin); assert.equal(received?.authorization,'Bearer identity');
  assert.equal((await gateway({...event,headers:{}})).statusCode,403);
});
test('Dynamo OAuth writes hash keys, use consistent reads and conditional consume, and retain replay tombstones', async () => {
  const commands: {input: any}[] = [];
  const store = new DynamoOAuthStore('oauth-table', {send:async (c: {input: any}) => {commands.push(c);return {};}} as any);
  await store.put({kind:'access',id:'test-secret-value',data:{subject:'user'},expiresAt:9999999999});
  assert.equal(JSON.stringify(commands).includes('test-secret-value'),false);
  await store.get('access','test-secret-value'); assert.equal(commands[1].input.ConsistentRead,true);
  assert.equal(await store.consume('refresh','value'),true); assert.match(commands[2].input.ConditionExpression,/attribute_not_exists\(#used\).*#expiry > :now/);
  assert.deepEqual(commands[2].input.ExpressionAttributeNames, {'#used':'consumed','#expiry':'expiresAt'});
});
test('consent escapes app and identity labels and displays permissions and removal path', () => {
  const html = consentHtml({id:'',csrf:'',appName:'<script>bad</script>',redirectUri:'http://127.0.0.1:42/cb',scopes:['freedms/mcp.read']}, {user:'<user>',dealership:'<dealer>'});
  assert.ok(!html.includes('<script>')); assert.match(html,/&lt;dealer&gt;/); assert.match(html,/127.0.0.1:42/); assert.match(html,/AI connections/); assert.ok(!html.includes('Create and update'));
});

test('membership removal immediately rejects both access and refresh', async () => {
  const s = await setup(), t = await s.connect();
  const member = await s.repo.membership('admin-A');
  await s.repo.saveMember({id:'second-admin',name:'Second',email:'second@example.test'}, {tenantId:'A',userId:'second-admin',active:true,role:'admin',version:1},0,
    {id:'add-second',tenantId:'A',actorId:'admin-A',aggregateId:'second-admin',aggregateVersion:1,type:'user.added',occurredAt:new Date().toISOString(),deliveryStatus:'pending'});
  const version = (member?.version ?? 0)+1;
  await s.repo.saveMember((await s.repo.users()).find(u=>u.id==='admin-A')!, {...member!,active:false,version},version-1,
    {id:'deactivate',tenantId:'A',actorId:'second-admin',aggregateId:'admin-A',aggregateVersion:version,type:'user.deactivated',occurredAt:new Date().toISOString(),deliveryStatus:'pending'});
  await assert.rejects(s.service.verifyAccess(t.access_token));
  assert.equal((await s.token({grant_type:'refresh_token',client_id:'client',refresh_token:t.refresh_token})).r.statusCode,400);
});
test('refresh keeps the original absolute deadline and code-only clients receive no refresh token', async () => {
  const s = await setup(), t = await s.connect();
  const before = (await s.store.get('refresh',t.refresh_token))!.expiresAt;
  const next = await s.token({grant_type:'refresh_token',client_id:'client',refresh_token:t.refresh_token});
  assert.equal((await s.store.get('refresh',next.data.refresh_token))!.expiresAt,before);
  const registry = s.repositories.forTenant(OPERATOR_TENANT_ID), registration = (await registry.mcpRegistration('client'))!;
  await registry.deleteMcpRegistration('client'); await registry.saveMcpRegistration({...registration,grant_types:['authorization_code']});
  const codeOnly = await s.connect(); assert.equal(codeOnly.refresh_token,undefined);
});
