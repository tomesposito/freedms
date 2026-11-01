import { createHash } from 'node:crypto';
import { CognitoIdentityProviderClient, CreateUserPoolClientCommand, DeleteUserPoolClientCommand, type CreateUserPoolClientCommandInput } from '@aws-sdk/client-cognito-identity-provider';
import { ApiError } from '../errors.js';
import { parseBody, response, errorResponse, type ApiRequest, type ApiResponse } from '../handler.js';
import { OPERATOR_TENANT_ID, type RepositoryFactory } from '../repository.js';
import { onlyKeys, text, invalid } from '../validation.js';

export interface McpRegistration {
  tenantId: string; client_id: string; client_name: string; redirect_uris: string[]; scopes: string[]; createdAt: string;
}
export interface RegistrationClients {
  create(input: CreateUserPoolClientCommandInput): Promise<string>;
  delete(poolId: string, clientId: string): Promise<void>;
}
export class CognitoRegistrationClients implements RegistrationClients {
  constructor(private client = new CognitoIdentityProviderClient({})) {}
  async create(input: CreateUserPoolClientCommandInput): Promise<string> {
    const result = await this.client.send(new CreateUserPoolClientCommand(input));
    if (!result.UserPoolClient?.ClientId) throw new Error('Missing Cognito client ID');
    return result.UserPoolClient.ClientId;
  }
  async delete(poolId: string, clientId: string): Promise<void> {
    try { await this.client.send(new DeleteUserPoolClientCommand({UserPoolId: poolId, ClientId: clientId})); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error; }
  }
}
export interface RegistrationConfig { poolId: string; clients: RegistrationClients }
export const registrationLimit = 10;
export const registrationWindowMs = 300_000;
function strings(value: unknown, label: string, allowed?: string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(v => typeof v !== 'string' || (allowed && !allowed.includes(v)))) throw invalid(`Invalid ${label}.`);
  return [...new Set(value as string[])];
}
function metadata(request: ApiRequest) {
  const body = parseBody(request.body, 16 * 1024);
  onlyKeys(body, ['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope']);
  const client_name = text(body.client_name, 'Client name', 128);
  const redirect_uris = strings(body.redirect_uris, 'redirect_uris');
  for (const uri of redirect_uris) {
    let url: URL;
    try { url = new URL(uri); } catch { throw invalid('Invalid redirect URI.'); }
    if (uri.length > 2048 || /[\s*#\\]/.test(uri) || /%2a/i.test(uri) || /^[a-z]+:\/\/[^/?#]*@/i.test(uri) || url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|\?|$)/i.test(uri)))) throw invalid('Redirect URIs require HTTPS or HTTP localhost/127.0.0.1, without wildcards, fragments or credentials.');
  }
  const grant_types = strings(body.grant_types ?? ['authorization_code'], 'grant_types', ['authorization_code', 'refresh_token']);
  if (!grant_types.includes('authorization_code')) throw invalid('authorization_code is required.');
  const response_types = strings(body.response_types ?? ['code'], 'response_types', ['code']);
  if ((body.token_endpoint_auth_method ?? 'none') !== 'none') throw invalid('Only public clients using PKCE are supported.');
  // Reject unknown scopes rather than silently reducing the requested permissions.
  const scope = body.scope ?? 'freedms/mcp.read';
  if (typeof scope !== 'string' || !scope.trim()) throw invalid('Invalid scope.');
  const scopes = strings(scope.trim().split(/ +/), 'scope', ['freedms/mcp.read', 'freedms/mcp.write']);
  return {client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method: 'none', scope: scopes.join(' '), scopes};
}
export async function registerMcpClient(request: ApiRequest, repositories: RepositoryFactory, now: Date, config?: RegistrationConfig): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== 'POST') return response(405, {error: 'invalid_request', error_description: 'Method not allowed.'});
  try {
    // Gateway supplies the source, never a caller-controlled JSON field or forwarding header.
    const source = createHash('sha256').update(request.sourceIp ?? 'unknown').digest('hex');
    const bucket = Math.floor(now.getTime() / registrationWindowMs);
    const repository = repositories.forTenant(OPERATOR_TENANT_ID);
    if (!await repository.consumeMcpRegistrationAttempt(source, bucket, registrationLimit)) {
      const result = response(429, {error: 'temporarily_unavailable', error_description: 'Too many registration attempts.'});
      result.headers['retry-after'] = String(Math.ceil(((bucket + 1) * registrationWindowMs - now.getTime()) / 1000));
      return result;
    }
    let data: ReturnType<typeof metadata>;
    try { data = metadata(request); }
    catch (error) { if (error instanceof ApiError) return response(400, {error: 'invalid_client_metadata', error_description: error.message}); throw error; }
    if (!config?.poolId) return response(503, {error: 'temporarily_unavailable', error_description: 'Registration is not configured.'});
    const {scopes, ...result} = data;
    const client_id = await config.clients.create({UserPoolId: config.poolId, ClientName: data.client_name,
      GenerateSecret: false, ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'], AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'], AllowedOAuthScopes: scopes, SupportedIdentityProviders: ['COGNITO'], CallbackURLs: data.redirect_uris,
      PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, AccessTokenValidity: 1, TokenValidityUnits: {AccessToken: 'hours'}});
    try {
      // Like access requests, this is operator bookkeeping: no dealership mutation/outbox event.
      await repository.saveMcpRegistration({tenantId: OPERATOR_TENANT_ID, client_id, client_name: data.client_name, redirect_uris: data.redirect_uris, scopes, createdAt: now.toISOString()});
    } catch (error) {
      await config.clients.delete(config.poolId, client_id);
      throw error;
    }
    return response(201, {client_id, ...result});
  } catch (error) { return errorResponse(error); }
}
export async function deleteMcpRegistration(repositories: RepositoryFactory, config: RegistrationConfig, clientId: string): Promise<void> {
  const repository = repositories.forTenant(OPERATOR_TENANT_ID);
  if (!await repository.mcpRegistration(clientId)) throw new ApiError(404, 'NOT_FOUND', 'Registered client not found.');
  // Keep the record on upstream failure. Missing upstream clients are safe to retry.
  await config.clients.delete(config.poolId, clientId);
  await repository.deleteMcpRegistration(clientId);
}
