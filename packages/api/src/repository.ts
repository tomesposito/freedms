import { debitNormal, type AccountBalance } from '@freedms/shared';
import { leadStages, leadSources, type LeadReport } from '@freedms/shared';
import type { MfaRecord } from '@freedms/shared';
import type { WebhookEndpoint, WebhookDelivery } from '@freedms/shared';
import type { FeedConfig, FeedRun } from '@freedms/shared';
import type { InventoryImport, AnalyticsRecord, QuickEntryUsage } from '@freedms/shared';
import type { CrmEntity, Deal, Lead, Customer, ServiceAppointment, RepairOrder, SignatureRecord, Technician, Part } from '@freedms/shared';
import type { Membership, OutboxEvent, Tenant, User, Vehicle, VehicleStatus } from '@freedms/shared';
export interface VehicleQuery { status?: VehicleStatus; search?: string }
export interface LeadQuery { search?: string; stage?: Lead['stage']; assignee?: string | null; limit: number; offset: number }
export interface LeadPage { leads: Lead[]; customers: Customer[]; total: number }
/** An instance is permanently bound to ONE tenant; no method accepts an alternate tenant. */
export interface TenantRepository {
  acceptInvite(invite: import('@freedms/shared').Invite, user: User, now: Date): Promise<'accepted' | 'already-member'>;
  workspaceUsers(): Promise<import('@freedms/shared').WorkspaceUser[]>;
  saveMember(user: User, membership: Membership, expectedVersion: number, event: OutboxEvent): Promise<void>;
  mfa(userId: string): Promise<MfaRecord | undefined>;
  saveMfa(record: MfaRecord, expectedVersion: number, event: OutboxEvent): Promise<void>;
  webhookEndpoints(): Promise<WebhookEndpoint[]>;
  webhookEndpoint(id: string): Promise<WebhookEndpoint | undefined>;
  saveWebhookEndpoint(record: WebhookEndpoint, expectedVersion: number, event: OutboxEvent): Promise<void>;
  webhookDeliveries(): Promise<WebhookDelivery[]>;
  saveWebhookDelivery(record: WebhookDelivery): Promise<void>;
  feedConfig(): Promise<FeedConfig | undefined>;
  saveFeedConfig(record: FeedConfig, expectedVersion: number, event: OutboxEvent): Promise<void>;
  appendFeedRun(record: FeedRun, event: OutboxEvent): Promise<void>;
  feedRuns(): Promise<FeedRun[]>;
  feedRun(id: string): Promise<FeedRun | undefined>;
  appendImport(record: InventoryImport, event: OutboxEvent): Promise<void>;
  imports(): Promise<InventoryImport[]>;
  events(): Promise<OutboxEvent[]>;
  appendAnalytics(record: AnalyticsRecord): Promise<void>;
  analytics(): Promise<AnalyticsRecord[]>;
  appendUsage(usage: QuickEntryUsage): Promise<void>;
  usageForTest(): Promise<QuickEntryUsage[]>;
  users(): Promise<User[]>;
  serviceBoardEpoch(): Promise<number>;
  serviceBoard(day: string): Promise<ServiceBoardRows>;
  accountingBalances(range: SalesReportRange): Promise<AccountBalance[]>;
  inventoryReportRows(): Promise<Vehicle[]>;
  forecastRows(window: ForecastWindow): Promise<ForecastRows>;
  salesReportRows(range: SalesReportRange): Promise<SalesReportRows>;
  leadSummary(): Promise<LeadReport>;
  leadListPage(query: LeadQuery): Promise<LeadPage>;
  crmList<K extends CrmEntity['kind']>(kind: K): Promise<Extract<CrmEntity, {kind: K}>[]>;
  crmGet<K extends CrmEntity['kind']>(kind: K, id: string): Promise<Extract<CrmEntity, {kind: K}> | undefined>;
  crmWrite(writes: CrmWrite[], vehicles?: VehicleWrite[]): Promise<void>;
  membership(userId: string): Promise<Membership | undefined>;
  tenant(): Promise<Tenant | undefined>;
  list(query: VehicleQuery): Promise<Vehicle[]>;
  listPage(query: VehicleQuery & {limit: number; offset: number}): Promise<{vehicles: Vehicle[]; total: number}>;
  get(id: string): Promise<Vehicle | undefined>;
  create(vehicle: Vehicle, event: OutboxEvent): Promise<void>;
  update(vehicle: Vehicle, expectedVersion: number, event: OutboxEvent): Promise<void>;
  delete(id: string, expectedVersion: number, event: OutboxEvent): Promise<void>;
  provision(tenant: Tenant, user: User, membership: Membership, event: OutboxEvent, acceptance?: CrmWrite): Promise<void>;
}
export interface RepositoryFactory { tenantForSubject?(subject: string): Promise<string | undefined>; forTenant(tenantId: string): TenantRepository }
export function matches(vehicle: Vehicle, query: VehicleQuery): boolean {
  return (!query.status || vehicle.status === query.status) && (!query.search ||
    [vehicle.stockNumber, vehicle.vin, vehicle.make, vehicle.model, vehicle.trim, vehicle.location]
      .join(' ').toLowerCase().includes(query.search.toLowerCase()));
}
export function assertScope(tenantId: string, ...rows: {tenantId: string}[]): void {
  if (rows.some(row => row.tenantId !== tenantId)) throw new Error('Repository tenant scope violation');
}
export function assertEvent(vehicleId: string, version: number, event: OutboxEvent, type: OutboxEvent['type']): void {
  if (event.aggregateId !== vehicleId || event.aggregateVersion !== version || event.type !== type) throw new Error('Invalid outbox event');
}

export const serviceBoardKinds = new Set<CrmEntity['kind']>(['service-appointment', 'repair-order', 'signature', 'technician']);

export interface CrmWrite { record: CrmEntity; expectedVersion: number; event: OutboxEvent }
export function assertCrmWrites(tenantId: string, writes: CrmWrite[]): void {
  const keys = new Set<string>(); const events = new Set<string>();
  // Allow reservation reconciliation alongside the existing ten business records.
  // 39 paired rows/events leave room for part-number guards and a vehicle pair.
  if (!writes.length || writes.length > 39 || writes.filter(w=>w.record.kind!=='parts-reservation').length > 10) throw new Error('Invalid CRM transaction');
  for (const {record, expectedVersion, event} of writes) {
    assertScope(tenantId, record, event);
    if (['terms-acceptance', 'signature', 'parts-return', 'parts-sale', 'compliance-check', 'journal-entry', 'payoff-quote', 'share-response'].includes(record.kind) && expectedVersion !== 0) throw new Error('Signatures, parts sales, journal entries, payoff quotes, share responses and compliance checks are immutable');
    assertEvent(record.id, expectedVersion + 1, event, record.kind === 'terms-acceptance' ? 'terms-acceptance.created' : record.kind === 'signature' ? 'signature.created' : record.kind === 'parts-return' ? 'parts-return.created' : record.kind === 'parts-sale' ? 'parts-sale.created' : record.kind === 'compliance-check' ? 'compliance-check.created' : record.kind === 'share-response' ? 'share-response.created' : record.kind === 'payoff-quote' ? 'payoff-quote.created' : record.kind === 'journal-entry' ? 'journal-entry.created' : record.kind === 'document' && record.status === 'disposed' ? 'document.disposed' : `${record.kind}.${expectedVersion ? 'updated' : 'created'}`);
    if (record.version !== expectedVersion + 1 || expectedVersion < 0 || !Number.isInteger(expectedVersion)) throw new Error('Invalid CRM version');
    const key = `${record.kind}#${record.id}`;
    if (keys.has(key) || events.has(event.id)) throw new Error('Duplicate CRM transaction item');
    keys.add(key); events.add(event.id);
  }
}

export interface VehicleWrite { record: Vehicle; expectedVersion: number; event: OutboxEvent }
export function assertVehicleWrites(tenantId: string, writes: VehicleWrite[], crm: CrmWrite[]): void {
  const ids = new Set<string>(); const events = new Set(crm.map(w => w.event.id));
  if (writes.length > 1) throw new Error('Invalid vehicle transaction');
  for (const {record, expectedVersion, event} of writes) {
    assertScope(tenantId, record, event);
    assertEvent(record.id, expectedVersion + 1, event, 'vehicle.updated');
    if (record.version !== expectedVersion + 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || ids.has(record.id) || events.has(event.id)) throw new Error('Invalid vehicle transaction');
    ids.add(record.id); events.add(event.id);
  }
}

export function assertFeedConfig(tenantId: string, record: FeedConfig, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  assertEvent(record.id, record.version, event, 'feed.configured');
  if (record.id !== 'feed-config' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid feed config version');
}

export function assertWebhookEndpoint(tenantId: string, record: WebhookEndpoint, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  assertEvent(record.id, record.version, event, expectedVersion ? 'webhook.updated' : 'webhook.created');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid webhook endpoint version');
}

export function assertMfa(tenantId: string, record: MfaRecord, expectedVersion: number, event: OutboxEvent): void {
  assertScope(tenantId, record, event);
  if (!['mfa.setup', 'mfa.enabled', 'mfa.disabled', 'mfa.reset', 'mfa.recovery_regenerated', 'mfa.verified'].includes(event.type)) throw new Error('Invalid MFA outbox event');
  assertEvent(record.userId, record.version, event, event.type);
  if (record.id !== record.userId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || record.version !== expectedVersion + 1) throw new Error('Invalid MFA version');
}

export function vehiclePage(vehicles: Vehicle[], {limit, offset}: {limit: number; offset: number}): {vehicles: Vehicle[]; total: number} {
  // UTC ISO timestamps and UUIDs sort lexicographically; avoid localeCompare overhead on this hot path.
  const compare = (a: Vehicle, b: Vehicle): number => a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const total = vehicles.length;
  if (offset >= total) return {vehicles: [], total};
  const end = Math.min(offset + limit, total);
  // Keep only the first offset + limit rows in a max heap, with the latest-sorting row at the root.
  // Deep pages use the full sort when retaining a heap would offer little benefit.
  if (end < total / 2) {
    // Scan recent insertions first: they usually already contain the newest page.
    const heap = vehicles.slice(total - end);
    const siftDown = (start: number): void => {
      let parent = start;
      while (parent * 2 + 1 < heap.length) {
        let child = parent * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        parent = child;
      }
    };
    for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) siftDown(i);
    for (let i = total - end - 1; i >= 0; i--) {
      if (compare(vehicles[i], heap[0]) < 0) {
        heap[0] = vehicles[i];
        siftDown(0);
      }
    }
    heap.sort(compare);
    return {vehicles: heap.slice(offset), total};
  }
  vehicles.sort(compare);
  return {vehicles: vehicles.slice(offset, end), total};
}

/** Join raw references and retain only the first offset + limit matches. Callers clone the page. */
export function leadPage(rows: Iterable<CrmEntity>, customers: Map<string, Customer>, query: LeadQuery): LeadPage {
  const compare = (a: Lead, b: Lead): number => a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const heap: Lead[] = []; let total = 0;
  const end = query.offset + query.limit, search = (query.search ?? '').toLowerCase();
  const siftDown = (start: number): void => {
    let parent = start;
    while (parent * 2 + 1 < heap.length) {
      let child = parent * 2 + 1;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
      if (compare(heap[parent], heap[child]) >= 0) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]]; parent = child;
    }
  };
  for (const lead of rows) {
    if (lead.kind !== 'lead') continue;
    const customer = customers.get(lead.customerId);
    // Orphan leads cannot form a LeadView; exclude them without inventing a customer.
    if (!customer || (query.stage && lead.stage !== query.stage) ||
      (query.assignee !== undefined && lead.assigneeId !== query.assignee) ||
      (search && ![customer.name, customer.email, customer.phone, lead.source, lead.vehicleDescription].join(' ').toLowerCase().includes(search))) continue;
    total++;
    if (heap.length < end) {
      heap.push(lead);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]]; child = parent;
      }
    } else if (compare(lead, heap[0]) < 0) { heap[0] = lead; siftDown(0); }
  }
  const leads = heap.sort(compare).slice(query.offset);
  return {leads, customers: leads.map(lead => customers.get(lead.customerId)!), total};
}

/** Count raw rows once; an optional accumulator lets query pages be discarded immediately. */
export function countLeads(rows: Iterable<CrmEntity>, summary: LeadReport = {
  byStage: leadStages.map(stage => ({stage, count: 0})),
  bySource: leadSources.map(source => ({source, count: 0})), total: 0
}): LeadReport {
  const stages = new Map(summary.byStage.map(row => [row.stage, row]));
  const sources = new Map(summary.bySource.map(row => [row.source, row]));
  for (const lead of rows) {
    if (lead.kind !== 'lead') continue;
    summary.total++;
    const stage = stages.get(lead.stage), source = sources.get(lead.source);
    if (stage) stage.count++;
    if (source) source.count++;
  }
  return summary;
}

export interface ServiceBoardRows {
  appointments: ServiceAppointment[];
  repairOrders: RepairOrder[];
  signatures: SignatureRecord[];
  technicians: Technician[];
}

/** Select raw references in input order; callers clone only the returned rows if needed.
 * Ordered pages must supply all appointments, then ROs, then signatures, so unmatched
 * rows can be discarded immediately. Unordered memory rows resolve links at finish.
 */
export function serviceBoardSelection(day: string, ordered = false) {
  const board: ServiceBoardRows = {appointments: [], repairOrders: [], signatures: [], technicians: []};
  const appointmentIds = new Set<string>(), repairOrderIds = new Set<string>();
  const matchesOrder = (r: RepairOrder) => r.createdAt.slice(0, 10) === day || !!(r.appointmentId && appointmentIds.has(r.appointmentId));
  const matchesSignature = (s: SignatureRecord) => s.targetType === 'repair-order' && !!(s.repairOrderId && repairOrderIds.has(s.repairOrderId));
  return {
    add(rows: Iterable<CrmEntity>) {
      for (const row of rows) {
        if (row.kind === 'service-appointment' && row.scheduledStart.slice(0, 10) === day) {
          board.appointments.push(row); appointmentIds.add(row.id);
        } else if (row.kind === 'repair-order' && (ordered ? matchesOrder(row) : row.createdAt.slice(0, 10) === day || !!row.appointmentId)) {
          board.repairOrders.push(row); repairOrderIds.add(row.id);
        } else if (row.kind === 'signature' && (ordered ? matchesSignature(row) : row.targetType === 'repair-order')) {
          board.signatures.push(row);
        } else if (row.kind === 'technician') board.technicians.push(row);
      }
    },
    finish(): ServiceBoardRows {
      if (!ordered) {
        board.repairOrders = board.repairOrders.filter(matchesOrder);
        repairOrderIds.clear();
        for (const row of board.repairOrders) repairOrderIds.add(row.id);
        board.signatures = board.signatures.filter(matchesSignature);
      }
      return board;
    }
  };
}

export interface SalesReportRange { from: string | null; to: string | null }
export interface SalesReportRows { deals: Deal[]; vehicles: Vehicle[]; customers: Customer[] }

export function soldDate(deal: Deal): string {
  const timestamp = [...deal.history].reverse().find(h => h.status === 'sold')?.timestamp ?? deal.updatedAt;
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Retain only sold deals in the inclusive UTC date range, in input order. */
export function salesReportSelection(range: SalesReportRange) {
  const deals: Deal[] = [], vehicleIds = new Set<string>(), customerIds = new Set<string>();
  return {
    deals, vehicleIds, customerIds,
    add(rows: Iterable<CrmEntity>) {
      for (const deal of rows) {
        if (deal.kind !== 'deal' || deal.status !== 'sold') continue;
        const date = soldDate(deal);
        if ((range.from && date < range.from) || (range.to && date > range.to)) continue;
        deals.push(deal); vehicleIds.add(deal.vehicleId); customerIds.add(deal.customerId);
      }
    }
  };
}

export interface ForecastWindow { from: string; to: string }
export interface ForecastRows {
  currentStock: number;
  soldDates: string[];
  scheduledStarts: string[];
  parts: Part[];
  usage: {partId: string; quantity: number}[];
}

/** Reduce raw rows once; retain no vehicle or historical CRM records except catalog parts. */
export function forecastSelection(window: ForecastWindow) {
  const rows: ForecastRows = {currentStock: 0, soldDates: [], scheduledStarts: [], parts: [], usage: []};
  const within = (date: string) => date.slice(0, 10) >= window.from && date.slice(0, 10) <= window.to;
  // Preserve counter-sale then RO usage order, regardless of memory insertion order.
  const roUsage: ForecastRows['usage'] = [];
  return {
    addVehicles(vehicles: Iterable<Vehicle>) {
      for (const vehicle of vehicles) if (vehicle.status !== 'sold') rows.currentStock++;
    },
    add(records: Iterable<CrmEntity>) {
      for (const row of records) {
        if (row.kind === 'deal' && row.status === 'sold') {
          const date = soldDate(row);
          if (within(date)) rows.soldDates.push(date);
        } else if (row.kind === 'service-appointment' && within(row.scheduledStart) && row.status !== 'no-show') {
          rows.scheduledStarts.push(row.scheduledStart);
        } else if (row.kind === 'part') rows.parts.push(row);
        else if (row.kind === 'parts-sale' && within(row.createdAt)) rows.usage.push({partId: row.partId, quantity: row.quantity});
        else if (row.kind === 'repair-order' && row.stockApplied && within(row.createdAt)) {
          for (const line of row.lineItems) if (line.kind === 'parts' && line.partId) roUsage.push({partId: line.partId, quantity: line.quantity!});
        }
      }
    },
    finish(): ForecastRows { return {...rows, usage: [...rows.usage, ...roUsage]}; }
  };
}

/** Retain account metadata and cent totals only; each journal line is visited once. */
export function accountingBalanceSelection(range: SalesReportRange) {
  const accounts: AccountBalance[] = [];
  const sums = new Map<string, {debit: number; credit: number}>();
  return {
    add(rows: Iterable<CrmEntity>) {
      for (const row of rows) {
        if (row.kind === 'gl-account') accounts.push({accountId: row.id, code: row.code, name: row.name, type: row.type, debit: 0, credit: 0, balance: 0});
        if (row.kind !== 'journal-entry') continue;
        const day = row.date.slice(0, 10);
        if ((range.from && day < range.from) || (range.to && day > range.to)) continue;
        for (const line of row.lines) {
          const sum = sums.get(line.accountId) ?? {debit: 0, credit: 0};
          sum.debit += line.debit; sum.credit += line.credit;
          sums.set(line.accountId, sum);
        }
      }
    },
    finish(): AccountBalance[] {
      return accounts.sort((a, b) => a.code.localeCompare(b.code)).map(account => {
        const {debit, credit} = sums.get(account.accountId) ?? {debit: 0, credit: 0};
        return {...account, debit, credit, balance: debitNormal(account.type) ? debit - credit : credit - debit};
      });
    }
  };
}
