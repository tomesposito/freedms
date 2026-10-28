/**
 * Scale seed generator (issue #49). Creates synthetic tenants/records through
 * the HTTP API like a user would. Run:
 *   node --import tsx scripts/scale-seed.ts --profile smoke
 * Local only by default (http://127.0.0.1:3001). Never prints tokens.
 */
import { writeFile } from 'node:fs/promises';
import {
  resolveProfile, overridesFromFlags, stringFlag, intFlag, hasFlag,
  vehiclePayload, customerPayload, leadPayloadForCustomer, partPayload, repairOrderPayload,
  type ScaleProfile, type TenantProfile,
} from './scale-lib.js';

const argv = process.argv.slice(2);
if (hasFlag(argv, 'help')) {
  console.log(`Usage: node --import tsx scripts/scale-seed.ts [options]
  --profile full|smoke        profile (default full)
  --base-url <url>             API base (default $FREEDMS_SCALE_BASE_URL or http://127.0.0.1:3001)
  --state <file>               state output for scale-measure (default scale-state.json; no tokens stored)
  --concurrency <n>            client concurrency (default 1)
  --maxMinutes <n>             soft cap; stop cleanly and still print the actual-count summary
  --heavy-vehicles/--heavy-in-stock/--heavy-leads/--heavy-customers/--heavy-deals/
  --heavy-repair-orders/--heavy-parts/--heavy-appointments <n>
  --light-tenants/--light-vehicles/--light-in-stock/--light-leads/--light-customers/
  --light-deals/--light-repair-orders/--light-parts/--light-appointments <n>`);
  process.exit(0);
}

const baseUrl = (stringFlag(argv, 'base-url') ?? process.env.FREEDMS_SCALE_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const envToken = process.env.FREEDMS_SCALE_TOKEN ?? '';
const profileName = stringFlag(argv, 'profile') ?? 'full';
const profile: ScaleProfile = resolveProfile(profileName, overridesFromFlags(argv));
const concurrency = Math.max(1, intFlag(argv, 'concurrency') ?? 1);
const maxMinutes = intFlag(argv, 'maxMinutes') ?? intFlag(argv, 'max-minutes');
const statePath = stringFlag(argv, 'state') ?? 'scale-state.json';
const deadline = maxMinutes ? Date.now() + maxMinutes * 60000 : Infinity;
const started = Date.now();
let truncated = false;
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

interface TenantState { label: string; tenantId: string; email: string | null; userId: string; counts: Record<string, number> }

class Client {
  token: string;
  constructor(private tenant: { tenantId?: string; email?: string | null }, token: string) { this.token = token; }
  async raw(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
    return { status: res.status, data: json.data ?? json };
  }
  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let r = await this.raw(method, path, body);
    if (r.status === 401 && this.tenant.tenantId && this.tenant.email && !envToken) {
      const s = await this.raw('POST', '/local/session', { tenantId: this.tenant.tenantId, email: this.tenant.email });
      if (s.status === 200 && s.data?.token) { this.token = s.data.token; r = await this.raw(method, path, body); }
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> HTTP ${r.status}`);
    return r.data as T;
  }
}

async function pool<T>(items: readonly T[], workers: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length || 1) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]!, i); }
  }));
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const pastDue = () => Date.now() > deadline;

async function provision(label: string, dealership: string): Promise<{ client: Client; session: any; email: string }> {
  const email = `scale-${label}@example.test`;
  const anon = new Client({}, '');
  const created = await anon.request<any>('POST', '/local/session', {
    onboarding: true, name: 'Scale Admin', email, dealership,
    address: '1 Scale Way', phone: '555-0100', dealerType: 'independent', invites: [],
  });
  const client = new Client({}, created.token);
  const session = await client.request<any>('GET', '/session');
  return { client, session, email };
}

async function seedTenant(label: string, tp: TenantProfile, existing?: Client): Promise<TenantState> {
  const counts: Record<string, number> = { vehicles: 0, vehiclesInStock: 0, customers: 0, leads: 0, followUps: 0, deals: 0, dealsSold: 0, parts: 0, repairOrders: 0, repairOrdersCompleted: 0, appointments: 0 };
  let failures = 0;
  const fail = (what: string, e: unknown) => { failures++; console.error(`[seed] ${label} FAILED ${what}: ${e instanceof Error ? e.message : String(e)}`); };

  let client: Client, tenantId: string, userId: string, email: string | null;
  if (existing) {
    client = existing;
    const session = await client.request<any>('GET', '/session');
    tenantId = session.tenant.id; userId = session.principal.userId; email = session.user?.email ?? null;
  } else {
    const p = await provision(label, `Scale ${label} Dealership`);
    email = p.email;
    tenantId = p.session.tenant.id; userId = p.session.principal.userId;
    // Enable re-session by {tenantId, email} for 401 recovery.
    client = new Client({ tenantId, email }, p.client.token);
  }
  console.log(`[seed] ${label}: tenant seeded as ${tenantId} (profile vehicles=${tp.lifetimeVehicles} leads=${tp.leads} deals=${tp.deals} ros=${tp.repairOrders})`);

  const soldDeals = tp.deals;
  const vehicleIds: string[] = [];
  const stockVehicleIds: string[] = [];
  // Vehicles first. Deal vehicles + stock start available; surplus lifetime
  // vehicles are created directly with status "sold" (vehicle input accepts
  // it; no invented API, no extra PUT per vehicle).
  const vehicleJobs = range(tp.lifetimeVehicles).map(i => ({
    i, status: i < tp.deals + tp.inStock ? 'available' : 'sold',
  }));
  await pool(vehicleJobs, concurrency, async (job) => {
    if (pastDue()) { truncated = true; return; }
    try {
      const v = await client.request<any>('POST', '/vehicles', vehiclePayload(job.i, { status: job.status }));
      vehicleIds[job.i] = v.id; counts.vehicles++;
      if (v.status !== 'sold') counts.vehiclesInStock++;
      if (job.i >= tp.deals && job.i < tp.deals + tp.inStock) stockVehicleIds.push(v.id);
      if (counts.vehicles % 25 === 0 || counts.vehicles === tp.lifetimeVehicles) console.log(`[seed] ${label} vehicles ${counts.vehicles}/${tp.lifetimeVehicles} elapsed ${elapsed()}`);
    } catch (e) { fail(`vehicle ${job.i}`, e); }
  });
  const dealVehicleIds = vehicleIds.slice(0, tp.deals);
  const roVehicleIds = stockVehicleIds.length ? stockVehicleIds : vehicleIds.filter(Boolean);

  // Customer pool (roughly leads/5 distinct customers), reused across records.
  const customerIds: string[] = [];
  await pool(range(tp.customers), concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    try {
      const r = await client.request<any>('POST', '/customers', customerPayload(i));
      customerIds[i] = r.customer.id; counts.customers++;
      if (counts.customers % 25 === 0 || counts.customers === tp.customers) console.log(`[seed] ${label} customers ${counts.customers}/${tp.customers} elapsed ${elapsed()}`);
    } catch (e) { fail(`customer ${i}`, e); }
  });

  // Leads against the customer pool; the first `deals` leads point at deal vehicles.
  const leads: Array<{ id: string; customerId: string; version: number; vehicleId: string | null }> = [];
  await pool(range(tp.leads), concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    const customerId = customerIds[i % Math.max(1, customerIds.length)];
    if (!customerId) { fail(`lead ${i}`, new Error('no customer available')); return; }
    try {
      const vehicleId = i < dealVehicleIds.length ? dealVehicleIds[i]! : (roVehicleIds[i % Math.max(1, roVehicleIds.length)] ?? null);
      const r = await client.request<any>('POST', '/leads', leadPayloadForCustomer(customerId, i, vehicleId));
      leads[i] = { id: r.lead.id, customerId: r.lead.customerId, version: r.lead.version, vehicleId }; counts.leads++;
      if (counts.leads % 25 === 0 || counts.leads === tp.leads) console.log(`[seed] ${label} leads ${counts.leads}/${tp.leads} elapsed ${elapsed()}`);
    } catch (e) { fail(`lead ${i}`, e); }
  });

  // Follow-up activity on a share of leads, plus stage advance on a share.
  const followUpIdx = leads.map((l, i) => (l && i % 5 === 0 ? i : -1)).filter(i => i >= 0);
  await pool(followUpIdx, concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    const lead = leads[i]!;
    try {
      const dueAt = new Date(Date.now() + 86400000).toISOString();
      const r = await client.request<any>('POST', `/leads/${lead.id}/follow-ups`, { version: lead.version, type: 'call', dueAt });
      lead.version = r.version; counts.followUps++;
      if (i % 10 === 0) {
        const adv = await client.request<any>('PUT', `/leads/${lead.id}`, { version: lead.version, stage: 'contacted', assigneeId: userId, vehicleId: lead.vehicleId });
        lead.version = adv.version;
      }
    } catch (e) { fail(`follow-up lead ${i}`, e); }
  });

  // Deals: create (initial pencil), approve, then sell most of them.
  await pool(range(tp.deals), concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    const vehicleId = dealVehicleIds[i];
    const lead = leads[i];
    if (!vehicleId || !lead) { fail(`deal ${i}`, new Error('missing vehicle/lead')); return; }
    try {
      let deal = await client.request<any>('POST', '/deals', { vehicleId, customerId: lead.customerId, leadId: lead.id, type: i % 4 === 3 ? 'cash' : 'finance' });
      counts.deals++;
      if (i < soldDeals) {
        deal = await client.request<any>('PUT', `/deals/${deal.id}`, { version: deal.version, status: 'approved' });
        await client.request<any>('PUT', `/deals/${deal.id}`, { version: deal.version, status: 'sold' });
        counts.dealsSold++; counts.vehiclesInStock--;
      }
      if (counts.deals % 25 === 0 || counts.deals === tp.deals) console.log(`[seed] ${label} deals ${counts.deals}/${tp.deals} elapsed ${elapsed()}`);
    } catch (e) { fail(`deal ${i}`, e); }
  });

  // Parts inventory.
  await pool(range(tp.parts), concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    try { await client.request('POST', '/parts', partPayload(i)); counts.parts++; } catch (e) { fail(`part ${i}`, e); }
  });

  // Repair orders; finalize every second one so GL postings reconcile.
  await pool(range(tp.repairOrders), concurrency, async (i) => {
    if (pastDue()) { truncated = true; return; }
    const customerId = customerIds[i % Math.max(1, customerIds.length)];
    if (!customerId) { fail(`ro ${i}`, new Error('no customer available')); return; }
    try {
      const ro = await client.request<any>('POST', '/service/repair-orders', repairOrderPayload(customerId, roVehicleIds[i % Math.max(1, roVehicleIds.length)] ?? null, userId, i));
      counts.repairOrders++;
      if (i % 2 === 0) {
        await client.request('PUT', `/service/repair-orders/${ro.id}`, { version: ro.version, status: 'completed' });
        counts.repairOrdersCompleted++;
      }
      if (counts.repairOrders % 25 === 0 || counts.repairOrders === tp.repairOrders) console.log(`[seed] ${label} repairOrders ${counts.repairOrders}/${tp.repairOrders} elapsed ${elapsed()}`);
    } catch (e) { fail(`repair-order ${i}`, e); }
  });

  // A few appointments for today so the service board has same-day rows.
  for (let i = 0; i < tp.appointments; i++) {
    if (pastDue()) { truncated = true; break; }
    const customerId = customerIds[i % Math.max(1, customerIds.length)];
    if (!customerId) break;
    const day = new Date().toISOString().slice(0, 10);
    try {
      await client.request('POST', '/service/appointments', {
        customerId, vehicleId: roVehicleIds[i % Math.max(1, roVehicleIds.length)] ?? null, advisorId: userId,
        concern: `Scale appointment ${i + 1}`, scheduledStart: `${day}T14:00:00.000Z`, scheduledEnd: `${day}T15:00:00.000Z`,
      });
      counts.appointments++;
    } catch (e) { fail(`appointment ${i}`, e); }
  }

  if (failures) throw Object.assign(new Error(`${label}: ${failures} create(s) failed`), { counts, tenantId, email, userId });
  return { label, tenantId, email, userId, counts };
}

async function main(): Promise<void> {
  console.log(`[seed] profile=${profile.name} base=${new URL(baseUrl).host} concurrency=${concurrency}${maxMinutes ? ` maxMinutes=${maxMinutes}` : ''}`);
  console.log(`[seed] heavy=${JSON.stringify(profile.heavy)} lightTenants=${profile.lightTenants} light=${JSON.stringify(profile.light)}`);
  const tenants: TenantState[] = [];
  let failed = false;

  const runTenant = async (label: string, tp: TenantProfile, existing?: Client) => {
    try { tenants.push(await seedTenant(label, tp, existing)); }
    catch (e) {
      failed = true;
      const partial = e as Error & { counts?: Record<string, number>; tenantId?: string; email?: string | null; userId?: string };
      console.error(`[seed] ${label}: ${partial.message}`);
      if (partial.tenantId) tenants.push({ label, tenantId: partial.tenantId, email: partial.email ?? null, userId: partial.userId ?? '', counts: partial.counts ?? {} });
    }
  };

  if (envToken) {
    console.log('[seed] FREEDMS_SCALE_TOKEN set: seeding the token tenant as heavy only; light tenants skipped (no /local/session on hosted).');
    await runTenant('heavy', profile.heavy, new Client({}, envToken));
  } else {
    await runTenant('heavy', profile.heavy);
    for (let i = 0; i < profile.lightTenants; i++) {
      if (pastDue()) { truncated = true; console.log(`[seed] maxMinutes reached; stopping before light tenant ${i + 1}`); break; }
      await runTenant(`light-${i + 1}`, profile.light);
    }
  }

  const state = {
    profile: profile.name, baseHost: new URL(baseUrl).host, createdAt: new Date().toISOString(), truncated,
    heavyProfile: profile.heavy, lightProfile: profile.light, lightTenantsPlanned: profile.lightTenants,
    heavy: tenants.find(t => t.label === 'heavy') ?? null,
    light: tenants.filter(t => t.label !== 'heavy'),
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ seeded: state, stateFile: statePath, elapsed: elapsed() }, null, 2));
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`[seed] fatal: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
