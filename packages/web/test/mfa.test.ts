import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mfaStatusHtml, adminMfaHtml } from '../src/mfa.js';
test('MFA status helpers show state/count, escape text and never render secrets or hashes', () => {
  const status = {userId: '<img>', enabled: true, recoveryCodesRemaining: 7, lockedUntil: '<script>alert("x")</script>', secret: 'HIDDEN_SECRET', pendingSecret: 'HIDDEN_PENDING', recoveryHashes: ['HIDDEN_HASH']};
  const html = mfaStatusHtml(status);
  assert.match(html, /Enabled/); assert.match(html, /7 recovery codes/); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  assert.match(mfaStatusHtml({...status, enabled: false, recoveryCodesRemaining: 0}), /Disabled/);
  for (const value of ['HIDDEN_SECRET', 'HIDDEN_PENDING', 'HIDDEN_HASH']) assert.ok(!html.includes(value));
});
test('MFA admin helpers escape names/ids, show Reset only for enabled users and admins, omit secrets', () => {
  const user = {userId: '\"><script>', name: '<img src=x onerror=alert(1)>', enabled: true, secret: 'HIDDEN_SECRET', pendingSecret: 'HIDDEN_PENDING', recoveryHashes: ['HIDDEN_HASH']};
  const html = adminMfaHtml([user], true);
  assert.match(html, /Reset MFA/); assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/);
  assert.ok(!adminMfaHtml([user], false).includes('Reset'));
  assert.ok(!adminMfaHtml([{...user, enabled: false}], true).includes('Reset'));
  for (const value of ['HIDDEN_SECRET', 'HIDDEN_PENDING', 'HIDDEN_HASH']) assert.ok(!html.includes(value));
});
