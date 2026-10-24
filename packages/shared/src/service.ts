import type { CrmRecord } from './index.js';
export const appointmentStatuses = ['scheduled','checked-in','in-service','done','picked-up','no-show'] as const;
export type AppointmentStatus = typeof appointmentStatuses[number];
export const appointmentStatusLabels: Record<AppointmentStatus,string> = {scheduled:'Scheduled','checked-in':'Checked in','in-service':'In service',done:'Done','picked-up':'Picked up','no-show':'No-show'};
export const repairOrderPayTypes = ['customer-pay','internal','warranty'] as const;
export type RepairOrderPayType = typeof repairOrderPayTypes[number];
export const repairOrderPayTypeLabels: Record<RepairOrderPayType,string> = {'customer-pay':'Customer pay',internal:'Internal',warranty:'Warranty'};
export const repairOrderStatuses = ['open','in-progress','completed','picked-up'] as const;
export type RepairOrderStatus = typeof repairOrderStatuses[number];
export const repairOrderStatusLabels: Record<RepairOrderStatus,string> = {open:'Open','in-progress':'In progress',completed:'Completed','picked-up':'Picked up'};
export interface ServiceAppointment extends CrmRecord {
  kind: 'service-appointment'; customerId: string; customerName: string;
  vehicleId: string | null; vehicleDescription: string; advisorId: string | null;
  scheduledStart: string; scheduledEnd: string; concern: string; status: AppointmentStatus;
}
export interface RepairOrderLineItem {
  partId?: string | null; id: string; kind: 'labor' | 'parts'; description: string;
  laborHoursHundredths: number | null; laborRateCents: number | null;
  quantity: number | null; unitPriceCents: number | null;
}
export function lineItemAmountCents(item: RepairOrderLineItem): number {
  return item.kind === 'labor' ? Math.round(item.laborHoursHundredths! * item.laborRateCents! / 100) : item.quantity! * item.unitPriceCents!;
}
export interface RepairOrderTotals { laborCents: number; partsCents: number; totalCents: number }
export function repairOrderTotals(items: RepairOrderLineItem[]): RepairOrderTotals {
  const laborCents = items.filter(i => i.kind === 'labor').reduce((s, i) => s + lineItemAmountCents(i), 0);
  const partsCents = items.filter(i => i.kind === 'parts').reduce((s, i) => s + lineItemAmountCents(i), 0);
  return {laborCents, partsCents, totalCents: laborCents + partsCents};
}
export interface RepairOrder extends CrmRecord {
  stockApplied?: boolean; stockWarning?: string | null;
  kind: 'repair-order'; appointmentId: string | null; customerId: string; customerName: string;
  vehicleId: string | null; vehicleDescription: string; payType: RepairOrderPayType;
  status: RepairOrderStatus; advisorId: string | null; concern: string; lineItems: RepairOrderLineItem[];
}
export interface RepairOrderView extends RepairOrder { totals: RepairOrderTotals }
export interface ServiceBoardDay {
  date: string; appointments: ServiceAppointment[];
  byStatus: Record<AppointmentStatus, ServiceAppointment[]>; repairOrders: RepairOrderView[];
}
