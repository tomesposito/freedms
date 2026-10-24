import { randomUUID } from 'node:crypto';
import { appointmentStatuses, repairOrderPayTypes, repairOrderStatuses, repairOrderTotals, type ServiceAppointment, type RepairOrder, type RepairOrderLineItem, type Principal, type ServiceBoardDay } from '@freedms/shared';
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
function lineItems(value: unknown): RepairOrderLineItem[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid('Provide at most 100 line items.');
  const ids = new Set<string>();
  const count = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100000) throw invalid('Hours / quantity must be an integer from 1 to 100000.'); return v; };
  const items = value.map(value => {
    const b = object(value); onlyKeys(b, ['id','kind','description','laborHoursHundredths','laborRateCents','quantity','unitPriceCents']);
    const id = b.id === undefined ? randomUUID() : text(b.id, 'Line id', 64);
    if (ids.has(id)) throw invalid('Line ids must be unique.'); ids.add(id);
    const kind = choice(b.kind, ['labor','parts'], 'line kind'), description = text(b.description, 'Description', 200);
    if (kind === 'labor') {
      if (b.quantity !== null || b.unitPriceCents !== null) throw invalid('Labor must have null parts fields.');
      return {id, kind, description, laborHoursHundredths: count(b.laborHoursHundredths), laborRateCents: money(b.laborRateCents, 'Labor rate'), quantity: null, unitPriceCents: null};
    }
    if (b.laborHoursHundredths !== null || b.laborRateCents !== null) throw invalid('Parts must have null labor fields.');
    return {id, kind, description, laborHoursHundredths: null, laborRateCents: null, quantity: count(b.quantity), unitPriceCents: money(b.unitPriceCents, 'Unit price')};
  });
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
export async function service(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase(), q = request.query ?? {}, time = now.toISOString();
  const methodError = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (path === '/service/board') {
    if (method !== 'GET') throw methodError(); onlyKeys(q, ['date']); const day = date(q.date ?? time.slice(0,10));
    const appointments = (await repo.crmList('service-appointment')).filter(a => a.scheduledStart.slice(0,10) === day).sort((a,b) => a.scheduledStart.localeCompare(b.scheduledStart) || a.id.localeCompare(b.id));
    const ids = new Set(appointments.map(a => a.id));
    const repairOrders = (await repo.crmList('repair-order')).filter(r => r.createdAt.slice(0,10) === day || (r.appointmentId && ids.has(r.appointmentId))).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(view);
    const byStatus = Object.fromEntries(appointmentStatuses.map(s => [s, appointments.filter(a => a.status === s)])) as ServiceBoardDay['byStatus'];
    return response(200, {data: {date: day, appointments, byStatus, repairOrders}});
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
  onlyKeys(b, ['vehicleId','vehicleDescription','advisorId','concern', ...(appt ? ['scheduledStart','scheduledEnd', 'status'] : ['payType','lineItems', ...(old ? ['status'] : ['appointmentId'])]), ...(old ? ['version'] : ['customerId'])]);
  const expected = old ? version(b.version) : 0; if (old && expected !== old.version) throw conflict();
  let appointment: ServiceAppointment | undefined;
  if (!appt && !old && b.appointmentId != null) {
    appointment = await repo.crmGet('service-appointment', requireId(b.appointmentId));
    if (!appointment) throw invalid('Appointment must belong to this workspace.');
    if (b.customerId !== undefined && b.customerId !== appointment.customerId) throw invalid('Customer must match the appointment.');
  }
  const merged: Record<string, unknown> = {...appointment, ...old, ...b};
  const refs = await references(repo, merged);
  const base = {...refs, id: old?.id ?? randomUUID(), tenantId: principal.tenantId, version: expected + 1, createdAt: old?.createdAt ?? time, updatedAt: time};
  let record: ServiceAppointment | RepairOrder;
  if (appt) {
    const scheduledStart = timestamp(merged.scheduledStart, 'Start'), scheduledEnd = timestamp(merged.scheduledEnd, 'End');
    const duration = Date.parse(scheduledEnd) - Date.parse(scheduledStart);
    if (duration <= 0 || duration > 86400000) throw invalid('Appointment window must be positive and at most 24 hours.');
    record = {...base, kind: 'service-appointment', scheduledStart, scheduledEnd, status: choice(merged.status === undefined ? 'scheduled' : merged.status, appointmentStatuses, 'status')};
  } else {
    record = {...base, kind: 'repair-order', appointmentId: old?.kind === 'repair-order' ? old.appointmentId : appointment?.id ?? null,
      payType: choice(merged.payType, repairOrderPayTypes, 'pay type'), status: old ? choice(merged.status, repairOrderStatuses, 'status') : 'open', lineItems: lineItems(merged.lineItems === undefined ? [] : merged.lineItems)};
  }
  await repo.crmWrite([{record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version, type: `${record.kind}.${old ? 'updated' : 'created'}`, occurredAt: time, deliveryStatus: 'pending'}}]);
  return response(old ? 200 : 201, {data: record.kind === 'repair-order' ? view(record) : record});
}
