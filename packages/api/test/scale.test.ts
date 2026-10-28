import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile, summarize, evaluateBudget, budgetMsFor,
  resolveProfile, generateVin, isValidVin,
  vehiclePayload, customerPayload, partPayload,
} from '../../../scripts/scale-lib.js';

test('scale percentile uses nearest-rank and handles edges', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 100), 100);
  assert.equal(percentile([30, 10, 20], 50), 20);
  assert.throws(() => percentile([1], 0), /percentile/);
  assert.throws(() => percentile([1], 101), /percentile/);
});

test('scale summarize reports count, extremes, mean and percentiles', () => {
  assert.deepEqual(summarize([]), { count: 0, min: null, max: null, mean: null, p50: null, p95: null });
  const s = summarize([10, 20, 30, 40]);
  assert.equal(s.count, 4);
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);
  assert.equal(s.mean, 25);
  assert.equal(s.p50, 20);
  assert.equal(s.p95, 40);
});

test('scale budgets: reads and pencil 300ms, reports 1000ms, strict less-than', () => {
  assert.equal(budgetMsFor('read'), 300);
  assert.equal(budgetMsFor('pencil'), 300);
  assert.equal(budgetMsFor('report'), 1000);
  assert.deepEqual(evaluateBudget('read', 299), { budgetMs: 300, p95: 299, pass: true });
  assert.equal(evaluateBudget('read', 300).pass, false);
  assert.equal(evaluateBudget('report', 999).pass, true);
  assert.equal(evaluateBudget('report', 1000).pass, false);
  assert.equal(evaluateBudget('read', null).pass, false);
});

test('scale full profile encodes the issue targets exactly', () => {
  const p = resolveProfile();
  assert.equal(p.heavy.lifetimeVehicles, 10000);
  assert.equal(p.heavy.inStock, 100);
  assert.equal(p.heavy.leads, 150000);
  assert.equal(p.heavy.deals, 8000);
  assert.equal(p.heavy.repairOrders, 50000);
  assert.equal(p.heavy.customers, 30000);
  assert.equal(p.lightTenants, 1000);
  assert.equal(p.light.lifetimeVehicles, 30);
  assert.equal(p.light.leads, 200);
  assert.equal(p.light.repairOrders, 200);
});

test('scale smoke profile is tiny and overrides re-derive the customer pool', () => {
  const p = resolveProfile('smoke');
  assert.equal(p.heavy.lifetimeVehicles, 60);
  assert.equal(p.heavy.leads, 120);
  assert.equal(p.heavy.deals, 15);
  assert.equal(p.heavy.repairOrders, 40);
  assert.equal(p.lightTenants, 3);
  assert.equal(p.light.leads, 25);

  const o = resolveProfile('smoke', { heavyLeads: 1000, lightTenants: 25, heavyRepairOrders: 7 });
  assert.equal(o.heavy.leads, 1000);
  assert.equal(o.heavy.customers, 200);
  assert.equal(o.heavy.repairOrders, 7);
  assert.equal(o.lightTenants, 25);

  const explicit = resolveProfile('smoke', { heavyLeads: 1000, heavyCustomers: 3 });
  assert.equal(explicit.heavy.customers, 3);
});

test('scale profile validation rejects impossible shapes', () => {
  assert.throws(() => resolveProfile('smoke', { heavyInStock: 50 }), /deals/);
  assert.throws(() => resolveProfile('smoke', { heavyLeads: 1 }), /leads/);
  assert.throws(() => resolveProfile('smoke', { heavyCustomers: 0 }), /customers/);
  assert.throws(() => resolveProfile('nope'), /Unknown profile/);
  assert.throws(() => resolveProfile('smoke', { heavyInStock: 999 }), /inStock/);
  assert.throws(() => resolveProfile('smoke', { heavyDeals: 999 }), /deals/);
  assert.throws(() => resolveProfile('smoke', { heavyLeads: -1 }), /non-negative/);
  assert.throws(() => resolveProfile('smoke', { lightTenants: 1.5 }), /non-negative/);
});

test('scale VIN generation is valid and synthetic payloads are fictional', () => {
  for (const serial of [0, 1, 42, 99999, 100000]) assert.ok(isValidVin(generateVin(serial)), generateVin(serial));
  assert.equal(generateVin(1).length, 17);
  assert.equal(isValidVin('1HGCM82633AA00001'), true);
  assert.equal(isValidVin('IHGCM82633AA00001'), false);
  assert.equal(isValidVin('SHORT'), false);
  assert.throws(() => generateVin(-1), /serial/);

  const v = vehiclePayload(3, { status: 'available' });
  assert.ok(isValidVin(v.vin));
  assert.equal(v.status, 'available');
  assert.ok(v.listPrice > v.cost && v.cost > 0);
  assert.match(customerPayload(0).email, /@example\.test$/);
  assert.ok(partPayload(0).costCents < partPayload(0).retailPriceCents);
});
