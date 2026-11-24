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

// Shared session (#190): sign-in tokens live in localStorage, which is
// shared by every tab of this origin in the same browser profile, so one
// sign-in serves all tabs. Transient OAuth/PKCE data stays in
// sessionStorage, isolated to the tab and flow that started it. The XSS
// tradeoff of a JS-readable shared store is recorded in SOLUTION_DESIGN.md.
export const TOKEN_KEYS = ['freedms-token', 'freedms-refresh-token', 'freedms-access-token'] as const;
export const EPOCH_KEY = 'freedms-session-epoch';
type StoreLike = {getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void};
function storeNamed(name: 'localStorage' | 'sessionStorage'): StoreLike | undefined {
  try { return (globalThis as Record<string, unknown>)[name] as StoreLike | undefined ?? undefined; } catch { return undefined; }
}
// In environments without localStorage (older unit-test stubs), the shared
// store falls back to sessionStorage so behavior stays defined.
export function sharedStorage(): StoreLike | undefined { return storeNamed('localStorage') ?? storeNamed('sessionStorage'); }
function tabStorage(): StoreLike | undefined { return storeNamed('sessionStorage') ?? sharedStorage(); }
function readShared(key: string): string | null {
  const shared = sharedStorage(); if (!shared) return null;
  const value = shared.getItem(key);
  if (value != null) return value;
  // Migrate a legacy tab-scoped token left by the pre-#190 build.
  const tab = tabStorage();
  if (tab && tab !== shared) {
    const legacy = tab.getItem(key);
    if (legacy != null) { shared.setItem(key, legacy); tab.removeItem(key); return legacy; }
  }
  return null;
}
function writeShared(key: string, value: string): void {
  sharedStorage()?.setItem(key, value);
  const tab = tabStorage(); const shared = sharedStorage();
  if (tab && tab !== shared) tab.removeItem(key);
}
function removeShared(key: string): void {
  sharedStorage()?.removeItem(key);
  tabStorage()?.removeItem(key);
}
export function sessionEpoch(): number { const raw = sharedStorage()?.getItem(EPOCH_KEY); const n = raw ? Number.parseInt(raw, 10) : 0; return Number.isFinite(n) ? n : 0; }
export function tokenSubject(token: string | null | undefined): string | null {
  if (!token) return null;
  try { const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return typeof payload.sub === 'string' ? payload.sub : typeof payload.email === 'string' ? payload.email : null; } catch { return null; }
}
export const getAccessToken = () => readShared('freedms-access-token');
export const getToken = () => readShared('freedms-token');
export const setToken = (token: string) => writeShared('freedms-token', token);
export function storeTokens(tokens: Tokens): void {
  setToken(tokens.id); writeShared('freedms-refresh-token', tokens.refresh); writeShared('freedms-access-token', tokens.access);
}
let sessionGeneration = 0;
let channel: {postMessage(m: unknown): void; close(): void} | undefined;
function broadcast(message: unknown): void {
  try {
    const BC = (globalThis as Record<string, unknown>).BroadcastChannel as (new (name: string) => {postMessage(m: unknown): void; close(): void}) | undefined;
    if (!BC) return;
    channel ||= new BC('freedms-session');
    (channel as unknown as {unref?: () => void}).unref?.();
    channel.postMessage(message);
  } catch { /* cross-tab sync still works through storage events */ }
}
export function clearSession(): void {
  sessionGeneration++;
  // Bump the shared epoch first: a tab mid-refresh in another tab sees the
  // epoch change and discards its result instead of reviving the session.
  try { sharedStorage()?.setItem(EPOCH_KEY, String(sessionEpoch() + 1)); } catch { /* storage may be unavailable */ }
  for (const key of TOKEN_KEYS) removeShared(key);
  const tab = tabStorage();
  for (const key of ['freedms-pkce', 'freedms-state', 'freedms-return']) tab?.removeItem(key);
  broadcast({type: 'freedms-session-cleared', epoch: sessionEpoch()});
}
export type SharedSessionChange = 'signed-out' | 'account-changed' | 'refreshed';
const changeHandlers = new Set<(kind: SharedSessionChange) => void>();
export function handleSessionStorageEvent(event: {key?: string | null; newValue?: string | null; oldValue?: string | null}): void {
  if (event.key === EPOCH_KEY) { notify('signed-out'); return; }
  if (event.key !== 'freedms-token') return;
  if (!event.newValue) { notify('signed-out'); return; }
  const before = tokenSubject(event.oldValue); const after = tokenSubject(event.newValue);
  notify(before && after && before !== after ? 'account-changed' : 'refreshed');
}
function notify(kind: SharedSessionChange): void { for (const handler of [...changeHandlers]) { try { handler(kind); } catch { /* one tab's handler must not break the others */ } } }
export function onSharedSessionChange(handler: (kind: SharedSessionChange) => void): () => void {
  changeHandlers.add(handler);
  const target = globalThis as unknown as {addEventListener?: (t: string, f: (e: unknown) => void) => void};
  const listener = (event: unknown) => handleSessionStorageEvent(event as {key?: string | null});
  try { target.addEventListener?.('storage', listener); } catch { /* no event target in this environment */ }
  let bc: {addEventListener?: (t: string, f: (e: {data?: unknown}) => void) => void; close(): void; unref?: () => void} | undefined;
  try {
    const BC = (globalThis as Record<string, unknown>).BroadcastChannel as (new (name: string) => NonNullable<typeof bc>) | undefined;
    if (BC) { bc = new BC('freedms-session'); bc.unref?.(); bc.addEventListener?.('message', event => { if ((event.data as {type?: string})?.type === 'freedms-session-cleared') notify('signed-out'); }); }
  } catch { bc = undefined; }
  return () => { changeHandlers.delete(handler); try { bc?.close(); } catch { /* already closed */ } };
}
let refreshing: Promise<boolean> | undefined;
async function doRefresh(snapshot: {id: string | null; refresh: string}): Promise<boolean> {
  // Another tab may have refreshed while this tab waited for the lock:
  // if the stored session changed and is now valid, adopt it, don't refresh again.
  const currentId = getToken(); const currentRefresh = readShared('freedms-refresh-token');
  if ((currentId !== snapshot.id || currentRefresh !== snapshot.refresh) && currentId && !tokenExpired(currentId) && currentRefresh) return true;
  const token = currentRefresh; if (!token) return false;
  const generation = sessionGeneration; const epoch = sessionEpoch();
  try {
    const tokens = await cognito!.refresh(token);
    if (generation !== sessionGeneration || epoch !== sessionEpoch()) return false;
    // Sign-out or an account change landed during the request: do not revive.
    if (readShared('freedms-refresh-token') !== token && readShared('freedms-refresh-token') !== null) return false;
    if (!getToken() && epoch !== sessionEpoch()) return false;
    storeTokens(tokens); return true;
  } catch { return false; }
}
export async function refreshSession(): Promise<boolean> {
  const token = readShared('freedms-refresh-token');
  if (localMode || !cognito || !token) return false;
  if (refreshing) return refreshing;
  const snapshot = {id: getToken(), refresh: token};
  const run = async (): Promise<boolean> => {
    const locks = (globalThis as {navigator?: {locks?: {request(name: string, cb: () => Promise<boolean>): Promise<boolean>}}}).navigator?.locks;
    if (locks) { try { return await locks.request('freedms-session-refresh', () => doRefresh(snapshot)); } catch { return doRefresh(snapshot); } }
    return doRefresh(snapshot);
  };
  refreshing = run().finally(() => { refreshing = undefined; });
  return refreshing;
}
export function tokenExpired(token: string): boolean {
  try { const exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp; return typeof exp !== 'number' || exp * 1000 <= Date.now(); } catch { return true; }
}
export async function freshToken(): Promise<string | null> {
  if (!localMode && getToken() && tokenExpired(getToken()!) && !(await refreshSession())) clearSession();
  return getToken();
}
export async function signOut(): Promise<void> {
  const refresh = readShared('freedms-refresh-token');
  if (authFlow === 'inapp') {
    clearSession();
    try { if (refresh) await cognito!.revoke(refresh); } catch { /* best effort */ }
    location.assign(location.origin + '/'); return;
  }
  clearSession();
  if (domain && client) location.assign(`${domain}/logout?client_id=${encodeURIComponent(client)}&logout_uri=${encodeURIComponent(redirect())}`);
  else location.assign(redirect());
}
export async function signIn(): Promise<void> {
  tabStorage()?.setItem('freedms-return', location.hash);
  if (!domain || !client) throw new Error('Configure the Cognito domain and client ID to sign in.');
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  tabStorage()?.setItem('freedms-pkce', verifier); tabStorage()?.setItem('freedms-state', state);
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({response_type: 'code', client_id: client, redirect_uri: redirect(), scope: 'openid email profile', state, code_challenge_method: 'S256', code_challenge: challenge});
  location.assign(`${domain}/oauth2/authorize?${params}`);
}
export async function finishSignIn(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (authFlow === 'inapp' && !params.has('code')) return;
  if (params.has('error')) { history.replaceState(null, '', location.pathname); throw new Error('Sign-in was not completed. Please try again.'); }
  const code = params.get('code'); if (!code) return;
  const tab = tabStorage();
  const verifier = tab?.getItem('freedms-pkce'); const state = tab?.getItem('freedms-state');
  tab?.removeItem('freedms-state'); tab?.removeItem('freedms-pkce');
  history.replaceState(null, '', location.pathname);
  if (!verifier || !state || params.get('state') !== state || !domain || !client) throw new Error('Sign-in session could not be verified. Please sign in again.');
  const response = await fetch(`${domain}/oauth2/token`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client, code, redirect_uri: redirect(), code_verifier: verifier})});
  const body = await response.json();
  if (!response.ok || !body.id_token) throw new Error('Sign-in failed. Please try again.');
  setToken(body.id_token);
  const returnHash = tab?.getItem('freedms-return');
  tab?.removeItem('freedms-return');
  if (returnHash?.startsWith('#/')) history.replaceState(null, '', `${location.pathname}${returnHash}`);
}
