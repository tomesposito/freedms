export interface TurnstileVerifier {
  configured: boolean;
  verify(token: string): Promise<boolean>;
}
export class UnconfiguredTurnstileVerifier implements TurnstileVerifier {
  configured = false;
  async verify(_token: string): Promise<boolean> { return false; }
}
export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  configured = true;
  constructor(private secret: string, private fetchRequest: typeof fetch = fetch) {}
  async verify(token: string): Promise<boolean> {
    try {
      const result = await this.fetchRequest('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({secret: this.secret, response: token}),
        signal: AbortSignal.timeout(10000)
      });
      if (!result.ok) return false;
      const body: unknown = await result.json();
      return typeof body === 'object' && body !== null && 'success' in body && body.success === true;
    } catch { return false; }
  }
}
export function turnstileVerifierFromEnv(env: NodeJS.ProcessEnv = process.env, fetchRequest?: typeof fetch): TurnstileVerifier {
  const secret = env.TURNSTILE_SECRET?.trim();
  return secret ? new CloudflareTurnstileVerifier(secret, fetchRequest) : new UnconfiguredTurnstileVerifier();
}
