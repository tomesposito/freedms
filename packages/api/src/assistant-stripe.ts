import { randomUUID } from 'node:crypto';
import { assistantTiers, type AssistantPlan, type AssistantCycle, type OutboxEvent, type Principal } from '@freedms/shared';
import { AssistantBilling, assistantCycleDates, DEFAULT_ASSISTANT_CREDIT_CAP, DEFAULT_ASSISTANT_OVERAGE_CAP } from './assistant-billing.js';
import type { RepositoryFactory, TenantRepository } from './repository.js';
import { billingUnavailable, validTopUp, type StripeBilling, type AssistantTier } from './stripe.js';
import { ApiError } from './errors.js';
import { object, onlyKeys, invalid } from './validation.js';
export function billingReturnUrl(base: string | undefined, origin: string | undefined, hosted: boolean): string {
  const local = origin && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin) ? origin : 'http://127.0.0.1:5173';
  if (!base && hosted) throw new ApiError(503, 'BILLING_UNAVAILABLE', 'Billing return URL is not set up.');
  const url = new URL(base || local);
  if (url.protocol !== 'https:' && (hosted || !['localhost', '127.0.0.1'].includes(url.hostname))) throw billingUnavailable();
  return new URL('/#/account/assistant', url).href;
}
function outbox(tenantId: string, actorId: string, version: number, now: Date, link = false): OutboxEvent {
  return {id: randomUUID(), tenantId, actorId, aggregateId: link ? 'assistant-billing' : 'assistant-plan', aggregateVersion: version,
    type: link ? 'assistant-billing.updated' : 'assistant-plan.updated', occurredAt: now.toISOString(), deliveryStatus: 'pending'};
}
export async function billingAction(repository: TenantRepository, stripe: StripeBilling, actor: Principal, action: string, input: unknown, returnUrl: string, now: Date) {
  if (!stripe.configured) throw billingUnavailable();
  const body = object(input);
  onlyKeys(body, action === 'checkout' ? ['tier'] : action === 'topup' ? ['credits'] : []);
  if (action === 'checkout' && (typeof body.tier !== 'string' || !Object.hasOwn(assistantTiers, body.tier))) throw invalid('Choose an assistant tier.');
  if (action === 'topup' && !validTopUp(body.credits)) throw invalid('Choose 1 to 100000 credits.');
  const plan = await repository.assistantPlan();
  if (action === 'checkout' && plan && (plan.status !== 'cancelled' || (plan.accessUntil && Date.parse(plan.accessUntil) > now.getTime())))
    throw new ApiError(409, 'BILLING_PLAN_EXISTS', 'Manage the existing plan in billing.');
  if (action === 'topup' && (!plan || plan.status !== 'active' || (plan.accessUntil && Date.parse(plan.accessUntil) <= now.getTime())))
    throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An active assistant plan is required to add credits.');
  let link = await repository.assistantBillingLink();
  if (!link && action !== 'checkout') throw new ApiError(409, 'BILLING_CUSTOMER_REQUIRED', 'There is no billing customer to manage.');
  if (!link) {
    const customerId = await stripe.createCustomer(actor.tenantId);
    link = {tenantId: actor.tenantId, customerId, version: 1};
    try { await repository.saveAssistantBillingLink(link, outbox(actor.tenantId, actor.userId, 1, now, true)); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CONFLICT') throw error;
      const saved = await repository.assistantBillingLink(); if (!saved) throw error; link = saved;
    }
  }
  if (action === 'portal') return stripe.portal(link.customerId, returnUrl);
  if (action === 'topup') return stripe.checkoutTopUp(link.customerId, body.credits as number, returnUrl);
  const seats = (await repository.workspaceUsers()).filter(row => row.membership.active).length;
  if (!seats) throw invalid('At least one active user is required.');
  return stripe.checkoutSubscription(link.customerId, body.tier as AssistantTier, seats, returnUrl);
}
export async function stripeWebhook(repositories: RepositoryFactory, stripe: StripeBilling, raw: string, signature: string | undefined, now: Date) {
  const event = await stripe.verifyEvent(raw, signature);
  if (!event.customerId) return;
  const tenantId = await repositories.tenantForStripeCustomer?.(event.customerId);
  if (!tenantId) return;
  const repo = repositories.forTenant(tenantId), link = await repo.assistantBillingLink();
  if (link?.customerId !== event.customerId || await repo.stripeEventProcessed(event.id)) return;
  const old = await repo.assistantPlan();
  let plan: AssistantPlan | undefined, cycle: AssistantCycle | undefined;
  if (event.subscription) {
    const sub = event.subscription;
    if (sub.customerId !== link.customerId || (old?.stripeSubscriptionId && old.stripeSubscriptionId !== sub.id &&
        (old.status !== 'cancelled' || (old.accessUntil && Date.parse(old.accessUntil) > now.getTime())))) return;
    // An initial subscription record is never an entitlement until money has arrived.
    if (!old && (!sub.paid || sub.status !== 'active')) return;
    const status = sub.status === 'active' ? 'active' : ['past_due', 'unpaid'].includes(sub.status) ? 'past_due' : 'cancelled';
    const accessUntil = sub.endedAt ?? (sub.cancelAtPeriodEnd || status === 'cancelled' ? sub.periodEnd : undefined);
    plan = {id: 'assistant-plan', tenantId, disabled: false, overageEnabled: false, overageCapCredits: DEFAULT_ASSISTANT_OVERAGE_CAP,
      perRequestCreditCap: DEFAULT_ASSISTANT_CREDIT_CAP, ...old, tier: sub.tier, status,
      cycleAnchor: old?.stripeSubscriptionId === sub.id ? old.cycleAnchor : sub.periodStart, stripeCustomerId: link.customerId, stripeSubscriptionId: sub.id,
      accessUntil, version: (old?.version ?? 0) + 1};
    // A trial, incomplete subscription or replacement must not revive an old plan for free.
    if (!['active', 'past_due', 'unpaid', 'canceled'].includes(sub.status)) plan.accessUntil = now.toISOString();
    if (status === 'active' && !sub.paid) return;
  } else if (event.payment && old) {
    if (!validTopUp(event.payment.credits) || await repo.stripeEventProcessed(event.payment.id)) return;
    const billing = new AssistantBilling(repo, () => now);
    const dates = assistantCycleDates(old.cycleAnchor, now);
    // Ensure the normal allotment/proration first; the purchased credits and receipt commit together.
    await billing.pool({tenantId, userId: 'stripe', role: 'admin'});
    const current = (await repo.assistantCycle(dates.cycleStart))!;
    cycle = {...current, topUpCredits: current.topUpCredits + event.payment.credits, version: current.version + 1};
    plan = {...old, version: old.version + 1};
  }
  if (!plan) return;
  // DynamoDB does not marshal undefined attributes; resuming removes the access cutoff.
  if (plan.accessUntil === undefined) delete plan.accessUntil;
  try {
    await repo.commitStripeEvent({eventId: event.id, paymentId: event.payment?.id, plan, cycle,
      event: outbox(tenantId, 'stripe', plan.version, now)});
  } catch (error) {
    // Concurrent duplicates can lose the optimistic race. Other conflicts must be retried by Stripe.
    if (error instanceof ApiError && error.code === 'CONFLICT' &&
        (await repo.stripeEventProcessed(event.id) || (event.payment && await repo.stripeEventProcessed(event.payment.id)))) return;
    throw error;
  }
}
