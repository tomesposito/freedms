export interface McpGrant {
  id: string;
  tenantId: string;
  userId: string;
  clientId: string;
  appName: string;
  scopes: string[];
  firstGrantedAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  oauthAuthorizationId?: string;
  version: number;
}
export type McpGrantView = Omit<McpGrant, 'tenantId' | 'clientId' | 'oauthAuthorizationId'> & {ownerName?: string; ownerEmail?: string | null};
