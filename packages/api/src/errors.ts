export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const missing = () => new ApiError(404, 'NOT_FOUND', 'Record not found.');
export const conflict = () => new ApiError(409, 'CONFLICT', 'This record changed. Reload it before saving again.');
export function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ApiError(400, 'INVALID_ID', 'Invalid identifier.');
  return value;
}
