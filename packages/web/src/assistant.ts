import { escapeHtml as e } from './format';

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
export interface AssistantSkill {id: string; name: string; costCredits: number; kind: 'summary' | 'cleanup'}
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
  overageCapCredits?: number; overageCreditsUsed?: number;
  tier: string; status: 'active' | 'past_due' | 'cancelled'; disabled: boolean;
  overageEnabled: boolean; balanceCredits: number; cycleEnd: string;
}
export type AssistantState = 'loading' | 'ready' | 'paywall' | 'past-due' | 'disabled' | 'exhausted' | 'unconfigured' | 'unavailable';
type ApiError = {code?: string; status?: number};
export function poolState(pool?: AssistantPool, error?: ApiError): AssistantState {
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
export interface AssistantTurn {text: string; result?: Reply; error?: string; skill?: string; context?: AssistantContext; applied?: boolean}
const locked: Record<AssistantState, string> = {
  ready: 'Ask, or tell it what to do…', loading: 'Checking assistant plan…', unavailable: 'Unable to check assistant plan — reopen to retry',
  'past-due': 'Locked — payment is past due',
  paywall: 'Locked — this store has no assistant plan', exhausted: 'Out of credits',
  disabled: 'Locked — assistant turned off by an admin', unconfigured: 'Locked — assistant is not set up',
};
function stateBody(state: AssistantState, pool?: AssistantPool): string {
  switch (state) {
    case 'ready': return `<section><h2>What do you need done?</h2><p>Ask about anything in the store, or hand it a job. It uses the same tools as the AI connections your dealers already run — as you, with your permissions.</p><ul class="assistant-capabilities"><li>Find cars, leads, deals, and repair orders</li><li>Add and update records — stock a vehicle, move a lead, post a note</li><li>Run the numbers on a pencil or a report</li></ul><div class="assistant-note"><b>It cannot, ever:</b> capture a signature, attest a compliance check, accept terms, handle MFA, or make a credit decision. Those have no tools. They stay with a person.</div></section>`;
    case 'past-due': return `<p role="status">Payment is past due. Ask an admin to update billing in Account → AI assistant.</p>${stateBody('paywall', pool)}`;
    case 'paywall': return `<section><h2>The assistant is a paid add-on.</h2><p>freeDMS itself is free. The assistant is not — it runs on a frontier model and works the store as you do. It is priced in credits: a lookup costs 1, a change costs 2, and the pool is shared by the whole dealership.</p>${[['Assistant', 75, 15], ['Assistant Pro', 175, 29], ['Assistant Heavy', 350, 49]].map(([name, credits, price]) => `<div class="assistant-tier"><div><b>${e(name)}</b><small>${e(credits)} credits per user</small></div><strong>$${e(price)} / user / mo</strong></div>`).join('')}<div class="assistant-note">Failed actions never charge, and the pool stops hard at zero — nobody gets a surprise bill.</div><div class="assistant-callout">Ask your admin to turn it on</div><p class="assistant-small">Admins subscribe under Account → AI assistant. Your usage is recorded under your name, like everything else you do in the store.</p></section>`;
    case 'exhausted': {
      const date = pool?.cycleEnd ? new Date(pool.cycleEnd) : undefined;
      const reset = date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'}) : 'the next cycle date';
      return `<section><div class="assistant-stop"><h2>You are out of credits.</h2><p>The dealership pool is used up for this cycle. The assistant stops here by design so the bill cannot run past the plan. Work you did this cycle is all still in the product, under the names of the people who asked for it.</p></div><div class="assistant-note"><b>To keep going:</b> an admin can buy a top-up (25¢ a credit) or turn on overage under Account → AI assistant. Otherwise the pool refills on ${e(reset)}.</div></section>`;
    }
    case 'unconfigured': return `<section class="assistant-unconfigured"><h2>The AI assistant isn't set up.</h2><p>This workspace's deployment has no assistant model configured, so there is nothing to talk to yet. Nothing here is simulated — when the operator enables it, this tray is where it will live.</p><div class="assistant-note"><b>Operator note:</b> set the stack's AssistantModelId parameter to a Bedrock model the account can invoke, and redeploy. The tray enables itself; no other setting changes.</div></section>`;
    default: return `<p role="status">${e(locked[state])}</p>`;
  }
}
export function trayHtml(state: AssistantState, turns: AssistantTurn[] = [], pool?: AssistantPool, busy = false, draft = '', skills: AssistantSkill[] = []): string {
  // Disabled means absent: the shell hides entirely (see paint), and there is no tray to render.
  if (state === 'disabled') return '';
  return `<header class="assistant-header"><div><h2 id="assistant-title">AI assistant${state === 'exhausted' ? '' : `<span>${(state === 'paywall' || state === 'past-due') ? 'PAID' : 'BEDROCK'}</span>`}</h2><button type="button" id="assistant-close" aria-label="Close AI assistant">✕</button></div><p>Works in this workspace as you · ${(state === 'paywall' || state === 'past-due') ? 'billed to the dealership' : 'every action is recorded as yours'}</p>${pool ? `<p class="assistant-header-balance">${e(pool.balanceCredits.toLocaleString('en-US'))} credits</p>` : ''}</header><div class="assistant-body" aria-live="polite">${state === 'ready' ? skillChipsHtml(skills, busy) : ''}${turns.map((turn, i) => `<div class="assistant-user">${e(turn.text)}</div>${turn.result ? `${turn.result.transcript.map(row => `<div class="assistant-tool ${row.ok ? 'done' : 'failed'}"><i aria-hidden="true"></i>${e(toolLabel(row.tool))}<small>${row.ok ? 'done' : 'failed'}</small></div>`).join('')}<div class="assistant-reply">${e(turn.result.reply)}</div><div class="assistant-receipt">${e(receipt(turn.result.creditsUsed))}</div>${turn.result.proposals ? proposalsHtml(turn.result.proposals, i, busy || state !== 'ready' || !!turn.applied) : ''}` : ''}${turn.error ? `<div class="assistant-error" role="alert">${e(turn.error)}${state === 'ready' && !busy && !turn.skill ? `<button type="button" data-assistant-retry="${e(i)}">Retry</button>` : ''}</div>` : ''}`).join('')}${busy ? '<div class="assistant-working" role="status">● ● ● <span>Working…</span></div>' : ''}${state !== 'ready' || !turns.length ? stateBody(state, pool) : ''}</div><form class="assistant-composer"><textarea id="assistant-input" aria-label="Message AI assistant" rows="2" maxlength="16000" placeholder="${e(locked[state])}" ${state !== 'ready' || busy ? 'disabled' : ''}>${e(draft)}</textarea><button class="primary" type="submit" ${state !== 'ready' || busy ? 'disabled' : ''}>Send</button></form>`;
}

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
// Memory only: neither messages nor drafts are written to browser storage or logs.
let owner = '', open = false, turns: AssistantTurn[] = [], pool: AssistantPool | undefined;
let state: AssistantState = 'loading', unconfigured = false, busy = false, draft = '', generation = 0, poolRequest = 0;
let root: HTMLElement, cluster: HTMLElement, trigger: HTMLButtonElement, api: Api;
let skills: AssistantSkill[] = [], skillContext: AssistantContext | null = null, skillsRequest = 0, skillsError = '';
export function resetAssistant(): void {
  generation++; poolRequest++; skillsRequest++; skills = []; skillContext = null; skillsError = ''; owner = ''; open = false; turns = []; pool = undefined;
  state = 'loading'; unconfigured = false; busy = false; draft = '';
  root?.querySelector<HTMLDialogElement>('dialog')?.close();
}
function paint(focus = false): void {
  if (!root?.isConnected) return;
  const input = root.querySelector<HTMLTextAreaElement>('#assistant-input');
  const hadFocus = document.activeElement === input;
  const selection = input?.selectionStart;
  const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
  if (state === 'disabled') { open = false; if (dialog.open) dialog.close(); root.style.display = 'none'; cluster.style.display = 'none'; return; }
  root.style.display = ''; cluster.style.display = '';
  trigger.setAttribute('aria-expanded', String(open));
  trigger.innerHTML = '<span class="assistant-spark" aria-hidden="true">✦</span><span class="assistant-label">AI assistant</span>';
  cluster.querySelector('#assistant-credit')!.innerHTML = pool ? `<span class="assistant-balance">${e(pool.balanceCredits.toLocaleString('en-US'))} credits</span>` : '';
  dialog.innerHTML = trayHtml(state, turns, pool, busy, draft, skills);
  if (skillsError) { const note = document.createElement('p'); note.className = 'assistant-error'; note.textContent = skillsError; dialog.querySelector('.assistant-body')?.prepend(note); }
  if (open && !dialog.open) dialog.showModal();
  if (!open && dialog.open) dialog.close();
  if (open && (focus || hadFocus)) {
    const next = dialog.querySelector<HTMLTextAreaElement>('#assistant-input')!;
    if (!next.disabled) { next.focus(); if (hadFocus && selection !== undefined) next.setSelectionRange(selection, selection); }
    else dialog.querySelector<HTMLButtonElement>('#assistant-close')!.focus();
  }
  dialog.querySelector('#assistant-close')!.addEventListener('click', close);
  dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void send(draft); });
  const next = dialog.querySelector<HTMLTextAreaElement>('#assistant-input')!;
  next.addEventListener('input', () => { draft = next.value; });
  next.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(draft); } });
  dialog.querySelectorAll<HTMLButtonElement>('[data-assistant-retry]').forEach(button => button.addEventListener('click', () => { void send(turns[Number(button.dataset.assistantRetry)].text); }));
  dialog.querySelectorAll<HTMLButtonElement>('[data-assistant-skill]').forEach(button => button.addEventListener('click', () => { void runSkill(button.dataset.assistantSkill!); }));
  dialog.querySelectorAll<HTMLElement>('[data-proposals]').forEach(list => {
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
  if (busy || turns.length) { const body = dialog.querySelector('.assistant-body')!; body.scrollTop = body.scrollHeight; }
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
  paint(focusComposer);
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
  skillsRequest++; skills = []; skillsError = ''; skillContext = null;
  api = request;
  root = document.createElement('div'); root.className = 'assistant-shell';
  root.innerHTML = '<dialog id="assistant-tray" aria-labelledby="assistant-title"></dialog>';
  // Keep the modal outside responsive chrome: moving an open dialog exits the top layer.
  cluster = container;
  cluster.innerHTML = '<span id="assistant-credit"></span><button type="button" id="assistant-trigger" aria-label="AI assistant" aria-controls="assistant-tray" aria-expanded="false"></button>';
  (container.closest('#app') ?? container).append(root);
  trigger = cluster.querySelector<HTMLButtonElement>('#assistant-trigger')!;
  trigger.addEventListener('click', () => { if (open) close(); else void openTray(); });
  const dialog = root.querySelector('dialog')!;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientY > dialog.getBoundingClientRect().bottom)) close(); });
  paint(open); void refreshPool().then(() => { if (open) void loadSkills(); });
}
