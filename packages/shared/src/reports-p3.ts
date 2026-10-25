import type { DepartmentalStatement } from './accounting.js';
export interface TechnicianMetrics {
  from: string | null; to: string | null;
  rows: {technicianId: string; technician: string; soldHoursHundredths: number; flaggedHoursHundredths: number | null; missingFlaggedLines: number; efficiencyPercent: number | null; roCount: number}[];
}
export interface DepartmentReport extends DepartmentalStatement {
  locations: {location: string; roCount: number; laborCents: number; servicePartsCents: number; counterSaleCount: number; counterCents: number}[];
}
export interface Projection<T> {
  projection: T | null;
  basis: {from: string; to: string; sampleSize: number};
  method: string;
  insufficientReason: string | null;
}
export interface Forecasts {
  inventory: Projection<{currentStock: number; daysSupply: number; earlierDaysSupply: number | null; changeDays: number | null}>;
  service: Projection<{day: string; appointments: number; occurrences: number; projectedAppointments: number}[]>;
  parts: Projection<{partId: string; partNumber: string; location: string; unitsUsed: number; dailyUse: number; available: number; daysSupply: number; reorderNext30Days: number}[]>;
}
