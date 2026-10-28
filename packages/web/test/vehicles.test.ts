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

test('lead board wires paged envelopes, range controls and filter resets', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../src/crm.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /crmRoute\(parts, \{api, apiEnvelope,/);
  assert.match(source, /params.set\('limit', '100'\); params.set\('offset', String\(boardOffset\)\)/);
  assert.match(source, /ui.apiEnvelope<LeadView\[\]>/);
  assert.ok(source.includes('Showing ${boardOffset + 1}–${boardOffset + leads.length} of ${total} leads'));
  assert.match(source, /id="prev-leads".*boardOffset === 0.*>Prev/);
  assert.match(source, /id="next-leads".*boardOffset \+ leads.length >= total.*>Next/);
  assert.match(source, /boardOffset = Math.max\(0, boardOffset - 100\)/); assert.match(source, /boardOffset \+= 100/);
  assert.match(source, /bind\(ui, 'lead-filters'.*boardOffset = 0; ui.refresh\(\)/);
  assert.match(source, /querySelector\('#clear-leads'\).*boardOffset = 0; ui.refresh\(\)/);
  assert.match(source, /total > 0 && boardOffset >= total/);
  assert.match(source, /\$\{total \? `<p class="muted count">/);
});
