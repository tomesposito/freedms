import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSettledBounded, reportsRoute, REPORT_REQUEST_CONCURRENCY } from '../src/reports.js';
import type { UI } from '../src/desking.js';

// Regression coverage for #184: the Reports page fired all ten section
// requests at once, bursting past the hosted API Lambda's reserved
// concurrency of 2. Loads are now scheduled under REPORT_REQUEST_CONCURRENCY.

const projection = {projection: null, basis: {from: '2026-10-01', to: '2026-10-29', sampleSize: 0}, method: 'Local history'};
const data: Record<string, unknown> = {
  '/reports/inventory': {buckets: [], rows: [], totals: {count: 0, totalCost: 0, totalListPrice: 0}},
  '/reports/sales': {rows: [], totals: {dealsSold: 0, totalFrontGross: 0, totalFiGross: 0, averageGross: 0}},
  '/reports/leads': {total: 0, byStage: [], bySource: []},
  '/reports/turn': {periodDays: 0, soldInPeriod: 0, averageDaysToSale: 0, turnRate: 0},
  '/reports/fi': {dealsSold: 0, dealsWithFi: 0, penetrationBps: 0, fiGrossPerDeal: 0, totalFiRetail: 0, totalFiCost: 0, totalFiGross: 0, perProduct: []},
  '/reports/fixed-ops': {roCount: 0, counterSaleCount: 0, laborCents: 0, partsCents: 0, roTotalCents: 0, counterTotalCents: 0, partsCostCents: 0, laborGrossCents: 0, partsGrossCents: 0},
  '/reports/technicians': {rows: []}, '/reports/departments': {departments: [], locations: []},
  '/reports/forecasts': {inventory: projection, service: projection, parts: projection}
};

interface State { html: string; downloads: [string, string][]; exportClicks: Map<string, () => Promise<void>> }

async function withRoute(api: UI['api'], current: () => boolean, run: (ui: UI & {download: (path: string, filename: string) => Promise<void>}, state: State) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const state: State = {html: '', downloads: [], exportClicks: new Map()};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    querySelector: () => ({addEventListener: () => {}}),
    querySelectorAll: (selector: string) => selector === '[data-export]'
      ? ['inventory', 'sales', 'turn', 'fi', 'leads', 'accounting'].map(name => ({dataset: {export: name}, disabled: false, addEventListener: (_event: string, callback: () => Promise<void>) => { state.exportClicks.set(name, callback); }}))
      : []
  }});
  const ui = {admin: true, current, shell: (html: string) => { state.html = html; }, refresh: () => {}, flash: () => {}, api,
    download: async (path: string, filename: string) => { state.downloads.push([path, filename]); }};
  try { await run(ui, state); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('bounded runner never exceeds the limit, preserves order, and isolates rejections', async () => {
  let inFlight = 0, peak = 0; const started: number[] = [];
  const tasks = Array.from({length: 7}, (_, i) => async () => {
    started.push(i); inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, (7 - i) * 2));
    inFlight--;
    if (i === 3) throw Error('boom');
    return i * 10;
  });
  const results = await allSettledBounded(tasks, 2);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(results.map(r => r.status === 'fulfilled' ? r.value : -1), [0, 10, 20, -1, 40, 50, 60]);
});

test('bounded runner stops firing queued work once shouldContinue is false', async () => {
  let checks = 0, ran = 0;
  const tasks = Array.from({length: 5}, () => async () => { ran++; });
  const results = await allSettledBounded(tasks, 1, () => ++checks <= 2);
  assert.equal(ran, 2);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected', 'rejected']);
});

test('reports load peaks at the concurrency bound, keeps successful sections, isolates the failed one, and exports still work', async () => {
  let inFlight = 0, peak = 0;
  await withRoute(async <T>(path: string) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 10));
    inFlight--;
    if (path === '/reports/saved') throw Error('<unavailable>');
    assert.ok(path in data, path);
    return data[path] as T;
  }, () => true, async (ui, state) => {
    await reportsRoute(ui);
    assert.equal(peak, REPORT_REQUEST_CONCURRENCY);
    for (const title of ['Inventory', 'Sales', 'Lead pipeline', 'Technician metrics', 'Departmental report', 'Fixed operations']) assert.ok(state.html.includes(`<h2>${title}</h2>`), title);
    assert.match(state.html, /Custom reports could not be loaded/);
    assert.doesNotMatch(state.html, /This page could not be loaded/);
    await state.exportClicks.get('inventory')!();
    assert.deepEqual(state.downloads, [['/reports/inventory.csv', 'inventory.csv']]);
  });
});

test('a superseded reports route stops firing queued requests and renders nothing stale', async () => {
  let currentChecks = 0, apiCalls = 0;
  await withRoute(async <T>(path: string) => { apiCalls++; if (path === '/reports/saved') throw Error('<unavailable>'); return data[path] as T; },
    () => ++currentChecks <= 2,
    async (ui, state) => {
      await reportsRoute(ui);
      assert.equal(apiCalls, 2);
      assert.match(state.html, /Loading reports/);
      assert.doesNotMatch(state.html, /<h2>Inventory<\/h2>/);
    });
});
