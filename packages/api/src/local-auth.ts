import type { LocalTokens } from './auth.js';
import { isMcpPath } from './mcp/server.js';

/** Select request credentials before the local adapter calls the handler. */
export function localAuth(path: string, isIntake: boolean, token: string, tokens: Pick<LocalTokens, 'verify'>) {
  return isMcpPath(path) ? {authorization: `Bearer ${token}`} : isIntake ? {intakeToken: token}
    : (path.replace(/\/$/, '') === '/access-requests' || path.replace(/\/$/, '') === '/assistant/billing/webhook' || path.replace(/\/$/, '').startsWith('/share/') || path.startsWith('/public/') || path.startsWith('/invite/')) ? {}
    : {claims: tokens.verify(token)};
}
