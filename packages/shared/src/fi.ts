import type { CrmRecord } from './index.js';
export const fiCategories = ['service-contract', 'gap', 'tire-wheel', 'paint-fabric', 'key-replacement', 'maintenance', 'theft', 'other'] as const;
export type FiCategory = typeof fiCategories[number];
export const fiCategoryLabels: Record<FiCategory, string> = {'service-contract': 'Warranty/service contract', gap: 'GAP', 'tire-wheel': 'Tire & wheel', 'paint-fabric': 'Paint & fabric', 'key-replacement': 'Key replacement', maintenance: 'Maintenance', theft: 'Theft', other: 'Other'};
export interface FiProduct extends CrmRecord {
  kind: 'fi-product'; name: string; category: FiCategory; cost: number; retailPrice: number; termNotes: string; active: boolean;
}
