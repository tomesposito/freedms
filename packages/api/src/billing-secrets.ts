import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { stripeBillingFromEnv, UnconfiguredStripeBilling, type StripeBilling } from './stripe.js';

/** Cache credentials briefly; rotations take effect without copying keys into Lambda environment variables. */
export function createBillingLoader(env: NodeJS.ProcessEnv = process.env,
  read = async (secretId: string) => (await new SecretsManagerClient({maxAttempts: 2}).send(new GetSecretValueCommand({SecretId: secretId}), {abortSignal: AbortSignal.timeout(2000)})).SecretString,
  now = Date.now) {
  let cached: {until: number; value: Promise<StripeBilling>} | undefined;
  return (): Promise<StripeBilling> => {
    if (!env.FREEDMS_STRIPE_SECRET_ARN) return Promise.resolve(stripeBillingFromEnv(env));
    if (cached && cached.until > now()) return cached.value;
    const value = (async () => {
      try {
        const decoded: unknown = JSON.parse(await read(env.FREEDMS_STRIPE_SECRET_ARN!) ?? '{}');
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid secret');
        const settings: NodeJS.ProcessEnv = {};
        for (const [name, value] of Object.entries(decoded)) {
          if (name.startsWith('FREEDMS_STRIPE_') && typeof value === 'string') settings[name] = value;
        }
        return stripeBillingFromEnv(settings);
      } catch {
        // Secret errors must neither leak credentials nor take the free dealership software offline.
        console.error('Stripe configuration could not be loaded.');
        return new UnconfiguredStripeBilling();
      }
    })();
    cached = {until: now() + 60_000, value};
    return value;
  };
}
