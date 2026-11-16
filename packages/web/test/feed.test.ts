import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedRunHtml } from '../src/feed.js';
test('feed run UI escapes vehicle text, shows every exclusion and only generated downloads', () => {
  const html = feedRunHtml({id: 'run', tenantId: 'A', actorId: 'user', createdAt: '2026-10-22', formats: ['json'], includedCount: 0, excludedCount: 1, included: [], rows: [], excluded: [{vehicleId: 'vehicle', stockNumber: '<script>alert(1)</script>', reason: 'missing_price', message: 'Missing price.'}]});
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Missing price.')); assert.ok(html.includes('0 included · 1 excluded'));
  assert.ok(html.includes('run.json')); assert.ok(!html.includes('run.csv'));
});

import { facebookFeedHtml } from '../src/feed.js';
test('Facebook status escapes text and explains setup and honest limits', () => {
  const empty = facebookFeedHtml({enabled: false, feedUrl: '/public/<dealer>/facebook.csv', lastGeneratedAt: null, vehicleCount: null}, '<dealer>');
  assert.ok(empty.includes('&lt;dealer&gt;')); assert.ok(!empty.includes('<dealer>'));
  assert.ok(empty.includes('Not generated yet — enable it and click Generate feed.'));
  assert.ok(empty.includes('Meta controls catalog approval, eligibility, and ranking'));
  assert.ok(empty.includes('placement is never promised'));
  const generated = facebookFeedHtml({enabled: true, feedUrl: '"<url>', lastGeneratedAt: '<date>', vehicleCount: 2}, 'A');
  assert.ok(generated.includes('&quot;&lt;url&gt;')); assert.ok(generated.includes('&lt;date&gt; · 2 vehicles')); assert.ok(generated.includes('Enabled'));
});
