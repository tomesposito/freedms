import type { CrmEntity, RepairOrder, ServiceAppointment, SignatureRecord, Technician } from '@freedms/shared';
export const boardDay = '2026-10-28';
const base = {tenantId: 'A', version: 1, createdAt: `${boardDay}T12:00:00Z`, updatedAt: `${boardDay}T12:00:00Z`};
const otherDay = '2026-10-27T12:00:00Z';
const appointment: ServiceAppointment = {...base, kind: 'service-appointment', id: 'a', customerId: 'c', customerName: 'Customer', vehicleId: null, vehicleDescription: '', advisorId: null, concern: '', scheduledStart: base.createdAt, scheduledEnd: `${boardDay}T13:00:00Z`, status: 'scheduled'};
export const boardOrder: RepairOrder = {...base, kind: 'repair-order', id: 'r-day', appointmentId: null, customerId: 'c', customerName: 'Customer', vehicleId: null, vehicleDescription: '', advisorId: null, concern: '', payType: 'customer-pay', status: 'open', lineItems: []};
const signature: SignatureRecord = {...base, kind: 'signature', id: 's-day', targetType: 'repair-order', repairOrderId: 'r-day', dealId: null, documentId: null, targetLabel: '', targetVersion: 1, targetHash: '', signerName: 'Customer', method: 'typed', signatureData: 'Customer', consentText: '', signedAt: base.createdAt, capturedBy: 'userA'};
const technician: Technician = {...base, kind: 'technician', id: 't-z', name: 'Tech', skills: []};
// Deliberately put signatures/linked ROs before appointments for the raw memory pass.
export const boardRows: CrmEntity[] = [signature, {...signature, id: 's-linked', repairOrderId: 'r-linked'},
  {...signature, id: 's-excluded', repairOrderId: 'r-excluded'}, {...signature, id: 's-document', targetType: 'document', repairOrderId: 'r-day'},
  {...boardOrder, id: 'r-linked', createdAt: otherDay, appointmentId: 'a'}, boardOrder,
  {...boardOrder, id: 'r-both', appointmentId: 'a'}, {...boardOrder, id: 'r-excluded', createdAt: otherDay},
  {...boardOrder, id: 'r-other-link', createdAt: otherDay, appointmentId: 'other'},
  appointment, {...appointment, id: 'other', scheduledStart: otherDay}, {...appointment, id: 'a-second'},
  technician, {...technician, id: 't-a'}];
export const boardIds = {appointments: ['a', 'a-second'], repairOrders: ['r-linked', 'r-day', 'r-both'], signatures: ['s-day', 's-linked'], technicians: ['t-z', 't-a']};
