import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Part, Principal, RepairOrderLineItem } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { parts, stockEvent } from '../src/parts.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
const input={partNumber:'FILTER-1',description:'Oil filter',binLocation:'A-1',costCents:450,retailPriceCents:899,quantityOnHand:20,reorderPoint:5};
const line=(partId?: string, quantity=2, id='line'): RepairOrderLineItem=>({id,kind:'parts',description:'Filter',partId,quantity,unitPriceCents:899,laborHoursHundredths:null,laborRateCents:null});
async function setup() {
  let now=new Date('2026-10-24T12:00:00Z');
  const repositories=new MemoryRepositories(), tokens=new LocalTokens('parts-test-secret-at-least-32-characters',()=>now.getTime());
  for(const tenantId of ['A','B']) await repositories.forTenant(tenantId).provision({id:tenantId,name:tenantId,createdAt:now.toISOString()},{id:`user${tenantId}`,name:tenantId},{tenantId,userId:`user${tenantId}`,role:'staff',active:true},{id:'provision',tenantId,actorId:`user${tenantId}`,aggregateId:tenantId,aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  const handler=createHandler(repositories,{decode:async()=>{throw new Error('No network');}},()=>now);
  const call=async(method:string,path:string,body?:unknown,tenant='A',query?:ApiRequest['query'])=>{const r=await handler({method,path,body:body===undefined ? undefined:JSON.stringify(body),query,claims:tokens.verify(tokens.issue(`user${tenant}`,tenant))}); return {status:r.statusCode,...JSON.parse(r.body)};};
  const customers: Record<string,string>={};
  for(const tenant of ['A','B']) customers[tenant]=(await call('POST','/leads',{customer:{name:`Buyer ${tenant}`,phone:'',email:'',address:'',notes:'',consent:{status:'unknown',timestamp:null,source:''}},source:'walk-in'},tenant)).data.lead.customerId;
  const part=async(patch={},tenant='A')=>(await call('POST','/parts',{...input,...patch},tenant));
  const ro=async(items:RepairOrderLineItem[],tenant='A')=>call('POST','/service/repair-orders',{customerId:customers[tenant],payType:'customer-pay',lineItems:items},tenant);
  const stock=async(id:string)=>(await call('GET',`/parts/${id}`)).data.quantityOnHand;
  return {call,part,ro,stock,repositories,customers,handler,setTime:(s:string)=>{now=new Date(s);}};
}
test('Parts catalog validates strict inputs and emits server-authored events; reads, search, updates and conflicts',async()=>{
  const {call,part,repositories}=await setup();
  for(const patch of [{partNumber:''},{description:2},{binLocation:null},{costCents:-1},{costCents:1.2},{retailPriceCents:'9'},{quantityOnHand:-1},{quantityOnHand:1.5},{quantityOnHand:Number.MAX_SAFE_INTEGER+1},{reorderPoint:-1},{reorderPoint:'2'},{tenantId:'B'},{customerName:'Fake'},{version:1},{id:'fake'},{stockWarning:'fake'},{allowNegativeStock:true}]) assert.equal((await part(patch)).status,400,JSON.stringify(patch));
  const created=await part(); assert.equal(created.status,201); const p=created.data; assert.equal(p.tenantId,'A'); assert.equal(p.version,1);
  assert.deepEqual((await call('GET',`/parts/${p.id}`)).data,p);
  for(const search of ['filter-1','OIL','a-1']) assert.equal((await call('GET','/parts',undefined,'A',{search})).data[0].id,p.id);
  assert.deepEqual((await call('GET','/parts',undefined,'A',{search:'absent'})).data,[]);
  assert.equal((await part()).status,400); assert.equal((await part({},'B')).status,201);
  const other=(await part({partNumber:'OTHER'})).data;
  assert.equal((await call('PUT',`/parts/${other.id}`,{version:1,partNumber:p.partNumber})).status,400);
  const updated=await call('PUT',`/parts/${p.id}`,{version:1,partNumber:'RENAMED',quantityOnHand:12}); assert.equal(updated.status,200); assert.equal(updated.data.version,2);
  assert.equal((await call('PUT',`/parts/${p.id}`,{version:1})).status,409);
  assert.equal((await part()).status,201);
  for(const type of ['part.created','part.updated']) {const event=repositories.eventsForTest('A').find(e=>e.aggregateId===p.id&&e.type===type)!; assert.deepEqual([event.actorId,event.tenantId,event.aggregateVersion],['userA','A',type==='part.created'?1:2]);}
  for(const query of [{extra:'bad'},{reorder:'yes'}]) assert.equal((await call('GET','/parts',undefined,'A',query)).status,400);
});
test('RO stock reconciliation aggregates lines, is idempotent, restores, refinalizes, and reconciles edits exactly',async()=>{
  const {part,ro,call,stock,repositories}=await setup(); const p=(await part()).data,q=(await part({partNumber:'SECOND',quantityOnHand:10})).data;
  let r=(await ro([line(p.id,2),line(p.id,3,'repeat'),line(q.id,4,'other'),line(undefined,8,'free')])).data;
  assert.equal(await stock(p.id),20); assert.equal(r.stockApplied,false);
  const save=async(patch={})=>{const result=await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,...patch}); assert.equal(result.status,200,JSON.stringify(result));r=result.data;};
  await save({status:'completed'}); assert.equal(r.stockApplied,true); assert.equal(await stock(p.id),15); assert.equal(await stock(q.id),6);
  const stockVersion=(await call('GET',`/parts/${p.id}`)).data.version;
  await save(); assert.equal(await stock(p.id),15); assert.equal((await call('GET',`/parts/${p.id}`)).data.version,stockVersion);
  await save({status:'open'}); assert.equal(r.stockApplied,false); assert.equal(await stock(p.id),20); assert.equal(await stock(q.id),10);
  await save({status:'completed'}); assert.equal(await stock(p.id),15); assert.equal(await stock(q.id),6);
  await save({lineItems:[line(p.id,7)]}); assert.equal(await stock(p.id),13); assert.equal(await stock(q.id),10);
  await save({status:'picked-up'}); assert.equal(await stock(p.id),13);
  await save({status:'in-progress'}); assert.equal(await stock(p.id),20);
  assert.ok(repositories.eventsForTest('A').filter(e=>e.type==='part.updated').every(e=>e.causeId===r.id&&e.actorId==='userA'&&e.tenantId==='A'));
});
test('RO insufficient stock fails atomically; explicit boolean override records warning and survives unchanged saves',async()=>{
  const {part,ro,call,stock,repositories}=await setup(); const p=(await part({quantityOnHand:1})).data,q=(await part({partNumber:'ENOUGH'})).data;
  const r=(await ro([line(q.id,2,'enough'),line(p.id,3)])).data,path=`/service/repair-orders/${r.id}`,before=repositories.eventsForTest('A').length;
  const denied=await call('PUT',path,{version:1,status:'completed'}); assert.equal(denied.status,400); assert.match(denied.error.message,/FILTER-1/);
  assert.equal(await stock(p.id),1); assert.equal(await stock(q.id),20); assert.deepEqual((await call('GET',path)).data,r); assert.equal(repositories.eventsForTest('A').length,before);
  assert.equal((await call('PUT',path,{version:1,status:'completed',allowNegativeStock:'true'})).status,400);
  const done=await call('PUT',path,{version:1,status:'completed',allowNegativeStock:true}); assert.equal(done.status,200); assert.equal(await stock(p.id),-2); assert.match(done.data.stockWarning,/FILTER-1/);
  const same=await call('PUT',path,{version:2,status:'picked-up'}); assert.equal(same.status,200); assert.equal(same.data.stockWarning,done.data.stockWarning); assert.equal(await stock(p.id),-2);
  assert.equal((await call('PUT',path,{version:3,status:'open'})).data.stockWarning,null); assert.equal(await stock(p.id),1);
  for(const patch of [{stockApplied:true},{stockWarning:'fake'},{tenantId:'B'}]) assert.equal((await call('PUT',path,{version:4,...patch})).status,400);
  assert.equal((await call('POST','/service/repair-orders',{customerId:r.customerId,payType:'internal',allowNegativeStock:true})).status,400);
});
test('RO stock transaction cap permits nine distinct parts, rejects ten without changes, and free-text lines never deplete',async()=>{
  const {part,ro,call,stock}=await setup(); const ps=[]; for(let i=0;i<10;i++) ps.push((await part({partNumber:`P${i}`})).data);
  const r=(await ro(ps.map((p,i)=>line(p.id,1,String(i))))).data;
  const result=await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'}); assert.equal(result.status,400); assert.match(result.error.message,/9/);
  for(const p of ps) assert.equal(await stock(p.id),20);
  assert.equal((await call('GET',`/service/repair-orders/${r.id}`)).data.version,1);
  assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed',lineItems:r.lineItems.slice(0,9)})).status,200);
  for(const p of ps.slice(0,9)) assert.equal(await stock(p.id),19);
  const free=(await ro([line(undefined,100)])).data; assert.equal((await call('PUT',`/service/repair-orders/${free.id}`,{version:1,status:'completed'})).status,200); assert.equal(await stock(ps[9].id),20);
});
test('Counter sales calculate default and explicit prices, validate customers, list newest first and remain immutable',async()=>{
  const {part,call,stock,customers,setTime,repositories}=await setup(); const p=(await part()).data;
  const first=await call('POST','/parts/sales',{partId:p.id,quantity:2}); assert.equal(first.status,201); assert.equal(first.data.totalCents,1798); assert.equal(first.data.unitPriceCents,899); assert.equal(first.data.customerId,null); assert.equal(first.data.stockNegative,false); assert.equal(await stock(p.id),18);
  setTime('2026-10-25T12:00:00Z'); const second=await call('POST','/parts/sales',{partId:p.id,quantity:3,unitPriceCents:500,customerId:customers.A}); assert.equal(second.status,201); assert.equal(second.data.totalCents,1500); assert.equal(second.data.customerName,'Buyer A'); assert.equal(await stock(p.id),15);
  assert.deepEqual((await call('GET','/parts/sales')).data.map((s:{id:string})=>s.id),[second.data.id,first.data.id]); assert.deepEqual((await call('GET',`/parts/sales/${first.data.id}`)).data,first.data);
  for(const method of ['PUT','DELETE','POST']) assert.equal((await call(method,`/parts/sales/${first.data.id}`,{})).status,405);
  for(const patch of [{customerId:'missing'},{customerId:customers.B},{quantity:0},{quantity:1.2},{quantity:'1'},{unitPriceCents:-1},{unitPriceCents:null},{quantity:Number.MAX_SAFE_INTEGER},{tenantId:'B'},{totalCents:1},{customerName:'Fake'},{allowNegativeStock:1},{partId:'missing'}]) assert.equal((await call('POST','/parts/sales',{partId:p.id,quantity:1,...patch})).status,400,JSON.stringify(patch));
  const event=repositories.eventsForTest('A').find(e=>e.type==='parts-sale.created')!; assert.deepEqual([event.actorId,event.tenantId,event.aggregateId,event.aggregateVersion],['userA','A',first.data.id,1]);
  await assert.rejects(repositories.forTenant('A').crmWrite([{record:{...first.data,version:2},expectedVersion:1,event:{...event,aggregateVersion:2}}]),/immutable/);
});
test('Counter sales reject negative stock atomically and flag explicit overrides',async()=>{
  const {part,call,stock,repositories}=await setup(); const p=(await part({quantityOnHand:1})).data; const before=repositories.eventsForTest('A').length;
  const body={partId:p.id,quantity:3}; const denied=await call('POST','/parts/sales',body); assert.equal(denied.status,400); assert.match(denied.error.message,/FILTER-1/); assert.equal(await stock(p.id),1); assert.deepEqual((await call('GET','/parts/sales')).data,[]); assert.equal(repositories.eventsForTest('A').length,before);
  const allowed=await call('POST','/parts/sales',{...body,allowNegativeStock:true}); assert.equal(allowed.status,201); assert.equal(await stock(p.id),-2); assert.equal(allowed.data.stockNegative,true); assert.match(allowed.data.stockWarning,/explicitly allowed/);
});
test('Reorder filter includes at/below point, excludes above, and reflects depletion',async()=>{
  const {part,call,ro}=await setup(); const at=(await part({partNumber:'AT',quantityOnHand:5})).data, below=(await part({partNumber:'BELOW',quantityOnHand:3})).data, above=(await part({partNumber:'ABOVE',quantityOnHand:6})).data;
  const list=async()=>(await call('GET','/parts',undefined,'A',{reorder:'true'})).data.map((p:Part)=>p.id);
  assert.deepEqual(await list(),[below.id,at.id]); const r=(await ro([line(above.id,1)])).data;
  await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'}); assert.deepEqual(await list(),[below.id,above.id,at.id]);
});
test('Parts, sales and stock references are tenant isolated; protected fields, labor references and readers rejected',async()=>{
  const {part,call,ro,stock,repositories,customers,handler}=await setup(); const p=(await part()).data;
  const sale=(await call('POST','/parts/sales',{partId:p.id,quantity:1})).data;
  for(const path of [`/parts/${p.id}`,`/parts/sales/${sale.id}`]) assert.equal((await call('GET',path,undefined,'B')).status,404);
  assert.equal((await call('PUT',`/parts/${p.id}`,{version:2,quantityOnHand:0},'B')).status,404);
  for(const path of ['/parts','/parts/sales']) assert.deepEqual((await call('GET',path,undefined,'B')).data,[]);
  assert.equal((await call('POST','/parts/sales',{partId:p.id,quantity:1},'B')).status,400);
  assert.equal((await ro([line(p.id)],'B')).status,400); assert.equal((await ro([line('missing')])).status,400);
  const foreign=(await ro([],'B')).data; assert.equal((await call('PUT',`/service/repair-orders/${foreign.id}`,{version:1,status:'completed',lineItems:[line(p.id)]},'B')).status,400); assert.equal(await stock(p.id),19);
  assert.equal((await ro([{...line(p.id),kind:'labor',quantity:null,unitPriceCents:null,laborHoursHundredths:100,laborRateCents:500}])).status,400);
  assert.equal((await call('POST','/service/appointments',{customerId:customers.A,allowNegativeStock:true})).status,400);
  assert.equal((await handler({method:'GET',path:'/parts'})).statusCode,401);
  for(const path of ['/parts','/parts/sales']) await assert.rejects(parts({method:'POST',path,body:'{}'},{tenantId:'A',userId:'userA',role:'reader'} as unknown as Principal,repositories.forTenant('A'),new Date()),{status:403});
  for(const path of ['/parts/unknown/extra','/parts/sales/unknown/extra']) assert.equal((await call('GET',path)).status,404);
});
test('Concurrent catalog creates and stock sales cannot duplicate part numbers or oversell',async()=>{
  const {part,call,stock}=await setup(); const created=await Promise.all([part(),part()]); assert.deepEqual(created.map(r=>r.status).sort(),[201,409]); const p=created.find(r=>r.status===201)!.data;
  const sold=await Promise.all([call('POST','/parts/sales',{partId:p.id,quantity:15}),call('POST','/parts/sales',{partId:p.id,quantity:15})]); assert.deepEqual(sold.map(r=>r.status).sort(),[201,409]); assert.equal(await stock(p.id),5); assert.equal((await call('GET','/parts/sales')).data.length,1);
});
test('Dynamo reserves and releases unique part numbers atomically with versioned records and events',async()=>{
  const time='2026-10-24T12:00:00Z', principal:Principal={tenantId:'A',userId:'userA',role:'staff'};
  const p:Part={...input,kind:'part',id:'part',tenantId:'A',version:1,createdAt:time,updatedAt:time}; const commands:TransactWriteCommand[]=[];
  const client={send:async(command:GetCommand|TransactWriteCommand)=>{if(command instanceof GetCommand) return {Item:{data:p}}; commands.push(command);return {};}} as unknown as DynamoDBDocumentClient;
  const repo=new DynamoRepositories('table',client).forTenant('A'); await repo.crmWrite([{record:p,expectedVersion:0,event:stockEvent(principal,time,p)}]);
  const renamed={...p,partNumber:'NEW',version:2}; await repo.crmWrite([{record:renamed,expectedVersion:1,event:stockEvent(principal,time,renamed)}]);
  assert.deepEqual(commands[0].input.TransactItems!.map(i=>i.Put?.Item?.SK).slice(0,2),['PART-NUMBER#FILTER-1','PART#part']);
  const items=commands[1].input.TransactItems!; assert.equal(items[0].Put?.Item?.SK,'PART-NUMBER#NEW');assert.equal(items[1].Delete?.Key?.SK,'PART-NUMBER#FILTER-1'); assert.equal(items[2].Put?.ExpressionAttributeValues?.[':v'],1);
  for(const command of commands) assert.ok(command.input.TransactItems!.every(i=>(i.Put?.Item??i.Delete?.Key)?.PK==='TENANT#A'));
});
test('Finalized edits add and remove stock effects together and reject insufficient replacements atomically',async()=>{
  const {part,ro,call,stock}=await setup();const p=(await part()).data,q=(await part({partNumber:'REPLACEMENT',quantityOnHand:3})).data;
  const r=(await ro([line(p.id,5)])).data,path=`/service/repair-orders/${r.id}`;
  await call('PUT',path,{version:1,status:'completed'});
  assert.equal((await call('PUT',path,{version:2,lineItems:[line(q.id,4)]})).status,400);assert.equal(await stock(p.id),15);assert.equal(await stock(q.id),3);assert.equal((await call('GET',path)).data.version,2);
  assert.equal((await call('PUT',path,{version:2,lineItems:[line(q.id,2)]})).status,200);assert.equal(await stock(p.id),20);assert.equal(await stock(q.id),1);
});
test('Concurrent RO completion commits stock and outbox only once',async()=>{
  const {part,ro,call,stock,repositories}=await setup();const p=(await part()).data,r=(await ro([line(p.id,5)])).data;
  const results=await Promise.all([1,2].map(()=>call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(await stock(p.id),15);assert.equal(repositories.eventsForTest('A').filter(e=>e.type==='part.updated').length,1);assert.equal(repositories.eventsForTest('A').filter(e=>e.type==='repair-order.updated').length,1);
});
