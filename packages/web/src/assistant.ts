import { effectiveVehiclePhotos, PHOTO_PREP_SKILL, type VehicleView } from '@freedms/shared';
import { approvalFields, prepareBackgroundMedia, preparePhotoInputs, reviewHtml, scopeHtml, type PhotoPrepScope, type PrepReview } from './assistant-photo-prep';
import { escapeHtml as e } from './format';
import { renderMarkdown } from './markdown';

export interface AssistantContext {surface: 'vehicle' | 'contact' | 'lead' | 'deal' | 'vehicles' | 'leads' | 'contacts'; id?: string}
export function assistantContextFromHash(hash: string): AssistantContext | null {
  const path = hash.split('?')[0].replace(/\/$/, '');
  if (['#', '#/vehicles'].includes(path)) return {surface: 'vehicles'};
  if (path === '#/leads') {
    const id = new URLSearchParams(hash.split('?')[1]).get('customerId');
    return id ? {surface: 'contact', id} : {surface: 'leads'};
  }
  const match = /^#\/(vehicles|leads|deals)\/([^/]+)$/.exec(path);
  if (!match || ['new', 'settings', 'equity', 'reports'].includes(match[2])) return null;
  return {surface: {vehicles: 'vehicle', leads: 'lead', deals: 'deal'}[match[1]] as AssistantContext['surface'], id: match[2]};
}
export interface AssistantSkill {id: string; name: string; costCredits: number; kind: 'summary' | 'cleanup' | 'photo'; perPhotoCredits?: number; backgroundAvailable?: boolean}
export interface AssistantProposal {proposalId: string; kind: 'fix' | 'missing' | 'stale' | 'duplicate'; label: string; current?: string; proposed?: string; customerId?: string}
export function skillChipsHtml(skills: AssistantSkill[], busy = false): string {
  return `<div class="assistant-skills">${skills.map(s => `<button type="button" data-assistant-skill="${e(s.id)}" ${busy ? 'disabled' : ''}>${e(s.name)} · ${e(s.costCredits)} credits</button>`).join('')}</div>`;
}
export function proposalsHtml(proposals: AssistantProposal[], index: number, locked = false): string {
  return `<div class="assistant-proposals" data-proposals="${index}">${proposals.map(p => p.kind === 'fix'
    ? `<label><input type="checkbox" value="${e(p.proposalId)}" ${locked ? 'disabled' : ''}><span>${e(p.label)}: ${e(p.current)} → ${e(p.proposed)}</span></label>`
    : `<p class="assistant-flag">${p.kind === 'duplicate' ? 'Merge proposal — handle by hand. ' : ''}${e(p.label)}</p>`).join('')}${proposals.some(p => p.kind === 'fix') ? '<p>Applying rechecks the scan (same read cost), then costs 2 credits per customer changed.</p><p class="assistant-apply-cost"></p><button type="button" data-assistant-apply disabled>Apply selected</button>' : ''}</div>`;
}

export interface AssistantPool {
  perRequestCreditCap?: number; overageCapCredits?: number; overageCreditsUsed?: number;
  tier: string; status: 'active' | 'past_due' | 'cancelled'; disabled: boolean;
  overageEnabled: boolean; balanceCredits: number; cycleEnd: string;
}
export type AssistantState = 'loading' | 'ready' | 'paywall' | 'waiting-list' | 'past-due' | 'disabled' | 'exhausted' | 'unconfigured' | 'unavailable';
type ApiError = {code?: string; status?: number};
export function poolState(pool?: AssistantPool, error?: ApiError): AssistantState {
  if (error?.code === 'ASSISTANT_SANDBOX_RESTRICTED') return 'waiting-list';
  if (error?.code === 'ASSISTANT_PAST_DUE') return 'past-due';
  if (error) return error.code === 'ASSISTANT_PLAN_REQUIRED' || error.status === 402 ? 'paywall' : 'unavailable';
  if (!pool) return 'loading';
  if (pool.disabled) return 'disabled';
  if (pool.status === 'past_due') return 'past-due';
  if (pool.status !== 'active') return 'paywall';
  if (pool.balanceCredits <= 0 && (!pool.overageEnabled || (pool.overageCreditsUsed ?? Math.max(0, -pool.balanceCredits)) >= (pool.overageCapCredits ?? 500))) return 'exhausted';
  return 'ready';
}
export function chatErrorState(error: ApiError): AssistantState | undefined {
  if (error.code === 'ASSISTANT_SANDBOX_RESTRICTED') return 'waiting-list';
  if (error.code === 'ASSISTANT_PAST_DUE') return 'past-due';
  if (error.code === 'ASSISTANT_UNAVAILABLE' || error.status === 503) return 'unconfigured';
  if (error.code === 'ASSISTANT_DISABLED') return 'disabled';
  if (error.code === 'ASSISTANT_CREDITS_EXHAUSTED') return 'exhausted';
  if (error.code === 'ASSISTANT_PLAN_REQUIRED' || error.status === 402) return 'paywall';
}
export function toolLabel(tool: string): string {
  const names: Record<string, string> = {search_vehicles: 'Search inventory', get_vehicle: 'Open vehicle record', update_vehicle_status: 'Update vehicle status', set_vehicle_status: 'Update vehicle status'};
  const words = tool.replace(/_/g, ' ');
  return Object.hasOwn(names, tool) ? names[tool] : words.charAt(0).toUpperCase() + words.slice(1);
}
export function receipt(credits: number): string { return `This used ${credits} ${credits === 1 ? 'credit' : 'credits'}`; }
interface Reply {reply: string; transcript: {tool: string; ok: boolean}[]; creditsUsed: number; proposals?: AssistantProposal[]}
export interface AssistantTurn {text: string; result?: Reply; error?: string; skill?: string; context?: AssistantContext; applied?: boolean; prep?: PrepReview}
const locked: Record<AssistantState, string> = {
  'waiting-list': 'Paid AI plans are opening soon',
  ready: 'Ask, or tell it what to do…', loading: 'Checking assistant plan…', unavailable: 'Unable to check assistant plan — reopen to retry',
  'past-due': 'Locked — payment is past due',
  paywall: 'Locked — this store has no assistant plan', exhausted: 'Out of credits',
  disabled: 'Locked — assistant turned off by an admin', unconfigured: 'Locked — assistant is not set up',
};
function stateBody(state: AssistantState, pool?: AssistantPool): string {
  switch (state) {
    case 'waiting-list': return '<section><h2>Paid AI plans are opening soon.</h2><p>Ask a dealership admin to join the waiting list under Account → AI assistant. Joining does not start a subscription or charge anything.</p></section>';
    case 'ready': return `<section><h2>What do you need done?</h2><p>Ask about anything in the store, or hand it a job. It uses the same tools as the AI connections your dealers already run — as you, with your permissions.</p><ul class="assistant-capabilities"><li>Find cars, leads, deals, and repair orders</li><li>Add and update records — stock a vehicle, move a lead, post a note</li><li>Run the numbers on a pencil or a report</li></ul><div class="assistant-note"><b>It cannot, ever:</b> capture a signature, attest a compliance check, accept terms, handle MFA, or make a credit decision. Those have no tools. They stay with a person.</div></section>`;
    case 'past-due': return `<p role="status">Payment is past due. Ask an admin to update billing in Account → AI assistant.</p>${stateBody('paywall', pool)}`;
    case 'paywall': return `<section><h2>The assistant is a paid add-on.</h2><p>freeDMS itself is free. The assistant is not — it runs on a frontier model and works the store as you do. It is priced in credits: a lookup costs 1, a change costs 2, and the pool is shared by assigned AI users at the dealership.</p>${[['Assistant', 75, 15], ['Assistant Pro', 175, 29], ['Assistant Heavy', 350, 49]].map(([name, credits, price]) => `<div class="assistant-tier"><div><b>${e(name)}</b><small>${e(credits)} credits per AI user</small></div><strong>$${e(price)} / AI user / mo</strong></div>`).join('')}<div class="assistant-note">Failed actions never charge, and the pool stops hard at zero — nobody gets a surprise bill.</div><div class="assistant-callout">Ask your admin to turn it on</div><p class="assistant-small">Admins subscribe under Account → AI assistant. Your usage is recorded under your name, like everything else you do in the store.</p></section>`;
    case 'exhausted': {
      const date = pool?.cycleEnd ? new Date(pool.cycleEnd) : undefined;
      const reset = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'}) : 'the next cycle date';
      return `<section><div class="assistant-stop"><h2>You are out of credits.</h2><p>The dealership pool is used up for this cycle. The assistant stops here by design so the bill cannot run past the plan. Work you did this cycle is all still in the product, under the names of the people who asked for it.</p></div><div class="assistant-note"><b>To keep going:</b> an admin can buy a top-up (25¢ a credit) or turn on overage under Account → AI assistant. Otherwise the pool refills on ${e(reset)}.</div></section>`;
    }
    case 'unconfigured': return `<section class="assistant-unconfigured"><h2>The AI assistant isn't set up.</h2><p>This workspace's deployment has no assistant model configured, so there is nothing to talk to yet. Nothing here is simulated — when the operator enables it, this tray is where it will live.</p><div class="assistant-note"><b>Operator note:</b> set the stack's AssistantModelId parameter to a model the account can invoke, and redeploy. The tray enables itself; no other setting changes.</div></section>`;
    default: return `<p role="status">${e(locked[state])}</p>`;
  }
}
export function trayHtml(state: AssistantState, turns: AssistantTurn[] = [], pool?: AssistantPool, busy = false, draft = '', skills: AssistantSkill[] = [], prepHtml = ''): string {
  // Disabled means absent: paint removes the panel and trigger entirely.
  if (state === 'disabled') return '';
  return `<header class="assistant-header"><h2 id="assistant-title">AI assistant${(state === 'paywall' || state === 'past-due') ? '<span>PAID</span>' : ''}</h2><div class="assistant-header-actions">${pool ? `<span class="assistant-header-credit">${e(pool.balanceCredits.toLocaleString('en-US'))} credits</span>` : ''}<button type="button" id="assistant-close" aria-label="Close AI assistant">✕</button></div></header><div class="assistant-body" aria-live="polite">${state === 'ready' ? skillChipsHtml(skills, busy) : ''}${turns.map((turn, i) => `<div class="assistant-user" data-assistant-turn="${i}">${e(turn.text)}</div>${turn.result ? `${turn.result.transcript.map(row => `<div class="assistant-tool ${row.ok ? 'done' : 'failed'}"><i aria-hidden="true"></i>${e(toolLabel(row.tool))}<small>${row.ok ? 'done' : 'failed'}</small></div>`).join('')}<div class="assistant-reply">${renderMarkdown(turn.result.reply)}</div>${turn.prep ? reviewHtml(turn.prep, i, busy, !['ready', 'exhausted'].includes(state)) : ''}<div class="assistant-receipt">${e(receipt(turn.result.creditsUsed))}</div>${turn.result.proposals ? proposalsHtml(turn.result.proposals, i, busy || state !== 'ready' || !!turn.applied) : ''}` : ''}${turn.error ? `<div class="assistant-error" role="alert">${e(turn.error)}${state === 'ready' && !busy && !turn.skill ? `<button type="button" data-assistant-retry="${e(i)}">Retry</button>` : ''}</div>` : ''}`).join('')}${prepHtml}${busy ? '<div class="assistant-working" role="status">● ● ● <span>Working…</span></div>' : ''}${state !== 'ready' || (!turns.length && !prepHtml) ? stateBody(state, pool) : ''}</div><form class="assistant-composer"><textarea id="assistant-input" aria-label="Message AI assistant" rows="2" maxlength="16000" placeholder="${e(locked[state])}" ${state !== 'ready' || busy ? 'disabled' : ''}>${e(draft)}</textarea><button class="primary" type="submit" ${state !== 'ready' || busy ? 'disabled' : ''}>Send</button></form>`;
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
// Memory only: neither messages nor drafts are written to browser storage or logs.
let owner = '', open = false, turns: AssistantTurn[] = [], pool: AssistantPool | undefined;
let state: AssistantState = 'loading', unconfigured = false, busy = false, draft = '', generation = 0, poolRequest = 0;
let root: HTMLElement, cluster: HTMLElement, trigger: HTMLButtonElement, api: Api;
let photoScope: PhotoPrepScope | undefined;
const entrypoints = new Map<HTMLElement, {id: string; request: number}>();
let skills: AssistantSkill[] = [], skillContext: AssistantContext | null = null, skillsRequest = 0, skillsError = '';
export function resetAssistant(): void {
  photoScope = undefined; entrypoints.clear();
  generation++; poolRequest++; skillsRequest++; skills = []; skillContext = null; skillsError = ''; owner = ''; open = false; turns = []; pool = undefined;
  state = 'loading'; unconfigured = false; busy = false; draft = '';
  document.body.classList.remove('assistant-dock-open');
  const panel = root?.querySelector<HTMLElement>('#assistant-tray');
  if (panel) panel.inert = true;
}
function paint(focus = false, preserveScroll = false): void {
  if (!root?.isConnected) return;
  const input = root.querySelector<HTMLTextAreaElement>('#assistant-input');
  const hadFocus = document.activeElement === input;
  const hadCloseFocus = document.activeElement === root.querySelector('#assistant-close');
  const selection = input?.selectionStart;
  let panel = root.querySelector<HTMLElement>('#assistant-tray');
  if (state === 'disabled') {
    photoScope = undefined;
    for (const entry of entrypoints.keys()) entry.replaceChildren();
    open = false; document.body.classList.remove('assistant-dock-open');
    root.replaceChildren(); cluster.replaceChildren(); return;
  }
  if (!panel) { buildShell(); panel = root.querySelector<HTMLElement>('#assistant-tray')!; }
  trigger.setAttribute('aria-expanded', String(open));
  trigger.innerHTML = '<span class="assistant-spark" aria-hidden="true">✦</span><span class="assistant-label">AI assistant</span>';
  cluster.querySelector('#assistant-credit')!.innerHTML = pool ? `<span class="assistant-balance">${e(pool.balanceCredits.toLocaleString('en-US'))} credits</span>` : '';
  const oldScroll = panel.querySelector('.assistant-body')?.scrollTop ?? 0;
  const price = skills.find(skill => skill.id === PHOTO_PREP_SKILL)?.perPhotoCredits;
  const prep = state === 'ready' && photoScope && pool && price
    ? scopeHtml(photoScope, pool.balanceCredits, pool.perRequestCreditCap ?? 25, pool.overageEnabled ? pool.overageCapCredits ?? 500 : 0, price, busy)
    : '';
  panel.innerHTML = trayHtml(state, turns, pool, busy, draft, skills, prep);
  bindPhotoPrep(panel);
  if (skillsError) { const note = document.createElement('p'); note.className = 'assistant-error'; note.textContent = skillsError; panel.querySelector('.assistant-body')?.prepend(note); }
  document.body.classList.toggle('assistant-dock-open', open);
  panel.inert = !open;
  if (open && (focus || hadFocus || hadCloseFocus)) {
    const next = panel.querySelector<HTMLTextAreaElement>('#assistant-input')!;
    if (!next.disabled && (focus || !hadCloseFocus)) { next.focus(); if (hadFocus && selection !== undefined) next.setSelectionRange(selection, selection); }
    else panel.querySelector<HTMLButtonElement>('#assistant-close')!.focus();
  }
  panel.querySelector('#assistant-close')!.addEventListener('click', close);
  panel.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void send(draft); });
  const next = panel.querySelector<HTMLTextAreaElement>('#assistant-input')!;
  next.addEventListener('input', () => { draft = next.value; });
  next.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(draft); } });
  panel.querySelectorAll<HTMLButtonElement>('[data-assistant-retry]').forEach(button => button.addEventListener('click', () => { void send(turns[Number(button.dataset.assistantRetry)].text); }));
  panel.querySelectorAll<HTMLButtonElement>('[data-assistant-skill]').forEach(button => button.addEventListener('click', () => { void runSkill(button.dataset.assistantSkill!); }));
  panel.querySelectorAll<HTMLElement>('[data-proposals]').forEach(list => {
    const turn = turns[Number(list.dataset.proposals)];
    const button = list.querySelector<HTMLButtonElement>('[data-assistant-apply]');
    if (!button) return;
    const selected = () => Array.from(list.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value);
    list.addEventListener('change', () => {
      const ids = selected(); button.disabled = busy || state !== 'ready' || !!turn.applied || !ids.length;
      const customers = new Set(turn.result!.proposals!.filter(p => ids.includes(p.proposalId)).map(p => p.customerId));
      list.querySelector('.assistant-apply-cost')!.textContent = ids.length ? `Selected writes: ${customers.size * 2} credits, plus scan reads.` : '';
    });
    button.addEventListener('click', () => { void runSkill(turn.skill!, turn, selected()); });
  });
  const body = panel.querySelector('.assistant-body')!;
  if (preserveScroll) body.scrollTop = oldScroll;
  else if (busy || turns.length || prep) body.scrollTop = body.scrollHeight;
}
function close(): void { open = false; paint(); trigger?.focus(); }
async function refreshPool(): Promise<void> {
  const request = ++poolRequest, current = generation;
  const focusComposer = open && state === 'loading';
  try {
    const result = await api<AssistantPool>('/assistant/pool');
    if (current !== generation || request !== poolRequest) return;
    pool = result; state = poolState(result);
    if (state === 'ready' && unconfigured) state = 'unconfigured';
  } catch (error) {
    if (current !== generation || request !== poolRequest) return;
    const next = poolState(undefined, error as ApiError);
    if (next !== 'unavailable' || !['disabled', 'exhausted', 'unconfigured'].includes(state)) state = next;
    pool = undefined;
  }
  paint(focusComposer, !focusComposer);
  for (const [entry, context] of entrypoints) {
    if (!entry.isConnected) entrypoints.delete(entry);
    else if (state !== 'ready') { context.request++; entry.replaceChildren(); }
    else if (!entry.childElementCount) void checkPhotoPrepEntry(entry, context);
  }
}
async function send(text: string): Promise<void> {
  text = text.trim();
  if (!text || busy || state !== 'ready') return;
  const current = generation;
  // Failed messages remain visible, but only completed exchanges form API history.
  const messages = turns.filter(turn => turn.result).slice(-24).flatMap(turn => [{role: 'user', text: turn.text}, {role: 'assistant', text: turn.result!.reply}]);
  messages.push({role: 'user', text});
  const turn: AssistantTurn = {text}; turns.push(turn); draft = ''; busy = true; paint();
  try {
    const context = assistantContextFromHash(location.hash);
    const result = await api<Reply>('/assistant/chat', 'POST', {messages, ...(context ? {context} : {})});
    if (current !== generation) return;
    turn.result = result;
  } catch (error) {
    if (current !== generation) return;
    const next = chatErrorState(error as ApiError);
    if (next) { state = next; unconfigured = next === 'unconfigured'; }
    else turn.error = error instanceof Error ? error.message : 'The assistant could not complete this turn. Please retry.';
  } finally {
    if (current === generation) {
      busy = false; paint(true); await refreshPool();
    }
  }
}
async function loadSkills(): Promise<void> {
  const request = ++skillsRequest, current = generation, hash = location.hash;
  skills = []; skillsError = ''; skillContext = assistantContextFromHash(hash); paint();
  if (state !== 'ready' || !skillContext) return;
  try {
    const query = new URLSearchParams({...skillContext});
    const result = await api<{context: AssistantContext | null; skills: AssistantSkill[]}>(`/assistant/skills?${query}`);
    if (current !== generation || request !== skillsRequest || hash !== location.hash) return;
    skills = result.skills; skillContext = result.context;
  } catch (error) {
    if (current !== generation || request !== skillsRequest) return;
    skillsError = error instanceof Error ? error.message : 'Could not load skills. Reopen the assistant to retry.';
  }
  paint();
}
async function runSkill(id: string, source?: AssistantTurn, accepted?: string[]): Promise<void> {
  if (busy || state !== 'ready') return;
  const skill = skills.find(s => s.id === id), context = source?.context ?? skillContext;
  if (!context || (!source && (!skill || JSON.stringify(context) !== JSON.stringify(assistantContextFromHash(location.hash))))) return;
  if (!source && id === PHOTO_PREP_SKILL && skill && context.id) {
    const current = generation, hash = location.hash;
    busy = true; paint();
    try {
      const vehicle = await api<VehicleView>(`/vehicles/${encodeURIComponent(context.id)}`);
      if (generation === current && hash === location.hash) {
        photoScope = {vehicle, selected: new Set(effectiveVehiclePhotos(vehicle).map((_, index) => index)), mode: 'whole',
          backgroundAvailable: skill.backgroundAvailable === true, replaceBackground: false};
      }
    } catch (error) {
      if (generation === current) skillsError = error instanceof Error ? error.message : 'Could not open photo prep.';
    } finally { if (generation === current) { busy = false; paint(); } }
    return;
  }
  const current = generation;
  const turn: AssistantTurn = {text: source ? 'Apply selected changes' : skill!.name, skill: id, context};
  turns.push(turn); busy = true; paint();
  try {
    const result = await api<Reply & {applied?: string[]}>(`/assistant/skills/${source ? 'apply' : 'run'}`, 'POST', {skill: id, ...context, ...(source ? {accepted} : {})});
    if (current !== generation) return;
    turn.result = result;
    if (source) source.applied = true;
  } catch (error) {
    if (current !== generation) return;
    const next = chatErrorState(error as ApiError); if (next) state = next;
    turn.error = error instanceof Error ? error.message : 'Could not complete this skill. Reopen the skill to review current data.';
  } finally {
    if (current === generation) { busy = false; paint(); await refreshPool(); }
  }
}
async function openTray(skillId?: string): Promise<void> {
  if (!root?.isConnected) return;
  const current = generation, hash = location.hash;
  skills = []; skillsError = ''; skillContext = assistantContextFromHash(hash);
  open = true; paint(true); await refreshPool();
  if (current !== generation || hash !== location.hash) return;
  await loadSkills();
  if (skillId && open && current === generation && hash === location.hash) await runSkill(skillId);
}
export async function askAssistant(text: string): Promise<void> {
  const current = generation, hash = location.hash;
  await openTray();
  if (current === generation && hash === location.hash && open) { draft = text; await send(text); paint(true); }
}
export async function commandSkills(): Promise<AssistantSkill[]> {
  await refreshPool();
  await loadSkills();
  return state === 'ready' ? skills : [];
}
export function openAssistantSkill(skillId: string): void { void openTray(skillId); }
export function mountAssistant(container: HTMLElement, request: Api, identity: string): void {
  if (owner !== identity) { resetAssistant(); owner = identity; }
  if (photoScope?.vehicle.id !== assistantContextFromHash(location.hash)?.id) photoScope = undefined;
  skillsRequest++; skills = []; skillsError = ''; skillContext = null;
  api = request;
  root = document.createElement('div'); root.className = 'assistant-shell';
  cluster = container;
  (container.closest('#app') ?? container).append(root);
  buildShell();
  paint(open); void refreshPool().then(() => { if (open) void loadSkills(); });
}

function buildShell(): void {
  root.innerHTML = '<aside id="assistant-tray" aria-labelledby="assistant-title" inert></aside>';
  // Keep the dock independent of the responsive command bar.
  cluster.innerHTML = '<span id="assistant-credit"></span><button type="button" id="assistant-trigger" aria-label="AI assistant" aria-controls="assistant-tray" aria-expanded="false"></button>';
  trigger = cluster.querySelector<HTMLButtonElement>('#assistant-trigger')!;
  trigger.addEventListener('click', () => { if (open) close(); else void openTray(); });
  root.querySelector('#assistant-tray')!.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
}

export function mountPhotoPrepEntry(entry: HTMLElement, vehicleId: string): void {
  for (const previous of entrypoints.keys()) if (!previous.isConnected) entrypoints.delete(previous);
  const context = {id: vehicleId, request: 0};
  entrypoints.set(entry, context);
  void checkPhotoPrepEntry(entry, context);
}
async function checkPhotoPrepEntry(entry: HTMLElement, context: {id: string; request: number}) {
  const request = ++context.request;
  let available = false;
  try {
    const result = await api<{skills: AssistantSkill[]}>(`/assistant/skills?surface=vehicle&id=${encodeURIComponent(context.id)}`);
    available = result.skills.some(skill => skill.id === PHOTO_PREP_SKILL);
  } catch { /* The tray owns the unavailable states. */ }
  if (!entry.isConnected || entrypoints.get(entry) !== context || request !== context.request) return;
  if (!available || state === 'disabled') { entry.replaceChildren(); return; }
  if (entry.childElementCount) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Ask the assistant to prep these photos';
  button.onclick = () => openAssistantSkill(PHOTO_PREP_SKILL);
  entry.replaceChildren(button);
}

function bindPhotoPrep(panel: HTMLElement): void {
  panel.querySelectorAll<HTMLInputElement>('input[name="prep-scope"]').forEach(input => input.onchange = () => {
    if (!photoScope) return;
    photoScope.mode = input.value as PhotoPrepScope['mode'];
    if (photoScope.mode === 'whole') photoScope.selected = new Set(effectiveVehiclePhotos(photoScope.vehicle).map((_, index) => index));
    paint(false, true);
    panel.querySelector<HTMLInputElement>(`input[name="prep-scope"][value="${input.value}"]`)?.focus();
  });
  panel.querySelectorAll<HTMLInputElement>('[data-prep-photo]').forEach(input => input.onchange = () => {
    const index = Number(input.dataset.prepPhoto);
    if (input.checked) photoScope?.selected.add(index);
    else photoScope?.selected.delete(index);
    paint(false, true);
    panel.querySelector<HTMLInputElement>(`[data-prep-photo="${index}"]`)?.focus();
  });
  panel.querySelector<HTMLInputElement>('[data-prep-background]')?.addEventListener('change', event => {
    if (!photoScope) return;
    photoScope.replaceBackground = (event.currentTarget as HTMLInputElement).checked;
    paint(false, true);
    panel.querySelector<HTMLInputElement>('[data-prep-background]')?.focus();
  });
  panel.querySelector<HTMLButtonElement>('[data-prep-run]')?.addEventListener('click', () => { void runPhotoPrep(); });
  panel.querySelector<HTMLButtonElement>('[data-prep-cancel]')?.addEventListener('click', () => { photoScope = undefined; paint(); });
  panel.querySelectorAll<HTMLElement>('[data-prep-review]').forEach(element => {
    const turn = turns[Number(element.dataset.prepReview)];
    const review = turn.prep!;
    element.querySelectorAll<HTMLTextAreaElement>('[data-prep-description]').forEach(field => field.oninput = () => {
      const row = review.suggestions[Number(field.dataset.prepDescription)];
      if (row?.kind === 'description') row.text = field.value;
    });
    element.querySelectorAll<HTMLButtonElement>('[data-prep-approve]').forEach(button => button.onclick = () => {
      void approvePhotoPrep(turn, [review.suggestions[Number(button.dataset.prepApprove)]]);
    });
    element.querySelectorAll<HTMLButtonElement>('[data-prep-dismiss]').forEach(button => button.onclick = () => {
      const [row] = review.suggestions.splice(Number(button.dataset.prepDismiss), 1);
      if (row.kind === 'light') review.media.delete(row.index);
      if (row.kind === 'background') review.backgroundMedia.delete(row.index);
      paint(false, true);
    });
    element.querySelector<HTMLButtonElement>('[data-prep-approve-all]')?.addEventListener('click', () => {
      void approvePhotoPrep(turn, [...review.suggestions]);
    });
    element.querySelector<HTMLButtonElement>('[data-prep-dismiss-all]')?.addEventListener('click', () => { delete turn.prep; paint(false, true); });
  });
}

async function runPhotoPrep() {
  if (busy || !photoScope || state !== 'ready') return;
  const scope = photoScope, current = generation;
  const turn: AssistantTurn = {text: `Prep listing photos · ${scope.vehicle.stockNumber}`, skill: PHOTO_PREP_SKILL};
  turns.push(turn); photoScope = undefined; busy = true; paint();
  try {
    const {images, media} = await preparePhotoInputs(scope);
    if (generation !== current) return;
    const result = await api<Reply & {prep: Pick<PrepReview, 'suggestions' | 'missing' | 'version'>}>('/assistant/skills/run', 'POST',
      {skill: PHOTO_PREP_SKILL, surface: 'vehicle', id: scope.vehicle.id, version: scope.vehicle.version, images, descriptionOnly: scope.mode === 'description',
        ...(scope.mode !== 'description' && scope.replaceBackground ? {replaceBackground: true} : {})});
    if (generation !== current) return;
    const {prep, ...reply} = result;
    turn.result = reply;
    const order = effectiveVehiclePhotos(scope.vehicle).map((_, index) => index);
    const successful = new Set(prep.suggestions.flatMap(row => row.kind === 'light' ? [row.index] : []));
    for (const index of media.keys()) if (!successful.has(index)) media.delete(index);
    const backgroundMedia = await prepareBackgroundMedia(prep.suggestions);
    if (generation !== current) return;
    turn.prep = {...prep, scope, media, backgroundMedia, order, vehiclePhotoCount: order.length};
  } catch (error) {
    if (generation !== current) return;
    const next = chatErrorState(error as ApiError);
    if (next) { state = next; unconfigured = next === 'unconfigured'; }
    else turn.error = error instanceof Error ? error.message : 'Could not run photo prep.';
  } finally {
    if (generation === current) {
      busy = false; paint();
      const body = root.querySelector('.assistant-body');
      const anchor = body?.querySelector(`[data-assistant-turn="${turns.indexOf(turn)}"]`);
      if (body && anchor) body.scrollTop += anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
      await refreshPool();
    }
  }
}

async function approvePhotoPrep(turn: AssistantTurn, accepted: PrepReview['suggestions']) {
  if (busy || !turn.prep || !['ready', 'exhausted'].includes(state)) return;
  const current = generation, review = turn.prep;
  const photoPrep = approvalFields(review, accepted);
  busy = true; delete turn.error; paint(false, true);
  try {
    const saved = await api<VehicleView>(`/vehicles/${encodeURIComponent(review.scope.vehicle.id)}`, 'PUT', {version: review.version, photoPrep});
    if (generation !== current) return;
    if (photoPrep.order) review.order = photoPrep.order.map(index => review.order[index]);
    review.version = saved.version;
    review.vehiclePhotoCount = effectiveVehiclePhotos(saved).length;
    while (review.order.length < review.vehiclePhotoCount) review.order.push(review.order.length);
    review.suggestions = review.suggestions.filter(row => !accepted.includes(row));
    for (const row of accepted) {
      if (row.kind === 'light') review.media.delete(row.index);
      if (row.kind === 'background') review.backgroundMedia.delete(row.index);
    }
    document.dispatchEvent(new CustomEvent('vehicle-photo-prep-approved', {detail: saved}));
  } catch (error) {
    if (generation === current) turn.error = error instanceof Error ? error.message : 'Could not approve changes.';
  } finally { if (generation === current) { busy = false; paint(false, true); } }
}
