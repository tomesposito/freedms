import type { DecodedVin } from '@freedms/shared';
import { ApiError } from './errors.js';
import { vin as validateVin } from './validation.js';
export interface VinDecoder { decode(vin: string): Promise<DecodedVin> }
export class NhtsaVinDecoder implements VinDecoder {
  constructor(private request: typeof fetch = fetch) {}
  async decode(value: string): Promise<DecodedVin> {
    const vin = validateVin(value);
    try {
      const response = await this.request(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, {signal: AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error('NHTSA request failed');
      const body = await response.json() as {Results?: Record<string, string>[]};
      const row = body.Results?.[0];
      if (!row || typeof row.Make !== 'string' || typeof row.Model !== 'string') throw new Error('Invalid NHTSA response');
      const year = Number(row.ModelYear);
      const warnings: string[] = [];
      if (row.ErrorCode?.split(',').some(code => code.trim() !== '0')) warnings.push(row.ErrorText || 'NHTSA reported incomplete or invalid VIN data.');
      if (!row.Make || !row.Model || !year) warnings.push('Some vehicle attributes could not be decoded. Enter and verify missing fields.');
      return {vin, year: Number.isInteger(year) && year >= 1886 ? year : null, make: row.Make, model: row.Model, trim: row.Trim || '', warnings};
    } catch { throw new ApiError(502, 'VIN_UNAVAILABLE', 'VIN decoding is unavailable. Retry or enter the vehicle details manually.'); }
  }
}
