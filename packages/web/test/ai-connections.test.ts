import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpGrantView } from '@freedms/shared';
import { aiConnectionsHtml } from '../src/ai-connections.js';
const endpoint = 'https://app.example.test/api/mcp';
const grant: McpGrantView = {id: 'grant', userId: 'user', appName: 'My assistant', scopes: ['freedms/mcp.read'], firstGrantedAt: '2026-11-01T12:00:00Z', lastUsedAt: '2026-11-01T13:00:00Z', revokedAt: null, version: 1};
test('AI connections empty state explains setup without a table or client identifiers', () => {
  const html = aiConnectionsHtml([], endpoint);
  for (const text of ['No AI connections yet', endpoint, 'normal freeDMS login', 'approve what the app can do', 'revoke its access']) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /<table|client_id|clientId|client ID/);
});
test('AI connections show plain scopes, dates, revoke controls, revoked status and escaped owner names', () => {
  const html = aiConnectionsHtml([grant, {...grant, id: 'write', scopes: ['freedms/mcp.write']}], endpoint, [{...grant, ownerName: '<Owner>', ownerEmail: 'owner@example.test'}]);
  for (const text of ['can read', 'can read and change', 'Connected', 'Last used', 'Revoke', 'Everyone at this dealership', '&lt;Owner&gt;', 'owner@example.test', new Date(grant.firstGrantedAt).toLocaleString(), new Date(grant.lastUsedAt).toLocaleString()]) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /client_id|clientId|freedms\/mcp.write/);
  const revoked = aiConnectionsHtml([{...grant, revokedAt: grant.lastUsedAt}], endpoint);
  assert.match(revoked, /Revoked/); assert.doesNotMatch(revoked, /<button|data-revoke/);
});
