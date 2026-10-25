import { signatureStatusLabel } from './signatures';
import { documentTypes, type DocumentSearchResult } from '@freedms/shared';
import { escapeHtml as e } from './format';
import type { UI } from './desking';
type Retention = {version: number; retentionDays: number | null};
export function documentResultsHtml(docs: DocumentSearchResult[], disposal = false): string {
  if (!docs.length) return `<p class="empty">${disposal ? 'No documents past retention or awaiting disposal.' : 'No documents match your search.'}</p>`;
  return `<ul>${docs.map(d => `<li><strong>${e(d.name)}</strong> · ${e(d.type)} · ${e(d.buyerName)} · Uploaded ${e(d.uploadedAt)} · <a href="#/deals/${e(d.dealId)}/jacket">Deal jacket ${e(d.dealId)}</a>${!['approved', 'sold'].includes(d.dealStatus) ? ' (packet available after approval)' : ''}${d.status ? ` · <strong>${d.status === 'disposed' ? 'Disposed' : 'Disposal pending'}</strong>` : ''}${!d.status ? ` · ${signatureStatusLabel(d.signatureStatus)}` : ''}${disposal ? ` <button data-dispose="${e(d.id)}">${d.status === 'disposal-pending' ? 'Retry disposal' : 'Dispose'}</button>` : ''}</li>`).join('')}</ul>`;
}
export async function documentsRoute(ui: UI, filters = new URLSearchParams()): Promise<void> {
  ui.shell('<p>Loading documents…</p>');
  const [docs, settings, expired] = await Promise.all([
    ui.api<DocumentSearchResult[]>(`/documents${filters.size ? `?${filters}` : ''}`),
    ui.admin ? ui.api<Retention>('/documents/retention') : Promise.resolve(null),
    ui.admin ? ui.api<DocumentSearchResult[]>('/documents/past-retention') : Promise.resolve([])
  ]);
  if (!ui.current()) return;
  ui.shell(`<h1>Documents</h1><section class="card"><h2>Search deal attachments</h2><form id="document-search"><div class="form-grid"><label>File name<input name="name" maxlength="160" value="${e(filters.get('name') ?? '')}"></label><label>Document type<select name="type"><option value="">All types</option>${documentTypes.map(t => `<option${filters.get('type') === t ? ' selected' : ''}>${e(t)}</option>`).join('')}</select></label><label>Buyer or deal ID<input name="buyer" maxlength="200" value="${e(filters.get('buyer') ?? '')}"></label><label>Uploaded from (UTC)<input name="from" type="date" value="${e(filters.get('from') ?? '')}"></label><label>Uploaded to (UTC)<input name="to" type="date" value="${e(filters.get('to') ?? '')}"></label></div><button>Search documents</button></form></section><section class="card"><h2>Results</h2>${documentResultsHtml(docs)}</section>
    ${settings ? `<section class="card"><h2>Document retention</h2><p>${settings.retentionDays === null ? 'No retention period configured.' : `Current retention period: ${settings.retentionDays} days.`} Nothing is deleted automatically. Disposal is irreversible and removes the file permanently. The attachment record stays in the deal jacket.</p><form id="document-retention"><label>Retention period (days; leave blank to disable)<input name="days" type="number" min="1" max="36500" step="1" value="${settings.retentionDays ?? ''}"></label><button>Save retention period</button></form><h3>Past retention / pending disposal</h3>${documentResultsHtml(expired, true)}</section>` : ''}`);
  const run = async (button: HTMLButtonElement, operation: () => Promise<unknown>) => {
    button.disabled = true;
    try { await operation(); if (ui.current()) await documentsRoute(ui, filters); }
    catch (error) {
      // Refresh also exposes a pending disposal after a storage failure.
      if (ui.current()) { try { await documentsRoute(ui, filters); } catch { /* Keep the original error. */ } if (ui.current()) ui.flash(error); }
    } finally { button.disabled = false; }
  };
  document.querySelector<HTMLFormElement>('#document-search')!.addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, next = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (String(value).trim()) next.set(key, String(value).trim());
    void documentsRoute(ui, next).catch(error => { if (ui.current()) ui.flash(error); });
  });
  document.querySelector<HTMLFormElement>('#document-retention')?.addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, days = String(new FormData(form).get('days')).trim();
    void run(form.querySelector('button')!, () => ui.api('/documents/retention', 'PUT', {version: settings!.version, retentionDays: days ? Number(days) : null}));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-dispose]').forEach(button => button.addEventListener('click', () => {
    const doc = expired.find(d => d.id === button.dataset.dispose)!;
    if (!window.confirm(`Permanently dispose of “${doc.name}”? This is irreversible and removes the file permanently. The attachment record will remain in the deal jacket.`)) return;
    void run(button, () => ui.api(`/documents/${encodeURIComponent(doc.id)}/dispose`, 'POST', {version: doc.version, confirm: true}));
  }));
}
