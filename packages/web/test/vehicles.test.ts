import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleView } from '@freedms/shared';
import { fetchAllVehicles } from '../src/vehicles.js';

test('fetchAllVehicles collects every page, preserves filters and stops at a short page', async () => {
  const rows = Array.from({length: 1003}, (_, id) => ({id: String(id)}));
  const offsets: number[] = [];
  const api = async <T>(path: string): Promise<T> => {
    const url = new URL(path, 'http://local');
    assert.equal(url.pathname, '/vehicles'); assert.equal(url.searchParams.get('limit'), '500');
    assert.equal(url.searchParams.get('status'), 'available'); assert.equal(url.searchParams.get('search'), 'a & b');
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return rows.slice(offset, offset + 500) as T;
  };
  assert.deepEqual(await fetchAllVehicles<VehicleView>(api, {status: 'available', search: 'a & b'}), rows);
  assert.deepEqual(offsets, [0, 500, 1000]);
});
test('fetchAllVehicles makes one call for a short first page, including empty inventory', async () => {
  for (const rows of [[], [{id: 'one'}]]) {
    let calls = 0;
    const api = async <T>(path: string): Promise<T> => { calls++; assert.equal(path, '/vehicles?limit=500&offset=0'); return rows as T; };
    assert.deepEqual(await fetchAllVehicles(api), rows); assert.equal(calls, 1);
  }
});
test('fetchAllVehicles checks the next page when the last populated page is full', async () => {
  let calls = 0;
  const rows = Array.from({length: 500}, (_, id) => ({id: String(id)}));
  const api = async <T>(): Promise<T> => (++calls === 1 ? rows : []) as T;
  assert.deepEqual(await fetchAllVehicles(api), rows); assert.equal(calls, 2);
});
