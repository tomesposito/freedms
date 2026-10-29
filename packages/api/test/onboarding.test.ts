import { TERMS_VERSION, PRIVACY_VERSION } from '@freedms/shared';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Invite } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { LocalTokens } from '../src/auth.js';
import { localSession } from '../src/local-session.js';
import { localAuth } from '../src/local-auth.js';
import { createHandler } from '../src/handler.js';
const now = new Date('2026-10-25T12:00:00Z');
const payload = () => ({acceptance: {termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION}, onboarding: true, name: 'Owner', email: 'OWNER@example.test', dealership: 'Test Motors', address: '123 Main Street', phone: '555-0100', dealerType: 'independent', invites: [{name: 'Staff', email: 'staff@example.test', role: 'staff'}, {name: 'Admin', email: 'admin@example.test', role: 'admin'}]});
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('local-test-secret-at-least-32-characters', () => now.getTime());
  let clock = now;
  const handler = createHandler(repositories, {decode: async () => { throw Error('Offline only'); }}, () => clock);
  const create = async (invites = payload().invites) => {
    const result = await localSession(JSON.stringify({...payload(), invites}), repositories, tokens, now);
    assert.equal(result.statusCode, 201);
    return JSON.parse(result.body).data as {token: string; invites: Invite[]};
  };
  const call = async (path: string, token = '', method = 'GET', body?: unknown) => {
    const result = await handler({path, method, body: body === undefined ? undefined : JSON.stringify(body), ...localAuth(path, false, token, tokens)});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  return {repositories, tokens, create, call, advance: (date: Date) => { clock = date; }};
}
test('wizard provisions the profile, admin email and seven-day pending invites with metadata-only outbox events', async () => {
  const s = await setup(), created = await s.create(), claims = s.tokens.verify(created.token);
  const repo = s.repositories.forTenant(claims['custom:tenant_id']);
  assert.deepEqual(await repo.tenant(), {id: claims['custom:tenant_id'], name: 'Test Motors', address: '123 Main Street', phone: '555-0100', dealerType: 'independent', createdAt: now.toISOString()});
  const users = await repo.workspaceUsers(); assert.equal(users.length, 1); assert.equal(users[0].user.email, 'owner@example.test'); assert.equal(users[0].membership.role, 'admin');
  assert.equal(created.invites.length, 2);
  for (const invite of created.invites) {
    assert.equal(invite.status, 'pending'); assert.equal(invite.expiresAt, '2026-11-01T12:00:00.000Z');
    assert.equal(invite.tokenHash, createHash('sha256').update(invite.token).digest('hex'));
    assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: true, dealership: 'Test Motors', inviter: 'Owner', name: invite.name, email: invite.email, role: invite.role});
  }
  const events = (await repo.events()).filter(e => e.type === 'invite.created'); assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.aggregateId), created.invites.map(i => i.id));
  assert.ok(!JSON.stringify(events).includes('token')); assert.ok(!JSON.stringify(events).includes('example.test'));
  assert.equal((await repo.list({})).length, 0);
});
test('invalid wizard payloads never access a repository or provision a tenant', async () => {
  const s = await setup();
  const invalid = [{invites: [{name: 'X', email: 'bad', role: 'staff'}]}, {invites: [payload().invites[0], {...payload().invites[0], email: ' STAFF@example.test '}]}, {invites: [{name: 'Me', email: 'owner@example.test', role: 'admin'}]}, {dealerType: 'unknown'}, {email: 'bad'}, {address: ''}, {phone: ''}, {invites: Array(11).fill(payload().invites[0])}];
  for (const patch of invalid) await assert.rejects(localSession(JSON.stringify({...payload(), ...patch}), {forTenant: () => { assert.fail('Validation must precede repository access'); }}, s.tokens, now), error => (error as {status: number}).status === 400);
});
test('invite lists and mutations isolate tenants and forbid staff', async () => {
  const s = await setup(), a = await s.create(), b = await s.create();
  assert.deepEqual((await s.call('/admin/invites', a.token)).data.map((i: Invite) => i.id).sort(), a.invites.map(i => i.id).sort());
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`/admin/invites/${b.invites[0].id}/${action}`, a.token, 'POST', {version: 1})).status, 404);
  const staff = (await s.call('/admin/users', a.token, 'POST', {name: 'Staff', email: 'member@example.test', role: 'staff'})).data;
  const token = s.tokens.issue(staff.userId, s.tokens.verify(a.token)['custom:tenant_id']);
  assert.equal((await s.call('/admin/invites', token)).status, 403);
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`/admin/invites/${a.invites[0].id}/${action}`, token, 'POST', {version: 1})).status, 403);
});
test('reissue rotates credentials, stale writes fail, revoke is final, and mutations emit events', async () => {
  const s = await setup(), a = await s.create(), old = a.invites[0];
  const path = `/admin/invites/${old.id}`;
  const reissued = await s.call(`${path}/reissue`, a.token, 'POST', {version: 1}); assert.equal(reissued.status, 200);
  assert.notEqual(reissued.data.token, old.token);
  assert.equal((await s.call(`/invite/${old.token}`)).data.valid, false);
  assert.equal((await s.call(`/invite/${reissued.data.token}`)).data.valid, true);
  assert.equal((await s.call(`${path}/revoke`, a.token, 'POST', {version: 1})).status, 409);
  const revoked = await s.call(`${path}/revoke`, a.token, 'POST', {version: 2}); assert.equal(revoked.status, 200);
  assert.equal(revoked.data.token, ''); assert.equal(revoked.data.tokenHash, ''); assert.equal(revoked.data.status, 'revoked');
  assert.equal((await s.call(`/invite/${reissued.data.token}`)).data.valid, false);
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`${path}/${action}`, a.token, 'POST', {version: 3})).status, 409);
  const events = await s.repositories.forTenant(old.tenantId).events();
  assert.deepEqual(events.filter(e => e.type === 'invite.updated').map(e => e.aggregateVersion), [2, 3]);
});
test('expired, malformed and unknown public tokens return 200 invalid through local auth', async () => {
  const s = await setup(), a = await s.create();
  s.advance(new Date('2026-11-01T12:00:00Z'));
  for (const token of [a.invites[0].token, '', 'bad', '%.oops', `unknown.${'a'.repeat(64)}`, `${a.invites[0].tenantId}.${'b'.repeat(64)}`]) {
    const result = await s.call(`/invite/${token}`); assert.equal(result.status, 200); assert.deepEqual(result.data, token === a.invites[0].token ? {valid: false, reason: 'expired'} : {valid: false});
  }
  assert.deepEqual(localAuth('/invite/token', false, '', {verify: () => { throw Error('Must not verify'); }}), {});
  assert.throws(() => localAuth('/admin/invites', false, '', s.tokens));
});
test('acceptance is atomic, single-use, role-fixed, isolated and signs in as staff', async () => {
  const s = await setup(), a = await s.create(), b = await s.create(), invite = a.invites[0];
  const repo = s.repositories.forTenant(invite.tenantId), other = s.repositories.forTenant(b.invites[0].tenantId);
  const before = await other.workspaceUsers(), otherInvites = await other.crmList('invite');
  const invitesBefore = await repo.crmList('invite');
  const path = `/invite/${invite.token}/accept`, body = {name: 'New Name', email: 'STAFF@example.test'};
  for (const extra of [{role: 'admin'}, {tenantId: b.invites[0].tenantId}]) assert.equal((await s.call(path, '', 'POST', {...body, ...extra})).status, 400);
  assert.equal((await s.call(path, '', 'POST', {...body, email: 'wrong@example.test'})).data.outcome, 'email-mismatch');
  assert.equal((await repo.workspaceUsers()).length, 1);
  assert.equal((await s.call(`/invite/${b.invites[0].tenantId}.${invite.token.split('.')[1]}/accept`, '', 'POST', body)).data.outcome, 'refused');
  const results = await Promise.all([s.call(path, '', 'POST', body), s.call(path, '', 'POST', body)]);
  assert.equal(results.filter(r => r.data.outcome === 'accepted').length, 1);
  assert.equal(results.filter(r => r.data.outcome === 'refused').length, 1);
  const accepted = (await repo.crmGet('invite', invite.id))!;
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.acceptedAt, now.toISOString()); assert.equal(accepted.acceptedName, 'New Name');
  assert.equal(accepted.token, ''); assert.equal(accepted.tokenHash, '');
  assert.deepEqual(await repo.crmList('invite'), invitesBefore.map(row => row.id === accepted.id ? accepted : row));
  const rows = await repo.workspaceUsers(); assert.equal(rows.length, 2);
  assert.equal(rows[1].user.id, accepted.acceptedUserId); assert.equal(rows[1].membership.role, 'staff'); assert.equal(rows[1].membership.active, true);
  assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: false, reason: 'accepted'});
  assert.equal((await s.call(path, '', 'POST', body)).data.reason, 'accepted');
  const signed = await localSession(JSON.stringify({tenantId: invite.tenantId, email: invite.email}), s.repositories, s.tokens, now);
  const token = JSON.parse(signed.body).data.token;
  for (const route of ['/admin/users', '/admin/invites']) assert.equal((await s.call(route, token)).status, 403);
  const events = (await repo.events()).filter(e => ['invite.accepted', 'user.added'].includes(e.type));
  assert.deepEqual(events.map(e => e.type), ['invite.accepted', 'user.added']);
  assert.ok(!JSON.stringify(events).includes(invite.token)); assert.ok(!JSON.stringify(events).includes('@'));
  assert.deepEqual(await other.workspaceUsers(), before); assert.deepEqual(await other.crmList('invite'), otherInvites);
  assert.equal((await s.call(`/admin/invites/${invite.id}/reissue`, a.token, 'POST', {version: 2})).status, 409);
});
test('revoked, expired and unknown acceptance links refuse; existing members keep pending invites', async () => {
  const s = await setup(), a = await s.create(), [invite, expiring] = a.invites;
  const accept = (i: Invite) => s.call(`/invite/${i.token}/accept`, '', 'POST', {name: i.name, email: i.email});
  await s.call('/admin/users', a.token, 'POST', {name: 'Existing', email: invite.email, role: 'staff'});
  assert.equal((await accept(invite)).data.outcome, 'already-member');
  const repo = s.repositories.forTenant(invite.tenantId);
  assert.equal((await repo.crmGet('invite', invite.id))!.status, 'pending'); assert.equal((await repo.workspaceUsers()).length, 2);
  await s.call(`/admin/invites/${invite.id}/revoke`, a.token, 'POST', {version: 1});
  assert.equal((await accept(invite)).data.reason, 'revoked');
  assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: false, reason: 'revoked'});
  s.advance(new Date('2026-11-01T12:00:00Z'));
  assert.equal((await accept(expiring)).data.reason, 'expired');
  assert.equal((await s.call('/invite/bad/accept', '', 'POST', {name: 'Name', email: invite.email})).data.outcome, 'refused');
});
test('Dynamo acceptance conditions invite and membership guard in the same transaction as identity and both events', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, QueryCommand, TransactWriteCommand} = await import('@aws-sdk/lib-dynamodb');
  const s = await setup(), a = await s.create(), invite = a.invites[0];
  const rows = await s.repositories.forTenant(invite.tenantId).workspaceUsers();
  const commands: any[] = [];
  const client = {send: async (command: any) => {
    commands.push(command);
    if (command instanceof GetCommand) return command.input.Key?.SK === 'MEMBERSHIP_GUARD' ? {Item: {data: {version: 4}}} : {Item: {data: invite}};
    if (command instanceof QueryCommand) return {Items: rows.map(r => ({data: command.input.ExpressionAttributeValues?.[':prefix'] === 'USER#' ? r.user : r.membership}))};
    return {};
  }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant(invite.tenantId);
  const user = {id: 'new-user', name: 'New Name', email: invite.email};
  assert.equal(await repo.acceptInvite(invite, user, now), 'accepted');
  assert.equal(commands[0].input.Key.SK, 'MEMBERSHIP_GUARD');
  const items = (commands.at(-1) as InstanceType<typeof TransactWriteCommand>).input.TransactItems!;
  assert.equal(items.length, 6); assert.ok(items.every(i => i.Put?.Item?.PK === `TENANT#${invite.tenantId}`));
  assert.equal(items[0].Put?.ExpressionAttributeValues?.[':v'], 4);
  assert.equal(items[1].Put?.ExpressionAttributeValues?.[':v'], invite.version);
  assert.equal(items[1].Put?.ConditionExpression, '#d.#v = :v');
  assert.equal(items[1].Put?.Item?.data.status, 'accepted');
  assert.equal(items[3].Put?.Item?.data.role, 'staff');
  assert.deepEqual(items.slice(4).map(i => i.Put?.Item?.data.type), ['invite.accepted', 'user.added']);
  await assert.rejects(repo.acceptInvite({...invite, tenantId: 'other'}, user, now));
  invite.status = 'revoked'; await assert.rejects(repo.acceptInvite(invite, user, now));
});

test('post-signup invitations are tenant-scoped, seven-day, single-use and role-locked', async () => {
  const s = await setup(), a = await s.create([]), b = await s.create([]);
  const tenantId = s.tokens.verify(a.token)['custom:tenant_id'], repo = s.repositories.forTenant(tenantId);
  assert.deepEqual((await s.call('/admin/invites', a.token)).data, []);
  const input = {name: 'New colleague', email: ' NEW@example.test ', role: 'staff'};
  const created = await s.call('/admin/invites', a.token, 'POST', input);
  assert.equal(created.status, 201);
  const invite: Invite = created.data;
  assert.equal(invite.name, input.name); assert.equal(invite.email, 'new@example.test');
  assert.equal(invite.tenantId, tenantId); assert.equal(invite.status, 'pending');
  assert.equal(invite.expiresAt, new Date(now.getTime() + 7 * 86400000).toISOString());
  assert.equal(invite.tokenHash, createHash('sha256').update(invite.token).digest('hex'));
  assert.deepEqual((await s.call('/admin/invites', a.token)).data, [invite]);
  assert.deepEqual((await s.call('/admin/invites', b.token)).data, []);
  for (const action of ['reissue', 'revoke']) assert.equal((await s.call(`/admin/invites/${invite.id}/${action}`, b.token, 'POST', {version: 1})).status, 404);
  // The same address in another workspace must not block creation.
  assert.equal((await s.call('/admin/invites', b.token, 'POST', input)).status, 201);
  assert.deepEqual((await s.call(`/invite/${invite.token}`)).data, {valid: true, dealership: 'Test Motors', inviter: 'Owner', name: invite.name, email: invite.email, role: 'staff'});
  const path = `/invite/${invite.token}/accept`, profile = {name: invite.name, email: invite.email};
  assert.equal((await s.call(path, '', 'POST', {...profile, role: 'admin'})).status, 400);
  assert.equal((await repo.workspaceUsers()).length, 1);
  assert.equal((await s.call(path, '', 'POST', profile)).data.outcome, 'accepted');
  assert.equal((await s.call(path, '', 'POST', profile)).data.outcome, 'refused');
  const members = await repo.workspaceUsers(); assert.equal(members.length, 2);
  const member = members.find(row => row.user.email === invite.email)!;
  assert.equal(member.membership.role, 'staff'); assert.equal(member.membership.active, true);
  const staffToken = s.tokens.issue(member.user.id, tenantId);
  assert.equal((await s.call('/admin/invites', staffToken, 'POST', {...input, email: 'another@example.test'})).status, 403);
  assert.equal((await s.call('/admin/invites', a.token, 'POST', input)).status, 409);
  const events = (await repo.events()).filter(event => event.aggregateId === invite.id);
  assert.deepEqual(events.map(event => event.type), ['invite.created', 'invite.accepted']);
  assert.equal(events[0].actorId, s.tokens.verify(a.token).sub);
  assert.ok(!JSON.stringify(events).includes('token')); assert.ok(!JSON.stringify(events).includes(invite.token));
  assert.ok(!JSON.stringify(events).includes('@'));
});
test('post-signup invitation validation and duplicate checks include inactive users and allow revoked or expired invites', async () => {
  const s = await setup(), a = await s.create([]);
  const input = {name: 'Colleague', email: 'colleague@example.test', role: 'admin'};
  const create = (patch: Record<string, unknown> = {}) => s.call('/admin/invites', a.token, 'POST', {...input, ...patch});
  for (const patch of [{name: ''}, {name: 42}, {name: 'x'.repeat(121)}, {email: 'bad'}, {email: null}, {role: 'owner'}, {role: null}, {tenantId: 'other'}, {token: 'supplied'}])
    assert.equal((await create(patch)).status, 400);
  const repo = s.repositories.forTenant(s.tokens.verify(a.token)['custom:tenant_id']);
  assert.deepEqual(await repo.crmList('invite'), []);
  assert.equal((await create({email: ' OWNER@example.test '})).status, 409);
  const user = (await s.call('/admin/users', a.token, 'POST', {...input, email: 'inactive@example.test'})).data;
  assert.equal((await s.call(`/admin/users/${user.userId}/deactivate`, a.token, 'POST', {version: user.version})).status, 200);
  const inactive = await create({email: 'INACTIVE@example.test'}); assert.equal(inactive.status, 409);
  assert.match(inactive.error.message, /already in the workspace.*Users/);
  const first = await create(); assert.equal(first.status, 201); assert.equal(first.data.role, 'admin');
  const duplicate = await create({email: ' COLLEAGUE@example.test '}); assert.equal(duplicate.status, 409);
  assert.match(duplicate.error.message, /Reissue or revoke/);
  assert.equal((await s.call(`/admin/invites/${first.data.id}/revoke`, a.token, 'POST', {version: 1})).status, 200);
  const second = await create(); assert.equal(second.status, 201); assert.notEqual(second.data.id, first.data.id);
  s.advance(new Date(second.data.expiresAt));
  assert.equal((await create()).status, 201);
});

test('fresh onboarding session preserves the entered owner identity for the sidebar', async () => {
  const s = await setup();
  const result = await localSession(JSON.stringify({...payload(), name: 'Olivia Owner', invites: []}), s.repositories, s.tokens, now);
  const {token} = JSON.parse(result.body).data;
  const session = await s.call('/session', token);
  assert.equal(session.status, 200);
  assert.deepEqual(session.data.user, {id: s.tokens.verify(token).sub, name: 'Olivia Owner', email: 'owner@example.test'});
  assert.equal(session.data.tenant.name, 'Test Motors');
});

test('both signup branches require current versions before any repository access', async () => {
  const s = await setup();
  for (const base of [payload(), {dealership: 'Local Motors', name: 'Owner'}]) {
    for (const [acceptance, status] of [[undefined, 400], [null, 400], [{}, 400], [{termsVersion: TERMS_VERSION}, 400], [{...payload().acceptance, extra: true}, 400], [{...payload().acceptance, termsVersion: 'old'}, 409], [{...payload().acceptance, privacyVersion: 'old'}, 409]] as const) {
      await assert.rejects(localSession(JSON.stringify({...base, acceptance}), {forTenant: () => { assert.fail('No repository access before validation'); }}, s.tokens, now), error => (error as {status: number}).status === status);
    }
    await assert.rejects(localSession(JSON.stringify({...base, acceptance: payload().acceptance, extra: true}), {forTenant: () => { assert.fail('No repository access before validation'); }}, s.tokens, now), error => (error as {status: number}).status === 400);
  }
});

test('signup acceptance is immutable, exact, admin-only and tenant isolated', async () => {
  const s = await setup(), a = await s.create([]), b = await s.create([]);
  const claims = s.tokens.verify(a.token), tenantId = claims['custom:tenant_id'];
  const repo = s.repositories.forTenant(tenantId), records = await repo.crmList('terms-acceptance');
  assert.deepEqual(records, [{id: 'signup', kind: 'terms-acceptance', tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), acceptedAt: now.toISOString(), userId: claims.sub, name: 'Owner', email: 'owner@example.test', termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, sharingPolicy: 'standard'}]);
  assert.deepEqual((await s.call('/admin/terms-acceptance', a.token)).data, records[0]);
  const other = await s.call('/admin/terms-acceptance', b.token);
  assert.notEqual(other.data.tenantId, tenantId); assert.notEqual(other.data.userId, claims.sub);
  assert.equal((await s.call('/admin/terms-acceptance', b.token, 'GET', undefined)).status, 200);
  const staff = (await s.call('/admin/users', a.token, 'POST', {name: 'Staff', email: 'staff@example.test', role: 'staff'})).data;
  assert.equal((await s.call('/admin/terms-acceptance', s.tokens.issue(staff.userId, tenantId))).status, 403);
  assert.equal((await s.call('/admin/terms-acceptance', a.token, 'POST', {})).status, 405);
  const events = (await repo.events()).filter(e => e.type === 'terms-acceptance.created');
  assert.equal(events.length, 1); assert.equal(events[0].actorId, claims.sub); assert.equal(events[0].aggregateId, 'signup');
  assert.doesNotMatch(JSON.stringify(events), /email|example.test|token/);
  await assert.rejects(repo.crmWrite([{record: {...records[0], version: 2}, expectedVersion: 1, event: {...events[0], aggregateVersion: 2}}]), /immutable/);
  await assert.rejects(repo.crmWrite([{record: records[0], expectedVersion: 0, event: events[0]}]));
  assert.deepEqual(await repo.crmList('terms-acceptance'), records);
});

test('simple local signup records acceptance with an explicit absent email', async () => {
  const s = await setup();
  const result = await localSession(JSON.stringify({dealership: 'Local', name: 'Owner', acceptance: payload().acceptance}), s.repositories, s.tokens, now);
  const token = JSON.parse(result.body).data.token;
  const acceptance = (await s.call('/admin/terms-acceptance', token)).data;
  assert.equal(acceptance.email, null); assert.equal(acceptance.sharingPolicy, 'standard'); assert.equal(acceptance.termsVersion, TERMS_VERSION);
});

test('Dynamo signup writes identity, acceptance and metadata event in one conditional transaction', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {TransactWriteCommand} = await import('@aws-sdk/lib-dynamodb');
  const commands: any[] = [];
  const client = {send: async (command: any) => { commands.push(command); return {}; }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
  const s = await setup();
  await localSession(JSON.stringify({...payload(), invites: []}), new DynamoRepositories('table', client), s.tokens, now);
  assert.equal(commands.length, 1); assert.ok(commands[0] instanceof TransactWriteCommand);
  const items = commands[0].input.TransactItems!;
  assert.equal(items.length, 6);
  const record = items.find(i => i.Put?.Item?.SK === 'TERMS-ACCEPTANCE#signup')!.Put!.Item!.data;
  assert.equal(record.email, 'owner@example.test');
  assert.ok(items.every((i: any) => i.Put.Item.PK === `TENANT#${record.tenantId}` && i.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  assert.equal(items.filter((i: any) => i.Put.Item.data.type === 'terms-acceptance.created').length, 1);
});
