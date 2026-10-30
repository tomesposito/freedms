import type { LocalTokens } from './auth.js';

/** Select request credentials before the local adapter calls the handler. */
export function localAuth(path: string, isIntake: boolean, token: string, tokens: Pick<LocalTokens, 'verify'>) {
  return ['/mcp', '/.well-known/oauth-protected-resource'].includes(path.replace(/\/$/, '')) ? {authorization: `Bearer ${token}`} : isIntake ? {intakeToken: token}
    : (path.replace(/\/$/, '').startsWith('/share/') || path.startsWith('/invite/')) ? {}
    : {claims: tokens.verify(token)};
}
