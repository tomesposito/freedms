import { serviceCatalog, dispatch, inspect } from './service-depth.js';
import type { DocumentStore } from './document-store.js';
import { reconcilePosting } from './fixed-ops.js';
import { reconcileStock, negativeOverride } from './parts.js';
import { randomUUID } from 'node:crypto';
import { serviceSkills, maxDocumentBytes, appointmentStatuses, repairOrderPayTypes, repairOrderStatuses, repairOrderTotals, type ServiceAppointment, type RepairOrder, type RepairOrderLineItem, type Principal, type ServiceBoardDay } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice, timestamp } from './crm-validation.js';
import { invalid, object, onlyKeys, text, money, version } from './validation.js';
import type { TenantRepository } from './repository.js';
const view = (r: RepairOrder) => ({...r, totals: repairOrderTotals(r.lineItems)});
function date(value: unknown): string {
  const s = text(value, 'Date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10) !== s) throw invalid('Provide a real calendar date.');
  return s;
}
async function lineItems(value: unknown, repo: TenantRepository): Promise<RepairOrderLineItem[]> {
  if (!Array.isArray(value) || value.length > 100) throw invalid('Provide at most 100 line items.');
  const ids = new Set<string>();
  const count = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100000) throw invalid('Hours / quantity must be an integer from 1 to 100000.'); return v; };
  const items = await Promise.all(value.map(async value => {
    const b = object(value); onlyKeys(b, ['flaggedHoursHundredths','skill','partId','id','kind','description','laborHoursHundredths','laborRateCents','quantity','unitPriceCents']);
    const id = b.id === undefined ? randomUUID() : text(b.id, 'Line id', 64);
    if (ids.has(id)) throw invalid('Line ids must be unique.'); ids.add(id);
    const kind = choice(b.kind, ['labor','parts'], 'line kind'), description = text(b.description, 'Description', 200);
    const flagged = b.flaggedHoursHundredths;
    if (flagged != null && (kind !== 'labor' || typeof flagged !== 'number' || !Number.isInteger(flagged) || flagged < 0 || flagged > 100000)) throw invalid('Flagged hours must be hundredths from 0 to 100000 on labor only.');
    if (kind === 'labor') {
      if (b.partId != null) throw invalid('Labor cannot reference a stocked part.');
      if (b.quantity !== null || b.unitPriceCents !== null) throw invalid('Labor must have null parts fields.');
      const skill = b.skill == null ? null : choice(b.skill,serviceSkills,'skill');
      const rate = b.laborRateCents === undefined && skill ? (await repo.crmGet('labor-rate',skill))?.laborRateCents : b.laborRateCents;
      return {id, kind, description, skill, ...(flagged === undefined ? {} : {flaggedHoursHundredths: flagged as number | null}), laborHoursHundredths: count(b.laborHoursHundredths), laborRateCents: money(rate, 'Labor rate'), quantity: null, unitPriceCents: null};
    }
    if (b.laborHoursHundredths !== null || b.laborRateCents !== null) throw invalid('Parts must have null labor fields.');
    return {id, kind, description, partId: b.partId == null ? null : requireId(b.partId), laborHoursHundredths: null, laborRateCents: null, quantity: count(b.quantity), unitPriceCents: money(b.unitPriceCents, 'Unit price')};
  }));
  if (!Number.isSafeInteger(repairOrderTotals(items).totalCents)) throw invalid('Repair order total is too large.');
  return items;
}
async function references(repo: TenantRepository, b: Record<string, unknown>) {
  const customerId = requireId(b.customerId), customer = await repo.crmGet('customer', customerId);
  if (!customer) throw invalid('Customer must belong to this workspace.');
  const vehicleId = b.vehicleId == null || b.vehicleId === '' ? null : requireId(b.vehicleId);
  const vehicle = vehicleId ? await repo.get(vehicleId) : undefined;
  if (vehicleId && !vehicle) throw invalid('Vehicle must belong to this workspace.');
  const advisorId = b.advisorId == null || b.advisorId === '' ? null : requireId(b.advisorId);
  if (advisorId && !(await repo.membership(advisorId))?.active) throw invalid('Advisor must be an active workspace user.');
  const description = text(b.vehicleDescription === undefined ? '' : b.vehicleDescription, 'Vehicle description', 1000, true);
  return {customerId, customerName: customer.name, vehicleId, vehicleDescription: description || (vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : ''), advisorId, concern: text(b.concern === undefined ? '' : b.concern, 'Concern', 2000, true)};
}
export async function service(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, store?: DocumentStore) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase(), q = request.query ?? {}, time = now.toISOString();
  const methodError = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const catalog = await serviceCatalog(request,principal,repo,now); if (catalog) return catalog;
  // Jacket documents require a deal. Inspection references instead live on the RO,
  // using the same tenant-bound byte store and 40 KiB attachment discipline.
  const photo = /^\/service\/repair-orders\/([^/]+)\/photos(?:\/([^/]+)\/content)?$/.exec(path);
  if (photo) {
    onlyKeys(q,[]);
    const old = await repo.crmGet('repair-order',requireId(photo[1])); if (!old) throw missing();
    if (!store) throw new ApiError(503,'STORAGE_UNAVAILABLE','Document storage is not configured.');
    const storage = store.forTenant(principal.tenantId);
    if (method === 'GET' && photo[2]) {
      const ref = old.photos?.find(p=>p.id===requireId(photo[2])); if (!ref) throw missing();
      const bytes = await storage.get(ref.id); if (!bytes) throw missing();
      return response(200,{data:{content:Buffer.from(bytes).toString('base64')}});
    }
    if (method !== 'POST' || photo[2]) throw methodError(); requireWrite(principal,method);
    const b = parseBody(request.body); onlyKeys(b,['version','name','type','content']);
    if (version(b.version) !== old.version) throw conflict();
    if ((old.photos?.length ?? 0) >= 100) throw invalid('At most 100 inspection photos.');
    const name = text(b.name,'Photo name',160), type = choice(b.type,['image/jpeg','image/png','image/webp'],'photo type');
    if (typeof b.content !== 'string' || !b.content.length || b.content.length > Math.ceil(maxDocumentBytes/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.content)) throw invalid('Provide valid base64 photo content, at most 40 KiB decoded.');
    const bytes = Buffer.from(b.content,'base64'); if (bytes.length > maxDocumentBytes || bytes.toString('base64') !== b.content) throw invalid('Photo must be at most 40 KiB.');
    const id = randomUUID(), record = {...old,version:old.version+1,updatedAt:time,photos:[...(old.photos ?? []),{id,name,type,size:bytes.length}]};
    await storage.put(id,bytes);
    try { await repo.crmWrite([{record,expectedVersion:old.version,event:{id:randomUUID(),tenantId:principal.tenantId,actorId:principal.userId,aggregateId:old.id,aggregateVersion:record.version,type:'repair-order.updated',occurredAt:time,deliveryStatus:'pending'}}]); }
    catch(error) { await storage.remove(id); throw error; }
    return response(201,{data:view(record)});
  }
  if (path === '/service/board') {
    if (method !== 'GET') throw methodError(); onlyKeys(q, ['date']); const day = date(q.date ?? time.slice(0,10));
    const appointments = (await repo.crmList('service-appointment')).filter(a => a.scheduledStart.slice(0,10) === day).sort((a,b) => a.scheduledStart.localeCompare(b.scheduledStart) || a.id.localeCompare(b.id));
    const ids = new Set(appointments.map(a => a.id));
    const repairOrders = (await repo.crmList('repair-order')).filter(r => r.createdAt.slice(0,10) === day || (r.appointmentId && ids.has(r.appointmentId))).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(view);
    const byStatus = Object.fromEntries(appointmentStatuses.map(s => [s, appointments.filter(a => a.status === s)])) as ServiceBoardDay['byStatus'];
    const technicians = (await repo.crmList('technician')).map(t=>({...t,dayLoad:[...appointments,...repairOrders].filter(r=>r.technicianId===t.id).length}));
    return response(200, {data: {date: day, appointments, byStatus, repairOrders, technicians}});
  }
  const match = /^\/service\/(appointments|repair-orders)(?:\/([^/]+))?$/.exec(path); if (!match) throw missing();
  const appt = match[1] === 'appointments', id = match[2] ? requireId(match[2]) : undefined;
  if (!(id ? ['GET','PUT'] : ['GET','POST']).includes(method)) throw methodError();
  onlyKeys(q, !id && method === 'GET' ? appt ? ['date','status','search'] : ['customerId','vehicleId','status','search'] : []);
  const old = id ? appt ? await repo.crmGet('service-appointment', id) : await repo.crmGet('repair-order', id) : undefined;
  if (id && !old) throw missing();
  if (method === 'GET') {
    if (old) return response(200, {data: old.kind === 'repair-order' ? view(old) : old});
    const search = text(q.search ?? '', 'Search', 200, true).toLowerCase();
    const status = q.status === undefined ? undefined : appt ? choice(q.status, appointmentStatuses, 'status') : choice(q.status, repairOrderStatuses, 'status');
    const matches = (r: ServiceAppointment | RepairOrder) => (!status || r.status === status) && [r.customerName,r.vehicleDescription,r.concern].some(v => v.toLowerCase().includes(search));
    if (appt) {
      const day = q.date === undefined ? undefined : date(q.date);
      return response(200, {data: (await repo.crmList('service-appointment')).filter(r => matches(r) && (!day || r.scheduledStart.slice(0,10) === day)).sort((a,b) => a.scheduledStart.localeCompare(b.scheduledStart) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))});
    }
    if (q.customerId !== undefined) requireId(q.customerId); if (q.vehicleId !== undefined) requireId(q.vehicleId);
    return response(200, {data: (await repo.crmList('repair-order')).filter(r => matches(r) && (!q.customerId || r.customerId === q.customerId) && (!q.vehicleId || r.vehicleId === q.vehicleId)).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(view)});
  }
  requireWrite(principal, method);
  const b = parseBody(request.body);
  onlyKeys(b, ['technicianId','requiredSkill','acknowledgeSkillMismatch','vehicleId','vehicleDescription','advisorId','concern', ...(appt ? ['scheduledStart','scheduledEnd', 'status'] : ['inspection','recommendationDecision','payType','lineItems', ...(old ? ['status','allowNegativeStock'] : ['appointmentId'])]), ...(old ? ['version'] : ['customerId'])]);
  const expected = old ? version(b.version) : 0; if (old && expected !== old.version) throw conflict();
  let appointment: ServiceAppointment | undefined;
  if (!appt && !old && b.appointmentId != null) {
    appointment = await repo.crmGet('service-appointment', requireId(b.appointmentId));
    if (!appointment) throw invalid('Appointment must belong to this workspace.');
    if (b.customerId !== undefined && b.customerId !== appointment.customerId) throw invalid('Customer must match the appointment.');
  }
  const merged: Record<string, unknown> = {...appointment, ...old, ...b};
  const refs = await references(repo, merged);
  const assignment = await dispatch(repo,principal,time,merged,old ?? appointment,'technicianId' in b || 'requiredSkill' in b);
  const base = {...refs, ...assignment, id: old?.id ?? randomUUID(), tenantId: principal.tenantId, version: expected + 1, createdAt: old?.createdAt ?? time, updatedAt: time};
  let record: ServiceAppointment | RepairOrder;
  if (appt) {
    const scheduledStart = timestamp(merged.scheduledStart, 'Start'), scheduledEnd = timestamp(merged.scheduledEnd, 'End');
    const duration = Date.parse(scheduledEnd) - Date.parse(scheduledStart);
    if (duration <= 0 || duration > 86400000) throw invalid('Appointment window must be positive and at most 24 hours.');
    record = {...base, kind: 'service-appointment', scheduledStart, scheduledEnd, status: choice(merged.status === undefined ? 'scheduled' : merged.status, appointmentStatuses, 'status')};
  } else {
    record = {...base, kind: 'repair-order', appointmentId: old?.kind === 'repair-order' ? old.appointmentId : appointment?.id ?? null,
      payType: choice(merged.payType, repairOrderPayTypes, 'pay type'), status: old ? choice(merged.status, repairOrderStatuses, 'status') : 'open', lineItems: await lineItems(merged.lineItems === undefined ? [] : merged.lineItems,repo)};
  }
  if (record.kind === 'repair-order') {
    const prior = old?.kind === 'repair-order' ? old : undefined;
    record.photos = prior?.photos ?? [];
    Object.assign(record, await inspect(repo,merged.inspection === undefined ? [] : merged.inspection,prior));
    if (b.recommendationDecision !== undefined) {
      const decision = object(b.recommendationDecision); onlyKeys(decision,['id','status']);
      const recommendation = record.recommendations!.find(r=>r.id===requireId(decision.id)); if (!recommendation) throw missing();
      if (recommendation.status !== 'pending') throw conflict();
      recommendation.status = choice(decision.status,['approved','declined'],'recommendation decision');
      recommendation.decidedBy = principal.userId; recommendation.decidedAt = time;
      if (recommendation.status === 'approved') {
        record.lineItems = await lineItems([...record.lineItems,...recommendation.lines],repo);
        recommendation.lineIds = recommendation.lines.map(l=>l.id);
      }
    }
  }
  const stockWrites = record.kind === 'repair-order' ? await reconcileStock(repo, principal, time, old?.kind === 'repair-order' ? old : undefined, record, negativeOverride(b.allowNegativeStock)) : [];
  const journalWrites = record.kind === 'repair-order' ? await reconcilePosting(repo, principal, now, old?.kind === 'repair-order' ? old : undefined, record) : [];
  await repo.crmWrite([...stockWrites, {record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type: `${record.kind}.${old ? 'updated' : 'created'}`, occurredAt: time, deliveryStatus: 'pending'}}]);
  // RO + stock can consume all ten writes; validated journal entries follow immediately.
  if (journalWrites.length) await repo.crmWrite(journalWrites);
  return response(old ? 200 : 201, {data: record.kind === 'repair-order' ? view(record) : record});
}
