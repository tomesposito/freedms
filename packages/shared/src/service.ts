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
export interface ServiceAppointment extends CrmRecord, Dispatch {
  kind: 'service-appointment'; customerId: string; customerName: string;
  vehicleId: string | null; vehicleDescription: string; advisorId: string | null;
  scheduledStart: string; scheduledEnd: string; concern: string; status: AppointmentStatus;
}
export interface RepairOrderLineItem {
  skill?: ServiceSkill | null; partId?: string | null; id: string; kind: 'labor' | 'parts'; description: string;
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
export interface RepairOrder extends CrmRecord, Dispatch {
  inspection?: InspectionItem[]; photos?: InspectionPhoto[]; recommendations?: Recommendation[];
  glPosted?: boolean; glPostingEntryId?: string | null;
  stockApplied?: boolean; stockWarning?: string | null;
  kind: 'repair-order'; appointmentId: string | null; customerId: string; customerName: string;
  vehicleId: string | null; vehicleDescription: string; payType: RepairOrderPayType;
  status: RepairOrderStatus; advisorId: string | null; concern: string; lineItems: RepairOrderLineItem[];
}
export interface RepairOrderView extends RepairOrder { totals: RepairOrderTotals }
export interface ServiceBoardDay {
  technicians?: (Technician & {dayLoad: number})[];
  date: string; appointments: ServiceAppointment[];
  byStatus: Record<AppointmentStatus, ServiceAppointment[]>; repairOrders: RepairOrderView[];
}

export const serviceSkills = ['brakes','diesel','electrical','diagnostics','engine','transmission','suspension','hvac','tires','general'] as const;
export type ServiceSkill = typeof serviceSkills[number];
export interface Technician extends CrmRecord { kind: 'technician'; name: string; skills: ServiceSkill[] }
export interface LaborRate extends CrmRecord { kind: 'labor-rate'; skill: ServiceSkill; laborRateCents: number }
export interface Dispatch { technicianId?: string | null; requiredSkill?: ServiceSkill | null; skillMismatchWarning?: {requiredSkill: ServiceSkill; technicianId: string; acknowledgedBy: string; acknowledgedAt: string} | null }
export interface InspectionItem { id: string; label: string; status: 'ok' | 'monitor' | 'needs-attention'; skill: ServiceSkill; laborHoursHundredths: number; partId: string | null }
export interface InspectionPhoto { id: string; name: string; type: 'image/jpeg' | 'image/png' | 'image/webp'; size: number }
export interface Recommendation { id: string; inspectionItemId: string; description: string; estimatedPriceCents: number; status: 'pending' | 'approved' | 'declined'; lines: RepairOrderLineItem[]; lineIds: string[]; decidedBy?: string; decidedAt?: string }
