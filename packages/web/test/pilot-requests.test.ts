import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessRequest } from '@freedms/shared';
import type { UI } from '../src/desking.js';
import { pilotRequestsHtml, pilotRequestsRoute } from '../src/pilot-requests.js';
import { sidebarNavigation } from '../src/sidebar.js';

const record: AccessRequest = {id: 'request', tenantId: 'operator', email: 'dealer@example.test', contactName: '<Dealer>', dealershipName: 'A & B Motors', phone: '555-0100', inventorySize: '26-50', currentDms: 'Manual', message: '<script>alert(1)</script>', status: 'pending', handledAt: null, version: 2, createdAt: '2026-10-31T22:00:00Z', updatedAt: '2026-10-31T22:01:00Z'};
test('pilot inbox escapes submitted details and distinguishes pending and handled states', () => {
  const html = pilotRequestsHtml([record], 'pending');
  assert.match(html, /&lt;Dealer&gt;/); assert.match(html, /A &amp; B Motors/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  for (const value of ['555-0100', '26-50', 'Manual', 'Mark handled', 'dealer@example.test']) assert.ok(html.includes(value));
  assert.match(pilotRequestsHtml([], 'pending'), /No pending requests/);
  const handled = pilotRequestsHtml([{...record, status: 'handled', handledAt: record.updatedAt}], 'handled');
  assert.match(handled, /Handled:/); assert.doesNotMatch(handled, /data-handle-request/);
});
test('pilot navigation and route require explicit operator capability as well as admin', async () => {
  assert.match(sidebarNavigation(true, true), /#\/pilot-requests/);
  for (const [admin, allowed] of [[true, false], [false, true], [false, false]]) {
    assert.doesNotMatch(sidebarNavigation(admin, allowed), /#\/pilot-requests/);
    let html = '';
    await pilotRequestsRoute({admin, api: async () => { throw Error('Must not fetch'); }, shell: value => { html = value; }, flash: () => {}, current: () => true, refresh: () => {}}, allowed);
    assert.match(html, /Only the pilot operator/);
  }
});
test('pilot inbox sends displayed version, refreshes after success, and retains failed requests for retry', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let click: () => Promise<void> = async () => {}; let refreshed = 0; let error: unknown; let fail = false;
  const button = {disabled: false, dataset: {handleRequest: 'request'}, addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; }};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {querySelector: () => null, querySelectorAll: () => [button]}});
  const calls: unknown[] = [];
  const ui: UI = {admin: true, current: () => true, shell: () => {}, refresh: () => { refreshed++; }, flash: value => { error = value; }, api: async <T>(path: string, method?: string, body?: unknown) => {
    calls.push({path, method, body});
    if (method === 'POST' && fail) throw Error('Reload before saving.');
    return [record] as T;
  }};
  try {
    await pilotRequestsRoute(ui, true);
    await click(); assert.equal(refreshed, 1); assert.equal(button.disabled, false);
    assert.deepEqual(calls[1], {path: '/admin/access-requests/handled', method: 'POST', body: {email: record.email, version: 2}});
    fail = true; await click(); assert.equal(refreshed, 1); assert.equal(button.disabled, false); assert.ok(error instanceof Error);
    let rendered = false; ui.current = () => false; ui.shell = html => { if (!html.includes('Loading')) rendered = true; };
    await pilotRequestsRoute(ui, true, 'handled'); assert.equal(rendered, false);
    assert.deepEqual(calls.at(-1), {path: '/admin/access-requests?status=handled', method: undefined, body: undefined});
  } finally { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); }
});
