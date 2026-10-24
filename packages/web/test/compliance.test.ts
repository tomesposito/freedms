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
