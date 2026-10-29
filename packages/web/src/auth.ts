import { createCognito, type Tokens } from './cognito';
const env = import.meta.env || {};
export function selectAuthFlow(config: {domain?: string; client?: string; poolId?: string; flow?: string}) { return config.domain && config.client && config.poolId && config.flow !== 'redirect' ? 'inapp' : 'redirect'; }
const domain = env.VITE_COGNITO_DOMAIN as string | undefined;
const client = env.VITE_COGNITO_CLIENT_ID as string | undefined;
const redirect = () => `${location.origin}${location.pathname}`;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const authFlow = selectAuthFlow({domain, client, poolId: env.VITE_COGNITO_USER_POOL_ID, flow: env.VITE_AUTH_FLOW});
export const cognito = authFlow === 'inapp' ? createCognito({poolId: env.VITE_COGNITO_USER_POOL_ID!, clientId: client!, region: env.VITE_COGNITO_REGION, endpoint: env.VITE_COGNITO_ENDPOINT}) : undefined;
export const localMode = env.DEV && !domain;
export const getToken = () => sessionStorage.getItem('freedms-token');
export const setToken = (token: string) => sessionStorage.setItem('freedms-token', token);
export function storeTokens(tokens: Tokens): void {
  setToken(tokens.id); sessionStorage.setItem('freedms-refresh-token', tokens.refresh); sessionStorage.setItem('freedms-access-token', tokens.access);
}
let sessionGeneration = 0;
export function clearSession(): void {
  sessionGeneration++;
  for (const key of ['freedms-token', 'freedms-refresh-token', 'freedms-access-token', 'freedms-pkce', 'freedms-state', 'freedms-return']) sessionStorage.removeItem(key);
}
let refreshing: Promise<boolean> | undefined;
export async function refreshSession(): Promise<boolean> {
  const token = sessionStorage.getItem('freedms-refresh-token');
  if (localMode || !cognito || !token) return false;
  const generation = sessionGeneration;
  return refreshing ||= cognito.refresh(token).then(tokens => { if (generation !== sessionGeneration) return false; storeTokens(tokens); return true; }).catch(() => false).finally(() => { refreshing = undefined; });
}
export function tokenExpired(token: string): boolean {
  try { const exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp; return typeof exp !== 'number' || exp * 1000 <= Date.now(); } catch { return true; }
}
export async function freshToken(): Promise<string | null> {
  if (!localMode && getToken() && tokenExpired(getToken()!) && !(await refreshSession())) clearSession();
  return getToken();
}
export async function signOut(): Promise<void> {
  const refresh = sessionStorage.getItem('freedms-refresh-token');
  if (authFlow === 'inapp') {
    clearSession();
    try { if (refresh) await cognito!.revoke(refresh); } catch { /* best effort */ }
    location.assign(location.origin + '/'); return;
  }
  sessionStorage.removeItem('freedms-token');
  if (domain && client) location.assign(`${domain}/logout?client_id=${encodeURIComponent(client)}&logout_uri=${encodeURIComponent(redirect())}`);
  else location.assign(redirect());
}
export async function signIn(): Promise<void> {
  sessionStorage.setItem('freedms-return', location.hash);
  if (!domain || !client) throw new Error('Configure the Cognito domain and client ID to sign in.');
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem('freedms-pkce', verifier); sessionStorage.setItem('freedms-state', state);
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({response_type: 'code', client_id: client, redirect_uri: redirect(), scope: 'openid email profile', state, code_challenge_method: 'S256', code_challenge: challenge});
  location.assign(`${domain}/oauth2/authorize?${params}`);
}
export async function finishSignIn(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (authFlow === 'inapp' && !params.has('code')) return;
  if (params.has('error')) { history.replaceState(null, '', location.pathname); throw new Error('Sign-in was not completed. Please try again.'); }
  const code = params.get('code'); if (!code) return;
  const verifier = sessionStorage.getItem('freedms-pkce'); const state = sessionStorage.getItem('freedms-state');
  sessionStorage.removeItem('freedms-state'); sessionStorage.removeItem('freedms-pkce');
  history.replaceState(null, '', location.pathname);
  if (!verifier || !state || params.get('state') !== state || !domain || !client) throw new Error('Sign-in session could not be verified. Please sign in again.');
  const response = await fetch(`${domain}/oauth2/token`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client, code, redirect_uri: redirect(), code_verifier: verifier})});
  const body = await response.json();
  if (!response.ok || !body.id_token) throw new Error('Sign-in failed. Please try again.');
  setToken(body.id_token);
  const returnHash = sessionStorage.getItem('freedms-return');
  sessionStorage.removeItem('freedms-return');
  if (returnHash?.startsWith('#/')) history.replaceState(null, '', `${location.pathname}${returnHash}`);
}
