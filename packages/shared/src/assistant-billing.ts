export const assistantTiers = {
  assistant: {name: 'Assistant', pricePerUserCents: 1500, creditsPerUser: 75},
  'assistant-pro': {name: 'Assistant Pro', pricePerUserCents: 2900, creditsPerUser: 175},
  'assistant-heavy': {name: 'Assistant Heavy', pricePerUserCents: 4900, creditsPerUser: 350},
} as const;
export interface AssistantPlan {
  id: 'assistant-plan'; tenantId: string; tier: keyof typeof assistantTiers;
  status: 'active' | 'past_due' | 'cancelled'; cycleAnchor: string;
  stripeCustomerId?: string; stripeSubscriptionId?: string; accessUntil?: string;
  licensedUserIds?: string[]; paidSeats?: number; paidPeriodStart?: string; paidPeriodEnd?: string; paidInvoiceId?: string;
  appliedSeatChangeId?: string; checkoutPurchaseId?: string;
  billingHold?: 'refund' | 'dispute';
  disabled: boolean; overageEnabled: boolean; overageCapCredits: number; perRequestCreditCap: number; version: number;
}
export interface AssistantCycle {
  id: string; tenantId: string; cycleStart: string; cycleEnd: string; billedUserCount: number;
  allotmentCredits: number; topUpCredits: number; version: number;
  paidCapacity?: number;
}
export interface AssistantTokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface AssistantLedgerEntry extends AssistantTokenUsage {
  id: string; tenantId: string; actorId: string; action: string;
  actionClass: 'read' | 'write' | 'photo' | 'answer'; credits: number; cycleStart: string; createdAt: string;
}
