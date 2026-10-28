import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepairOrderLineItem } from '@freedms/shared';
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
  const repo={leadListPage: async () => { throw new Error('Unexpected lead page read'); }, listPage:async()=>{throw new Error('Unexpected vehicle page read');},list:async()=>[{status:'available'},{status:'available'}],crmList:async(kind:string)=>kind==='deal'?deals:[]};
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
