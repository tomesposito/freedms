import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHOTO_PREP_SKILL } from '@freedms/shared';
import { facebookRow } from '../src/facebook-feed.js';
import { buildPublicInventory } from '../src/public-inventory.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import type { AuthClaims, Customer, OutboxEvent } from '@freedms/shared';
import { createHandler } from '../src/handler.js';
import { AssistantBilling } from '../src/assistant-billing.js';
import { MemoryRepositories } from '../src/memory.js';
import { type AssistantMessage, type AssistantProvider, type PhotoPrepImageEditor, photoPrepImageEditorFromEnv } from '../src/assistant-provider.js';
import { assistantSkillsEndpoint, customerProposals, type Proposal } from '../src/assistant-skills.js';
import { BriaPhotoPrepEditor } from '../src/bria-photo-prep.js';
import { PNG } from 'pngjs';
const date = new Date('2026-11-04T12:00:00Z');
const auth = (tenant = 'A'): AuthClaims => ({sub: `user-${tenant}`, 'custom:tenant_id': tenant, iss: 'test', aud: 'test', exp: 9999999999, token_use: 'id'});
const vehicle = {stockNumber: 'STOCK-104', vin: '1HGCM82633A004352', year: 2003, make: 'Honda', model: 'Accord', trim: '', mileage: null, status: 'in recon', listPrice: 0, cost: 50000, reconCosts: [{description: 'Brakes', amount: 10000}], dateStocked: '2026-01-01', location: '', notes: ''};
const customer = {name: 'JANE DOE', phone: '12125551234', email: '', address: '42  Main   Street', notes: 'Keep notes', consent: {status: 'unknown', timestamp: null, source: ''}};
class Provider implements AssistantProvider {
  configured = true; seen: AssistantMessage[][] = [];
  async converse(messages: AssistantMessage[]): Promise<AssistantMessage> { this.seen.push(structuredClone(messages)); return {role: 'assistant', content: [{text: 'Done'}]}; }
}
async function setup(seed = true, photoPrepImageEditor?: PhotoPrepImageEditor) {
  const repositories = new MemoryRepositories(), provider = new Provider();
  const event = (tenantId: string, id: string, type: OutboxEvent['type'], version = 1): OutboxEvent => ({id: `${id}-${version}`, tenantId, actorId: `user-${tenantId}`, aggregateId: id, aggregateVersion: version, type, occurredAt: date.toISOString(), deliveryStatus: 'pending'});
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: date.toISOString()}, {id: `user-${tenantId}`, name: 'User'}, {tenantId, userId: `user-${tenantId}`, role: 'admin', active: true}, event(tenantId, tenantId, 'tenant.created'));
  const documents = new MemoryDocumentStore();
  const handle = createHandler(repositories, {decode: async () => {throw Error('offline');}}, () => date, documents, undefined, undefined, undefined, {assistantProvider: provider, photoPrepImageEditor, assistantSeedLocalPlan: seed});
  const req = async (path: string, body?: unknown, tenant = 'A', method = body === undefined ? 'GET' : 'POST') => {
    const url = new URL(path, 'http://offline');
    const result = await handle({path: url.pathname, query: Object.fromEntries(url.searchParams), method, claims: auth(tenant), ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    return {status: result.statusCode, ...JSON.parse(result.body)};
  };
  const addCustomer = async (patch = {}, tenant = 'A') => (await req('/customers', {...customer, ...patch}, tenant)).data.customer as Customer;
  const addVehicle = async (patch = {}, tenant = 'A') => (await req('/vehicles', {...vehicle, ...patch}, tenant)).data;
  const addLead = async (vehicleId: string | null = null) => (await req('/leads', {customer, vehicleId, vehicleDescription: 'Interested in Honda', source: 'walk-in', sourceDetail: '', assigneeId: null})).data.lead;
  const repo = repositories.forTenant('A');
  const run = (skill: string, surface: string, id?: string) => req('/assistant/skills/run', {skill, surface, ...(id ? {id} : {})});
  const apply = (skill: string, surface: string, accepted: string[], id?: string) => req('/assistant/skills/apply', {skill, surface, accepted, ...(id ? {id} : {})});
  return {req, repo, repositories, provider, addCustomer, addVehicle, addLead, run, apply, event};
}
test('skill registry surfaces, validation and tenant-bound detail lookup', async () => {
  const s = await setup(), c = await s.addCustomer(), v = await s.addVehicle(), l = await s.addLead();
  const foreign = await s.addVehicle({stockNumber: 'SECRET'}, 'B');
  for (const [surface, id, ids] of [
    ['vehicle', v.id, ['vehicle_summary']], ['contact', c.id, ['contact_summary', 'clean_record']],
    ['lead', l.id, ['lead_summary', 'clean_record']], ['leads', '', ['cleanup_pass']], ['contacts', '', ['cleanup_pass']], ['vehicles', '', []],
  ] as const) {
    const result = await s.req(`/assistant/skills?surface=${surface}${id ? `&id=${id}` : ''}`);
    assert.equal(result.status, 200); assert.deepEqual(result.data.skills.map((s: {id: string}) => s.id), ids);
  }
  // A real deal uses the existing workflow and still has no launch skills.
  const sellable = await s.addVehicle({stockNumber: 'SELL', vin: '1HGCM82633A004353', status: 'available'});
  const deal = await s.req('/deals', {vehicleId: sellable.id, customerId: c.id, type: 'cash'});
  assert.equal(deal.status, 201);
  assert.deepEqual((await s.req(`/assistant/skills?surface=deal&id=${deal.data.id}`)).data.skills, []);
  for (const query of ['surface=unknown', 'surface=vehicle', 'surface=vehicles&id=extra', 'surface=lead&id=bad/id', 'surface=contacts&tenantId=B']) assert.equal((await s.req(`/assistant/skills?${query}`)).status, 400);
  assert.deepEqual((await s.req(`/assistant/skills?surface=vehicle&id=${foreign.id}`)).data, {context: null, skills: []});
  assert.equal((await s.run('vehicle_summary', 'contacts')).status, 400);
});
test('chat names this vehicle, keeps failed context private, and preserves absent-context history', async () => {
  const s = await setup(), v = await s.addVehicle(), foreign = await s.addVehicle({stockNumber: 'SECRET-B'}, 'B');
  const messages = [{role: 'user', text: 'What is blocking this vehicle?'}];
  await s.req('/assistant/chat', {messages, context: {surface: 'vehicle', id: v.id}});
  assert.match(JSON.stringify(s.provider.seen[0]), /Current context: vehicle.*2003 Honda Accord.*STOCK-104/);
  assert.match(JSON.stringify(s.provider.seen[0]), new RegExp(v.id));
  assert.equal((await s.repo.assistantLedger('2026-11-04')).length, 1, 'only answer charged, context lookup is free');
  await s.req('/assistant/chat', {messages, context: {surface: 'vehicle', id: foreign.id}});
  assert.match(JSON.stringify(s.provider.seen[1]), /No context record is available/);
  assert.doesNotMatch(JSON.stringify(s.provider.seen[1]), /SECRET-B|Honda/);
  await s.req('/assistant/chat', {messages});
  assert.deepEqual(s.provider.seen[2], [{role: 'user', content: [{text: messages[0].text}]}]);
  assert.equal((await s.req('/assistant/chat', {messages, context: {surface: 'vehicles', id: v.id}})).status, 400);
});
test('vehicle summary costs exactly its chip price and records skill usage by user', async () => {
  const s = await setup(), v = await s.addVehicle();
  const listing = await s.req(`/assistant/skills?surface=vehicle&id=${v.id}`);
  const result = await s.run('vehicle_summary', 'vehicle', v.id);
  assert.equal(result.status, 200); assert.equal(result.data.creditsUsed, 3); assert.equal(listing.data.skills[0].costCredits, result.data.creditsUsed);
  assert.deepEqual(result.data.transcript, ['get_vehicle', 'list_deals', 'get_feed_config'].map(tool => ({tool, ok: true})));
  for (const text of ['Cost: $500.00', 'Brakes: $100.00', 'Recon total: $100.00', 'Cost + recon: $600.00', 'Aging:', '2026-01-01', 'schedule: manual', 'Deal history: 0', 'in recon', 'not listed', 'aged', 'no price']) assert.ok(result.data.reply.includes(text), text);
  assert.deepEqual((await s.repo.assistantLedger('2026-11-04')).map(r => r.action), ['get_vehicle', 'list_deals', 'get_feed_config'].map(t => `skill:vehicle_summary:${t}`));
  const usage = (await s.req('/assistant/usage')).data.byUser[0];
  assert.equal(usage.userId, 'user-A'); assert.deepEqual(usage.skills.vehicle_summary, {actions: 3, credits: 3});
  const fresh = await s.addVehicle({stockNumber: 'FRESH', vin: '1HGCM82633A004353', status: 'available', listPrice: 100000, dateStocked: '2026-11-04'});
  const clear = await s.run('vehicle_summary', 'vehicle', fresh.id);
  assert.match(clear.data.reply, /No sale blockers found/); assert.match(clear.data.reply, /Feed: listed/);
});
test('clean record reads only; applying changes exactly accepted fields once with agent audit', async () => {
  const s = await setup(), c = await s.addCustomer(), v = await s.addVehicle();
  await s.req('/assistant/pool');
  const events = await s.repo.events(), savedVehicle = await s.repo.get(v.id);
  const run = await s.run('clean_record', 'contact', c.id), proposals: Proposal[] = run.data.proposals;
  assert.equal(run.data.creditsUsed, 1); assert.deepEqual(run.data.transcript, [{tool: 'get_customer', ok: true}]);
  assert.deepEqual(await s.repo.crmGet('customer', c.id), c); assert.deepEqual(await s.repo.get(v.id), savedVehicle);
  assert.deepEqual(await s.repo.events(), events);
  for (const [field, proposed] of [['name', 'Jane Doe'], ['phone', '(212) 555-1234'], ['address', '42 Main Street']]) assert.ok(proposals.some(p => p.kind === 'fix' && p.field === field && p.proposed === proposed));
  const phone = proposals.find(p => p.kind === 'fix' && p.field === 'phone')!;
  const result = await s.apply('clean_record', 'contact', [phone.proposalId], c.id);
  assert.equal(result.status, 200); assert.equal(result.data.creditsUsed, 3); assert.deepEqual(result.data.applied, [phone.proposalId]);
  const after = (await s.repo.crmGet('customer', c.id))!;
  assert.equal(after.phone, '(212) 555-1234'); assert.equal(after.name, c.name); assert.equal(after.address, c.address); assert.equal(after.notes, c.notes); assert.equal(after.email, c.email); assert.deepEqual(after.consent, c.consent); assert.equal(after.version, c.version + 1);
  const writes = (await s.repo.events()).filter(e => e.aggregateId === c.id && e.aggregateVersion === 2);
  assert.equal(writes.length, 1); assert.equal(writes[0].actorId, 'user-A'); assert.equal(writes[0].actorType, 'agent');
  const missing = proposals.find(p => p.kind === 'missing')!;
  for (const ids of [[missing.proposalId], ['unknown'], [phone.proposalId]]) assert.equal((await s.apply('clean_record', 'contact', ids, c.id)).status, 400);
  assert.deepEqual(await s.repo.crmGet('customer', c.id), after);
});
test('proposal normalization handles leading US digit, casing, whitespace, email and missing fields', () => {
  const proposals = customerProposals({...customer, id: 'customer', name: 'john smith', email: ' USER@EXAMPLE.TEST ', address: ' \t42   Main\nSt ', phone: '+1 (212) 555-1234'} as Customer);
  for (const [field, proposed] of [['name', 'John Smith'], ['phone', '(212) 555-1234'], ['email', 'user@example.test'], ['address', '42 Main St']]) assert.ok(proposals.some(p => p.kind === 'fix' && p.field === field && p.proposed === proposed));
  const empty = customerProposals({...customer, id: 'empty', phone: '', email: '', address: ''} as Customer);
  assert.equal(empty.filter(p => p.kind === 'missing').length, 3);
});
test('cleanup pass finds duplicates and stale leads, excludes other tenants and rejects merges before writes', async () => {
  const s = await setup(), a = await s.addCustomer({email: 'same@example.test'}), b = await s.addCustomer({name: 'OTHER PERSON', phone: '(212) 555-1234', email: 'same@example.test'});
  const foreign = await s.addCustomer({name: 'SECRET PERSON', email: 'same@example.test'}, 'B');
  const l = await s.addLead(); const old = (await s.repo.crmGet('lead', l.id))!;
  await s.repo.crmWrite([{record: {...old, updatedAt: '2026-09-01', version: old.version + 1}, expectedVersion: old.version, event: s.event('A', l.id, 'lead.updated', old.version + 1)}]);
  await s.req('/assistant/pool'); const before = await s.repo.events();
  const result = await s.run('cleanup_pass', 'leads'); const proposals: Proposal[] = result.data.proposals;
  assert.equal(result.data.creditsUsed, 2); assert.deepEqual(await s.repo.events(), before);
  for (const matchOn of ['phone', 'email']) assert.ok(proposals.some(p => p.kind === 'duplicate' && p.matchOn === matchOn && p.customerIds.includes(a.id) && p.customerIds.includes(b.id)));
  assert.ok(proposals.some(p => p.kind === 'stale' && p.leadId === l.id));
  assert.doesNotMatch(JSON.stringify(result), /SECRET PERSON/); assert.ok(!JSON.stringify(result).includes(foreign.id));
  const fix = proposals.find(p => p.kind === 'fix' && p.customerId === a.id && p.field === 'name')!;
  const duplicate = proposals.find(p => p.kind === 'duplicate')!;
  assert.equal((await s.apply('cleanup_pass', 'leads', [fix.proposalId, duplicate.proposalId])).status, 400);
  assert.deepEqual(await s.repo.events(), before); assert.equal((await s.repo.crmGet('customer', a.id))!.name, a.name);
  const applied = await s.apply('cleanup_pass', 'leads', [fix.proposalId]);
  assert.equal(applied.data.creditsUsed, 4); assert.deepEqual(applied.data.applied, [fix.proposalId]);
  assert.equal((await s.repo.crmGet('customer', a.id))!.name, 'Jane Doe'); assert.equal((await s.repo.crmGet('customer', a.id))!.phone, a.phone);
  assert.deepEqual(await s.repositories.forTenant('B').crmGet('customer', foreign.id), foreign);
});
test('lead skills resolve its customer and vehicle with matching conditional prices', async () => {
  const s = await setup(), v = await s.addVehicle();
  for (const vehicleId of [null, v.id]) {
    const lead = await s.addLead(vehicleId);
    const listing = (await s.req(`/assistant/skills?surface=lead&id=${lead.id}`)).data.skills;
    for (const id of ['lead_summary', 'clean_record']) {
      const result = await s.run(id, 'lead', lead.id);
      assert.equal(result.data.creditsUsed, listing.find((x: {id: string}) => x.id === id).costCredits);
      assert.equal(result.data.transcript[0].tool, 'get_lead');
      if (id === 'lead_summary') { assert.match(result.data.reply, /JANE DOE/); assert.match(result.data.reply, vehicleId ? /STOCK-104/ : /Interested in Honda/); }
    }
  }
});
test('no entitlement prevents every skill endpoint from executing tools', async () => {
  for (const path of ['/assistant/skills', '/assistant/skills/run', '/assistant/skills/apply']) {
    let calls = 0;
    await assert.rejects(assistantSkillsEndpoint({method: path.endsWith('/skills') ? 'GET' : 'POST', path, claims: auth(), query: {surface: 'contacts'}, body: JSON.stringify({skill: 'cleanup_pass', surface: 'contacts', accepted: []})},
      {tenantId: 'A', userId: 'user-A', role: 'admin'}, {check: async () => false}, async () => { calls++; throw Error('must not execute'); }, date), {status: 402});
    assert.equal(calls, 0);
  }
  const s = await setup(false);
  assert.equal((await s.req('/assistant/skills?surface=contacts')).status, 402);
  assert.equal((await s.run('cleanup_pass', 'contacts')).status, 402);
  assert.equal((await s.apply('cleanup_pass', 'contacts', [])).status, 402);
});
test('pool and request caps stop scripts; failed cross-tenant actions are free', async () => {
  const s = await setup(), v = await s.addVehicle(), foreign = await s.addVehicle({stockNumber: 'SECRET'}, 'B');
  const failed = await s.run('vehicle_summary', 'vehicle', foreign.id);
  assert.equal(failed.data.creditsUsed, 0); assert.deepEqual(failed.data.transcript, [{tool: 'get_vehicle', ok: false}]); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
  await s.req('/assistant/admin/settings', {perRequestCreditCap: 2}, 'A', 'PUT');
  const capped = await s.run('vehicle_summary', 'vehicle', v.id);
  assert.equal(capped.data.creditsUsed, 2); assert.equal(capped.data.transcript.length, 2); assert.match(capped.data.reply, /credit cap/);
  const cycle = (await s.repo.assistantCycle('2026-11-04'))!;
  await s.repo.saveAssistantCycle({...cycle, allotmentCredits: 3, version: cycle.version + 1}, cycle.version);
  const exhausted = await s.run('vehicle_summary', 'vehicle', v.id);
  assert.equal(exhausted.data.creditsUsed, 1); assert.equal(exhausted.data.transcript.length, 1); assert.match(exhausted.data.reply, /exhausted/);
  assert.equal((await s.run('vehicle_summary', 'vehicle', v.id)).status, 402);
});
test('accepted fixes group into one customer write and stale or foreign selections cannot write', async () => {
  const s = await setup(), c = await s.addCustomer(), foreign = await s.addCustomer({name: 'PRIVATE CUSTOMER'}, 'B');
  const proposals: Proposal[] = (await s.run('clean_record', 'contact', c.id)).data.proposals;
  const selected = proposals.filter(p => p.kind === 'fix' && ['name', 'address'].includes(p.field)).map(p => p.proposalId);
  const applied = await s.apply('clean_record', 'contact', selected, c.id);
  assert.equal(applied.data.creditsUsed, 3); assert.equal(applied.data.transcript.filter((r: {tool: string}) => r.tool === 'update_customer').length, 1);
  const after = (await s.repo.crmGet('customer', c.id))!;
  assert.equal(after.version, 2); assert.equal(after.name, 'Jane Doe'); assert.equal(after.address, '42 Main Street'); assert.equal(after.phone, c.phone);
  assert.equal((await s.run('clean_record', 'contact', foreign.id)).data.creditsUsed, 0);
  assert.deepEqual((await s.apply('clean_record', 'contact', selected, foreign.id)).data.applied, []);
  assert.deepEqual(await s.repositories.forTenant('B').crmGet('customer', foreign.id), foreign);
  assert.deepEqual((await s.req(`/assistant/skills?surface=contact&id=${foreign.id}`)).data, {context: null, skills: []});
});

test('skills refresh the write fence and preserve completed outcomes on settlement failure', async () => {
  for (const mode of ['disabled', 'settlement'] as const) {
    const s = await setup(), c = await s.addCustomer();
    await s.req('/assistant/pool');
    const billing = new AssistantBilling(s.repo, () => date);
    let executions = 0;
    const commit = s.repo.commitAssistantLedger;
    s.repo.commitAssistantLedger = async (entries, cycle, version) => {
      if (mode === 'settlement' && entries[0].actionClass === 'write') throw new Error('offline');
      await commit(entries, cycle, version);
    };
    const proposal = customerProposals(c).find(p => p.kind === 'fix' && p.field === 'phone')!;
    const result = await assistantSkillsEndpoint({method: 'POST', path: '/assistant/skills/apply', claims: auth(),
      body: JSON.stringify({skill: 'clean_record', surface: 'contact', id: c.id, accepted: [proposal.proposalId]})},
      {tenantId: 'A', userId: 'user-A', role: 'admin'}, billing, async request => {
        executions++;
        if (request.method === 'GET') {
          if (mode === 'disabled') await billing.updateSettings({tenantId: 'A', userId: 'user-A', role: 'admin'}, {disabled: true});
          return {statusCode: 200, headers: {}, body: JSON.stringify({data: c})};
        }
        return {statusCode: 200, headers: {}, body: JSON.stringify({data: {...c, version: 2}})};
      }, date);
    const data = JSON.parse(result.body).data;
    assert.equal(data.creditsUsed, 1);
    assert.equal(executions, mode === 'disabled' ? 1 : 2);
    assert.match(data.reply, mode === 'disabled' ? /disabled/ : /DID execute successfully/);
    assert.deepEqual(data.transcript, [{tool: 'get_customer', ok: true}, ...(mode === 'settlement' ? [{tool: 'update_customer', ok: true}] : [])]);
    assert.equal((await s.repo.assistantLedger('2026-11-04')).length, 1);
  }
});

test('photo prep settles successful photos before continuing and leaves a review-only result', async () => {
  const s = await setup();
  const v = await s.addVehicle({photoUrls: ['https://example.test/one.jpg', 'https://example.test/two.jpg', 'https://example.test/three.jpg']});
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const url = `/vehicles/${v.id}`;
  const before = (await s.req('/assistant/pool')).data.balanceCredits;
  const list = await s.req(`/assistant/skills?surface=vehicle&id=${v.id}`);
  assert.equal(list.data.skills.find((skill: {id: string}) => skill.id === PHOTO_PREP_SKILL).costCredits, 9);
  const ledgerRows: number[] = [];
  s.provider.converse = async messages => {
    ledgerRows.push((await s.repo.assistantLedger('2026-11-04')).length);
    const vision = messages[0].content?.some(item => item.image);
    const reply = vision
      ? JSON.stringify({label: 'exterior', coverScore: 85, vin: '1HGCM82633A004353', mileage: 81000, damage: 'Bumper scuff'})
      : '2003 Honda Accord.';
    return {role: 'assistant', content: [{text: reply}]};
  };
  const input = {skill: PHOTO_PREP_SKILL, surface: 'vehicle', id: v.id, version: v.version,
    images: [{index: 0, jpeg}, {index: 1}, {index: 2, jpeg}]};
  const run = (body = input, tenant = 'A') => s.req('/assistant/skills/run', body, tenant);
  assert.equal((await run(input, 'B')).status, 404);
  const pass = await run();
  assert.equal(pass.status, 200);
  assert.equal(pass.data.creditsUsed, 6);
  assert.deepEqual(ledgerRows, [0, 1, 2]);
  assert.deepEqual(pass.data.transcript.slice(0, 3).map((row: {ok: boolean}) => row.ok), [true, false, true]);
  assert.ok(pass.data.prep.suggestions.some((row: {kind: string; matches?: boolean}) => row.kind === 'vin' && row.matches === false));
  assert.deepEqual((await s.req(url)).data, v);
  assert.equal((await s.req('/assistant/pool')).data.balanceCredits, before - 6);

  const approved = {version: v.version, photoPrep: {order: [2, 0, 1], derivatives: [{index: 0, display: jpeg, thumb: jpeg, hero: jpeg, feed: jpeg}],
    mileage: 81000, listingDescription: 'Edited description.', damage: [{index: 2, note: 'Bumper scuff'}]}};
  assert.equal((await s.req(url, approved, 'B', 'PUT')).status, 404);
  const update = await s.req(url, approved, 'A', 'PUT');
  assert.equal(update.status, 200);
  assert.equal(update.data.version, v.version + 1);
  assert.equal(update.data.vin, v.vin);
  assert.equal(update.data.mileage, 81000);
  assert.equal(update.data.listingDescription, 'Edited description.');
  assert.equal(facebookRow(update.data, 'A', 'Demo Dealer', update.data.photoUrls).description, 'Edited description.');
  assert.ok(!JSON.stringify(buildPublicInventory('Demo Dealer', [{...update.data, status: 'available'}])).includes('Edited description.'));
  assert.match(update.data.notes, /Photo 3.*Bumper scuff/);
  assert.equal(update.data.photos[0].url, v.photoUrls[2]);
  assert.equal(update.data.photos.at(-1).derivedFrom, v.photoUrls[0]);
  assert.equal((await s.req(url, approved, 'A', 'PUT')).status, 409);
  assert.equal((await s.repo.events()).filter(e => e.type === 'vehicle.updated').length, 1);
  assert.equal((await s.req('/assistant/pool')).data.balanceCredits, before - 6);
});

test('photo prep uses the shared cap and never calls the provider when disabled', async () => {
  const s = await setup();
  const v = await s.addVehicle({photoUrls: ['https://example.test/photo.jpg']});
  const body = {skill: PHOTO_PREP_SKILL, surface: 'vehicle', id: v.id, version: v.version, images: [], descriptionOnly: true};
  const run = () => s.req('/assistant/skills/run', body);
  await s.req('/assistant/admin/settings', {perRequestCreditCap: 2}, 'A', 'PUT');
  const capped = await run();
  assert.equal(capped.data.creditsUsed, 0);
  assert.match(capped.data.reply, /credit cap/);
  await s.req('/assistant/admin/settings', {disabled: true}, 'A', 'PUT');
  assert.equal((await run()).status, 403);
  assert.equal((await s.req(`/assistant/skills?surface=vehicle&id=${v.id}`)).status, 403);
  assert.equal(s.provider.seen.length, 0);
});

test('background selection shares photo settlement and records successful and failed editor usage', async () => {
  let edits = 0;
  const s = await setup(true, {
    configured: true, source: 'bria',
    async replaceBackground(bytes) {
      edits++;
      if (bytes[3] === 0xe1) throw new Error('Offline editor failure');
      return bytes;
    },
  });
  const photoUrls = ['https://example.test/one.jpg', 'https://example.test/two.jpg'];
  const v = await s.addVehicle({photoUrls});
  const url = '/vehicles/' + v.id;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const otherJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1]).toString('base64');
  s.provider.converse = async messages => ({role: 'assistant', content: [{text: messages[0].content?.some(block => block.image)
    ? JSON.stringify({label: 'exterior', coverScore: 90}) : 'Draft listing.'}]});
  const body = {skill: PHOTO_PREP_SKILL, surface: 'vehicle', id: v.id, version: v.version, images: [{index: 0, jpeg}, {index: 1, jpeg: otherJpeg}]};
  const run = (replaceBackground = false, tenant = 'A') => s.req('/assistant/skills/run', {...body, replaceBackground}, tenant);
  const list = await s.req('/assistant/skills?surface=vehicle&id=' + v.id);
  assert.equal(list.data.skills.find((row: {id: string}) => row.id === PHOTO_PREP_SKILL).backgroundAvailable, true);
  const balance = (await s.req('/assistant/pool')).data.balanceCredits;
  assert.equal((await run()).data.creditsUsed, 6);
  assert.equal((await run(true, 'B')).status, 404);
  assert.equal(edits, 0);
  const pass = await run(true);
  assert.equal(pass.data.creditsUsed, 6);
  assert.equal(edits, 2);
  assert.deepEqual(pass.data.prep.suggestions.filter((row: {kind: string}) => row.kind === 'background'), [{kind: 'background', index: 0, jpeg}]);
  assert.match(pass.data.reply, /No background suggestion for photo 2/);
  assert.deepEqual((await s.req(url)).data, v);
  assert.equal((await s.req('/assistant/pool')).data.balanceCredits, balance - 12);
  const ledger = await s.repo.assistantLedger('2026-11-04');
  for (const outcome of ['success', 'failure']) {
    const row = ledger.find(entry => entry.photoBackgroundUsage?.outcome === outcome);
    assert.equal(row?.credits, 0);
    assert.equal(row?.actionClass, 'usage');
    assert.deepEqual(row.photoBackgroundUsage, {job: 'photo-background', provider: 'bria', outcome, costBasisMills: 32});
  }
  assert.equal(ledger.filter(row => row.actionClass === 'photo').length, 4);
  assert.equal((await s.repositories.forTenant('B').assistantLedger('2026-11-04')).length, 0);

  const media = {index: 0, display: jpeg, thumb: jpeg, hero: jpeg, feed: jpeg};
  const approval = {version: v.version, photoPrep: {derivatives: [{...media, kind: 'background'}, media]}};
  assert.equal((await s.req(url, approval, 'B', 'PUT')).status, 404);
  const applied = await s.req(url, approval, 'A', 'PUT');
  assert.equal(applied.status, 200);
  assert.equal(applied.data.version, v.version + 1);
  assert.deepEqual(applied.data.photos.slice(0, 2).map((row: {url: string}) => row.url), photoUrls);
  assert.equal(applied.data.photos[2].name, 'Background replacement · Photo 1');
  assert.equal(applied.data.photos[2].derivedFrom, photoUrls[0]);
  assert.equal(applied.data.photos[3].derivedFrom, photoUrls[0]);
  assert.equal((await s.req(url, approval, 'A', 'PUT')).status, 409);
  assert.equal((await s.repo.events()).filter(row => row.type === 'vehicle.updated').length, 1);
});

test('unconfigured background editing leaves ordinary photo prep available', async () => {
  const s = await setup(true, photoPrepImageEditorFromEnv({}));
  const v = await s.addVehicle({photoUrls: ['https://example.test/one.jpg']});
  s.provider.converse = async () => ({role: 'assistant', content: [{text: '{"label":"exterior","coverScore":90}'}]});
  const list = await s.req('/assistant/skills?surface=vehicle&id=' + v.id);
  assert.equal(list.data.skills.find((row: {id: string}) => row.id === PHOTO_PREP_SKILL).backgroundAvailable, undefined);
  const pass = await s.req('/assistant/skills/run', {skill: PHOTO_PREP_SKILL, surface: 'vehicle', id: v.id, version: v.version,
    images: [{index: 0, jpeg: '/9j/2Q=='}], replaceBackground: true});
  assert.equal(pass.data.creditsUsed, 3);
  assert.match(pass.data.reply, /Background replacement is unavailable/);
  assert.ok(pass.data.prep.suggestions.some((row: {kind: string}) => row.kind === 'light'));
  assert.ok((await s.repo.assistantLedger('2026-11-04')).every(row => !row.photoBackgroundUsage));
});

test('Bria photo editor submits a background-only job and downloads the completed preview offline', async () => {
  const png = new PNG({width: 8, height: 8, fill: true});
  png.data.fill(255);
  const bytes = PNG.sync.write(png);
  const urls: string[] = [];
  const controller = new AbortController();
  const editor = new BriaPhotoPrepEditor('', async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.signal, controller.signal);
    assert.equal(options?.redirect, 'error');
    if (urls.length === 1) {
      assert.equal(options?.method, 'POST');
      const payload = JSON.parse(String(options.body));
      assert.equal(payload.image, '/9j/2Q==');
      assert.equal(payload.mode, 'fibo2');
      assert.equal(payload.sync, false);
      return Response.json({request_id: 'offline-job'}, {status: 202});
    }
    if (urls.length === 2) return Response.json({status: 'COMPLETED', result: {image_url: 'https://bria-datasets.s3.us-east-1.amazonaws.com/edit.png'}});
    assert.equal(options?.headers, undefined);
    return new Response(new Uint8Array(bytes));
  });
  const jpeg = await editor.replaceBackground(Buffer.from('/9j/2Q==', 'base64'), controller.signal);
  assert.deepEqual([...jpeg.slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual(urls, ['https://engine.prod.bria-api.com/v2/image/edit/replace_background',
    'https://engine.prod.bria-api.com/v2/status/offline-job', 'https://bria-datasets.s3.us-east-1.amazonaws.com/edit.png']);
});
