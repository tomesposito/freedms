import type { CrmRecord, Customer, Vehicle } from './index.js';
export const dealStatuses = ['working', 'approved', 'sold', 'dead'] as const;
export type DealStatus = typeof dealStatuses[number];
/** Rates are integer basis points (6% = 600); money is integer USD cents. */
export interface TaxSettings { taxRateBps: number; taxTradeDifference: boolean; docFee: number }
export interface WorkspaceSettings extends CrmRecord, TaxSettings { kind: 'settings'; shareExpiryDays?: number; commissionRateBps?: number }
export const defaultSettings: TaxSettings & {commissionRateBps: number} = {commissionRateBps: 0, taxRateBps: 0, taxTradeDifference: false, docFee: 0};
export interface Trade { year: string; make: string; model: string; vin: string; allowance: number; payoff: number; actualCashValue: number }
export interface FiSelection { productId: string; name: string; category: import('./fi.js').FiCategory; cost: number; retailPrice: number; termNotes: string; status: 'accepted' | 'declined' }
export interface LeaseTerms { msrp: number; residualPercentBps: number; residualAmount: number; moneyFactorMicro: number; acquisitionFee: number; securityDeposit: number; milesPerYear: number }
export const defaultLeaseTerms = (msrp: number): LeaseTerms => ({msrp, residualPercentBps: 0, residualAmount: 0, moneyFactorMicro: 0, acquisitionFee: 0, securityDeposit: 0, milesPerYear: 12000});
export interface Pencil { type: Deal['type']; lease: LeaseTerms | null; fiSelections: FiSelection[]; id: string; name: string; price: number; down: number; term: number; aprBps: number }
export interface Deal extends CrmRecord, TaxSettings {
  kind: 'deal'; vehicleId: string; customerId: string; leadId: string | null; type: 'cash' | 'finance' | 'lease';
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
  if (p.fiSelections.length > 50 || new Set(p.fiSelections.map(s => s.productId)).size !== p.fiSelections.length) throw new Error('Invalid F&I selections.');
  let fiRetailTotal = 0, fiCostTotal = 0;
  for (const s of p.fiSelections) {
    integer(s.cost, 10_000_000_000, 'F&I cost'); integer(s.retailPrice, 10_000_000_000, 'F&I retail');
    if (!['accepted', 'declined'].includes(s.status)) throw new Error('Invalid F&I status.');
    if (s.status === 'accepted') { fiRetailTotal += s.retailPrice; fiCostTotal += s.cost; }
  }
  const fiGross = fiRetailTotal - fiCostTotal;
  const allowance = trade?.allowance ?? 0, payoff = trade?.payoff ?? 0;
  const taxableBase = Math.max(0, p.price - (tax.taxTradeDifference ? allowance : 0));
  const salesTax = roundRatio(BigInt(taxableBase) * BigInt(tax.taxRateBps), 10000n);
  const netEquity = allowance - payoff;
  const balance = p.price + tax.docFee + salesTax + fiRetailTotal - netEquity - p.down;
  const amountFinanced = type === 'finance' ? Math.max(0, balance) : 0;
  const payment = type === 'finance' ? monthlyPayment(amountFinanced, p.aprBps, p.term) : 0;
  const totalPayments = payment * (type === 'finance' ? p.term : 0);
  const financeCharge = totalPayments - amountFinanced;
  const tradeOverallowance = allowance - (trade?.actualCashValue ?? 0);
  const frontGross = p.price - vehicle.cost - vehicle.reconCosts.reduce((sum, item) => sum + item.amount, 0) - tradeOverallowance;
  if (type === 'lease') {
    const lease = leaseMath(p, trade, tax, vehicle);
    return {fiRetailTotal, fiCostTotal, fiGross, taxableBase: lease.basePayment, salesTax: lease.totalTax, netEquity,
      balance: lease.adjustedCapCost + lease.totalTax, amountFinanced: 0, payment: lease.monthlyPayment,
      totalPayments: lease.totalPayments, financeCharge: lease.totalRentCharge, totalCost: p.down + lease.totalPayments,
      frontGross, tradeOverallowance, cashDue: lease.driveOff, creditDue: 0, lease};
  }
  return {lease: null, fiRetailTotal, fiCostTotal, fiGross, taxableBase, salesTax, netEquity, balance, amountFinanced, payment, totalPayments, financeCharge,
    totalCost: balance + netEquity + p.down + financeCharge, frontGross, tradeOverallowance,
    cashDue: type === 'cash' ? Math.max(0, balance) : 0, creditDue: Math.max(0, -balance)};
}
export function paymentGrid(p: Pencil, trade: Trade | null, tax: TaxSettings, vehicle: Pick<Vehicle, 'cost' | 'reconCosts'>) {
  const terms = p.term <= 12 ? [p.term, p.term + 12, p.term + 24] : p.term >= 109 ? [p.term - 24, p.term - 12, p.term] : [p.term - 12, p.term, p.term + 12];
  const firstDown = Math.min(p.down, 10_000_000_000 - 100000);
  const downs = [firstDown, firstDown + 50000, firstDown + 100000];
  return terms.map(term => ({term, options: downs.map(down => ({down, payment: pencilMath({...p, term, down}, trade, tax, vehicle, 'finance').payment}))}));
}

export function residualFromPercent(msrp: number, bps: number): number {
  integer(msrp, 10_000_000_000, 'MSRP'); integer(bps, 10000, 'residual percent');
  return roundRatio(BigInt(msrp) * BigInt(bps), 10000n);
}
export function residualPercentFromAmount(msrp: number, amount: number): number {
  integer(msrp, 10_000_000_000, 'MSRP'); integer(amount, msrp, 'residual amount');
  return msrp ? roundRatio(BigInt(amount) * 10000n, BigInt(msrp)) : 0;
}
export function moneyFactorToAprBps(micro: number): number {
  integer(micro, 10000, 'money factor');
  return roundRatio(BigInt(micro) * 240000n, 1000000n);
}
export function leaseMath(p: Pencil, trade: Trade | null, tax: TaxSettings, vehicle: Pick<Vehicle, 'cost' | 'reconCosts'>): LeaseTerms & {grossCapCost: number; adjustedCapCost: number; aprBpsEquivalent: number; depreciationFee: number; rentCharge: number; basePayment: number; monthlyTax: number; monthlyPayment: number; totalPayments: number; totalTax: number; totalRentCharge: number; driveOff: number; purchaseOption: number} {
  const l = p.lease;
  if (!l) throw new Error('Invalid lease.');
  // Reuse the common money, tax and F&I validation without recursing into lease math.
  const common = pencilMath(p, trade, tax, vehicle, 'cash');
  for (const value of [l.msrp, l.residualAmount, l.acquisitionFee, l.securityDeposit]) integer(value, 10_000_000_000, 'lease money');
  integer(l.residualPercentBps, 10000, 'residual percent');
  residualPercentFromAmount(l.msrp, l.residualAmount);
  integer(l.milesPerYear, 100000, 'miles per year'); integer(p.term, 120, 'term');
  if (!p.term) throw new Error('Invalid lease.');
  const aprBpsEquivalent = moneyFactorToAprBps(l.moneyFactorMicro);
  const grossCapCost = p.price + l.acquisitionFee + tax.docFee + common.fiRetailTotal;
  const adjustedCapCost = grossCapCost - p.down - common.netEquity;
  if (adjustedCapCost < 0) throw new Error('Invalid lease.');
  const depreciationFee = adjustedCapCost > l.residualAmount ? roundRatio(BigInt(adjustedCapCost - l.residualAmount), BigInt(p.term)) : 0;
  const rentCharge = roundRatio(BigInt(adjustedCapCost + l.residualAmount) * BigInt(l.moneyFactorMicro), 1000000n);
  const basePayment = depreciationFee + rentCharge;
  const monthlyTax = roundRatio(BigInt(basePayment) * BigInt(tax.taxRateBps), 10000n);
  const monthlyPayment = basePayment + monthlyTax;
  return {...l, grossCapCost, adjustedCapCost, aprBpsEquivalent, depreciationFee, rentCharge, basePayment, monthlyTax,
    monthlyPayment, totalPayments: monthlyPayment * p.term, totalTax: monthlyTax * p.term,
    totalRentCharge: rentCharge * p.term, driveOff: p.down + monthlyPayment + l.securityDeposit, purchaseOption: l.residualAmount};
}
