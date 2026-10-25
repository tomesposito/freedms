import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Invite, Principal, Tenant } from '@freedms/shared';
import type { CrmWrite, RepositoryFactory, TenantRepository } from './repository.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, object, onlyKeys, text } from './validation.js';
import { emailAddress } from './users.js';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
function credentials(tenantId: string) {
  const token = `${tenantId}.${randomBytes(32).toString('hex')}`;
  return {token, tokenHash: hash(token)};
}
export function validateOnboarding(input: Record<string, unknown>) {
  onlyKeys(input, ['onboarding', 'name', 'email', 'dealership', 'address', 'phone', 'dealerType', 'invites']);
  text(input.name, 'Your name'); text(input.dealership, 'Dealership');
  const email = emailAddress(input.email);
  if (!['independent', 'franchise', 'other'].includes(String(input.dealerType))) throw invalid('Choose a dealer type.');
  const profile = {address: text(input.address, 'Address', 500), phone: text(input.phone, 'Phone', 50), dealerType: input.dealerType as Tenant['dealerType']};
  if (!Array.isArray(input.invites) || input.invites.length > 10) throw invalid('Enter at most 10 invites.');
  const seen = new Set([email]);
  const invites = input.invites.map(value => {
    const row = object(value); onlyKeys(row, ['name', 'email', 'role']);
    const name = text(row.name, 'Invite name'), address = emailAddress(row.email);
    if (seen.has(address)) throw invalid('Invite emails must be unique and different from your account email.');
    seen.add(address);
    if (row.role !== 'admin' && row.role !== 'staff') throw invalid('Role must be admin or staff.');
    return {name, email: address, role: row.role as Invite['role']};
  });
  return {email, profile, invites};
}
export function newInvite(tenantId: string, row: Pick<Invite, 'name' | 'email' | 'role'>, now: Date): Invite {
  // Retain the plain token only in tenant-scoped, admin-only records for repeat copying.
  // Public lookup verifies the hash and never returns either credential; events contain metadata only.
  return {...row, ...credentials(tenantId), id: randomUUID(), kind: 'invite', tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), status: 'pending'};
}
export function inviteWrite(record: Invite, actorId: string, expectedVersion = 0): CrmWrite {
  return {record, expectedVersion, event: {id: randomUUID(), tenantId: record.tenantId, actorId, aggregateId: record.id, aggregateVersion: record.version, type: expectedVersion ? 'invite.updated' : 'invite.created', occurredAt: record.updatedAt, deliveryStatus: 'pending'}};
}
export async function manageInvites(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage invites.');
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  onlyKeys(request.query ?? {}, []);
  if (path === '/admin/invites' && method === 'GET') return response(200, {data: await repo.crmList('invite')});
  const match = /^\/admin\/invites\/([^/]+)\/(reissue|revoke)$/.exec(path);
  if (!match) throw missing();
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const body = parseBody(request.body); onlyKeys(body, ['version']);
  const old = await repo.crmGet('invite', requireId(match[1])); if (!old) throw missing();
  if (body.version !== old.version || old.status === 'revoked') throw conflict();
  const record: Invite = {...old, version: old.version + 1, updatedAt: now.toISOString(), ...(match[2] === 'reissue' ? {...credentials(principal.tenantId), status: 'pending', expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString()} : {status: 'revoked', token: '', tokenHash: ''})};
  await repo.crmWrite([inviteWrite(record, principal.userId, old.version)]);
  return response(200, {data: record});
}
export async function publicInvite(request: ApiRequest, repositories: RepositoryFactory, now: Date) {
  if (request.method.toUpperCase() !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const invalidLink = () => response(200, {data: {valid: false}});
  const match = /^\/invite\/([\w-]{1,128}\.[a-f0-9]{64})$/.exec(request.path);
  if (!match) return invalidLink();
  const token = match[1], repo = repositories.forTenant(token.split('.')[0]), digest = Buffer.from(hash(token));
  const invite = (await repo.crmList('invite')).find(row => /^[a-f0-9]{64}$/.test(row.tokenHash) && timingSafeEqual(digest, Buffer.from(row.tokenHash)));
  if (!invite || invite.status !== 'pending' || invite.expiresAt <= now.toISOString()) return invalidLink();
  const tenant = await repo.tenant(); if (!tenant) return invalidLink();
  return response(200, {data: {valid: true, dealership: tenant.name, role: invite.role}});
}
