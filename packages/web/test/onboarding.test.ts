import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardingError, type Onboarding } from '../src/onboarding.js';
import { inviteLandingHtml, inviteLink } from '../src/invites.js';
import { usersHtml } from '../src/users.js';
import type { Invite } from '@freedms/shared';
const data: Onboarding = {name: 'Owner', email: 'owner@example.test', dealership: 'Motors', address: 'Main St', phone: '555', dealerType: 'other', invites: []};
test('wizard validates each step, permits skipping invites, and rejects duplicate/self invites', () => {
  for (const step of [0, 1, 2]) assert.equal(onboardingError(data, step), '');
  assert.ok(onboardingError({...data, name: ''}, 0)); assert.ok(onboardingError({...data, email: 'bad'}, 0));
  for (const field of ['dealership', 'address', 'phone', 'dealerType']) assert.ok(onboardingError({...data, [field]: ''}, 1));
  const row = {name: 'Team', email: 'team@example.test', role: 'staff'};
  for (const invites of [[{...row, email: 'bad'}], [row, {...row, email: ' TEAM@example.test '}], [{...row, email: 'OWNER@example.test'}]]) assert.ok(onboardingError({...data, invites}, 2));
});
test('invite pages escape content and explain pending acceptance and unavailable links', () => {
  const html = inviteLandingHtml({valid: true, dealership: '<Motors>', role: 'staff'});
  assert.match(html, /&lt;Motors&gt;/); assert.match(html, /Acceptance and profile setup arrive in the next step/);
  assert.match(inviteLandingHtml({valid: false}), /expired, been revoked, or been replaced/);
  assert.equal(inviteLink('token', 'https://example.test/app/'), 'https://example.test/app/#/invite/token');
});
test('users show copyable pending links and final revocation without mutation actions', () => {
  const pending = {id: 'i', name: '<Team>', email: 'team@example.test', role: 'staff', status: 'pending', expiresAt: '2026-11-01', token: 'secret'} as Invite;
  const html = usersHtml([], true, [pending, {...pending, id: 'revoked', status: 'revoked', token: ''}], 'https://example.test/');
  assert.match(html, /&lt;Team&gt;/); assert.match(html, /https:\/\/example.test\/#\/invite\/secret/);
  assert.match(html, /data-action="reissue"/); assert.match(html, /data-action="revoke"/);
  assert.doesNotMatch(html, /data-invite="revoked"/); assert.match(html, /Revocation is final/);
});
