import { pencilMath, type Activity, type Deal, type Lead, type Vehicle } from './index.js';
export interface CustomerTimelineEntry {
  timestamp: string; kind: Activity['kind'] | 'deal'; summary: string;
  leadId?: string; dealId?: string; type?: Activity['type']; direction?: Activity['direction'];
}
export interface EquityMiningEntry {
  customer: {id: string; name: string}; customerId: string; dealId: string; leadId: string | null;
  vehicle: Pick<Vehicle, 'id' | 'year' | 'make' | 'model' | 'stockNumber'> | null;
  saleDate: string; monthsOwned: number; vehicleAgeYears: number | null; dealType: Deal['type'];
  tradeAllowance: number; tradePayoff: number; saleNetEquityCents: number; tradeRecorded: boolean;
  estimatedPayoffCents: number | null; payoffBasis: string; termMonths: number | null;
  remainingPayments: number | null; mileageBand: null; reasons: string[];
}
/** UTC month arithmetic clamps the day to the destination month's final day. */
export function addOwnershipMonths(value: string, months: number): string {
  const date = new Date(value), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end)); return date.toISOString();
}
export function saleDate(deal: Deal): string {
  return deal.history.filter(h => h.status === 'sold').map(h => h.timestamp).sort().at(-1) ?? deal.updatedAt;
}
export function ownershipLead(deal: Deal, leads: Lead[]): Lead | undefined {
  const candidates = leads.filter(l => l.customerId === deal.customerId);
  return candidates.find(l => l.id === deal.leadId) ?? candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}
export function ownershipSignals(deal: Deal, vehicle: Vehicle | undefined, now: Date) {
  const sold = saleDate(deal), date = new Date(sold);
  let monthsOwned = Math.max(0, (now.getUTCFullYear() - date.getUTCFullYear()) * 12 + now.getUTCMonth() - date.getUTCMonth());
  if (monthsOwned && Date.parse(addOwnershipMonths(sold, monthsOwned)) > now.getTime()) monthsOwned--;
  // Age uses the current UTC year, not the sale year. No odometer is recorded.
  const vehicleAgeYears = vehicle ? Math.max(0, now.getUTCFullYear() - vehicle.year) : null;
  const p = deal.pencils.find(p => p.id === deal.workingPencilId);
  const termMonths = deal.type !== 'cash' && p ? p.term : null;
  const remainingPayments = termMonths === null ? null : Math.max(0, termMonths - monthsOwned);
  let estimatedPayoffCents: number | null = null;
  let payoffBasis = deal.type === 'cash' ? 'Cash sale; no loan balance estimated.' : 'Working pencil unavailable; balance unknown.';
  if (p && deal.type !== 'cash') {
    const math = pencilMath(p, deal.trade, deal, vehicle ?? {cost: 0, reconCosts: []}, deal.type);
    if (deal.type === 'finance') {
      // B0 = pencilMath.amountFinanced. Each on-time month: B = max(0, B + round(B*APR/120000) - payment).
      // Round interest half up to cents; final contractual payment clears any rounding residual.
      let balance = math.amountFinanced;
      for (let month = 0; month < Math.min(monthsOwned, p.term); month++) balance = Math.max(0, balance + Number((BigInt(balance) * BigInt(p.aprBps) + 60000n) / 120000n) - math.payment);
      estimatedPayoffCents = monthsOwned >= p.term ? 0 : balance;
      payoffBasis = 'Estimated loan balance assuming on-time monthly payments; not a lender quote.';
    } else {
      // A lease is not a loan: amountFinanced is zero. Do not misrepresent it as owned outright.
      estimatedPayoffCents = math.lease!.monthlyPayment * remainingPayments! + math.lease!.purchaseOption;
      payoffBasis = 'Lease estimate: remaining scheduled payments plus purchase option; excludes buyout taxes/fees, not a lessor quote.';
    }
  }
  const reasons: string[] = [];
  if (monthsOwned >= 35) reasons.push(`Owned ${monthsOwned} whole months since ${sold}: ownership trade window starts at 35 months.`);
  if (termMonths !== null && monthsOwned >= termMonths) reasons.push(`${deal.type === 'lease' ? 'Lease' : 'Finance'} term of ${termMonths} months has ended after ${monthsOwned} months; ${remainingPayments} scheduled payments remain.`);
  if (vehicleAgeYears !== null && vehicleAgeYears >= 8 && monthsOwned >= 24) reasons.push(`Vehicle is ${vehicleAgeYears} years old and owned ${monthsOwned} months (thresholds: 8 years and 24 months).`);
  return {saleDate: sold, monthsOwned, vehicleAgeYears, termMonths, remainingPayments, estimatedPayoffCents, payoffBasis, reasons};
}
