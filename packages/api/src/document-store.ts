import { requireId } from './errors.js';
/** File bytes live outside business records. Scope is bound from authenticated claims. */
export interface DocumentStore {
  forTenant(tenantId: string): {
    put(id: string, content: Uint8Array): Promise<void>;
    get(id: string): Promise<Uint8Array | undefined>;
    remove(id: string): Promise<void>;
  };
}
export class MemoryDocumentStore implements DocumentStore {
  private tenants = new Map<string, Map<string, Uint8Array>>();
  forTenant(tenantId: string) {
    requireId(tenantId);
    let rows = this.tenants.get(tenantId);
    if (!rows) { rows = new Map(); this.tenants.set(tenantId, rows); }
    const data = rows;
    return {
      put: async (id: string, content: Uint8Array) => { requireId(id); data.set(id, content.slice()); },
      get: async (id: string) => { requireId(id); return data.get(id)?.slice(); },
      remove: async (id: string) => { requireId(id); data.delete(id); }
    };
  }
}
