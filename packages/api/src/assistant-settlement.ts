import type { AssistantCycle, AssistantLedgerEntry, AssistantPlan } from '@freedms/shared';
import { ApiError } from './errors.js';

export const DEFAULT_ASSISTANT_OVERAGE_CAP = 500;

/** The caller must fence the plan and cycle versions through the atomic commit. */
export function assertAssistantBalance(entries: AssistantLedgerEntry[], cycle: AssistantCycle, plan: AssistantPlan, ledger: AssistantLedgerEntry[]) {
  const settled = ledger.filter(row => row.cycleStart === cycle.cycleStart).reduce((sum, row) => sum + row.credits, 0);
  const debit = entries.reduce((sum, row) => sum + row.credits, 0);
  const overage = plan.overageEnabled && !plan.stripeSubscriptionId ? plan.overageCapCredits ?? DEFAULT_ASSISTANT_OVERAGE_CAP : 0;
  if (settled + debit > cycle.allotmentCredits + cycle.topUpCredits + overage)
    throw new ApiError(402, 'ASSISTANT_CREDITS_EXHAUSTED', 'The assistant credit pool is exhausted.');
}
