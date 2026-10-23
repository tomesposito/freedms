import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreditApplication, DealView, Principal } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { credit } from '../src/credit.js';
import { renderPacket } from '../../web/src/jacket.js';
const now = new Date('2026-10-23T12:00:00Z');
const person = {fullName: 'Applicant <script>', dateOfBirth: '1990-01-01', ssn: '123-45-6789', address: '123 Main', phone: '', email: '', housingStatus: 'rent', monthlyHousingPayment: 100000, yearsAtAddress: 1, employerName: '', jobTitle: '', yearsEmployed: 0, grossMonthlyIncome: 500000, otherMonthlyIncome: 0, otherIncomeSource: ''};
const input = {applicant: person, coApplicant: {...person, fullName: 'Co Applicant', ssn: '987-65-4321'}, consentAt: now.toISOString()};
const quote = {lenderName: 'Trade bank', payoffAmount: 100000, goodThroughDate: '2026-11-01', accountNumber: '4111111111111111', notes: 'Quote'};
const decision = {outcome: 'approved', lenderName: 'Dealer-entered bank', termsNote: 'Manual terms', adverseReasons: []};
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'staff', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => now);
  const raw = (tenant: string, method = 'GET', path = '/fi-products', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  const createDeal = async (tenant = 'A'): Promise<DealView> => {
    const v = (await call(tenant, 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: ''})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type: 'finance'})).data;
  };
  return {repositories, handler, call, raw, createDeal};
}
test('Credit round trip, edits, last4 preservation/replacement, concurrency, workflow and final lock', async () => {
  const {call, createDeal} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
  assert.equal((await call('A', 'GET', path)).status, 404);
  const created = await call('A', 'POST', path, input); assert.equal(created.status, 201);
  assert.equal(created.data.status, 'draft'); assert.equal(created.data.decision, null); assert.equal(created.data.customerId, d.customerId);
  assert.deepEqual((await call('A', 'GET', path)).data, created.data);
  assert.equal((await call('A', 'POST', path, input)).status, 400);
  assert.equal((await call('A', 'PUT', path, {...input, version: 1, status: 'decision-recorded', decision})).status, 400);
  const {ssn, ...withoutSsn} = person;
  let result = await call('A', 'PUT', path, {...input, applicant: withoutSsn, version: 1});
  assert.equal(result.status, 200); assert.equal(result.data.applicant.ssnLast4, '6789');
  assert.equal((await call('A', 'PUT', path, {...input, version: 1})).status, 409);
  result = await call('A', 'PUT', path, {...input, applicant: {...person, ssn: '234567890'}, version: 2, status: 'ready'});
  assert.equal(result.data.applicant.ssnLast4, '7890');
  assert.equal((await call('A', 'PUT', path, {...input, version: 3, status: 'draft'})).status, 200);
  assert.equal((await call('A', 'PUT', path, {...input, version: 4, status: 'ready'})).status, 200);
  assert.equal((await call('A', 'PUT', path, {...input, version: 5, status: 'ready'})).status, 200);
  result = await call('A', 'PUT', path, {...input, version: 6, status: 'decision-recorded', decision});
  assert.equal(result.status, 200); assert.equal(result.data.decision.decidedAt, now.toISOString()); assert.equal(result.data.decision.decidedBy, 'userA');
  assert.equal((await call('A', 'PUT', path, {...input, version: 7})).status, 400);
});
test('Credit applicant, consent, decision and payoff validation reject malformed inputs', async () => {
  const {call, createDeal} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
  for (const patch of [{ssn: '1234'}, {ssn: '123 45 6789'}, {ssn: '1234567890'}, {ssn: '000-12-3456'}, {ssnLast4: '6789'}, {dateOfBirth: '2027-01-01'}, {dateOfBirth: '2026-02-30'}, {dateOfBirth: 'bad'}, {monthlyHousingPayment: -1}, {grossMonthlyIncome: 1.5}, {otherMonthlyIncome: -1}, {housingStatus: 'bad'}, {yearsEmployed: 101}, {yearsAtAddress: -1}, {yearsAtAddress: 1.5}, {fullName: ''}, {address: ''}, {phone: '12'}, {email: 'bad'}]) {
    assert.equal((await call('A', 'POST', path, {...input, applicant: {...person, ...patch}})).status, 400, JSON.stringify(patch));
  }
  for (const patch of [{consentAt: undefined}, {consentAt: '2026-02-30T12:00:00Z'}, {customerId: 'foreign'}, {tenantId: 'B'}]) assert.equal((await call('A', 'POST', path, {...input, ...patch})).status, 400);
  await call('A', 'POST', path, input);
  for (const patch of [{status: 'bad'}, {decision}, {status: 'ready', decision}, {applicant: {...person, ssnLast4: '1234'}}]) assert.equal((await call('A', 'PUT', path, {...input, version: 1, ...patch})).status, 400);
  await call('A', 'PUT', path, {...input, version: 1, status: 'ready'});
  for (const bad of [undefined, {...decision, outcome: 'declined'}, {...decision, outcome: 'bad'}, {...decision, lenderName: ''}, {...decision, adverseReasons: ['credit-history']}, {...decision, outcome: 'declined', adverseReasons: ['bad']}, {...decision, outcome: 'declined', adverseReasons: 'credit-history'}, {...decision, decidedAt: now.toISOString()}]) assert.equal((await call('A', 'PUT', path, {...input, version: 2, status: 'decision-recorded', decision: bad})).status, 400);
  for (const patch of [{payoffAmount: -1}, {goodThroughDate: '2026-02-30'}, {accountLast4: '1111'}, {accountNumber: '12-34'}, {lenderName: ''}]) assert.equal((await call('A', 'POST', `/deals/${d.id}/payoff-quotes`, {...quote, ...patch})).status, 400);
});
test('Credit and payoff tenant isolation, repository scope, authorization and route boundaries', async () => {
  const {call, createDeal, repositories, handler} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
  const a = (await call('A', 'POST', path, input)).data as CreditApplication;
  for (const [method, route, body] of [['GET', path, undefined], ['POST', path, input], ['PUT', path, {...input, version: 1}], ['GET', `/deals/${d.id}/payoff-quotes`, undefined], ['POST', `/deals/${d.id}/payoff-quotes`, quote]] as const) assert.equal((await call('B', method, route, body)).status, 404);
  assert.equal(await repositories.forTenant('B').crmGet('credit-application', a.id), undefined);
  const event = repositories.eventsForTest('A').find(e => e.type === 'credit-application.created')!;
  await assert.rejects(repositories.forTenant('B').crmWrite([{record: a, expectedVersion: 0, event}]), /scope/);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...a, tenantId: 'B'}, expectedVersion: 0, event}]), /scope/);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: a, expectedVersion: 0, event: {...event, tenantId: 'B'}}]), /scope/);
  assert.equal((await handler({method: 'GET', path})).statusCode, 401);
  await assert.rejects(credit({method: 'POST', path, body: JSON.stringify(input)}, {tenantId: 'A', userId: 'userA', role: 'reader'} as unknown as Principal, repositories.forTenant('A'), now), {status: 403});
  assert.equal((await call('A', 'DELETE', path)).status, 405);
  assert.equal((await call('A', 'GET', path + '/extra')).status, 404);
  assert.equal((await call('A', 'GET', path, undefined, {extra: 'bad'})).status, 400);
});
test('SSNs and full account numbers never reach responses, storage, outbox, jacket or CSV exports', async () => {
  const {call, raw, createDeal, repositories} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
  const responses: string[] = [];
  for (const [method, route, body] of [
    ['POST', path, input], ['PUT', path, {...input, version: 1, status: 'ready'}],
    ['PUT', path, {...input, version: 2, status: 'decision-recorded', decision}],
    ['GET', path, undefined], ['POST', `/deals/${d.id}/payoff-quotes`, quote],
    ['GET', `/deals/${d.id}/payoff-quotes`, undefined],
  ] as const) { const r = await raw('A', method, route, body); assert.ok(r.statusCode < 300, r.body); responses.push(r.body); }
  assert.equal((await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'approved'})).status, 200);
  const jacket = await raw('A', 'GET', `/deals/${d.id}/jacket`); assert.equal(jacket.statusCode, 200); responses.push(jacket.body);
  const j = JSON.parse(jacket.body).data;
  assert.equal(j.credit.applicantSsnLast4, '6789'); assert.equal(j.payoffQuotes[0].accountLast4, '1111'); assert.equal(j.adverseAction, null);
  responses.push(renderPacket(j));
  for (const route of ['/reports/sales.csv', '/reports/accounting.csv']) { const r = await raw('A', 'GET', route); assert.equal(r.statusCode, 200); responses.push(r.body); }
  const repo = repositories.forTenant('A'), events = repositories.eventsForTest('A');
  responses.push(JSON.stringify(await repo.crmList('credit-application')), JSON.stringify(await repo.crmList('payoff-quote')), JSON.stringify(events));
  for (const body of responses) for (const secret of ['123-45-6789', '123456789', '987-65-4321', '987654321', '4111111111111111']) assert.ok(!body.includes(secret));
  const a = (await call('A', 'GET', path)).data;
  assert.equal(a.applicant.ssnLast4, '6789'); assert.equal(a.coApplicant.ssnLast4, '4321');
  for (const type of ['credit-application.created', 'credit-application.updated', 'payoff-quote.created']) {
    const matching = events.filter(e => e.type === type); assert.ok(matching.length);
    for (const event of matching) {
      assert.equal(event.tenantId, 'A'); assert.equal(event.actorId, 'userA');
      assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort());
    }
  }
});
test('Jacket has adverse action only for declined decisions; payoff quotes are sorted and scoped', async () => {
  for (const outcome of [null, 'declined', 'approved', 'conditioned']) {
    const {call, createDeal, repositories} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
    if (outcome) {
      await call('A', 'POST', path, input); await call('A', 'PUT', path, {...input, version: 1, status: 'ready'});
      const r = await call('A', 'PUT', path, {...input, version: 2, status: 'decision-recorded', decision: {...decision, outcome, lenderName: outcome === 'declined' ? '' : 'Bank', adverseReasons: outcome === 'declined' ? ['credit-history', 'credit-history', 'insufficient-income'] : []}});
      assert.equal(r.status, 200);
    }
    assert.equal((await call('A', 'GET', `/deals/${d.id}/jacket`)).status, 400);
    await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'approved'});
    const j = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data;
    assert.equal(!!j.credit, !!outcome);
    if (outcome === 'declined') assert.deepEqual(j.adverseAction.reasons, ['credit-history', 'insufficient-income']); else assert.equal(j.adverseAction, null);
    assert.equal(renderPacket(j).includes('Adverse action notice'), outcome === 'declined');
    const qpath = `/deals/${d.id}/payoff-quotes`;
    assert.deepEqual((await call('A', 'GET', qpath)).data, []);
    const q1 = (await call('A', 'POST', qpath, quote)).data, q2 = (await call('A', 'POST', qpath, quote)).data;
    assert.equal(q1.accountLast4, '1111'); assert.equal(q1.quotedAt, now.toISOString());
    assert.deepEqual((await call('A', 'GET', qpath)).data.map((q: {id: string}) => q.id), [q1.id, q2.id].sort());
    assert.equal(await repositories.forTenant('B').crmGet('payoff-quote', q1.id), undefined);
  }
});
test('Concurrent creates cannot produce multiple applications for a deal', async () => {
  const {call, createDeal, repositories} = await setup(); const d = await createDeal(), path = `/deals/${d.id}/credit-application`;
  const results = await Promise.all([call('A', 'POST', path, input), call('A', 'POST', path, input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 400]);
  assert.equal((await repositories.forTenant('A').crmList('credit-application')).length, 1);
});
