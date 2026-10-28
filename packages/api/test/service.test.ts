import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appointmentStatuses, lineItemAmountCents, repairOrderTotals, type RepairOrderLineItem, type Principal, type RepairOrderView, type ServiceAppointment } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { MemoryDocumentStore } from '../src/document-store.js';
import { service } from '../src/service.js';
const start = '2026-10-24T09:00:00Z', end = '2026-10-24T10:00:00Z';
const labor: RepairOrderLineItem = {id:'labor',kind:'labor',description:'Diagnose',laborHoursHundredths:255,laborRateCents:12345,quantity:null,unitPriceCents:null};
const parts: RepairOrderLineItem = {id:'parts',kind:'parts',description:'Filter',laborHoursHundredths:null,laborRateCents:null,quantity:3,unitPriceCents:1234};
async function setup() {
  let now = new Date('2026-10-24T12:00:00Z');
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('service-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A','B']) await repositories.forTenant(tenantId).provision({id:tenantId,name:tenantId,createdAt:now.toISOString()},{id:`user${tenantId}`,name:tenantId},{tenantId,userId:`user${tenantId}`,role:'staff',active:true},{id:'provision',tenantId,actorId:`user${tenantId}`,aggregateId:tenantId,aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  const handler = createHandler(repositories,{decode:async () => { throw new Error('No network'); }},() => now,new MemoryDocumentStore());
  const call = async (tenant: string, method: string, path: string, body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method,path,body:body === undefined ? undefined:JSON.stringify(body),query,claims:tokens.verify(tokens.issue(`user${tenant}`,tenant))});
    return {status:r.statusCode,...JSON.parse(r.body)};
  };
  const refs = async (tenant: string) => {
    const vehicle = (await call(tenant,'POST','/vehicles',{mileage: null, stockNumber:'test',vin:'1HGCM82633A004352',year:2003,make:'Honda',model:'Accord',trim:'',status:'available',listPrice:100000,cost:70000,reconCosts:[],dateStocked:'2026-10-19',location:'',notes:''})).data;
    const lead = (await call(tenant,'POST','/leads',{customer:{name:`Buyer ${tenant}`,phone:'',email:'',address:'',notes:'',consent:{status:'unknown',timestamp:null,source:''}},source:'walk-in',vehicleId:vehicle.id})).data.lead;
    return {customerId:lead.customerId,vehicleId:vehicle.id,advisorId:`user${tenant}`};
  };
  const a = await refs('A'), b = await refs('B');
  const appointment = (patch = {}, tenant = 'A') => call(tenant,'POST','/service/appointments',{...a,scheduledStart:start,scheduledEnd:end,concern:' Rattle ',...patch});
  const ro = (patch = {}, tenant = 'A') => call(tenant,'POST','/service/repair-orders',{...a,payType:'customer-pay',lineItems:[],...patch});
  return {call,handler,repositories,a,b,appointment,ro,now:()=>now,setTime:(iso:string)=>{now=new Date(iso);}};
}
test('Service appointments validate references, fields, timestamps and server-authored records/events', async () => {
  const {appointment,call,repositories,b} = await setup();
  for (const patch of [{unknown:1},{customerName:'Fake'},{tenantId:'B'},{actorId:'userB'},{status:'bad'},{status:null},{scheduledEnd:start},{scheduledEnd:'2026-10-25T09:00:01Z'},{customerId:undefined},{customerId:'missing'},{customerId:b.customerId},{vehicleId:b.vehicleId},{advisorId:b.advisorId},{scheduledStart:'bad'},{scheduledEnd:'2026-02-30T10:00:00Z'},{concern:'x'.repeat(2001)},{vehicleDescription:'x'.repeat(1001)}]) assert.equal((await appointment(patch)).status,400,JSON.stringify(patch));
  const created = await appointment(); assert.equal(created.status,201); const r = created.data;
  assert.equal(r.customerName,'Buyer A'); assert.equal(r.vehicleDescription,'2003 Honda Accord'); assert.equal(r.concern,'Rattle'); assert.equal(r.status,'scheduled');
  assert.deepEqual((await call('A','GET',`/service/appointments/${r.id}`)).data,r);
  assert.equal((await call('A','GET','/service/appointments',undefined,{date:'2026-10-24',status:'scheduled',search:'HONDA'})).data.length,1);
  for (const query of [{date:'2026-02-30'},{status:'bad'},{extra:'bad'}]) assert.equal((await call('A','GET','/service/appointments',undefined,query)).status,400);
  const event = repositories.eventsForTest('A').find(e => e.type === 'service-appointment.created')!;
  assert.deepEqual([event.actorId,event.tenantId,event.aggregateId,event.aggregateVersion],['userA','A',r.id,1]);
});
test('Service appointments are versioned and transition through every status', async () => {
  const {appointment,call,repositories,a} = await setup(); let r = (await appointment()).data; const path = `/service/appointments/${r.id}`;
  assert.equal((await call('A','PUT',path,{})).status,400);
  assert.equal((await call('A','PUT',path,{version:1,customerId:a.customerId})).status,400);
  for (const status of appointmentStatuses) { const next = await call('A','PUT',path,{version:r.version,status}); assert.equal(next.status,200); assert.equal(next.data.status,status); r=next.data; }
  assert.equal((await call('A','PUT',path,{version:1})).status,409);
  assert.equal(repositories.eventsForTest('A').filter(e => e.type === 'service-appointment.updated').length,6);
});
test('Repair orders reconcile each rounded labor and parts line and derive unstored totals', async () => {
  const {ro,repositories} = await setup();
  const items = [labor,{...labor,id:'fraction',laborHoursHundredths:1,laborRateCents:155},parts,{...parts,id:'part2',quantity:2,unitPriceCents:99}];
  assert.deepEqual(items.map(lineItemAmountCents),[31480,2,3702,198]);
  const expected = {laborCents:31482,partsCents:3900,totalCents:35382}; assert.deepEqual(repairOrderTotals(items),expected);
  const result = await ro({lineItems:items}); assert.equal(result.status,201); assert.deepEqual(result.data.totals,expected);
  const stored = await repositories.forTenant('A').crmGet('repair-order',result.data.id); assert.ok(stored); assert.equal('totals' in stored,false); assert.deepEqual(result.data.totals,repairOrderTotals(stored.lineItems));
  assert.deepEqual((await ro()).data.totals,{laborCents:0,partsCents:0,totalCents:0});
  const {id,...withoutId} = labor; const generated = await ro({lineItems:[withoutId]}); assert.equal(generated.status,201); assert.ok(generated.data.lineItems[0].id);
});
test('Repair-order line validation rejects malformed, duplicate and unsafe totals', async () => {
  const {ro} = await setup();
  const invalidItems = [[{...labor,quantity:1}],[{...parts,laborRateCents:1}],[{...labor,laborHoursHundredths:0}],[{...labor,laborHoursHundredths:-1}],[{...labor,laborHoursHundredths:1.5}],[{...parts,quantity:0}],[{...parts,quantity:100001}],[{...labor,laborRateCents:-1}],[{...parts,unitPriceCents:-1}],[{...labor,extra:1}],[{...labor,id:''}],[{...labor,id:'x'.repeat(65)}],[labor,labor],Array.from({length:101},(_,i)=>({...labor,id:String(i)})),null,{},[{...parts,description:''}],Array.from({length:100},(_,i)=>({...parts,id:String(i),quantity:100000,unitPriceCents:10000000000}))];
  for (const lineItems of invalidItems) assert.equal((await ro({lineItems})).status,400,JSON.stringify(lineItems).slice(0,150));
  for (const patch of [{status:'open'},{totals:{}},{payType:'bad'},{unknown:1}]) assert.equal((await ro(patch)).status,400);
});
test('Repair orders inherit appointments, allow walk-ins, update versions and keep associations immutable', async () => {
  const {appointment,call,ro,a,b,repositories} = await setup(); const ap = (await appointment()).data;
  const created = await call('A','POST','/service/repair-orders',{appointmentId:ap.id,payType:'warranty'}); assert.equal(created.status,201); const r = created.data;
  for (const key of ['customerId','vehicleId','advisorId','concern','vehicleDescription']) assert.equal(r[key],ap[key]);
  assert.equal((await ro({appointmentId:ap.id,customerId:b.customerId})).status,400);
  const foreign = (await appointment({...b},'B')).data; assert.equal((await ro({appointmentId:foreign.id})).status,400);
  assert.equal((await ro({appointmentId:null})).status,201);
  const path = `/service/repair-orders/${r.id}`;
  assert.equal((await call('A','PUT',path,{})).status,400);
  for (const patch of [{customerId:a.customerId},{appointmentId:null},{status:'bad'},{extra:1}]) assert.equal((await call('A','PUT',path,{version:1,...patch})).status,400);
  const updated = await call('A','PUT',path,{version:1,status:'completed',payType:'internal',lineItems:[labor]}); assert.equal(updated.status,200); assert.equal(updated.data.totals.totalCents,31480);
  assert.equal((await call('A','PUT',path,{version:1})).status,409); assert.deepEqual((await call('A','GET',path)).data,updated.data);
  for (const type of ['repair-order.created','repair-order.updated']) { const event = repositories.eventsForTest('A').find(e => e.type === type)!; assert.equal(event.actorId,'userA'); assert.equal(event.tenantId,'A'); assert.equal(event.aggregateId,r.id); }
});
test('Service history scopes customers and vehicles, searches, and sorts newest first', async () => {
  const {ro,call,a,setTime} = await setup(); const first = (await ro({concern:'Engine rattle'})).data;
  setTime('2026-10-25T12:00:00Z'); const second = (await ro({concern:'Filter replacement'})).data;
  const otherCustomer = (await call('A','POST','/leads',{customer:{name:'Other',phone:'',email:'',address:'',notes:'',consent:{status:'unknown',timestamp:null,source:''}},source:'walk-in'})).data.lead.customerId;
  await ro({customerId:otherCustomer,vehicleId:null,vehicleDescription:'Truck'});
  for (const query of [{customerId:a.customerId},{vehicleId:a.vehicleId}]) assert.deepEqual((await call('A','GET','/service/repair-orders',undefined,query)).data.map((r:RepairOrderView)=>r.id),[second.id,first.id]);
  for (const search of ['BUYER A','HONDA','rattle']) assert.ok((await call('A','GET','/service/repair-orders',undefined,{search})).data.some((r:RepairOrderView)=>r.id===first.id));
  assert.equal((await call('A','GET','/service/repair-orders',undefined,{search:'absent'})).data.length,0);
  for (const query of [{status:'bad'},{extra:'bad'}]) assert.equal((await call('A','GET','/service/repair-orders',undefined,query)).status,400);
});
test('UTC service board groups all statuses and includes created-today or appointment-linked ROs once', async () => {
  const {appointment,ro,call,setTime} = await setup();
  setTime('2026-10-23T12:00:00Z');
  const ap = (await appointment()).data;
  const linked = (await ro({appointmentId:ap.id})).data;
  const excluded = (await ro()).data;
  await appointment({scheduledStart:'2026-10-25T00:00:00Z',scheduledEnd:'2026-10-25T01:00:00Z'});
  setTime('2026-10-24T12:00:00Z');
  const today = (await ro()).data, both = (await ro({appointmentId:ap.id})).data;
  await call('A','PUT',`/service/repair-orders/${excluded.id}`,{version:1,status:'completed'});
  const day = (await call('A','GET','/service/board')).data;
  assert.equal(day.date,'2026-10-24'); assert.deepEqual(day.appointments.map((a:ServiceAppointment)=>a.id),[ap.id]);
  assert.deepEqual(Object.keys(day.byStatus),[...appointmentStatuses]); assert.equal(day.byStatus.scheduled.length,1); assert.equal(day.byStatus.done.length,0);
  assert.deepEqual(new Set(day.repairOrders.map((r:RepairOrderView)=>r.id)),new Set([linked.id,today.id,both.id])); assert.equal(day.repairOrders.length,3); assert.equal(day.repairOrders[0].id,linked.id);
  for (const query of [{date:'2026-02-30'},{date:'2026-1-01'},{extra:'bad'}]) assert.equal((await call('A','GET','/service/board',undefined,query)).status,400);
});
test('Service tenant isolation, repository scope, auth, reader writes and route method contracts', async () => {
  const {appointment,ro,call,handler,repositories,a,b,now} = await setup();
  const ap = (await appointment()).data, r = (await ro()).data;
  for (const [segment,record] of [['appointments',ap],['repair-orders',r]] as const) {
    const path = `/service/${segment}/${record.id}`;
    for (const method of ['GET','PUT']) assert.equal((await call('B',method,path,{version:1})).status,404);
    assert.deepEqual((await call('B','GET',`/service/${segment}`)).data,[]);
    assert.equal((await handler({method:'GET',path})).statusCode,401);
    assert.equal((await call('A','DELETE',path)).status,405); assert.equal((await call('A','POST',path,{})).status,405);
    assert.equal((await call('A','GET',path+'/extra')).status,404); assert.equal((await call('A','GET',path,undefined,{extra:'bad'})).status,400);
    await assert.rejects(service({method:'POST',path:`/service/${segment}`,body:'{}'},{tenantId:'A',userId:'userA',role:'reader'} as unknown as Principal,repositories.forTenant('A'),now()),{status:403});
    const event = repositories.eventsForTest('A').find(e=>e.aggregateId===record.id)!;
    for (const [tenant,rec,ev] of [['B',record,event],['A',{...record,tenantId:'B'},event],['A',record,{...event,tenantId:'B'}]] as const) await assert.rejects(repositories.forTenant(tenant).crmWrite([{record:rec,event:ev,expectedVersion:0}]),/scope/);
  }
  for (const patch of [{customerId:a.customerId,vehicleId:null,advisorId:null},{vehicleId:a.vehicleId},{advisorId:'userA'}]) assert.equal((await appointment({...b,...patch},'B')).status,400);
  assert.equal((await ro({appointmentId:ap.id},'B')).status,400);
  assert.equal((await call('A','POST','/service/board',{})).status,405); assert.equal((await call('A','GET','/service/unknown')).status,404);
  assert.equal((await call('B','GET','/service/board')).data.repairOrders.length,0);
});

test('Technician and labor grid CRUD validate, version, emit events and isolate tenants', async()=>{
  const {call,repositories,handler,now}=await setup();
  for(const [segment,kind,body,patch] of [
    ['technicians','technician',{name:'Alex',skills:['brakes','diesel']},{name:'Alex T',skills:['diagnostics']}],
    ['labor-rates','labor-rate',{skill:'brakes',laborRateCents:15000},{skill:'brakes',laborRateCents:18000}]
  ] as const){
    const created=await call('A','POST',`/service/${segment}`,body);assert.equal(created.status,201);const r=created.data,path=`/service/${segment}/${r.id}`;
    assert.equal((await call('A','GET',path)).data.id,r.id);
    assert.equal((await call('A','GET',`/service/${segment}`)).data.length,1);
    assert.deepEqual((await call('B','GET',`/service/${segment}`)).data,[]);
    for(const method of ['GET','PUT'])assert.equal((await call('B',method,path,{version:1,...patch})).status,404);
    assert.equal((await call('A','PUT',path,{version:1,...patch})).data.version,2);
    assert.equal((await call('A','PUT',path,{version:1,...patch})).status,409);
    assert.equal((await call('A','DELETE',path)).status,405);
    assert.equal((await handler({method:'GET',path})).statusCode,401);
    await assert.rejects(service({method:'POST',path:`/service/${segment}`,body:JSON.stringify(body)},{tenantId:'A',userId:'userA',role:'reader'} as unknown as Principal,repositories.forTenant('A'),now()),{status:403});
    assert.equal(repositories.eventsForTest('A').filter(e=>e.type===`${kind}.created`||e.type===`${kind}.updated`).length,2);
  }
  for(const body of [{name:'',skills:[]},{name:'A',skills:['magic']},{name:'A',skills:'brakes'}])assert.equal((await call('A','POST','/service/technicians',body)).status,400);
  for(const body of [{skill:'bad',laborRateCents:1},{skill:'engine',laborRateCents:-1},{skill:'engine',laborRateCents:1.2}])assert.equal((await call('A','POST','/service/labor-rates',body)).status,400);
  assert.equal((await call('A','POST','/service/labor-rates',{skill:'brakes',laborRateCents:1})).status,409);
});
test('Dispatch requires deliberate mismatch override on appointments and ROs and reports day load',async()=>{
  const {call,appointment,ro}=await setup();
  const tech=(await call('A','POST','/service/technicians',{name:'Diesel specialist',skills:['diesel']})).data;
  for(const create of [appointment,ro]){
    const assignment={technicianId:tech.id,requiredSkill:'brakes'};
    const rejected=await create(assignment);assert.equal(rejected.status,400);assert.match(rejected.error.message,/Diesel specialist.*brakes/);
    const r=(await create({...assignment,acknowledgeSkillMismatch:true})).data;
    assert.deepEqual(r.skillMismatchWarning,{requiredSkill:'brakes',technicianId:tech.id,acknowledgedBy:'userA',acknowledgedAt:'2026-10-24T12:00:00.000Z'});
    const path=`/service/${r.kind==='repair-order'?'repair-orders':'appointments'}/${r.id}`;
    assert.equal((await call('A','PUT',path,{version:1,...assignment})).status,400);
    assert.equal((await call('A','PUT',path,{version:1,requiredSkill:'engine'})).status,400);
    assert.equal((await call('A','PUT',path,{version:1,requiredSkill:'diesel'})).status,200);
    assert.equal((await create({technicianId:'missing'})).status,400);
  }
  const board=(await call('A','GET','/service/board')).data;assert.equal(board.technicians[0].dayLoad,2);
  assert.deepEqual((await call('B','GET','/service/board')).data.technicians,[]);
  assert.equal((await appointment({technicianId:tech.id},'B')).status,400);
});
test('Labor grid supplies omitted rates while manual override remains the stored and posted amount',async()=>{
  const {call,ro}=await setup();await call('A','POST','/service/labor-rates',{skill:'diagnostics',laborRateCents:15000});
  const {laborRateCents,...line}=labor;
  const r=(await ro({lineItems:[{...line,skill:'diagnostics'}]})).data;
  assert.equal(r.lineItems[0].laborRateCents,15000);
  const updated=await call('A','PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed',lineItems:[{...r.lineItems[0],laborRateCents:12300}]});
  assert.equal(updated.status,200);assert.equal(updated.data.totals.totalCents,31365);
  const journals=(await call('A','GET','/accounting/journal',undefined,{repairOrderId:r.id})).data;
  assert.equal(journals[0].lines.find((l:any)=>l.accountCode==='4300').credit,31365);
});
test('Photo inspection produces one priced recommendation, persists declines and approves through stock and GL',async()=>{
  const {call,ro,repositories}=await setup();await call('A','POST','/service/labor-rates',{skill:'brakes',laborRateCents:12000});
  const part=(await call('A','POST','/parts',{partNumber:'PAD',description:'Brake pads',costCents:2000,retailPriceCents:4000,quantityOnHand:5,reorderPoint:1,binLocation:''})).data;
  assert.ok(part);
  const item={id:'brakes-check',label:'Replace pads',status:'needs-attention',skill:'brakes',partId:part.id};
  let result=await ro({inspection:[item]});assert.equal(result.status,201);let r=result.data;const path=`/service/repair-orders/${r.id}`;
  const content=Buffer.from('small photo fixture').toString('base64');
  result=await call('A','POST',`${path}/photos`,{version:r.version,name:'pads.png',type:'image/png',content});assert.equal(result.status,201);r=result.data;
  assert.equal(r.photos[0].size,19);assert.equal('content' in r.photos[0],false);
  const photoPath=`${path}/photos/${r.photos[0].id}/content`;
  assert.equal((await call('A','GET',photoPath)).data.content,content);
  for(const method of ['GET','PUT'])assert.equal((await call('B',method,path,{version:r.version,inspection:[item]})).status,404);
  assert.equal((await call('B','GET',photoPath)).status,404);
  assert.equal((await call('B','POST',`${path}/photos`,{version:r.version,name:'x',type:'image/png',content})).status,404);
  r=(await call('A','PUT',path,{version:r.version,inspection:[item]})).data;
  assert.equal(r.recommendations.length,1);assert.equal(r.recommendations[0].estimatedPriceCents,16000);
  const rec=r.recommendations[0];
  r=(await call('A','PUT',path,{version:r.version,recommendationDecision:{id:rec.id,status:'declined'}})).data;
  assert.equal(r.lineItems.length,0);assert.equal(r.recommendations[0].status,'declined');assert.equal(r.recommendations[0].decidedBy,'userA');assert.ok(r.recommendations[0].decidedAt);
  assert.equal((await call('A','PUT',path,{version:r.version,recommendationDecision:{id:rec.id,status:'approved'}})).status,409);
  r=(await call('A','PUT',path,{version:r.version,inspection:[item,{...item,id:'second'}]})).data;
  assert.equal(r.recommendations.length,2);
  result=await call('A','PUT',path,{version:r.version,status:'completed',recommendationDecision:{id:r.recommendations[1].id,status:'approved'}});assert.equal(result.status,200);r=result.data;
  assert.equal(r.totals.totalCents,16000);assert.equal(r.lineItems.length,2);assert.deepEqual(r.recommendations[1].lineIds,r.lineItems.map((l:any)=>l.id));assert.equal(r.glPosted,true);assert.equal(r.stockApplied,true);
  assert.equal((await call('A','GET',`/parts/${part.id}`)).data.quantityOnHand,4);
  assert.equal((await call('A','GET','/accounting/journal',undefined,{repairOrderId:r.id})).data.length,1);
  assert.equal((await call('B','PUT',path,{version:r.version,recommendationDecision:{id:rec.id,status:'approved'}})).status,404);
  assert.equal((await call('A','PUT',path,{version:1,recommendationDecision:{id:rec.id,status:'approved'}})).status,409);
  const stored=await repositories.forTenant('A').crmGet('repair-order',r.id);assert.equal(stored?.recommendations?.[0].status,'declined');
});
test('Photo and inspection validation rejects forged references, oversized uploads and foreign parts',async()=>{
  const {call,ro,b}=await setup();const r=(await ro()).data,path=`/service/repair-orders/${r.id}`;
  for(const body of [{photos:[{id:'forged'}]},{recommendations:[]},{inspection:[{label:'X',status:'bad'}]},{inspection:[{label:'X',status:'ok',partId:'missing'}]},{inspection:[{id:'same',label:'A',status:'ok'},{id:'same',label:'B',status:'ok'}]}])assert.equal((await call('A','PUT',path,{version:1,...body})).status,400);
  for(const body of [{content:'!'}, {content:Buffer.alloc(40961).toString('base64')},{type:'text/html',content:'eA=='},{content:''}])assert.equal((await call('A','POST',`${path}/photos`,{version:1,name:'x.png',type:'image/png',...body})).status,400);
  assert.equal((await call('A','POST',`${path}/photos`,{version:2,name:'x',type:'image/png',content:'eA=='})).status,409);
  const foreign=(await call('B','POST','/parts',{partNumber:'FOREIGN',description:'Other',costCents:1,retailPriceCents:2,quantityOnHand:0,reorderPoint:0,binLocation:''})).data;
  assert.equal((await ro({inspection:[{label:'X',status:'ok',partId:foreign.id}]})).status,400);
  await call('A','POST','/service/labor-rates',{skill:'brakes',laborRateCents:100});
  assert.equal((await ro({...b,inspection:[{label:'X',status:'needs-attention',skill:'brakes'}]},'B')).status,400);
});

test('Completing a linked RO versions its appointment, emits an event and updates the service board', async () => {
  const {appointment,ro,call,repositories,setTime} = await setup();
  const ap = (await appointment()).data, r = (await ro({appointmentId:ap.id})).data;
  setTime('2026-10-24T13:00:00Z');
  assert.equal((await call('A','PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'})).status,200);
  const updated = (await call('A','GET',`/service/appointments/${ap.id}`)).data;
  assert.deepEqual(updated,{...ap,status:'done',version:2,updatedAt:'2026-10-24T13:00:00.000Z'});
  const events = repositories.eventsForTest('A').filter(e=>e.type==='service-appointment.updated');
  assert.equal(events.length,1);
  assert.deepEqual({...events[0],id:'generated'},{id:'generated',tenantId:'A',actorId:'userA',aggregateId:ap.id,aggregateVersion:2,type:'service-appointment.updated',occurredAt:updated.updatedAt,deliveryStatus:'pending'});
  const board = (await call('A','GET','/service/board',undefined,{date:'2026-10-24'})).data;
  assert.deepEqual(board.byStatus.done,[updated]); assert.deepEqual(board.byStatus.scheduled,[]);
  assert.deepEqual(board.appointments,[updated]); assert.equal(board.repairOrders[0].status,'completed');
  // Exercise J07's board-agreement check against the actual API response and renderer offline.
  const {serviceBoardHtml} = await import('../../web/src/service.js');
  const html = serviceBoardHtml(board);
  assert.ok(html.includes(ap.customerName)); assert.ok(html.includes(ap.vehicleDescription));
  assert.match(html,/Completed/); assert.doesNotMatch(html,/Scheduled \(1\)/);
  assert.equal((await call('A','PUT',`/service/repair-orders/${r.id}`,{version:1,status:'open'})).status,409);
  assert.deepEqual((await call('A','GET',`/service/appointments/${ap.id}`)).data,updated);
});

test('Pickup and reopening finalized ROs follow the appointment status mapping', async () => {
  for (const finalized of ['completed','picked-up']) for (const [status,expected] of [['open','scheduled'],['in-progress','in-service']]) {
    const {appointment,ro,call} = await setup();
    const ap = (await appointment()).data, r = (await ro({appointmentId:ap.id})).data;
    const path = `/service/repair-orders/${r.id}`, apPath = `/service/appointments/${ap.id}`;
    assert.equal((await call('A','PUT',path,{version:1,status:finalized})).status,200);
    assert.equal((await call('A','GET',apPath)).data.status,finalized==='completed'?'done':'picked-up');
    assert.equal((await call('A','PUT',path,{version:2,status})).status,200);
    const updated = (await call('A','GET',apPath)).data;
    assert.equal(updated.status,expected); assert.equal(updated.version,3);
  }
});

test('Walk-in completion and unchanged RO status do not write appointments', async () => {
  const {appointment,ro,call,repositories} = await setup();
  const walkIn = (await ro()).data;
  assert.equal((await call('A','PUT',`/service/repair-orders/${walkIn.id}`,{version:1,status:'completed'})).status,200);
  const ap = (await appointment()).data, r = (await ro({appointmentId:ap.id})).data;
  assert.equal((await call('A','PUT',`/service/repair-orders/${r.id}`,{version:1,payType:'internal',status:'open'})).status,200);
  assert.deepEqual((await call('A','GET',`/service/appointments/${ap.id}`)).data,ap);
  assert.equal(repositories.eventsForTest('A').filter(e=>e.type==='service-appointment.updated').length,0);
});

test('Missing or foreign linked appointments are never changed by RO completion', async () => {
  const {appointment,ro,call,repositories,b} = await setup();
  const foreign = (await appointment(b,'B')).data;
  assert.equal((await ro({appointmentId:foreign.id})).status,400);
  for (const appointmentId of [foreign.id,'missing']) {
    const r = (await ro()).data;
    const repo = repositories.forTenant('A'), stored = (await repo.crmGet('repair-order',r.id))!;
    // Simulate a legacy dangling reference that cannot be created through the API.
    await repo.crmWrite([{record:{...stored,appointmentId,version:2},expectedVersion:1,event:{id:`dangling-${r.id}`,tenantId:'A',actorId:'userA',aggregateId:r.id,aggregateVersion:2,type:'repair-order.updated',occurredAt:r.updatedAt,deliveryStatus:'pending'}}]);
    assert.equal((await call('A','PUT',`/service/repair-orders/${r.id}`,{version:2,status:'completed'})).status,200);
  }
  assert.deepEqual((await call('B','GET',`/service/appointments/${foreign.id}`)).data,foreign);
  for (const tenant of ['A','B']) assert.equal(repositories.eventsForTest(tenant).filter(e=>e.type==='service-appointment.updated').length,0);
});

test('Shared appointments retain the highest finalized RO state until all ROs reopen', async () => {
  const {appointment,ro,call} = await setup();
  const ap = (await appointment()).data, first = (await ro({appointmentId:ap.id})).data, second = (await ro({appointmentId:ap.id})).data;
  const update = async (r: RepairOrderView, status: string, expected: string) => {
    const result = await call('A','PUT',`/service/repair-orders/${r.id}`,{version:r.version,status});
    assert.equal(result.status,200); Object.assign(r,result.data);
    assert.equal((await call('A','GET',`/service/appointments/${ap.id}`)).data.status,expected);
  };
  await update(first,'completed','done'); await update(second,'completed','done');
  await update(first,'open','done'); await update(second,'picked-up','picked-up');
  await update(first,'completed','picked-up'); await update(first,'in-progress','picked-up');
  await update(second,'open','scheduled');
});

test('RO status changes preserve an advisor no-show decision', async () => {
  const {appointment,ro,call,repositories} = await setup();
  const ap = (await appointment({status:'no-show'})).data; let r = (await ro({appointmentId:ap.id})).data;
  for (const status of ['completed','picked-up','open','completed','in-progress']) {
    const result = await call('A','PUT',`/service/repair-orders/${r.id}`,{version:r.version,status});
    assert.equal(result.status,200); r=result.data;
    assert.deepEqual((await call('A','GET',`/service/appointments/${ap.id}`)).data,ap);
  }
  assert.equal(repositories.eventsForTest('A').filter(e=>e.type==='service-appointment.updated').length,0);
});

test('Appointment sync fits with eight stock writes and follows a full nine-part batch', async () => {
  for (const count of [8,9]) {
    const {appointment,ro,call} = await setup();
    const ap = (await appointment()).data, lineItems = [];
    for (let i=0;i<count;i++) {
      const part = (await call('A','POST','/parts',{partNumber:`PART-${i}`,description:'Filter',costCents:100,retailPriceCents:200,quantityOnHand:10,reorderPoint:0,binLocation:''})).data;
      lineItems.push({...parts,id:`line-${i}`,partId:part.id,quantity:1,unitPriceCents:200});
    }
    let r = (await ro({appointmentId:ap.id,lineItems})).data;
    for (const [status,expected,quantity] of [['completed','done',9],['open','scheduled',10]] as const) {
      const result = await call('A','PUT',`/service/repair-orders/${r.id}`,{version:r.version,status});
      assert.equal(result.status,200); r=result.data;
      assert.equal((await call('A','GET',`/service/appointments/${ap.id}`)).data.status,expected);
      for (const line of lineItems) assert.equal((await call('A','GET',`/parts/${line.partId}`)).data.quantityOnHand,quantity);
    }
    assert.equal((await call('A','GET','/accounting/journal',undefined,{repairOrderId:r.id})).data.length,2);
  }
});
