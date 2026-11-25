import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { migrationEntities, type MigrationImport, type MigrationPreview } from '@freedms/shared';
import { LocalTokens } from '../src/auth.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { createHandler } from '../src/handler.js';
import { MemoryRepositories } from '../src/memory.js';
import type { MigrationCommit } from '../src/repository.js';
import { bodyLimit } from '../src/quick-entry.js';

const now = new Date('2026-11-25T12:00:00.000Z');
const fixtures = {
  inventory: {csv: 'year,make,model,vin,stock #,cost,price,date stocked,old location\n2020,Ford,Fusion, 1hgcm82633a004352 ,S1,"$10,000.25",12000,11/5/2026,Main\n2020,Ford,Fusion,bad,S2,100,120,02/30/2026,Main', expected: {count: 2, amountCents: 1_010_025}},
  customers: {csv: 'customer id,first name,last name,email,mobile\nC100, Ada ,Buyer,ADA@EXAMPLE.TEST,"+1 (555) 123-4567"', expected: {count: 1}},
  leads: {csv: 'lead id,customer id,stock #,status,lead source\nL100,C100,s1,Contacted,Phone', expected: {count: 1}},
  deals: {csv: 'deal id,customer id,VIN,lead id,status,deal amount\nD100,C100,1HGCM82633A004352,L100,Approved,"$11,750.25"', expected: {count: 1, amountCents: 1_175_025}}
};

async function setup() {
  const repositories = new MemoryRepositories();
  const tokens = new LocalTokens('migration-tests-static-secret-32-chars', () => now.getTime());
  for (const tenantId of ['A', 'B']) {
    await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: 'owner', name: 'Owner'},
      {tenantId, userId: 'owner', role: 'admin', active: true},
      {id: 'provision', tenantId, actorId: 'owner', aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  }
  const handler = createHandler(repositories, {decode: async () => { assert.fail('Unexpected VIN decode'); }}, () => now);
  const call = async <T = unknown>(path: string, body?: unknown, tenant = 'A', agent = false) => {
    const result = await handler({method: body === undefined ? 'GET' : 'POST', path: '/migration' + path,
      claims: tokens.verify(tokens.issue('owner', tenant)), agent, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const parsed = JSON.parse(result.body);
    return {status: result.statusCode, data: parsed.data as T, error: parsed.error};
  };
  return {repositories, call};
}

test('migration maps, previews and commits four tenant-scoped entities with an audit trail and reconciliation', async () => {
  const {repositories, call} = await setup();
  const a = repositories.forTenant('A'), b = repositories.forTenant('B');
  for (const entity of migrationEntities) {
    const path = `/${entity}/import`;
    let payload: typeof fixtures[typeof entity] & {mapping?: (string | null)[]} = fixtures[entity];
    const before = await a.events();
    let preview = await call<MigrationPreview>(path + '/preview', payload);
    assert.equal(preview.status, 200, JSON.stringify(preview.error));
    if (entity === 'inventory') {
      assert.deepEqual(preview.data.columns.at(-1), {header: 'old location', field: null, issue: 'Unmapped'});
      payload = {...payload, mapping: preview.data.columns.map(column => column.field ?? 'location')};
      preview = await call<MigrationPreview>(path + '/preview', payload);
      assert.equal(preview.data.rows[0].values.location, 'Main');
      assert.deepEqual(preview.data.actual, {count: 1, amountCents: 1_000_025});
      assert.deepEqual(preview.data.rows.map(row => row.status), ['ready', 'skipped']);
      assert.ok(preview.data.rows[1].reasons.some(reason => reason.includes('valid date')));
      assert.deepEqual(preview.data.rows[0].changes.filter(change => ['vin', 'dateStocked', 'cost'].includes(change.field))
        .map(change => change.after).sort(), ['1000025', '1HGCM82633A004352', '2026-11-05']);
    }
    if (entity === 'customers') {
      assert.equal(preview.data.rows[0].values.name, 'Ada Buyer');
      assert.equal(preview.data.rows[0].values.phone, '5551234567');
    }
    assert.deepEqual(await a.events(), before);
    const approval = preview.data.approval;
    assert.equal((await call(path, {...payload, approval}, 'B')).status, 409);
    assert.equal((await call(path, {...payload, approval, expected: {...payload.expected, count: 90}})).status, 409);
    const committed = await call<MigrationImport>(path, {...payload, approval});
    assert.equal(committed.status, 201, JSON.stringify(committed.error));
    assert.deepEqual(committed.data.actual, preview.data.actual);
    assert.deepEqual(committed.data.expected, payload.expected);
    assert.equal((await call(path, {...payload, approval})).status, 200);
    assert.equal((await call(`/imports/${committed.data.id}`)).status, 200);
    assert.equal((await call(`/imports/${committed.data.id}`, undefined, 'B')).status, 404);
    assert.equal((await call(path, {...payload, approval}, 'A', true)).status, 403);
    assert.equal((await a.events()).length, before.length + 2);
    assert.deepEqual((await call('/imports', undefined, 'B')).data, []);
    assert.equal(await b.migrationVersion(), 0);
    const isolatedPreview = await call<MigrationPreview>(path + '/preview', payload, 'B');
    assert.equal(isolatedPreview.data.actual.count, entity === 'leads' || entity === 'deals' ? 0 : 1);
  }
  assert.equal((await a.migrationHistory()).length, 4);
  const [vehicle] = await a.list({});
  const [customer] = await a.crmList('customer');
  const [lead] = await a.crmList('lead');
  const [deal] = await a.crmList('deal');
  assert.equal(deal.customerId, customer.id);
  assert.equal(deal.leadId, lead.id);
  assert.equal(deal.vehicleId, vehicle.id);
  assert.equal(deal.pencils[0].price, 1_175_025);
  assert.equal(deal.status, 'approved');
  assert.deepEqual([await b.list({}), await b.crmList('customer'), await b.crmList('lead'), await b.crmList('deal')], [[], [], [], []]);
  assert.equal(bodyLimit('POST', '/migration/inventory/import/preview'), 1024 * 1024);
});

test('migration requires explicit review of ambiguous mappings and commits a concurrent approval only once', async () => {
  const {call, repositories} = await setup();
  const path = '/customers/import';
  const body = {csv: 'name,email,Email Address\nAda,ada@example.test,other@example.test', expected: {count: 1}};
  const preview = await call<MigrationPreview>(path + '/preview', body);
  assert.deepEqual(preview.data.columns.map(column => column.issue), [undefined, 'Ambiguous', 'Ambiguous']);
  assert.equal((await call(path + '/preview', {...body, mapping: ['name', 'email', 'email']})).status, 400);
  const mapped = {...body, mapping: ['name', 'email', null]};
  const corrected = await call<MigrationPreview>(path + '/preview', mapped);
  assert.equal(corrected.data.rows[0].values.email, 'ada@example.test');
  const results = await Promise.all([call(path, {...mapped, approval: corrected.data.approval}), call(path, {...mapped, approval: corrected.data.approval})]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal((await repositories.forTenant('A').crmList('customer')).length, 1);
});

test('Dynamo migration reads and atomic writes use the tenant partition and reject a foreign report or record', async () => {
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => { commands.push(command); return {}; }};
  const repositories = new DynamoRepositories('test', client as unknown as DynamoDBDocumentClient);
  const repo = repositories.forTenant('A');
  await repo.migrationHistory();
  await repo.migrationVersion();
  await repo.migrationReport('report');
  assert.ok(commands[0] instanceof QueryCommand);
  assert.equal(commands[0].input.ExpressionAttributeValues?.[':pk'], 'TENANT#A');
  for (const command of commands.slice(1)) {
    assert.ok(command instanceof GetCommand);
    assert.equal(command.input.Key?.PK, 'TENANT#A');
  }
  const report: MigrationImport = {id: 'report', tenantId: 'A', actorId: 'owner', createdAt: now.toISOString(),
    entity: 'customers', columns: [], rows: [], expected: {count: 1}, actual: {count: 1}};
  const event = {id: 'import', tenantId: 'A', actorId: 'owner', aggregateId: 'report', aggregateVersion: 1,
    occurredAt: now.toISOString(), deliveryStatus: 'pending' as const, type: 'migration.imported' as const};
  const record = {id: 'customer', tenantId: 'A', kind: 'customer' as const, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    name: 'Ada', email: '', address: '', phone: '', notes: '', consent: {status: 'unknown' as const, timestamp: null, source: ''}};
  const commit: MigrationCommit = {report, event, expectedVersion: 0, writes: [{record, event: {...event, id: 'created', type: 'customer.created', aggregateId: record.id}}]};
  for (const repo of [repositories.forTenant('A'), new MemoryRepositories().forTenant('A')]) {
    await assert.rejects(repo.commitMigration({...commit, report: {...report, tenantId: 'B'}}));
    await assert.rejects(repo.commitMigration({...commit, writes: [{...commit.writes[0], record: {...record, tenantId: 'B'}}]}));
    await assert.rejects(repo.commitMigration({...commit, event: {...event, tenantId: 'B'}}));
  }
  await repo.commitMigration(commit);
  const transaction = commands.at(-1);
  assert.ok(transaction instanceof TransactWriteCommand);
  const items = transaction.input.TransactItems ?? [];
  assert.ok(items.every(item => item.Put?.Item?.PK === 'TENANT#A'));
  assert.deepEqual(items.map(item => item.Put?.Item?.SK),
    ['MIGRATION#EPOCH', 'MIGRATION-REPORT#report', 'MIGRATION-HISTORY#report', 'EVENT#import', 'CUSTOMER#customer', 'EVENT#created', 'LEADLIST#EPOCH']);
});
