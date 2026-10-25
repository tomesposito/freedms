import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteLandingHtml, inviteSignInHtml, welcomeHtml } from '../src/invites.js';
import { usersHtml } from '../src/users.js';
test('hosted invitation requires sign-in and never advertises passwordless local access', () => {
  const html = inviteLandingHtml({valid: true, dealership: 'Demo', inviter: 'Admin', name: 'Staff', email: 'staff@example.test', role: 'staff'}, true);
  assert.match(html, /Sign in to accept/); assert.match(html, /id="accept-invite" hidden/);
  assert.doesNotMatch(html, /No password is needed/);
  const accepted = inviteSignInHtml('tenant', 'staff@example.test', false, true);
  assert.match(accepted, /Open your workspace/); assert.doesNotMatch(accepted, /workspace ID/);
});
test('hosted account screens do not offer independent MFA enrollment or local identity creation', () => {
  const html = usersHtml([{userId: 'admin', name: 'Admin', email: 'admin@example.test', active: true, role: 'admin', version: 1, mfaEnabled: false}], true, [], undefined, true);
  assert.doesNotMatch(html, /id="add-user"|Local sign-in only/); assert.match(html, /Required at sign-in/); assert.match(html, /Deactivate/);
  const welcome = welcomeHtml('staff', 'Demo', true);
  assert.doesNotMatch(welcome, /Skip MFA|MFA is optional/); assert.match(welcome, /requires an authenticator/);
});
