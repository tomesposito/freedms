import { randomUUID } from 'node:crypto';
import { assistantTiers, type AssistantPlan, type AssistantCycle, type AssistantLedgerEntry, type AssistantTokenUsage, type AssistantWaitlistEntry, type Principal } from '@freedms/shared';
import type { TenantRepository } from './repository.js';
import type { AssistantEntitlement } from './assistant.js';
import { tools } from './mcp/tools.js';
import { object, onlyKeys, invalid } from './validation.js';
import { ApiError } from './errors.js';

export const DEFAULT_ASSISTANT_OVERAGE_CAP = 500;
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
  beforeWrite(price: {credits: number}): Promise<string | undefined>;
  charge(action: string, price: Pick<AssistantLedgerEntry, 'actionClass' | 'credits'>, usage?: AssistantTokenUsage): Promise<string | undefined>;
  finish(): Promise<number>;
}
export class AssistantBilling implements AssistantEntitlement {
  constructor(private repository: TenantRepository, private now: () => Date, private seedLocalPlan = false) {}
  private async plan(actor: Actor) {
    let plan = await this.repository.assistantPlan();
    if (!plan && this.seedLocalPlan) {
      plan = {id: 'assistant-plan', tenantId: actor.tenantId, tier: 'assistant', status: 'active', cycleAnchor: this.now().toISOString(),
        disabled: false, overageEnabled: false, overageCapCredits: DEFAULT_ASSISTANT_OVERAGE_CAP, perRequestCreditCap: DEFAULT_ASSISTANT_CREDIT_CAP, version: 1};
      await this.repository.saveAssistantPlan(plan, 0, {id: randomUUID(), tenantId: actor.tenantId, actorId: actor.userId,
        aggregateId: plan.id, aggregateVersion: 1, type: 'assistant-plan.updated', occurredAt: this.now().toISOString(), deliveryStatus: 'pending'});
    }
    return plan ? {...plan, ...(plan.stripeSubscriptionId ? {overageEnabled: false} : {}), overageCapCredits: plan.overageCapCredits ?? DEFAULT_ASSISTANT_OVERAGE_CAP} : undefined;
  }
  private async ensureCycle(plan: AssistantPlan): Promise<AssistantCycle> {
    if (plan.stripeSubscriptionId) {
      const paid = plan.paidPeriodStart ? await this.repository.assistantCycle(plan.paidPeriodStart) : undefined;
      if (!paid) throw new ApiError(503, 'BILLING_PENDING', 'Waiting for payment confirmation.');
      return paid;
    }
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
    return {plan, cycle, pool: {tier: plan.tier, status: this.effectiveStatus(plan), disabled: plan.disabled, overageEnabled: plan.overageEnabled,
      overageCapCredits: plan.overageCapCredits, perRequestCreditCap: plan.perRequestCreditCap, cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd,
      allotmentCredits: cycle.allotmentCredits, topUpCredits: cycle.topUpCredits, usedCredits, balanceCredits,
      overageCreditsUsed: Math.max(0, -balanceCredits)}};
  }
  async pool(actor: Actor) { return (await this.snapshot(actor)).pool; }
  private effectiveStatus(plan: AssistantPlan) {
    if (plan.accessUntil && this.now().getTime() >= Date.parse(plan.accessUntil)) return 'cancelled' as const;
    if (plan.status === 'cancelled' && plan.accessUntil && this.now().getTime() < Date.parse(plan.accessUntil)) return 'active' as const;
    if (plan.stripeSubscriptionId && (!plan.paidPeriodEnd || this.now().getTime() >= Date.parse(plan.paidPeriodEnd))) return 'past_due' as const;
    return plan.status;
  }
  async status(actor: Actor) {
    const plan = await this.plan(actor);
    if (!plan) return {status: 'no-plan' as const, plan};
    if (plan.billingHold) return {status: 'billing-review' as const, plan};
    if (plan.stripeSubscriptionId && !(plan.licensedUserIds ?? []).includes(actor.userId)) return {status: 'unassigned' as const, plan};
    if (plan.disabled) return {status: 'disabled' as const, plan};
    if (this.effectiveStatus(plan) === 'past_due') return {status: 'past-due' as const, plan};
    if (this.effectiveStatus(plan) !== 'active') return {status: 'no-plan' as const, plan};
    const pool = await this.pool(actor);
    return {status: pool.balanceCredits <= 0 && (!plan.overageEnabled || pool.overageCreditsUsed >= plan.overageCapCredits) ? 'exhausted' as const : 'ok' as const, plan, pool};
  }
  async check(actor: Actor) { return (await this.status(actor)).status === 'ok'; }
  async requireEntitlement(actor: Actor) {
    const result = await this.status(actor);
    if (result.status === 'unassigned') throw new ApiError(403, 'ASSISTANT_UNASSIGNED', 'Ask your administrator to assign you AI access.');
    if (result.status === 'billing-review') throw new ApiError(402, 'ASSISTANT_BILLING_REVIEW', 'AI access is paused while a refund or dispute is reviewed. Contact support.');
    if (result.status === 'past-due') throw new ApiError(402, 'ASSISTANT_PAST_DUE', 'Payment is past due. Update billing in Account → AI assistant.');
    if (result.status === 'no-plan') throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An AI assistant plan is required.');
    if (result.status === 'disabled') throw new ApiError(403, 'ASSISTANT_DISABLED', 'The AI assistant is disabled for this workspace.');
    if (result.status === 'exhausted') throw new ApiError(402, 'ASSISTANT_CREDITS_EXHAUSTED', 'The AI assistant credit pool is exhausted.');
    return result.pool!;
  }
  async meter(actor: Actor): Promise<AssistantMeter> {
    await this.requireEntitlement(actor);
    let {pool} = await this.snapshot(actor);
    let total = 0;
    const stop = (price: {credits: number}) => total + price.credits > pool.perRequestCreditCap
      ? 'The assistant hit the credit cap for this message. Please send another message to continue.'
      : pool.balanceCredits + (pool.overageEnabled ? pool.overageCapCredits : 0) < price.credits
        ? pool.overageEnabled ? 'The assistant reached the monthly overage cap. Raise the cap or wait for the next cycle to continue.' : 'The assistant credit pool is exhausted. Add credits or wait for the next cycle to continue.' : undefined;
    return {
      // Reads use the last balance, reduced after each settlement. Writes refresh the fence.
      stop,
      beforeWrite: async price => {
        try { pool = await this.requireEntitlement(actor); }
        catch (error) {
          if (error instanceof ApiError && [402, 403].includes(error.status)) return error.message;
          return 'The assistant could not verify access. No further actions ran.';
        }
        return stop(price);
      },
      charge: async (action, price, usage = zeroUsage) => {
        const entry: AssistantLedgerEntry = {id: randomUUID(), tenantId: actor.tenantId, actorId: actor.userId, action, ...price, ...usage,
          cycleStart: pool.cycleStart, createdAt: this.now().toISOString()};
        try {
          for (let attempt = 0; attempt < 5; attempt++) {
            // Retry only the ledger with the SAME id; never replay a business action.
            // Read the original cycle even if the billing period rolls over during execution.
            const plan = await this.plan(actor);
            const cycle = await this.repository.assistantCycle(entry.cycleStart);
            if (!plan || !cycle) throw new Error('Billing state unavailable');
            try {
              await this.repository.commitAssistantLedger([entry], cycle, plan.version);
              total += price.credits; pool.balanceCredits -= price.credits;
              return;
            } catch (error) {
              // A lost acknowledgement may mean the debit is already durable.
              if ((await this.repository.assistantLedger(entry.cycleStart)).some(row => row.id === entry.id)) {
                total += price.credits; pool.balanceCredits -= price.credits;
                return;
              }
              if (!(error instanceof ApiError) || error.code !== 'CONFLICT' || attempt === 4) throw error;
            }
          }
        } catch {
          return action === 'answer'
            ? 'The assistant could not settle the answer charge. The answer has been withheld.'
            : `The action ${action} DID execute successfully, but its credit settlement could not be confirmed. No further actions ran. Review the completed action before retrying.`;
        }
      },
      finish: async () => total,
    };
  }

  async admin(actor: Actor, waitingListOnly = false) {
    const plan = waitingListOnly ? undefined : await this.plan(actor);
    const users = waitingListOnly ? [] : (await this.repository.workspaceUsers()).filter(row => row.membership.active).map(row => ({userId: row.user.id, name: row.user.name, assigned: (plan?.licensedUserIds ?? []).includes(row.user.id)}));
    if (!plan) {
      const entry = await this.repository.assistantWaitlist();
      const waitlist = entry ? {tier: entry.tier, tierName: assistantTiers[entry.tier].name,
        pricePerUserCents: assistantTiers[entry.tier].pricePerUserCents, creditsPerUser: assistantTiers[entry.tier].creditsPerUser,
        requestedAt: entry.requestedAt, requestedByName: entry.requestedByName} : null;
      return {plan: null, users, waitlist};
    }
    const {cycle, pool} = await this.snapshot(actor);
    const tier = assistantTiers[plan.tier];
    return {users, waitlist: null, billingHold: plan.billingHold, plan: {tier: plan.tier, tierName: tier.name, pricePerUserCents: tier.pricePerUserCents,
      creditsPerUser: tier.creditsPerUser, billedUserCount: plan.paidSeats ?? cycle.billedUserCount,
      monthlyTotalCents: tier.pricePerUserCents * (plan.paidSeats ?? cycle.billedUserCount), renewalDate: cycle.cycleEnd, status: this.effectiveStatus(plan), accessUntil: plan.accessUntil},
      pool, usage: (await this.usage(actor)).byUser,
      controls: {disabled: plan.disabled, overageEnabled: plan.overageEnabled,
        overageCapCredits: plan.overageCapCredits, perRequestCreditCap: plan.perRequestCreditCap}};
  }
  /** Joining the waiting list grants nothing: it records which plan the workspace wants for when paid plans open. */
  async joinWaitlist(actor: Actor, input: unknown, waitingListOnly = false) {
    const body = object(input);
    onlyKeys(body, ['tier']);
    if (typeof body.tier !== 'string' || !Object.hasOwn(assistantTiers, body.tier)) throw invalid('Choose a valid plan.');
    if (!waitingListOnly && await this.plan(actor)) throw new ApiError(409, 'ASSISTANT_WAITLIST_UNAVAILABLE', 'This workspace already has an AI assistant plan.');
    const me = (await this.repository.workspaceUsers()).find(row => row.membership.userId === actor.userId);
    const existing = await this.repository.assistantWaitlist();
    const record: AssistantWaitlistEntry = {id: 'assistant-waitlist', tenantId: actor.tenantId, tier: body.tier as keyof typeof assistantTiers,
      requestedById: actor.userId, requestedByName: me?.user.name ?? actor.userId, requestedByEmail: me?.user.email ?? '',
      requestedAt: this.now().toISOString(), version: (existing?.version ?? 0) + 1};
    await this.repository.saveAssistantWaitlist(record, existing?.version ?? 0, {id: randomUUID(), tenantId: actor.tenantId,
      actorId: actor.userId, aggregateId: record.id, aggregateVersion: record.version, type: 'assistant-waitlist.updated',
      occurredAt: this.now().toISOString(), deliveryStatus: 'pending'});
    return this.admin(actor, waitingListOnly);
  }
  async leaveWaitlist(actor: Actor, waitingListOnly = false) {
    const existing = await this.repository.assistantWaitlist();
    if (existing) await this.repository.deleteAssistantWaitlist(existing.version, {id: randomUUID(), tenantId: actor.tenantId,
      actorId: actor.userId, aggregateId: existing.id, aggregateVersion: existing.version + 1, type: 'assistant-waitlist.removed',
      occurredAt: this.now().toISOString(), deliveryStatus: 'pending'});
    return this.admin(actor, waitingListOnly);
  }
  async updateSettings(actor: Actor, input: unknown) {
    const body = object(input);
    onlyKeys(body, ['disabled', 'overageEnabled', 'overageCapCredits', 'perRequestCreditCap']);
    for (const key of ['disabled', 'overageEnabled']) {
      if (key in body && typeof body[key] !== 'boolean') throw invalid(`${key} must be a boolean.`);
    }
    for (const [key, min, max] of [['overageCapCredits', 0, 100000], ['perRequestCreditCap', 1, 1000]] as const) {
      if (key in body && (typeof body[key] !== 'number' || !Number.isInteger(body[key]) || body[key] < min || body[key] > max))
        throw invalid(`${key} must be an integer from ${min} to ${max}.`);
    }
    const plan = await this.plan(actor);
    if (!plan) throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An AI assistant plan is required.');
    if (plan.stripeSubscriptionId && body.overageEnabled === true) throw invalid('Overage billing is unavailable. Purchase prepaid credits instead.');
    const updated = {...plan, ...body, version: plan.version + 1} as AssistantPlan;
    await this.repository.saveAssistantPlan(updated, plan.version, {id: randomUUID(), tenantId: actor.tenantId,
      actorId: actor.userId, aggregateId: plan.id, aggregateVersion: updated.version, type: 'assistant-plan.updated',
      occurredAt: this.now().toISOString(), deliveryStatus: 'pending'});
    return this.admin(actor);
  }
  async usage(actor: Actor) {
    const pool = await this.pool(actor);
    const names = new Map((await this.repository.workspaceUsers()).map(row => [row.membership.userId, row.user.name]));
    const byUser = new Map<string, {userId: string; name: string; lastUsedAt: string | null; actions: number; credits: number; skills: Record<string, {actions: number; credits: number}>} & AssistantTokenUsage>();
    for (const row of await this.repository.assistantLedger(pool.cycleStart)) {
      if (actor.role !== 'admin' && row.actorId !== actor.userId) continue;
      const sum = byUser.get(row.actorId) ?? {userId: row.actorId, name: names.get(row.actorId) ?? row.actorId, lastUsedAt: null, actions: 0, credits: 0, skills: {}, ...zeroUsage};
      if (!sum.lastUsedAt || row.createdAt > sum.lastUsedAt) sum.lastUsedAt = row.createdAt;
      sum.actions++; sum.credits += row.credits;
      if (row.action.startsWith('skill:')) {
        const skill = row.action.split(':')[1];
        const usage = sum.skills[skill] ?? {actions: 0, credits: 0};
        usage.actions++; usage.credits += row.credits; sum.skills[skill] = usage;
      }
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) sum[key] += row[key];
      byUser.set(row.actorId, sum);
    }
    return {cycleStart: pool.cycleStart, cycleEnd: pool.cycleEnd, byUser: [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId))};
  }
}
