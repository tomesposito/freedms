import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appointmentStatuses, lineItemAmountCents, repairOrderTotals, type RepairOrderLineItem, type Principal, type RepairOrderView, type ServiceAppointment } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
import { service } from '../src/service.js';
const start = '2026-10-24T09:00:00Z', end = '2026-10-24T10:00:00Z';
const labor: RepairOrderLineItem = {id:'labor',kind:'labor',description:'Diagnose',laborHoursHundredths:255,laborRateCents:12345,quantity:null,unitPriceCents:null};
const parts: RepairOrderLineItem = {id:'parts',kind:'parts',description:'Filter',laborHoursHundredths:null,laborRateCents:null,quantity:3,unitPriceCents:1234};
async function setup() {
  let now = new Date('2026-10-24T12:00:00Z');
  const repositories = new MemoryRepositories(), tokens = new LocalTokens('service-test-secret-at-least-32-characters', () => now.getTime());
  for (const tenantId of ['A','B']) await repositories.forTenant(tenantId).provision({id:tenantId,name:tenantId,createdAt:now.toISOString()},{id:`user${tenantId}`,name:tenantId},{tenantId,userId:`user${tenantId}`,role:'staff',active:true},{id:'provision',tenantId,actorId:`user${tenantId}`,aggregateId:tenantId,aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  const handler = createHandler(repositories,{decode:async () => { throw new Error('No network'); }},() => now);
  const call = async (tenant: string, method: string, path: string, body?: unknown, query?: ApiRequest['query']) => {
    const r = await handler({method,path,body:body === undefined ? undefined:JSON.stringify(body),query,claims:tokens.verify(tokens.issue(`user${tenant}`,tenant))});
    return {status:r.statusCode,...JSON.parse(r.body)};
  };
  const refs = async (tenant: string) => {
    const vehicle = (await call(tenant,'POST','/vehicles',{stockNumber:'test',vin:'1HGCM82633A004352',year:2003,make:'Honda',model:'Accord',trim:'',status:'available',listPrice:100000,cost:70000,reconCosts:[],dateStocked:'2026-10-19',location:'',notes:''})).data;
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
