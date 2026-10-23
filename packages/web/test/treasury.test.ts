import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agingHtml, registerHtml, statementPreviewHtml } from '../src/treasury.js';
test('Treasury empty states and user content are rendered honestly and escaped', () => {
  assert.match(agingHtml({asOf: '2026-10-23', rows: [], buckets: [], total: 0, glBalance: 0}), /No open items/);
  assert.match(registerHtml([]), /No cash entries/);
  const html = registerHtml([{id: 'id', entryId: 'e', date: '2026-10-23', memo: '<img src=x>', amount: -123, balance: -123}]);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); assert.match(html, /1\.23/);
  const preview = statementPreviewHtml({rows: [{rowNumber: 1, status: 'error', error: '<script>bad</script>'}], validCount: 0, errorCount: 1, duplicateCount: 0});
  assert.match(preview, /1 errors/); assert.doesNotMatch(preview, /<script>/);
});
