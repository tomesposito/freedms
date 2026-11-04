import { randomUUID } from 'node:crypto';
import { assistantTiers, type AssistantPlan, type AssistantCycle, type AssistantLedgerEntry, type AssistantTokenUsage, type Principal } from '@freedms/shared';
import type { TenantRepository } from './repository.js';
import type { AssistantEntitlement } from './assistant.js';
import { tools } from './mcp/tools.js';
import { ApiError } from './errors.js';

export const DEFAULT_ASSISTANT_CREDIT_CAP = 25;
export const PHOTO_PRICE = {actionClass: 'photo', credits: 3} as const;
export const ANSWER_PRICE = {actionClass: 'answer', credits: 1} as const;
export const zeroUsage: AssistantTokenUsage = {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0};
export function priceForTool(name: string) {
  const tool = tools.find(tool => tool.name === name);
  return tool ? {actionClass: tool.method === 'GET' ? 'read' as const : 'write' as const, credits: tool.method === 'GET' ? 1 : 2} : undefined;
}
/** Calendar dates in UTC; every anniversary uses the ORIGINAL anchor day. */
export function assistantCycleDates(anchor: string, date: Date) {
  const origin = new Date(anchor);
  if (!Number.isFinite(origin.getTime()) || !Number.isFinite(date.getTime())) throw new Error('Invalid cycle date');
  const anniversary = (offset: number) => {
    const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(origin.getUTCDate(), last)));
  };
  const offset = date < anniversary(0) ? -1 : 0;
  return {cycleStart: anniversary(offset).toISOString().slice(0, 10), cycleEnd: anniversary(offset + 1).toISOString().slice(0, 10)};
}
export function proratedAssistantCredits(credits: number, added: number, cycleStart: string, cycleEnd: string, today: Date) {
  const days = (Date.parse(cycleEnd) - Date.parse(cycleStart)) / 86400000;
  const remaining = Math.max(0, Math.min(days, (Date.parse(cycleEnd) - Date.parse(today.toISOString().slice(0, 10))) / 86400000));
  return added * Math.floor(credits * remaining / days);
}
type Actor = Pick<Principal, 'tenantId' | 'userId' | 'role'>;
export interface AssistantMeter {
  stop(price: {credits: number}): string | undefined;
  charge(action: string, price: Pick<AssistantLedgerEntry, 'actionClass' | 'credits'>, usage?: AssistantTokenUsage): void;
  finish(): Promise<number>;
}
export class AssistantBilling implements AssistantEntitlement {
  constructor(private repository: TenantRepository, private now: () => Date, private seedLocalPlan = false) {}
  private async plan(actor: Actor) {
    let plan = await this.repository.assistantPlan();
    if (!plan && this.seedLocalPlan) {
      plan = {id: 'assistant-plan', tenantId: actor.tenantId, tier: 'assistant', status: 'active', cycleAnchor: this.now().toISOString(),
        disabled: false, overageEnabled: false, perRequestCreditCap: DEFAULT_ASSISTANT_CREDIT_CAP, version: 1};
      await this.repository.saveAssistantPlan(plan, 0, {id: randomUUID(), tenantId: actor.tenantId, actorId: actor.userId,
        aggregateId: plan.id, aggregateVersion: 1, type: 'assistant-plan.updated', occurredAt: this.now().toISOString(), deliveryStatus: 'pending'});
    }
    return plan;
  }
  private async ensureCycle(plan: AssistantPlan): Promise<AssistantCycle> {
    const date = this.now(), dates = assistantCycleDates(plan.cycleAnchor, date);
    const count = (await this.repository.workspaceUsers()).filter(row => row.membership.active).length;
    const credits = assistantTiers[plan.tier].creditsPerUser;
    let cycle = await this.repository.assistantCycle(dates.cycleStart);
    if (!cycle) {
      cycle = {id: dates.cycleStart, tenantId: plan.tenantId, ...dates, billedUserCount: count, allotmentCredits: count * credits, topUpCredits: 0, version: 1};
      await this.repository.saveAssistantCycle(cycle, 0);
    } else if (count > cycle.billedUserCount) {
      const expected = cycle.version;
      cycle = {...cycle, billedUserCount: count, version: expected + 1,
        allotmentCredits: cycle.allotmentCredits + proratedAssistantCredits(credits, count - cycle.billedUserCount, cycle.cycleStart, cycle.cycleEnd, date)};
      await this.repository.saveAssistantCycle(cycle, expected);
    }
    return cycle;
  }
  private async snapshot(actor: Actor) {
    const plan = await this.plan(actor);
    if (!plan) throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An AI assistant plan is required.');
    const cycle = await this.ensureCycle(plan);
    const usedCredits = (await this.repository.assistantLedger(cycle.cycleStart)).reduce((sum, row) => sum + row.credits, 0);
    const balanceCredits = cycle.allotmentCredits + cycle.topUpCredits - usedCredits;
    return {plan, cycle, pool: {tier: plan.tier, status: plan.status, disabled: plan.disabled, overageEnabled: plan.overageEnabled,
      perRequestCreditCap: plan.perRequestCreditCap, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd,
      allotmentCredits: cycle.allotmentCredits, topUpCredits: cycle.topUpCredits, usedCredits, balanceCredits,
      overageCreditsUsed: Math.max(0, -balanceCredits)}};
  }
  async pool(actor: Actor) { return (await this.snapshot(actor)).pool; }
  async status(actor: Actor) {
    const plan = await this.plan(actor);
    if (!plan || plan.status !== 'active') return {status: 'no-plan' as const, plan};
    if (plan.disabled) return {status: 'disabled' as const, plan};
    const pool = await this.pool(actor);
    return {status: pool.balanceCredits <= 0 && !plan.overageEnabled ? 'exhausted' as const : 'ok' as const, plan, pool};
  }
  async check(actor: Actor) { return (await this.status(actor)).status === 'ok'; }
  async requireEntitlement(actor: Actor) {
    const result = await this.status(actor);
    if (result.status === 'no-plan') throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An AI assistant plan is required.');
    if (result.status === 'disabled') throw new ApiError(403, 'ASSISTANT_DISABLED', 'The AI assistant is disabled for this workspace.');
    if (result.status === 'exhausted') throw new ApiError(402, 'ASSISTANT_CREDITS_EXHAUSTED', 'The AI assistant credit pool is exhausted.');
    return result.pool!;
  }
  async meter(actor: Actor): Promise<AssistantMeter> {
    await this.requireEntitlement(actor);
    const {pool, cycle, plan} = await this.snapshot(actor);
    const pending: AssistantLedgerEntry[] = []; let total = 0;
    return {
      stop: price => total + price.credits > pool.perRequestCreditCap
        ? 'The assistant hit the credit cap for this message. Please send another message to continue.'
        : !pool.overageEnabled && pool.balanceCredits - total < price.credits
          ? 'The assistant credit pool is exhausted. Add credits or wait for the next cycle to continue.' : undefined,
      charge: (action, price, usage = zeroUsage) => {
        pending.push({id: randomUUID(), tenantId: actor.tenantId, actorId: actor.userId, action, ...price, ...usage,
          cycleStart: pool.cycleStart, createdAt: this.now().toISOString()}); total += price.credits;
      },
      finish: async () => {
        // An optimistic conflict fails the turn without publishing any debit. No retry:
        // business actions may have executed and must never be replayed automatically.
        if (pending.length) await this.repository.commitAssistantLedger(pending, cycle, plan.version);
        return total;
      },
    };
  }
  async usage(actor: Actor) {
    const pool = await this.pool(actor);
    const byUser = new Map<string, {userId: string; actions: number; credits: number} & AssistantTokenUsage>();
    for (const row of await this.repository.assistantLedger(pool.cycleStart)) {
      if (actor.role !== 'admin' && row.actorId !== actor.userId) continue;
      const sum = byUser.get(row.actorId) ?? {userId: row.actorId, actions: 0, credits: 0, ...zeroUsage};
      sum.actions++; sum.credits += row.credits;
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) sum[key] += row[key];
      byUser.set(row.actorId, sum);
    }
    return {cycleStart: pool.cycleStart, cycleEnd: pool.cycleEnd, byUser: [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId))};
  }
}
