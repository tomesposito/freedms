/** Raw TOTP secrets are retained on tenant records because verification requires them.
 * Recovery codes are never stored raw: only SHA-256 hashes are retained. */
export interface MfaRecord {
  id: string; tenantId: string; userId: string; version: number; createdAt: string; updatedAt: string;
  enabled: boolean; secret: string | null; pendingSecret: string | null; recoveryHashes: string[];
  failedAttempts: number; lockedUntil: string | null; lastTotpStep: number | null;
}
export interface PublicMfaStatus { userId: string; enabled: boolean; recoveryCodesRemaining: number; lockedUntil: string | null }
export interface AdminMfaEntry { userId: string; name: string; enabled: boolean }
