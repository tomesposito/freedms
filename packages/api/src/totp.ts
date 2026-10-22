import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function decodeBase32(secret: string): Buffer {
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    const digit = alphabet.indexOf(char); if (digit < 0) throw new Error('Invalid base32');
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}
export const generateTotpSecret = (): string => base32(randomBytes(20));
export function hotp(secret: string, counter: number, digits = 6): string {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(bytes).digest();
  const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
}
export const totp = (secret: string, date: Date): string => hotp(secret, Math.floor(date.getTime() / 30000));
export function verifyTotp(secret: string, code: string, date: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(date.getTime() / 30000); let matched: number | null = null;
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate >= 0 && timingSafeEqual(Buffer.from(hotp(secret, candidate)), Buffer.from(code))) matched = candidate;
  }
  return matched;
}
export function otpauthUrl(secret: string, accountLabel: string): string {
  return `otpauth://totp/freeDMS:${encodeURIComponent(accountLabel)}?secret=${encodeURIComponent(secret)}&issuer=freeDMS&algorithm=SHA1&digits=6&period=30`;
}
