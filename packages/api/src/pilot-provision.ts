import { randomUUID, randomBytes } from 'node:crypto';
import { AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { RepositoryFactory } from './repository.js';
import { requireId } from './errors.js';
import { emailAddress } from './users.js';
import { text } from './validation.js';
import { newInvite, inviteWrite } from './invites.js';

export interface PilotPerson { tenantId: string; name: string; email: string }
export interface PilotIdentity { ensure(person: PilotPerson): Promise<string> }
export class CognitoPilotIdentity implements PilotIdentity {
  constructor(private pool: string, private saveCredential: (email: string, password: string) => Promise<void>, private client = new CognitoIdentityProviderClient({})) {}
  async ensure(person: PilotPerson): Promise<string> {
    const attributes = (values: {Name?: string; Value?: string}[] = []) => Object.fromEntries(values.map(a => [a.Name, a.Value]));
    try {
      const existing = await this.client.send(new AdminGetUserCommand({UserPoolId: this.pool, Username: person.email}));
      const a = attributes(existing.UserAttributes);
      if (a['custom:tenant_id'] !== person.tenantId || a.email?.toLowerCase() !== person.email || !existing.Enabled)
        throw new Error('Existing identity does not match this active pilot account');
      return requireId(a.sub);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'UserNotFoundException') throw error;
    }
    const password = `Aa1!${randomBytes(24).toString('base64url')}`;
    // Save before the external write so an interrupted call cannot lose the password.
    await this.saveCredential(person.email, password);
    const created = await this.client.send(new AdminCreateUserCommand({UserPoolId: this.pool, Username: person.email,
      MessageAction: 'SUPPRESS', TemporaryPassword: password,
      UserAttributes: [{Name: 'email', Value: person.email}, {Name: 'email_verified', Value: 'true'},
        {Name: 'name', Value: person.name}, {Name: 'custom:tenant_id', Value: person.tenantId}]}));
    return requireId(attributes(created.User?.Attributes).sub);
  }
}
function person(input: PilotPerson): PilotPerson {
  return {tenantId: requireId(input.tenantId), name: text(input.name, 'Name'), email: emailAddress(input.email)};
}
export async function bootstrapPilot(repositories: RepositoryFactory, identity: PilotIdentity, input: PilotPerson & {dealership: string}, now = new Date()) {
  const p = person(input), dealership = text(input.dealership, 'Dealership'), repo = repositories.forTenant(p.tenantId);
  const existing = await repo.tenant();
  if (existing && existing.name !== dealership) throw new Error('Workspace already exists with a different name');
  if (existing && !(await repo.workspaceUsers()).some(r => r.user.email === p.email && r.membership.active && r.membership.role === 'admin'))
    throw new Error('Existing workspace administrator does not match');
  const userId = await identity.ensure(p);
  if (existing) {
    const row = (await repo.workspaceUsers()).find(r => r.user.id === userId);
    if (!row || row.user.email !== p.email || !row.membership.active || row.membership.role !== 'admin')
      throw new Error('Existing workspace administrator does not match');
    return {tenantId: p.tenantId, userId};
  }
  await repo.provision({id: p.tenantId, name: dealership, createdAt: now.toISOString()},
    {id: userId, name: p.name, email: p.email}, {tenantId: p.tenantId, userId, role: 'admin', active: true, version: 1},
    {id: randomUUID(), tenantId: p.tenantId, actorId: userId, aggregateId: p.tenantId, aggregateVersion: 1,
      type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  return {tenantId: p.tenantId, userId};
}
export async function invitePilot(repositories: RepositoryFactory, identity: PilotIdentity,
  input: PilotPerson & {actorId: string; role: 'admin' | 'staff'}, now = new Date()) {
  const p = person(input), repo = repositories.forTenant(p.tenantId), actorId = requireId(input.actorId);
  const actor = await repo.membership(actorId);
  if (!actor?.active || actor.role !== 'admin' || !await repo.tenant()) throw new Error('Active pilot administrator required');
  if (!['admin', 'staff'].includes(input.role)) throw new Error('Invalid invitation role');
  if ((await repo.workspaceUsers()).some(r => r.user.email?.toLowerCase() === p.email)) throw new Error('Membership already exists; manage access in Users');
  await identity.ensure(p);
  const pending = (await repo.crmList('invite')).find(i => i.email === p.email && i.status === 'pending');
  if (pending) {
    if (pending.role !== input.role || pending.expiresAt <= now.toISOString()) throw new Error('Review the existing invitation in Users');
    return pending;
  }
  const invite = newInvite(p.tenantId, {...p, role: input.role}, now);
  await repo.crmWrite([inviteWrite(invite, actorId)]);
  return invite;
}
