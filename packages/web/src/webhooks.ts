import type { PublicWebhookEndpoint, WebhookDelivery, WebhookEventType } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
export function webhookEndpointHtml(endpoint: PublicWebhookEndpoint, admin: boolean): string {
  return `<article class="card"><h3>${e(endpoint.url)}</h3><p>${endpoint.eventTypes.map(e).join(', ')}</p><p>${endpoint.enabled ? 'Enabled' : 'Disabled'} · Created ${e(endpoint.createdAt)}</p>${admin ? `<button data-toggle="${e(endpoint.id)}">${endpoint.enabled ? 'Disable' : 'Enable'}</button> <button data-rotate="${e(endpoint.id)}">Rotate secret</button>` : ''}</article>`;
}
export function webhookDeliveryHtml(delivery: WebhookDelivery, endpoints: PublicWebhookEndpoint[]): string {
  return `<article class="card"><p>${e(delivery.eventType)} → ${e(endpoints.find(endpoint => endpoint.id === delivery.endpointId)?.url ?? delivery.endpointId)}</p><p><span class="${delivery.status === 'failed' ? 'error' : 'badge'}">${e(delivery.status)}</span> · ${e(delivery.attempts)} attempts · ${e(delivery.updatedAt)}</p></article>`;
}
export async function webhooksRoute(ui: UI, secret?: string): Promise<void> {
  ui.shell('<p>Loading webhooks…</p>');
  try {
    const [settings, deliveries] = await Promise.all([ui.api<{endpoints: PublicWebhookEndpoint[]; eventTypes: WebhookEventType[]}>('/webhooks/endpoints'), ui.api<WebhookDelivery[]>('/webhooks/deliveries')]);
    if (!ui.current()) return;
    ui.shell(`<h1>Webhooks</h1><p>Webhooks send event metadata to URLs you configure.</p><p>Deliveries are attempted from this local app when events happen or when you click Send pending. No background scheduler runs here; deliveries do not run while the app is closed. Signing secrets are stored on local tenant records because signing requires the raw value.</p>
      ${secret ? `<section class="card" role="status"><h2>Signing secret</h2><p>Copy it now — it will not be shown again.</p><code>${e(secret)}</code></section>` : ''}
      ${ui.admin ? '' : '<p>Only administrators can change webhook settings.</p>'}
      <section><h2>Endpoints</h2>${settings.endpoints.length ? settings.endpoints.map(endpoint => webhookEndpointHtml(endpoint, ui.admin)).join('') : '<p class="empty">No webhook endpoints yet.</p>'}</section>
      ${ui.admin ? `<section class="card"><h2>Add endpoint</h2><form id="webhook-create"><label>URL<input name="url" type="url" required placeholder="https://example.com/webhook"></label><fieldset><legend>Event subscriptions</legend>${settings.eventTypes.map(type => `<label><input type="checkbox" name="eventTypes" value="${e(type)}">${e(type)}</label>`).join('')}</fieldset><button>Create endpoint</button></form></section><button id="webhook-dispatch">Send pending</button>` : ''}
      <section><h2>Delivery log</h2>${deliveries.length ? deliveries.map(delivery => webhookDeliveryHtml(delivery, settings.endpoints)).join('') : '<p>No deliveries yet.</p>'}</section>`);
    const run = async (button: HTMLButtonElement, operation: () => Promise<{secret?: string}>) => {
      button.disabled = true;
      try { const result = await operation(); if (ui.current()) await webhooksRoute(ui, result.secret); }
      catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    };
    const form = document.querySelector<HTMLFormElement>('#webhook-create');
    form?.addEventListener('submit', event => {
      event.preventDefault(); const data = new FormData(form);
      void run(form.querySelector('button')!, () => ui.api('/webhooks/endpoints', 'POST', {url: data.get('url'), eventTypes: data.getAll('eventTypes')}));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-toggle], [data-rotate]').forEach(button => button.addEventListener('click', () => {
      const endpoint = settings.endpoints.find(item => item.id === (button.dataset.toggle ?? button.dataset.rotate))!;
      void run(button, () => ui.api(`/webhooks/endpoints/${endpoint.id}${button.dataset.rotate ? '/rotate-secret' : ''}`, button.dataset.rotate ? 'POST' : 'PUT', {version: endpoint.version, ...(button.dataset.rotate ? {} : {enabled: !endpoint.enabled})}));
    }));
    document.querySelector<HTMLButtonElement>('#webhook-dispatch')?.addEventListener('click', event => {
      void run(event.currentTarget as HTMLButtonElement, async () => { await ui.api('/webhooks/dispatch', 'POST', {}); return {}; });
    });
  } catch (error) { if (ui.current()) ui.flash(error); }
}
