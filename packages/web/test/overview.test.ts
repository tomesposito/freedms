import {test} from 'node:test';
import assert from 'node:assert/strict';
import {overviewHtml, overviewDefinition, overviewRoute} from '../src/overview.js';
import type {OverviewReport} from '@freedms/shared';
const empty: OverviewReport = {
  inventory: {status: 'fulfilled', value: {totals: {count: 0, totalCost: 0, totalListPrice: 0}, buckets: ['0-30','31-60','61-90','91+'].map(bucket => ({bucket: bucket as '0-30', count: 0, totalCost: 0}))}},
  sales: {status: 'fulfilled', value: {from: '2026-10-13', to: '2026-11-11', totals: {dealsSold: 0, totalFrontGross: 0, totalFiGross: 0, averageGross: 0}, trend: []}},
  leads: {status: 'fulfilled', value: {total: 0, byStage: []}},
};
test('overview empty and loading layouts keep six basis-labelled tiles and three chart panels', () => {
  const html = overviewHtml(empty), loading = overviewHtml();
  assert.equal((html.match(/overview-tile"/g) ?? []).length, 6);
  assert.equal((html.match(/overview-panel/g) ?? []).length, 3);
  for (const text of ['No vehicles in inventory yet.', 'No deals sold in this range.', 'No leads yet.', 'href="#/new"', 'href="#/import"', '$0.00']) assert.ok(html.includes(text));
  assert.equal((loading.match(/overview-skeleton"/g) ?? []).length, 9);
  assert.match(loading, /Loading reports…/);
  assert.equal((html.match(/<small>current<\/small>/g) ?? []).length, 4);
  assert.equal((html.match(/<small>trailing 30 days<\/small>/g) ?? []).length, 2);
});
test('overview partial failure leaves successful source numbers and never presents unavailable values as zero', () => {
  const html = overviewHtml({...empty, inventory: {status: 'rejected', reason: '<secret>'}});
  assert.equal((html.match(/aria-label="Unavailable"/g) ?? []).length, 3);
  assert.match(html, /Inventory aging could not be loaded/); assert.match(html, /data-overview-retry/);
  assert.match(html, /No deals sold in this range/); assert.doesNotMatch(html, /secret/);
});
test('overview renderer follows definition positions and formats warning and cents from aggregates', () => {
  const data = structuredClone(empty);
  if(data.inventory.status === 'fulfilled') {data.inventory.value.buckets[3].count = 2; data.inventory.value.totals.totalCost = 123456;}
  const html = overviewHtml(data); assert.match(html, /overview-warning/); assert.match(html, /\$1,234.56/);
  const tile = {metric: 'totals.totalListPrice', source: 'inventory' as const, label: 'Configured metric', format: 'money' as const, window: 'current' as const, position: -1};
  overviewDefinition.tiles.push(tile);
  try {const changed = overviewHtml(data); assert.ok(changed.indexOf('Configured metric') < changed.indexOf('Vehicles on lot'));}
  finally {overviewDefinition.tiles.pop();}
});
test('overview uses one 30-day UTC request and all-failed sources bind full-page Retry', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let retry = () => {}, refreshed = 0, html = '', calls = 0;
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {querySelector: () => ({addEventListener: (_event: string, callback: () => void) => {retry = callback;}})}});
  try {
    await overviewRoute({admin: true, current: () => true, flash: () => {}, refresh: () => {refreshed++;}, shell: value => {html = value;}, api: async <T>(path: string) => {
      calls++; const url = new URL(path, 'http://offline'); assert.equal(url.pathname, '/reports/overview');
      assert.equal((Date.parse(url.searchParams.get('to')!) - Date.parse(url.searchParams.get('from')!)) / 86400000, 29);
      return Object.fromEntries(['inventory','sales','leads'].map(source => [source, {status: 'rejected', reason: 'offline'}])) as T;
    }});
    assert.equal(calls, 1); assert.match(html, /No reports could be loaded/); assert.doesNotMatch(html, /overview-skeleton/);
    retry(); assert.equal(refreshed, 1);
  } finally {if(original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');}
});
