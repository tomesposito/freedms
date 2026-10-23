import type { DealView, Pencil, pencilMath } from '@freedms/shared';
import { currency, escapeHtml as e } from './format';
/** Buyer-safe lease steps shared by the live worksheet and printed packet. */
export function leaseSummary(p: Pencil, d: DealView, m: ReturnType<typeof pencilMath>): string {
  const l = m.lease; if (!l) return '';
  const rows: [string, string][] = [
    ['MSRP', currency(l.msrp)],
    ['Gross capitalized cost', currency(l.grossCapCost)],
    ['Acquisition fee (capitalized)', currency(l.acquisitionFee)],
    ['Doc fee (capitalized)', currency(d.docFee)],
    ['Adjustments — cash down', currency(p.down)],
    ['Adjustments — trade net equity', currency(m.netEquity)],
    ['Adjusted capitalized cost', currency(l.adjustedCapCost)],
    ['Residual value', `${currency(l.residualAmount)} (${(l.residualPercentBps / 100).toFixed(2)}% of MSRP)`],
    ['Money factor', (l.moneyFactorMicro / 1000000).toFixed(6)],
    ['Equivalent APR', `${(l.aprBpsEquivalent / 100).toFixed(2)}% from money factor`],
    ['Term', `${p.term} months`], ['Miles per year allowance', String(l.milesPerYear)],
    ['Depreciation fee /mo', currency(l.depreciationFee)], ['Rent charge /mo', currency(l.rentCharge)],
    ['Base payment /mo', currency(l.basePayment)],
    [`Sales tax /mo — payment-based: ${(d.taxRateBps / 100).toFixed(2)}% of each monthly payment`, currency(l.monthlyTax)],
    ['Monthly payment', currency(l.monthlyPayment)], ['Total of payments (includes total tax)', currency(l.totalPayments)],
    ['Total tax over term', currency(l.totalTax)], ['Total rent charge', currency(l.totalRentCharge)],
    ['Amount due at signing (drive-off)', currency(l.driveOff)],
    ['Drive-off split: cash down + first payment + security deposit', `${currency(p.down)} + ${currency(l.monthlyPayment)} + ${currency(l.securityDeposit)}`],
    ['Security deposit (refundable)', currency(l.securityDeposit)],
    ['Total cost (cash down + total payments; refundable deposit excluded)', currency(m.totalCost)],
    ['End-of-lease purchase option', currency(l.purchaseOption)]
  ];
  return `<dl class="jacket-numbers">${rows.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><p>Tax is on each monthly payment. Trade equity reduces capitalized cost. Acquisition and doc fees are capitalized. Rent charge is not interest.</p>`;
}
