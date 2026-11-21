import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHandler } from '../src/handler.js';
import { gatewayHandler } from '../src/gateway.js';
import { localAuth } from '../src/local-auth.js';
import { MemoryRepositories } from '../src/memory.js';
import { mcpConfig } from '../src/mcp/auth.js';
import type { CreateUserPoolClientCommandInput } from '@aws-sdk/client-cognito-identity-provider';

const resource = 'https://app.example.test/api/mcp';
const oauthDomain = 'https://pool.auth.us-east-1.amazoncognito.com';
const config = {issuer: 'https://cognito-idp.us-east-1.amazonaws.com/pool', clientId: 'existing-client', resource, oauthDomain};
function setup() {
  const created: CreateUserPoolClientCommandInput[] = [];
  const handle = createHandler(new MemoryRepositories(), {decode: async () => { throw Error('No network'); }}, undefined, undefined, undefined, undefined, undefined, {
    mcp: config,
    registration: {poolId: 'pool', clients: {create: async input => { created.push(input); return 'registered-client'; }, delete: async () => {}}},
  });
  const gateway = gatewayHandler(handle, config.issuer, 'web-client', 'private-origin');
  const request = (url: string, method = 'GET', body?: unknown, origin = 'private-origin') => {
    const path = new URL(url).pathname.replace(/^\/api\//, '/');
    return gateway({rawPath: path, requestContext: {http: {method, sourceIp: '192.0.2.10'}},
      headers: {'x-freedms-origin': origin, host: 'attacker.example'}, body: body === undefined ? undefined : JSON.stringify(body)});
  };
  return {created, handle, request};
}

test('OAuth discovery from the MCP challenge reaches public Cognito registration without a manual client ID', async () => {
  const s = setup();
  const challenge = await s.request(resource, 'POST', {jsonrpc: '2.0', id: 1, method: 'initialize'});
  assert.equal(challenge.statusCode, 401);
  const resourceMetadataUrl = challenge.headers['www-authenticate'].match(/resource_metadata="([^"]+)"/)?.[1];
  assert.equal(resourceMetadataUrl, 'https://app.example.test/api/.well-known/oauth-protected-resource');
  const protectedMetadata = await s.request(resourceMetadataUrl!);
  assert.equal(protectedMetadata.statusCode, 200);
  const resourceMetadata = JSON.parse(protectedMetadata.body);
  assert.equal(resourceMetadata.resource, resource);
  const issuer = resourceMetadata.authorization_servers[0];
  assert.equal(issuer, 'https://app.example.test');
  const discovery = await s.request(`${issuer}/.well-known/oauth-authorization-server`);
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.headers['cache-control'], 'no-store');
  const metadata = JSON.parse(discovery.body);
  assert.deepEqual(metadata, {
    issuer,
    authorization_endpoint: `${oauthDomain}/oauth2/authorize`, token_endpoint: `${oauthDomain}/oauth2/token`,
    revocation_endpoint: `${oauthDomain}/oauth2/revoke`, registration_endpoint: `${resource}/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
    scopes_supported: ['freedms/mcp.read', 'freedms/mcp.write'],
  });
  const registration = await s.request(metadata.registration_endpoint, 'POST', {
    client_name: 'Codex', redirect_uris: ['http://127.0.0.1:43210/callback'],
    grant_types: metadata.grant_types_supported, response_types: metadata.response_types_supported,
    token_endpoint_auth_method: 'none', scope: metadata.scopes_supported.join(' '),
  });
  assert.equal(registration.statusCode, 201);
  assert.equal(JSON.parse(registration.body).client_id, 'registered-client');
  assert.equal(s.created[0].GenerateSecret, false);
  assert.deepEqual(s.created[0].CallbackURLs, ['http://127.0.0.1:43210/callback']);
  assert.deepEqual(s.created[0].AllowedOAuthScopes, resourceMetadata.scopes_supported);
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({client_id: JSON.parse(registration.body).client_id,
    redirect_uri: s.created[0].CallbackURLs![0], response_type: 'code', code_challenge_method: 'S256', code_challenge: 'test-challenge', state: 'test-state'}).toString();
  assert.equal(authorize.origin, oauthDomain);
  assert.equal(authorize.searchParams.get('client_id'), 'registered-client');
});

test('discovery keeps origin protection and private API authentication, rejects writes and unconfigured OAuth', async () => {
  const s = setup();
  const url = 'https://app.example.test/.well-known/oauth-authorization-server';
  assert.equal((await s.request(url, 'GET', undefined, 'wrong-origin')).statusCode, 403);
  assert.equal((await s.request('https://app.example.test/api/session')).statusCode, 401);
  assert.equal((await s.request(`${url}/unexpected`)).statusCode, 401);
  assert.equal((await s.request(url, 'POST', {})).statusCode, 405);
  assert.equal((await s.request(`${url}/`)).statusCode, 200);
  assert.deepEqual(localAuth('/.well-known/oauth-authorization-server', false, '', {verify: () => { throw Error('Discovery must be public'); }}), {authorization: 'Bearer '});
  const unconfigured = createHandler(new MemoryRepositories(), {decode: async () => { throw Error('No network'); }}, undefined, undefined, undefined, undefined, undefined,
    {mcp: {...config, oauthDomain: undefined}});
  assert.equal((await unconfigured({path: '/.well-known/oauth-authorization-server', method: 'GET'})).statusCode, 503);
});

test('MCP deployment config keeps OAuth discovery separate from the access-token issuer', () => {
  const old = process.env.MCP_OAUTH_DOMAIN;
  try { process.env.MCP_OAUTH_DOMAIN = oauthDomain; assert.equal(mcpConfig().oauthDomain, oauthDomain); }
  finally { if (old === undefined) delete process.env.MCP_OAUTH_DOMAIN; else process.env.MCP_OAUTH_DOMAIN = old; }
  const template = readFileSync('infra/template.yaml', 'utf8');
  assert.match(template, /MCP_OAUTH_DOMAIN: !Sub 'https:\/\/\$\{CognitoDomainPrefix\}.auth.\$\{AWS::Region\}.amazoncognito.com'/);
  assert.match(template, /Path: \/.well-known\/oauth-authorization-server\n\s+Method: GET\n\s+Auth: \{Authorizer: NONE\}/);
  const behavior = template.split('PathPattern: /.well-known/oauth-authorization-server\n')[1].split('          - PathPattern:')[0];
  assert.match(behavior, /TargetOriginId: api/); assert.match(behavior, /AllowedMethods: \[GET, HEAD\]/);
  assert.match(behavior, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(behavior, /FunctionARN: !GetAtt ViewerFunction.FunctionARN/);
  const code = template.split('      FunctionCode: !Sub |\n')[1].split('\n  WebAcl:')[0].replaceAll('${RootDomain}', 'example.test');
  const handler = runInNewContext(`${code}; handler`) as (event: unknown) => {uri?: string; statusCode?: number};
  const event = (host: string, uri: string) => ({request: {method: 'GET', uri, headers: {host: {value: host}}}});
  assert.equal(handler(event('app.example.test', '/.well-known/oauth-authorization-server')).uri, '/.well-known/oauth-authorization-server');
  assert.equal(handler(event('app.example.test', '/api/.well-known/oauth-protected-resource')).uri, '/.well-known/oauth-protected-resource');
  assert.equal(handler(event('example.test', '/.well-known/oauth-authorization-server')).statusCode, 404);
  assert.equal(handler(event('untrusted.example', '/.well-known/oauth-authorization-server')).statusCode, 404);
});
