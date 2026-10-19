import type { CrmRecord, Customer, Vehicle } from './index.js';
export const dealStatuses = ['working', 'approved', 'sold', 'dead'] as const;
export type DealStatus = typeof dealStatuses[number];
/** Rates are integer basis points (6% = 600); money is integer USD cents. */
export interface TaxSettings { taxRateBps: number; taxTradeDifference: boolean; docFee: number }
export interface WorkspaceSettings extends CrmRecord, TaxSettings { kind: 'settings' }
export const defaultSettings: TaxSettings = {taxRateBps: 0, taxTradeDifference: false, docFee: 0};
export interface Trade { year: string; make: string; model: string; vin: string; allowance: number; payoff: number; actualCashValue: number }
export interface Pencil { id: string; name: string; price: number; down: number; term: number; aprBps: number }
export interface Deal extends CrmRecord, TaxSettings {
  kind: 'deal'; vehicleId: string; customerId: string; leadId: string | null; type: 'cash' | 'finance';
  trade: Trade | null; pencils: Pencil[]; workingPencilId: string; status: DealStatus;
  history: {status: DealStatus; actorId: string; timestamp: string}[];
}
export interface DealView extends Deal { vehicle: Vehicle; customer: Customer }
function integer(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${label}.`);
}
const roundRatio = (n: bigint, d: bigint) => Number((n * 2n + d) / (2n * d));
/** Exact rational amortization, rounded half up once to a whole cent. */
export function monthlyPayment(principal: number, aprBps: number, term: number): number {
  integer(principal, Number.MAX_SAFE_INTEGER, 'principal'); integer(aprBps, 10000, 'APR'); integer(term, 120, 'term');
  if (!term) throw new Error('Term must be 1–120 months.');
  if (!aprBps) return roundRatio(BigInt(principal), BigInt(term));
  const d = 120000n, r = BigInt(aprBps), n = BigInt(term);
  const power = (d + r) ** n;
  return roundRatio(BigInt(principal) * r * power, d * (power - d ** n));
}
export function pencilMath(p: Pencil, trade: Trade | null, tax: TaxSettings, vehicle: Pick<Vehicle, 'cost' | 'reconCosts'>, type: Deal['type']) {
  for (const value of [p.price, p.down, tax.docFee, ...(trade ? [trade.allowance, trade.payoff, trade.actualCashValue] : [])]) integer(value, 10_000_000_000, 'money');
  integer(tax.taxRateBps, 10000, 'tax rate');
  const allowance = trade?.allowance ?? 0, payoff = trade?.payoff ?? 0;
  const taxableBase = Math.max(0, p.price - (tax.taxTradeDifference ? allowance : 0));
  const salesTax = roundRatio(BigInt(taxableBase) * BigInt(tax.taxRateBps), 10000n);
  const netEquity = allowance - payoff;
  const balance = p.price + tax.docFee + salesTax - netEquity - p.down;
  const amountFinanced = type === 'finance' ? Math.max(0, balance) : 0;
  const payment = type === 'finance' ? monthlyPayment(amountFinanced, p.aprBps, p.term) : 0;
  const totalPayments = payment * (type === 'finance' ? p.term : 0);
  const financeCharge = totalPayments - amountFinanced;
  const tradeOverallowance = allowance - (trade?.actualCashValue ?? 0);
  const frontGross = p.price - vehicle.cost - vehicle.reconCosts.reduce((sum, item) => sum + item.amount, 0) - tradeOverallowance;
  return {taxableBase, salesTax, netEquity, balance, amountFinanced, payment, totalPayments, financeCharge,
    totalCost: p.price + tax.docFee + salesTax + financeCharge, frontGross, tradeOverallowance,
    cashDue: type === 'cash' ? Math.max(0, balance) : 0, creditDue: Math.max(0, -balance)};
}
export function paymentGrid(p: Pencil, trade: Trade | null, tax: TaxSettings, vehicle: Pick<Vehicle, 'cost' | 'reconCosts'>) {
  const terms = p.term <= 12 ? [p.term, p.term + 12, p.term + 24] : p.term >= 109 ? [p.term - 24, p.term - 12, p.term] : [p.term - 12, p.term, p.term + 12];
  const firstDown = Math.min(p.down, 10_000_000_000 - 100000);
  const downs = [firstDown, firstDown + 50000, firstDown + 100000];
  return terms.map(term => ({term, options: downs.map(down => ({down, payment: pencilMath({...p, term, down}, trade, tax, vehicle, 'finance').payment}))}));
}
