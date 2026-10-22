import type { VehicleInput } from './index.js';
export interface ImportRowResult {
  rowNumber: number; status: 'valid' | 'error' | 'duplicate';
  errors: {field: string; message: string}[];
  duplicate?: {field: 'vin' | 'stockNumber'; reason: string};
  vehicle?: VehicleInput;
}
export interface ImportPreview { totalRows: number; validCount: number; errorCount: number; duplicateCount: number; rows: ImportRowResult[] }
export interface ImportResult {
  importId: string; totalRows: number; importedCount: number; duplicateCount: number; errorCount: number;
  importedVehicleIds: string[];
  skipped: {rowNumber: number; status: 'error' | 'duplicate'; errors?: ImportRowResult['errors']; duplicate?: ImportRowResult['duplicate']}[];
}
export interface InventoryImport { id: string; tenantId: string; actorId: string; createdAt: string; totalRows: number; importedCount: number; duplicateCount: number; errorCount: number }

/** Strict RFC 4180 fields, allowing either LF or CRLF record separators. */
export function inventoryCsvRows(source: string): string[][] {
  const csv = source.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], field = '', state: 'plain' | 'quoted' | 'closed' = 'plain';
  const finishField = () => { row.push(field); field = ''; state = 'plain'; };
  const finishRow = () => { finishField(); rows.push(row); row = []; if (rows.length > 1001) throw new Error('CSV may contain at most 1000 data rows.'); };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (state === 'quoted') {
      if (c === '"') { if (csv[i + 1] === '"') { field += '"'; i++; } else state = 'closed'; }
      else field += c;
    } else if (c === ',') finishField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && csv[++i] !== '\n') throw new Error('CSV requires LF or CRLF line endings.');
      finishRow();
    } else if (c === '"' && state === 'plain' && field === '') state = 'quoted';
    else { if (state === 'closed' || c === '"') throw new Error('Invalid CSV quoting.'); field += c; }
  }
  if (state === 'quoted') throw new Error('Unbalanced CSV quotes.');
  if (field || row.length || state === 'closed') finishRow();
  if (rows.length < 2) throw new Error('CSV requires a header and at least one data row.');
  return rows;
}
export const inventoryCsvHeaders: Record<string, string> = {
  year: 'year', make: 'make', model: 'model', trim: 'trim', vin: 'vin',
  stocknumber: 'stockNumber', 'stock #': 'stockNumber', 'stock number': 'stockNumber', stock_number: 'stockNumber', stock: 'stockNumber',
  cost: 'cost', 'acquisition cost': 'cost', price: 'listPrice', listprice: 'listPrice', 'list price': 'listPrice', list_price: 'listPrice',
  mileage: 'mileage', miles: 'mileage', odometer: 'mileage', status: 'status',
  datestocked: 'dateStocked', 'date stocked': 'dateStocked', date_stocked: 'dateStocked', location: 'location', notes: 'notes'
};
