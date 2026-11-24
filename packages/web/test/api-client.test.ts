import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/api-client.js';

// The caller owns envelope parsing and error semantics, just as apiEnvelope does.
async function readEnvelope(response: Response): Promise<unknown> {
  const result = await response.json();
  if ('error' in result) throw Object.assign(new Error(result.error.message), {status: response.status});
  if (!response.ok) throw new Error('The request could not be completed.');
  return result.data;
}
function harness(statuses: number[], header?: string, envelope = false) {
  const responses: Response[] = [], sleeps: number[] = [];
  const init = {method: 'POST', body: '{"test":true}'};
  const run = () => fetchWithRetry('/test', init, {
    fetch: async (input, options) => {
      assert.equal(input, '/test'); assert.equal(options, init);
      const status = statuses[Math.min(responses.length, statuses.length - 1)];
      const response = new Response(JSON.stringify(status === 200 ? {data: 'ok'} : envelope ? {error: {message: 'Try later'}} : {message: 'Too Many Requests'}), {status, headers: header === undefined ? {} : {'Retry-After': header}});
      responses.push(response); return response;
    },
    sleep: async delay => { sleeps.push(delay); }, random: () => 0.5
  });
  return {run, responses, sleeps};
}
for (const status of [429, 503]) test(`HTTP ${status} retries before reading any discarded body`, async () => {
  const h = harness([status, 200]);
  assert.equal(await readEnvelope(await h.run()), 'ok');
  assert.equal(h.responses.length, 2); assert.deepEqual(h.sleeps, [300]);
  assert.equal(h.responses[0].bodyUsed, false);
});
test('permanent throttling exhausts exactly three attempts and preserves final envelope error status', async () => {
  const h = harness([429], undefined, true);
  await assert.rejects(async () => readEnvelope(await h.run()), {message: 'Try later', status: 429});
  assert.equal(h.responses.length, 3); assert.deepEqual(h.sleeps, [300, 800]);
  assert.deepEqual(h.responses.map(r => r.bodyUsed), [false, false, true]);
});
test('exhausted gateway response retains the generic caller error', async () => {
  const h = harness([503]);
  await assert.rejects(async () => readEnvelope(await h.run()), /The request could not be completed/);
  assert.equal(h.responses.length, 3);
});
for (const status of [400, 401, 403, 500]) test(`HTTP ${status} is returned once without retry or body parsing`, async () => {
  const h = harness([status], undefined, true);
  await assert.rejects(async () => readEnvelope(await h.run()), {message: 'Try later', status});
  assert.equal(h.responses.length, 1); assert.deepEqual(h.sleeps, []);
});
test('numeric Retry-After replaces backoff and is capped at five seconds', async () => {
  for (const [header, delay] of [['2', 2000], ['99', 5000], ['0', 0], ['0.5', 500], ['invalid', 300], ['-1', 300], ['', 300]] as const) {
    const h = harness([429, 200], header); await h.run(); assert.deepEqual(h.sleeps, [delay]);
  }
});
test('network exceptions are not retried', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('/test', undefined, {fetch: async () => { calls++; throw Error('offline'); }, sleep: async () => { assert.fail('must not sleep'); }}), /offline/);
  assert.equal(calls, 1);
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function pendingFetch() {
  const started: string[] = [];
  const pending: Array<{resolve: (response: Response) => void; reject: (error: Error) => void}> = [];
  let active = 0, peak = 0;
  const request: typeof fetch = async input => {
    started.push(String(input)); active++; peak = Math.max(peak, active);
    try { return await new Promise<Response>((resolve, reject) => pending.push({resolve, reject})); }
    finally { active--; }
  };
  return {request, started, pending, peak: () => peak};
}
test('assistant, reports, and downloads share two request slots in FIFO order', async () => {
  const h = pendingFetch();
  const paths = ['/assistant/pool', ...Array.from({length: 10}, (_, i) => `/reports/section-${i}`), '/reports/inventory.csv'];
  const calls = paths.map(path => fetchWithRetry(path, undefined, {fetch: h.request}));
  await tick(); assert.deepEqual(h.started, paths.slice(0, 2));
  for (let i = 0; i < paths.length; i++) {
    assert.ok(h.pending.length > 0); h.pending.shift()!.resolve(new Response('ok'));
    await tick();
    assert.deepEqual(h.started, paths.slice(0, Math.min(i + 3, paths.length)));
  }
  await Promise.all(calls); assert.equal(h.peak(), 2);
});
test('a failed request releases capacity for queued API calls', async () => {
  const h = pendingFetch();
  const failed = fetchWithRetry('/assistant/pool', undefined, {fetch: h.request});
  const rejection = assert.rejects(failed, /offline/);
  const second = fetchWithRetry('/reports/inventory', undefined, {fetch: h.request});
  const third = fetchWithRetry('/reports/sales', undefined, {fetch: h.request});
  await tick(); h.pending.shift()!.reject(Error('offline'));
  await rejection; await tick();
  assert.deepEqual(h.started, ['/assistant/pool', '/reports/inventory', '/reports/sales']);
  for (const pending of h.pending.splice(0)) pending.resolve(new Response('ok'));
  await Promise.all([second, third]); assert.equal(h.peak(), 2);
});
test('retry backoff releases its slot so unrelated requests can complete', async () => {
  let resume!: () => void, attempts = 0;
  const retry = fetchWithRetry('/reports/leads', undefined, {
    fetch: async () => new Response('ok', {status: attempts++ === 0 ? 503 : 200}),
    sleep: () => new Promise<void>(resolve => { resume = resolve; }),
  });
  await tick(); assert.equal(typeof resume, 'function');
  const h = pendingFetch();
  const other = ['/assistant/pool', '/reports/inventory'].map(path => fetchWithRetry(path, undefined, {fetch: h.request}));
  await tick(); assert.equal(h.started.length, 2);
  for (const pending of h.pending.splice(0)) pending.resolve(new Response('ok'));
  await Promise.all(other); resume(); assert.equal((await retry).status, 200);
});
