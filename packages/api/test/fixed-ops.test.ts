import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepairOrderLineItem, JournalEntry, AccountBalance } from '@freedms/shared';
import { MemoryRepositories } from '../src/memory.js';
import { createHandler, type ApiRequest } from '../src/handler.js';
import type { CrmWrite } from '../src/repository.js';
import { write } from '../src/accounting.js';
import { LocalTokens } from '../src/auth.js';
const input={partNumber:'FILTER-1',description:'Oil filter',binLocation:'A-1',costCents:450,retailPriceCents:899,quantityOnHand:20,reorderPoint:5};
const line=(partId?: string, quantity=2, id='line'): RepairOrderLineItem=>({id,kind:'parts',description:'Filter',partId,quantity,unitPriceCents:899,laborHoursHundredths:null,laborRateCents:null});
async function setup() {
  let now=new Date('2026-10-24T12:00:00Z');
  const repositories=new MemoryRepositories(), tokens=new LocalTokens('parts-test-secret-at-least-32-characters',()=>now.getTime());
  for(const tenantId of ['A','B']) await repositories.forTenant(tenantId).provision({id:tenantId,name:tenantId,createdAt:now.toISOString()},{id:`user${tenantId}`,name:tenantId},{tenantId,userId:`user${tenantId}`,role:'staff',active:true},{id:'provision',tenantId,actorId:`user${tenantId}`,aggregateId:tenantId,aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  let intercept: ((writes: CrmWrite[]) => void) | undefined;
  const forTenant = repositories.forTenant.bind(repositories);
  repositories.forTenant = tenantId => { const repo = forTenant(tenantId); return {...repo, crmWrite: async (writes, vehicles) => { intercept?.(writes); await repo.crmWrite(writes, vehicles); }}; };
  const handler=createHandler(repositories,{decode:async()=>{throw new Error('No network');}},()=>now);
  const call=async(method:string,path:string,body?:unknown,tenant='A',query?:ApiRequest['query'])=>{const r=await handler({method,path,body:body===undefined ? undefined:JSON.stringify(body),query,claims:tokens.verify(tokens.issue(`user${tenant}`,tenant))}); return {status:r.statusCode,...JSON.parse(r.body)};};
  const customers: Record<string,string>={};
  for(const tenant of ['A','B']) customers[tenant]=(await call('POST','/leads',{customer:{name:`Buyer ${tenant}`,phone:'',email:'',address:'',notes:'',consent:{status:'unknown',timestamp:null,source:''}},source:'walk-in'},tenant)).data.lead.customerId;
  const part=async(patch={},tenant='A')=>(await call('POST','/parts',{...input,...patch},tenant));
  const ro=async(items:RepairOrderLineItem[],tenant='A')=>call('POST','/service/repair-orders',{customerId:customers[tenant],payType:'customer-pay',lineItems:items},tenant);
  const stock=async(id:string)=>(await call('GET',`/parts/${id}`)).data.quantityOnHand;
  return {call,part,ro,stock,repositories,customers,handler,intercept:(fn?: (writes: CrmWrite[]) => void)=>{intercept=fn;},setTime:(s:string)=>{now=new Date(s);}};
}
const labor: RepairOrderLineItem = {id:'labor',kind:'labor',description:'Labor',laborHoursHundredths:255,laborRateCents:12345,quantity:null,unitPriceCents:null};
test('Fixed ops exact hand-verified posting, departmental tie-out, reports, isolation and outbox', async()=>{
  const {call,part,ro,repositories}=await setup(); const p=(await part({retailPriceCents:1234})).data;
  let r=(await ro([labor,{...line(p.id,3),unitPriceCents:1234},{...line(undefined,1,'free'),unitPriceCents:500}])).data;
  r=(await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'})).data;
  const entries=(await call('GET','/accounting/journal',undefined,'A',{repairOrderId:r.id})).data as JournalEntry[];
  assert.equal(entries.length,1); const entry=entries[0]; assert.equal(r.glPostingEntryId,entry.id);
  const amounts=(e:JournalEntry)=>e.lines.map(l=>[l.accountCode,l.debit,l.credit]);
  assert.deepEqual(amounts(entry),[['1150',35682,0],['5300',1350,0],['4300',0,31480],['4400',0,4202],['1300',0,1350]]);
  assert.equal(entry.lines.reduce((s,l)=>s+l.debit,0),37032);
  const service=(await call('GET','/accounting/departmental')).data.departments.find((d:{department:string})=>d.department==='service');
  assert.deepEqual([service.income,service.expenses,service.grossProfit],[35682,1350,34332]);
  const sale=(await call('POST','/parts/sales',{partId:p.id,quantity:2,unitPriceCents:899})).data;
  const counter=(await call('GET','/accounting/journal',undefined,'A',{partsSaleId:sale.id})).data[0];
  assert.deepEqual(amounts(counter),[['1150',1798,0],['5400',900,0],['4500',0,1798],['1300',0,900]]);
  assert.equal(counter.lines.reduce((s:number,l:{debit:number})=>s+l.debit,0),2698);
  const period={from:'2026-10-24',to:'2026-10-24'};
  const statement=(await call('GET','/accounting/departmental',undefined,'A',period)).data;
  assert.equal(statement.departments.find((d:{department:string})=>d.department==='parts').grossProfit,898);
  const trial=(await call('GET','/accounting/trial-balance',undefined,'A',period)).data;
  assert.equal(trial.totals.balanced,true);
  for(const [type,key] of [['income','income'],['expense','expenses']]) assert.equal(statement.totals[key],trial.rows.filter((r:AccountBalance)=>r.type===type).reduce((s:number,r:AccountBalance)=>s+r.balance,0));
  const inventory=trial.rows.find((r:AccountBalance)=>r.code==='1300'); assert.deepEqual([inventory.credit,inventory.balance],[2250,-2250]);
  assert.deepEqual((await call('GET','/reports/fixed-ops',undefined,'A',period)).data,{...period,roCount:1,laborCents:31480,partsCents:4202,roTotalCents:35682,counterSaleCount:1,counterTotalCents:1798,partsCostCents:2250,laborGrossCents:31480,partsGrossCents:3750});
  for(const query of [{},{repairOrderId:r.id},{partsSaleId:sale.id}]) assert.deepEqual((await call('GET','/accounting/journal',undefined,'B',query)).data,[]);
  assert.deepEqual((await call('GET','/accounting/departmental',undefined,'B')).data.totals,{income:0,expenses:0,grossProfit:0});
  assert.equal((await call('GET','/reports/fixed-ops',undefined,'B')).data.roCount,0);
  assert.equal((await call('GET','/reports/fixed-ops',undefined,'B')).data.counterTotalCents,0);
  assert.equal((await call('GET','/reports/fixed-ops',undefined,'A',{from:'2026-10-25'})).data.roCount,0);
  for(const path of ['/reports/fixed-ops','/accounting/departmental']) for(const query of [{from:'2026-02-30'},{from:'2026-10-25',to:'2026-10-24'},{bad:'x'}]) assert.equal((await call('GET',path,undefined,'A',query)).status,400);
  for(const id of [entry.id,counter.id]) { const events=repositories.eventsForTest('A').filter(e=>e.aggregateId===id); assert.equal(events.length,1); assert.deepEqual([events[0].type,events[0].tenantId,events[0].actorId],['journal-entry.created','A','userA']); }
});
test('RO postings repeat safely, reverse on reopen and edits, skip manual double reversals and empty entries',async()=>{
  const {call,ro,repositories}=await setup(); let r=(await ro([labor])).data;
  const save=async(patch={})=>{const result=await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,...patch});assert.equal(result.status,200,JSON.stringify(result));r=result.data;};
  const journal=async()=> (await call('GET','/accounting/journal',undefined,'A',{repairOrderId:r.id})).data as JournalEntry[];
  await save({status:'completed'}); const original=r.glPostingEntryId;
  await save(); await save({status:'picked-up'}); assert.equal((await journal()).length,1);
  await save({status:'open'}); let entries=await journal(); assert.equal(entries.length,2); assert.equal(r.glPosted,false);assert.equal(r.glPostingEntryId,null);
  assert.equal(entries.flatMap(e=>e.lines).filter(l=>l.accountCode==='4300').reduce((s,l)=>s+l.credit-l.debit,0),0);
  await save({status:'completed'}); assert.notEqual(r.glPostingEntryId,original);
  await save({lineItems:[{...labor,laborRateCents:10000}]}); entries=await journal(); assert.equal(entries.length,5);
  const reversed=new Set(entries.map(e=>e.reversesEntryId));assert.equal(entries.filter(e=>e.source==='service-posting'&&!reversed.has(e.id)).length,1);
  const manual=await call('POST',`/accounting/journal/${r.glPostingEntryId}/reverse`,{});assert.equal(manual.status,201);assert.equal(manual.data.repairOrderId,r.id);
  await save({status:'open'}); assert.equal((await journal()).length,6); await save();assert.equal((await journal()).length,6);
  await save({status:'completed',lineItems:[]});assert.equal(r.glPosted,false);assert.equal((await journal()).length,6);
  for(const patch of [{glPosted:true},{glPostingEntryId:'fake'},{glPostingPending:true},{glPendingEntries:[]}]) assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,...patch})).status,400);
  for(const e of (await journal()).filter(e=>e.source==='reversal')) assert.ok(repositories.eventsForTest('A').some(event=>event.aggregateId===e.id&&event.type==='journal-entry.created'&&event.actorId==='userA'&&event.tenantId==='A'));
});
test('Zero retail stocked parts post cost, all pay types post, and unsafe cost fails before stock or RO changes',async()=>{
  const {call,part,ro,stock}=await setup();const p=(await part()).data;
  for(const payType of ['customer-pay','internal','warranty']) {
    let r=(await ro([{...line(p.id,1),unitPriceCents:0}])).data;
    const done=await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed',payType});assert.equal(done.status,200);r=done.data;
    const entry=(await call('GET','/accounting/journal',undefined,'A',{repairOrderId:r.id})).data[0];assert.deepEqual(entry.lines.map((l:{accountCode:string})=>l.accountCode),['5300','1300']);
  }
  const huge=(await part({partNumber:'HUGE',costCents:10_000_000_000,quantityOnHand:1_000_000})).data;
  assert.ok(huge);
  const r=(await ro(Array.from({length:10},(_,i)=>({...line(huge.id,100000,String(i)),unitPriceCents:0})))).data;
  assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:1,status:'completed'})).status,400);
  assert.equal(await stock(huge.id),1_000_000);assert.equal((await call('GET',`/service/repair-orders/${r.id}`)).data.version,1);
  assert.deepEqual((await call('GET','/accounting/journal',undefined,'A',{repairOrderId:r.id})).data,[]);
  assert.equal((await call('POST','/parts/sales',{partId:huge.id,quantity:1_000_000,unitPriceCents:0})).status,400);assert.equal(await stock(huge.id),1_000_000);
  const zero=(await part({partNumber:'ZERO',costCents:0,retailPriceCents:0})).data;
  const sale=await call('POST','/parts/sales',{partId:zero.id,quantity:1});assert.equal(sale.status,201);
  assert.deepEqual((await call('GET','/accounting/journal',undefined,'A',{partsSaleId:sale.data.id})).data,[]);
});
test('Department mapping includes custom P&L accounts as other and excludes balance sheet accounts',async()=>{
  const {accountDepartment,departments}=await import('@freedms/shared');
  assert.deepEqual(departments,['sales','service','parts','other']);
  for(const code of ['4000','4100','4200','5000','5100']) assert.equal(accountDepartment(code),'sales');
  for(const code of ['4300','4400','5300']) assert.equal(accountDepartment(code),'service');
  for(const code of ['4500','5400']) assert.equal(accountDepartment(code),'parts');
  assert.equal(accountDepartment('4999'),'other');
  const {call}=await setup();
  assert.equal((await call('POST','/accounting/accounts',{code:'4999',name:'Custom income',type:'income'})).status,201);
  const statement=(await call('GET','/accounting/departmental')).data;
  assert.ok(statement.departments.every((d:{rows:AccountBalance[]})=>d.rows.every(r=>r.type==='income'||r.type==='expense')));
});


test('RO journal failure rolls back stock, RO version and outbox in the normal transaction', async()=>{
  const {call,part,ro,stock,repositories,intercept}=await setup();
  const p=(await part()).data, r=(await ro([line(p.id)])).data;
  const before=await repositories.forTenant('A').crmGet('repair-order',r.id);
  const events=repositories.eventsForTest('A').filter(e=>[r.id,p.id].includes(e.aggregateId));
  let attempted=false;
  intercept(writes=>{if(writes.some(w=>w.record.kind==='journal-entry')) {
    attempted=true;
    assert.ok(writes.some(w=>w.record.kind==='repair-order'));
    assert.ok(writes.some(w=>w.record.kind==='part'));
    throw new Error('Injected journal failure');
  }});
  assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,status:'completed'})).status,500);
  assert.equal(attempted,true);
  assert.deepEqual(await repositories.forTenant('A').crmGet('repair-order',r.id),before);
  assert.equal(await stock(p.id),20);
  assert.deepEqual(await repositories.forTenant('A').crmList('journal-entry'),[]);
  assert.deepEqual(repositories.eventsForTest('A').filter(e=>[r.id,p.id].includes(e.aggregateId)),events);
  intercept();
  assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,status:'completed'})).status,200);
  assert.equal(await stock(p.id),18);
});

test('Oversized RO edit retains reversal and posting intent and ordinary saves repair every interruption',async()=>{
  // Also cover entries already committed before the pending flag was cleared,
  // and a reopen/edit while the missing entries are still pending.
  for(const recovery of ['retry','entries-exist','manual-reversal','reopen','edit']) {
    const {call,part,ro,stock,repositories,intercept}=await setup();
    const parts=[];
    for(let i=0;i<9;i++) parts.push((await part({partNumber:`PART-${i}`})).data);
    let r=(await ro(parts.map((p,i)=>line(p.id,1,String(i))))).data;
    r=(await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,status:'completed'})).data;
    assert.equal(r.glPosted,true);
    const original=r.glPostingEntryId;
    intercept(writes=>{if(writes.some(w=>w.record.kind==='journal-entry')) throw new Error('Injected follow-up failure');});
    const failed=await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,lineItems:parts.map((p,i)=>line(p.id,2,String(i)))});
    assert.equal(failed.status,500);
    r=(await call('GET',`/service/repair-orders/${r.id}`)).data;
    assert.equal(r.glPosted,false); assert.equal(r.glPostingPending,true);
    assert.equal(r.glPendingEntries.length,2);
    const intended=r.glPostingEntryId;
    for(const p of parts) assert.equal(await stock(p.id),18);
    intercept();
    const repo=repositories.forTenant('A');
    if(recovery==='entries-exist') await repo.crmWrite(r.glPendingEntries.map((e:JournalEntry)=>write(e,{tenantId:'A',userId:'userA',role:'staff'})));
    if(recovery==='manual-reversal') assert.equal((await call('POST',`/accounting/journal/${original}/reverse`,{})).status,201);
    const patch=recovery==='reopen' ? {status:'open'} : recovery==='edit' ? {lineItems:parts.map((p,i)=>line(p.id,3,String(i)))} : {};
    const repaired=await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,...patch});
    assert.equal(repaired.status,200,JSON.stringify(repaired)); r=repaired.data;
    assert.equal(r.glPosted,recovery!=='reopen'); assert.equal(r.glPostingPending,false);
    assert.deepEqual(r.glPendingEntries,[]);
    if(recovery==='retry'||recovery==='entries-exist') assert.equal(r.glPostingEntryId,intended);
    let entries=await repo.crmList('journal-entry');
    const reversed=new Set(entries.map(e=>e.reversesEntryId));
    assert.ok(reversed.has(original));
    assert.equal(entries.filter(e=>e.source==='service-posting'&&!reversed.has(e.id)).length,recovery==='reopen'?0:1);
    assert.equal(entries.length,recovery==='reopen'?2:3);
    assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version})).status,200);
    assert.deepEqual(await repo.crmList('journal-entry'),entries);
    for(const e of entries) assert.equal(repositories.eventsForTest('A').filter(event=>event.aggregateId===e.id).length,1);
    assert.equal((await call('GET','/accounting/trial-balance')).data.totals.balanced,true);
    assert.deepEqual(await repositories.forTenant('B').crmList('journal-entry'),[]);
  }
});

test('Legacy dangling RO posting repairs finalized saves and permits reopen or edited lines',async()=>{
  for(const action of ['save','reopen','edit']) {
    const {call,ro,repositories}=await setup();
    let r=(await ro([labor])).data;
    const repo=repositories.forTenant('A'), old=(await repo.crmGet('repair-order',r.id))!;
    const corrupt={...old,version:old.version+1,status:'completed' as const,glPosted:true,glPostingEntryId:'missing-entry'};
    await repo.crmWrite([{record:corrupt,expectedVersion:old.version,event:{id:`corrupt-${action}`,tenantId:'A',actorId:'userA',aggregateId:old.id,aggregateVersion:corrupt.version,type:'repair-order.updated',occurredAt:old.updatedAt,deliveryStatus:'pending'}}]);
    const patch=action==='reopen'?{status:'open'}:action==='edit'?{lineItems:[{...labor,laborRateCents:10000}]}:{};
    const result=await call('PUT',`/service/repair-orders/${r.id}`,{version:corrupt.version,...patch});
    assert.equal(result.status,200,JSON.stringify(result)); r=result.data;
    assert.equal(r.glPosted,action!=='reopen'); assert.equal(r.glPostingPending,false);
    const entries=await repo.crmList('journal-entry');
    assert.equal(entries.length,action==='reopen'?0:1);
    assert.ok(entries.every(e=>e.source==='service-posting'));
    if(action==='reopen') assert.equal(r.glPostingEntryId,null);
    else assert.equal(r.glPostingEntryId,entries[0].id);
  }
});


test('Journal entries take the last transaction slot before appointment synchronization',async()=>{
  const {call,part,customers,intercept}=await setup();
  const appointment=(await call('POST','/service/appointments',{customerId:customers.A,scheduledStart:'2026-10-24T12:00:00Z',scheduledEnd:'2026-10-24T13:00:00Z'})).data;
  const items=[];
  for(let i=0;i<8;i++) items.push(line((await part({partNumber:`SLOT-${i}`})).data.id,1,String(i)));
  const created=await call('POST','/service/repair-orders',{appointmentId:appointment.id,customerId:customers.A,payType:'customer-pay',lineItems:items});
  assert.equal(created.status,201);
  const r=created.data;
  let journalBatch=false, appointmentBatch=false;
  intercept(writes=>{
    if(writes.some(w=>w.record.kind==='journal-entry')) {
      journalBatch=true; assert.equal(writes.length,10);
      assert.equal(writes.filter(w=>w.record.kind==='part').length,8);
      assert.ok(writes.some(w=>w.record.kind==='repair-order'));
      assert.ok(!writes.some(w=>w.record.kind==='service-appointment'));
    }
    if(writes.some(w=>w.record.kind==='service-appointment')) {assert.equal(journalBatch,true);appointmentBatch=true;}
  });
  assert.equal((await call('PUT',`/service/repair-orders/${r.id}`,{version:r.version,status:'completed'})).status,200);
  assert.equal(journalBatch,true); assert.equal(appointmentBatch,true);
  assert.equal((await call('GET',`/service/appointments/${appointment.id}`)).data.status,'done');
});
