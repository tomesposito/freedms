import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoRepositories } from '../src/dynamo.js';
import { agingBuckets, type Vehicle } from '@freedms/shared';
import { view } from '../src/validation.js';
import { customReport } from '../src/reports-p2.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadSources, leadStages, pencilMath, type Deal, type CrmEntity, type Lead, type DealView, type InventoryReport, type LeadReport, type SalesReport } from '@freedms/shared';
import { countLeads } from '../src/repository.js';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { inventoryReport, salesReport, inventoryCsv, leadReport, leadCsv, salesCsv, soldDate, toCsv } from '../src/reports.js';

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
  const vehicle = async (stockNumber: string, days = 0, cost = 700000, recon = 50000) => json('/vehicles', 'POST', {mileage: null, stockNumber, vin: '1HGCM82633A004352', year: 2019, make: 'Honda, "Special"', model: 'Accord', trim: 'EX', status: 'available', listPrice: 1000000, cost, reconCosts: [{description: 'Repair', amount: recon}], dateStocked: new Date(clock.getTime() - days * 86400000).toISOString().slice(0, 10), location: '', notes: ''});
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
      if (property === 'salesReportRows') return async (range: Parameters<typeof repo.salesReportRows>[0]) => {
        const rows = await target.salesReportRows(range);
        if (missing === 'vehicle') rows.vehicles = [];
        if (missing === 'customer') rows.customers = [];
        if (missing === 'pencil') rows.deals = rows.deals.map(r => ({...r, workingPencilId: 'missing'}));
        return rows;
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

test('lead counter consumes a raw iterable once and preserves legacy counts and ordering', async () => {
  const s = await setup();
  const {lead: template} = await s.json<{lead: Lead}>('/leads', 'POST', {customerId: s.customer.id, source: 'phone'});
  const leads = [template, {...template, stage: 'contacted', source: 'website'},
    {...template, stage: 'contacted', source: 'phone'},
    {...template, stage: 'unknown', source: 'toString'}] as Lead[];
  const expected = {byStage: leadStages.map(stage => ({stage, count: leads.filter(l => l.stage === stage).length})),
    bySource: leadSources.map(source => ({source, count: leads.filter(l => l.source === source).length})), total: leads.length};
  let passes = 0, visits = 0;
  const rows: Iterable<CrmEntity> = {[Symbol.iterator]: function* () {
    assert.equal(++passes, 1);
    yield s.customer;
    for (const lead of leads) { visits++; yield lead; }
  }};
  const actual = countLeads(rows);
  assert.equal(visits, 4); assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(leadCsv(actual), leadCsv(expected));
  assert.deepEqual(countLeads(leads.slice(2), countLeads(leads.slice(0, 2))), expected);
});

test('memory lead summary avoids cloning and full-list reads, stays fresh and tenant isolated', async t => {
  const s = await setup();
  const {lead} = await s.json<{lead: Lead}>('/leads', 'POST', {customerId: s.customer.id, source: 'phone'});
  const repo = s.repositories.forTenant('A');
  const old = await repo.crmList('lead');
  const clone = t.mock.method(globalThis, 'structuredClone', () => { throw new Error('summary must not clone rows'); });
  const guarded = new Proxy(repo, {get(target, property) {
    if (property === 'crmList') return () => { throw new Error('summary must not list rows'); };
    return Reflect.get(target, property);
  }});
  assert.deepEqual(await leadReport(guarded), countLeads(old));
  assert.deepEqual(await s.repositories.forTenant('B').leadSummary(), countLeads([]));
  clone.mock.restore();
  await s.json(`/leads/${lead.id}`, 'PUT', {version: lead.version, stage: 'contacted'});
  const updated = await repo.leadSummary();
  assert.equal(updated.total, 1);
  assert.equal(updated.byStage.find(row => row.stage === 'new')!.count, 0);
  assert.equal(updated.byStage.find(row => row.stage === 'contacted')!.count, 1);
  updated.byStage[0].count = 999;
  assert.equal((await repo.leadSummary()).byStage[0].count, 0);
});


test('sales bounded read preserves rows and totals amid unrelated data and clones only selected references', async t => {
  const s = await setup();
  await s.sell('2026-10-02', 1); await s.sell('2026-10-03', 2);
  const repo = s.repositories.forTenant('A'), range = {from: '2026-10-02', to: '2026-10-03'};
  const expected = await salesReport(repo, range), template = (await repo.crmList('deal'))[0];
  const vehicle = (await repo.list({}))[0];
  const write = async (record: CrmEntity) => repo.crmWrite([{record, expectedVersion: 0, event: {
    id: record.id, tenantId: 'A', actorId: 'userA', aggregateId: record.id, aggregateVersion: 1,
    type: `${record.kind}.created` as 'deal.created', occurredAt: record.createdAt, deliveryStatus: 'pending'
  }}]);
  for (let i = 0; i < 1000; i++) {
    const v = {...vehicle, id: `unrelated-v-${i}`, version: 1};
    await repo.create(v, {id: v.id, tenantId: 'A', actorId: 'userA', aggregateId: v.id, aggregateVersion: 1,
      type: 'vehicle.created', occurredAt: v.createdAt, deliveryStatus: 'pending'});
    await write({...s.customer, id: `unrelated-c-${i}`, version: 1});
    await write({...template, id: `excluded-${i}`, version: 1, status: i % 2 ? 'working' : 'sold',
      history: [], updatedAt: i % 4 ? '2026-10-01T23:59:59Z' : '2026-10-04T00:00:00Z',
      vehicleId: 'missing', customerId: 'missing', workingPencilId: 'missing'});
  }
  const clone = structuredClone;
  const spy = t.mock.method(globalThis, 'structuredClone', (value: unknown) => {
    const rows = value as Awaited<ReturnType<typeof repo.salesReportRows>>;
    assert.equal(rows.deals.length, 2); assert.equal(rows.vehicles.length, 2); assert.equal(rows.customers.length, 1);
    return clone(value);
  });
  const guarded = new Proxy(repo, {get(target, property) {
    if (property === 'list' || property === 'crmList') return () => { throw new Error('no full lists'); };
    return Reflect.get(target, property);
  }});
  assert.equal(JSON.stringify(await salesReport(guarded, range)), JSON.stringify(expected));
  const rows = await repo.salesReportRows(range); rows.deals[0].history = []; rows.vehicles[0].cost = -1; rows.customers[0].name = 'mutated';
  assert.deepEqual(await salesReport(guarded, range), expected);
  spy.mock.restore();
  assert.deepEqual(await s.repositories.forTenant('B').salesReportRows(range), {deals: [], vehicles: [], customers: []});
});

test('memory and Dynamo sales selection agree on UTC boundaries, history fallback and dangling references', async () => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {GetCommand, QueryCommand} = await import('@aws-sdk/lib-dynamodb');
  const s = await setup(); await s.sell('2026-10-02', 1);
  const repo = s.repositories.forTenant('A'), template = (await repo.crmList('deal'))[0];
  const vehicles = await repo.list({}), customers = await repo.crmList('customer');
  const range = {from: '2026-10-02', to: '2026-10-03'};
  for (const fault of ['none', 'vehicle', 'customer', 'pencil'] as const) {
    const deals: Deal[] = [
      {...template, id: 'from', history: [], updatedAt: '2026-10-02T00:00:00Z'},
      {...template, id: 'to', history: [...template.history, {status: 'sold', actorId: 'userA', timestamp: '2026-10-04T01:00:00+02:00'}]},
      ...['2026-10-01', '2026-10-04'].map((date, i) => ({...template, id: `outside-${i}`, history: [], updatedAt: `${date}T12:00:00Z`, vehicleId: 'missing', customerId: 'missing', workingPencilId: 'missing'})),
      {...template, id: 'unsold', status: 'working', history: [], vehicleId: 'missing', customerId: 'missing', workingPencilId: 'missing'}
    ];
    if (fault === 'vehicle') deals[0].vehicleId = 'missing';
    if (fault === 'customer') deals[0].customerId = 'missing';
    if (fault === 'pencil') deals[0].workingPencilId = 'missing';
    const memory = new MemoryRepositories().forTenant('A');
    for (const v of vehicles) await memory.create({...v, version: 1}, {id: v.id, tenantId: 'A', actorId: 'userA', aggregateId: v.id, aggregateVersion: 1, type: 'vehicle.created', occurredAt: v.createdAt, deliveryStatus: 'pending'});
    for (const r of [...customers, ...deals]) await memory.crmWrite([{record: {...r, version: 1}, expectedVersion: 0, event: {id: r.id, tenantId: 'A', actorId: 'userA', aggregateId: r.id, aggregateVersion: 1, type: `${r.kind}.created`, occurredAt: r.createdAt, deliveryStatus: 'pending'}}]);
    const gets: string[] = [];
    const client = {send: async (command: InstanceType<typeof GetCommand> | InstanceType<typeof QueryCommand>) => {
      if (command instanceof GetCommand) {
        assert.equal(command.input.Key?.PK, 'TENANT#A');
        const key = String(command.input.Key?.SK); gets.push(key);
        const data = [...vehicles, ...customers].find(r => `${'kind' in r ? 'CUSTOMER' : 'VEHICLE'}#${r.id}` === key);
        return data ? {Item: {data}} : {};
      }
      assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'DEAL#');
      assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
      return {Items: deals.map(data => ({data}))};
    }} as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
    const dynamo = new DynamoRepositories('table', client).forTenant('A');
    if (fault === 'none') {
      const actual = await salesReport(memory, range);
      assert.deepEqual(actual.rows.map(r => [r.dealId, r.soldDate]), [['from', '2026-10-02'], ['to', '2026-10-03']]);
      assert.deepEqual(await salesReport(dynamo, range), actual);
      assert.equal(gets.length, 2); assert.ok(gets.every(id => !id.endsWith('#missing')));
    } else {
      for (const backend of [memory, dynamo]) await assert.rejects(salesReport(backend, range), {status: 404, code: 'NOT_FOUND', message: 'Record not found.'});
    }
  }
});


test('inventory bounded reads preserve legacy JSON/CSV, page through sold rows and detach tenant data', async t => {
  const s = await setup(), now = new Date('2026-10-20T12:00:00Z');
  const template: Vehicle = await s.vehicle('Z-template', 91);
  const memory = s.repositories.forTenant('A');
  for (const [i, days] of [0, 30, 31, 60, 61, 90, 91, 120].entries()) {
    const row: Vehicle = {...template, id: `fixture-${i}`, stockNumber: `A-${i}`,
      status: (['available', 'reserved', 'in recon', 'sold'] as const)[i % 4],
      trim: i % 2 ? '' : 'EX', cost: 10001 + i, listPrice: 20003 + i,
      reconCosts: [{description: 'One', amount: 123}, {description: 'Two', amount: 456}],
      dateStocked: new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10)};
    await memory.create(row, {id: row.id, tenantId: 'A', actorId: 'userA', aggregateId: row.id,
      aggregateVersion: 1, type: 'vehicle.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  }
  const foreign = {...template, id: 'foreign', tenantId: 'B', stockNumber: 'PRIVATE-B'};
  await s.repositories.forTenant('B').create(foreign, {id: 'foreign', tenantId: 'B', actorId: 'userB', aggregateId: foreign.id,
    aggregateVersion: 1, type: 'vehicle.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const all = await memory.list({});
  // Independent legacy all-vehicle computation, including its response property order.
  const rows = all.filter(v => v.status !== 'sold').map(vehicle => {
    const v = view(vehicle, now);
    const bucket = agingBuckets[v.agingDays <= 30 ? 0 : v.agingDays <= 60 ? 1 : v.agingDays <= 90 ? 2 : 3];
    return {stockNumber: v.stockNumber, vehicle: [`${v.year} ${v.make} ${v.model}`, v.trim].filter(Boolean).join(' '), status: v.status, dateStocked: v.dateStocked, agingDays: v.agingDays, bucket, listPrice: v.listPrice, cost: v.cost, reconTotal: v.reconTotal, totalCost: v.cost + v.reconTotal};
  }).sort((a, b) => b.agingDays - a.agingDays || a.stockNumber.localeCompare(b.stockNumber));
  const expected = {rows, buckets: agingBuckets.map(bucket => ({bucket, count: rows.filter(r => r.bucket === bucket).length, totalCost: rows.filter(r => r.bucket === bucket).reduce((sum, r) => sum + r.totalCost, 0)})),
    totals: {count: rows.length, totalCost: rows.reduce((sum, r) => sum + r.totalCost, 0), totalListPrice: rows.reduce((sum, r) => sum + r.listPrice, 0)}};
  let pages = 0, corrupt = false;
  const client = {send: async (command: QueryCommand) => {
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.TableName, 'table');
    assert.equal(command.input.KeyConditionExpression, 'PK = :pk AND begins_with(SK, :prefix)');
    assert.equal(command.input.ExpressionAttributeValues?.[':prefix'], 'VEHICLE#');
    assert.equal(command.input.ConsistentRead, true);
    const pk = command.input.ExpressionAttributeValues?.[':pk'];
    assert.ok(['TENANT#A', 'TENANT#B', 'TENANT#empty'].includes(pk));
    const data = pk === 'TENANT#A' ? all : pk === 'TENANT#B' ? [foreign] : [];
    const offset = Number(command.input.ExclusiveStartKey?.offset ?? 0);
    if (offset) assert.equal(command.input.ExclusiveStartKey?.PK, pk);
    pages++;
    // Fresh deserialized objects, as returned by the real document client; one row per page.
    return {Items: structuredClone(data.slice(offset, offset + 1).map(data => ({data: corrupt ? {...data, tenantId: 'B'} : data}))),
      ...(offset + 1 < data.length ? {LastEvaluatedKey: {PK: pk, offset: offset + 1}} : {})};
  }} as unknown as DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('table', client);
  const selected = all.filter(v => v.status !== 'sold');
  const normalize = (rows: Vehicle[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const repo of [memory, dynamo.forTenant('A')]) {
    const guarded = new Proxy(repo, {get(target, property) {
      if (property === 'list') return () => { throw new Error('inventory must not load the full vehicle list'); };
      return Reflect.get(target, property);
    }});
    assert.deepEqual(normalize(await repo.inventoryReportRows()), normalize(structuredClone(selected)));
    const result = await inventoryReport(guarded, now);
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
    assert.equal(inventoryCsv(result), inventoryCsv(expected));
    const custom = await customReport(guarded, now, {dataset: 'inventory', columns: ['stockNumber', 'status']});
    assert.deepEqual(custom.rows, expected.rows.map(r => [r.stockNumber, r.status]));
    const detached = await repo.inventoryReportRows();
    detached[0].stockNumber = 'MUTATED'; detached[0].reconCosts[0].amount = -1;
    assert.deepEqual(normalize(await repo.inventoryReportRows()), normalize(structuredClone(selected)));
  }
  assert.ok(pages >= all.length * 5);
  for (const factory of [s.repositories, dynamo]) {
    assert.deepEqual(await factory.forTenant('B').inventoryReportRows(), [foreign]);
    assert.deepEqual(await factory.forTenant('empty').inventoryReportRows(), []);
    assert.deepEqual(await inventoryReport(factory.forTenant('empty'), now), {rows: [],
      buckets: agingBuckets.map(bucket => ({bucket, count: 0, totalCost: 0})), totals: {count: 0, totalCost: 0, totalListPrice: 0}});
  }
  corrupt = true;
  await assert.rejects(dynamo.forTenant('A').inventoryReportRows(), /scope/);
  const originalClone = globalThis.structuredClone;
  const clone = t.mock.method(globalThis, 'structuredClone', <T>(value: T): T => {
    assert.ok(Array.isArray(value));
    assert.equal(value.length, selected.length);
    assert.ok(value.every((v: Vehicle) => v.status !== 'sold'));
    return originalClone(value);
  });
  await memory.inventoryReportRows();
  assert.equal(clone.mock.callCount(), 1);
});
