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

import { destinationFeedHtml, agreementGatedHtml } from '../src/feed.js';
test('destination status escapes text and explains setup and honest limits (#205)', () => {
  const google = destinationFeedHtml({id: 'google', name: 'Google Vehicle Ads', enabled: true, feedUrl: '/public/<dealer>/google.csv', lastGeneratedAt: '<date>', vehicleCount: 2}, '<dealer>');
  assert.ok(google.includes('&lt;dealer&gt;')); assert.ok(!google.includes('<dealer>'));
  assert.ok(google.includes('Google Merchant Center')); assert.ok(google.includes('scheduled fetch'));
  assert.ok(google.includes('does not record color')); assert.ok(google.includes('placement is never promised'));
  assert.ok(google.includes('&lt;date&gt; · 2 vehicles')); assert.ok(google.includes('Enabled'));
  const syndication = destinationFeedHtml({id: 'syndication', name: 'Syndication CSV', enabled: false, feedUrl: '/public/A/syndication.csv', lastGeneratedAt: null, vehicleCount: null}, 'A');
  assert.ok(syndication.includes('Not generated yet — enable it and click Generate feed.'));
  assert.ok(syndication.includes('Carsforsale.com')); assert.ok(syndication.includes('Disabled'));
  const gated = agreementGatedHtml([{name: 'Cars.com', note: 'Approved providers only.'}, {name: '<b>AutoTrader</b>', note: 'Note <x>'}]);
  assert.ok(gated.includes('Cars.com')); assert.ok(gated.includes('Agreement-gated destinations'));
  assert.ok(gated.includes('&lt;b&gt;AutoTrader&lt;/b&gt;')); assert.ok(!gated.includes('<b>AutoTrader</b>'));
});
