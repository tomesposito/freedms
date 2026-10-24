import type { CrmRecord } from './index.js';
import type { pencilMath } from './desking.js';
export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = typeof accountTypes[number];
export const debitNormal = (type: AccountType) => type === 'asset' || type === 'expense';
export interface GlAccount extends CrmRecord { kind: 'gl-account'; code: string; name: string; type: AccountType; active: boolean; system: boolean; cash?: boolean }
export interface JournalLine { accountId: string; accountCode: string; accountName: string; debit: number; credit: number; explanation: string; itemId?: string; dueDate?: string; party?: string; reference?: string; vehicleId?: string | null }
export interface JournalEntry extends CrmRecord {
  kind: 'journal-entry'; date: string; dealId: string | null; source: 'deal-posting' | 'service-posting' | 'parts-posting' | 'reversal' | 'manual' | 'ap' | 'ar' | 'payment'; memo: string;
  repairOrderId?: string | null; partsSaleId?: string | null;
  lines: JournalLine[]; reversesEntryId: string | null; reversedByEntryId: string | null;
}
export type JournalView = JournalEntry & {reversed: boolean};
export const defaultAccounts: readonly (readonly [string, string, AccountType])[] = [
  ['1000', 'Cash', 'asset'], ['1100', 'Contracts in transit', 'asset'], ['1200', 'Vehicle inventory', 'asset'],
  ['2400', 'Accounts payable', 'liability'], ['2000', 'Sales tax payable', 'liability'], ['2100', 'Trade payoff payable', 'liability'], ['2200', 'F&I products payable', 'liability'], ['2300', 'Customer credits payable', 'liability'],
  ['4000', 'Vehicle sales', 'income'], ['4100', 'F&I income', 'income'], ['4200', 'Fee income', 'income'],
  ['5000', 'Cost of vehicles sold', 'expense'], ['5100', 'F&I product cost', 'expense'],
  ['1150', 'Service and parts receivable', 'asset'], ['1300', 'Parts inventory', 'asset'],
  ['4300', 'Labor income', 'income'], ['4400', 'Service parts income', 'income'], ['4500', 'Counter parts income', 'income'],
  ['5300', 'Service parts cost', 'expense'], ['5400', 'Counter parts cost', 'expense'],
];
export interface AccountBalance { accountId: string; code: string; name: string; type: AccountType; debit: number; credit: number; balance: number }
export interface TrialBalance { from: string | null; to: string | null; rows: AccountBalance[]; totals: {debit: number; credit: number; balanced: boolean} }
export interface Commissions { from: string | null; to: string | null; rateBps: number; rows: {dealId: string; soldDate: string; buyer: string; vehicle: string; frontGross: number; commission: number}[]; totals: {frontGross: number; commission: number} }
export interface DealPack { dealId: string; entries: JournalView[]; commission: number; numbers: ReturnType<typeof pencilMath> }
export function commissionFor(frontGross: number, rateBps: number): number {
  return frontGross > 0 ? Number((BigInt(frontGross) * BigInt(rateBps) * 2n + 10000n) / 20000n) : 0;
}

export const departments = ['sales', 'service', 'parts', 'other'] as const;
export type Department = typeof departments[number];
export function accountDepartment(code: string): Department {
  if (['4000','4100','4200','5000','5100'].includes(code)) return 'sales';
  if (['4300','4400','5300'].includes(code)) return 'service';
  if (['4500','5400'].includes(code)) return 'parts';
  return 'other';
}
export interface DepartmentalStatement {
  from: string | null; to: string | null;
  departments: {department: Department; income: number; expenses: number; grossProfit: number; rows: AccountBalance[]}[];
  totals: {income: number; expenses: number; grossProfit: number};
}
export interface FixedOpsReport {
  from: string | null; to: string | null; roCount: number; laborCents: number; partsCents: number; roTotalCents: number;
  counterSaleCount: number; counterTotalCents: number; partsCostCents: number; laborGrossCents: number; partsGrossCents: number;
}
