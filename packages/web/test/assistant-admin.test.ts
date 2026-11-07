import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantAdminHtml, assistantAdminRoute, pendingBilling, type AssistantAdminData } from '../src/assistant-admin.js';
const data: AssistantAdminData = {
  plan: {tier: 'assistant-pro', tierName: 'Assistant Pro', pricePerUserCents: 2900, creditsPerUser: 175, billedUserCount: 10, monthlyTotalCents: 29000, renewalDate: '2026-12-03', status: 'active'},
  pool: {allotmentCredits: 1750, topUpCredits: 0, usedCredits: 612, balanceCredits: 1138, cycleStart: '2026-11-03', cycleEnd: '2026-12-03'},
  usage: [{userId: 'a', name: '<Owner>', actions: 2, credits: 3, lastUsedAt: '2026-11-04T12:00:00Z'}],
  controls: {disabled: false, overageEnabled: false, overageCapCredits: 500, perRequestCreditCap: 25},
};
test('admin page renders plan, pool, usage, controls and honest billing', () => {
  const html = assistantAdminHtml(data);
  for (const text of ['Assistant Pro', '$29 / AI user / mo', '10 AI users', '$290 / month', '1138 of 1750 credits left', '612 used', '<progress', '&lt;Owner&gt;', new Date(data.usage![0].lastUsedAt!).toLocaleString(), 'value="25"', pendingBilling, 'Manage billing', 'Top up']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<Owner>|href=/);
  assert.match(assistantAdminHtml({...data, usage: []}), /No assistant use yet this cycle/);
});
test('no plan and nonadmin render plain empty states without controls or API access', async () => {
  const html = assistantAdminHtml({plan: null}); assert.match(html, /No AI assistant plan yet/); assert.match(html, /Join the waiting list/); assert.doesNotMatch(html, /<input/);
  let rendered = '';
  await assistantAdminRoute({admin: false, api: async () => {throw Error('must not call');}, shell: value => {rendered = value;}, current: () => true, refresh: () => {}, flash: () => {throw Error('unexpected');}});
  assert.equal(rendered, assistantAdminHtml(data, false)); assert.match(rendered, /Only a workspace admin/); assert.doesNotMatch(rendered, /<input/);
});
test('waiting list card offers every tier and the joined state names the plan', () => {
  const open = assistantAdminHtml({plan: null});
  for (const name of ['Assistant', 'Assistant Pro', 'Assistant Heavy']) assert.ok(open.includes(name));
  assert.equal((open.match(/data-waitlist="join"/g) ?? []).length, 3);
  assert.match(open, /Joining doesn't start a plan or charge anything/);
  assert.ok(!open.includes(pendingBilling));
  const joined = assistantAdminHtml({plan: null, waitlist: {tier: 'assistant-pro', tierName: 'Assistant Pro', pricePerUserCents: 2900, creditsPerUser: 175, requestedAt: '2026-11-07T18:00:00Z', requestedByName: 'Ann Admin'}});
  assert.match(joined, /You're on the waiting list/);
  assert.match(joined, /Assistant Pro/);
  assert.match(joined, /Requested Nov 7, 2026/);
  assert.match(joined, /Nothing is charged and no plan has started/);
  assert.match(joined, /data-waitlist="change"/);
  assert.match(joined, /data-waitlist="leave"/);
  const configured = assistantAdminHtml({plan: null, billingConfigured: true, waitlist: {tier: 'assistant-pro', tierName: 'Assistant Pro', pricePerUserCents: 2900, creditsPerUser: 175, requestedAt: '2026-11-07T18:00:00Z', requestedByName: 'Ann Admin'}});
  assert.match(configured, /Subscribe to Assistant Pro/);
  assert.doesNotMatch(configured, /waiting list/);
});
test('configured billing renders shared tiers, checkout, portal, topup, past due and cancellation', () => {
  const empty = assistantAdminHtml({plan: null, billingConfigured: true});
  for (const name of ['Assistant', 'Assistant Pro', 'Assistant Heavy']) assert.ok(empty.includes(`Subscribe to ${name}`));
  for (const price of ['$15', '$29', '$49']) assert.ok(empty.includes(price));
  assert.doesNotMatch(empty, /isn't set up/);
  const active = assistantAdminHtml({...data, billingConfigured: true});
  assert.match(active, /data-billing="portal"/); assert.match(active, /data-topup-credits/); assert.match(active, /data-billing="topup"/);
  const due = assistantAdminHtml({...data, billingConfigured: true, plan: {...data.plan!, status: 'past_due'}});
  assert.match(due, /Payment is past due/); assert.match(due, /Manage billing to update payment/);
  assert.match(assistantAdminHtml({...data, billingConfigured: true, plan: {...data.plan!, accessUntil: '2026-12-03T00:00:00Z'}}), /Cancels Dec 3, 2026/);
});
