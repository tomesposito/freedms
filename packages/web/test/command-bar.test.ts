import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandBarHtml, paletteHtml, shortcutAllowed } from '../src/command-bar.js';
const empty = {vehicles: [], people: [], deals: []};
test('command bar owns the sole sidebar toggle and unbranded search/assistant slots', () => {
  const html = commandBarHtml('<button id="sidebar-toggle"></button>');
  assert.equal((html.match(/id="sidebar-toggle"/g) ?? []).length, 1);
  assert.match(html, /command-assistant/); assert.match(html, /aria-controls="command-palette"/); assert.doesNotMatch(html, /brand|logo/);
});
test('palette explicitly separates records, priced skills and last ask action, escaping data', () => {
  const html = paletteHtml('<text>', {...empty, vehicles: [{id: 'v', title: '<Ford>', meta: '<Stock>', href: '#/vehicles/v'}]}, [{id: 'vehicle_summary', name: 'Vehicle summary', costCredits: 3, kind: 'summary'}]);
  assert.match(html, /data-href="#\/vehicles\/v"/); assert.match(html, /3 credits/);
  assert.ok(html.indexOf('data-href') < html.indexOf('data-skill'));
  assert.ok(html.indexOf('data-skill') < html.indexOf('data-ask'));
  assert.match(html, /&lt;Ford&gt;/); assert.doesNotMatch(html, /<text>|<Stock>/);
  assert.match(paletteHtml('none', empty, []), /No records match.*data-ask/s);
  assert.doesNotMatch(paletteHtml('', empty, []), /data-ask|No records match/);
});
test('shortcut protects form fields and editable ancestors, except the palette input', () => {
  for (const id of ['', 'command-input']) for (const editing of [true, false]) {
    const target = {id, closest: (selector: string) => { assert.match(selector, /input, textarea, select, \[contenteditable\]/); return editing ? {} : null; }} as unknown as Element;
    assert.equal(shortcutAllowed(target), id === 'command-input' || !editing);
  }
});

test('standalone customer query keeps the contact skill context', async () => {
  const {assistantContextFromHash} = await import('../src/assistant.js');
  assert.deepEqual(assistantContextFromHash('#/leads?customerId=customer-1'), {surface: 'contact', id: 'customer-1'});
});
