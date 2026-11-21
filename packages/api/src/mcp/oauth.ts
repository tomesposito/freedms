import { randomBytes, randomUUID } from 'node:crypto';
import OAuth from '@node-oauth/oauth2-server';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { AuthClaims, McpGrant } from '@freedms/shared';
import { authorize, validateClaims } from '../auth.js';
import { grantEvent } from '../ai-connections.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from '../repository.js';
import { response, type ApiRequest, type ApiResponse } from '../handler.js';
import type { AccessClaims } from './auth.js';
import { digest, type OAuthStore } from './oauth-store.js';

const scopes = ['freedms/mcp.read', 'freedms/mcp.write'];
const random = (prefix = '') => prefix + randomBytes(32).toString('base64url');
const cookieName = '__Host-freedms-mcp';
const seconds = () => Math.floor(Date.now() / 1000);
const invalid = () => new OAuth.InvalidRequestError('The connection request is invalid or has expired. Start again from your app.');
const denied = () => new OAuth.InvalidGrantError('This connection is no longer authorized. Connect again from your app.');
interface User extends OAuth.User {sub: string; tenantId: string; family: string}
interface GrantData {user: User; client: OAuth.Client; scope: string[]; resource: string}
interface CodeData extends GrantData {redirectUri: string; codeChallenge: string; codeChallengeMethod: string}
interface Interaction {params: Record<string, string>; browserHash: string; csrfHash: string}
export interface OAuthConfig {
  resource: string; clientId: string; redirectUris: string[];
  verifyIdentity: (jwt: string) => Promise<AuthClaims>;
}
export const oauthPaths = ['/mcp/oauth/interaction', '/mcp/oauth/authorize', '/mcp/oauth/token', '/mcp/oauth/revoke'];
export interface McpOAuth {handle(request: ApiRequest): Promise<ApiResponse>; verifyAccess(token: string): Promise<AccessClaims>}
export function cognitoIdentityVerifier(issuer: string, audience: string): OAuthConfig['verifyIdentity'] {
  const verifier = CognitoJwtVerifier.create({userPoolId: new URL(issuer).pathname.slice(1), tokenUse: 'id', clientId: audience});
  return async jwt => {
    const claims = await verifier.verify(jwt);
    validateClaims(claims, issuer, audience);
    return claims as unknown as AuthClaims;
  };
}
export function createMcpOAuth(repositories: RepositoryFactory, store: OAuthStore, config: OAuthConfig): McpOAuth {
  const origin = new URL(config.resource).origin;
  const registry = repositories.forTenant(OPERATOR_TENANT_ID);
  async function client(id: string, secret?: string): Promise<OAuth.Client | false> {
    if (secret || !id || id.length > 256) return false;
    if (id === config.clientId) return {id, name: 'freeDMS MCP', redirectUris: config.redirectUris, grants: ['authorization_code', 'refresh_token'], scopes};
    const saved = await registry.mcpRegistration(id);
    return saved ? {id, name: saved.client_name, redirectUris: saved.redirect_uris, grants: saved.grant_types ?? ['authorization_code', 'refresh_token'], scopes: saved.scopes} : false;
  }
  async function active(data: GrantData): Promise<number> {
    const family = await store.get('family', data.user.family);
    const registered = await client(data.client.id);
    if (!family || family.consumed || family.expiresAt <= seconds() || data.resource !== config.resource || !registered || data.scope.some(s => !registered.scopes.includes(s))) throw denied();
    if (await repositories.tenantForSubject?.(data.user.sub) !== data.user.tenantId) throw denied();
    const repo = repositories.forTenant(data.user.tenantId);
    const member = await repo.membership(data.user.sub);
    const grant = (await repo.mcpGrants()).find(g => g.userId === data.user.sub && g.clientId === data.client.id);
    if (!member?.active || !['admin', 'staff'].includes(member.role) || !grant || grant.revokedAt || grant.oauthAuthorizationId !== data.user.family || data.scope.some(s => !grant.scopes.includes(s))) throw denied();
    return family.expiresAt;
  }
  // Model methods are invoked by the maintained OAuth engine. No raw credentials are stored in rows.
  const model: OAuth.AuthorizationCodeModel & OAuth.RefreshTokenModel = {
    getClient: client,
    generateAuthorizationCode: async () => random('fdm_ac_'),
    generateAccessToken: async () => random('fdm_at_'),
    generateRefreshToken: async () => random('fdm_rt_'),
    validateRedirectUri: async (uri, c) => Array.isArray(c.redirectUris) && c.redirectUris.includes(uri),
    validateScope: async (_u, c, requested) => requested?.length && requested.every(s => scopes.includes(s) && c.scopes.includes(s)) ? requested : false,
    saveAuthorizationCode: async (code, c, u) => {
      const data: CodeData = {user: u as User, client: c, scope: code.scope!, resource: config.resource, redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge!, codeChallengeMethod: code.codeChallengeMethod!};
      await active(data);
      await store.put({kind: 'code', id: code.authorizationCode, data, expiresAt: Math.floor(code.expiresAt.getTime() / 1000)});
      return {...code, client: c, user: u};
    },
    getAuthorizationCode: async code => {
      const row = await store.get<CodeData>('code', code);
      if (!row || row.expiresAt <= seconds()) return false;
      if (row.consumed) { await store.consume('family', row.data.user.family); return false; }
      await active(row.data);
      return {...row.data, authorizationCode: code, expiresAt: new Date(row.expiresAt * 1000)};
    },
    revokeAuthorizationCode: async code => {
      const ok = await store.consume('code', code.authorizationCode);
      if (!ok) await store.consume('family', (code.user as User).family);
      return ok;
    },
    saveToken: async (token, c, u) => {
      const data: GrantData = {user: u as User, client: c, scope: token.scope!, resource: config.resource};
      const absoluteExpiry = await active(data);
      const accessExpiry = Math.min(absoluteExpiry, seconds() + 3600);
      const refresh = c.grants.includes('refresh_token');
      const {accessToken, refreshToken} = token;
      const result: OAuth.Token = {accessToken, scope: data.scope, client: c, user: u, accessTokenExpiresAt: new Date(accessExpiry * 1000),
        ...(refresh ? {refreshToken, refreshTokenExpiresAt: new Date(absoluteExpiry * 1000)} : {})};
      await store.put({kind: 'access', id: token.accessToken, data, expiresAt: accessExpiry},
        ...(refresh ? [{kind: 'refresh', id: token.refreshToken, data, expiresAt: absoluteExpiry}] : []));
      return result;
    },
    getAccessToken: async token => {
      const row = await store.get<GrantData>('access', token);
      if (!row || row.expiresAt <= seconds()) return false;
      await active(row.data);
      return {...row.data, accessToken: token, accessTokenExpiresAt: new Date(row.expiresAt * 1000)};
    },
    getRefreshToken: async token => {
      const row = await store.get<GrantData>('refresh', token);
      if (!row || row.expiresAt <= seconds()) return false;
      // Client binding is checked by the engine before revokeToken can revoke a family.
      await active(row.data);
      return {...row.data, refreshToken: token, refreshTokenExpiresAt: new Date(row.expiresAt * 1000)};
    },
    revokeToken: async token => {
      const ok = await store.consume('refresh', token.refreshToken);
      if (!ok) await store.consume('family', (token.user as User).family);
      return ok;
    }
  };
  const oauth = new OAuth({model, requirePKCE: true, authorizationCodeLifetime: 60, accessTokenLifetime: 3600,
    refreshTokenLifetime: 30 * 86400, alwaysIssueNewRefreshToken: true,
    requireClientAuthentication: {authorization_code: false, refresh_token: false}});
  const browserCookie = (request: ApiRequest) => (request.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
  function json(request: ApiRequest): Record<string, unknown> {
    if (request.origin !== origin || !request.contentType?.startsWith('application/json')) throw invalid();
    const data = JSON.parse(request.body ?? '');
    if (!data || Array.isArray(data) || typeof data !== 'object') throw invalid();
    return data;
  }
  function form(request: ApiRequest) {
    if (!request.contentType?.startsWith('application/x-www-form-urlencoded') || request.authorization) throw invalid();
    const params = new URLSearchParams(request.body);
    if ([...params.keys()].some(k => params.getAll(k).length !== 1)) throw invalid();
    const data = Object.fromEntries(params);
    if (data.resource !== undefined && data.resource !== config.resource) throw new OAuth.InvalidRequestError('Invalid resource.');
    return data;
  }
  async function handle(request: ApiRequest): Promise<ApiResponse> {
    const path = request.path.replace(/\/$/, '');
    if (request.method !== 'POST') return response(405, {error: 'invalid_request'});
    try {
      if (!request.body || Buffer.byteLength(request.body) > 16 * 1024) throw invalid();
      if (path.endsWith('/interaction')) {
        const data = json(request);
        if (Object.keys(data).some(k => !['client_id', 'redirect_uri', 'response_type', 'state', 'scope', 'resource', 'code_challenge', 'code_challenge_method'].includes(k)) || Object.values(data).some(v => typeof v !== 'string')) throw invalid();
        const p = data as Record<string, string>, c = await client(p.client_id);
        if (!c || !Array.isArray(c.redirectUris) || !c.redirectUris.includes(p.redirect_uri) || p.response_type !== 'code' ||
          !p.state || p.state.length > 2048 || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '') ||
          (p.resource !== undefined && p.resource !== config.resource)) throw invalid();
        const requested = (p.scope ?? 'freedms/mcp.read').split(' ');
        if (!requested.length || requested.some(s => !scopes.includes(s) || !c.scopes.includes(s))) throw new OAuth.InvalidScopeError('Unsupported permissions.');
        if (!await registry.consumeMcpRegistrationAttempt(digest('interaction:' + (request.sourceIp ?? 'unknown')), Math.floor(Date.now() / 300_000), 30)) return response(429, {error: 'temporarily_unavailable'});
        p.scope = [...new Set(requested)].join(' '); p.resource = config.resource;
        const browser = /^[A-Za-z0-9_-]{43}$/.test(browserCookie(request)) ? browserCookie(request) : random();
        const id = random(), csrf = random();
        await store.put({kind: 'interaction', id, data: {params: p, browserHash: digest(browser), csrfHash: digest(csrf)}, expiresAt: seconds() + 600});
        return {...response(200, {id, csrf, appName: c.name, redirectUri: p.redirect_uri, scopes: requested}),
          cookies: [`${cookieName}=${browser}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`]};
      }
      if (path.endsWith('/authorize')) {
        const body = json(request);
        if (typeof body.id !== 'string' || typeof body.csrf !== 'string' || !['details', 'allow', 'deny'].includes(String(body.action))) throw invalid();
        const row = await store.get<Interaction>('interaction', body.id);
        if (!row || row.consumed || row.expiresAt <= seconds() || row.data.browserHash !== digest(browserCookie(request)) || row.data.csrfHash !== digest(body.csrf)) throw invalid();
        const p = row.data.params, c = await client(p.client_id);
        if (!c || !Array.isArray(c.redirectUris) || !c.redirectUris.includes(p.redirect_uri)) throw invalid();
        const redirect = new URL(p.redirect_uri);
        if (body.action === 'deny') {
          if (!await store.consume('interaction', body.id)) throw invalid();
          redirect.searchParams.set('error', 'access_denied'); redirect.searchParams.set('state', p.state);
          return response(200, {redirect: redirect.href});
        }
        if (!/^Bearer [^ ]+$/.test(request.authorization ?? '')) throw denied();
        let claims: AuthClaims;
        try { claims = await config.verifyIdentity(request.authorization!.slice(7)); } catch { throw denied(); }
        if (await repositories.tenantForSubject?.(claims.sub) !== claims['custom:tenant_id']) throw denied();
        const {repository} = await authorize(claims, repositories);
        if (body.action === 'details') return response(200, {dealership: (await repository.tenant())?.name, user: (await repository.users()).find(u => u.id === claims.sub)?.name});
        if (!await store.consume('interaction', body.id)) throw invalid();
        const user: User = {sub: claims.sub, tenantId: claims['custom:tenant_id'], family: random()};
        const existing = (await repository.mcpGrants()).find(g => g.userId === user.sub && g.clientId === c.id);
        const time = new Date().toISOString();
        const grant: McpGrant = {id: existing?.id ?? randomUUID(), tenantId: user.tenantId, userId: user.sub, clientId: c.id, appName: c.name,
          scopes: p.scope.split(' '), firstGrantedAt: time, lastUsedAt: time, revokedAt: null, oauthAuthorizationId: user.family, version: (existing?.version ?? 0) + 1};
        await store.put({kind: 'family', id: user.family, data: {}, expiresAt: seconds() + 30 * 86400});
        await repository.saveMcpGrant(grant, existing?.version ?? 0, grantEvent(grant, user.sub, 'mcp-grant.authorized'));
        const result = new OAuth.Response();
        await oauth.authorize(new OAuth.Request({method: 'GET', headers: {}, query: p}), result, {authenticateHandler: {handle: async () => user}});
        return response(200, {redirect: result.get('location')});
      }
      if (path.endsWith('/token')) {
        const body = form(request);
        if (!['authorization_code', 'refresh_token'].includes(body.grant_type)) throw new OAuth.UnsupportedGrantTypeError('Unsupported grant.');
        // Bind before model lookup so a wrong client cannot use a replay to revoke someone else's family.
        const kind = body.grant_type === 'authorization_code' ? 'code' : 'refresh';
        const raw = body.grant_type === 'authorization_code' ? body.code : body.refresh_token;
        if (!raw) throw denied();
        const row = await store.get<GrantData>(kind, raw);
        if (!row || row.data.client.id !== body.client_id) throw denied();
        const result = new OAuth.Response();
        await oauth.token(new OAuth.Request({method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(request.body))}, query: {}, body}), result);
        return response(result.status ?? 200, result.body);
      }
      if (path.endsWith('/revoke')) {
        const body = form(request);
        if (!body.token || !body.client_id || !await client(body.client_id)) throw invalid();
        const kind = body.token.startsWith('fdm_rt_') ? 'refresh' : 'access';
        const row = await store.get<GrantData>(kind, body.token);
        if (row && row.data.client.id === body.client_id) await store.consume('family', row.data.user.family);
        return {...response(200, null), body: ''};
      }
      throw invalid();
    } catch (error) {
      const known = error instanceof OAuth.OAuthError;
      return response(known ? error.code : 400, {error: known ? error.name : 'invalid_request', error_description: known ? error.message : 'Unable to complete this connection. Start again from your app.'});
    }
  }
  return {handle, verifyAccess: async token => {
    if (!/^fdm_at_[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
    const result = await model.getAccessToken(token);
    if (!result) throw denied();
    return {sub: result.user.sub, iss: origin, exp: result.accessTokenExpiresAt!.getTime() / 1000, client_id: result.client.id,
      token_use: 'access', scope: result.scope!.join(' '), grant_id: result.user.family};
  }};
}
