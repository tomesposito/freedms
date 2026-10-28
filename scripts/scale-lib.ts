/** Pure helpers for the scale seed + latency harness (issue #49). No I/O here. */

export interface TenantProfile {
  lifetimeVehicles: number;
  inStock: number;
  leads: number;
  customers: number;
  deals: number;
  repairOrders: number;
  parts: number;
  appointments: number;
}

export interface ScaleProfile {
  name: string;
  heavy: TenantProfile;
  lightTenants: number;
  light: TenantProfile;
}

export type ScaleOverrides = Partial<{
  heavyLifetimeVehicles: number; heavyInStock: number; heavyLeads: number; heavyCustomers: number;
  heavyDeals: number; heavyRepairOrders: number; heavyParts: number; heavyAppointments: number;
  lightTenants: number;
  lightLifetimeVehicles: number; lightInStock: number; lightLeads: number; lightCustomers: number;
  lightDeals: number; lightRepairOrders: number; lightParts: number; lightAppointments: number;
}>;

export const FULL_PROFILE: ScaleProfile = {
  name: 'full',
  heavy: { lifetimeVehicles: 10000, inStock: 100, leads: 150000, customers: 30000, deals: 8000, repairOrders: 50000, parts: 250, appointments: 12 },
  lightTenants: 1000,
  light: { lifetimeVehicles: 30, inStock: 28, leads: 200, customers: 40, deals: 2, repairOrders: 200, parts: 20, appointments: 2 },
};

export const SMOKE_PROFILE: ScaleProfile = {
  name: 'smoke',
  heavy: { lifetimeVehicles: 60, inStock: 45, leads: 120, customers: 24, deals: 15, repairOrders: 40, parts: 5, appointments: 3 },
  lightTenants: 3,
  light: { lifetimeVehicles: 10, inStock: 8, leads: 25, customers: 5, deals: 2, repairOrders: 10, parts: 3, appointments: 1 },
};

const cloneTenant = (t: TenantProfile): TenantProfile => ({ ...t });

function checkCount(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer, got ${value}`);
}

function applyTenant(base: TenantProfile, prefix: 'heavy' | 'light', o: ScaleOverrides): TenantProfile {
  const t = cloneTenant(base);
  const get = (key: string) => (o as Record<string, number | undefined>)[`${prefix}${key}`];
  const leadsBefore = t.leads;
  if (get('LifetimeVehicles') !== undefined) t.lifetimeVehicles = get('LifetimeVehicles')!;
  if (get('InStock') !== undefined) t.inStock = get('InStock')!;
  if (get('Leads') !== undefined) t.leads = get('Leads')!;
  if (get('Customers') !== undefined) t.customers = get('Customers')!;
  else if (t.leads !== leadsBefore) t.customers = Math.ceil(t.leads / 5);
  if (get('Deals') !== undefined) t.deals = get('Deals')!;
  if (get('RepairOrders') !== undefined) t.repairOrders = get('RepairOrders')!;
  if (get('Parts') !== undefined) t.parts = get('Parts')!;
  if (get('Appointments') !== undefined) t.appointments = get('Appointments')!;
  for (const [k, v] of Object.entries(t)) checkCount(`${prefix}.${k}`, v);
  if (t.inStock > t.lifetimeVehicles) throw new Error(`${prefix}.inStock (${t.inStock}) cannot exceed lifetimeVehicles (${t.lifetimeVehicles})`);
  if (t.deals > t.lifetimeVehicles - t.inStock) throw new Error(`${prefix}.deals (${t.deals}) cannot exceed lifetimeVehicles minus inStock; each deal sells a distinct vehicle`);
  if (t.deals > t.leads) throw new Error(`${prefix}.deals requires at least as many leads`);
  if ((t.leads || t.repairOrders || t.appointments) && !t.customers) throw new Error(`${prefix}.customers must be positive for leads or service records`);
  return t;
}

/** Resolve a named profile plus per-count overrides into a validated profile. */
export function resolveProfile(name = 'full', overrides: ScaleOverrides = {}): ScaleProfile {
  const base = name === 'full' ? FULL_PROFILE : name === 'smoke' ? SMOKE_PROFILE : undefined;
  if (!base) throw new Error(`Unknown profile "${name}" (expected "full" or "smoke")`);
  const lightTenants = overrides.lightTenants ?? base.lightTenants;
  checkCount('lightTenants', lightTenants);
  return { name, heavy: applyTenant(base.heavy, 'heavy', overrides), lightTenants, light: applyTenant(base.light, 'light', overrides) };
}

/** Nearest-rank percentile. Returns null for empty input. p in (0, 100]. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new Error(`percentile p must be in (0, 100], got ${p}`);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface LatencySummary { count: number; min: number | null; max: number | null; mean: number | null; p50: number | null; p95: number | null }

export function summarize(values: readonly number[]): LatencySummary {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

export type EndpointKind = 'read' | 'report' | 'pencil';

export function budgetMsFor(kind: EndpointKind): number {
  return kind === 'report' ? 1000 : 300;
}

export interface BudgetResult { budgetMs: number; p95: number | null; pass: boolean }

export function evaluateBudget(kind: EndpointKind, p95: number | null): BudgetResult {
  const budgetMs = budgetMsFor(kind);
  return { budgetMs, p95, pass: p95 !== null && p95 < budgetMs };
}

/** Synthetic VIN: 12-char prefix + 5-digit serial = 17 chars, no I/O/Q. */
export function generateVin(serial: number): string {
  if (!Number.isSafeInteger(serial) || serial < 0) throw new Error(`VIN serial must be a non-negative integer, got ${serial}`);
  return `1HGCM82633AA${String(serial % 100000).padStart(5, '0')}`;
}

export function isValidVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

const MAKES: ReadonlyArray<readonly [string, string]> = [
  ['Toyota', 'Camry'], ['Honda', 'Accord'], ['Ford', 'F-150'], ['Mazda', 'CX-5'],
  ['Subaru', 'Outback'], ['Hyundai', 'Elantra'], ['Nissan', 'Altima'], ['Jeep', 'Wrangler'],
];
const SOURCES = ['walk-in', 'phone', 'website', 'marketplace', 'referral', 'other'] as const;
const pad = (n: number, w = 6) => String(n).padStart(w, '0');

export function vehiclePayload(index: number, options: { status?: string; dateStocked?: string } = {}) {
  const [make, model] = MAKES[index % MAKES.length]!;
  const listPrice = 1500000 + (index % 40) * 25000;
  return {
    mileage: 1000 + (index * 137) % 90000,
    stockNumber: `SCALE-${pad(index + 1)}`,
    vin: generateVin(index + 1),
    year: 2018 + (index % 8),
    make, model, trim: 'Scale',
    status: options.status ?? 'available',
    listPrice, cost: Math.round(listPrice * 0.82),
    reconCosts: [{ description: 'Scale inspection', amount: 15000 }],
    dateStocked: options.dateStocked ?? '2024-01-15',
    location: 'Scale lot',
    notes: 'Synthetic scale-test vehicle. No real data.',
  };
}

export function customerPayload(index: number) {
  return {
    name: `Scale Buyer ${pad(index + 1)}`,
    email: `scale-buyer-${index + 1}@example.test`,
    phone: '', address: '',
    notes: 'Synthetic scale-test customer. No real data.',
    consent: { status: 'unknown', timestamp: null, source: '' },
  };
}

export function leadPayloadForCustomer(customerId: string, index: number, vehicleId?: string | null) {
  return { customerId, source: SOURCES[index % SOURCES.length], ...(vehicleId ? { vehicleId } : {}) };
}

export function leadPayloadWithCustomer(index: number, vehicleId?: string | null) {
  return { customer: customerPayload(index), source: SOURCES[index % SOURCES.length], ...(vehicleId ? { vehicleId } : {}) };
}

export function partPayload(index: number) {
  return {
    partNumber: `SCALE-PART-${pad(index + 1, 5)}`,
    description: `Scale part ${index + 1}`,
    costCents: 500 + (index % 20) * 100,
    retailPriceCents: 1200 + (index % 20) * 250,
    quantityOnHand: 25, binLocation: 'SCALE-A1', reorderPoint: 5,
  };
}

export function repairOrderPayload(customerId: string, vehicleId: string | null, advisorId: string | null, index: number) {
  return {
    customerId, vehicleId, advisorId,
    concern: `Scale service concern ${index + 1}`,
    payType: 'customer-pay',
    lineItems: [
      { id: `scale-labor-${index + 1}`, kind: 'labor', description: 'Scale labor', laborHoursHundredths: 100, laborRateCents: 12000, quantity: null, unitPriceCents: null },
      { id: `scale-parts-${index + 1}`, kind: 'parts', description: 'Scale parts', laborHoursHundredths: null, laborRateCents: null, quantity: 1, unitPriceCents: 2500 },
    ],
  };
}

/** Read a `--flag value` / `--flag=value` string flag. */
export function stringFlag(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some(a => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** Read an integer flag; throws on a non-integer value. */
export function intFlag(argv: readonly string[], name: string): number | undefined {
  const raw = stringFlag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be an integer, got "${raw}"`);
  return n;
}

/** Map CLI override flags (e.g. --heavy-leads) to ScaleOverrides. */
export function overridesFromFlags(argv: readonly string[]): ScaleOverrides {
  const map: Record<string, keyof ScaleOverrides> = {
    'heavy-vehicles': 'heavyLifetimeVehicles', 'heavy-lifetime-vehicles': 'heavyLifetimeVehicles',
    'heavy-in-stock': 'heavyInStock', 'heavy-leads': 'heavyLeads', 'heavy-customers': 'heavyCustomers',
    'heavy-deals': 'heavyDeals', 'heavy-repair-orders': 'heavyRepairOrders', 'heavy-ros': 'heavyRepairOrders',
    'heavy-parts': 'heavyParts', 'heavy-appointments': 'heavyAppointments',
    'light-tenants': 'lightTenants',
    'light-vehicles': 'lightLifetimeVehicles', 'light-lifetime-vehicles': 'lightLifetimeVehicles',
    'light-in-stock': 'lightInStock', 'light-leads': 'lightLeads', 'light-customers': 'lightCustomers',
    'light-deals': 'lightDeals', 'light-repair-orders': 'lightRepairOrders', 'light-ros': 'lightRepairOrders',
    'light-parts': 'lightParts', 'light-appointments': 'lightAppointments',
  };
  const out: ScaleOverrides = {};
  for (const [flag, key] of Object.entries(map)) {
    const v = intFlag(argv, flag);
    if (v !== undefined) (out as Record<string, number>)[key] = v;
  }
  return out;
}
