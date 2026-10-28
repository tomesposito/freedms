/**
 * Scale latency harness (issue #49). Drives hot paths through the HTTP API
 * as an authenticated tenant user. Run:
 *   node --import tsx scripts/scale-measure.ts --state scale-state.json
 * Emits JSON + a markdown report with per-endpoint p50/p95 and PASS/FAIL
 * against budget. It REPORTS budget failures; it never fixes endpoints.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  summarize, evaluateBudget, budgetMsFor, stringFlag, intFlag, hasFlag,
  vehiclePayload, customerPayload, type EndpointKind,
} from './scale-lib.js';

const argv = process.argv.slice(2);
if (hasFlag(argv, 'help')) {
  console.log(`Usage: node --import tsx scripts/scale-measure.ts [options]
  --state <file>          seed state JSON (default scale-state.json locally; no tokens stored)
  --base-url <url>        API base (default $FREEDMS_SCALE_BASE_URL or state/host or http://127.0.0.1:3001)
  --out <file>            JSON results file (default scale-results.json)
  --report <file>         markdown report file (also printed to stdout)
  --requests <n>          requests per endpoint per concurrency level (default 100)
  --peak <n>              peak concurrency (default 5)
  --ten-x <n>             10x concurrency (default 50)
  --light-sample <n>      light tenants to sample for GET endpoints (default 5)
  Auth: $FREEDMS_SCALE_TOKEN if set (hosted; skips /local/session), otherwise
  tenants are re-sessioned locally via POST /local/session {tenantId, email}.`);
  process.exit(0);
}

const statePath = stringFlag(argv, 'state') ?? (process.env.FREEDMS_SCALE_TOKEN ? undefined : 'scale-state.json');
const outPath = stringFlag(argv, 'out') ?? 'scale-results.json';
const reportPath = stringFlag(argv, 'report');
const requestsPer = Math.max(1, intFlag(argv, 'requests') ?? 100);
const peak = Math.max(1, intFlag(argv, 'peak') ?? 5);
const tenX = Math.max(1, intFlag(argv, 'ten-x') ?? 50);
const lightSample = Math.max(0, intFlag(argv, 'light-sample') ?? 5);
const envToken = process.env.FREEDMS_SCALE_TOKEN ?? '';

interface SeedTenant { label: string; tenantId: string; email: string | null; counts?: Record<string, number> }
interface SeedState {
  profile?: string; baseHost?: string; createdAt?: string; truncated?: boolean;
  heavyProfile?: unknown; lightProfile?: unknown; lightTenantsPlanned?: number;
  heavy: SeedTenant | null; light: SeedTenant[];
}

let seedState: SeedState | null = null;
if (statePath) seedState = JSON.parse(await readFile(statePath, 'utf8')) as SeedState;

const baseUrl = (stringFlag(argv, 'base-url') ?? process.env.FREEDMS_SCALE_BASE_URL
  ?? (seedState?.baseHost ? `http://${seedState.baseHost}` : 'http://127.0.0.1:3001')).replace(/\/$/, '');

class Client {
  constructor(public tenant: { tenantId?: string; email?: string | null }, public token: string) {}
  async raw(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* keep status only */ }
    return { status: res.status, data: json.data ?? json };
  }
  async request<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let r = await this.raw(method, path, body);
    if (r.status === 401 && this.tenant.tenantId && this.tenant.email && !envToken) {
      const s = await this.raw('POST', '/local/session', { tenantId: this.tenant.tenantId, email: this.tenant.email });
      if (s.status === 200 && s.data?.token) { this.token = s.data.token; r = await this.raw(method, path, body); }
    }
    return r as { status: number; data: T };
  }
  async must<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> HTTP ${r.status}`);
    return r.data;
  }
}

async function clientFor(tenant: SeedTenant | null): Promise<Client> {
  if (envToken) return new Client(tenant ? { tenantId: tenant.tenantId, email: tenant.email } : {}, envToken);
  if (!tenant?.tenantId || !tenant?.email) throw new Error('No seed state tenant (with email) and no FREEDMS_SCALE_TOKEN: cannot authenticate. Run scale-seed first or set the token env.');
  const anon = new Client({}, '');
  const s = await anon.request<any>('POST', '/local/session', { tenantId: tenant.tenantId, email: tenant.email });
  if (s.status !== 200 || !s.data?.token) throw new Error(`Re-session for tenant ${tenant.tenantId} failed (HTTP ${s.status})`);
  return new Client({ tenantId: tenant.tenantId, email: tenant.email }, s.data.token);
}

const today = new Date().toISOString().slice(0, 10);
const range = `from=2000-01-01&to=${today}`;

interface EndpointDef { name: string; kind: EndpointKind; method: 'GET' | 'PUT'; path: string; note?: string }

function getEndpoints(): EndpointDef[] {
  return [
    { name: 'inventory-list', kind: 'read', method: 'GET', path: '/vehicles' },
    { name: 'inventory-aging-report', kind: 'report', method: 'GET', path: '/reports/inventory' },
    { name: 'lead-pipeline-board', kind: 'read', method: 'GET', path: '/leads' },
    { name: 'lead-pipeline-summary', kind: 'report', method: 'GET', path: '/reports/leads' },
    { name: 'service-board', kind: 'read', method: 'GET', path: `/service/board?date=${today}` },
    { name: 'trial-balance', kind: 'report', method: 'GET', path: `/accounting/trial-balance?${range}` },
    { name: 'department-statement', kind: 'report', method: 'GET', path: `/accounting/departmental?${range}` },
    { name: 'sales-report', kind: 'report', method: 'GET', path: `/reports/sales?${range}` },
    { name: 'forecasts', kind: 'report', method: 'GET', path: `/reports/forecasts?${range}` },
    { name: 'pencil-calculation', kind: 'pencil', method: 'PUT', path: '/deals/:scratch', note: 'WRITE: pencil recalculation via PUT /deals/:id; one scratch deal per concurrent worker, budget = read budget' },
  ];
}

interface RunResult {
  tenant: string; endpoint: string; kind: EndpointKind; level: string; concurrency: number;
  count: number; errors: number; errorStatuses: Record<string, number>;
  p50: number | null; p95: number | null; max: number | null; mean: number | null;
  budgetMs: number; pass: boolean;
  samples: Array<{ latencyMs: number; status: number }>;
}

async function runConcurrent(client: Client, ep: EndpointDef, level: string, concurrency: number, total: number): Promise<RunResult> {
  const latencies: number[] = [];
  const samples: RunResult['samples'] = [];
  const errorStatuses: Record<string, number> = {};
  let errors = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) {
      next++;
      const t0 = performance.now();
      const r = await client.request(ep.method, ep.path).catch(() => ({ status: 0 }));
      const latencyMs = performance.now() - t0;
      latencies.push(latencyMs);
      samples.push({ latencyMs, status: r.status });
      if (r.status !== 200) { errors++; errorStatuses[String(r.status)] = (errorStatuses[String(r.status)] ?? 0) + 1; }
    }
  }));
  const s = summarize(latencies);
  const budget = evaluateBudget(ep.kind, s.p95);
  return { tenant: 'heavy', endpoint: ep.name, kind: ep.kind, level, concurrency, count: s.count, errors, errorStatuses, p50: s.p50, p95: s.p95, max: s.max, mean: s.mean, budgetMs: budget.budgetMs, pass: budget.pass && errors === 0, samples };
}

/** One scratch deal per worker preserves optimistic versions at actual concurrency. */
async function runPencil(client: Client, dealIds: string[], level: string, concurrency: number, total: number): Promise<RunResult> {
  const samples: RunResult['samples'] = [];
  const errorStatuses: Record<string, number> = {};
  let errors = 0, next = 0;
  await Promise.all(dealIds.slice(0, Math.min(concurrency, total)).map(async dealId => {
    let deal = await client.must<any>('GET', `/deals/${dealId}`);
    while (next < total) {
      next++;
      const pencil = deal.pencils.find((p: any) => p.id === deal.workingPencilId) ?? deal.pencils[0];
      const nextPencil = { ...pencil, down: pencil.down === 10007 ? 10000 : 10007 };
      const t0 = performance.now();
      const r = await client.request('PUT', `/deals/${dealId}`, { version: deal.version, pencils: [nextPencil], workingPencilId: deal.workingPencilId }).catch(() => ({ status: 0, data: null }));
      samples.push({ latencyMs: performance.now() - t0, status: r.status });
      if (r.status !== 200) {
        errors++; errorStatuses[String(r.status)] = (errorStatuses[String(r.status)] ?? 0) + 1;
        // Recover the version after an ambiguous transport failure without hiding it.
        deal = await client.must<any>('GET', `/deals/${dealId}`);
      } else deal = r.data;
    }
  }));
  const s = summarize(samples.map(r => r.latencyMs));
  const budget = evaluateBudget('pencil', s.p95);
  return { tenant: 'heavy', endpoint: 'pencil-calculation', kind: 'pencil', level, concurrency, count: s.count, errors, errorStatuses, p50: s.p50, p95: s.p95, max: s.max, mean: s.mean, budgetMs: budget.budgetMs, pass: budget.pass && errors === 0, samples };
}

async function ensureTodayAppointment(client: Client, userId: string): Promise<void> {
  const board = await client.must<any>('GET', `/service/board?date=${today}`);
  if ((board.appointments?.length ?? 0) > 0) return;
  const customers = await client.must<any[]>('GET', '/customers');
  const customerId = customers[0]?.id;
  if (!customerId) return;
  const start = `${today}T16:00:00.000Z`, end = `${today}T17:00:00.000Z`;
  await client.must('POST', '/service/appointments', { customerId, vehicleId: null, advisorId: userId, concern: 'Scale measure board check', scheduledStart: start, scheduledEnd: end });
}

async function makeScratchDeal(client: Client, index: number): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').toUpperCase();
  const vehicle = await client.must<any>('POST', '/vehicles', { ...vehiclePayload(90000 + index, { status: 'available' }), stockNumber: `SCALE-CALC-${suffix}`, vin: suffix.slice(0, 17) });
  const cust = await client.must<any>('POST', '/customers', customerPayload(90000 + index));
  const deal = await client.must<any>('POST', '/deals', { vehicleId: vehicle.id, customerId: cust.customer.id, leadId: null, type: 'finance' });
  return deal.id;
}

function fmt(v: number | null): string { return v === null ? '—' : v.toFixed(1); }

async function main(): Promise<void> {
  const heavyClient = await clientFor(seedState?.heavy ?? null);
  const session = await heavyClient.must<any>('GET', '/session');
  await ensureTodayAppointment(heavyClient, session.principal.userId);
  const scratchDealIds: string[] = [];
  for (let i = 0; i < Math.min(requestsPer, Math.max(peak, tenX)); i++) scratchDealIds.push(await makeScratchDeal(heavyClient, i));

  const endpoints = getEndpoints();
  const levels: Array<{ name: string; concurrency: number }> = [
    { name: 'peak', concurrency: peak }, { name: '10x', concurrency: tenX },
  ];
  const results: RunResult[] = [];

  for (const level of levels) {
    for (const ep of endpoints) {
      const r = ep.kind === 'pencil'
        ? await runPencil(heavyClient, scratchDealIds, level.name, level.concurrency, requestsPer)
        : await runConcurrent(heavyClient, ep, level.name, level.concurrency, requestsPer);
      results.push(r);
      console.log(`[measure] heavy ${ep.name} @${level.name} (c=${r.concurrency}) n=${r.count} errors=${r.errors} p50=${fmt(r.p50)}ms p95=${fmt(r.p95)}ms budget=${r.budgetMs}ms ${r.pass ? 'PASS' : 'FAIL'}`);
    }
  }

  // Sample light tenants on the GET endpoints only.
  const lightTenants = envToken ? [] : (seedState?.light ?? []).slice(0, lightSample);
  for (const lt of lightTenants) {
    const lc = await clientFor(lt);
    for (const level of levels) {
      for (const ep of endpoints.filter(e => e.method === 'GET')) {
        const r = await runConcurrent(lc, ep, level.name, level.concurrency, requestsPer);
        results.push({ ...r, tenant: lt.label });
        console.log(`[measure] ${lt.label} ${ep.name} @${level.name} n=${r.count} errors=${r.errors} p95=${fmt(r.p95)}ms ${r.pass ? 'PASS' : 'FAIL'}`);
      }
    }
  }

  const failures = results.filter(r => !r.pass);
  const payload = {
    generatedAt: new Date().toISOString(),
    environment: { baseHost: new URL(baseUrl).host, node: process.version, profile: seedState?.profile ?? null, seedCreatedAt: seedState?.createdAt ?? null, truncated: seedState?.truncated ?? null },
    seeded: { heavyProfile: seedState?.heavyProfile ?? null, lightProfile: seedState?.lightProfile ?? null, lightTenantsPlanned: seedState?.lightTenantsPlanned ?? null, heavy: seedState?.heavy ?? null, light: seedState?.light ?? [] },
    setup: { scratchVehicles: scratchDealIds.length, scratchCustomers: scratchDealIds.length, scratchDeals: scratchDealIds.length },
    config: { requestsPerEndpoint: requestsPer, levels },
    budgets: { readMs: budgetMsFor('read'), reportMs: budgetMsFor('report'), pencilMs: budgetMsFor('pencil') },
    results,
    failures: failures.map(f => ({ tenant: f.tenant, endpoint: f.endpoint, level: f.level, budgetMs: f.budgetMs, p95: f.p95, errors: f.errors })),
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');

  const lines: string[] = [
    '# Scale latency report (issue #49)', '',
    `- Generated: ${payload.generatedAt}`,
    `- Environment: base host \`${payload.environment.baseHost}\`, node \`${process.version}\`, local in-memory stack unless a hosted base URL was configured`,
    `- Profile: ${seedState?.profile ?? '(no seed state file)'}; seed created ${seedState?.createdAt ?? 'unknown'}${seedState?.truncated ? ' (TRUNCATED by --maxMinutes)' : ''}`,
    `- Requests per endpoint per level: ${requestsPer}; peak concurrency ${peak}, 10x concurrency ${tenX}`,
    `- Budgets: read p95 < ${budgetMsFor('read')} ms; report p95 < ${budgetMsFor('report')} ms; pencil (write/calc) p95 < ${budgetMsFor('pencil')} ms`,
    '- Percentile: nearest-rank. Non-200 responses count as errors and fail the endpoint.', '',
    '## Dataset actually seeded', '',
    '```json', JSON.stringify(payload.seeded, null, 2), '```', '',
    `Measurement setup adds ${scratchDealIds.length} vehicles, customers and scratch deals on top of the seed counts.`, '',
    '## Results', '',
    '| Tenant | Endpoint | Kind | Level | Concurrency | n | Errors | p50 (ms) | p95 (ms) | Max (ms) | Budget (ms) | Result |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...results.map(r => `| ${r.tenant} | ${r.endpoint} | ${r.kind} | ${r.level} | ${r.concurrency} | ${r.count} | ${r.errors} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${r.budgetMs} | ${r.pass ? 'PASS' : 'FAIL'} |`),
    '',
    '## Budget failures', '',
  ];
  if (failures.length) lines.push(...failures.map(f => `- FAIL ${f.tenant} ${f.endpoint} @${f.level}: budget ${f.budgetMs} ms, measured p95 ${fmt(f.p95)} ms, errors ${f.errors}${Object.keys(f.errorStatuses).length ? ` (${JSON.stringify(f.errorStatuses)})` : ''} — file a follow-up issue; do not fix inline in this harness.`));
  else lines.push('- None. All endpoints met budget with no errors.');
  lines.push('', '## Notes', '',
    '- Pencil calculation is a WRITE path (PUT /deals/:id on harness-created scratch deals), with one deal per concurrent worker to preserve versions; it is reported separately from reads.',
    '- Service board uses today\'s date; the harness ensures at least one appointment for today on the heavy tenant before measuring.',
    '- Full-profile local seeding is a long run: per-write cost on the local in-memory stack grows with tenant size. See docs/scale-test.md.');
  const markdown = lines.join('\n') + '\n';
  if (reportPath) await writeFile(reportPath, markdown);
  console.log(`\n${markdown}`);
  console.log(`[measure] JSON written to ${outPath}${reportPath ? `; report written to ${reportPath}` : ''}`);
}

main().catch((e) => { console.error(`[measure] fatal: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
