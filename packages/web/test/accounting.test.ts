import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountBalance, GlAccount, JournalView } from '@freedms/shared';
import { accountRows, balanceRows, commissionsHtml, journalHtml, trialHtml } from '../src/accounting.js';
const a: GlAccount = {id: 'a', tenantId: 'A', kind: 'gl-account', code: '1000', name: '<img src=x>', type: 'asset', active: false, system: true, version: 1, createdAt: '', updatedAt: ''};
const balance: AccountBalance = {accountId: a.id, code: a.code, name: a.name, type: a.type, debit: 100, credit: 100, balance: 0};
const entry: JournalView = {id: 'j', tenantId: 'A', kind: 'journal-entry', version: 1, createdAt: '', updatedAt: '', date: '2026-10-23', dealId: 'd', source: 'deal-posting', memo: '<script>memo</script>', lines: [{accountId: 'a', accountCode: '1000', accountName: a.name, debit: 100, credit: 0, explanation: '<script>why</script>'}], reversesEntryId: null, reversedByEntryId: null, reversed: false};
test('Accounting renderers escape names, memos, explanations and show balances, totals, status and pack links', () => {
  for (const html of [accountRows([a], [balance]), balanceRows([balance]), journalHtml([entry])]) { assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/); }
  assert.match(accountRows([a], [balance]), /Inactive/);
  assert.match(journalHtml([entry]), /&lt;script/); assert.match(journalHtml([entry]), /#\/accounting\/deals\/d/); assert.match(journalHtml([entry]), /data-reverse/);
  assert.doesNotMatch(journalHtml([{...entry, reversed: true}]), /data-reverse/);
  assert.doesNotMatch(journalHtml([{...entry, source: 'reversal'}]), /data-reverse/);
  assert.match(journalHtml([]), /No journal entries/);
  assert.match(trialHtml({from: null, to: null, rows: [balance], totals: {debit: 100, credit: 100, balanced: true}}), /Balanced.*\$1\.00.*\$1\.00/);
  const commissions = {from: null, to: null, rateBps: 2500, rows: [], totals: {frontGross: 0, commission: 0}};
  assert.match(commissionsHtml(commissions), /No sold deals in this period/);
  assert.match(commissionsHtml(commissions), /25\.00%/);
  const html = commissionsHtml({...commissions, rows: [{dealId: 'd', soldDate: '', buyer: '<script>x</script>', vehicle: '<img>', frontGross: 100, commission: 25}]});
  assert.doesNotMatch(html, /<script|<img/); assert.match(html, /\$0\.25/);
});

test('Departmental statements render totals and escaped account names; fixed ops journal links identify sources', async () => {
  const { departmentalHtml } = await import('../src/accounting.js');
  const data = {from:null,to:null,departments:[{department:'service' as const,income:35682,expenses:1350,grossProfit:34332,rows:[{...balance,type:'income' as const}]}],totals:{income:35682,expenses:1350,grossProfit:34332}};
  const html=departmentalHtml(data); assert.match(html,/Service/);assert.match(html,/Total gross profit \$343\.32/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
  assert.match(departmentalHtml({...data,departments:[]}),/No income or expense entries/);
  const journal=journalHtml([{...entry,dealId:null,repairOrderId:'ro/1',source:'service-posting'},{...entry,dealId:null,partsSaleId:'<sale>',source:'parts-posting',reversed:true}]);
  assert.match(journal,/#\/service\/repair-orders\/ro%2F1/);assert.match(journal,/#\/parts/);assert.match(journal,/Counter sale &lt;sale&gt;/);assert.match(journal,/Reversed/);
});
