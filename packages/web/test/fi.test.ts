import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FiProduct, FiSelection } from '@freedms/shared';
import { catalogRows, menuHtml } from '../src/fi.js';
const p: FiProduct = {id: 'p', kind: 'fi-product', tenantId: 'A', version: 1, createdAt: '', updatedAt: '', name: '<img src=x>', category: 'service-contract', cost: 90000, retailPrice: 150000, termNotes: '<script>coverage</script>', active: true};
const s: FiSelection = {productId: p.id, name: p.name, category: p.category, cost: p.cost, retailPrice: p.retailPrice, termNotes: p.termNotes, status: 'accepted'};
test('F&I HTML escapes catalog/menu text and displays real empty, undecided, accepted, declined and inactive states', () => {
  for (const html of [catalogRows([p]), menuHtml([p], []), menuHtml([p], [s])]) { assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); }
  assert.match(menuHtml([], []), /No active F&I products/);
  assert.match(menuHtml([p], []), /undecided/);
  assert.match(menuHtml([p], [s]), /accepted.*F&I gross \$600\.00/);
  assert.match(menuHtml([{...p, active: false}], [{...s, status: 'declined'}]), /declined · Inactive/);
  assert.doesNotMatch(menuHtml([p], [{...s, status: 'declined'}]), /F&I gross/);
  assert.match(catalogRows([{...p, active: false}]), /Inactive/);
});
