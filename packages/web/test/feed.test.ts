import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedRunHtml } from '../src/feed.js';
test('feed run UI escapes vehicle text, shows every exclusion and only generated downloads', () => {
  const html = feedRunHtml({id: 'run', tenantId: 'A', actorId: 'user', createdAt: '2026-10-22', formats: ['json'], includedCount: 0, excludedCount: 1, included: [], rows: [], excluded: [{vehicleId: 'vehicle', stockNumber: '<script>alert(1)</script>', reason: 'missing_price', message: 'Missing price.'}]});
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Missing price.')); assert.ok(html.includes('0 included · 1 excluded'));
  assert.ok(html.includes('run.json')); assert.ok(!html.includes('run.csv'));
});
