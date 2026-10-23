import type { Membership, User } from './index.js';
export interface WorkspaceUser { user: User; membership: Membership }
export interface PublicWorkspaceUser { userId: string; name: string; email: string | null; role: Membership['role']; active: boolean; version: number; mfaEnabled: boolean }
