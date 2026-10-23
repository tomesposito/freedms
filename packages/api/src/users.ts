import { randomUUID } from 'node:crypto';
import type { Membership, OutboxEvent, Principal, PublicWorkspaceUser, Role, User, WorkspaceUser } from '@freedms/shared';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { assertEvent, type TenantRepository } from './repository.js';
import { invalid, onlyKeys, text } from './validation.js';
export function emailAddress(value: unknown): string {
  const email = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email address.');
  return email;
}
function role(value: unknown): Role {
  if (value !== 'admin' && value !== 'staff') throw invalid('Role must be admin or staff.');
  return value;
}
/** Called inside each backend's atomic membership write boundary. */
export function validateMemberWrite(user: User, member: Membership, expected: number, event: OutboxEvent, rows: WorkspaceUser[]): void {
  requireId(user.id); requireId(member.userId);
  const actor = rows.find(r => r.membership.userId === event.actorId)?.membership;
  if (!actor?.active || actor.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage workspace users.');
  const old = rows.find(r => r.membership.userId === member.userId);
  if (user.id !== member.userId || !Number.isSafeInteger(expected) || expected < 0 || member.version !== expected + 1) throw invalid('Invalid membership version.');
  role(member.role);
  if (typeof member.active !== 'boolean') throw invalid('Active must be a boolean.');
  if ((old?.membership.version ?? 0) !== expected) throw conflict();
  if (old && old.membership.active === member.active && old.membership.role === member.role) throw conflict();
  const type = !old ? 'user.added' : old.membership.role !== member.role ? 'user.role_changed' : member.active ? 'user.reactivated' : 'user.deactivated';
  assertEvent(user.id, member.version, event, type);
  if (!old) {
    if (!member.active || expected !== 0) throw conflict();
    text(user.name, 'Name'); const email = emailAddress(user.email);
    if (rows.some(r => r.user.email?.toLowerCase() === email)) throw new ApiError(409, 'DUPLICATE_EMAIL', 'A user with this email already exists in this workspace.');
  } else {
    if (JSON.stringify(user) !== JSON.stringify(old.user) || (old.membership.active !== member.active && old.membership.role !== member.role)) throw invalid('Change one membership setting at a time.');
    if (old.membership.active && old.membership.role === 'admin' && (!member.active || member.role !== 'admin') && !rows.some(r => r.user.id !== user.id && r.membership.active && r.membership.role === 'admin')) throw new ApiError(409, 'LAST_ADMIN', 'Keep at least one active administrator. Add or promote another active admin first.');
  }
}
export async function manageUsers(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  if (principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage workspace users.');
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const match = /^\/admin\/users\/([^/]+)\/(role|deactivate|reactivate)$/.exec(path);
  if (path !== '/admin/users' && !match) throw missing();
  if (!(match ? method === 'POST' : ['GET', 'POST'].includes(method))) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  const rows = await repo.workspaceUsers();
  const publicUser = async ({user, membership}: WorkspaceUser): Promise<PublicWorkspaceUser> => ({userId: user.id, name: user.name, email: user.email ?? null, role: membership.role, active: membership.active, version: membership.version ?? 0, mfaEnabled: (await repo.mfa(user.id))?.enabled ?? false});
  if (method === 'GET') return response(200, {data: await Promise.all(rows.map(publicUser))});
  const body = parseBody(request.body, 4096);
  let user: User, member: Membership, expected = 0;
  let type: OutboxEvent['type'] = 'user.added';
  if (!match) {
    onlyKeys(body, ['name', 'email', 'role']);
    user = {id: randomUUID(), name: text(body.name, 'Name'), email: emailAddress(body.email)};
    member = {tenantId: principal.tenantId, userId: user.id, role: role(body.role), active: true, version: 1};
  } else {
    const row = rows.find(r => r.user.id === requireId(match[1])); if (!row) throw missing();
    onlyKeys(body, match[2] === 'role' ? ['role', 'version'] : ['version']);
    expected = row.membership.version ?? 0;
    if (body.version !== expected) throw conflict();
    user = row.user; member = {...row.membership, version: expected + 1};
    if (match[2] === 'role') { member.role = role(body.role); type = 'user.role_changed'; }
    else { member.active = match[2] === 'reactivate'; type = member.active ? 'user.reactivated' : 'user.deactivated'; }
  }
  await repo.saveMember(user, member, expected, {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: user.id, aggregateVersion: member.version!, type, occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  return response(match ? 200 : 201, {data: await publicUser({user, membership: member})});
}
