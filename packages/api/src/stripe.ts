import { createHmac, timingSafeEqual } from 'node:crypto';
import { assistantTiers } from '@freedms/shared';
import { ApiError } from './errors.js';
export type AssistantTier = keyof typeof assistantTiers;
export interface StripeSubscription {
  id: string; customerId: string; tier: AssistantTier; status: string;
  periodStart: string; periodEnd: string; cancelAtPeriodEnd: boolean; endedAt?: string; paid: boolean;
}
export interface StripeBillingEvent {
  id: string; customerId?: string; subscription?: StripeSubscription;
  payment?: {id: string; credits: number};
}
export interface StripeBilling {
  readonly configured: boolean;
  createCustomer(tenantId: string): Promise<string>;
  checkoutSubscription(customerId: string, tier: AssistantTier, seats: number, returnUrl: string): Promise<{url: string}>;
  checkoutTopUp(customerId: string, credits: number, returnUrl: string): Promise<{url: string}>;
  portal(customerId: string, returnUrl: string): Promise<{url: string}>;
  verifyEvent(rawBody: string, signature: string | undefined): Promise<StripeBillingEvent>;
}
export const billingUnavailable = () => new ApiError(503, 'BILLING_UNAVAILABLE', "Billing isn't set up yet.");
export class UnconfiguredStripeBilling implements StripeBilling {
  readonly configured = false;
  async createCustomer(): Promise<string> { throw billingUnavailable(); }
  async checkoutSubscription(): Promise<{url: string}> { throw billingUnavailable(); }
  async checkoutTopUp(): Promise<{url: string}> { throw billingUnavailable(); }
  async portal(): Promise<{url: string}> { throw billingUnavailable(); }
  async verifyEvent(): Promise<StripeBillingEvent> { throw billingUnavailable(); }
}
const badSignature = () => new ApiError(400, 'STRIPE_SIGNATURE', 'Invalid Stripe signature.');
export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, now: Date): void {
  if (!secret) throw billingUnavailable();
  const fields = (header ?? '').split(',').map(part => part.trim().split('='));
  const timestamps = fields.filter(([key]) => key === 't');
  const timestamp = timestamps[0]?.[1] ?? '';
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamp) || Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) throw badSignature();
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  if (!fields.some(([key, value]) => key === 'v1' && /^[a-f0-9]{64}$/i.test(value ?? '') && timingSafeEqual(expected, Buffer.from(value, 'hex')))) throw badSignature();
}
type Json = Record<string, any>; // Stripe wire objects are validated at the normalization boundary below.
const id = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'object' && value !== null ? String((value as Json).id ?? '') : '';
const iso = (seconds: unknown): string => {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) throw new ApiError(502, 'STRIPE_RESPONSE', 'Stripe returned an invalid billing period.');
  return new Date(seconds * 1000).toISOString();
};
export function validTopUp(credits: unknown): credits is number { return typeof credits === 'number' && Number.isSafeInteger(credits) && credits >= 1 && credits <= 100000; }
export class HttpStripeBilling implements StripeBilling {
  readonly configured = true;
  constructor(private key: string, private webhookSecret: string, private prices: Record<AssistantTier | 'topup', string>,
    private fetcher: typeof fetch = fetch, private now = () => new Date()) {}
  private async request(path: string, fields?: Record<string, string>, key?: string): Promise<Json> {
    try {
      const result = await this.fetcher(`https://api.stripe.com/v1/${path}`, {method: fields ? 'POST' : 'GET',
        headers: {Authorization: `Bearer ${this.key}`, 'Stripe-Version': '2025-03-31.basil',
          ...(fields ? {'Content-Type': 'application/x-www-form-urlencoded'} : {}), ...(key ? {'Idempotency-Key': key} : {})},
        ...(fields ? {body: new URLSearchParams(fields)} : {}), signal: AbortSignal.timeout(15000)});
      if (!result.ok) throw new Error('Stripe request failed');
      return await result.json() as Json;
    } catch { throw new ApiError(502, 'BILLING_PROVIDER_UNAVAILABLE', 'Billing could not be reached. Please try again.'); }
  }
  async createCustomer(tenantId: string) {
    const customer = await this.request('customers', {'metadata[tenantId]': tenantId}, `freedms-customer-${tenantId}`);
    if (!/^cus_[a-zA-Z0-9]+$/.test(customer.id)) throw new ApiError(502, 'STRIPE_RESPONSE', 'Invalid billing customer.');
    return customer.id as string;
  }
  private link(result: Json): {url: string} {
    if (typeof result.url !== 'string' || !/^https:\/\/(checkout|billing)\.stripe\.com\//.test(result.url)) throw new ApiError(502, 'STRIPE_RESPONSE', 'Invalid billing link.');
    return {url: result.url};
  }
  async checkoutSubscription(customer: string, tier: AssistantTier, seats: number, returnUrl: string) {
    return this.link(await this.request('checkout/sessions', {mode: 'subscription', customer, success_url: returnUrl, cancel_url: returnUrl,
      'line_items[0][price]': this.prices[tier], 'line_items[0][quantity]': String(seats), 'metadata[tier]': tier}));
  }
  async checkoutTopUp(customer: string, credits: number, returnUrl: string) {
    if (!validTopUp(credits)) throw new ApiError(400, 'INVALID_INPUT', 'Choose 1 to 100000 credits.');
    return this.link(await this.request('checkout/sessions', {mode: 'payment', customer, success_url: returnUrl, cancel_url: returnUrl,
      'line_items[0][price]': this.prices.topup, 'line_items[0][quantity]': String(credits), 'metadata[credits]': String(credits)}));
  }
  async portal(customer: string, returnUrl: string) { return this.link(await this.request('billing_portal/sessions', {customer, return_url: returnUrl})); }
  private subscription(row: Json): StripeSubscription | undefined {
    const items = row.items?.data;
    if (!Array.isArray(items) || items.length !== 1) return;
    const item = items[0], price = id(item.price);
    const tier = (Object.keys(assistantTiers) as AssistantTier[]).find(tier => this.prices[tier] === price);
    if (!tier) return;
    return {id: id(row), customerId: id(row.customer), tier, status: row.status,
      periodStart: iso(item.current_period_start ?? row.current_period_start), periodEnd: iso(item.current_period_end ?? row.current_period_end),
      cancelAtPeriodEnd: row.cancel_at_period_end === true, ...(row.ended_at ? {endedAt: iso(row.ended_at)} : {}),
      paid: row.latest_invoice?.status === 'paid' && row.latest_invoice?.amount_paid > 0};
  }
  async verifyEvent(raw: string, signature: string | undefined): Promise<StripeBillingEvent> {
    verifyStripeSignature(raw, signature, this.webhookSecret, this.now());
    let event: Json;
    try { event = JSON.parse(raw); } catch { throw badSignature(); }
    if (!event || !/^evt_[a-zA-Z0-9_]+$/.test(event.id) || typeof event.type !== 'string' || !event.data?.object) throw badSignature();
    const result: StripeBillingEvent = {id: event.id}, row = event.data.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const session = await this.request(`checkout/sessions/${encodeURIComponent(id(row))}?expand[]=line_items&expand[]=subscription.latest_invoice`);
      result.customerId = id(session.customer);
      if (session.payment_status !== 'paid' || !(session.amount_total > 0)) return result;
      if (session.mode === 'subscription' && session.subscription && typeof session.subscription === 'object') result.subscription = this.subscription(session.subscription);
      if (session.mode === 'payment') {
        const credits = Number(session.metadata?.credits), lines = session.line_items?.data;
        if (validTopUp(credits) && lines?.length === 1 && id(lines[0].price) === this.prices.topup && lines[0].quantity === credits &&
            session.currency === 'usd' && session.amount_total === credits * 25) result.payment = {id: id(session), credits};
      }
    } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      const current = await this.request(`subscriptions/${encodeURIComponent(id(row))}?expand[]=latest_invoice`);
      result.customerId = id(current.customer); result.subscription = this.subscription(current);
    } else if (['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required'].includes(event.type)) {
      const subscriptionId = id(row.parent?.subscription_details?.subscription ?? row.subscription);
      if (subscriptionId) {
        const current = await this.request(`subscriptions/${encodeURIComponent(subscriptionId)}?expand[]=latest_invoice`);
        result.customerId = id(current.customer); result.subscription = this.subscription(current);
      }
    }
    return result;
  }
}
export function stripeBillingFromEnv(env: NodeJS.ProcessEnv = process.env): StripeBilling {
  const prices = {assistant: env.FREEDMS_STRIPE_PRICE_ASSISTANT ?? '', 'assistant-pro': env.FREEDMS_STRIPE_PRICE_ASSISTANT_PRO ?? '',
    'assistant-heavy': env.FREEDMS_STRIPE_PRICE_ASSISTANT_HEAVY ?? '', topup: env.FREEDMS_STRIPE_PRICE_TOPUP ?? ''};
  return env.FREEDMS_STRIPE_SECRET_KEY && Object.values(prices).every(Boolean)
    ? new HttpStripeBilling(env.FREEDMS_STRIPE_SECRET_KEY, env.FREEDMS_STRIPE_WEBHOOK_SECRET ?? '', prices) : new UnconfiguredStripeBilling();
}
