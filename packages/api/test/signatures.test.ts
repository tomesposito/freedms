import { bodyLimit } from '../src/quick-entry.js';
import { createHash } from 'node:crypto';
import { DEAL_SIGNATURE_CONSENT, SERVICE_SIGNATURE_CONSENT, repairOrderTotals } from '@freedms/shared';
import { stableStringify } from '../src/signature-targets.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type DealView } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
const vehicle = {cost: 700000, reconCosts: [{description: 'Repair', amount: 50000}]};
const now = new Date('2026-10-19T12:00:00Z');
async function setup(role: 'admin' | 'staff' = 'admin') {
  let time = now;
  const repositories = new MemoryRepositories(); const tokens = new LocalTokens('desking-test-secret-at-least-32-characters', () => time.getTime());
  for (const tenantId of ['A', 'B']) await repositories.forTenant(tenantId).provision({id: tenantId, name: tenantId, createdAt: now.toISOString()}, {id: `user${tenantId}`, name: tenantId}, {tenantId, userId: `user${tenantId}`, role, active: true}, {id: 'provision', tenantId, actorId: `user${tenantId}`, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const store = new MemoryDocumentStore();
  const handler = createHandler(repositories, {decode: async () => { throw new Error('No network'); }}, () => time, store);
  const call = async (tenant: string, method = 'GET', path = '/deals', body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method, path, body: body === undefined ? undefined : JSON.stringify(body), query, claims: tokens.verify(tokens.issue(`user${tenant}`, tenant))});
    return {status: r.statusCode, ...JSON.parse(r.body)};
  };
  const v = (await call('A', 'POST', '/vehicles', {stockNumber: 'test', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Test', trim: '', status: 'available', listPrice: 1000000, ...vehicle, dateStocked: '2026-10-19', location: '', notes: ''})).data;
  const lead = (await call('A', 'POST', '/leads', {customer: {name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}}, source: 'walk-in', vehicleId: v.id})).data.lead;
  const create = async (overrides = {}) => { const r = await call('A', 'POST', '/deals', {vehicleId: v.id, customerId: lead.customerId, leadId: lead.id, type: 'finance', ...overrides}); assert.equal(r.status, 201); return r.data as DealView; };
  return {call, create, v, lead, repositories, handler, store, setNow: (value: Date) => { time = value; }};
}
const upload = {name: 'license.bin', type: 'id', content: Buffer.from([0, 255, 1, 128, 10]).toString('base64')};
const typed = {signerName:'Test signer',method:'typed',signatureData:'Test signer'};
async function approved() {
  const context = await setup(); let d = await context.create();
  d = (await context.call('A','PUT',`/deals/${d.id}`,{version:d.version,status:'approved'})).data;
  const base = `/deals/${d.id}`;
  const doc = (await context.call('A','POST',base+'/documents',upload)).data;
  return {...context,d,base,doc,sign:base+'/buyers-order/signatures',docBase:base+'/documents/'+doc.id};
}
test('signature packet: unsigned status, audited capture, duplicate conflict and pencil invalidation',async () => {
  const {call,base,sign,d,repositories} = await approved();
  const before = (await call('A','GET',base+'/jacket')).data;
  assert.equal(before.buyersOrderSignature.status,'awaiting'); assert.equal(before.documents[0].signatureStatus,'awaiting');
  assert.equal((await call('A','GET','/documents')).data[0].signatureStatus,'awaiting');
  const result = await call('A','POST',sign,typed); assert.equal(result.status,201);
  const s = result.data;
  assert.equal(s.signerName,typed.signerName); assert.equal(s.signedAt,now.toISOString()); assert.equal(s.capturedBy,'userA'); assert.equal(s.consentText,DEAL_SIGNATURE_CONSENT); assert.equal(s.targetHash,before.buyersOrderSignature.hash); assert.equal(s.targetVersion,d.version);
  const j=(await call('A','GET',base+'/jacket')).data;
  assert.equal(j.buyersOrderSignature.status,'signed'); assert.equal(j.checklist[0].signatureStatus,'signed');
  assert.ok(repositories.eventsForTest('A').some(e=>e.type==='signature.created' && e.actorId==='userA' && e.tenantId==='A' && e.aggregateId===s.id && e.deliveryStatus==='pending'));
  assert.equal((await call('A','POST',sign,typed)).status,409);
  assert.equal((await call('A','PUT',base,{version:d.version,pencils:d.pencils.map(p=>({...p,price:p.price+100}))})).status,200);
  const changed=(await call('A','GET',base+'/jacket')).data;
  assert.equal(changed.buyersOrderSignature.status,'superseded'); assert.equal(changed.signatures[0].id,s.id);
});
test('document signatures hash exact bytes; replacement preserves history and requires re-signing',async () => {
  const {call,base,docBase,doc} = await approved();
  const s=(await call('A','POST',docBase+'/signatures',typed)).data;
  assert.equal(s.targetHash,createHash('sha256').update(Buffer.from(upload.content,'base64')).digest('hex'));
  assert.equal((await call('A','GET',base+'/jacket')).data.documents[0].signatureStatus,'signed');
  assert.equal((await call('A','GET','/documents')).data[0].signatureStatus,'signed');
  assert.equal((await call('A','POST',docBase+'/signatures',typed)).status,409);
  const content=Buffer.from('replacement').toString('base64');
  const replaced=await call('A','POST',docBase+'/replace',{version:doc.version,content});
  assert.equal(replaced.status,200); assert.equal(replaced.data.version,2); assert.equal(replaced.data.signatureStatus,'superseded');
  assert.equal(replaced.data.uploadedAt,doc.uploadedAt); assert.equal(replaced.data.uploadedBy,doc.uploadedBy);
  assert.equal((await call('A','GET',docBase+'/content')).data.content,content);
  assert.equal((await call('A','POST',docBase+'/replace',{version:doc.version,content})).status,409);
  assert.equal((await call('A','GET',base+'/jacket')).data.documents[0].signatureStatus,'superseded');
  assert.equal((await call('A','GET','/documents')).data[0].signatureStatus,'superseded');
  assert.equal((await call('A','POST',docBase+'/signatures',typed)).status,201);
  const j=(await call('A','GET',base+'/jacket')).data;
  assert.equal(j.documents[0].signatureStatus,'signed'); assert.equal(j.signatures.length,2); assert.ok(j.signatures.some((r:{id:string})=>r.id===s.id));
  // Even identical replacement bytes require a signature for the new version.
  assert.equal((await call('A','POST',docBase+'/replace',{version:2,content})).data.signatureStatus,'superseded');
});
const lines = [{id:'labor',kind:'labor',description:'Repair',laborHoursHundredths:150,laborRateCents:10000,quantity:null,unitPriceCents:null}];
test('repair order authorization snapshots estimate and becomes superseded after work changes',async () => {
  const {call,lead}=await setup();
  const ro=(await call('A','POST','/service/repair-orders',{customerId:lead.customerId,payType:'customer-pay',concern:'Repair noise',lineItems:lines})).data;
  const path='/service/repair-orders/'+ro.id;
  assert.equal((await call('A','GET',path)).data.signatureStatus,'awaiting');
  const result=await call('A','POST',path+'/signatures',typed); assert.equal(result.status,201);
  assert.equal(result.data.estimateCents,repairOrderTotals(ro.lineItems).totalCents); assert.equal(result.data.consentText,SERVICE_SIGNATURE_CONSENT);
  const signed=(await call('A','GET',path)).data; assert.equal(signed.signatureStatus,'signed'); assert.equal(signed.signatures.length,1);
  assert.equal((await call('A','GET','/service/repair-orders')).data[0].signatureStatus,'signed');
  assert.equal((await call('A','GET','/service/board',undefined,{date:'2026-10-19'})).data.repairOrders[0].signatureStatus,'signed');
  assert.equal((await call('A','POST',path+'/signatures',typed)).status,409);
  assert.equal((await call('A','PUT',path,{version:ro.version,lineItems:[{...lines[0],laborHoursHundredths:200}]})).status,200);
  const changed=(await call('A','GET',path)).data; assert.equal(changed.signatureStatus,'superseded'); assert.equal(changed.signatures.length,1);
});
test('signature endpoints and enriched reads isolate tenants and mismatched deals',async () => {
  const {call,create,base,docBase,sign,lead,repositories}=await approved();
  const ro=(await call('A','POST','/service/repair-orders',{customerId:lead.customerId,payType:'customer-pay',lineItems:lines})).data;
  for (const path of [sign,docBase+'/signatures','/service/repair-orders/'+ro.id+'/signatures']) {
    assert.equal((await call('A','POST',path,typed)).status,201);
    assert.equal((await call('B','POST',path,typed)).status,404);
  }
  assert.equal((await call('B','POST',docBase+'/replace',{version:1,content:upload.content})).status,404);
  for (const path of [base+'/jacket','/service/repair-orders/'+ro.id]) assert.equal((await call('B','GET',path)).status,404);
  for (const path of ['/documents','/service/repair-orders']) assert.deepEqual((await call('B','GET',path)).data,[]);
  assert.deepEqual(await repositories.forTenant('B').crmList('signature'),[]);
  const other=await create(); assert.equal((await call('A','POST',docBase.replace(base,'/deals/'+other.id)+'/signatures',typed)).status,404);
});
test('capture validation rejects invalid inputs, working deals, disposed and pending documents',async () => {
  const {call,create,sign,docBase,doc,handler,repositories}=await approved();
  for (const changes of [{signerName:undefined},{signerName:' '},{signerName:'x'.repeat(161)},{method:'other'},{method:'drawn',signatureData:'abc'},{method:'drawn',signatureData:'data:image/png;base64,YR=='},{method:'drawn',signatureData:'data:image/png;base64,'+'A'.repeat(131072)},{signatureData:' '},{signatureData:'x'.repeat(161)},{consentText:'forged'}]) {
    assert.equal((await call('A','POST',sign,{...typed,...changes})).status,400);
  }
  assert.equal((await handler({method:'POST',path:sign,body:JSON.stringify(typed)})).statusCode,401);
  const working=await create(); assert.equal((await call('A','POST',`/deals/${working.id}/buyers-order/signatures`,typed)).status,400);
  assert.equal((await call('A','POST',docBase+'/signatures',{...typed,method:'drawn',signatureData:'data:image/png;base64,iVBORw0KGgo='})).status,201);
  assert.equal((await call('A','POST','/documents/'+doc.id+'/dispose',{version:1,confirm:true})).status,200);
  assert.equal((await call('A','POST',docBase+'/signatures',typed)).status,400);
  assert.equal((await call('A','POST',docBase+'/replace',{version:3,content:upload.content})).status,400);
  assert.equal((await repositories.forTenant('A').crmList('signature')).length,1);
});
test('buyer view only exposes signature statuses and counts',async () => {
  const {call,base,sign,docBase,handler}=await approved();
  const share=(await call('A','POST',base+'/share',{})).data;
  const view=async () => JSON.parse((await handler({method:'GET',path:'/share/'+share.token})).body).data;
  const before=await view(); assert.equal(before.buyersOrderSignature,'awaiting'); assert.equal(before.documentsAwaitingSignature,1);
  await call('A','POST',sign,typed); await call('A','POST',docBase+'/signatures',typed);
  const after=await view(); assert.equal(after.buyersOrderSignature,'signed'); assert.equal(after.documentsAwaitingSignature,0);
  assert.doesNotMatch(JSON.stringify(after),/signerName|signatureData|targetHash|consentText|Test signer/);
});
test('signature hashing sorts nested object keys and preserves array order',() => {
  assert.equal(stableStringify({b:{y:2,x:1},a:[3,4]}),stableStringify({a:[3,4],b:{x:1,y:2}}));
  assert.notEqual(stableStringify([1,2]),stableStringify([2,1]));
});
test('failed replacement metadata write restores original bytes and signature status',async () => {
  const {call,docBase,doc,repositories,store}=await approved();
  await call('A','POST',docBase+'/signatures',typed);
  const original=repositories.forTenant.bind(repositories);
  repositories.forTenant=(tenantId:string) => {
    const repo=original(tenantId);
    return new Proxy(repo,{get(target,key) { if(key==='crmWrite') return async () => { throw new Error('Injected failure'); }; const value=Reflect.get(target,key); return typeof value==='function' ? value.bind(target) : value; }});
  };
  assert.equal((await call('A','POST',docBase+'/replace',{version:1,content:Buffer.from('new').toString('base64')})).status,500);
  assert.equal(Buffer.from((await store.forTenant('A').get(doc.id))!).toString('base64'),upload.content);
  assert.equal((await original('A').crmGet('document',doc.id))!.version,1);
});
test('drawn signature body budget accepts canonical data above the ordinary JSON cap',async () => {
  const {call,sign}=await approved();
  const signatureData='data:image/png;base64,'+Buffer.alloc(98000).toString('base64');
  assert.ok(signatureData.length <= 131072 && signatureData.length > 65536);
  assert.equal(bodyLimit('POST',sign),136*1024);
  assert.equal(bodyLimit('POST','/service/repair-orders/ro/signatures'),136*1024);
  assert.equal(bodyLimit('POST','/deals/deal/documents/doc/replace'),65536);
  assert.equal(bodyLimit('GET',sign),65536);
  assert.equal((await call('A','POST',sign,{...typed,method:'drawn',signatureData})).status,201);
});
test('pending disposal prohibits signing/replacement while keeping history readable',async () => {
  const {call,base,docBase,doc,store}=await approved();
  await call('A','POST',docBase+'/signatures',typed);
  const original=store.forTenant.bind(store);
  store.forTenant=(tenantId:string) => ({...original(tenantId),remove:async () => {throw new Error('Injected removal failure');}});
  assert.equal((await call('A','POST','/documents/'+doc.id+'/dispose',{version:1,confirm:true})).status,503);
  assert.equal((await call('A','POST',docBase+'/signatures',typed)).status,400);
  assert.equal((await call('A','POST',docBase+'/replace',{version:2,content:upload.content})).status,400);
  const j=(await call('A','GET',base+'/jacket')).data;
  assert.equal(j.documents[0].status,'disposal-pending'); assert.equal(j.signatures.length,1);
});
