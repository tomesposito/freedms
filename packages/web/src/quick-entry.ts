import { track } from './analytics';
import type { LeadDraft, VehicleDraft } from '@freedms/shared';
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
let draftInput: 'text' | 'photo' = 'text';
let discardReview: (() => void) | undefined;
let vehicleDraft: VehicleDraft | undefined;
let leadDraft: LeadDraft | undefined;
export function takeVehicleDraft() { const draft = vehicleDraft; vehicleDraft = undefined; return draft; }
export function takeLeadDraft() { const draft = leadDraft; leadDraft = undefined; return draft; }
export function clearDrafts() { discardReview?.(); vehicleDraft = undefined; leadDraft = undefined; }
export const reviewNote = '<p class="warning">Review the AI draft — nothing is saved until you save.</p>';
export const quickEntryCard = '<section id="quick-entry" class="card"><h2>Quick entry</h2><p class="muted" role="status">Checking AI availability…</p></section>';
export async function bindQuickEntry(kind: 'vehicle' | 'lead', api: Api, current: () => boolean): Promise<void> {
  const panel = document.querySelector<HTMLElement>('#quick-entry'); if (!panel) return;
  const active = () => current() && panel.isConnected;
  panel.innerHTML = `<h2>Quick entry</h2><p class="muted" role="status">Checking AI availability…</p><form><label>Describe the ${kind}<textarea maxlength="2000" required disabled></textarea></label><button disabled>Draft ${kind}</button></form>${kind === 'vehicle' ? '<label>Photo of window sticker / VIN plate<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled></label><p class="muted" id="photo-status"></p>' : ''}`;
  const message = panel.querySelector<HTMLElement>('[role=status]')!;
  const form = panel.querySelector('form')!; const textarea = form.querySelector('textarea')!; const button = form.querySelector('button')!;
  const photo = panel.querySelector<HTMLInputElement>('[type=file]');
  let vision = false;
  const busy = (value: boolean) => { textarea.disabled = value; button.disabled = value; if (photo) photo.disabled = value || !vision; };
  try {
    const status = await api<{configured: boolean; vision: boolean}>('/quick-entry/status'); if (!active()) return;
    vision = status.vision;
    message.textContent = status.configured ? 'Create a draft to review and edit. Nothing saves automatically.' : "AI quick entry isn't set up. You can still add records manually.";
    if (photo) panel.querySelector('#photo-status')!.textContent = status.vision ? 'JPEG, PNG, WebP or GIF, up to 3.75 MiB. The image is sent to the configured AI provider.' : "Photo intake isn't supported by the configured provider.";
    if (!status.configured) return;
    busy(false);
  } catch { if (active()) message.textContent = 'AI availability could not be checked. You can still add records manually.'; return; }
  const draft = async (path: string, body: unknown) => {
    busy(true); message.textContent = 'Extracting draft…';
    draftInput = path.endsWith('-photo') ? 'photo' : 'text';
    try {
      if (kind === 'vehicle') {
        const result = await api<{draft: VehicleDraft}>(path, 'POST', body); if (!active()) return;
        vehicleDraft = result.draft; location.hash = '#/new';
      } else {
        const result = await api<{draft: LeadDraft}>(path, 'POST', body); if (!active()) return;
        leadDraft = result.draft; location.hash = '#/leads/new';
      }
    } catch (error) { if (active()) message.textContent = error instanceof Error ? error.message : 'Extraction failed. Please retry.'; }
    finally { if (active()) busy(false); }
  };
  form.addEventListener('submit', event => { event.preventDefault(); void draft(`/quick-entry/${kind}`, {text: textarea.value}); });
  photo?.addEventListener('change', async () => {
    const file = photo.files?.[0]; if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024 * 3 / 4 || !file.size) { message.textContent = 'Choose a JPEG, PNG, WebP or GIF of at most 3.75 MiB.'; photo.value = ''; return; }
    busy(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('The image could not be read.')); reader.readAsDataURL(file); });
      if (active()) await draft('/quick-entry/vehicle-photo', {mediaType: file.type, dataBase64});
    } catch { if (active()) message.textContent = 'The image could not be read.'; }
    finally { if (active()) { busy(false); photo.value = ''; } }
  });
}
/** Populate only known controls; drafts never submit the form. */
export function fillDraft(form: HTMLFormElement, values: Record<string, unknown>, money: string[] = []) {
  for (const [key, value] of Object.entries(values)) {
    const control = form.elements.namedItem(key);
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
      control.value = money.includes(key) && typeof value === 'number' ? (value / 100).toFixed(2) : String(value ?? '');
    }
  }
}

/** Bound only after an AI draft fills the review form. No draft content enters telemetry. */
export function bindDraftOutcome(form: HTMLFormElement, surface: 'inventory' | 'lead', api: Api): () => void {
  const input = draftInput;
  let edited = false, finished = false;
  const edit = () => { edited = true; };
  const finish = (outcome: 'saved' | 'edited' | 'discarded') => {
    if (finished) return;
    finished = true;
    window.removeEventListener('hashchange', discard);
    form.removeEventListener('input', edit); form.removeEventListener('change', edit);
    if (discardReview === discard) discardReview = undefined;
    void track(api, {event: 'quick_entry_used', surface, input, outcome});
  };
  const discard = () => finish('discarded');
  discardReview = discard;
  form.addEventListener('input', edit); form.addEventListener('change', edit);
  window.addEventListener('hashchange', discard);
  return () => finish(edited ? 'edited' : 'saved');
}
