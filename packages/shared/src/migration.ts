export const migrationEntities = ['inventory', 'customers', 'leads', 'deals'] as const;
export type MigrationEntity = typeof migrationEntities[number];
export const migrationLabels: Record<MigrationEntity, string> = {
  inventory: 'Inventory', customers: 'Customers', leads: 'Leads', deals: 'Open deals'
};
export const migrationBatchLimit = 47;

export interface MigrationColumn {
  header: string;
  field: string | null;
  issue?: 'Unmapped' | 'Ambiguous';
}

export interface MigrationRow {
  rowNumber: number;
  status: 'ready' | 'skipped';
  reasons: string[];
  changes: {field: string; before: string; after: string; reason: string}[];
  values: Record<string, string | number>;
  recordId?: string;
}

export interface MigrationTotals { count: number; amountCents?: number }

export interface MigrationPreview {
  entity: MigrationEntity;
  fields: string[];
  columns: MigrationColumn[];
  rows: MigrationRow[];
  expected: MigrationTotals;
  actual: MigrationTotals;
  approval: string;
}

export interface MigrationImport extends Omit<MigrationPreview, 'approval' | 'fields'> {
  id: string;
  tenantId: string;
  actorId: string;
  createdAt: string;
}

export interface MigrationHistory extends Omit<MigrationImport, 'columns' | 'rows'> {
  totalRows: number;
}
