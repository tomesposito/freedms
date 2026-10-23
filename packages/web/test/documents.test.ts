import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentResultsHtml, documentsRoute } from '../src/documents.js';
import type { DocumentSearchResult } from '@freedms/shared';
import type { UI } from '../src/desking.js';
const doc: DocumentSearchResult = {id: 'doc', tenantId: 'A', kind: 'document', version: 1, createdAt: '', updatedAt: '', dealId: 'deal', name: '<img src=x>', type: 'id', size: 1, uploadedBy: 'admin', uploadedAt: '2026-10-19T12:00:00Z', buyerName: '<script>', dealStatus: 'approved'};
test('document results preserve jacket links, escape user text and distinguish disposed/pending states', () => {
  assert.match(documentResultsHtml([]), /No documents match/);
  assert.match(documentResultsHtml([], true), /No documents past retention/);
  const html = documentResultsHtml([{...doc, status: 'disposed'}]);
  assert.match(html, /Disposed/); assert.match(html, /href="#\/deals\/deal\/jacket"/);
  assert.doesNotMatch(html, /<img|<script|data-download|<button/); assert.match(html, /&lt;img/);
  assert.match(documentResultsHtml([{...doc, status: 'disposal-pending'}], true), /Retry disposal/);
});
test('Documents page gates admin requests and controls, and requires confirmation before disposal', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let click: (() => void) | undefined, confirmed = false, confirmation = '';
  let mutations = 0, markup = ''; const paths: string[] = [];
  const button = {dataset: {dispose: 'doc'}, disabled: false, addEventListener: (_: string, fn: () => void) => { click = fn; }};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {querySelector: () => ({addEventListener: () => {}}), querySelectorAll: () => [button]}});
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {confirm: (message: string) => { confirmation = message; return confirmed; }}});
  const ui: UI = {admin: false, current: () => true, shell: html => { markup = html; }, refresh: () => {}, flash: error => { throw error; }, api: async <T>(path: string, method?: string, body?: unknown) => {
    paths.push(path);
    if (method === 'POST') { mutations++; assert.deepEqual(body, {version: 1, confirm: true}); return {} as T; }
    return (path === '/documents/retention' ? {version: 0, retentionDays: null} : path === '/documents/past-retention' ? [doc] : []) as T;
  }};
  try {
    await documentsRoute(ui);
    assert.deepEqual(paths, ['/documents']); assert.doesNotMatch(markup, /Save retention|data-dispose/);
    ui.admin = true; await documentsRoute(ui);
    assert.match(markup, /No retention period configured/); assert.match(markup, /Nothing is deleted automatically/);
    assert.match(markup, /irreversible.*permanently/); assert.match(markup, /data-dispose/);
    click!(); assert.equal(mutations, 0); assert.match(confirmation, /irreversible.*permanently/);
    confirmed = true; click!();
    // Allow the async command and refresh to finish before restoring the DOM stub.
    await new Promise(resolve => setImmediate(resolve)); assert.equal(mutations, 1);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
