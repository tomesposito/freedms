import type { CrmRecord } from './index.js';
export const creditStatuses = ['draft', 'ready', 'decision-recorded'] as const;
export type CreditStatus = typeof creditStatuses[number];
export const decisionOutcomes = ['approved', 'declined', 'conditioned'] as const;
export type DecisionOutcome = typeof decisionOutcomes[number];
export const adverseActionReasons = ['credit-history', 'insufficient-income', 'employment-history', 'insufficient-collateral', 'excessive-obligations', 'incomplete-application', 'unable-to-verify', 'other'] as const;
export type AdverseActionReason = typeof adverseActionReasons[number];
export const adverseActionReasonLabels: Record<AdverseActionReason, string> = {
  'credit-history': 'Credit history', 'insufficient-income': 'Insufficient income', 'employment-history': 'Employment history',
  'insufficient-collateral': 'Insufficient collateral', 'excessive-obligations': 'Excessive obligations',
  'incomplete-application': 'Incomplete application', 'unable-to-verify': 'Unable to verify information', other: 'Other',
};
export const housingStatuses = ['own', 'rent', 'living-with-family', 'other'] as const;
export interface CreditApplicant {
  fullName: string; dateOfBirth: string; ssnLast4: string; address: string; phone: string; email: string;
  housingStatus: typeof housingStatuses[number]; monthlyHousingPayment: number; yearsAtAddress: number;
  employerName: string; jobTitle: string; yearsEmployed: number; grossMonthlyIncome: number; otherMonthlyIncome: number; otherIncomeSource: string;
}
export interface CreditDecision {
  outcome: DecisionOutcome; lenderName: string; termsNote: string; decidedAt: string; decidedBy: string; adverseReasons: AdverseActionReason[];
}
export interface CreditApplication extends CrmRecord {
  kind: 'credit-application'; dealId: string; customerId: string; applicant: CreditApplicant; coApplicant: CreditApplicant | null;
  consentAt: string; status: CreditStatus; decision: CreditDecision | null;
}
export interface PayoffQuote extends CrmRecord {
  kind: 'payoff-quote'; dealId: string; lenderName: string; payoffAmount: number; goodThroughDate: string; accountLast4: string; quotedAt: string; notes: string;
}
export function maskedSsn(last4: string): string { return /^\d{4}$/.test(last4) ? `•••-••-${last4}` : 'Not on file'; }
