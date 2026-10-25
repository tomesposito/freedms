import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usersHtml, usersRoute } from '../src/users.js';
test('Users UI gates staff without fetching and renders an honest empty state', async () => {
  let html = '';
  await usersRoute({admin: false, api: async () => { throw Error('Must not fetch'); }, shell: value => { html = value; }, flash: () => {}, current: () => true, refresh: () => {}}, 'A');
  assert.match(html, /Only administrators/); assert.doesNotMatch(html, /add-user|data-action/);
  assert.match(usersHtml([], true), /No workspace users/); assert.match(usersHtml([], true), /no email is sent/);
});
test('Users UI escapes PII, displays role, status and MFA, and offers all membership actions', () => {
  const html = usersHtml([{userId: 'u', name: '<script>', email: 'a&b@example.test', role: 'admin', active: true, version: 0, mfaEnabled: true}, {userId: 'v', name: 'Staff', email: null, role: 'staff', active: false, version: 2, mfaEnabled: false}], true);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /a&amp;b/); assert.doesNotMatch(html, /<script>/);
  for (const label of ['Enabled', 'Disabled', 'Active', 'Inactive', 'Make staff', 'Make admin', 'Deactivate', 'Reactivate', 'No email recorded']) assert.ok(html.includes(label));
});
