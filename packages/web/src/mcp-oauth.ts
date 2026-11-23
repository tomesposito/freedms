import { authShellHtml, mountLogin } from './login';
import { freshToken } from './auth';
import { escapeHtml as e } from './format';
import type { Cognito } from './cognito';
interface Connection {id: string; csrf: string; appName: string; redirectUri: string; scopes: string[]}
export function consentHtml(connection: Connection, identity: {user: string; dealership: string}): string {
  const host = new URL(connection.redirectUri).host;
  return authShellHtml(`<p class="eyebrow">CONNECT AN APP</p><h1>Connect ${e(connection.appName)}</h1><p>Give this app access to your freeDMS dealership.</p>
    <div class="oauth-summary"><p><strong>Requesting app</strong><br>${e(connection.appName)}<br><span class="muted">${e(host)}</span></p>
    <p><strong>Signed in as</strong><br>${e(identity.user)} · ${e(identity.dealership)}</p></div>
    <h2>This app will be able to</h2><ul class="oauth-permissions"><li>Read your dealership’s inventory, deals, customers and reports.</li>${connection.scopes.includes('freedms/mcp.write') ? '<li>Create and update records using your current permissions.</li>' : ''}</ul>
    <p class="muted">Your password and authenticator codes stay with freeDMS. You can remove this app any time in Account → AI connections.</p>
    <div id="oauth-error" class="error" role="alert" tabindex="-1" hidden></div><button id="oauth-allow" class="primary">Allow access</button><button id="oauth-deny" class="quiet">Cancel</button>`);
}
export async function mountMcpOAuth(root: HTMLElement, cognito?: Cognito): Promise<void> {
  const paint = (html: string) => {root.innerHTML = html; root.querySelector<HTMLAnchorElement>('.auth-brand')!.href = '/';};
  const fail = (message: string) => paint(authShellHtml(`<h1>Unable to connect</h1><p>${e(message)}</p><p>Return to your app and start the connection again.</p><a class="button quiet" href="/">Back to freeDMS</a>`));
  const call = async <T>(path: string, body: unknown, idToken?: string): Promise<T> => {
    const result = await fetch(`/api/mcp/oauth/${path}`, {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', ...(idToken ? {authorization: `Bearer ${idToken}`} : {})}, body: JSON.stringify(body)});
    const data = await result.json();
    if (!result.ok) throw new Error(data.error_description ?? 'This connection could not be completed. Please try again.');
    return data as T;
  };
  paint(authShellHtml('<h1>Connect to freeDMS</h1><p role="status">Checking the connection request…</p>'));
  try {
    if (!cognito) throw new Error('App connections are not available right now.');
    const params = new URLSearchParams(location.search); params.delete('mcp_oauth');
    if ([...params.keys()].some(k => params.getAll(k).length !== 1)) throw new Error('The connection request is invalid.');
    const connection = await call<Connection>('interaction', Object.fromEntries(params));
    // A valid shared web session (#190) can authorize the connection, but the
    // explicit consent below is always shown and the web session is left as-is.
    const proceed = async (idToken: string) => {
      const identity = await call<{user: string; dealership: string}>('authorize', {id: connection.id, csrf: connection.csrf, action: 'details'}, idToken);
      paint(consentHtml(connection, identity));
      for (const action of ['allow', 'deny']) root.querySelector(`#oauth-${action}`)!.addEventListener('click', async () => {
        const buttons = root.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(b => { b.disabled = true; });
        try {
          const result = await call<{redirect: string}>('authorize', {id: connection.id, csrf: connection.csrf, action}, action === 'allow' ? idToken : undefined);
          location.assign(result.redirect);
        } catch (error) {
          const alert = root.querySelector<HTMLElement>('#oauth-error')!; alert.textContent = (error as Error).message; alert.hidden = false; alert.focus();
          buttons.forEach(b => { b.disabled = false; });
        }
      });
    };
    const existing = await freshToken().catch(() => null);
    if (existing) { try { await proceed(existing); return; } catch { /* fall through to a fresh sign-in */ } }
    // Credentials stay in this closure; connecting an app does not replace the ordinary web session.
    mountLogin(root, cognito, async tokens => { await proceed(tokens.id); }, {brandHref: '/'});
  } catch (error) { fail((error as Error).message); }
}
