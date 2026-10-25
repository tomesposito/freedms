import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Invite, Principal, Tenant, User, WorkspaceUser } from '@freedms/shared';
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
  if (body.version !== old.version || old.status !== 'pending') throw conflict();
  const record: Invite = {...old, version: old.version + 1, updatedAt: now.toISOString(), ...(match[2] === 'reissue' ? {...credentials(principal.tenantId), status: 'pending', expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString()} : {status: 'revoked', closedTokenHash: old.tokenHash, token: '', tokenHash: ''})};
  await repo.crmWrite([inviteWrite(record, principal.userId, old.version)]);
  return response(200, {data: record});
}
/** Validate against the stored invite inside the repository write boundary. */
export function acceptanceWrite(tenantId: string, current: Invite | undefined, supplied: Invite, user: User, rows: WorkspaceUser[], now: Date) {
  if (!current || current.tenantId !== tenantId || supplied.tenantId !== tenantId || current.version !== supplied.version || current.tokenHash !== supplied.tokenHash || current.status !== 'pending' || current.expiresAt <= now.toISOString()) throw conflict();
  if (user.email !== current.email || !user.name.trim() || rows.some(r => r.user.id === user.id)) throw conflict();
  if (rows.some(r => r.user.email?.toLowerCase() === current.email.toLowerCase() && r.membership.active)) return undefined;
  // Inactive identities require administrator review; never create a duplicate identity.
  if (rows.some(r => r.user.email?.toLowerCase() === current.email.toLowerCase())) throw new ApiError(409, 'INACTIVE_MEMBER', 'Ask your admin to reactivate your existing membership.');
  const record: Invite = {...current, status: 'accepted', version: current.version + 1, updatedAt: now.toISOString(), acceptedAt: now.toISOString(), acceptedUserId: user.id, acceptedName: user.name, closedTokenHash: current.tokenHash, token: '', tokenHash: ''};
  const member = {tenantId, userId: user.id, role: current.role, active: true, version: 1};
  const event = {...inviteWrite(record, user.id, current.version).event, type: 'invite.accepted' as const};
  const memberEvent = {...event, id: randomUUID(), aggregateId: user.id, aggregateVersion: 1, type: 'user.added' as const};
  return {record, member, event, memberEvent};
}
export async function publicInvite(request: ApiRequest, repositories: RepositoryFactory, now: Date) {
  const method = request.method.toUpperCase();
  const accepting = request.path.endsWith('/accept');
  if (method !== (accepting ? 'POST' : 'GET')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  let profile: {name: string; email: string} | undefined;
  if (accepting) { const body = parseBody(request.body); onlyKeys(body, ['name', 'email']); profile = {name: text(body.name, 'Name'), email: emailAddress(body.email)}; }
  const refuse = (reason?: 'expired' | 'revoked' | 'accepted') => response(200, {data: accepting ? {outcome: 'refused', ...(reason ? {reason} : {})} : {valid: false, ...(reason ? {reason} : {})}});
  const match = /^\/invite\/([\w-]{1,128}\.[a-f0-9]{64})(?:\/accept)?$/.exec(request.path);
  if (!match) return refuse();
  // Closed digests identify dead links for explanations only; they never authorize acceptance.
  const token = match[1], repo = repositories.forTenant(token.split('.')[0]), digest = Buffer.from(hash(token));
  const lookup = async () => (await repo.crmList('invite')).find(row => [row.tokenHash, row.closedTokenHash].some(value => value && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(digest, Buffer.from(value))));
  const invite = await lookup();
  const reason = (row: Invite) => row.status !== 'pending' ? row.status : row.expiresAt <= now.toISOString() ? 'expired' : undefined;
  if (!invite) return refuse();
  const dead = reason(invite); if (dead) return refuse(dead);
  const tenant = await repo.tenant(); if (!tenant) return refuse();
  if (profile) {
    if (profile.email !== invite.email.toLowerCase()) return response(200, {data: {outcome: 'email-mismatch', message: 'Use the invited email address to accept this invitation.'}});
    const user = {id: randomUUID(), name: profile.name, email: invite.email};
    try {
      const outcome = await repo.acceptInvite(invite, user, now);
      return response(200, {data: {outcome, tenantId: tenant.id, email: invite.email, role: invite.role, dealership: tenant.name}});
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await lookup(); const dead = latest && reason(latest);
        if (dead) return refuse(dead);
        return response(200, {data: {outcome: 'refused', message: error.code === 'INACTIVE_MEMBER' ? error.message : 'This invitation changed. Ask your admin to reissue a link.'}});
      }
      throw error;
    }
  }
  const actorId = (await repo.events()).find(event => event.aggregateId === invite.id && event.type === 'invite.created')?.actorId;
  const inviter = (await repo.workspaceUsers()).find(row => row.user.id === actorId)?.user.name ?? 'Your dealership admin';
  return response(200, {data: {valid: true, dealership: tenant.name, inviter, name: invite.name, email: invite.email, role: invite.role}});
}
