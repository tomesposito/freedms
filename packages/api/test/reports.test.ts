import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadSources, leadStages, pencilMath, type DealView, type InventoryReport, type LeadReport, type SalesReport } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { inventoryCsv, leadCsv, salesCsv, soldDate, toCsv } from '../src/reports.js';

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && c === '\r' && csv[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  assert.equal(quoted, false); assert.equal(cell, ''); assert.deepEqual(row, []); return rows;
}
const paths = ['inventory', 'sales', 'leads', 'inventory.csv', 'sales.csv', 'leads.csv', 'accounting.csv'];
async function setup() {
  let clock = new Date('2026-10-20T12:00:00Z');
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('reports-test-secret-at-least-32-characters', () => clock.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: clock.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'admin', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: clock.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => clock);
  const request = (path: string, query?: ApiRequest['query'], tenant = 'A', method = 'GET', body?: unknown) => handler({path, query, method, body: body === undefined ? undefined : JSON.stringify(body), claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const json = async <T = any>(path: string, method = 'GET', body?: unknown, query?: ApiRequest['query'], tenant = 'A'): Promise<T> => {
    const r = await request(path, query, tenant, method, body); assert.ok(r.statusCode < 300, r.body); return JSON.parse(r.body).data;
  };
  const {customer} = await json('/customers', 'POST', {name: 'Buyer, "Pat"', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}});
  const vehicle = async (stockNumber: string, days = 0, cost = 700000, recon = 50000) => json('/vehicles', 'POST', {stockNumber, vin: '1HGCM82633A004352', year: 2019, make: 'Honda, "Special"', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1000000, cost, reconCosts: [{description: 'Repair', amount: recon}], dateStocked: new Date(clock.getTime() - days * 86400000).toISOString().slice(0, 10), location: '', notes: ''});
  const sell = async (date: string, index: number) => {
    clock = new Date(`${date}T23:59:59Z`);
    const v = await vehicle(`S${index}`);
    let d: DealView = await json('/deals', 'POST', {vehicleId: v.id, customerId: customer.id, type: 'finance'});
    d = await json(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'approved', docFee: 12345,
      pencils: [...d.pencils, {...d.pencils[0], id: `chosen${index}`, price: 800001 + index, name: 'Working'}], workingPencilId: `chosen${index}`,
      trade: {year: '2010', make: 'Trade', model: 'Car', vin: '', allowance: 200000, actualCashValue: 100000, payoff: 230000}});
    return json<DealView>(`/deals/${d.id}`, 'PUT', {version: d.version, status: 'sold'});
  };
  const reset = () => { clock = new Date('2026-10-20T12:00:00Z'); };
  return {request, json, vehicle, sell, reset, repositories, handler, customer};
}

test('inventory report reconciles every aging boundary, costs, ordering and CSV from JSON', async () => {
  const s = await setup();
  for (const [i, days] of [0, 30, 31, 60, 61, 90, 91].entries()) await s.vehicle(`I${i}`, days, 10000 + i, 500 + i);
  await s.vehicle('A-first', 91, 100, 25);
  await s.sell('2026-10-20', 1); s.reset();
  const data = await s.json<InventoryReport>('/reports/inventory');
  assert.deepEqual(data.totals, {count: 8, totalCost: 73667, totalListPrice: 8000000});
  assert.deepEqual(data.buckets, [{bucket: '0-30', count: 2, totalCost: 21002}, {bucket: '31-60', count: 2, totalCost: 21010}, {bucket: '61-90', count: 2, totalCost: 21018}, {bucket: '91+', count: 2, totalCost: 10637}]);
  assert.deepEqual(data.rows.map(r => r.agingDays), [91, 91, 90, 61, 60, 31, 30, 0]); assert.equal(data.rows[0].stockNumber, 'A-first');
  const csv = await s.request('/reports/inventory.csv'); assert.equal(csv.body, inventoryCsv(data));
  const cells = parseCsv(csv.body); assert.deepEqual(cells[0], ['stockNumber', 'vehicle', 'status', 'dateStocked', 'agingDays', 'bucket', 'listPrice', 'cost', 'reconTotal', 'totalCost']); assert.equal(cells[1][1], '2019 Honda, "Special" Accord EX');
  for (const row of cells.slice(1)) for (const cell of row.slice(6)) assert.match(cell, /^-?\d+\.\d{2}$/);
});

test('sales and accounting reconcile working pencil, trade, snapshot tax, fees and inclusive dates', async () => {
  const s = await setup();
  await s.json('/settings', 'PUT', {version: 0, taxRateBps: 625, taxTradeDifference: true, docFee: 999});
  const deals: DealView[] = [];
  for (const [i, date] of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].entries()) deals.push(await s.sell(date, i));
  s.reset(); await s.json('/settings', 'PUT', {version: 1, taxRateBps: 0, taxTradeDifference: false, docFee: 0});
  for (const [range, indices] of [[{}, [0, 1, 2, 3]], [{from: '2026-10-02', to: '2026-10-03'}, [1, 2]], [{from: '2026-10-03'}, [2, 3]], [{to: '2026-10-02'}, [0, 1]], [{from: '2026-10-03', to: '2026-10-03'}, [2]], [{from: '2026-10-05'}, []]] as [Record<string, string>, number[]][]) {
    const data = await s.json<SalesReport>('/reports/sales', 'GET', undefined, range);
    const selected = indices.map(i => deals[i]), numbers = selected.map(d => pencilMath(d.pencils.find(p => p.id === d.workingPencilId)!, d.trade, d, d.vehicle, d.type));
    const gross = numbers.reduce((sum, n) => sum + n.frontGross, 0);
    assert.deepEqual(data.rows.map(r => r.dealId), selected.map(d => d.id));
    assert.deepEqual(data.totals, {dealsSold: selected.length, totalFrontGross: gross, totalFiGross: 0, averageGross: selected.length ? Math.round(gross / selected.length) : 0});
    const sales = await s.request('/reports/sales.csv', range), accounting = await s.request('/reports/accounting.csv', range);
    assert.equal(sales.body, salesCsv(data)); assert.deepEqual(parseCsv(sales.body)[0], ['soldDate', 'dealId', 'buyer', 'vehicle', 'price', 'frontGross', 'fiGross']); assert.equal(accounting.body, salesCsv(data, true));
    const rows = parseCsv(accounting.body); assert.deepEqual(rows[0], ['date', 'deal', 'buyer', 'vehicle', 'price', 'cost', 'recon', 'tax', 'fees', 'gross', 'fiGross']);
    rows.slice(1).forEach((row, i) => {
      assert.equal(row[0], data.rows[i].soldDate); assert.equal(row[1], selected[i].id); assert.equal(row[2], 'Buyer, "Pat"'); assert.equal(row[3], `2019 Honda, "Special" Accord (${selected[i].vehicle.stockNumber})`);
      assert.deepEqual(row.slice(4), [data.rows[i].price, 700000, 50000, numbers[i].salesTax, 12345, numbers[i].frontGross, 0].map(n => (n / 100).toFixed(2)));
      row.slice(4).forEach(cell => assert.match(cell, /^-?\d+\.\d{2}$/));
    });
  }
});

test('lead pipeline is a zero-filled current snapshot in domain order and shares CSV data', async () => {
  const s = await setup();
  for (const [i, source] of leadSources.entries()) {
    const {lead} = await s.json('/leads', 'POST', {customerId: s.customer.id, source});
    if (i) await s.json(`/leads/${lead.id}`, 'PUT', {version: lead.version, stage: leadStages[i]});
  }
  const data = await s.json<LeadReport>('/reports/leads');
  assert.equal(data.total, 6); assert.deepEqual(data.byStage, leadStages.map((stage, i) => ({stage, count: i < 6 ? 1 : 0}))); assert.deepEqual(data.bySource, leadSources.map(source => ({source, count: 1})));
  const csv = (await s.request('/reports/leads.csv')).body; assert.equal(csv, leadCsv(data)); assert.deepEqual(parseCsv(csv)[0], ['dimension', 'value', 'count']);
});

test('all reports and CSVs enforce tenant isolation, authentication, headers and read-only behavior', async () => {
  const s = await setup(); await s.vehicle('PRIVATE-A'); await s.sell('2026-10-20', 1); s.reset();
  await s.json('/leads', 'POST', {customerId: s.customer.id, source: 'phone'});
  const repo = s.repositories.forTenant('A');
  const snapshot = async () => JSON.stringify([await repo.list({}), await repo.crmList('deal'), await repo.crmList('lead'), await repo.crmList('customer'), s.repositories.eventsForTest('A')]);
  const before = await snapshot();
  for (const path of paths) {
    const a = await s.request(`/reports/${path}`); assert.equal(a.statusCode, 200);
    assert.equal(a.headers['cache-control'], 'no-store'); assert.equal(a.headers['x-content-type-options'], 'nosniff');
    const b = await s.request(`/reports/${path}`, undefined, 'B'); assert.equal(b.statusCode, 200); assert.ok(!b.body.includes('PRIVATE-A')); assert.ok(!b.body.includes('Pat')); assert.ok(!b.body.includes('Special'));
    assert.equal((await s.handler({method: 'GET', path: `/reports/${path}`})).statusCode, 401);
    if (path.endsWith('.csv')) {
      assert.equal(a.headers['content-type'], 'text/csv; charset=utf-8'); assert.equal(a.headers['content-disposition'], `attachment; filename="${path === 'leads.csv' ? 'lead-pipeline.csv' : path}"`);
      assert.ok(a.body.endsWith('\r\n')); if (path !== 'leads.csv') assert.equal(parseCsv(b.body).length, 1);
    }
  }
  const inventory = await s.json<InventoryReport>('/reports/inventory', 'GET', undefined, undefined, 'B'); assert.deepEqual(inventory.rows, []); assert.deepEqual(inventory.totals, {count: 0, totalCost: 0, totalListPrice: 0}); assert.ok(inventory.buckets.every(b => b.count === 0 && b.totalCost === 0));
  const sales = await s.json<SalesReport>('/reports/sales', 'GET', undefined, undefined, 'B'); assert.deepEqual(sales.rows, []); assert.deepEqual(sales.totals, {dealsSold: 0, totalFrontGross: 0, totalFiGross: 0, averageGross: 0});
  const leads = await s.json<LeadReport>('/reports/leads', 'GET', undefined, undefined, 'B'); assert.equal(leads.total, 0); assert.ok([...leads.byStage, ...leads.bySource].every(r => r.count === 0));
  assert.equal(await snapshot(), before);
});

test('report query allowlists and calendar ranges reject invalid input', async () => {
  const s = await setup();
  for (const path of ['sales', 'sales.csv', 'accounting.csv']) {
    for (const query of [{from: '10/02/2026'}, {from: '2026-02-30'}, {to: '2025-02-29'}, {to: ''}, {from: '2026-13-01'}, {from: '2026-10-03', to: '2026-10-02'}, {tenantId: 'B'}]) assert.equal((await s.request(`/reports/${path}`, query)).statusCode, 400);
    assert.equal((await s.request(`/reports/${path}`, {from: '2024-02-29'})).statusCode, 200);
  }
  for (const path of ['inventory', 'inventory.csv', 'leads', 'leads.csv']) for (const query of [{from: '2026-10-01'}, {tenantId: 'B'}]) assert.equal((await s.request(`/reports/${path}`, query)).statusCode, 400);
  for (const path of paths) assert.equal((await s.request(`/reports/${path}`, undefined, 'A', 'POST')).statusCode, 405);
});

test('RFC 4180 escaping is conditional and round-trips commas, quotes, CR and LF', () => {
  const rows = [['plain', 'comma,value', 'a"b', 'CR\rvalue', 'LF\nvalue', 'both\r\nvalue', '', '-450.00']];
  assert.equal(toCsv(rows), 'plain,"comma,value","a""b","CR\rvalue","LF\nvalue","both\r\nvalue",,-450.00\r\n');
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('sold date uses the last sold history entry in UTC, falling back to updatedAt', async () => {
  const s = await setup(), deal = await s.sell('2026-10-01', 1);
  assert.equal(soldDate({...deal, updatedAt: '2026-10-15T12:00:00Z'}), '2026-10-01');
  assert.equal(soldDate({...deal, history: [...deal.history, {status: 'sold', actorId: 'userA', timestamp: '2026-10-04T23:30:00-03:00'}]}), '2026-10-05');
  assert.equal(soldDate({...deal, history: [], updatedAt: '2026-10-15T12:00:00Z'}), '2026-10-15');
});

test('missing sold deal references or working pencil fail closed without partial reports', async () => {
  const s = await setup(); await s.sell('2026-10-01', 1); await s.sell('2026-10-02', 2); s.reset();
  // Fault-inject read results only; all fixture records were created through the handler.
  const repo = s.repositories.forTenant('A');
  for (const missing of ['vehicle', 'customer', 'pencil']) {
    const handler = createHandler({forTenant: () => new Proxy(repo, {get(target, property) {
      if (property === 'list' && missing === 'vehicle') return async () => [];
      if (property === 'crmList') return async (kind: Parameters<typeof repo.crmList>[0]) => {
        if (missing === 'customer' && kind === 'customer') return [];
        const rows = await target.crmList(kind);
        return missing === 'pencil' && kind === 'deal' ? rows.map(r => ({...r, workingPencilId: 'missing'})) : rows;
      };
      return Reflect.get(target, property);
    }})}, {decode: async () => { throw new Error('No network'); }});
    const tokens = new LocalTokens('reports-fault-test-at-least-32-characters');
    for (const path of ['sales', 'sales.csv', 'accounting.csv']) {
      const r = await handler({method: 'GET', path: `/reports/${path}`, claims: tokens.verify(tokens.issue('userA', 'A'))}); assert.equal(r.statusCode, 404); assert.ok(!r.body.includes('Pat'));
    }
  }
});


test('sales sort ties by deal ID and exclude working, approved and dead deals', async () => {
  const s = await setup();
  const a = await s.sell('2026-10-20', 1), b = await s.sell('2026-10-20', 2);
  for (const status of ['working', 'approved', 'dead']) {
    const vehicle = await s.vehicle(status);
    const deal = await s.json<DealView>('/deals', 'POST', {vehicleId: vehicle.id, customerId: s.customer.id, type: 'cash'});
    if (status !== 'working') await s.json(`/deals/${deal.id}`, 'PUT', {version: deal.version, status});
  }
  const sales = await s.json<SalesReport>('/reports/sales');
  assert.deepEqual(sales.rows.map(r => r.dealId), [a.id, b.id].sort());
  assert.equal(sales.totals.dealsSold, 2);
  const inventory = await s.json<InventoryReport>('/reports/inventory');
  assert.equal(inventory.totals.count, 3);
});
