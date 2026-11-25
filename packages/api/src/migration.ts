import { createHash, randomUUID } from 'node:crypto';
import {
  defaultLeaseTerms, inventoryCsvHeaders, migrationBatchLimit, migrationEntities,
  type Customer, type Deal, type Lead, type MigrationColumn, type MigrationEntity, type MigrationImport,
  type MigrationPreview, type MigrationRow, type MigrationTotals, type OutboxEvent, type Principal
} from '@freedms/shared';
import { choice, customerInput, normalizedPhone, source, stage } from './crm-validation.js';
import { ApiError, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { IMPORT_BODY_LIMIT, parseImportCsv, previewInventory } from './import.js';
import type { MigrationRecord, TenantRepository } from './repository.js';
import { dollarCents, invalid, object, onlyKeys, text, vin } from './validation.js';
import type { VinDecoder } from './vin.js';

const hash = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');
const customerReferences = {customerSourceId: ['customer id', 'buyer id', 'contact id'], customerEmail: ['email', 'buyer email'], customerPhone: ['phone', 'buyer phone']};
const vehicleReferences = {vin: ['vehicle vin'], stockNumber: ['stock #', 'stock', 'unit number']};
const aliases: Record<MigrationEntity, Record<string, string[]>> = {
  inventory: {
    ...Object.fromEntries([...new Set(Object.values(inventoryCsvHeaders))].map(field => [field,
      Object.keys(inventoryCsvHeaders).filter(alias => inventoryCsvHeaders[alias] === field)])),
    dateStocked: ['inventory date', 'stock date', 'date acquired'],
  },
  customers: {sourceId: ['id', 'customer id', 'contact id'], name: ['customer name', 'full name'], firstName: ['given name'], lastName: ['surname', 'family name'],
    phone: ['phone number', 'mobile', 'cell phone'], email: ['email address'], address: ['street address', 'mailing address'], notes: ['comments']},
  leads: {sourceId: ['id', 'lead id', 'prospect id'], ...customerReferences, ...vehicleReferences,
    vehicleDescription: ['vehicle interest', 'vehicle'], source: ['lead source'], sourceDetail: ['source detail', 'notes'], stage: ['lead stage', 'pipeline stage', 'status']},
  deals: {sourceId: ['id', 'deal id', 'deal number'], ...customerReferences, ...vehicleReferences,
    leadSourceId: ['lead id'], type: ['deal type'], status: ['deal status'], amount: ['selling price', 'sale price', 'deal amount', 'deal total', 'total amount']},
};

function mapping(entity: MigrationEntity, headers: string[], supplied: unknown): MigrationColumn[] {
  const fields = aliases[entity];
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length !== headers.length ||
      supplied.some(field => field !== null && (typeof field !== 'string' || !Object.hasOwn(fields, field)))) {
      throw invalid('Choose a migration field or skip for every CSV column.');
    }
    const selected = supplied.filter(field => field !== null);
    if (selected.length !== new Set(selected).size) throw invalid('Map each migration field at most once.');
    return headers.map((header, index) => ({header, field: supplied[index], ...(supplied[index] === null ? {issue: 'Unmapped'} : {})}));
  }
  const candidates = headers.map(header => Object.entries(fields).filter(([field, names]) =>
    [field, ...names].some(name => headerKey(name) === headerKey(header))).map(([field]) => field));
  const occurrences = new Map<string, number>();
  for (const matches of candidates) for (const field of matches) occurrences.set(field, (occurrences.get(field) ?? 0) + 1);
  return headers.map((header, index) => {
    const matches = candidates[index];
    if (!matches.length) return {header, field: null, issue: 'Unmapped'};
    if (matches.length !== 1 || occurrences.get(matches[0]) !== 1) {
      return {header, field: null, issue: 'Ambiguous'};
    }
    return {header, field: matches[0]};
  });
}

function totals(entity: MigrationEntity, value: unknown): MigrationTotals {
  const expected = object(value);
  const hasAmount = entity === 'inventory' || entity === 'deals';
  onlyKeys(expected, hasAmount ? ['count', 'amountCents'] : ['count']);
  const read = (value: unknown, label: string) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(`Enter a nonnegative integer for ${label}.`);
    return value;
  };
  return {count: read(expected.count, 'expected count'), ...(hasAmount ? {amountCents: read(expected.amountCents, 'expected cents')} : {})};
}

function normalizeDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : value;
}

function change(row: MigrationRow, field: string, before: string, after: string | number, reason: string) {
  if (before !== String(after) || typeof after === 'number') row.changes.push({field, before, after: String(after), reason});
}

function auditVehicle(row: MigrationRow, raw: Record<string, string>, values: Record<string, unknown>) {
  const reasons: Record<string, string> = {
    vin: 'Uppercased VIN', stockNumber: 'Generated or trimmed stock number',
    dateStocked: 'Converted to ISO date or used the import date',
    cost: 'Converted dollars to cents', listPrice: 'Converted dollars to cents',
    year: 'Converted model year to a number or filled it from the VIN', mileage: 'Converted odometer reading to miles',
    status: 'Standardized inventory status', make: 'Trimmed text or filled it from the VIN',
    model: 'Trimmed text or filled it from the VIN', trim: 'Trimmed text or filled it from the VIN'
  };
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    row.values[field] = value;
    change(row, field, raw[field] ?? '', value, reasons[field] ?? 'Trimmed whitespace');
  }
}

function matchOne<T extends {id: string}>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const matches = items.filter(predicate);
  if (matches.length !== 1) throw invalid(matches.length ? `Ambiguous ${label} in this workspace.` : `No matching ${label} in this workspace.`);
  return matches[0];
}

function phone(value: string): string {
  if (!/^[+\d().\s-]+$/.test(value) || !/^\d{7,15}$/.test(normalizedPhone(value))) throw invalid('Enter a phone number with 7 to 15 digits.');
  return normalizedPhone(value);
}

const sourceRecordId = (entity: MigrationEntity, sourceId: string) => hash('migration-source', entity, sourceId);

async function prepare(entity: MigrationEntity, body: Record<string, unknown>, principal: Principal, repo: TenantRepository, now: Date, decoder: VinDecoder) {
  if (typeof body.csv !== 'string' || (body.enrich !== undefined && typeof body.enrich !== 'boolean')) throw invalid('Provide CSV text and an optional VIN enrichment flag.');
  const parsed = parseImportCsv(body.csv);
  const [headers, ...data] = parsed;
  if (data.some(cells => cells.length !== headers.length)) throw invalid('CSV rows must have the same number of fields as the header.');
  if (data.length > migrationBatchLimit) throw invalid(`Each migration CSV can have up to ${migrationBatchLimit} rows. Split larger exports and supply expected totals for each file.`);
  const columns = mapping(entity, headers, body.mapping);
  const expected = totals(entity, body.expected);
  const fileId = hash(entity, parsed);
  const receiptId = (approval: string) => hash(fileId, columns, expected, body.enrich === true, approval);
  if (typeof body.approval === 'string') {
    const previous = await repo.migrationReport(receiptId(body.approval));
    if (previous) {
      if (previous.actorId !== principal.userId) throw missing();
      return {previous};
    }
  }
  const version = await repo.migrationVersion();
  const raws = data.map(cells => Object.fromEntries(columns.flatMap(({field}, index) => field ? [[field, cells[index]]] : [])));
  const rows: MigrationRow[] = raws.map((_, index) => ({rowNumber: index + 1, status: 'ready', reasons: [], changes: [], values: {}}));
  const records: MigrationRecord[] = [];
  const stamp = now.toISOString();
  const base = (recordId: string) => ({id: recordId, tenantId: principal.tenantId, version: 1, createdAt: stamp, updatedAt: stamp});
  const actual: MigrationTotals = {count: 0, ...(entity === 'inventory' || entity === 'deals' ? {amountCents: 0} : {})};
  if (entity === 'inventory') {
    const preview = await previewInventory(parsed, body.enrich === true, repo, now, decoder, {
      columns: columns.map(column => column.field), normalizeDate,
      audit: (index, values) => auditVehicle(rows[index], raws[index], values)
    });
    for (const [index, result] of preview.rows.entries()) {
      const row = rows[index];
      row.reasons.push(...result.errors.map(error => `${error.field}: ${error.message}`), ...(result.warnings ?? []));
      if (result.duplicate) row.reasons.push(result.duplicate.reason);
      if (result.status !== 'valid' || !result.vehicle) { row.status = 'skipped'; continue; }
      row.recordId = hash(fileId, row.rowNumber);
      records.push({...base(row.recordId), ...result.vehicle});
      actual.amountCents! += result.vehicle.cost;
    }
  } else {
    const [customers, vehicles, leads, deals] = await Promise.all([
      repo.crmList('customer'), entity === 'customers' ? [] : repo.list({}),
      entity === 'customers' ? [] : repo.crmList('lead'), entity === 'deals' ? repo.crmList('deal') : []
    ]);
    const usedIds = new Set((entity === 'customers' ? customers : entity === 'leads' ? leads : deals).map(record => record.id));
    for (const [index, raw] of raws.entries()) {
      const row = rows[index];
      const field = (name: string, normalize = (value: string) => value, reason = 'Trimmed whitespace') => {
        const original = raw[name] ?? '';
        const value = normalize(original.trim());
        if (Object.hasOwn(raw, name) || value) row.values[name] = value;
        change(row, name, original, value, reason);
        return value;
      };
      const sourceId = field('sourceId');
      const recordId = sourceId ? sourceRecordId(entity, sourceId) : hash(fileId, row.rowNumber);
      try {
        if (usedIds.has(recordId)) throw invalid('Source ID already exists in this workspace or file.');
        if (entity === 'customers') {
          const name = field('name'), first = field('firstName'), last = field('lastName');
          const combined = [first, last].filter(Boolean).join(' ');
          if (name && combined && name !== combined) throw invalid('Full name and name parts disagree. Choose one mapping.');
          if (!name && combined) {
            row.values.name = combined;
            change(row, 'name', '', combined, 'Combined first and last name');
          }
          const input = customerInput({name: name || combined,
            phone: field('phone', value => value ? phone(value) : '', 'Normalized phone number'),
            email: field('email', value => value.toLowerCase(), 'Lowercased email address'),
            address: field('address'), notes: field('notes'), consent: {status: 'unknown', timestamp: null, source: ''}});
          records.push({...base(recordId), kind: 'customer', ...input});
          customers.push(records.at(-1) as Customer);
        } else {
          const customerId = field('customerSourceId'), email = field('customerEmail', value => value.toLowerCase(), 'Lowercased email address');
          const number = field('customerPhone', value => value ? phone(value) : '', 'Normalized phone number');
          if (!customerId && !email && !number) throw invalid('Map a customer ID, email or phone to link this row to an imported or existing customer.');
          const customer = matchOne(customers, item => (!customerId || item.id === sourceRecordId('customers', customerId)) &&
            (!email || item.email.toLowerCase() === email) && (!number || normalizedPhone(item.phone) === number), 'customer');
          const vehicleVin = field('vin', value => value ? vin(value) : '', 'Uppercased VIN');
          const stock = field('stockNumber');
          if (entity === 'deals' && !vehicleVin && !stock) throw invalid('Map a VIN or stock number to link the deal to a vehicle.');
          const vehicle = vehicleVin || stock ? matchOne(vehicles, item => (!vehicleVin || item.vin === vehicleVin) &&
            (!stock || item.stockNumber.toLowerCase() === stock.toLowerCase()), 'vehicle') : null;
          row.values.customerId = customer.id;
          if (vehicle) row.values.vehicleId = vehicle.id;
          if (entity === 'leads') {
            const leadStage = stage(field('stage', value => value.toLowerCase() || 'new', 'Standardized stage or used new'));
            const lead: Lead = {...base(recordId), kind: 'lead', customerId: customer.id, vehicleId: vehicle?.id ?? null, assigneeId: null,
              vehicleDescription: text(field('vehicleDescription'), 'Vehicle description', 1000, true),
              source: source(field('source', value => value.toLowerCase() || 'other', 'Standardized source or used other')),
              sourceDetail: text(field('sourceDetail'), 'Source detail', 500, true), stage: leadStage,
              activities: [{id: hash(recordId, 'activity'), kind: 'stage', summary: `Lead imported as ${leadStage}`, actorId: principal.userId, timestamp: stamp}], followUps: []};
            records.push(lead);
          } else {
            if (!vehicle || vehicle.status === 'sold') throw invalid('An open deal requires an unsold vehicle.');
            const status = choice(field('status', value => value.toLowerCase() || 'working', 'Standardized status or used working'), ['working', 'approved'], 'open deal status');
            const type = choice(field('type', value => value.toLowerCase() || 'cash', 'Standardized deal type or used cash'), ['cash', 'finance', 'lease'], 'deal type');
            const leadId = field('leadSourceId');
            const lead = leadId ? matchOne(leads, item => item.id === sourceRecordId('leads', leadId) &&
              item.customerId === customer.id && (!item.vehicleId || item.vehicleId === vehicle.id), 'lead for this buyer and vehicle') : null;
            if (lead) row.values.leadId = lead.id;
            const amount = dollarCents(raw.amount);
            if (amount === undefined) throw invalid('Use a dollar amount from 0 to $100,000,000 with at most two decimal places.');
            row.values.amount = amount;
            change(row, 'amount', raw.amount, amount, 'Converted dollars to cents');
            const pencilId = hash(recordId, 'pencil');
            const deal: Deal = {...base(recordId), kind: 'deal', customerId: customer.id, vehicleId: vehicle.id, leadId: lead?.id ?? null, type,
              trade: null, taxRateBps: 0, taxTradeDifference: false, docFee: 0,
              pencils: [{id: pencilId, name: 'Imported pencil', type, lease: type === 'lease' ? defaultLeaseTerms(amount) : null,
                fiSelections: [], price: amount, down: 0, term: 36, aprBps: 0}],
              workingPencilId: pencilId, status, history: [{status, actorId: principal.userId, timestamp: stamp}]};
            records.push(deal);
            actual.amountCents! += amount;
          }
        }
        usedIds.add(recordId);
        row.recordId = recordId;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        row.status = 'skipped';
        row.reasons.push(error.message);
      }
    }
  }
  actual.count = records.length;
  const approval = hash(principal.tenantId, principal.userId, fileId, columns, rows, expected, actual);
  const preview: MigrationPreview = {entity, columns, fields: Object.keys(aliases[entity]), rows, expected, actual, approval};
  const report: MigrationImport = {id: receiptId(approval), tenantId: principal.tenantId, actorId: principal.userId, createdAt: stamp, entity, columns, rows, expected, actual};
  // Leave headroom for DynamoDB attribute names and envelope overhead.
  if (Buffer.byteLength(JSON.stringify(report)) > 300_000) throw invalid('This audit trail is too large. Split the CSV into smaller files.');
  return {preview, report, records, version};
}

export async function migrationImport(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, decoder: VinDecoder) {
  if (principal.role !== 'admin' || request.agent) throw new ApiError(403, 'FORBIDDEN', 'A workspace administrator must approve migration and access its reports.');
  onlyKeys(request.query ?? {}, []);
  const path = request.path.replace(/\/$/, '');
  const method = request.method.toUpperCase();
  if (method === 'GET') {
    if (path === '/migration/imports') return response(200, {data: (await repo.migrationHistory()).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))});
    const match = /^\/migration\/imports\/([^/]+)$/.exec(path);
    if (!match) throw missing();
    const report = await repo.migrationReport(requireId(match[1]));
    if (!report) throw missing();
    return response(200, {data: report});
  }
  const match = /^\/migration\/([^/]+)\/import(\/preview)?$/.exec(path);
  if (!match || !migrationEntities.includes(match[1] as MigrationEntity)) throw missing();
  if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const body = parseBody(request.body, IMPORT_BODY_LIMIT);
  onlyKeys(body, match[2] ? ['csv', 'enrich', 'mapping', 'expected'] : ['csv', 'enrich', 'mapping', 'expected', 'approval']);
  if (!match[2] && typeof body.approval !== 'string') throw invalid('Preview and approve the migration first.');
  const prepared = await prepare(match[1] as MigrationEntity, body, principal, repo, now, decoder);
  if (prepared.previous) return response(200, {data: prepared.previous});
  const {preview, report, records, version} = prepared;
  if (match[2]) return response(200, {data: preview});
  if (preview.approval !== body.approval) throw new ApiError(409, 'CONFLICT', 'The preview changed. Review it again before approving.');
  const event = (type: OutboxEvent['type'], aggregateId: string): OutboxEvent => ({
    id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId, aggregateVersion: 1,
    occurredAt: report.createdAt, type, deliveryStatus: 'pending'
  });
  await repo.commitMigration({report, expectedVersion: version, event: event('migration.imported', report.id),
    writes: records.map(record => ({record, event: event(`${'kind' in record ? record.kind : 'vehicle'}.created`, record.id)}))});
  return response(201, {data: report});
}
