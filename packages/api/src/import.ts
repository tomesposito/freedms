import { randomUUID } from 'node:crypto';
import { inventoryCsvRows, inventoryCsvHeaders, vehicleStatuses, type ImportPreview, type ImportResult, type ImportRowResult, type OutboxEvent, type Principal, type VehicleInput } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, missing } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import type { VinDecoder } from './vin.js';
import { dollarCents, invalid, onlyKeys, text, vehicleInput, vin } from './validation.js';
export const IMPORT_BODY_LIMIT = 1024 * 1024;
export const MAX_VIN_DECODES_PER_IMPORT = 25;
// Aggregate wall-clock budget for every decode in one import. A single decode may
// still take its own 8s cap, so the worst case is budget + 8s — well inside the
// hosted Lambda's 60s, leaving time for validation, writes, and the response.
export const VIN_ENRICHMENT_BUDGET_MS = 20_000;

async function preview(csv: string, enrich: boolean, repo: TenantRepository, now: Date, decoder: VinDecoder): Promise<ImportPreview> {
  let parsed: string[][];
  try { parsed = inventoryCsvRows(csv); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid CSV.'); }
  const [header, ...data] = parsed;
  const columns = header.map(h => { const key = h.trim().toLowerCase(); return Object.hasOwn(inventoryCsvHeaders, key) ? inventoryCsvHeaders[key] : undefined; });
  if (columns.filter(Boolean).some((c, i, all) => all.indexOf(c) !== i)) throw invalid('Duplicate recognized CSV header.');
  if (data.some(row => row.length !== header.length)) throw invalid('CSV rows must have the same number of fields as the header.');
  const existing = await repo.list({});
  const vins = new Set(existing.map(v => v.vin.toUpperCase()));
  const stocks = new Set(existing.map(v => v.stockNumber.trim().toLowerCase()));
  const assignedOrProvidedStocks = new Set(stocks);
  const seenVins = new Map<string, number>(), seenStocks = new Map<string, number>();
  const rows: ImportRowResult[] = [];
  const rawRows = data.map(cells => {
    const raw: Record<string, string> = {year: '', make: '', model: '', vin: '', stockNumber: '', cost: '', listPrice: ''};
    columns.forEach((key, i) => { if (key) raw[key] = cells[i].trim(); });
    return raw;
  });
  const validVins = rawRows.map(raw => { try { return vin(raw.vin); } catch { return undefined; } });
  const decodes = new Map<string, Awaited<ReturnType<VinDecoder['decode']>> | null>();
  const skipped = new Map<string, 'limit' | 'deadline'>();
  if (enrich) {
    // Decode candidates first, so attempts can be ordered and bounded before any row
    // is validated: rows missing a required field (year/make/model) decode ahead of
    // rows missing only the optional trim, each group in file order.
    const candidates = new Map<string, {priority: number, order: number}>();
    rawRows.forEach((raw, i) => {
      const validVin = validVins[i];
      if (!validVin) return;
      const missing = ['year', 'make', 'model', 'trim'].filter(k => !raw[k]);
      if (!missing.length) return;
      const priority = missing.some(k => k !== 'trim') ? 0 : 1;
      const current = candidates.get(validVin);
      // Order within a priority group is the first row where the VIN attains that
      // priority — a later required-field row must not inherit an earlier trim-only slot.
      if (!current || priority < current.priority) candidates.set(validVin, {priority, order: i});
    });
    const started = Date.now();
    for (const [validVin] of [...candidates.entries()].sort((a, b) => a[1].priority - b[1].priority || a[1].order - b[1].order)) {
      if (decodes.size >= MAX_VIN_DECODES_PER_IMPORT) { skipped.set(validVin, 'limit'); continue; }
      if (Date.now() - started >= VIN_ENRICHMENT_BUDGET_MS) { skipped.set(validVin, 'deadline'); continue; }
      // Reserve the attempt even on failure so repeated VINs are never retried.
      decodes.set(validVin, null);
      try { decodes.set(validVin, await decoder.decode(validVin)); }
      catch { /* Decoder failure leaves normal row validation in charge. */ }
    }
  }
  for (const [index, raw] of rawRows.entries()) {
    const result: ImportRowResult = {rowNumber: index + 1, status: 'valid', errors: []};
    const check = <T>(field: string, validate: () => T): T | undefined => {
      try { return validate(); } catch (error) { result.errors.push({field, message: error instanceof Error ? error.message : 'Invalid value.'}); }
    };
    const validVin = check('vin', () => vin(raw.vin));
    if (enrich && validVin) {
      const decoded = decodes.get(validVin);
      if (decoded) { for (const key of ['year', 'make', 'model', 'trim'] as const) if (!raw[key]) raw[key] = String(decoded[key] ?? ''); }
      else if (skipped.has(validVin) && ['year', 'make', 'model', 'trim'].some(k => !raw[k])) result.warnings = [skipped.get(validVin) === 'deadline'
        ? 'VIN decode skipped because the per-import enrichment time budget was reached. Fill missing fields manually or split the file.'
        : 'VIN decode skipped because the per-import decode limit was reached. Fill missing fields manually or split the file.'];
    }
    // Missing/blank stock numbers use IMP- plus the uppercased VIN's last 8 characters.
    // Reserve earlier rows too; append -2, -3, ... until unique within this tenant/file.
    if (!raw.stockNumber && validVin) {
      const base = `IMP-${validVin.slice(-8)}`;
      raw.stockNumber = base;
      for (let suffix = 2; assignedOrProvidedStocks.has(raw.stockNumber.toLowerCase()); suffix++) raw.stockNumber = `${base}-${suffix}`;
    }
    if (raw.stockNumber) assignedOrProvidedStocks.add(raw.stockNumber.toLowerCase());
    const value: Record<string, unknown> = {vin: validVin, reconCosts: [], mileage: null};
    for (const [key, max, optional] of [['stockNumber', 50, true], ['make', 120, false], ['model', 120, false], ['trim', 120, true], ['location', 200, true], ['notes', 10000, true]] as const) value[key] = check(key, () => text(raw[key] ?? '', key, max, optional));
    value.year = check('year', () => { const year = Number(raw.year); if (!/^\d+$/.test(raw.year) || !Number.isInteger(year) || year < 1886 || year > now.getUTCFullYear() + 2) throw invalid('Invalid model year.'); return year; });
    for (const key of ['cost', 'listPrice']) value[key] = check(key, () => { const cents = dollarCents(raw[key]); if (cents === undefined) throw invalid('Use a dollar amount from 0 to $100,000,000 with at most two decimal places.'); return cents; });
    value.status = check('status', () => { const status = raw.status?.toLowerCase() || 'available'; if (!vehicleStatuses.includes(status as VehicleInput['status'])) throw invalid('Invalid vehicle status.'); return status; });
    value.dateStocked = check('dateStocked', () => {
      const date = raw.dateStocked || now.toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > now.toISOString().slice(0, 10)) throw invalid('Date stocked must be a valid date no later than today (UTC).'); return date;
    });
    if (raw.mileage) check('mileage', () => {
      const miles = Number(raw.mileage.replace(/,/g, ''));
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw.mileage) || !Number.isSafeInteger(miles) || miles > 10_000_000) throw invalid('Mileage must be an integer from 0 to 10,000,000.');
      value.mileage = miles;
    });
    if (result.errors.length) result.status = 'error';
    else {
      result.vehicle = vehicleInput(value, now);
      const v = result.vehicle, stock = v.stockNumber.toLowerCase();
      // VIN wins consistently when both identities match; even duplicate rows reserve their identities.
      if (vins.has(v.vin)) result.duplicate = {field: 'vin', reason: "VIN already exists in this workspace's inventory."};
      else if (stocks.has(stock)) result.duplicate = {field: 'stockNumber', reason: "Stock number already exists in this workspace's inventory."};
      else if (seenVins.has(v.vin)) result.duplicate = {field: 'vin', reason: `VIN duplicates row ${seenVins.get(v.vin)} of this file.`};
      else if (seenStocks.has(stock)) result.duplicate = {field: 'stockNumber', reason: `Stock number duplicates row ${seenStocks.get(stock)} of this file.`};
      if (result.duplicate) result.status = 'duplicate';
      if (!seenVins.has(v.vin)) seenVins.set(v.vin, result.rowNumber);
      if (!seenStocks.has(stock)) seenStocks.set(stock, result.rowNumber);
    }
    rows.push(result);
  }
  return {totalRows: rows.length, validCount: rows.filter(r => r.status === 'valid').length, errorCount: rows.filter(r => r.status === 'error').length, duplicateCount: rows.filter(r => r.status === 'duplicate').length, rows};
}
export async function inventoryImport(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date, decoder: VinDecoder) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  if (!['/vehicles/import', '/vehicles/import/preview', '/vehicles/imports'].includes(path)) throw missing();
  if (method !== (path === '/vehicles/imports' ? 'GET' : 'POST')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  if (path === '/vehicles/imports') return response(200, {data: (await repo.imports()).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))});
  requireWrite(principal, method);
  const body = parseBody(request.body, IMPORT_BODY_LIMIT); onlyKeys(body, ['csv', 'enrich']);
  if (typeof body.csv !== 'string' || (body.enrich !== undefined && typeof body.enrich !== 'boolean')) throw invalid('CSV text and an optional boolean enrich flag are required.');
  const p = await preview(body.csv, body.enrich === true, repo, now, decoder);
  if (path.endsWith('/preview')) return response(200, {data: p});
  const event = (type: OutboxEvent['type'], aggregateId: string): OutboxEvent => ({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, ...(request.agent ? {actorType: 'agent' as const} : {}), type, aggregateId, aggregateVersion: 1, occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const result: ImportResult = {importId: randomUUID(), totalRows: p.totalRows, importedCount: 0, errorCount: p.errorCount, duplicateCount: p.duplicateCount, importedVehicleIds: [], skipped: []};
  for (const row of p.rows) {
    if (row.status !== 'valid') { result.skipped.push({rowNumber: row.rowNumber, status: row.status, errors: row.errors, ...(row.warnings ? {warnings: row.warnings} : {}), ...(row.duplicate ? {duplicate: row.duplicate} : {})}); continue; }
    const vehicle = {...row.vehicle!, id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()};
    await repo.create(vehicle, event('vehicle.created', vehicle.id)); result.importedVehicleIds.push(vehicle.id); result.importedCount++;
  }
  await repo.appendImport({id: result.importId, tenantId: principal.tenantId, actorId: principal.userId, createdAt: now.toISOString(), totalRows: p.totalRows, importedCount: result.importedCount, errorCount: p.errorCount, duplicateCount: p.duplicateCount}, event('vehicle.imported', result.importId));
  return response(201, {data: result});
}
