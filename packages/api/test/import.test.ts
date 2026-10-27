import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ImportPreview, ImportResult, InventoryImport, OutboxEvent } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { bodyLimit } from '../src/quick-entry.js';
import { IMPORT_BODY_LIMIT } from '../src/import.js';
const now = new Date('2026-10-22T12:00:00Z');
const headers = ['year', 'make', 'model', 'vin', 'stock #', 'cost', 'price', 'mileage', 'notes', 'trim', 'status', 'date stocked', 'location'];
const base = ['2003', 'Honda', 'Accord', '1HGCM82633A004352', 'S1', '$12,999.00', '15000', '88,000', 'Dealer note', '', '', '', ''];
const row = (changes: Record<number, string> = {}) => base.map((v, i) => changes[i] ?? v);
const csv = (rows = [base], h = headers) => '\uFEFF' + [h, ...rows].map(r => r.map(s => `"${s.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
async function setup(failDecode = false) {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('test-secret-must-be-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: 'user', name: 'Test'}, {tenantId, userId: 'user', role: 'staff', active: true}, {id: 'provision', tenantId, actorId: 'user', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  let calls = 0;
  const handler = createHandler(repositories, {decode: async vin => { calls++; if (failDecode) throw new Error('offline failure'); return {vin, year: 2004, make: 'Decoded', model: 'Model', trim: 'Trim', warnings: []}; }}, () => now);
  const call = async (body: unknown = {csv: csv()}, path = '/vehicles/import/preview', tenant = 'A', method = 'POST') => {
    const response = await handler({method, path, claims: tokens.verify(tokens.issue('user', tenant)), body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.statusCode, ...JSON.parse(response.body)};
  };
  return {repositories, handler, call, calls: () => calls};
}
test('import preview classifies all errors and duplicates without writing; confirm records exactly the valid rows', async () => {
  const {call, repositories} = await setup();
  const initial = await call({csv: csv()}, '/vehicles/import');
  const imported = await repositories.forTenant('A').get(initial.data.importedVehicleIds[0]);
  assert.equal(imported!.notes, 'Dealer note'); assert.equal(imported!.mileage, 88000);
  const repo = repositories.forTenant('A'); const before = await repo.events();
  const mixed = csv([
    row({3: '1HGCM82633A004353', 4: 'S2', 8: 'Quoted "note", with\nnewline'}),
    row({0: 'bad', 3: 'bad', 5: '-1'}),
    row({4: 'unique'}),
    row({3: '1HGCM82633A004354', 4: ' s1 '}),
    row({3: '1HGCM82633A004353', 4: 'S3'}),
    row({3: '1HGCM82633A004355', 4: 's2'}),
  ]);
  const preview = await call({csv: mixed}); assert.equal(preview.status, 200);
  const p: ImportPreview = preview.data;
  assert.deepEqual([p.totalRows, p.validCount, p.errorCount, p.duplicateCount], [6, 1, 1, 4]);
  assert.deepEqual(p.rows.map(r => r.status), ['valid', 'error', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  assert.deepEqual(p.rows[1].errors.map(e => e.field).sort(), ['cost', 'vin', 'year']);
  assert.equal(p.rows[2].duplicate?.field, 'vin'); assert.equal(p.rows[3].duplicate?.field, 'stockNumber');
  assert.match(p.rows[2].duplicate!.reason, /already exists in this workspace/);
  for (const r of p.rows.slice(4)) assert.match(r.duplicate!.reason, /row 1 of this file/);
  assert.deepEqual(await repo.events(), before); assert.equal((await repo.imports()).length, 1); assert.equal((await repo.list({})).length, 1);
  const confirmed = await call({csv: mixed}, '/vehicles/import'); assert.equal(confirmed.status, 201);
  const result: ImportResult = confirmed.data;
  assert.deepEqual([result.importedCount, result.errorCount, result.duplicateCount], [1, 1, 4]);
  assert.deepEqual(result.skipped.map(r => r.rowNumber), [2, 3, 4, 5, 6]);
  assert.ok(result.skipped.every(r => r.errors?.length || r.duplicate?.reason));
  const v = (await repo.get(result.importedVehicleIds[0]))!;
  assert.equal(v.cost, 1299900); assert.equal(v.listPrice, 1500000); assert.equal(v.status, 'available'); assert.equal(v.dateStocked, '2026-10-22');
  assert.equal(v.notes, 'Quoted "note", with\nnewline'); assert.equal(v.mileage, 88000); assert.deepEqual(v.reconCosts, []); assert.equal(v.version, 1);
  assert.deepEqual((await repo.events()).slice(before.length).map(e => e.type), ['vehicle.created', 'vehicle.imported']);
  assert.deepEqual((await repo.imports()).find(r => r.id === result.importId), {id: result.importId, tenantId: 'A', actorId: 'user', createdAt: now.toISOString(), totalRows: 6, importedCount: 1, duplicateCount: 4, errorCount: 1});
  for (const event of await repo.events()) assert.deepEqual(Object.keys(event).sort(), ['id', 'tenantId', 'actorId', 'aggregateId', 'aggregateVersion', 'type', 'occurredAt', 'deliveryStatus'].sort());
});
test('file errors reject preview and confirm before any writes', async () => {
  const {call, repositories} = await setup();
  const bad = ['', 'year,make', headers.join(','), csv().slice(0, -3), csv([base], headers.map(h => h === 'vin' ? 'unknown' : h)), csv(Array.from({length: 1001}, () => base)), csv() + 'extra,fields', csv().replace('"Honda"', '"Honda"junk')];
  for (const path of ['/vehicles/import', '/vehicles/import/preview']) {
    for (const source of bad) { const r = await call({csv: source}, path); assert.equal(r.status, 400, source.slice(0, 70)); assert.equal(r.error.code, 'VALIDATION'); }
    for (const body of [{}, {csv: csv(), enrich: 'yes'}, {csv: csv(), tenantId: 'B'}, {csv: 'x'.repeat(IMPORT_BODY_LIMIT)}]) assert.equal((await call(body, path)).status, 400);
  }
  const repo = repositories.forTenant('A'); assert.equal((await repo.list({})).length, 0); assert.equal((await repo.events()).length, 1); assert.deepEqual(await repo.imports(), []);
});
test('reimport creates a zero-count audit record and tenant history remains isolated', async () => {
  const {call, repositories} = await setup();
  await call({csv: csv()}, '/vehicles/import', 'B');
  assert.equal((await call()).data.validCount, 1);
  const first = await call({csv: csv()}, '/vehicles/import'); assert.equal(first.data.importedCount, 1);
  const second = await call({csv: csv()}, '/vehicles/import'); assert.equal(second.data.importedCount, 0); assert.equal(second.data.duplicateCount, 1);
  assert.equal(second.data.skipped[0].duplicate.field, 'vin'); assert.match(second.data.skipped[0].duplicate.reason, /already exists/);
  const a = await call({}, '/vehicles/imports', 'A', 'GET'), b = await call({}, '/vehicles/imports', 'B', 'GET');
  assert.equal(a.data.length, 2); assert.equal(b.data.length, 1); assert.ok(a.data.every((r: InventoryImport) => r.tenantId === 'A')); assert.equal(b.data[0].tenantId, 'B');
  const record = a.data[0], event = (await repositories.forTenant('A').events()).find(e => e.type === 'vehicle.imported')!;
  await assert.rejects(repositories.forTenant('B').appendImport(record, event), /scope/);
  await assert.rejects(repositories.forTenant('A').appendImport({...record, id: 'new'}, {...event, tenantId: 'B'}), /scope/);
  await assert.rejects(repositories.forTenant('A').appendImport(record, {...event, id: 'new-event', aggregateId: record.id}), /changed|conflict/i);
});
test('VIN enrichment fills only blanks in both endpoints and failures leave normal errors', async () => {
  const {call, calls} = await setup();
  const source = csv([row({0: '', 1: '', 2: '', 9: ''})]);
  assert.equal((await call({csv: source})).data.errorCount, 1); assert.equal(calls(), 0);
  const p = (await call({csv: source, enrich: true})).data; assert.equal(p.validCount, 1); assert.equal(p.rows[0].vehicle.make, 'Decoded'); assert.equal(p.rows[0].vehicle.trim, 'Trim');
  const provided = (await call({csv: csv(), enrich: true})).data.rows[0].vehicle; assert.equal(provided.year, 2003); assert.equal(provided.make, 'Honda'); assert.equal(provided.model, 'Accord');
  assert.equal((await call({csv: source, enrich: true}, '/vehicles/import')).data.importedCount, 1); assert.equal(calls(), 3);
  const failing = await setup(true); const result = await failing.call({csv: source, enrich: true}); assert.equal(result.data.errorCount, 1); assert.deepEqual(result.data.rows[0].errors.map((e: {field: string}) => e.field).sort(), ['make', 'model', 'year']);
});
test('import row boundaries, aliases, dollar formats, and invalid earlier rows', async () => {
  const {call} = await setup();
  const invalid = row({0: '1885', 1: '', 2: 'x'.repeat(121), 4: 'x'.repeat(51), 5: '100000000.01', 6: '1.234', 7: '-1', 8: 'x'.repeat(10001), 9: 'x'.repeat(121), 10: 'wrong', 11: '2026-02-30', 12: 'x'.repeat(201)});
  const p = (await call({csv: csv([invalid, base])})).data;
  assert.equal(p.rows[0].errors.length, 12); assert.equal(p.rows[1].status, 'valid');
  for (const amount of ['12999', '12999.00', '$12,999.00', '12,999.5']) {
    const r = await call({csv: csv([row({5: amount, 10: 'IN RECON', 3: base[3].toLowerCase()})], headers.map(h => h === 'stock #' ? ' STOCK_NUMBER ' : h === 'price' ? 'LIST_PRICE' : h.toUpperCase()))});
    assert.equal(r.data.validCount, 1); assert.equal(r.data.rows[0].vehicle.status, 'in recon'); assert.equal(r.data.rows[0].vehicle.cost, amount.endsWith('.5') ? 1299950 : 1299900);
  }
  const long = await call({csv: csv([row({8: 'x'.repeat(10000)})])}); assert.equal(long.data.rows[0].vehicle.notes.length, 10000);
  const extra = await call({csv: csv([[...base, 'ignored']], [...headers, 'dealer extra']).replace(/\r\n/g, '\n')}); assert.equal(extra.data.validCount, 1);
});
test('import paths enforce authentication, methods, body limits and unknown routes', async () => {
  const {call, handler} = await setup();
  for (const path of ['/vehicles/import', '/vehicles/import/preview', '/vehicles/imports']) {
    assert.equal((await handler({method: 'POST', path})).statusCode, 401);
    assert.equal((await call({}, path, 'A', 'DELETE')).status, 405);
    assert.equal(bodyLimit('POST', path), IMPORT_BODY_LIMIT);
  }
  assert.equal((await call({}, '/vehicles/import/unknown')).status, 404);
  assert.equal((await call({csv: csv([row({8: 'x'.repeat(9000)}) , ...Array.from({length: 8}, (_, i) => row({3: `1HGCM82633A00436${i}`, 4: `S${i + 2}`, 8: 'x'.repeat(9000)}))])})).status, 200);
});
test('Dynamo import records use scoped append-only keys and atomic metadata events', async () => {
  const commands: (QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: QueryCommand | TransactWriteCommand) => { commands.push(command); return {Items: []}; }} as unknown as DynamoDBDocumentClient;
  const repo = new DynamoRepositories('table', client).forTenant('A');
  const record: InventoryImport = {id: 'import', tenantId: 'A', actorId: 'user', createdAt: now.toISOString(), totalRows: 1, importedCount: 1, duplicateCount: 0, errorCount: 0};
  const event: OutboxEvent = {id: 'event', tenantId: 'A', actorId: 'user', aggregateId: 'import', aggregateVersion: 1, type: 'vehicle.imported', occurredAt: now.toISOString(), deliveryStatus: 'pending'};
  await repo.appendImport(record, event); await repo.imports();
  const items = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(items.map(i => i.Put?.Item?.SK), ['IMPORT#import', 'EVENT#event']); assert.ok(items.every(i => i.Put?.Item?.PK === 'TENANT#A' && i.Put.ConditionExpression === 'attribute_not_exists(PK)'));
  assert.deepEqual((commands[1] as QueryCommand).input.ExpressionAttributeValues, {':pk': 'TENANT#A', ':prefix': 'IMPORT#'});
  await assert.rejects(repo.appendImport({...record, tenantId: 'B'}, event), /scope/); await assert.rejects(repo.appendImport(record, {...event, tenantId: 'B'}), /scope/); await assert.rejects(repo.appendImport({...record, id: 'bad#id'}, {...event, aggregateId: 'bad#id'})); assert.equal(commands.length, 2);
});
