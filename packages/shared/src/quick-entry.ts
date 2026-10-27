import type { CustomerInput, Lead, VehicleInput } from './index.js';
export type VehicleDraft = Partial<Pick<VehicleInput, 'mileage' | 'year' | 'make' | 'model' | 'trim' | 'stockNumber' | 'vin' | 'listPrice' | 'cost' | 'location' | 'notes'>>;
export interface LeadDraft {
  customer?: Partial<Omit<CustomerInput, 'consent'>> & {consent: {status: 'unknown'; timestamp: null; source: ''}};
  vehicleDescription?: string; source?: Lead['source']; sourceDetail?: string;
}
export interface QuickEntryUsage {
  id: string; tenantId: string; actorId: string;
  kind: 'vehicle-text' | 'vehicle-photo' | 'lead-text'; occurredAt: string;
  signal?: Extract<import('./analytics.js').BehavioralEvent, {event: 'quick_entry_used'}>;
}
