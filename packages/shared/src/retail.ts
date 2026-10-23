import type { CrmRecord, Deal } from './index.js';
export const defaultShareExpiryDays = 7;
export interface DealShare extends CrmRecord {
  kind: 'deal-share'; dealId: string; tokenHash: string; expiresAt: string; revokedAt: string | null; createdBy: string;
}
export interface ShareResponse extends CrmRecord {
  kind: 'share-response'; dealId: string; shareId: string; responseKind: 'payment-choice' | 'change-request';
  optionId: string | null; termMonths: number | null; down: number; monthlyPayment: number | null; amountDue: number | null; message: string;
}
export interface BuyerPaymentOption {
  id: string; kind: 'cash' | 'finance' | 'lease'; termMonths: number | null; down: number; monthlyPayment: number | null; amountDue: number | null;
}
/** Explicit buyer allowlist; never extend dealer records or calculator output. */
export interface BuyerDealView {
  dealershipName: string; customerName: string; dealType: Deal['type'];
  vehicle: {year: number; make: string; model: string; trim: string; vin: string; stockNumber: string};
  price: number; docFee: number; salesTax: number;
  fiProducts: {name: string; retailPrice: number; termNotes: string}[]; fiRetailTotal: number;
  trade: {year: string; make: string; model: string; allowance: number; payoff: number; netEquity: number} | null;
  down: number; amountFinanced: number; monthlyPayment: number; totalPayments: number; financeCharge: number;
  cashDue: number; aprBps: number; termMonths: number; paymentOptions: BuyerPaymentOption[]; expiresAt: string;
}
