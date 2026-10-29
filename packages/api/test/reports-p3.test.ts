import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CrmEntity, Vehicle, RepairOrderLineItem } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import { LocalTokens } from '../src/auth.js';
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
const labor: RepairOrderLineItem = {id:'labor',kind:'labor',description:'Labor',laborHoursHundredths:255,laborRateCents:12345,quantity:null,unitPriceCents:null};

test('P3 technician hours: two known ROs, unassigned and unknown flags, range and zero sold guard',async()=>{
  const s=await setup();
  const tech=(await s.call('POST','/service/technicians',{name:'Pat',skills:['general']})).data;
  assert.ok(tech?.id);
  const first=(await s.ro([{...labor,laborHoursHundredths:250,flaggedHoursHundredths:200}])).data;
  const second=(await s.ro([{...labor,laborHoursHundredths:125,flaggedHoursHundredths:150}])).data;
  for(const r of [first,second]) assert.equal((await s.call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,technicianId:tech.id})).status,200);
  await s.ro([{...labor,flaggedHoursHundredths:0}]);
  const rows=(await s.call('GET','/reports/technicians')).data.rows;
  const pat=rows.find((r:any)=>r.technicianId===tech.id);
  assert.deepEqual([pat.soldHoursHundredths,pat.flaggedHoursHundredths,pat.efficiencyPercent,pat.roCount],[375,350,93.33,2]);
  assert.equal(rows.find((r:any)=>r.technician==='Unassigned').efficiencyPercent,0);
  await s.ro([labor]);
  const unassigned=(await s.call('GET','/reports/technicians')).data.rows.find((r:any)=>!r.technicianId);
  assert.equal(unassigned.flaggedHoursHundredths,null); assert.equal(unassigned.missingFlaggedLines,1); assert.equal(unassigned.efficiencyPercent,null);
  assert.deepEqual((await s.call('GET','/reports/technicians',undefined,'A',{from:'2026-10-25'})).data.rows,[]);
  // Defensive legacy fixture: writes cannot create zero sold hours, but reports must not divide by zero.
  const repo=s.repositories.forTenant('A'), record=(await repo.crmGet('repair-order',first.id))!;
  const {technicianMetrics}=await import('../src/reports-p3.js');
  const zeroRepo={crmList:async(kind:string)=>kind==='repair-order' ? [{...record,lineItems:[{...labor,laborHoursHundredths:0,flaggedHoursHundredths:0}]}] : []};
  assert.equal((await technicianMetrics(zeroRepo as any,{from:null,to:null})).rows[0].efficiencyPercent,null);
  for(const value of [-1,1.5,100001,'2']) assert.equal((await s.ro([{...labor,flaggedHoursHundredths:value as number}])).status,400);
});

test('P3 departments match GL cents before and after reversal; operational locations remain explicit',async()=>{
  const s=await setup();
  const p=(await s.part({location:'North'})).data;
  let ro=(await s.ro([{...labor,flaggedHoursHundredths:200},line(p.id)])).data;
  ro=(await s.call('PUT',`/service/repair-orders/${ro.id}`,{version:ro.version,status:'completed'})).data;
  await s.call('POST','/parts/sales',{partId:p.id,quantity:2,unitPriceCents:899});
  const q={from:'2026-10-24',to:'2026-10-24'};
  const compare=async()=>{
    const report=(await s.call('GET','/reports/departments',undefined,'A',q)).data;
    const gl=(await s.call('GET','/accounting/departmental',undefined,'A',q)).data;
    const {locations,...statement}=report; assert.deepEqual(statement,gl); return report;
  };
  const data=await compare();
  assert.equal(data.totals.income,35076); assert.equal(data.totals.expenses,1800);
  assert.deepEqual(data.locations.map((r:any)=>[r.location,r.roCount,r.counterCents]),[['No location',1,0],['North',0,1798]]);
  await s.call('PUT',`/service/repair-orders/${ro.id}`,{version:ro.version,status:'open'});
  assert.equal((await compare()).totals.income,1798);
});

test('P3 forecasts expose actual basis, change with tenant history, and reject insufficient history',async()=>{
  const s=await setup(), q={from:'2026-10-01',to:'2026-10-24'};
  const forecast=async(query=q)=>(await s.call('GET','/reports/forecasts',undefined,'A',query)).data;
  for(const p of Object.values(await forecast()) as any[]) {assert.equal(p.projection,null);assert.deepEqual(p.basis,{...q,sampleSize:0});assert.ok(p.insufficientReason);}
  const p=(await s.part()).data;
  for(let i=0;i<2;i++) {
    await s.call('POST','/parts/sales',{partId:p.id,quantity:2,unitPriceCents:899});
    const a=await s.call('POST','/service/appointments',{customerId:s.customers.A,scheduledStart:`2026-10-${i ? '12':'05'}T10:00:00Z`,scheduledEnd:`2026-10-${i ? '12':'05'}T11:00:00Z`,concern:'Service'}); assert.equal(a.status,201);
  }
  const before=await forecast(); assert.equal(before.parts.projection[0].unitsUsed,4);
  assert.equal(before.service.projection.find((d:any)=>d.day==='Monday').projectedAppointments,0.67);
  await s.call('POST','/parts/sales',{partId:p.id,quantity:3,unitPriceCents:899});
  await s.call('POST','/service/appointments',{customerId:s.customers.A,scheduledStart:'2026-10-19T10:00:00Z',scheduledEnd:'2026-10-19T11:00:00Z',concern:'Service'});
  const after=await forecast(); assert.equal(after.parts.basis.sampleSize,3);assert.equal(after.parts.projection[0].unitsUsed,7);
  assert.notDeepEqual(before.parts.projection,after.parts.projection);assert.notDeepEqual(before.service.projection,after.service.projection);
  assert.equal((await forecast({from:'2026-10-24',to:'2026-10-24'})).parts.projection,null);
  const defaults=(await s.call('GET','/reports/forecasts')).data;assert.deepEqual(defaults.service.basis,{from:'2026-08-30',to:'2026-10-24',sampleSize:3});
  assert.equal((await forecast({from:'2026-10-01',to:'2026-12-31'})).parts.basis.to,'2026-10-24');
  assert.equal((await s.call('GET','/reports/forecasts',undefined,'A',{from:'2026-11-01'})).data.inventory.projection,null);
});

test('P3 inventory days supply compares pace halves and responds to additional sold history',async()=>{
  const {forecasts}=await import('../src/reports-p3.js');
  const sold=(date:string)=>({status:'sold',history:[{status:'sold',timestamp:date}],updatedAt:date});
  const deals=[sold('2026-10-03'),sold('2026-10-20')];
  const repo={forecastRows:async()=>({currentStock:2,soldDates:deals.map(d=>d.updatedAt),scheduledStarts:[],parts:[],usage:[]}),
    list:async()=>{throw new Error('Unexpected full vehicle read');},crmList:async()=>{throw new Error('Unexpected full CRM read');}};
  const run=()=>forecasts(repo as any,{from:'2026-10-01',to:'2026-10-24'},new Date('2026-10-24T12:00:00Z'));
  assert.deepEqual((await run()).inventory.projection,{currentStock:2,daysSupply:24,earlierDaysSupply:24,changeDays:0});
  deals.push(sold('2026-10-22')); const data=(await run()).inventory;
  assert.deepEqual(data.projection,{currentStock:2,daysSupply:12,earlierDaysSupply:24,changeDays:-12}); assert.equal(data.basis.sampleSize,3);
});

test('P3 endpoints isolate tenants, validate range/method and preserve saved-definition outbox flow',async()=>{
  const s=await setup();await s.ro([labor]); const p=(await s.part()).data;
  await s.call('POST','/parts/sales',{partId:p.id,quantity:2,unitPriceCents:899});
  for(const endpoint of ['technicians','departments','forecasts']) {
    const path=`/reports/${endpoint}`;
    assert.equal((await s.call('GET',path,undefined,'B')).status,200);
    for(const query of [{from:'2026-02-30'},{from:'2026-10-25',to:'2026-10-01'},{unexpected:'yes'}]) assert.equal((await s.call('GET',path,undefined,'A',query)).status,400);
    assert.equal((await s.call('POST',path,{})).status,405);
  }
  assert.deepEqual((await s.call('GET','/reports/technicians',undefined,'B')).data.rows,[]);
  const other=(await s.call('GET','/reports/departments',undefined,'B')).data;
  assert.equal(other.totals.income,0); assert.deepEqual(other.locations,[]);
  for(const p of Object.values((await s.call('GET','/reports/forecasts',undefined,'B')).data) as any[]) {assert.equal(p.basis.sampleSize,0);assert.equal(p.projection,null);}
  for(const [dataset,columns] of [['technicians',['technician','soldHours','flaggedHours']],['departments',['department','income']],['locations',['location','counterCents']]] as const) {
    const saved=await s.call('POST','/reports/saved',{name:dataset,dataset,columns});assert.equal(saved.status,201);
    const run=await s.call('GET','/reports/custom',undefined,'A',{dataset,columns:columns.join(',')});assert.equal(run.status,200);assert.ok(run.data.rows.length);
    assert.equal(s.repositories.eventsForTest('A').filter(e=>e.aggregateId===saved.data.id && e.type==='saved-report.created').length,1);
    assert.equal((await s.call('GET',`/reports/saved/${saved.data.id}`,undefined,'B')).status,404);
  }
  assert.equal((await s.call('GET','/reports/saved')).data.length,3);
  assert.deepEqual((await s.call('GET','/reports/saved',undefined,'B')).data,[]);
});

test('forecast reads select compact inputs with exact boundaries, detached parts and tenant isolation in both backends', async t => {
  const {DynamoRepositories} = await import('../src/dynamo.js');
  const {QueryCommand} = await import('@aws-sdk/lib-dynamodb');
  const {forecasts} = await import('../src/reports-p3.js');
  const window = {from:'2026-10-01',to:'2026-10-24'}, now = '2026-10-24T12:00:00.000Z';
  const base = {tenantId:'A',version:1,createdAt:now,updatedAt:now};
  const records = [
    {kind:'deal',id:'first',status:'sold',history:[{status:'sold',timestamp:'2026-09-30T23:00:00-02:00'}]},
    {kind:'deal',id:'last',status:'sold',history:[{status:'sold',timestamp:'2026-09-01'},{status:'sold',timestamp:now}]},
    {kind:'deal',id:'fallback',status:'sold',history:[]},
    {kind:'deal',id:'old',status:'sold',history:[],updatedAt:'2026-09-30'},
    {kind:'deal',id:'future',status:'sold',history:[],updatedAt:'2026-10-25'},
    {kind:'deal',id:'working',status:'working',history:[]},
    ...['2026-09-30T23:59:59Z','2026-10-01T00:00:00Z',now,'2026-10-24T12:00:00.001Z','2026-10-25T00:00:00Z'].map((scheduledStart,i)=>({kind:'service-appointment',id:`a${i}`,status:'scheduled',scheduledStart})),
    {kind:'service-appointment',id:'no-show',status:'no-show',scheduledStart:now},
    {kind:'part',id:'p',...input,quantityReserved:2,location:'North'},
    // Insert RO before counter sales to check the old counter-then-RO ordering.
    {kind:'repair-order',id:'ro',stockApplied:true,lineItems:[line('p',3),labor,line(undefined)]},
    {kind:'repair-order',id:'reopened',stockApplied:false,lineItems:[line('p',99)]},
    {kind:'repair-order',id:'old-ro',createdAt:'2026-09-30',stockApplied:true,lineItems:[line('p',99)]},
    ...['2026-09-30','2026-10-01T00:00:00Z','2026-10-24T23:59:59Z','2026-10-25'].map((createdAt,i)=>({kind:'parts-sale',id:`s${i}`,createdAt,partId:'p',quantity:2})),
    {kind:'parts-sale',id:'missing-part',partId:'missing',quantity:1}
  ].map(row=>({...base,...row})) as CrmEntity[];
  const vehicles = ['available','sold','in-recon'].map((status,i)=>({...base,id:`v${i}`,status})) as Vehicle[];
  const memory = new MemoryRepositories();
  const repo = memory.forTenant('A');
  for (const record of records) await repo.crmWrite([{record,expectedVersion:0,event:{id:record.id,tenantId:'A',actorId:'u',aggregateId:record.id,aggregateVersion:1,type:`${record.kind}.created` as 'deal.created',occurredAt:now,deliveryStatus:'pending'}}]);
  for (const vehicle of vehicles) await repo.create(vehicle,{id:vehicle.id,tenantId:'A',actorId:'u',aggregateId:vehicle.id,aggregateVersion:1,type:'vehicle.created',occurredAt:now,deliveryStatus:'pending'});
  let pages = 0;
  const dynamo = new DynamoRepositories('offline', {send:async(command: InstanceType<typeof QueryCommand>)=>{
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.ConsistentRead,true);
    const values = command.input.ExpressionAttributeValues!;
    assert.ok(['TENANT#A','TENANT#B'].includes(values[':pk']));
    const prefix = values[':prefix'];
    const selected = values[':pk'] === 'TENANT#B' ? [] : prefix === 'VEHICLE#' ? vehicles : records.filter(r=>`${r.kind.toUpperCase()}#`===prefix);
    const offset = command.input.ExclusiveStartKey ? 1 : 0;
    pages++;
    return {Items:selected.slice(offset,offset ? undefined : 1).map(data=>({data})),...(!offset && selected.length>1 ? {LastEvaluatedKey:{PK:values[':pk'],SK:prefix}} : {})};
  }} as any);
  const expected = {currentStock:2,soldDates:['2026-10-01','2026-10-24','2026-10-24'],scheduledStarts:['2026-10-01T00:00:00Z',now,'2026-10-24T12:00:00.001Z'],parts:[records.find(r=>r.kind==='part')],usage:[{partId:'p',quantity:2},{partId:'p',quantity:2},{partId:'missing',quantity:1},{partId:'p',quantity:3}]};
  const clone = structuredClone;
  const spy = t.mock.method(globalThis,'structuredClone',(value:unknown)=>{
    assert.deepEqual(value,expected); // No full collections or discarded rows reach cloning.
    return clone(value);
  });
  assert.deepEqual(await repo.forecastRows(window),expected);
  spy.mock.restore();
  let report: string | undefined;
  for (const repositories of [memory,dynamo]) {
    const scoped = repositories.forTenant('A');
    assert.deepEqual(await scoped.forecastRows(window),expected);
    const guarded = new Proxy(scoped,{get(target,property){
      if (property==='list' || property==='crmList') return ()=>{throw new Error('Full collection read');};
      return Reflect.get(target,property);
    }});
    const result = await forecasts(guarded,window,new Date(now));
    assert.equal(result.service.basis.sampleSize,2);
    assert.equal(result.parts.basis.sampleSize,4);
    assert.equal(result.parts.projection![0].unitsUsed,7);
    if (report) assert.equal(JSON.stringify(result),report);
    report = JSON.stringify(result);
    assert.deepEqual(await repositories.forTenant('B').forecastRows(window),{currentStock:0,soldDates:[],scheduledStarts:[],parts:[],usage:[]});
  }
  assert.ok(pages>6);
  const detached = await repo.forecastRows(window); detached.parts[0].quantityOnHand=-1;
  assert.deepEqual(await repo.forecastRows(window),expected);
  const corrupt = new DynamoRepositories('offline',{send:async()=>({Items:[{data:{...vehicles[0],tenantId:'B'}}]})} as any);
  await assert.rejects(corrupt.forTenant('A').forecastRows(window),/scope/);
});

test('forecast cache refreshes after every relevant CRM kind and vehicle write', async () => {
  const repositories = new MemoryRepositories(), repo = repositories.forTenant('A');
  const window = {from:'2026-10-01',to:'2026-10-24'}, now = '2026-10-24T12:00:00.000Z';
  const base = {tenantId:'A',version:1,createdAt:now,updatedAt:now};
  let sequence = 0;
  const event = (id:string, version:number, type: import('@freedms/shared').OutboxEvent['type']) => ({id:`e${sequence++}`,tenantId:'A',actorId:'u',aggregateId:id,aggregateVersion:version,type,occurredAt:now,deliveryStatus:'pending' as const});
  const read = () => repositories.forTenant('A').forecastRows(window);
  const other = await repositories.forTenant('B').forecastRows(window);
  const records = [
    {kind:'deal',id:'d',status:'sold',history:[]},
    {kind:'service-appointment',id:'a',status:'scheduled',scheduledStart:now},
    {kind:'part',id:'p',...input},
    {kind:'parts-sale',id:'s',partId:'p',quantity:2},
    {kind:'repair-order',id:'r',stockApplied:true,lineItems:[line('p')]}
  ].map(row=>({...base,...row})) as CrmEntity[];
  for (const record of records) {
    const before = await read();
    await repo.crmWrite([{record,expectedVersion:0,event:event(record.id,1,`${record.kind}.created` as 'deal.created')}]);
    assert.notDeepEqual(await read(),before,record.kind);
    assert.deepEqual(await read(),await read());
  }
  const vehicle = {...base,id:'v',status:'available'} as Vehicle;
  assert.equal((await read()).currentStock,0);
  await repo.create(vehicle,event('v',1,'vehicle.created'));
  assert.equal((await read()).currentStock,1);
  await repo.update({...vehicle,version:2,status:'sold'},1,event('v',2,'vehicle.updated'));
  assert.equal((await read()).currentStock,0);
  await repo.update({...vehicle,version:3},2,event('v',3,'vehicle.updated'));
  assert.equal((await read()).currentStock,1);
  await repo.delete('v',3,event('v',4,'vehicle.deleted'));
  assert.equal((await read()).currentStock,0);
  assert.deepEqual(await repositories.forTenant('B').forecastRows(window),other);
  // More windows than the cache retains must still return the correct rows.
  for (let day=1;day<=6;day++) assert.deepEqual(await repo.forecastRows({...window,from:`2026-10-0${day}`}),await read());
});

test('cached forecast applies the appointment cutoff per request without intervening writes', async () => {
  const s = await setup(), q = {from:'2026-10-01',to:'2026-10-24'};
  for (const scheduledStart of ['2026-10-05T10:00:00.000Z','2026-10-24T12:00:00.001Z']) {
    assert.equal((await s.call('POST','/service/appointments',{customerId:s.customers.A,scheduledStart,scheduledEnd:scheduledStart.replace(/T\d\d:/,'T13:'),concern:'Service'})).status,201);
  }
  const read = async () => (await s.call('GET','/reports/forecasts',undefined,'A',q)).data.service;
  const before = await read();
  assert.equal(before.basis.sampleSize,1); assert.equal(before.projection,null);
  s.setTime('2026-10-24T12:00:00.001Z');
  const after = await read();
  assert.equal(after.basis.sampleSize,2);
  assert.equal(after.insufficientReason,null);
  assert.equal(after.projection.find((d:any)=>d.day==='Saturday').appointments,1);
  assert.equal(after.projection.find((d:any)=>d.day==='Monday').appointments,1);
  s.setTime('2026-10-24T12:00:00.000Z');
  assert.deepEqual(await read(),before);
});

test('irrelevant lead writes leave a populated forecast unchanged', async () => {
  const s = await setup();
  const p = (await s.part()).data;
  for (let i=0;i<2;i++) assert.equal((await s.call('POST','/parts/sales',{partId:p.id,quantity:2,unitPriceCents:899})).status,201);
  const read = async () => (await s.call('GET','/reports/forecasts')).data;
  const before = await read();
  assert.ok(before.parts.projection);
  assert.equal((await s.call('POST','/leads',{customerId:s.customers.A,source:'walk-in'})).status,201);
  assert.deepEqual(await read(),before);
});
