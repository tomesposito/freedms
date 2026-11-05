/** Loopback development only. Never imported by Lambda. */
import { authorize, type LocalTokens } from './auth.js';
import type { PilotOperator } from './access-requests.js';
import type { RepositoryFactory } from './repository.js';

export function localOperatorResolver(repositories: RepositoryFactory, tokens: LocalTokens, pilotOperator: PilotOperator, enabled: boolean) {
  // Capture static configuration before the shared object acquires a dynamic identity.
  const dynamic = enabled && !pilotOperator.userId && !pilotOperator.tenantId;
  return async (token: string): Promise<void> => {
    if (!dynamic) return;
    const {principal} = await authorize(tokens.verify(token), repositories);
    // Clear the previous request's identity for staff; never latch onto a workspace.
    pilotOperator.userId = principal.role === 'admin' ? principal.userId : '';
    pilotOperator.tenantId = principal.role === 'admin' ? principal.tenantId : '';
  };
}
