import { randomUUID } from 'node:crypto';
import type { CrmEntity, Part, PartsPurchaseOrder, PartsReturn, PricingMatrix, Principal, PurchaseOrderLine } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { invalid, onlyKeys, object, text, money, version } from './validation.js';
import { integer, stockEvent } from './parts.js';
import type { CrmWrite, TenantRepository } from './repository.js';

export async function partsDepth(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path=request.path.replace(/\/$/,''), method=request.method.toUpperCase(), time=now.toISOString(), q=request.query ?? {};
  const match=/^\/parts\/(purchase-orders|returns|pricing-matrix|pricing-proposal)(?:\/([^/]+)(?:\/(receive|special-fulfill))?)?$/.exec(path);
  if(!match) throw missing();
  const [,family,id,action]=match;
  const singleton=family==='pricing-matrix'||family==='pricing-proposal';
  if(singleton && id || family==='returns' && action) throw missing();
  if(id) requireId(id);
  const allowed=family==='pricing-proposal' ? ['GET'] : family==='pricing-matrix' ? ['GET','PUT'] : action ? ['POST'] : id ? ['GET'] : ['GET','POST'];
  if(!allowed.includes(method)) throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  onlyKeys(q,family==='pricing-proposal' ? ['costCents'] : []);
  const kind=family==='returns' ? 'parts-return' : 'parts-po';
  if(method==='GET') {
    if(singleton) {
      const matrix=await repo.crmGet('pricing-matrix','pricing-matrix');
      if(family==='pricing-matrix') return response(200,{data:matrix ?? {enabled:false,brackets:[]}});
      if(!/^\d+$/.test(q.costCents ?? '')) throw invalid('Cost must be integer cents.');
      const costCents=money(Number(q.costCents),'Cost'), bracket=matrix?.enabled ? matrix.brackets.find(b=>b.maxCostCents===null||b.maxCostCents>=costCents) : undefined;
      // BigInt keeps half-up exact even at the largest allowed cost and markup.
      const proposedRetailCents=bracket ? Number((BigInt(costCents)*BigInt(10000+bracket.markupBps)+5000n)/10000n) : null;
      return response(200,{data:{costCents,proposedRetailCents,markupBps:bracket?.markupBps ?? null}});
    }
    if(id) {const row=await repo.crmGet(kind,id); if(!row) throw missing(); return response(200,{data:row});}
    return response(200,{data:(await repo.crmList(kind)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id))});
  }
  requireWrite(principal,method);
  const b=parseBody(request.body), base={id:randomUUID(),tenantId:principal.tenantId,version:1,createdAt:time,updatedAt:time};
  const write=(record: Extract<CrmEntity,{kind:'parts-po'|'parts-return'|'pricing-matrix'}>, expectedVersion: number): CrmWrite=>({record,expectedVersion,event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:record.id,aggregateVersion:record.version,type:record.kind==='parts-return' ? 'parts-return.created' : `${record.kind}.${expectedVersion ? 'updated':'created'}`,occurredAt:time,deliveryStatus:'pending'}});
  const partWrite=(part: Part, causeId: string): CrmWrite=>({record:part,expectedVersion:part.version-1,event:stockEvent(principal,time,part,causeId)});
  if(family==='pricing-matrix') {
    onlyKeys(b,['version','enabled','brackets']);
    const old=await repo.crmGet('pricing-matrix','pricing-matrix'), expected=integer(b.version,'Version');
    if(expected!==(old?.version ?? 0)) throw conflict();
    if(typeof b.enabled!=='boolean'||!Array.isArray(b.brackets)||b.brackets.length>10) throw invalid('Matrix requires enabled and at most 10 brackets.');
    const bracketCount=b.brackets.length; let previous=-1;
    const brackets=b.brackets.map((value,i)=>{const row=object(value);onlyKeys(row,['maxCostCents','markupBps']);const cap=row.maxCostCents===null ? null : money(row.maxCostCents,'Maximum cost'), markupBps=integer(row.markupBps,'Markup');
      if(markupBps>100000||cap===null&&i!==bracketCount-1||cap!==null&&cap<=previous) throw invalid('Brackets must have increasing caps, an optional final unbounded cap, and markup at most 100000 basis points.');
      if(cap!==null) previous=cap; return {maxCostCents:cap,markupBps};});
    const record:PricingMatrix={...base,id:'pricing-matrix',createdAt:old?.createdAt ?? time,version:expected+1,kind:'pricing-matrix',enabled:b.enabled,brackets};
    await repo.crmWrite([write(record,expected)]);return response(200,{data:record});
  }
  if(family==='returns') {
    onlyKeys(b,['partId','vendorName','quantity','reason','purchaseOrderId','costCents']);
    const part=await repo.crmGet('part',requireId(b.partId));if(!part) throw invalid('Part must belong to this workspace.');
    const quantity=integer(b.quantity,'Quantity',1), costCents=b.costCents===undefined ? part.costCents : money(b.costCents,'Cost');
    if(quantity>part.quantityOnHand-(part.quantityReserved ?? 0)) throw invalid(`Insufficient unreserved stock for ${part.partNumber}.`);
    const purchaseOrderId=b.purchaseOrderId==null ? null : requireId(b.purchaseOrderId);
    if(purchaseOrderId && !await repo.crmGet('parts-po',purchaseOrderId)) throw invalid('Purchase order must belong to this workspace.');
    const record:PartsReturn={...base,kind:'parts-return',partId:part.id,vendorName:text(b.vendorName,'Vendor',200),quantity,reason:text(b.reason,'Reason',1000),purchaseOrderId,costCents,totalValueCents:integer(quantity*costCents,'Return value')};
    await repo.crmWrite([write(record,0),partWrite({...part,quantityOnHand:part.quantityOnHand-quantity,version:part.version+1,updatedAt:time},record.id)]);
    return response(201,{data:record});
  }
  if(!id) {
    onlyKeys(b,['vendorName','lines']);
    if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>8) throw invalid('Purchase orders require 1 to 8 lines.');
    const lines:PurchaseOrderLine[]=[], seen=new Set<string>();
    for(const value of b.lines) {
      const row=object(value);onlyKeys(row,['partId','quantityOrdered','costCents','specialOrder']);
      const partId=requireId(row.partId);if(seen.has(partId)||!await repo.crmGet('part',partId)) throw invalid('Each part must belong to this workspace and appear only once.');seen.add(partId);
      let specialOrder:PurchaseOrderLine['specialOrder']=null;
      if(row.specialOrder!=null) {
        const special=object(row.specialOrder);onlyKeys(special,['customerId','repairOrderId']);
        const customerId=special.customerId==null ? null : requireId(special.customerId), repairOrderId=special.repairOrderId==null ? null : requireId(special.repairOrderId);
        const customer=customerId ? await repo.crmGet('customer',customerId) : undefined, ro=repairOrderId ? await repo.crmGet('repair-order',repairOrderId) : undefined;
        if(!customerId&&!repairOrderId||customerId&&!customer||repairOrderId&&!ro) throw invalid('Special order requires a customer or repair order in this workspace.');
        const snapshot=customer ?? (ro ? await repo.crmGet('customer',ro.customerId) : undefined);
        specialOrder={customerId,repairOrderId,customerName:snapshot?.name ?? null};
      }
      lines.push({id:randomUUID(),partId,quantityOrdered:integer(row.quantityOrdered,'Ordered quantity',1),quantityReceived:0,costCents:money(row.costCents,'Cost'),specialOrder,quantityReserved:0,quantityFulfilled:0,fulfilled:false});
    }
    const record:PartsPurchaseOrder={...base,kind:'parts-po',vendorName:text(b.vendorName,'Vendor',200),status:'open',lines};
    await repo.crmWrite([write(record,0)]);return response(201,{data:record});
  }
  onlyKeys(b,action==='receive' ? ['version','lines'] : ['version','lineId']);
  const old=await repo.crmGet('parts-po',id);if(!old) throw missing();
  const expected=version(b.version);if(old.version!==expected) throw conflict();
  const record:PartsPurchaseOrder={...old,version:expected+1,updatedAt:time,lines:old.lines.map(line=>({...line}))}, writes:CrmWrite[]=[];
  const changes: {lineId:string;quantity:number}[]=[];
  if(action==='receive') {
    if(old.status==='received') throw invalid('Purchase order is fully received.');
    if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>8) throw invalid('Receive requires 1 to 8 lines.');
    for(const value of b.lines) {const row=object(value);onlyKeys(row,['lineId','quantity']);changes.push({lineId:requireId(row.lineId),quantity:integer(row.quantity,'Quantity',1)});}
  } else changes.push({lineId:requireId(b.lineId),quantity:0});
  const seen=new Set<string>();
  for(const change of changes) {
    const line=record.lines.find(l=>l.id===change.lineId);if(!line||seen.has(line.id)) throw invalid('Unknown or duplicate line.');seen.add(line.id);
    const part=await repo.crmGet('part',line.partId);if(!part) throw invalid('Part must belong to this workspace.');
    const updated={...part,quantityReserved:part.quantityReserved ?? 0,version:part.version+1,updatedAt:time};
    if(action==='receive') {
      if(change.quantity>line.quantityOrdered-line.quantityReceived) throw invalid('Quantity exceeds outstanding order.');
      updated.quantityOnHand=integer(part.quantityOnHand+change.quantity,'Stock',-Number.MAX_SAFE_INTEGER);updated.costCents=line.costCents;line.quantityReceived+=change.quantity;
      if(line.specialOrder) {updated.quantityReserved=integer(updated.quantityReserved+change.quantity,'Reserved');line.quantityReserved+=change.quantity;line.fulfilled=false;}
    } else {
      if(!line.specialOrder||line.quantityReserved<1) throw invalid('No arrived, unfulfilled special order quantity.');
      if(updated.quantityReserved<line.quantityReserved||updated.quantityOnHand<line.quantityReserved) throw invalid('Reserved stock is no longer available.');
      updated.quantityOnHand-=line.quantityReserved;updated.quantityReserved-=line.quantityReserved;line.quantityFulfilled+=line.quantityReserved;line.quantityReserved=0;line.fulfilled=true;
    }
    writes.push(partWrite(updated,record.id));
  }
  record.status=record.lines.every(l=>l.quantityReceived===l.quantityOrdered) ? 'received' : record.lines.some(l=>l.quantityReceived>0) ? 'partially-received' : 'open';
  await repo.crmWrite([...writes,write(record,expected)]);return response(200,{data:record});
}
