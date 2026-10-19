import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NhtsaVinDecoder } from '../src/vin.js';
const vin = '1HGCM82633A004352';
test('vPIC adapter parses a mocked flat result and supplies timeout signal', async () => {
  const decoder = new NhtsaVinDecoder(async (url, init) => {
    assert.equal(String(url), `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`); assert.ok(init?.signal);
    return new Response(JSON.stringify({Results: [{ModelYear: '2003', Make: 'Test make', Model: 'Test model', Trim: '', ErrorCode: '0'}]}));
  });
  assert.deepEqual(await decoder.decode(vin), {vin, year: 2003, make: 'Test make', model: 'Test model', trim: '', warnings: []});
});
test('partial decode is explicit and all upstream failures become actionable errors', async () => {
  const decoder = new NhtsaVinDecoder(async () => new Response(JSON.stringify({Results: [{ModelYear: '', Make: '', Model: '', ErrorCode: '7', ErrorText: 'Incomplete'}]})));
  const result = await decoder.decode(vin); assert.equal(result.year, null); assert.equal(result.warnings.length, 2);
  for (const request of [async () => new Response('', {status: 429}), async () => new Response('{}'), async () => { throw new Error('timeout'); }]) await assert.rejects(new NhtsaVinDecoder(request).decode(vin), /unavailable/);
});
