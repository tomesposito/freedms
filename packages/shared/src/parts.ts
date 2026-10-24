import type { CrmRecord } from './index.js';
export interface Part extends CrmRecord {
  kind: 'part'; partNumber: string; description: string; binLocation: string;
  costCents: number; retailPriceCents: number; quantityOnHand: number; reorderPoint: number;
}
export interface PartsSale extends CrmRecord {
  kind: 'parts-sale'; partId: string; partNumber: string; description: string;
  quantity: number; unitPriceCents: number; totalCents: number;
  customerId: string | null; customerName: string | null; stockNegative: boolean; stockWarning: string | null;
}
