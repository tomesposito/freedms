import { randomUUID } from 'node:crypto';
import { assistantTiers, type AssistantPlan, type AssistantCycle, type OutboxEvent, type Principal } from '@freedms/shared';
import { AssistantBilling, assistantCycleDates, DEFAULT_ASSISTANT_CREDIT_CAP, DEFAULT_ASSISTANT_OVERAGE_CAP } from './assistant-billing.js';
import type { RepositoryFactory, TenantRepository } from './repository.js';
import { billingUnavailable, validTopUp, type StripeBilling, type AssistantTier, type StripeSubscription } from './stripe.js';
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
async function selectedUsers(repository: TenantRepository, value: unknown, fallback: string[]): Promise<string[]> {
  const ids = value === undefined ? fallback : value;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw invalid('Select 1 to 100 users for AI access.');
  const active = new Set((await repository.workspaceUsers()).filter(row => row.membership.active).map(row => row.user.id));
  if (ids.some(id => !active.has(id))) throw invalid('AI access can only be assigned to active users in this dealership.');
  return [...ids].sort();
}
export async function billingAction(repository: TenantRepository, stripe: StripeBilling, actor: Principal, action: string, input: unknown, returnUrl: string, now: Date) {
  if (!stripe.configured) throw billingUnavailable();
  const body = object(input);
  onlyKeys(body, action === 'checkout' ? ['tier', 'userIds'] : action === 'seats' ? ['userIds', 'tier'] : action === 'topup' ? ['credits', 'requestId'] : []);
  if ((action === 'checkout' || (action === 'seats' && body.tier !== undefined)) && (typeof body.tier !== 'string' || !Object.hasOwn(assistantTiers, body.tier))) throw invalid('Choose an assistant tier.');
  if (action === 'topup' && !validTopUp(body.credits)) throw invalid('Choose 2 to 100000 credits.');
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId))) throw invalid('Invalid purchase identifier.');
  const plan = await repository.assistantPlan();
  if (action === 'checkout' && plan && (plan.status !== 'cancelled' || (plan.accessUntil && Date.parse(plan.accessUntil) > now.getTime())))
    throw new ApiError(409, 'BILLING_PLAN_EXISTS', 'Manage the existing plan in billing.');
  if (['topup', 'seats'].includes(action) && (!plan || plan.status !== 'active' || plan.billingHold || (plan.paidPeriodEnd && Date.parse(plan.paidPeriodEnd) <= now.getTime()) || (plan.accessUntil && Date.parse(plan.accessUntil) <= now.getTime())))
    throw new ApiError(402, 'ASSISTANT_PLAN_REQUIRED', 'An active paid assistant plan is required.');
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
  if (action === 'topup') return stripe.checkoutTopUp(link.customerId, body.credits as number, returnUrl, `topup-${actor.tenantId}-${body.requestId ?? randomUUID()}`);
  const userIds = await selectedUsers(repository, body.userIds, plan?.licensedUserIds ?? [actor.userId]);
  if (action === 'seats') {
    if (!plan?.stripeSubscriptionId || !stripe.updateSubscription) throw billingUnavailable();
    const tier = (body.tier ?? plan.tier) as AssistantTier;
    if (link.seatChange && link.seatChange.id !== plan.appliedSeatChangeId && stripe.getSubscription) {
      const current = await stripe.getSubscription(plan.stripeSubscriptionId);
      if (current.pending) return stripe.portal(link.customerId, returnUrl);
      if (current.quantity !== plan.paidSeats || current.tier !== plan.tier) throw new ApiError(409, 'BILLING_PENDING', 'Waiting for payment confirmation. Please refresh shortly.');
      const cleared = {...link, version: link.version + 1}; delete cleared.seatChange;
      await repository.updateAssistantBillingLink(cleared, link.version, outbox(actor.tenantId, actor.userId, cleared.version, now, true)); link = cleared;
    }
    // Reassigning already-paid seats does not change the subscription quantity.
    if (userIds.length === plan.paidSeats && tier === plan.tier) {
      if (link.seatChange && link.seatChange.id !== plan.appliedSeatChangeId)
        throw new ApiError(409, 'BILLING_PENDING', 'Wait for the pending seat change before reassigning access.');
      await repository.saveAssistantPlan({...plan, licensedUserIds: userIds, version: plan.version + 1}, plan.version, outbox(actor.tenantId, actor.userId, plan.version + 1, now));
      return {url: returnUrl};
    }
    const same = link.seatChange && JSON.stringify(link.seatChange.userIds) === JSON.stringify(userIds) && link.seatChange.tier === tier;
    if (link.seatChange && !same && link.seatChange.id !== plan.appliedSeatChangeId)
      throw new ApiError(409, 'BILLING_PENDING', 'Resolve the pending payment before changing seats again.');
    if (!same) {
      const updated = {...link, seatChange: {id: randomUUID(), userIds, tier, requestedAt: now.toISOString()}, version: link.version + 1};
      await repository.updateAssistantBillingLink(updated, link.version, outbox(actor.tenantId, actor.userId, updated.version, now, true)); link = updated;
    }
    const sub = await stripe.updateSubscription(plan.stripeSubscriptionId, userIds.length, tier, link.seatChange!.id);
    return sub.pending || !sub.paid ? stripe.portal(link.customerId, returnUrl) : {url: returnUrl};
  }
  if (!link.purchase || plan?.checkoutPurchaseId === link.purchase.id || link.purchase.expiresAt <= Math.floor(now.getTime() / 1000)) {
    const updated = {...link, userIds, purchase: {id: randomUUID(), tier: body.tier as AssistantTier, userIds, expiresAt: Math.floor(now.getTime() / 1000) + 3600}, version: link.version + 1};
    delete updated.seatChange;
    try { await repository.updateAssistantBillingLink(updated, link.version, outbox(actor.tenantId, actor.userId, updated.version, now, true)); link = updated; }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CONFLICT') throw error;
      link = (await repository.assistantBillingLink())!;
    }
  }
  if (!link.purchase || link.purchase.tier !== body.tier || JSON.stringify(link.purchase.userIds) !== JSON.stringify(userIds))
    throw new ApiError(409, 'BILLING_PENDING', 'An earlier checkout is still open. Complete it or wait up to one hour before selecting a different plan.');
  return stripe.checkoutSubscription(link.customerId, link.purchase.tier, userIds.length, returnUrl, link.purchase);
}

async function paidCycle(repo: TenantRepository, old: AssistantPlan | undefined, sub: StripeSubscription, tenantId: string, now: Date) {
  const start = sub.periodStart, end = sub.periodEnd, capacity = sub.quantity! * assistantTiers[sub.tier].creditsPerUser;
  const current = await repo.assistantCycle(start);
  if (current) {
    const previousCapacity = current.paidCapacity ?? current.billedUserCount * assistantTiers[old?.tier ?? sub.tier].creditsPerUser;
    const fraction = Math.max(0, Math.min(1, (Date.parse(end) - Date.parse(sub.changedAt ?? now.toISOString())) / (Date.parse(end) - Date.parse(start))));
    const added = Math.floor(Math.max(0, capacity - previousCapacity) * fraction);
    return {cycle: {...current, billedUserCount: sub.quantity!, paidCapacity: Math.max(previousCapacity, capacity), allotmentCredits: current.allotmentCredits + added, version: current.version + 1}};
  }
  const previous = old?.paidPeriodStart ? await repo.assistantCycle(old.paidPeriodStart) : undefined;
  const used = previous ? (await repo.assistantLedger(previous.cycleStart)).reduce((sum, row) => sum + row.credits, 0) : 0;
  const carry = previous ? Math.max(0, previous.topUpCredits - Math.max(0, used - previous.allotmentCredits)) : 0;
  return {cycle: {id: start, tenantId, cycleStart: start, cycleEnd: end, billedUserCount: sub.quantity!, paidCapacity: capacity,
    allotmentCredits: capacity, topUpCredits: carry, version: 1}, ...(previous ? {previousCycle: {id: previous.id, version: previous.version}} : {})};
}
export async function stripeWebhook(repositories: RepositoryFactory, stripe: StripeBilling, raw: string, signature: string | undefined, now: Date, sandboxOwner?: Pick<Principal, 'userId' | 'tenantId'> | null) {
  const event = await stripe.verifyEvent(raw, signature);
  if (!event.customerId) return;
  const tenantId = await repositories.tenantForStripeCustomer?.(event.customerId);
  if (!tenantId) return;
  const repo = repositories.forTenant(tenantId), link = await repo.assistantBillingLink();
  if (sandboxOwner !== undefined) {
    if (!sandboxOwner?.userId || tenantId !== sandboxOwner.tenantId) return;
    const member = await repo.membership(sandboxOwner.userId);
    if (!member?.active || member.role !== 'admin') return;
  }
  if (link?.customerId !== event.customerId || await repo.stripeEventProcessed(event.id)) return;
  const old = await repo.assistantPlan();
  let plan: AssistantPlan | undefined, cycle: AssistantCycle | undefined, previousCycle: {id: string; version: number} | undefined;
  if (event.subscription) {
    const sub = event.subscription;
    if (sub.customerId !== link.customerId || (old?.stripeSubscriptionId && old.stripeSubscriptionId !== sub.id &&
        (old.status !== 'cancelled' || (old.accessUntil && Date.parse(old.accessUntil) > now.getTime())))) return;
    // An initial subscription record is never an entitlement until money has arrived.
    if (!old && (!sub.paid || sub.status !== 'active')) return;
    if (sub.pending || (sub.status === 'active' && !sub.paid)) return;
    if (old?.paidPeriodStart && sub.periodStart < old.paidPeriodStart) return;
    if (sub.paid && (!Number.isSafeInteger(sub.quantity) || sub.quantity! < 1 || !sub.invoiceId)) throw new ApiError(502, 'STRIPE_RESPONSE', 'Missing paid seat or invoice details.');
    const status = sub.status === 'active' ? 'active' : ['past_due', 'unpaid'].includes(sub.status) ? 'past_due' : 'cancelled';
    const accessUntil = sub.endedAt ?? (sub.cancelAtPeriodEnd || status === 'cancelled' ? sub.periodEnd : undefined);
    plan = {id: 'assistant-plan', tenantId, disabled: false, overageEnabled: false, overageCapCredits: DEFAULT_ASSISTANT_OVERAGE_CAP,
      perRequestCreditCap: DEFAULT_ASSISTANT_CREDIT_CAP, ...old, tier: sub.tier, status,
      cycleAnchor: old?.stripeSubscriptionId === sub.id ? old.cycleAnchor : sub.periodStart, stripeCustomerId: link.customerId, stripeSubscriptionId: sub.id,
      accessUntil, version: (old?.version ?? 0) + 1};
    // A trial, incomplete subscription or replacement must not revive an old plan for free.
    if (!['active', 'past_due', 'unpaid', 'canceled'].includes(sub.status)) plan.accessUntil = now.toISOString();
    if (status === 'active' && sub.paid) {
      const newSubscription = old?.stripeSubscriptionId !== sub.id;
      const change = !newSubscription && link.seatChange && link.seatChange.id !== old?.appliedSeatChangeId && link.seatChange.userIds.length === sub.quantity && (!link.seatChange.tier || link.seatChange.tier === sub.tier) ? link.seatChange : undefined;
      const requested = newSubscription ? link.purchase?.userIds ?? link.userIds ?? [] : change?.userIds ?? old?.licensedUserIds ?? [];
      if (newSubscription) { delete plan.appliedSeatChangeId; if (link.purchase) plan.checkoutPurchaseId = link.purchase.id; }
      if (change) plan.appliedSeatChangeId = change.id;
      plan.licensedUserIds = requested.filter(userId => !sandboxOwner || userId === sandboxOwner.userId).slice(0, sub.quantity);
      plan.paidSeats = sub.quantity; plan.paidPeriodStart = sub.periodStart; plan.paidPeriodEnd = sub.periodEnd; plan.paidInvoiceId = sub.invoiceId;
      const grant = await paidCycle(repo, old, sub, tenantId, now); cycle = grant.cycle; previousCycle = grant.previousCycle;
    }
  } else if (event.hold && old) {
    plan = {...old, billingHold: event.hold, version: old.version + 1};
  } else if (event.payment && old) {
    if (!validTopUp(event.payment.credits) || await repo.stripeEventProcessed(event.payment.id)) return;
    const billing = new AssistantBilling(repo, () => now);
    const dates = old.paidPeriodStart ? {cycleStart: old.paidPeriodStart} : assistantCycleDates(old.cycleAnchor, now);
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
    await repo.commitStripeEvent({eventId: event.id, paymentId: event.payment?.id, plan, cycle, previousCycle,
      event: outbox(tenantId, 'stripe', plan.version, now)});
  } catch (error) {
    // Concurrent duplicates can lose the optimistic race. Other conflicts must be retried by Stripe.
    if (error instanceof ApiError && error.code === 'CONFLICT' &&
        (await repo.stripeEventProcessed(event.id) || (event.payment && await repo.stripeEventProcessed(event.payment.id)))) return;
    throw error;
  }
}
