/** Configure the catalog without putting credentials in command arguments, output, or Git. */
import Stripe from 'stripe';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { assistantTiers } from '../packages/shared/src/assistant-billing.js';
import { STRIPE_API_VERSION } from '../packages/api/src/stripe.js';

async function main() {
  const secretId = process.argv[2];
  if (!secretId?.startsWith('arn:aws:secretsmanager:')) throw new Error('Pass the Stripe secret ARN.');
  const secrets = new SecretsManagerClient({region: process.env.AWS_REGION ?? 'us-east-1'});
  const saved = await secrets.send(new GetSecretValueCommand({SecretId: secretId}));
  const settings = JSON.parse(saved.SecretString ?? '{}') as Record<string, string>;
  const key = settings.FREEDMS_STRIPE_SECRET_KEY;
  if (!/^(sk|rk)_(test|live)_/.test(key ?? '')) throw new Error('The secret does not contain a Stripe API key.');
  const live = /^(sk|rk)_live_/.test(key);
  if (live && !process.argv.includes('--live')) throw new Error('Live configuration requires the explicit --live option.');
  const stripe = new Stripe(key, {apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2});
  const account = await stripe.accounts.retrieve();
  const plans = [...Object.entries(assistantTiers).map(([id, tier]) => ({id, name: tier.name, amount: tier.pricePerUserCents, credits: tier.creditsPerUser, monthly: true})),
    {id: 'topup', name: 'AI credit top-up', amount: 25, credits: 1, monthly: false}];
  for (const plan of plans) {
    const productId = `freedms_${plan.id.replace(/-/g, '_')}`;
    const lookupKey = `${productId}_usd_v1`;
    let product: Stripe.Product;
    try { product = await stripe.products.retrieve(productId); }
    catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.code !== 'resource_missing') throw error;
      product = await stripe.products.create({id: productId, name: `FreeDMS ${plan.name}`, metadata: {application: 'freedms', credits: String(plan.credits)}}, {idempotencyKey: productId});
    }
    const prices = await stripe.prices.list({lookup_keys: [lookupKey], active: true, limit: 10});
    const price = prices.data[0] ?? await stripe.prices.create({product: product.id, currency: 'usd', unit_amount: plan.amount, lookup_key: lookupKey,
      ...(plan.monthly ? {recurring: {interval: 'month', usage_type: 'licensed'}} : {})}, {idempotencyKey: lookupKey});
    if (price.currency !== 'usd' || price.unit_amount !== plan.amount || !!price.recurring !== plan.monthly || (plan.monthly && (price.recurring?.interval !== 'month' || price.recurring.usage_type !== 'licensed')))
      throw new Error(`Existing ${lookupKey} price does not match the application.`);
    settings[`FREEDMS_STRIPE_PRICE_${plan.id.toUpperCase().replace(/-/g, '_')}`] = price.id;
  }
  const portalSettings: Stripe.BillingPortal.ConfigurationCreateParams = {
    business_profile: {headline: 'Manage your FreeDMS AI subscription'}, metadata: {application: 'freedms'},
    features: {customer_update: {enabled: true, allowed_updates: ['email', 'address', 'name', 'tax_id']},
      invoice_history: {enabled: true}, payment_method_update: {enabled: true}, subscription_cancel: {enabled: true, mode: 'at_period_end'}, subscription_update: {enabled: false}},
  };
  const portals = await stripe.billingPortal.configurations.list({limit: 100});
  const existingPortal = portals.data.find(row => row.metadata?.application === 'freedms');
  const portal = existingPortal ? await stripe.billingPortal.configurations.update(existingPortal.id, portalSettings)
    : await stripe.billingPortal.configurations.create(portalSettings, {idempotencyKey: 'freedms-billing-portal-v1'});
  settings.FREEDMS_STRIPE_PORTAL_CONFIGURATION = portal.id;
  const url = process.env.FREEDMS_STRIPE_WEBHOOK_URL ?? 'https://app.freedms.co/api/assistant/billing/webhook';
  if (!url.startsWith('https://')) throw new Error('The webhook must use HTTPS.');
  const enabled_events: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ['checkout.session.completed', 'checkout.session.async_payment_succeeded',
    'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.pending_update_applied',
    'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'charge.refunded', 'charge.dispute.created'];
  const endpoints = await stripe.webhookEndpoints.list({limit: 100});
  let endpoint = endpoints.data.find(row => row.url === url);
  if (!endpoint) {
    endpoint = await stripe.webhookEndpoints.create({url, api_version: STRIPE_API_VERSION, enabled_events, description: 'FreeDMS billing', metadata: {application: 'freedms'}}, {idempotencyKey: 'freedms-billing-webhook-v1'});
    if (!endpoint.secret) throw new Error('Stripe did not return a webhook signing secret.');
    settings.FREEDMS_STRIPE_WEBHOOK_SECRET = endpoint.secret;
  } else {
    if (!settings.FREEDMS_STRIPE_WEBHOOK_SECRET) throw new Error('Existing webhook needs its signing secret saved before continuing.');
    if (endpoint.api_version !== STRIPE_API_VERSION) throw new Error('Existing webhook uses another API version; migrate it explicitly.');
    await stripe.webhookEndpoints.update(endpoint.id, {enabled_events, disabled: false});
  }
  settings.FREEDMS_STRIPE_WEBHOOK_ID = endpoint.id;
  await secrets.send(new PutSecretValueCommand({SecretId: secretId, SecretString: JSON.stringify(settings)}));
  console.log(JSON.stringify({accountId: account.id, mode: live ? 'live' : 'test', webhookId: endpoint.id, webhookUrl: url,
    priceIds: Object.fromEntries(Object.entries(settings).filter(([name]) => name.startsWith('FREEDMS_STRIPE_PRICE_'))), secretArn: secretId}, null, 2));
}
main().catch(error => { console.error('Stripe setup failed:', error instanceof Stripe.errors.StripeError ? `${error.type} (${error.code ?? error.statusCode})` : error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
