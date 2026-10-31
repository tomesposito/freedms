import type { CrmRecord } from './index.js';
export interface Part extends CrmRecord {
  kind: 'part'; partNumber: string; description: string; binLocation: string; location: string; quantityReserved: number;
  costCents: number; retailPriceCents: number; quantityOnHand: number; reorderPoint: number;
}
export interface PartsSale extends CrmRecord {
  kind: 'parts-sale'; partId: string; partNumber: string; description: string;
  quantity: number; unitPriceCents: number; totalCents: number;
  customerId: string | null; customerName: string | null; stockNegative: boolean; stockWarning: string | null;
}

export interface PurchaseOrderLine {
  id: string; partId: string; quantityOrdered: number; quantityReceived: number; costCents: number;
  specialOrder: null | {customerId: string | null; repairOrderId: string | null; customerName: string | null};
  quantityReserved: number; quantityFulfilled: number; fulfilled: boolean;
  // Included in quantityFulfilled; reversible stock consumption by the owning RO.
  quantityConsumed?: number;
}
export interface PartsPurchaseOrder extends CrmRecord {
  kind: 'parts-po'; vendorName: string; status: 'open' | 'partially-received' | 'received'; lines: PurchaseOrderLine[];
}
export interface PartsReturn extends CrmRecord {
  kind: 'parts-return'; partId: string; vendorName: string; quantity: number; reason: string;
  purchaseOrderId: string | null; costCents: number; totalValueCents: number;
}
export interface PricingBracket { maxCostCents: number | null; markupBps: number }
export interface PricingMatrix extends CrmRecord { kind: 'pricing-matrix'; enabled: boolean; brackets: PricingBracket[] }
export interface PricingProposal { costCents: number; proposedRetailCents: number | null; markupBps: number | null }

export interface PartsReservation extends CrmRecord {
  kind: 'parts-reservation'; partId: string; repairOrderId: string;
  customerId: string | null; customerName: string | null;
  quantity: number; quantityConsumed: number; quantityReleased: number;
  status: 'active' | 'consumed' | 'released'; createdBy: string;
  releasedBy: string | null; releasedAt: string | null;
}
export const reservationActive = (r: PartsReservation): number => r.quantity-r.quantityConsumed-r.quantityReleased;
export function reservationStatus(r: PartsReservation, action: 'consumed' | 'released'): PartsReservation['status'] {
  return reservationActive(r)>0 ? 'active' : action;
}
