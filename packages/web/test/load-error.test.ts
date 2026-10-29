import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadErrorHtml } from '../src/load-error.js';
import { usersRoute } from '../src/users.js';
import { documentsRoute } from '../src/documents.js';
import { accountingRoute } from '../src/accounting.js';
import { partsRoute } from '../src/parts.js';
import { serviceRoute } from '../src/service.js';
import { reportsRoute, reportSection } from '../src/reports.js';
import { appointmentStatuses } from '@freedms/shared';
import type { UI } from '../src/desking.js';

async function withUI(run: (ui: UI, state: {html: string; calls: number; refreshed: number; events: Map<string, () => void>}) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const state = {html: '', calls: 0, refreshed: 0, events: new Map<string, () => void>()};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    querySelector: (selector: string) => ({addEventListener: (event: string, callback: () => void) => { state.events.set(`${selector}:${event}`, callback); }}),
    querySelectorAll: () => []
  }});
  const ui: UI = {admin: true, current: () => true, shell: html => {state.html = html;}, refresh: () => {state.refreshed++;}, flash: () => {}, api: async () => {state.calls++; throw Error('<unavailable>');}};
  try { await run(ui, state); } finally {
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
}
test('load error cards escape messages and headings', () => {
  const html = loadErrorHtml(Error('<script>'), '<title>');
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;title&gt;/); assert.doesNotMatch(html, /<script>|<title>/);
});
for (const [name, route] of [
  ['users', (ui: UI) => usersRoute(ui, 'A')], ['documents', documentsRoute],
  ['accounting', (ui: UI) => accountingRoute([], ui)], ['parts', (ui: UI) => partsRoute([], ui)],
  ['service detail', (ui: UI) => serviceRoute(['service', 'repair-orders', 'ro'], {...ui, apiEnvelope: ui.api})]
] as const) test(`${name} failure replaces loading with a working retry`, async () => withUI(async (ui, state) => {
  await route(ui);
  assert.match(state.html, /This page could not be loaded/); assert.match(state.html, /id="retry-load"/);
  assert.doesNotMatch(state.html, /Loading/);
  const before = state.calls; state.events.get('#retry-load:click')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.calls > before || state.refreshed === 1);
}));
for (const failed of ['/documents/retention', '/documents/past-retention']) test(`documents keep results when ${failed} fails`, async () => withUI(async (ui, state) => {
  ui.api = async <T>(path: string) => {
    if (path === failed) throw Error('Unavailable');
    return (path === '/documents/retention' ? {version: 0, retentionDays: null} : []) as T;
  };
  await documentsRoute(ui);
  assert.match(state.html, /No documents match your search/); assert.match(state.html, /Document retention could not be loaded/);
  assert.doesNotMatch(state.html, /Save retention period|This page could not be loaded/);
}));
test('service board survives unavailable users', async () => withUI(async (ui, state) => {
  await serviceRoute(['service'], {...ui, apiEnvelope: async <T>() => ({data: {date: '2026-10-29', appointments: [], repairOrders: [], byStatus: Object.fromEntries(appointmentStatuses.map(status => [status, []]))} as T})});
  assert.match(state.html, /Users could not be loaded/); assert.doesNotMatch(state.html, /This page could not be loaded/);
}));
test('settled report sections retain success HTML and isolate escaped failure cards', async () => {
  const results = await Promise.allSettled([Promise.resolve('Inventory'), Promise.reject(Error('<offline>')), Promise.resolve('Sales')]);
  const html = results.map((result, i) => reportSection(result, ['Inventory', 'Lead pipeline', 'Sales'][i], value => `<section>${value}</section>`)).join('');
  assert.equal(html, '<section>Inventory</section>' + loadErrorHtml(Error('<offline>'), 'Lead pipeline could not be loaded.', false) + '<section>Sales</section>');
  assert.match(html, /&lt;offline&gt;/); assert.doesNotMatch(html, /retry-load/);
});
test('all failed reports retain bound date controls and full-page Retry', async () => withUI(async (ui, state) => {
  await reportsRoute({...ui, download: async () => {}});
  assert.match(state.html, /report-range/); assert.match(state.html, /This page could not be loaded/); assert.doesNotMatch(state.html, /Loading/);
  assert.ok(state.events.has('#report-range:submit'));
  state.events.get('#retry-load:click')!(); state.events.get('#clear-range:click')!(); assert.equal(state.refreshed, 2);
}));
test('reports route renders nine successful loads when saved reports fail', async () => withUI(async (ui, state) => {
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
  ui.api = async <T>(path: string) => { if (path === '/reports/saved') throw Error('<unavailable>'); assert.ok(path in data); return data[path] as T; };
  await reportsRoute({...ui, download: async () => {}});
  for (const title of ['Inventory', 'Sales', 'Lead pipeline', 'Technician metrics', 'Departmental report', 'Fixed operations', 'Parts reorder forecast']) assert.ok(state.html.includes(`<h2>${title}</h2>`));
  assert.match(state.html, /Custom reports could not be loaded/); assert.match(state.html, /&lt;unavailable&gt;/);
  assert.doesNotMatch(state.html, /This page could not be loaded|custom-builder/);
  assert.ok(state.events.has('#report-range:submit')); assert.ok(state.events.has('#clear-range:click'));
}));
