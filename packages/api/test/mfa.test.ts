import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { OutboxEvent } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { base32, decodeBase32, generateTotpSecret, hotp, totp, verifyTotp, otpauthUrl } from '../src/totp.js';
const initial = new Date('2026-10-22T12:00:00Z');
async function setup() {
  let now = new Date(initial);
  const memory = new MemoryRepositories();
  for (const tenantId of ['A', 'B']) await memory.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: 'admin', name: 'Administrator'}, {tenantId, userId: 'admin', role: 'admin', active: true}, {id: 'provision', tenantId, actorId: 'admin', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  // Membership administration is not exposed by this build. Supply additional
  // active/inactive membership fixtures while retaining the real tenant storage.
  const repositories = {forTenant: (tenantId: string) => {
    const repo = memory.forTenant(tenantId);
    return {...repo, membership: async (userId: string) => tenantId === 'A' && ['staff', 'inactive'].includes(userId) ? {tenantId, userId, role: 'staff' as const, active: userId === 'staff'} : repo.membership(userId), users: async () => [...await repo.users(), ...(tenantId === 'A' ? [{id: 'staff', name: 'Staff'}] : [])]};
  }};
  const handler = createHandler(repositories, {decode: async () => { throw Error('No network'); }}, () => now, undefined, undefined, undefined, async () => { throw Error('No sends'); });
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  const call = async (path: string, method = 'GET', body: unknown = {}, tenant = 'A', user = 'admin') => {
    const result = await handler({path, method, body: JSON.stringify(body), claims: tokens.verify(tokens.issue(user, tenant))});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const post = (action: string, code?: string, tenant = 'A', user = 'admin') => call(`/account/mfa/${action}`, 'POST', code === undefined ? {} : {code}, tenant, user);
  const enable = async (user = 'admin') => {
    const result = await post('setup', undefined, 'A', user); assert.equal(result.status, 200);
    const secret = result.data.secret as string;
    const enabled = await post('enable', totp(secret, now), 'A', user); assert.equal(enabled.status, 200);
    return {secret, codes: enabled.data.recoveryCodes as string[]};
  };
  return {memory, repositories, call, post, enable, handler, now: () => now, advance: (ms = 30000) => { now = new Date(now.getTime() + ms); }};
}
function wrong(secret: string, now: Date): string {
  for (let n = 0; n < 1000000; n++) { const code = String(n).padStart(6, '0'); if (verifyTotp(secret, code, now) === null) return code; }
  throw Error('No incorrect code');
}
test('RFC 6238 exact SHA-1 eight-digit vectors, six-digit derivation and tolerant base32', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']] as const) {
    const date = new Date(seconds * 1000);
    assert.equal(hotp(secret, Math.floor(seconds / 30), 8), expected);
    assert.equal(totp(secret, date), expected.slice(-6));
    assert.equal(verifyTotp(secret, expected.slice(-6), date), Math.floor(seconds / 30));
  }
  assert.equal(decodeBase32(` ${secret.toLowerCase()}====\n`).toString(), '12345678901234567890');
  assert.equal(base32(Buffer.from('f')), 'MY'); assert.equal(decodeBase32('MY======').toString(), 'f');
  const generated = generateTotpSecret(); assert.match(generated, /^[A-Z2-7]{32}$/); assert.equal(decodeBase32(generated).length, 20);
  const step = Math.floor(initial.getTime() / 30000);
  for (const offset of [-1, 0, 1]) assert.equal(verifyTotp(secret, hotp(secret, step + offset), initial), step + offset);
  assert.equal(verifyTotp(secret, hotp(secret, step - 2), initial), null);
  assert.equal(verifyTotp(secret, '12345', initial), null);
  assert.ok(otpauthUrl(secret, 'a & b').includes('freeDMS:a%20%26%20b?'));
});
test('setup replaces pending secret; enabling reveals recovery codes once and session reports status', async () => {
  const s = await setup();
  assert.deepEqual((await s.call('/account/mfa')).data, {userId: 'admin', enabled: false, recoveryCodesRemaining: 0, lockedUntil: null});
  assert.equal((await s.call('/session')).data.mfaEnabled, false);
  const first = (await s.post('setup')).data, second = (await s.post('setup')).data;
  assert.notEqual(first.secret, second.secret); assert.equal(second.enabled, false);
  assert.equal(new URL(second.otpauthUrl).searchParams.get('secret'), second.secret);
  assert.equal((await s.call('/account/mfa')).data.enabled, false);
  assert.equal((await s.post('enable', 'bad')).status, 400);
  assert.equal((await s.memory.forTenant('A').mfa('admin'))?.failedAttempts, 0);
  assert.equal((await s.post('enable', wrong(second.secret, s.now()))).error.code, 'MFA_INVALID');
  const enabled = await s.post('enable', totp(second.secret, s.now())); assert.equal(enabled.status, 200);
  const codes = enabled.data.recoveryCodes as string[]; assert.equal(new Set(codes).size, 8);
  const stored = (await s.memory.forTenant('A').mfa('admin'))!;
  assert.equal(stored.pendingSecret, null); assert.equal(stored.secret, second.secret); assert.equal(stored.failedAttempts, 0);
  for (const code of codes) {
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(!JSON.stringify(stored).includes(code));
    assert.ok(stored.recoveryHashes.includes(createHash('sha256').update(code.replace('-', '')).digest('hex')));
  }
  assert.equal((await s.post('setup')).status, 409);
  assert.equal((await s.call('/session')).data.mfaEnabled, true);
  const publicJson = JSON.stringify([await s.call('/account/mfa'), await s.call('/admin/mfa'), await s.call('/session'), await s.memory.forTenant('A').events()]);
  for (const value of [first.secret, second.secret, ...codes, ...stored.recoveryHashes]) assert.ok(!publicJson.includes(value));
  assert.deepEqual((await s.memory.forTenant('A').events()).filter(e => e.type.startsWith('mfa.')).map(e => e.type), ['mfa.setup', 'mfa.setup', 'mfa.verified', 'mfa.enabled']);
});
test('TOTP rejects replay across operations; normalized recovery code works exactly once, including concurrent calls', async () => {
  const s = await setup(); const {secret, codes} = await s.enable();
  assert.equal((await s.post('verify', totp(secret, s.now()))).status, 401);
  s.advance(); assert.deepEqual((await s.post('verify', totp(secret, s.now()))).data, {verified: true});
  assert.equal((await s.post('disable', totp(secret, s.now()))).status, 401);
  assert.equal((await s.post('verify', codes[0].toLowerCase().replace('-', ' '))).status, 200);
  assert.equal((await s.post('verify', codes[0])).status, 401);
  const results = await Promise.all([s.post('verify', codes[1]), s.post('verify', codes[1])]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.some(r => r.status === 409 || r.status === 401));
  assert.equal((await s.call('/account/mfa')).data.recoveryCodesRemaining, 6);
});
test('every verification endpoint persists failures, locks after five, and recovers after injected time advances', async () => {
  for (const action of ['enable', 'verify', 'disable', 'recovery-codes']) {
    const s = await setup();
    const secret = action === 'enable' ? (await s.post('setup')).data.secret : (await s.enable()).secret;
    s.advance(); const bad = wrong(secret, s.now());
    for (let i = 0; i < 4; i++) assert.equal((await s.post(action, bad)).status, 401);
    assert.equal((await s.post(action, bad)).error.code, 'MFA_LOCKED');
    const record = (await s.memory.forTenant('A').mfa('admin'))!;
    assert.equal(record.failedAttempts, 0); assert.equal(Date.parse(record.lockedUntil!), s.now().getTime() + 900000);
    if (action === 'enable') await s.post('setup'); // Replacing setup cannot bypass lockout.
    assert.equal((await s.post(action, totp(secret, s.now()))).status, 429);
    assert.equal((await s.memory.forTenant('A').mfa('admin'))!.version, record.version + (action === 'enable' ? 1 : 0));
    s.advance(900000);
    const current = (await s.memory.forTenant('A').mfa('admin'))!;
    assert.equal((await s.post(action, totp(current.pendingSecret ?? current.secret!, s.now()))).status, 200);
    assert.equal((await s.memory.forTenant('A').mfa('admin'))!.lockedUntil, null);
  }
});
test('regeneration needs a fresh TOTP, invalidates old codes; disable requires proof and clears state', async () => {
  const s = await setup(); const {secret, codes} = await s.enable();
  assert.equal((await s.post('recovery-codes', codes[0])).status, 400);
  s.advance(); const regenerated = await s.post('recovery-codes', totp(secret, s.now())); assert.equal(regenerated.status, 200);
  assert.equal((await s.post('verify', codes[0])).status, 401);
  assert.equal((await s.post('disable', wrong(secret, s.now()))).status, 401);
  assert.equal((await s.post('disable', regenerated.data.recoveryCodes[0])).status, 200);
  const record = (await s.memory.forTenant('A').mfa('admin'))!;
  assert.deepEqual([record.enabled, record.secret, record.pendingSecret, record.recoveryHashes, record.failedAttempts, record.lockedUntil, record.lastTotpStep], [false, null, null, [], 0, null, null]);
  assert.equal((await s.post('verify', regenerated.data.recoveryCodes[1])).status, 409);
  assert.equal((await s.call('/session')).data.mfaEnabled, false);
  await s.enable();
  s.advance(); const nextSecret = (await s.memory.forTenant('A').mfa('admin'))!.secret!;
  assert.equal((await s.post('disable', totp(nextSecret, s.now()))).status, 200);
});
test('admin reset clears another active user; resetting MFA-off or absent records succeeds idempotently', async () => {
  const s = await setup(); const {secret, codes} = await s.enable('staff');
  const list = await s.call('/admin/mfa'); assert.deepEqual(list.data, [{userId: 'admin', name: 'Administrator', enabled: false}, {userId: 'staff', name: 'Staff', enabled: true}]);
  assert.ok(!JSON.stringify(list).includes(secret)); assert.ok(!JSON.stringify(list).includes(codes[0]));
  for (const path of ['/admin/mfa', '/admin/mfa/admin/reset']) assert.equal((await s.call(path, path.endsWith('reset') ? 'POST' : 'GET', {}, 'A', 'staff')).status, 403);
  assert.equal((await s.call('/admin/mfa/staff/reset', 'POST')).status, 200);
  assert.equal((await s.call('/account/mfa', 'GET', {}, 'A', 'staff')).data.enabled, false);
  const record = (await s.memory.forTenant('A').mfa('staff'))!;
  assert.equal(record.secret, null); assert.deepEqual(record.recoveryHashes, []);
  const reset = (await s.memory.forTenant('A').events()).find(e => e.type === 'mfa.reset')!; assert.equal(reset.actorId, 'admin'); assert.equal(reset.aggregateId, 'staff');
  for (const id of ['staff', 'admin', 'admin']) assert.equal((await s.call(`/admin/mfa/${id}/reset`, 'POST')).status, 200);
  for (const id of ['inactive', 'missing']) assert.equal((await s.call(`/admin/mfa/${id}/reset`, 'POST')).status, 404);
});
test('MFA isolation is per user AND tenant, even for the same user id; B cannot reset A-only users', async () => {
  const s = await setup(); const {secret, codes} = await s.enable(); await s.enable('staff');
  const responses = [await s.call('/account/mfa', 'GET', {}, 'B'), await s.call('/admin/mfa', 'GET', {}, 'B')];
  assert.equal(responses[0].data.enabled, false); assert.equal(responses[1].data[0].enabled, false);
  assert.equal((await s.call('/account/mfa', 'GET', {}, 'A', 'staff')).data.enabled, true);
  for (const action of ['verify', 'enable']) { const result = await s.post(action, totp(secret, s.now()), 'B'); assert.equal(result.status, 409); responses.push(result); }
  const reset = await s.call('/admin/mfa/staff/reset', 'POST', {}, 'B'); assert.equal(reset.status, 404); responses.push(reset);
  await s.call('/admin/mfa/admin/reset', 'POST', {}, 'B'); assert.equal((await s.call('/account/mfa')).data.enabled, true);
  for (const value of [secret, ...codes]) assert.ok(!JSON.stringify(responses).includes(value));
  const b = (await s.post('setup', undefined, 'B')).data; assert.notEqual(b.secret, secret);
  assert.equal((await s.memory.forTenant('A').mfa('admin'))!.secret, secret);
});
test('MFA validates bodies, routes, methods, auth and does not accept tenant ids', async () => {
  const s = await setup();
  assert.equal((await s.handler({path: '/account/mfa', method: 'GET'})).statusCode, 401);
  assert.equal((await s.call('/account/mfa/unknown')).status, 404);
  assert.equal((await s.call('/account/mfa/setup', 'GET')).status, 405);
  assert.equal((await s.call('/account/mfa', 'POST')).status, 405);
  assert.equal((await s.call('/account/mfa/setup', 'POST', {tenantId: 'B'})).status, 400);
  assert.equal((await s.call('/admin/mfa/admin/reset', 'POST', {code: '123456'})).status, 400);
  await s.post('setup');
  for (const code of ['', '12345', '1234567', 123456, null, 'abcdef', '123 456']) assert.equal((await s.call('/account/mfa/enable', 'POST', {code})).status, 400);
});
test('memory MFA writes reject scope/event/version violations, clone records and enforce optimistic concurrency', async () => {
  const s = await setup(); await s.post('setup');
  const a = s.memory.forTenant('A'), b = s.memory.forTenant('B');
  const old = (await a.mfa('admin'))!, record = {...old, version: old.version + 1};
  const event: OutboxEvent = {id: 'change', tenantId: 'A', actorId: 'admin', aggregateId: 'admin', aggregateVersion: record.version, type: 'mfa.setup', occurredAt: s.now().toISOString(), deliveryStatus: 'pending'};
  await assert.rejects(b.saveMfa(record, old.version, event), /scope/);
  await assert.rejects(a.saveMfa(record, old.version, {...event, tenantId: 'B'}), /scope/);
  for (const patch of [{aggregateId: 'other'}, {aggregateVersion: 99}, {type: 'webhook.created' as const}]) await assert.rejects(a.saveMfa(record, old.version, {...event, ...patch}), /outbox/);
  await assert.rejects(a.saveMfa({...record, userId: 'other'}, old.version, {...event, aggregateId: 'other'}), /version/);
  await a.saveMfa(record, old.version, event);
  record.pendingSecret = 'modified'; assert.notEqual((await a.mfa('admin'))!.pendingSecret, 'modified');
  await assert.rejects(a.saveMfa(record, old.version, {...event, id: 'stale'}), /changed/);
  assert.equal(await b.mfa('admin'), undefined);
});
