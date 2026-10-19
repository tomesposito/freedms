import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, escapeHtml } from '../src/format.js';
test('money entry preserves cents without floating point rounding', () => {
  assert.equal(cents('19.99'), 1999); assert.equal(cents('0.29'), 29); assert.equal(cents('12.5'), 1250);
  for (const input of ['-1', '1.001', '1e4', '', 'NaN']) assert.throws(() => cents(input));
});
test('dealer-entered HTML is rendered as text', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)"> &'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;');
});
