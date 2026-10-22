import { randomUUID } from 'node:crypto';
import { inventoryCsvRows, inventoryCsvHeaders, vehicleStatuses, type ImportPreview, type ImportResult, type ImportRowResult, type OutboxEvent, type Principal, type VehicleInput } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, missing } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import type { VinDecoder } from './vin.js';
import { dollarCents, invalid, onlyKeys, text, vehicleInput, vin } from './validation.js';
export const IMPORT_BODY_LIMIT = 1024 * 1024;

async function preview(csv: string, enrich: boolean, repo: TenantRepository, now: Date, decoder: VinDecoder): Promise<ImportPreview> {
  let parsed: string[][];
  try { parsed = inventoryCsvRows(csv); } catch (error) { throw invalid(error instanceof Error ? error.message : 'Invalid CSV.'); }
  const [header, ...data] = parsed;
  const columns = header.map(h => { const key = h.trim().toLowerCase(); return Object.hasOwn(inventoryCsvHeaders, key) ? inventoryCsvHeaders[key] : undefined; });
  for (const required of ['year', 'make', 'model', 'vin', 'stockNumber', 'cost', 'listPrice']) if (!columns.includes(required)) throw invalid(`Missing required header: ${required}.`);
  if (columns.filter(Boolean).some((c, i, all) => all.indexOf(c) !== i)) throw invalid('Duplicate recognized CSV header.');
  if (data.some(row => row.length !== header.length)) throw invalid('CSV rows must have the same number of fields as the header.');
  const existing = await repo.list({});
  const vins = new Set(existing.map(v => v.vin.toUpperCase()));
  const stocks = new Set(existing.map(v => v.stockNumber.trim().toLowerCase()));
  const seenVins = new Map<string, number>(), seenStocks = new Map<string, number>();
  const rows: ImportRowResult[] = [];
  for (const [index, cells] of data.entries()) {
    const raw: Record<string, string> = {};
    columns.forEach((key, i) => { if (key) raw[key] = cells[i].trim(); });
    const result: ImportRowResult = {rowNumber: index + 1, status: 'valid', errors: []};
    const check = <T>(field: string, validate: () => T): T | undefined => {
      try { return validate(); } catch (error) { result.errors.push({field, message: error instanceof Error ? error.message : 'Invalid value.'}); }
    };
    const validVin = check('vin', () => vin(raw.vin));
    if (enrich && validVin && ['year', 'make', 'model', 'trim'].some(k => !raw[k])) {
      try { const decoded = await decoder.decode(validVin); for (const key of ['year', 'make', 'model', 'trim'] as const) if (!raw[key]) raw[key] = String(decoded[key] ?? ''); }
      catch { /* Decoder failure leaves normal row validation in charge. */ }
    }
    const value: Record<string, unknown> = {vin: validVin, reconCosts: []};
    for (const [key, max, optional] of [['stockNumber', 50, false], ['make', 120, false], ['model', 120, false], ['trim', 120, true], ['location', 200, true], ['notes', 10000, true]] as const) value[key] = check(key, () => text(raw[key] ?? '', key, max, optional));
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
      const suffix = `${miles.toLocaleString('en-US')} miles`;
      value.notes = [String(value.notes ?? '').slice(0, 10000 - suffix.length - 1), suffix].filter(Boolean).join('\n');
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
  const event = (type: OutboxEvent['type'], aggregateId: string): OutboxEvent => ({id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, type, aggregateId, aggregateVersion: 1, occurredAt: now.toISOString(), deliveryStatus: 'pending'});
  const result: ImportResult = {importId: randomUUID(), totalRows: p.totalRows, importedCount: 0, errorCount: p.errorCount, duplicateCount: p.duplicateCount, importedVehicleIds: [], skipped: []};
  for (const row of p.rows) {
    if (row.status !== 'valid') { result.skipped.push({rowNumber: row.rowNumber, status: row.status, errors: row.errors, ...(row.duplicate ? {duplicate: row.duplicate} : {})}); continue; }
    const vehicle = {...row.vehicle!, id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()};
    await repo.create(vehicle, event('vehicle.created', vehicle.id)); result.importedVehicleIds.push(vehicle.id); result.importedCount++;
  }
  await repo.appendImport({id: result.importId, tenantId: principal.tenantId, actorId: principal.userId, createdAt: now.toISOString(), totalRows: p.totalRows, importedCount: result.importedCount, errorCount: p.errorCount, duplicateCount: p.duplicateCount}, event('vehicle.imported', result.importId));
  return response(201, {data: result});
}
