import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pencilMath, leaseMath, maxDocumentBytes, type DealView, type ShareResponse } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { publicShare } from '../src/retail.js';
const now = new Date('2026-10-23T12:00:00Z');
const product = {name: 'Service contract', category: 'service-contract', cost: 90000, retailPrice: 150000, termNotes: '36 months', active: true};
async function setup() {
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('fi-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role: 'admin', active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  let clock = now;
  const storage = new MemoryDocumentStore();
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => clock, storage);
  const raw = (tenant: string, method = 'GET', path = '/fi-products', body?: unknown, query?: ApiRequest['query']) => handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
  const call = async (...args: Parameters<typeof raw>) => { const r = await raw(...args); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  let sequence = 0;
  const createDeal = async (tenant = 'A', type = 'finance'): Promise<DealView> => {
    ++sequence;
    const v = (await call(tenant, 'POST', '/vehicles', {mileage: null, stockNumber: `test-${sequence}`, vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, cost: 712345, reconCosts: [{description: 'Repair', amount: 50000}], dateStocked: '2026-10-19', location: '', notes: 'INTERNAL PRIVATE'})).data;
    const lead = (await call(tenant, 'POST', '/leads', {customer: {name: `Buyer ${sequence}`, phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
    return (await call(tenant, 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, type})).data;
  };
  const pub = async (token: string, suffix = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') => { const r = await handler({method, path: `/share/${token}${suffix}`, body: body === undefined ? undefined : JSON.stringify(body)}); return {status: r.statusCode, ...JSON.parse(r.body)}; };
  return {repositories, handler, call, raw, createDeal, pub, storage, setClock: (date: Date) => { clock = date; }};
}
test('retail creation, settings, authorization, safe metadata and rotation', async () => {
  const {call, createDeal, repositories, handler, pub, setClock} = await setup();
  const d = await createDeal(), path = `/deals/${d.id}/share`;
  assert.deepEqual((await call('A', 'GET', path)).data, {share: null, responses: []});
  assert.equal((await call('A', 'POST', path + '/revoke', {})).status, 404);
  for (const method of ['GET', 'POST']) assert.equal((await handler({method, path, body: '{}'})).statusCode, 401);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/revoke']]) assert.equal((await call('B', method, path + suffix, {})).status, 404);
  assert.equal((await call('A', 'POST', path, {token: 'bad'})).status, 400);
  const created = await call('A', 'POST', path, {}); assert.equal(created.status, 201);
  const a = created.data; assert.match(a.token, /^A\.[a-f0-9]{64}$/); assert.equal(a.expiresAt, '2026-10-30T12:00:00.000Z'); assert.equal(a.path, '/share/' + a.token);
  const stored = (await repositories.forTenant('A').crmList('deal-share'))[0];
  assert.notEqual(stored.tokenHash, a.token); assert.ok(!JSON.stringify(stored).includes(a.token.split('.')[1]));
  assert.doesNotMatch(JSON.stringify((await call('A', 'GET', path)).data), /tokenHash/);
  const settings = (await call('A', 'GET', '/settings')).data;
  assert.equal(settings.shareExpiryDays, 7);
  for (const shareExpiryDays of [0, 91, 1.5]) assert.equal((await call('A', 'PUT', '/settings', {...settings, shareExpiryDays})).status, 400);
  assert.equal((await call('A', 'PUT', '/settings', {...settings, shareExpiryDays: 3})).status, 200);
  setClock(new Date(now.getTime() + 1000));
  const b = (await call('A', 'POST', path, {})).data;
  assert.equal(b.expiresAt, '2026-10-26T12:00:01.000Z'); assert.equal((await pub(a.token)).status, 404); assert.equal((await pub(b.token)).status, 200);
  assert.equal((await call('A', 'GET', path)).data.share.id, b.shareId);
  assert.equal((await call('A', 'POST', path + '/revoke', {})).status, 200);
  assert.equal((await call('A', 'POST', path + '/revoke', {})).status, 404);
  const events = repositories.eventsForTest('A').filter(e => e.type.startsWith('deal-share.'));
  assert.equal(events.filter(e => e.type === 'deal-share.created').length, 2); assert.equal(events.filter(e => e.type === 'deal-share.updated').length, 2);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort());
});
test('retail explicit buyer allowlist and exact working finance pencil, cash and lease numbers', async () => {
  const {call, createDeal, pub} = await setup();
  await call('A', 'PUT', '/settings', {version: 0, taxRateBps: 625, taxTradeDifference: true, docFee: 10000});
  const accepted = (await call('A', 'POST', '/fi-products', {...product, cost: 91234})).data;
  const declined = (await call('A', 'POST', '/fi-products', {...product, name: 'Declined GAP'})).data;
  let d = await createDeal();
  const trade = {year: '2010', make: 'Test', model: 'Trade', vin: '', allowance: 200000, payoff: 250000, actualCashValue: 156789};
  d = (await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, trade, pencils: [{...d.pencils[0], down: 100000, aprBps: 600, fiSelections: [{productId: accepted.id, status: 'accepted'}, {productId: declined.id, status: 'declined'}]}]})).data;
  const token = (await call('A', 'POST', `/deals/${d.id}/share`, {})).data.token;
  const v = (await pub(token)).data, m = pencilMath(d.pencils[0], trade, d, d.vehicle, d.type);
  assert.equal(v.price, 1000000); assert.equal(v.docFee, 10000); assert.equal(v.salesTax, 50000); assert.equal(v.fiRetailTotal, 150000); assert.equal(v.amountFinanced, 1160000); assert.equal(v.amountFinanced, m.amountFinanced); assert.equal(v.monthlyPayment, m.payment);
  assert.deepEqual(v.fiProducts, [{name: product.name, retailPrice: 150000, termNotes: '36 months'}]);
  // termNotes is the explicitly required buyer-facing coverage field; internal notes are forbidden.
  const serialized = JSON.stringify(v).replaceAll('termNotes', 'coverage');
  assert.doesNotMatch(serialized, /cost|gross|actualCashValue|overallowance|notes|tokenHash|INTERNAL PRIVATE|Declined GAP/i);
  const numbers = (x: unknown): number[] => typeof x === 'number' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(numbers) : [];
  for (const secret of [712345, 91234, 156789]) assert.ok(!numbers(v).includes(secret));
  assert.deepEqual(Object.keys(v).sort(), ['buyersOrderSignature', 'documentsAwaitingSignature', 'dealershipName', 'customerName', 'dealType', 'vehicle', 'price', 'docFee', 'salesTax', 'fiProducts', 'fiRetailTotal', 'trade', 'down', 'amountFinanced', 'monthlyPayment', 'totalPayments', 'financeCharge', 'cashDue', 'aprBps', 'termMonths', 'paymentOptions', 'expiresAt'].sort());
  assert.equal(v.paymentOptions.length, 9);
  for (const type of ['cash', 'lease']) {
    const deal = await createDeal('B', type), t = (await call('B', 'POST', `/deals/${deal.id}/share`, {})).data.token;
    const view = (await pub(t)).data; assert.equal(view.paymentOptions.length, 1); assert.equal(view.paymentOptions[0].id, type);
    if (type === 'cash') { assert.equal(view.paymentOptions[0].amountDue, view.cashDue); assert.equal(view.cashDue, 1000000); }
    else { const lease = leaseMath(deal.pencils[0], null, deal, deal.vehicle); assert.equal(view.monthlyPayment, lease.monthlyPayment); assert.equal(view.paymentOptions[0].amountDue, lease.driveOff); assert.equal(view.amountFinanced, lease.adjustedCapCost); assert.equal(view.financeCharge, lease.totalRentCharge); }
  }
});
test('retail isolation and identical unavailable responses for invalid, revoked, expired and closed links', async () => {
  const {call, createDeal, pub, setClock} = await setup();
  const a = await createDeal(), b = await createDeal();
  await call('A', 'PUT', `/customers/${b.customerId}`, {version: b.customer.version, name: 'OTHER BUYER', phone: '', email: '', address: '', notes: '', consent: b.customer.consent});
  const token = (await call('A', 'POST', `/deals/${a.id}/share`, {})).data.token;
  const view = (await pub(token)).data; assert.equal(view.customerName, a.customer.name); assert.equal(view.vehicle.vin, a.vehicle.vin); assert.equal(view.vehicle.stockNumber, a.vehicle.stockNumber); assert.notEqual(view.vehicle.stockNumber, b.vehicle.stockNumber); assert.notEqual(view.customerName, b.customer.name); assert.doesNotMatch(JSON.stringify(view), /OTHER BUYER/);
  const unavailable = {status: 404, error: {code: 'SHARE_UNAVAILABLE', message: 'This link is no longer available.'}};
  for (const t of ['bad', 'A.bad', `B.${token.split('.')[1]}`, token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')]) assert.deepEqual(await pub(t), unavailable);
  assert.equal((await pub(token, '/unknown')).status, 404); assert.equal((await pub(token, '', {}, 'PUT')).status, 405); assert.equal((await pub(token, '/respond')).status, 405);
  await call('A', 'POST', `/deals/${a.id}/share/revoke`, {});
  for (const [suffix, body] of [['', undefined], ['/respond', {message: 'hello'}], ['/documents', {name: 'ID', type: 'id', content: 'aGk='}]] as const) assert.deepEqual(await pub(token, suffix, body), unavailable);
  const expiring = (await call('A', 'POST', `/deals/${a.id}/share`, {})).data.token;
  setClock(new Date('2026-10-30T12:00:00Z')); assert.deepEqual(await pub(expiring), unavailable);
  setClock(now);
  let updated = (await call('A', 'PUT', `/deals/${a.id}`, {version: a.version, status: 'approved'})).data;
  updated = (await call('A', 'PUT', `/deals/${a.id}`, {version: updated.version, status: 'sold'})).data;
  assert.equal(updated.status, 'sold'); assert.deepEqual(await pub(expiring), unavailable);
  assert.equal((await call('A', 'POST', `/deals/${a.id}/share`, {})).status, 400);
  await call('A', 'PUT', `/deals/${b.id}`, {version: b.version, status: 'dead'});
  assert.equal((await call('A', 'POST', `/deals/${b.id}/share`, {})).status, 400);
});
test('retail buyer responses snapshot server options and emit metadata-only immutable events', async () => {
  const {call, createDeal, pub, repositories} = await setup();
  const d = await createDeal(), path = `/deals/${d.id}/share`, token = (await call('A', 'POST', path, {})).data.token;
  const option = (await pub(token)).data.paymentOptions[4];
  assert.equal((await pub(token, '/respond', {optionId: option.id})).status, 201);
  const message = '<script>change my payment</script>';
  assert.equal((await pub(token, '/respond', {message})).status, 201);
  for (const body of [{}, {optionId: option.id, message}, {optionId: 'bad'}, {optionId: option.id, monthlyPayment: 1}, {message: ''}, {message: 'x'.repeat(1001)}]) assert.equal((await pub(token, '/respond', body)).status, 400);
  const responses: ShareResponse[] = (await call('A', 'GET', path)).data.responses;
  assert.equal(responses.length, 2);
  const r = responses.find(r => r.responseKind === 'payment-choice')!;
  for (const key of ['termMonths', 'down', 'monthlyPayment', 'amountDue'] as const) assert.equal(r[key], option[key]);
  assert.equal(responses.find(r => r.responseKind === 'change-request')!.message, message);
  const events = repositories.eventsForTest('A').filter(e => e.type === 'share-response.created'); assert.equal(events.length, 2);
  for (const event of events) { assert.equal(event.actorId, 'customer'); assert.doesNotMatch(JSON.stringify(event), /message|monthlyPayment|change my payment/); assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort()); }
  await assert.rejects(repositories.forTenant('A').crmWrite([{record: {...r, version: 2}, expectedVersion: 1, event: {...events[0], aggregateId: r.id, aggregateVersion: 2}}]), /immutable/);
});
test('retail uploads use canonical base64, appear in jacket checklist, and enforce storage boundaries', async () => {
  const {call, createDeal, pub, repositories, storage} = await setup();
  const d = await createDeal(), token = (await call('A', 'POST', `/deals/${d.id}/share`, {})).data.token;
  const body = {name: 'Buyer ID', type: 'id', content: 'aGk='};
  assert.deepEqual(await pub(token, '/documents', body), {status: 201, data: {name: 'Buyer ID', type: 'id', size: 2}});
  for (const fields of [{content: 'aGk'}, {content: 'aGl='}, {content: ''}, {content: Buffer.alloc(maxDocumentBytes + 1).toString('base64')}, {type: 'bad'}, {name: 'x'.repeat(161)}, {extra: true}]) assert.equal((await pub(token, '/documents', {...body, ...fields})).status, 400);
  await call('A', 'PUT', `/deals/${d.id}`, {version: d.version, status: 'approved'});
  const jacket = (await call('A', 'GET', `/deals/${d.id}/jacket`)).data, doc = jacket.documents[0];
  assert.equal(doc.customerUploaded, true); assert.equal(doc.uploadedBy, 'customer'); assert.equal(jacket.checklist.find((c: {key: string}) => c.key === 'id').present, true);
  assert.equal((await call('A', 'GET', `/deals/${d.id}/documents/${doc.id}/content`)).data.content, body.content);
  assert.equal(await storage.forTenant('B').get(doc.id), undefined);
  const event = repositories.eventsForTest('A').find(e => e.type === 'document.created')!; assert.equal(event.actorId, 'customer');
  const noStorage = createHandler(repositories, {decode: async () => { throw Error('Offline'); }}, () => now);
  assert.equal((await noStorage({method: 'POST', path: `/share/${token}/documents`, body: JSON.stringify(body)})).statusCode, 503);
});
test('retail upload removes stored bytes if the metadata transaction fails', async () => {
  const {call, createDeal, repositories, storage} = await setup();
  const d = await createDeal(), token = (await call('A', 'POST', `/deals/${d.id}/share`, {})).data.token;
  let savedId = '', removedId = '';
  const repo = repositories.forTenant('A');
  await assert.rejects(publicShare({method: 'POST', path: `/share/${token}/documents`, body: JSON.stringify({name: 'ID', type: 'id', content: 'aGk='})}, {
    forTenant: tenant => { assert.equal(tenant, 'A'); return {...repo, crmWrite: async () => { throw new Error('Transaction failed'); }}; }
  }, now, {forTenant: tenant => {
    const scoped = storage.forTenant(tenant);
    return {...scoped, put: async (id, bytes) => { savedId = id; await scoped.put(id, bytes); }, remove: async id => { removedId = id; await scoped.remove(id); }};
  }}), /Transaction failed/);
  assert.ok(savedId); assert.equal(removedId, savedId); assert.equal(await storage.forTenant('A').get(savedId), undefined); assert.deepEqual(await repo.crmList('document'), []);
});
