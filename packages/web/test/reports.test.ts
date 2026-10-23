import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customTable, definitionQuery } from '../src/custom-reports.js';
test('custom report query retains choices and table renders API cells exactly with HTML escaping', () => {
  const q = new URLSearchParams(definitionQuery({dataset: 'fi', columns: ['product', 'gross'], groupBy: 'product', from: '2026-10-01'}));
  assert.equal(q.get('columns'), 'product,gross'); assert.equal(q.get('groupBy'), 'product'); assert.equal(q.get('from'), '2026-10-01'); assert.equal(q.has('to'), false);
  const html = customTable({dataset: 'fi', columns: [{key: 'product', label: 'Product'}, {key: 'gross', label: 'Gross'}], rows: [['<Plan> & "Plus"', '1234.56']]});
  assert.match(html, /<td>1234.56<\/td>/); assert.doesNotMatch(html, /\$|<Plan>/); assert.match(html, /&lt;Plan&gt;/);
  assert.match(customTable({dataset: 'fi', columns: [], rows: []}), /No records match/);
});
