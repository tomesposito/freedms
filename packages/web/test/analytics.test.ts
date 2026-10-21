import { test } from 'node:test';
import assert from 'node:assert/strict';
import { track, type AnalyticsApi } from '../src/analytics.js';
import { bindDraftOutcome, clearDrafts } from '../src/quick-entry.js';

test('client analytics uses one endpoint and silently absorbs request failures', async () => {
  const calls: unknown[][] = [];
  const api: AnalyticsApi = async (...args) => { calls.push(args); throw new Error('offline'); };
  await track(api, {event: 'pencil_grid_viewed'});
  assert.deepEqual(calls, [['/analytics/events', 'POST', {event: 'pencil_grid_viewed'}]]);
});
test('review reports saved, edited-then-saved and discarded once without any form content', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const window = new EventTarget(); Object.defineProperty(globalThis, 'window', {value: window, configurable: true});
  try {
    const calls: unknown[] = [];
    const api: AnalyticsApi = async (_path, _method, body) => { calls.push(body); return undefined as never; };
    for (const surface of ['inventory', 'lead'] as const) {
      for (const outcome of ['saved', 'edited', 'discarded'] as const) {
        const form = new EventTarget() as HTMLFormElement;
        const saved = bindDraftOutcome(form, surface, api);
        if (outcome === 'edited') form.dispatchEvent(new Event('input'));
        if (outcome === 'discarded') window.dispatchEvent(new Event('hashchange')); else saved();
        saved(); window.dispatchEvent(new Event('hashchange')); clearDrafts();
        assert.deepEqual(calls.at(-1), {event: 'quick_entry_used', surface, input: 'text', outcome});
      }
    }
    assert.equal(calls.length, 6);
    bindDraftOutcome(new EventTarget() as HTMLFormElement, 'lead', api);
    clearDrafts(); clearDrafts(); assert.equal(calls.length, 7);
    assert.deepEqual(calls.at(-1), {event: 'quick_entry_used', surface: 'lead', input: 'text', outcome: 'discarded'});
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
  }
});
