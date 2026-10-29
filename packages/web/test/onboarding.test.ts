import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardingError, type Onboarding } from '../src/onboarding.js';
import { inviteLandingHtml, inviteLink, welcomeHtml, welcomeDismissed, dismissWelcome, invitedEmailMatches } from '../src/invites.js';
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
  const html = inviteLandingHtml({valid: true, dealership: '<Motors>', inviter: 'Owner', name: 'Team', email: 'team@example.test', role: 'staff'});
  assert.match(html, /&lt;Motors&gt;/); assert.match(html, /Set up your profile/);
  assert.match(inviteLandingHtml({valid: false}), /Ask your admin to reissue a link/);
  assert.equal(inviteLink('token', 'https://example.test/app/'), 'https://example.test/app/#/invite/token');
});
test('users show copyable pending links and final revocation without mutation actions', () => {
  const pending = {id: 'i', name: '<Team>', email: 'team@example.test', role: 'staff', status: 'pending', expiresAt: '2026-11-01', token: 'secret'} as Invite;
  const html = usersHtml([], true, [pending, {...pending, id: 'revoked', status: 'revoked', token: ''}], 'https://example.test/');
  assert.match(html, /&lt;Team&gt;/); assert.match(html, /https:\/\/example.test\/#\/invite\/secret/);
  assert.match(html, /data-action="reissue"/); assert.match(html, /data-action="revoke"/);
  assert.doesNotMatch(html, /data-invite="revoked"/); assert.match(html, /Revocation is final/);
});

test('profile has fixed role, prefilled identity and reason-specific dead ends', () => {
  const html = inviteLandingHtml({valid: true, dealership: 'Motors', inviter: 'Owner', name: 'Team', email: 'team@example.test', role: 'staff'});
  for (const value of ['Owner', 'staff', 'value="Team"', 'value="team@example.test"']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /name="role"|<select/);
  for (const [reason, title] of [['expired', 'expired'], ['revoked', 'revoked'], ['accepted', 'already used']] as const) {
    const dead = inviteLandingHtml({valid: false, reason}); assert.ok(dead.includes(title)); assert.match(dead, /reissue a link/);
  }
  assert.equal(invitedEmailMatches(' TEAM@example.test ', 'team@example.test'), true);
  assert.equal(invitedEmailMatches('other@example.test', 'team@example.test'), false);
});
test('welcome explains roles and dismissal persists per user and tenant', () => {
  assert.match(welcomeHtml('admin', 'Motors'), /manage users, invites and workspace settings/);
  assert.match(welcomeHtml('staff', 'Motors'), /will refuse access/);
  assert.match(welcomeHtml('staff', 'Motors'), /later in Account/);
  const values = new Map<string, string>(); const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }};
  assert.equal(welcomeDismissed(storage, 'A', 'user'), false); dismissWelcome(storage, 'A', 'user');
  assert.equal(welcomeDismissed(storage, 'A', 'user'), true);
  assert.equal(welcomeDismissed(storage, 'B', 'user'), false); assert.equal(welcomeDismissed(storage, 'A', 'other'), false);
});
test('accepted invite audit shows when and as whom without copy or mutation actions', () => {
  const html = usersHtml([], true, [{id: 'used', name: 'Original', email: 'team@example.test', role: 'staff', status: 'accepted', acceptedAt: '2026-10-25', acceptedName: '<New Name>', token: '', expiresAt: '2026-11-01'} as Invite], 'https://example.test/');
  assert.match(html, /Accepted 2026-10-25 as &lt;New Name&gt; \(team@example.test\)/);
  assert.doesNotMatch(html, /data-copy|data-invite="used"/);
});

test('local admins can create invitations from an empty Users page separately from adding users', () => {
  const html = usersHtml([], true);
  const forms = [...html.matchAll(/<form[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  assert.deepEqual(forms.map(match => match[1]), ['add-user', 'create-invite']);
  const inviteForm = forms[1][2];
  for (const name of ['name', 'email', 'role']) assert.ok(inviteForm.includes(`name="${name}"`));
  assert.match(inviteForm, /<select name="role"><option value="staff">Staff<\/option><option value="admin">Admin/);
  assert.match(inviteForm, />Create invitation<\/button>/);
  assert.match(html, /No invites/); assert.match(html, /share copyable invite links themselves; no email is sent/);
  const hosted = usersHtml([], true, [], undefined, true);
  assert.doesNotMatch(hosted, /id="create-invite"|id="add-user"/);
  assert.match(hosted, /Pilot accounts are created by your pilot operator/);
  for (const hosted of [false, true]) assert.equal(usersHtml([], false, [], undefined, hosted), '<h1>Users</h1><p>Only administrators can manage workspace users.</p>');
});

test('finish requires assent and sends current document versions without client checkbox state', async () => {
  const {signupPayload, acceptanceHtml} = await import('../src/onboarding.js');
  const {TERMS_VERSION, PRIVACY_VERSION} = await import('@freedms/shared');
  assert.ok(onboardingError(data, 3)); assert.equal(onboardingError(data, 3, true), '');
  const html = acceptanceHtml(false);
  assert.doesNotMatch(html, /checked/); assert.match(html, /Draft — pending final legal review/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 2);
  assert.match(acceptanceHtml(true), /checked/);
  assert.deepEqual(signupPayload(data), {...data, onboarding: true, acceptance: {termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION}});
});

test('public legal pages render the complete operative drafts safely without counsel notes', async () => {
  const {legalPageHtml, legalMarkdown, acceptanceRecordHtml} = await import('../src/legal.js');
  const {TERMS_DOCUMENT, PRIVACY_DOCUMENT} = await import('@freedms/shared');
  for (const [kind, doc] of [['terms', TERMS_DOCUMENT], ['privacy', PRIVACY_DOCUMENT]] as const) {
    const html = legalPageHtml(kind);
    assert.match(html, /Draft — pending final legal review/); assert.match(html, /v1-draft/);
    assert.doesNotMatch(html, /Counsel notes|Review authorities|Pre-incorporation residual risk/);
    assert.ok(html.includes(legalMarkdown(doc.text))); assert.match(html, /<h1>freeDMS/); assert.match(html, /<h2>/);
  }
  assert.equal(legalMarkdown('# <script>\n\n- <img onerror=x>\n- **bold**'), '<h1>&lt;script&gt;</h1>\n<ul><li>&lt;img onerror=x&gt;</li><li><strong>bold</strong></li></ul>');
  assert.match(acceptanceRecordHtml(null), /No acceptance recorded/);
});
