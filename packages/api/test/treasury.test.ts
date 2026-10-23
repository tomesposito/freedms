import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aging, cashRegister, type JournalEntry, type Principal } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { treasury } from '../src/treasury.js';
async function setup() {
  let now = new Date('2026-08-01T12:00:00Z');
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('treasury-test-secret-32-characters-long', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: tenantId, name: tenantId}, {tenantId, userId: tenantId, role: 'admin', active: true}, {id: 'provision', tenantId, actorId: tenantId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('Offline only'); }}, () => now);
  const call = async (path: string, method = 'GET', body?: unknown, tenant = 'A', query?: Record<string, string>) => {
    const r = await handler({method, path: `/accounting/${path}`, ...(body === undefined ? {} : {body: JSON.stringify(body)}), claims: tokens.verify(tokens.issue(tenant, tenant)), query});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const post = (side = 'ap', fields = {}) => call(side, 'POST', {party: 'Supplier', reference: 'INV-1', dueDate: '2026-08-15', amount: 10000, offsetAccountId: side === 'ap' ? 'account-1200' : 'account-4000', ...fields});
  return {repositories, call, post, handler, advance: (date: string) => { now = new Date(date); }};
}
const payment = {amount: 4000, cashAccountId: 'account-1000', reference: 'Check 123'};
test('AP and AR balanced postings, partial payments, aging to GL, immutable reversals, concurrent allocations and outbox', async () => {
  const {call, post, repositories, advance} = await setup();
  for (const side of ['ap', 'ar']) {
    assert.deepEqual((await call(side)).data.rows, []);
    const posted = await post(side); assert.equal(posted.status, 201, JSON.stringify(posted));
    const id = posted.data.lines[0].itemId;
    assert.equal((await call(`${side}/${id}/payments`, 'POST', payment)).status, 201);
    const races = await Promise.all([call(`${side}/${id}/payments`, 'POST', payment), call(`${side}/${id}/payments`, 'POST', payment)]);
    assert.deepEqual(races.map(r => r.status).sort(), [201, 409]);
    assert.equal((await call(`${side}/${id}/payments`, 'POST', payment)).status, 400);
    advance('2026-10-23T12:00:00Z');
    const aged = (await call(side)).data;
    assert.equal(aged.total, 2000); assert.equal(aged.glBalance, aged.total); assert.equal(aged.buckets.reduce((s: number, b: {amount: number}) => s + b.amount, 0), aged.total);
    const balances = (await call('balances')).data;
    const controls = side === 'ar' ? ['1100'] : ['2100', '2200', '2300', '2400'];
    assert.equal(aged.total, balances.filter((r: {code: string}) => controls.includes(r.code)).reduce((s: number, r: {balance: number}) => s + r.balance, 0));
    assert.equal(aged.rows[0].bucket, '61–90');
    const historical = (await call(side, 'GET', undefined, 'A', {asOf: '2026-07-01'})).data; assert.equal(historical.total, 0);
    const journals = (await call('journal')).data as JournalEntry[];
    const paid = journals.filter(j => j.source === 'payment' && j.lines[0].itemId === id)[0];
    assert.equal((await call(`journal/${paid.id}/reverse`, 'POST', {})).status, 201);
    assert.equal((await call(side)).data.total, 6000);
    assert.equal((await call(`journal/${posted.data.id}/reverse`, 'POST', {})).status, 201);
    assert.equal((await call(side)).data.total, -4000);
    advance('2026-08-01T12:00:00Z');
  }
  const entries = await repositories.forTenant('A').crmList('journal-entry');
  for (const j of entries) assert.equal(j.lines.reduce((s, l) => s + l.debit, 0), j.lines.reduce((s, l) => s + l.credit, 0));
  for (const j of entries) assert.ok(repositories.eventsForTest('A').some(e => e.aggregateId === j.id && e.type === 'journal-entry.created'));
  const register = (await call('cash/account-1000')).data;
  assert.deepEqual(register, cashRegister(entries, 'account-1000'));
});
test('Every treasury route is tenant-scoped, validates inputs and enforces write authorization', async () => {
  const {call, post, repositories, handler, advance} = await setup();
  const bill = (await post()).data, item = bill.lines[0].itemId;
  const bank = await call('cash', 'POST', {code: '1010', name: 'Operating bank'}); assert.equal(bank.status, 201);
  assert.deepEqual((await call('cash/account-1010')).data, []);
  advance('2026-10-23T12:00:00Z');
  const period = (await call('reconciliations', 'POST', {accountId: 'account-1010', from: '2026-08-01', to: '2026-08-31', opening: 0, closing: 0})).data;
  for (const side of ['ap', 'ar']) { assert.deepEqual((await call(side, 'GET', undefined, 'B')).data.rows, []); assert.equal((await call(`${side}/${item}/payments`, 'POST', payment, 'B')).status, 404); }
  assert.equal((await call('cash/account-1010', 'GET', undefined, 'B')).status, 404);
  assert.deepEqual((await call('reconciliations', 'GET', undefined, 'B')).data, []);
  assert.equal((await call(`reconciliations/${period.id}`, 'GET', undefined, 'B')).status, 404);
  for (const action of ['lines', 'preview', 'import', 'match', 'close', 'amend', 'remove']) assert.equal((await call(`reconciliations/${period.id}/${action}`, 'POST', {}, 'B')).status, 404);
  for (const kind of ['accounting-lock', 'bank-reconciliation'] as const) {
    const records = await repositories.forTenant('A').crmList(kind); assert.ok(records.length);
    for (const record of records) {
      assert.equal(await repositories.forTenant('B').crmGet(kind, record.id), undefined);
      const event = repositories.eventsForTest('A').find(e => e.aggregateId === record.id)!;
      await assert.rejects(repositories.forTenant('B').crmWrite([{record, event, expectedVersion: record.version - 1}]), /scope/);
    }
  }
  for (const path of ['ap', 'ar', 'cash', 'reconciliations']) {
    assert.equal((await handler({method: 'GET', path: `/accounting/${path}`})).statusCode, 401);
    await assert.rejects(treasury({method: 'POST', path: `/accounting/${path}`, body: '{}'}, {tenantId: 'A', userId: 'A', role: 'reader'} as unknown as Principal, repositories.forTenant('A'), new Date()), {status: 403});
    assert.equal((await call(path, 'DELETE')).status, 405);
    assert.equal((await call(path, 'GET', undefined, 'A', {tenantId: 'B'})).status, 400);
  }
  for (const fields of [{amount: 0}, {amount: -1}, {amount: 1.5}, {amount: Number.MAX_SAFE_INTEGER}, {dueDate: '2026-02-30'}, {offsetAccountId: 'account-1000'}, {vehicleId: 'foreign'}, {tenantId: 'B'}]) assert.ok([400, 404].includes((await post('ap', fields)).status));
  assert.equal((await post('ar', {offsetAccountId: 'account-1100'})).status, 400);
  assert.equal((await call('cash', 'POST', {code: '1000', name: 'Duplicate'})).status, 409);
  assert.equal((await call('cash', 'POST', {code: 'bad', name: 'Invalid'})).status, 400);
  assert.equal((await call('ap', 'GET', undefined, 'A', {asOf: '2099-01-01'})).status, 400);
});
test('Statement CSV preview is read-only, validated, bound to tenant/version/content and duplicate-safe; reconciliation closes only at zero', async () => {
  const {call, post, advance, repositories} = await setup();
  const bill = (await post('ar')).data;
  const paid = (await call(`ar/${bill.lines[0].itemId}/payments`, 'POST', {...payment, amount: 10000})).data;
  advance('2026-09-01T12:00:00Z');
  const input = {accountId: 'account-1000', from: '2026-08-01', to: '2026-08-31', opening: 0, closing: 10000};
  assert.equal((await call('reconciliations', 'POST', {...input, to: '2026-09-01'})).status, 400);
  assert.equal((await call('reconciliations', 'POST', {...input, opening: 1})).status, 400);
  let p = (await call('reconciliations', 'POST', input)).data;
  assert.equal((await call('reconciliations', 'POST', input)).status, 400);
  const path = `reconciliations/${p.id}`;
  assert.equal((await call(`${path}/close`, 'POST', {version: p.version})).status, 400);
  const csv = 'id,date,description,amountCents\nbank-1,2026-08-02,"Lender, funding",10000\n';
  const count = repositories.eventsForTest('A').length;
  const preview = await call(`${path}/preview`, 'POST', {csv}); assert.equal(preview.status, 200); assert.equal(preview.data.validCount, 1);
  assert.equal(repositories.eventsForTest('A').length, count);
  assert.equal((await call(`${path}/import`, 'POST', {csv, version: p.version, previewToken: 'invented'})).status, 409);
  assert.equal((await call(`${path}/import`, 'POST', {csv: csv.replace('10000', '9000'), version: p.version, previewToken: preview.data.previewToken})).status, 409);
  p = (await call(`${path}/import`, 'POST', {csv, version: p.version, previewToken: preview.data.previewToken})).data;
  assert.equal(p.lines.length, 1); assert.equal(p.statementDifference, 0); assert.equal(p.unmatchedCount, 1);
  assert.equal((await call(`${path}/close`, 'POST', {version: p.version})).status, 400);
  const duplicate = (await call(`${path}/preview`, 'POST', {csv})).data; assert.equal(duplicate.duplicateCount, 1);
  assert.equal((await call(`${path}/import`, 'POST', {csv, version: p.version, previewToken: duplicate.previewToken})).status, 400);
  for (const bad of ['id,date,description,amountCents\nx,2026-02-30,test,10', 'id,date,description,amountCents\nx,2026-08-01,test,1.1', 'id,date,description,amountCents\nx,2026-09-01,test,10']) assert.equal((await call(`${path}/preview`, 'POST', {csv: bad})).data.errorCount, 1);
  assert.equal((await call(`${path}/preview`, 'POST', {csv: 'bad\nx'})).status, 400);
  assert.equal((await call(`${path}/match`, 'POST', {version: p.version, lineId: 'bank-1', registerId: 'foreign'})).status, 404);
  p = (await call(`${path}/match`, 'POST', {version: p.version, lineId: 'bank-1', registerId: `${paid.id}-line-1`})).data;
  assert.equal(p.difference, 0); assert.equal(p.outstanding, 0); assert.equal(p.unmatchedCount, 0);
  assert.equal((await call(`${path}/close`, 'POST', {version: 1})).status, 409);
  p = (await call(`${path}/close`, 'POST', {version: p.version})).data; assert.equal(p.status, 'reconciled');
  assert.equal((await call(`${path}/lines`, 'POST', {version: p.version, line: {id: 'x', date: '2026-08-01', description: 'x', amount: 1}})).status, 409);
  advance('2026-10-01T12:00:00Z');
  assert.equal((await call('reconciliations', 'POST', {...input, from: '2026-08-31', to: '2026-09-30', opening: 10000})).status, 400);
  const next = await call('reconciliations', 'POST', {...input, from: '2026-09-01', to: '2026-09-30', opening: 10000}); assert.equal(next.status, 201);
  assert.equal((await call(`reconciliations/${next.data.id}/close`, 'POST', {version: 1})).data.status, 'reconciled');
});
test('Manual statement lines, unmatched outstanding checks, amount mismatch and duplicate matches', async () => {
  const {call, post, advance} = await setup();
  const bill = (await post()).data;
  const paid = (await call(`ap/${bill.lines[0].itemId}/payments`, 'POST', payment)).data;
  advance('2026-09-01T12:00:00Z');
  let p = (await call('reconciliations', 'POST', {accountId: 'account-1000', from: '2026-08-01', to: '2026-08-31', opening: 0, closing: 0})).data;
  const firstPeriodId = p.id;
  assert.equal(p.outstanding, -4000); assert.equal(p.bookBalance, -4000); assert.equal(p.difference, 0);
  assert.equal((await call(`reconciliations/${p.id}/close`, 'POST', {version: p.version})).data.status, 'reconciled');
  advance('2026-10-01T12:00:00Z');
  p = (await call('reconciliations', 'POST', {accountId: 'account-1000', from: '2026-09-01', to: '2026-09-30', opening: 0, closing: -4000})).data;
  const path = `reconciliations/${p.id}`;
  p = (await call(`${path}/lines`, 'POST', {version: p.version, line: {id: 'check', date: '2026-09-01', description: 'Cleared check', amount: -4000}})).data;
  assert.equal((await call(`${path}/lines`, 'POST', {version: p.version, line: {id: 'check', date: '2026-09-01', description: 'Duplicate', amount: -4000}})).status, 409);
  p = (await call(`${path}/match`, 'POST', {version: p.version, lineId: 'check', registerId: `${paid.id}-line-1`})).data;
  assert.equal(p.difference, 0);
  p = (await call(`${path}/match`, 'POST', {version: p.version, lineId: 'check', registerId: null})).data;
  assert.equal(p.unmatchedCount, 1);
  p = (await call(`${path}/match`, 'POST', {version: p.version, lineId: 'check', registerId: `${paid.id}-line-1`})).data;
  assert.equal((await call(`${path}/close`, 'POST', {version: p.version})).data.status, 'reconciled');
  const historic = (await call(`reconciliations/${firstPeriodId}`)).data; assert.equal(historic.outstanding, -4000); assert.equal(historic.difference, 0);
});
test('Aging recognizes legacy contracts in transit and all due-date boundaries', () => {
  const amounts = [1, 2, 3, 4, 5, 6, 7, 8];
  const dates = ['2026-10-24', '2026-10-23', '2026-10-22', '2026-09-23', '2026-09-22', '2026-08-24', '2026-08-23', '2026-07-24'];
  const entries = dates.map((dueDate, i) => ({id: `posting-${i}`, date: '2026-01-01', memo: 'Buyer / deal', lines: [{accountId: 'account-1100', accountCode: '1100', debit: amounts[i], credit: 0, dueDate}]})) as JournalEntry[];
  const report = aging(entries, 'ar', '2026-10-23');
  assert.deepEqual(report.buckets.map(b => b.amount), [3, 7, 11, 7, 8]); assert.equal(report.total, 36); assert.equal(report.total, report.glBalance);
});
test('Open statement corrections are versioned; mismatched amounts, reused entries and nonzero arithmetic cannot close', async () => {
  const {call, post, advance} = await setup();
  const bill = (await post('ar')).data;
  const paid = (await call(`ar/${bill.lines[0].itemId}/payments`, 'POST', payment)).data;
  advance('2026-09-01T12:00:00Z');
  const input = {accountId: 'account-1000', from: '2026-08-01', to: '2026-08-31', opening: 0, closing: 4000};
  const concurrent = await Promise.all([call('reconciliations', 'POST', input), call('reconciliations', 'POST', input)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
  let p = concurrent.find(r => r.status === 201)!.data;
  const path = `reconciliations/${p.id}`;
  p = (await call(`${path}/lines`, 'POST', {version: p.version, line: {id: 'wrong', date: '2026-08-01', description: 'Wrong amount', amount: 3000}})).data;
  assert.equal((await call(`${path}/match`, 'POST', {version: p.version, lineId: 'wrong', registerId: `${paid.id}-line-1`})).status, 400);
  assert.equal((await call(`${path}/remove`, 'POST', {version: 1, lineId: 'wrong'})).status, 409);
  p = (await call(`${path}/remove`, 'POST', {version: p.version, lineId: 'wrong'})).data;
  for (const id of ['one', 'two']) p = (await call(`${path}/lines`, 'POST', {version: p.version, line: {id, date: '2026-08-01', description: id, amount: 4000}})).data;
  p = (await call(`${path}/match`, 'POST', {version: p.version, lineId: 'one', registerId: `${paid.id}-line-1`})).data;
  assert.equal((await call(`${path}/match`, 'POST', {version: p.version, lineId: 'two', registerId: `${paid.id}-line-1`})).status, 409);
  assert.equal((await call(`${path}/close`, 'POST', {version: p.version})).status, 400);
  p = (await call(`${path}/remove`, 'POST', {version: p.version, lineId: 'two'})).data;
  p = (await call(`${path}/amend`, 'POST', {version: p.version, closing: 5000})).data;
  assert.equal((await call(`${path}/close`, 'POST', {version: p.version})).status, 400);
  p = (await call(`${path}/amend`, 'POST', {version: p.version, closing: 4000})).data;
  p = (await call(`${path}/close`, 'POST', {version: p.version})).data;
  assert.equal(p.status, 'reconciled');
  for (const action of ['amend', 'remove']) assert.equal((await call(`${path}/${action}`, 'POST', {version: p.version, closing: 0, lineId: 'one'})).status, 409);
});
