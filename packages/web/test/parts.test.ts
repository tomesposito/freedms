import { sidebarNavigation } from '../src/sidebar.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Part, PartsSale, RepairOrderLineItem } from '@freedms/shared';
import { partsTableHtml, salesHtml } from '../src/parts.js';
import { rowHtml } from '../src/service.js';
import { currency } from '../src/format.js';
const p={id:'p',partNumber:'<part>',description:'<script>',binLocation:'<bin>',costCents:450,retailPriceCents:899,quantityOnHand:5,reorderPoint:5} as Part;
test('Parts catalog escapes user text, formats cents and flags exact reorder threshold with honest empty state',()=>{
  assert.match(partsTableHtml([]),/No parts stocked yet/);const html=partsTableHtml([p]); assert.match(html,/&lt;part&gt;/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;bin&gt;/);assert.doesNotMatch(html,/<script>/); assert.ok(html.includes(currency(899)));assert.ok(html.includes(currency(450)));assert.match(html,/<strong>Reorder<\/strong>/);assert.doesNotMatch(partsTableHtml([{...p,quantityOnHand:6}]),/<strong>Reorder/);
});
test('Counter sale display escapes snapshots and warnings and shows totals and walk-in customers',()=>{
  assert.match(salesHtml([]),/No counter sales yet/); const html=salesHtml([{createdAt:'2026-10-24',partNumber:'<part>',description:'<description>',customerName:null,quantity:2,unitPriceCents:899,totalCents:1798,stockWarning:'<warning>'} as PartsSale]); assert.match(html,/Walk-in/);assert.match(html,/&lt;warning&gt;/);assert.doesNotMatch(html,/<part>|<description>|<warning>/);assert.ok(html.includes(currency(1798)));
});
test('RO stocked selector shows selected part, on-hand hint, and preserves free-text option',()=>{
  const item={id:'line',kind:'parts',description:'Filter',partId:'p',quantity:2,unitPriceCents:899,laborHoursHundredths:null,laborRateCents:null} as RepairOrderLineItem;
  const html=rowHtml(item,[p]);assert.match(html,/Free-text part/);assert.match(html,/value="p" selected/);assert.match(html,/5 on hand/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(rowHtml({...item,kind:'labor',laborHoursHundredths:100,laborRateCents:100}),/name="partId"/);
  const service=readFileSync(new URL('../src/service.ts',import.meta.url),'utf8'),parts=readFileSync(new URL('../src/parts.ts',import.meta.url),'utf8'),main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  assert.ok(sidebarNavigation(true).includes('href="#/parts" title="Parts"'));assert.match(main,/partsRoute\(parts/);assert.match(service,/type="checkbox" name="allowNegativeStock"/);assert.match(parts,/type="checkbox" name="allowNegativeStock"/);assert.doesNotMatch(service,/arrives with the parts module/);assert.match(service,/Stock applied:/);assert.match(service,/e\(ro.stockWarning\)/);
});
