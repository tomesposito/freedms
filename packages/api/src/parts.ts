import { reservationActive, reservationStatus } from '@freedms/shared';
import { partsDepth } from './parts-depth.js';
import { ensureDefaultAccounts, write } from './accounting.js';
import { fixedPosting } from './fixed-ops.js';
import { randomUUID } from 'node:crypto';
import type { Part, PartsSale, Principal, RepairOrder, OutboxEvent } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, text, money, version } from './validation.js';
import type { CrmWrite, TenantRepository } from './repository.js';
export function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw invalid(`${label} must be an integer at least ${min}.`);
  return value;
}
export function negativeOverride(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw invalid('allowNegativeStock must be a boolean.');
  return value === true;
}
export function reservedOverride(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw invalid('acknowledgeReservedStock must be a boolean.');
  return value === true;
}
export function stockEvent(principal: Principal, time: string, record: Part | PartsSale, causeId?: string): OutboxEvent {
  return {id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:record.id,aggregateVersion:record.version,type:record.kind === 'parts-sale' ? 'parts-sale.created' : record.version === 1 ? 'part.created' : 'part.updated',occurredAt:time,deliveryStatus:'pending',...(causeId ? {causeId} : {})};
}
function stockChange(part: Part, delta: number, override: boolean, time: string) {
  const quantityOnHand = part.quantityOnHand + delta;
  if (!Number.isSafeInteger(quantityOnHand)) throw invalid(`Stock quantity too large for ${part.partNumber}.`);
  if (delta < 0 && quantityOnHand < 0 && !override) throw invalid(`Insufficient stock for ${part.partNumber}. Explicit negative-stock override required.`);
  return {...part,quantityOnHand,version:part.version+1,updatedAt:time};
}
export async function reconcileStock(repo: TenantRepository, principal: Principal, time: string, old: RepairOrder | undefined, record: RepairOrder, override: boolean, acknowledgeReservedStock: boolean): Promise<CrmWrite[]> {
  const finalized = ['completed','picked-up'].includes(record.status);
  const delta = new Map<string,number>();
  for (const line of record.lineItems) if (line.partId && !(await repo.crmGet('part',line.partId))) throw invalid('Part must belong to this workspace.');
  const apply = (ro: RepairOrder, sign: number) => { for (const line of ro.lineItems) if (line.partId) delta.set(line.partId,(delta.get(line.partId) ?? 0)+sign*line.quantity!); };
  if (old?.stockApplied) apply(old,1);
  if (finalized) apply(record,-1);
  const changes = [...delta].filter(([,n])=>n!==0);
  if (changes.length > 9) throw invalid('Stock save exceeds transaction limit: at most 9 affected stocked parts per repair-order save.');
  record.stockApplied = finalized;
  record.stockWarning = finalized && old?.stockApplied ? old.stockWarning ?? null : null;
  record.reservedStockWarning = finalized && old?.stockApplied ? old.reservedStockWarning ?? null : null;
  const reservedParts: NonNullable<RepairOrder['reservedStockWarning']>['parts'] = [];
  const orders = changes.some(([,amount])=>amount<0) ? await repo.crmList('parts-po') : [];
  const reservations = changes.length ? (await repo.crmList('parts-reservation')).filter(r=>r.repairOrderId===record.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)) : [];
  const writes: CrmWrite[] = [];
  for (const [id,amount] of changes) {
    const part = await repo.crmGet('part',id); if (!part) throw invalid('Part must belong to this workspace.');
    const updated = stockChange(part,amount,override,time);
    if (amount < 0) {
      const reservedForThisRo = orders.flatMap(po=>po.lines).filter(line=>line.partId===part.id && line.specialOrder?.repairOrderId===record.id).reduce((sum,line)=>sum+line.quantityReserved,0)+reservations.filter(r=>r.partId===id).reduce((sum,r)=>sum+reservationActive(r),0);
      const reservedForOthers = Math.max(0,(part.quantityReserved ?? 0)-reservedForThisRo);
      if (reservedForOthers > 0 && updated.quantityOnHand < reservedForOthers) reservedParts.push({partId:part.id,partNumber:part.partNumber,quantityReserved:reservedForOthers});
    }
    if (amount < 0 && updated.quantityOnHand < 0) record.stockWarning = `Negative stock explicitly allowed for ${part.partNumber}.` + (record.stockWarning ? ` ${record.stockWarning}` : '');
    // Consume and restore oldest first, with stable id ordering for equal timestamps.
    let remaining=Math.abs(amount);
    for(const reservation of reservations.filter(r=>r.partId===id)) {
      const quantity=Math.min(remaining,amount<0 ? reservationActive(reservation) : reservation.quantityConsumed);
      if(!quantity) continue;
      const changed={...reservation,quantityConsumed:reservation.quantityConsumed+(amount<0 ? quantity : -quantity),version:reservation.version+1,updatedAt:time};
      changed.status=reservationStatus(changed,'consumed');
      updated.quantityReserved=integer((updated.quantityReserved ?? 0)+(amount<0 ? -quantity : quantity),'Reserved');
      writes.push({record:changed,expectedVersion:reservation.version,event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:changed.id,aggregateVersion:changed.version,type:'parts-reservation.updated',occurredAt:time,deliveryStatus:'pending',causeId:record.id}});
      remaining-=quantity;if(!remaining) break;
    }
    writes.push({record:updated,expectedVersion:part.version,event:stockEvent(principal,time,updated,record.id)});
  }
  if(writes.length>38) throw invalid('Stock save exceeds transaction limit: too many on-hand reservations affected.');
  if (reservedParts.length) {
    if (!acknowledgeReservedStock) throw invalid(`Stock is reserved for other special orders: ${reservedParts.map(p=>`${p.partNumber} (${p.quantityReserved} reserved)`).join(', ')}. Explicit reserved-stock acknowledgement required.`);
    record.reservedStockWarning = {parts:reservedParts,acknowledgedBy:principal.userId,acknowledgedAt:time};
  }
  return writes;
}
export async function parts(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path=request.path.replace(/\/$/,''), method=request.method.toUpperCase(), time=now.toISOString(), q=request.query ?? {};
  if (/^\/parts\/(purchase-orders|returns|pricing-matrix|pricing-proposal|reservations)(?:\/|$)/.test(path)) return partsDepth(request,principal,repo,now);
  const match=/^\/parts(?:\/(sales)(?:\/([^/]+))?|\/([^/]+))?$/.exec(path); if (!match) throw missing();
  const sale=!!match[1], id=match[2] || match[3]; if(id) requireId(id);
  if (!(id ? sale ? ['GET'] : ['GET','PUT'] : ['GET','POST']).includes(method)) throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  onlyKeys(q,method==='GET' && !id && !sale ? ['search','reorder','location'] : []);
  if (method==='GET') {
    if(id) { const row= sale ? await repo.crmGet('parts-sale',id) : await repo.crmGet('part',id); if(!row) throw missing(); return response(200,{data:row}); }
    if(sale) return response(200,{data:(await repo.crmList('parts-sale')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))});
    if(q.reorder!==undefined && !['true','false'].includes(q.reorder)) throw invalid('Reorder must be true or false.');
    const search=text(q.search ?? '','Search',200,true).toLowerCase();
    return response(200,{data:(await repo.crmList('part')).filter(p=>(q.reorder!=='true'||p.quantityOnHand<=p.reorderPoint)&&(q.location===undefined||(p.location ?? '')===q.location)&&[p.partNumber,p.description,p.binLocation,p.location ?? ''].some(v=>v.toLowerCase().includes(search))).sort((a,b)=>(q.reorder==='true' ? (a.quantityOnHand-a.reorderPoint)-(b.quantityOnHand-b.reorderPoint) : 0)||a.partNumber.localeCompare(b.partNumber))});
  }
  requireWrite(principal,method); const b=parseBody(request.body);
  const base={id:randomUUID(),tenantId:principal.tenantId,version:1,createdAt:time,updatedAt:time};
  if(sale) {
    onlyKeys(b,['partId','quantity','customerId','unitPriceCents','allowNegativeStock']);
    const override=negativeOverride(b.allowNegativeStock), part=await repo.crmGet('part',requireId(b.partId)); if(!part) throw invalid('Part must belong to this workspace.');
    const quantity=integer(b.quantity,'Quantity',1), unitPriceCents=b.unitPriceCents===undefined ? part.retailPriceCents : money(b.unitPriceCents,'Unit price'), totalCents=quantity*unitPriceCents;
    if(!Number.isSafeInteger(totalCents)) throw invalid('Sale total is too large.');
    const customerId=b.customerId==null ? null : requireId(b.customerId), customer=customerId ? await repo.crmGet('customer',customerId) : undefined;
    if(customerId && !customer) throw invalid('Customer must belong to this workspace.');
    if ((part.quantityReserved ?? 0)>0 && part.quantityOnHand-quantity<part.quantityReserved) throw invalid(`Stock is reserved for ${part.partNumber}.`);
    const updated=stockChange(part,-quantity,override,time), stockNegative=updated.quantityOnHand<0;
    const record: PartsSale={...base,kind:'parts-sale',partId:part.id,partNumber:part.partNumber,description:part.description,quantity,unitPriceCents,totalCents,customerId,customerName:customer?.name ?? null,stockNegative,stockWarning:stockNegative ? `Negative stock explicitly allowed for ${part.partNumber}.` : null};
    const entry = fixedPosting(record, await ensureDefaultAccounts(repo, principal, now), quantity * part.costCents, now);
    await repo.crmWrite([...(entry ? [write(entry, principal)] : []), {record,expectedVersion:0,event:stockEvent(principal,time,record)},{record:updated,expectedVersion:part.version,event:stockEvent(principal,time,updated,record.id)}]);
    return response(201,{data:record});
  }
  onlyKeys(b,['partNumber','description','location','binLocation','costCents','retailPriceCents','quantityOnHand','reorderPoint',...(id ? ['version'] : [])]);
  const old=id ? await repo.crmGet('part',id) : undefined; if(id && !old) throw missing();
  const expected=old ? version(b.version) : 0; if(old && old.version!==expected) throw conflict();
  const merged={...old,...b};
  const record: Part={...base,id:old?.id ?? base.id,createdAt:old?.createdAt ?? time,version:expected+1,kind:'part',location:text(merged.location === undefined ? '' : merged.location, 'Location',100,true),quantityReserved:old?.quantityReserved ?? 0,partNumber:text(merged.partNumber,'Part number',100),description:text(merged.description,'Description',200),binLocation:text(merged.binLocation,'Bin location',100,true),costCents:money(merged.costCents,'Cost'),retailPriceCents:money(merged.retailPriceCents,'Retail price'),quantityOnHand:integer(merged.quantityOnHand,'Quantity on hand'),reorderPoint:integer(merged.reorderPoint,'Reorder point')};
  if(record.quantityOnHand<record.quantityReserved) throw invalid('Stock is reserved.');
  if((await repo.crmList('part')).some(p=>p.id!==record.id && p.partNumber===record.partNumber)) throw invalid('Part number already exists in this workspace.');
  await repo.crmWrite([{record,expectedVersion:expected,event:stockEvent(principal,time,record)}]);
  return response(old ? 200 : 201,{data:record});
}
