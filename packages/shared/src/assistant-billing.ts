export const assistantTiers = {
  assistant: {creditsPerUser: 75}, 'assistant-pro': {creditsPerUser: 175}, 'assistant-heavy': {creditsPerUser: 350},
} as const;
export interface AssistantPlan {
  id: 'assistant-plan'; tenantId: string; tier: keyof typeof assistantTiers;
  status: 'active' | 'past_due' | 'cancelled'; cycleAnchor: string;
  disabled: boolean; overageEnabled: boolean; perRequestCreditCap: number; version: number;
}
export interface AssistantCycle {
  id: string; tenantId: string; cycleStart: string; cycleEnd: string; billedUserCount: number;
  allotmentCredits: number; topUpCredits: number; version: number;
}
export interface AssistantTokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface AssistantLedgerEntry extends AssistantTokenUsage {
  id: string; tenantId: string; actorId: string; action: string;
  actionClass: 'read' | 'write' | 'photo' | 'answer'; credits: number; cycleStart: string; createdAt: string;
}
