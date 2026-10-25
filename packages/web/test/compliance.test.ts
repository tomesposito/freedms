import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complianceChecklist, type ComplianceCheck } from '@freedms/shared';
import { complianceHtml, complianceLogHtml, complianceDisclaimer } from '../src/compliance.js';
import { readFileSync } from 'node:fs';
test('Compliance views state dealer responsibility, show missing items, escape text and never block work', () => {
  const checklist = complianceChecklist(null, [], {status: 'unknown', timestamp: null, source: ''}, []);
  const html = complianceHtml({record: null, checks: [], checklist, complete: false});
  assert.match(html, /No compliance work recorded yet/); assert.match(html, /Incomplete/); assert.match(html, /Missing/); assert.match(html, /continue working and printing/); assert.doesNotMatch(html, /disabled/);
  assert.match(html, /no discrepancy found/);
  const log = complianceLogHtml([], ''); assert.match(log, /No checks recorded yet/);
  for (const view of [html, log]) { assert.ok(view.includes(complianceDisclaimer)); assert.match(view, /freeDMS did not run or verify checks against any external database/); }
  const check = {customerName: '<script>', method: '<img>', result: 'clear', initials: '<b>', performedBy: '<x>', checkedDate: '', performedAt: '', dealId: 'deal'} as ComplianceCheck;
  const escaped = complianceLogHtml([check], '<script>'); assert.doesNotMatch(escaped, /<script>|<img>|<b>|<x>/); assert.match(escaped, /&lt;script&gt;/);
  const jacket = readFileSync(new URL('../src/jacket.ts', import.meta.url), 'utf8'); assert.match(jacket, /complianceHtml\(compliance\)/); assert.match(jacket, /Print packet/);
});

import { privacyHtml, auditHtml, complianceNavigation } from '../src/compliance.js';
import type { PrivacyRequest, Customer, OutboxEvent } from '@freedms/shared';
test('Privacy UI starts empty, uses real customers and displays history, terminal states and honest anonymization', () => {
  assert.match(privacyHtml([], []), /No privacy requests yet/);
  assert.match(privacyHtml([], []), /Create a customer/);
  const customer = {id: 'customer', name: '<script>Buyer</script>'} as Customer;
  const request = {id: 'request', customerId: customer.id, type: 'access', status: 'received', dueDate: '2026-11-23', history: [{actor: '<actor>', action: 'received', at: '2026-10-23', note: '<note>'}]} as PrivacyRequest;
  const html = privacyHtml([request], [customer]);
  assert.match(html, /Fulfil & download JSON/); assert.match(html, /Start progress/); assert.match(html, /Denial reason/);
  assert.doesNotMatch(html, /<script>|<actor>|<note>/); assert.match(html, /Step history/);
  const finished = privacyHtml([{...request, type: 'deletion', status: 'fulfilled'}], [customer]);
  assert.match(finished, /Personal fields were anonymized and financial records the dealer must legally keep \(deals, GL\) were preserved/);
  assert.doesNotMatch(finished, /data-privacy-action|data-privacy-deny|deleted/i);
  assert.doesNotMatch(privacyHtml([{...request, status: 'denied'}], [customer]), /data-privacy-action|data-privacy-deny/);
});
test('Audit UI is read-only, escaped, filterable and admin navigation is gated', () => {
  assert.doesNotMatch(complianceNavigation(false), /Audit log/); assert.match(complianceNavigation(true), /Audit log/);
  assert.match(auditHtml([], {}), /No audit events/);
  const html = auditHtml([{occurredAt: '2026-10-23', actorId: '<actor>', aggregateId: '<target>', type: 'customer.updated', action: 'customer.anonymized'} as OutboxEvent], {search: '<script>'});
  for (const field of ['type', 'actor', 'target', 'search']) assert.ok(html.includes(`name="${field}"`));
  assert.match(html, /customer.anonymized/); assert.doesNotMatch(html, /<actor>|<target>|<script>|Edit|Delete/);
});
