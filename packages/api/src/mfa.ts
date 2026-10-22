import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MfaRecord, OutboxEvent, Principal, PublicMfaStatus } from '@freedms/shared';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import type { TenantRepository } from './repository.js';
import { invalid, onlyKeys } from './validation.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';
const normalize = (code: string) => code.replace(/[-\s]/g, '').toUpperCase();
const hash = (code: string) => createHash('sha256').update(normalize(code)).digest('hex');
const recoveryAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function recoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < 8) {
    let code = '';
    // Rejection sampling avoids modulo bias if the alphabet length changes.
    while (code.length < 8) for (const byte of randomBytes(16)) {
      if (byte < Math.floor(256 / recoveryAlphabet.length) * recoveryAlphabet.length && code.length < 8) code += recoveryAlphabet[byte % recoveryAlphabet.length];
    }
    codes.add(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return [...codes];
}
export function publicMfaStatus(userId: string, record?: MfaRecord): PublicMfaStatus {
  return {userId, enabled: record?.enabled ?? false, recoveryCodesRemaining: record?.recoveryHashes.length ?? 0, lockedUntil: record?.lockedUntil ?? null};
}
const cleared = {enabled: false, secret: null, pendingSecret: null, recoveryHashes: [] as string[], failedAttempts: 0, lockedUntil: null, lastTotpStep: null};
/** Real second-factor verification boundary for a sign-in flow. This endpoint does
 * not issue or upgrade tokens. Local workspace creation creates a new user with MFA
 * off; hosted pre-token enforcement belongs to Cognito, not this token verifier. */
export async function mfa(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase();
  const reset = /^\/admin\/mfa\/([^/]+)\/reset$/.exec(path);
  const action = /^\/account\/mfa\/(setup|enable|verify|disable|recovery-codes)$/.exec(path)?.[1];
  const read = path === '/account/mfa' || path === '/admin/mfa';
  if (!reset && !action && !read) throw missing();
  if (method !== (read ? 'GET' : 'POST')) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  onlyKeys(request.query ?? {}, []);
  if (path.startsWith('/admin/') && principal.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can manage workspace MFA.');
  if (path === '/admin/mfa') return response(200, {data: await Promise.all((await repo.users()).map(async user => ({userId: user.id, name: user.name, enabled: (await repo.mfa(user.id))?.enabled ?? false})))});
  const userId = reset ? requireId(reset[1]) : principal.userId;
  if (reset && !(await repo.membership(userId))?.active) throw missing();
  const existing = await repo.mfa(userId);
  if (read) return response(200, {data: publicMfaStatus(userId, existing)});
  const body = parseBody(request.body, 4096); onlyKeys(body, reset || action === 'setup' ? [] : ['code']);
  const date = now.toISOString();
  const record: MfaRecord = existing ?? {id: userId, userId, tenantId: principal.tenantId, version: 0, createdAt: date, updatedAt: date, ...cleared};
  const save = async (type: OutboxEvent['type']) => {
    const expected = record.version; record.version++; record.updatedAt = date;
    await repo.saveMfa(record, expected, {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: userId, aggregateVersion: record.version, type, occurredAt: date, deliveryStatus: 'pending'});
  };
  if (reset) { Object.assign(record, cleared); await save('mfa.reset'); return response(200, {data: publicMfaStatus(userId, record)}); }
  if (action === 'setup') {
    if (record.enabled) throw conflict();
    record.pendingSecret = generateTotpSecret(); await save('mfa.setup');
    return response(200, {data: {secret: record.pendingSecret, otpauthUrl: otpauthUrl(record.pendingSecret, `${principal.tenantId}:${userId}`), enabled: false}});
  }
  if (action === 'enable' ? !record.pendingSecret || record.enabled : !record.enabled || !record.secret) throw conflict();
  // No pre-existing rate limiter: persisted per-user lockout uses ApiError and
  // handler errorResponse, and survives restarts in Dynamo. Setup does not clear it.
  if (record.lockedUntil && now.getTime() < Date.parse(record.lockedUntil)) throw new ApiError(429, 'MFA_LOCKED', 'MFA is locked for 15 minutes. Try again later.');
  const code = body.code;
  const allowRecovery = action === 'verify' || action === 'disable';
  if (typeof code !== 'string' || (!/^\d{6}$/.test(code) && !(allowRecovery && /^[A-HJ-NP-Z2-9]{8}$/.test(normalize(code))))) throw invalid('Enter a six-digit TOTP code or, where supported, a recovery code.');
  const step = verifyTotp(action === 'enable' ? record.pendingSecret! : record.secret!, code, now);
  const recoveryIndex = allowRecovery ? record.recoveryHashes.indexOf(hash(code)) : -1;
  if ((step === null || (record.lastTotpStep !== null && step <= record.lastTotpStep)) && recoveryIndex < 0) {
    record.failedAttempts++;
    if (record.failedAttempts >= 5) { record.lockedUntil = new Date(now.getTime() + 15 * 60000).toISOString(); record.failedAttempts = 0; }
    // mfa.verified records verification attempts as well as successes; no code or
    // secret is included in event metadata. Every lockout/replay-state write is atomic.
    await save('mfa.verified');
    throw new ApiError(record.lockedUntil && now.getTime() < Date.parse(record.lockedUntil) ? 429 : 401, record.lockedUntil && now.getTime() < Date.parse(record.lockedUntil) ? 'MFA_LOCKED' : 'MFA_INVALID', 'MFA verification failed.');
  }
  record.failedAttempts = 0; record.lockedUntil = null;
  if (recoveryIndex >= 0) record.recoveryHashes.splice(recoveryIndex, 1);
  else record.lastTotpStep = step;
  if (action === 'disable') { Object.assign(record, cleared); await save('mfa.disabled'); return response(200, {data: publicMfaStatus(userId, record)}); }
  if (action === 'enable' || action === 'recovery-codes') {
    if (action === 'enable') { record.enabled = true; record.secret = record.pendingSecret; record.pendingSecret = null; }
    const codes = recoveryCodes(); record.recoveryHashes = codes.map(hash);
    await save(action === 'enable' ? 'mfa.enabled' : 'mfa.recovery_regenerated');
    return response(200, {data: {enabled: true, recoveryCodes: codes}});
  }
  await save('mfa.verified'); return response(200, {data: {verified: true}});
}
