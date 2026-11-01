import { PRODUCT_VERSION, ideaStatuses, type Idea, type QueuedIdea } from '@freedms/shared';
import type { UI } from './desking';
import { escapeHtml as e } from './format';
import { showLoadError } from './load-error';

const detail = (idea: Idea) => `<h3>${e(idea.title)}</h3><span class="badge">${e(idea.status)}</span><p class="pilot-request-message">${e(idea.description)}</p>
  ${idea.status === 'Declined' ? `<p class="pilot-request-message"><strong>Reason:</strong> ${e(idea.declineReason)}</p>` : ''}
  ${idea.status === 'Shipped' && idea.shippedNote ? `<p class="pilot-request-message"><strong>Shipped:</strong> ${e(idea.shippedNote)}</p>` : ''}
  <p class="muted">Submitted ${e(new Date(idea.createdAt).toLocaleString())}</p>`;
export function ideasHtml(own: Idea[], others?: Idea[]): string {
  return `<h1>Ideas</h1><p>Tell us what would make your work easier. Ideas are reviewed by a person; submitting one never starts a build.</p>
    <p class="muted">Your ideas are visible to you, your dealership administrators, and the operator.</p>
    <form id="idea-form" class="card"><h2>Suggest an idea</h2><label>Title<input name="title" required maxlength="160"></label><label>Description<textarea name="description" rows="4" required maxlength="5000"></textarea></label><button class="primary">Submit idea</button></form>
    <h2>Your ideas</h2>${own.length ? own.map(i => `<section class="card idea-card">${detail(i)}</section>`).join('') : '<div class="empty"><h3>No ideas yet</h3><p>Have something in mind? Use the form above.</p></div>'}
    ${others === undefined ? '' : `<h2>Your dealership’s ideas</h2><p class="muted">Submissions from other people in your dealership.</p>${others.length ? others.map(i => `<section class="card idea-card"><p>${e(i.submitter.name)} · ${e(i.submitter.email ?? i.submitter.id)}</p>${detail(i)}</section>`).join('') : '<p class="empty">No other submissions yet.</p>'}`}`;
}
export function ideasQueueHtml(ideas: QueuedIdea[]): string {
  return `<div class="heading"><div><p class="eyebrow">PILOT ADMINISTRATION</p><h1>Ideas review</h1><p>Review privately against the product vision. Status changes record a human decision and do not trigger builds.</p></div><button id="refresh-ideas" type="button">Refresh</button></div>
    ${ideas.length ? ideas.map((i, index) => `<section class="card idea-card"><h2>${e(i.tenantName)}</h2><p>${e(i.tenantId)} · ${e(i.submitter.name)} · ${e(i.submitter.email ?? i.submitter.id)}</p>${detail(i)}
      <dl class="detail-grid"><div><dt>Surface</dt><dd>${e(i.surface || 'Not provided')}</dd></div><div><dt>Product version</dt><dd>${e(i.productVersion)}</dd></div><div><dt>Updated</dt><dd>${e(new Date(i.updatedAt).toLocaleString())}</dd></div></dl>
      <form data-idea-index="${index}"><label>Status<select name="status">${ideaStatuses.map(status => `<option ${status === i.status ? 'selected' : ''} ${status === 'Received' ? 'disabled' : ''}>${e(status)}</option>`).join('')}</select></label>
      <label>Decline reason (required when declining)<textarea name="declineReason" maxlength="2000">${e(i.declineReason ?? '')}</textarea></label>
      <label>Shipped note (optional)<textarea name="shippedNote" maxlength="2000">${e(i.shippedNote ?? '')}</textarea></label><button class="primary">Save review</button></form></section>`).join('') : '<div class="empty"><h2>No ideas yet</h2><p>New submissions will appear here for human review.</p></div>'}`;
}
export async function ideasRoute(ui: UI, userId: string): Promise<void> {
  ui.shell('<h1>Ideas</h1><p>Loading ideas…</p>');
  try {
    const [own, dealership] = await Promise.all([ui.api<Idea[]>('/ideas'), ui.admin ? ui.api<Idea[]>('/ideas/dealership') : Promise.resolve(undefined)]);
    if (!ui.current()) return;
    ui.shell(ideasHtml(own, dealership?.filter(i => i.submitter.id !== userId)));
    const form = document.querySelector<HTMLFormElement>('#idea-form')!;
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button')!;
      if (button.disabled) return;
      button.disabled = true;
      const values = new FormData(form);
      try {
        await ui.api('/ideas', 'POST', {title: values.get('title'), description: values.get('description'), surface: location.hash.slice(1) || '/', productVersion: PRODUCT_VERSION});
        if (ui.current()) ui.refresh();
      } catch (error) { if (ui.current()) ui.flash(error); }
      finally { button.disabled = false; }
    });
  } catch (error) { showLoadError(ui, error, () => { void ideasRoute(ui, userId); }); }
}
export async function ideasQueueRoute(ui: UI, allowed: boolean): Promise<void> {
  if (!allowed || !ui.admin) { ui.shell('<h1>Ideas review</h1><p>Only the pilot operator can review ideas.</p>'); return; }
  ui.shell('<h1>Ideas review</h1><p>Loading ideas…</p>');
  try {
    const queue = await ui.api<QueuedIdea[]>('/admin/ideas');
    if (!ui.current()) return;
    ui.shell(ideasQueueHtml(queue));
    document.querySelector('#refresh-ideas')?.addEventListener('click', ui.refresh);
    document.querySelectorAll<HTMLFormElement>('[data-idea-index]').forEach(form => {
      const status = form.elements.namedItem('status') as HTMLSelectElement;
      const reason = form.elements.namedItem('declineReason') as HTMLTextAreaElement;
      const requireReason = () => { reason.required = status.value === 'Declined'; };
      requireReason(); status.addEventListener('change', requireReason);
      form.addEventListener('submit', async event => {
        event.preventDefault(); const button = form.querySelector('button')!;
        if (button.disabled) return;
        button.disabled = true;
        const idea = queue[Number(form.dataset.ideaIndex)], values = new FormData(form);
        try {
          await ui.api(`/admin/ideas/${encodeURIComponent(idea.tenantId)}/${encodeURIComponent(idea.id)}`, 'PUT', {version: idea.version, status: values.get('status'), declineReason: values.get('declineReason'), shippedNote: values.get('shippedNote')});
          if (ui.current()) ui.refresh();
        } catch (error) { if (ui.current()) ui.flash(error); }
        finally { button.disabled = false; }
      });
    });
  } catch (error) { showLoadError(ui, error, () => { void ideasQueueRoute(ui, allowed); }); }
}
