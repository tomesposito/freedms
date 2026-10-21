/** Deliberately closed: customer content and deal economics are never analytics properties. */
export type BehavioralEvent =
  | {event: 'quick_entry_used'; surface: 'inventory' | 'lead'; input: 'text' | 'photo'; outcome: 'saved' | 'edited' | 'discarded'}
  | {event: 'report_exported'; report: 'aging' | 'sales' | 'pipeline' | 'accounting'}
  | {event: 'pencil_grid_viewed'}
  | {event: 'jacket_checklist_completed'};
export interface AnalyticsRecord { id: string; tenantId: string; occurredAt: string; data: BehavioralEvent }
export interface FunnelStage { reached: boolean; firstAt: string | null; count: number }
export interface Funnel { tenantProvisioned: FunnelStage; vehicleStocked: FunnelStage; leadCreated: FunnelStage; pencilCreated: FunnelStage; sold: FunnelStage; jacketComplete: FunnelStage }
