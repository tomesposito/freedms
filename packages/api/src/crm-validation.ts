import { communicationTypes, leadSources, leadStages, type CustomerInput } from '@freedms/shared';
import { invalid, object, onlyKeys, text } from './validation.js';
export function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw invalid(`Invalid ${label}.`); return value as T;
}
export function timestamp(value: unknown, label: string): string {
  const s = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw invalid(`${label} must be a valid UTC timestamp.`);
  return new Date(s).toISOString();
}
export function customerInput(value: unknown): CustomerInput {
  const b = object(value); onlyKeys(b, ['name', 'phone', 'email', 'address', 'consent', 'notes']);
  const c = object(b.consent); onlyKeys(c, ['status', 'timestamp', 'source']);
  const status = choice(c.status, ['unknown', 'granted', 'revoked'], 'consent status');
  const consent = {status, timestamp: c.timestamp === null ? null : timestamp(c.timestamp, 'Consent timestamp'), source: text(c.source, 'Consent source', 200, status === 'unknown')};
  if (status !== 'unknown' && !consent.timestamp) throw invalid('Consent timestamp is required.');
  const phone = text(b.phone, 'Phone', 50, true); const email = text(b.email, 'Email', 254, true).toLowerCase();
  if (phone && phone.replace(/\D/g, '').length < 7) throw invalid('Enter a valid phone number.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email address.');
  return {name: text(b.name, 'Name'), phone, email, address: text(b.address, 'Address', 1000, true), notes: text(b.notes, 'Notes', 10000, true), consent};
}
export const source = (v: unknown) => choice(v, leadSources, 'lead source');
export const stage = (v: unknown) => choice(v, leadStages, 'pipeline stage');
export const communicationType = (v: unknown) => choice(v, communicationTypes, 'communication type');
export function normalizedPhone(phone: string): string { const digits = phone.replace(/\D/g, ''); return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits; }
