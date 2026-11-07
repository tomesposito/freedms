import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolState, chatErrorState, toolLabel, receipt, trayHtml, type AssistantPool, type AssistantState } from '../src/assistant.js';
const pool: AssistantPool = {tier: 'assistant', status: 'active', disabled: false, overageEnabled: false, balanceCredits: 75, cycleEnd: '2026-12-04'};
test('sandbox-restricted users see a waiting list with a locked composer', () => {
  const error = {code: 'ASSISTANT_SANDBOX_RESTRICTED', status: 403};
  assert.equal(poolState(undefined, error), 'waiting-list');
  assert.equal(chatErrorState(error), 'waiting-list');
  const html = trayHtml('waiting-list');
  assert.match(html, /join the waiting list/); assert.match(html, /Account → AI assistant/);
  assert.match(html, /<textarea[^>]*disabled/); assert.doesNotMatch(html, /Stripe|test payment|Subscribe/);
});
test('assistant pool state respects plan, disabled, zero and overage in order', () => {
  assert.equal(poolState(), 'loading'); assert.equal(poolState(pool), 'ready');
  for (const status of ['past_due', 'cancelled'] as const) {
    assert.equal(poolState({...pool, status}), status === 'past_due' ? 'past-due' : 'paywall');
    assert.equal(poolState({...pool, status, disabled: true}), 'disabled');
  }
  assert.equal(poolState({...pool, disabled: true, balanceCredits: 0}), 'disabled');
  for (const balanceCredits of [0, -1]) {
    assert.equal(poolState({...pool, balanceCredits}), 'exhausted');
    assert.equal(poolState({...pool, balanceCredits, overageEnabled: true}), 'ready');
  }
});
test('assistant pool failures lock safely without assuming free usage', () => {
  assert.equal(poolState(undefined, {code: 'ASSISTANT_PLAN_REQUIRED'}), 'paywall');
  assert.equal(poolState(undefined, {status: 402}), 'paywall');
  for (const error of [{status: 500}, {status: 403}, {}]) assert.equal(poolState(undefined, error), 'unavailable');
});
test('assistant chat errors distinguish exhausted 402 from paywall and permit provider retry', () => {
  for (const [code, state] of [['ASSISTANT_PLAN_REQUIRED', 'paywall'], ['ASSISTANT_DISABLED', 'disabled'], ['ASSISTANT_CREDITS_EXHAUSTED', 'exhausted'], ['ASSISTANT_UNAVAILABLE', 'unconfigured']]) assert.equal(chatErrorState({code}), state);
  assert.equal(chatErrorState({status: 402, code: 'ASSISTANT_CREDITS_EXHAUSTED'}), 'exhausted');
  assert.equal(chatErrorState({status: 503}), 'unconfigured');
  assert.equal(chatErrorState({status: 502, code: 'ASSISTANT_PROVIDER_FAILED'}), undefined);
});
test('assistant tool names have precise overrides and a literal humanized fallback', () => {
  for (const [name, label] of [['search_vehicles', 'Search inventory'], ['get_vehicle', 'Open vehicle record'], ['update_vehicle_status', 'Update vehicle status'], ['set_vehicle_status', 'Update vehicle status'], ['delete_lead', 'Delete lead'], ['constructor', 'Constructor'], ['get_listing_feed', 'Get listing feed'], ['', '']]) assert.equal(toolLabel(name), label);
});
for (const [state, text] of Object.entries({ready: 'What do you need done?', paywall: 'The assistant is a paid add-on.', exhausted: 'You are out of credits.', unconfigured: "The AI assistant isn't set up.", loading: 'Checking assistant plan…', unavailable: 'Unable to check assistant plan'})) {
  test(`assistant renders ${state} and its composer availability`, () => {
    const html = trayHtml(state as AssistantState, [], pool);
    assert.ok(html.includes(text));
    assert.equal(/<textarea[^>]*disabled/.test(html), state !== 'ready');
    assert.equal(/type="submit" disabled/.test(html), state !== 'ready');
    if (state === 'exhausted') assert.match(html, /December 4, 2026/);
    if (state === 'paywall') for (const term of ['75 credits', '175 credits', '350 credits', '$15', '$29', '$49', 'Failed actions never charge', 'Account → AI assistant']) assert.ok(html.includes(term));
    if (state === 'ready') for (const term of ['capture a signature', 'attest a compliance check', 'accept terms', 'handle MFA', 'credit decision', 'Those have no tools.']) assert.ok(html.includes(term));
  });
}
test('assistant conversation escapes every external text and preserves history in locked states', () => {
  for (const state of ['ready', 'exhausted', 'unconfigured', 'paywall'] as const) {
    const html = trayHtml(state, [{text: '<user>', error: '<error>', result: {reply: '<reply>', creditsUsed: 2, transcript: [{tool: '<tool>', ok: false}, {tool: 'search_vehicles', ok: true}]}}], pool, false, '</textarea><script>');
    for (const text of ['&lt;user&gt;', '&lt;error&gt;', '&lt;reply&gt;', '&lt;tool&gt;', '&lt;/textarea&gt;&lt;script&gt;', 'failed', 'done', 'This used 2 credits']) assert.ok(html.includes(text));
    assert.doesNotMatch(html, /<script>|<user>|<reply>|<tool>/);
  }
});
test('assistant disabled state renders nothing — the widget is absent, not a locked tray', () => {
  assert.equal(trayHtml('disabled', [], {...pool, disabled: true}), '');
  assert.equal(trayHtml('disabled', [{text: 'Find cars', result: {reply: 'ok', creditsUsed: 1, transcript: []}}], pool), '');
});
test('assistant receipts use actual credits and working state does not invent tool activity', () => {
  assert.equal(receipt(1), 'This used 1 credit'); assert.equal(receipt(0), 'This used 0 credits');
  const html = trayHtml('ready', [{text: 'Find cars'}], pool, true);
  assert.match(html, /Working…/); assert.doesNotMatch(html, /assistant-tool|This used/); assert.match(html, /<textarea[^>]*disabled/);
});

test('assistant tray locks at monthly overage cap', () => {
  assert.equal(poolState({...pool, overageEnabled: true, balanceCredits: -2, overageCapCredits: 2, overageCreditsUsed: 2}), 'exhausted');
});
test('past due has a distinct locked state and payment note', () => {
  assert.equal(chatErrorState({code: 'ASSISTANT_PAST_DUE', status: 402}), 'past-due');
  assert.match(trayHtml('past-due'), /Payment is past due/);
  assert.match(trayHtml('past-due'), /Account → AI assistant/);
  assert.match(trayHtml('past-due'), /The assistant is a paid add-on/);
});

test('assistant hash context mirrors detail and list routes without treating action pages as records', async () => {
  const {assistantContextFromHash: context} = await import('../src/assistant.js');
  for (const hash of ['#/', '#/vehicles', '#/vehicles/']) assert.deepEqual(context(hash), {surface: 'vehicles'});
  assert.deepEqual(context('#/leads'), {surface: 'leads'});
  for (const [route, surface] of [['vehicles', 'vehicle'], ['leads', 'lead'], ['deals', 'deal']]) assert.deepEqual(context(`#/${route}/record-104`), {surface, id: 'record-104'});
  for (const hash of ['#/leads/new', '#/leads/equity', '#/deals/new/lead/abc', '#/deals/new/vehicle/abc', '#/deals/settings', '#/vehicles/abc/edit', '#/reports', '#/account']) assert.equal(context(hash), null, hash);
});
test('skills show prices; proposals escape all record data and only fixes have unchecked controls', async () => {
  const {skillChipsHtml, proposalsHtml} = await import('../src/assistant.js');
  assert.match(skillChipsHtml([{id: 'vehicle_summary', name: 'Vehicle summary', costCredits: 3, kind: 'summary'}]), /Vehicle summary · 3 credits/);
  const html = proposalsHtml([
    {proposalId: 'fix:<id>', kind: 'fix', label: '<name>', current: '<script>', proposed: '"<new>'},
    {proposalId: 'duplicate', kind: 'duplicate', label: '<duplicate>'},
    {proposalId: 'missing', kind: 'missing', label: '<missing>'},
    {proposalId: 'stale', kind: 'stale', label: '<stale>'},
  ], 0);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  assert.doesNotMatch(html, / checked|<script>|<name>|<new>|<duplicate>|<missing>|<stale>/);
  for (const text of ['&lt;script&gt;', '&lt;name&gt;', 'Merge proposal — handle by hand', 'data-assistant-apply disabled', '2 credits per customer', 'same read cost']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(proposalsHtml([{proposalId: 'duplicate', kind: 'duplicate', label: 'Merge'}], 0), /checkbox|data-assistant-apply/);
});
