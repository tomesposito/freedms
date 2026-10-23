import type { CrmRecord, JournalEntry } from './index.js';
export const payableCodes = ['2100', '2200', '2300', '2400'];
export const agingLabels = ['Current', '1–30', '31–60', '61–90', '91+'] as const;
export interface AccountingLock extends CrmRecord { kind: 'accounting-lock' }
export interface StatementLine { id: string; date: string; description: string; amount: number; registerId: string | null }
export interface BankReconciliation extends CrmRecord {
  kind: 'bank-reconciliation'; accountId: string; from: string; to: string; opening: number; closing: number;
  status: 'open' | 'reconciled'; lines: StatementLine[];
}
export interface AgingItem { id: string; accountId: string; accountCode: string; party: string; reference: string; vehicleId: string | null; dueDate: string; balance: number; bucket: typeof agingLabels[number] }
export interface Aging { asOf: string; rows: AgingItem[]; buckets: {label: string; amount: number}[]; total: number; glBalance: number }
export interface RegisterEntry { id: string; entryId: string; date: string; memo: string; amount: number; balance: number }
export interface ReconciliationView extends BankReconciliation { difference: number; statementDifference: number; unmatchedCount: number; bookBalance: number; outstanding: number }
export interface StatementPreview { rows: {rowNumber: number; status: 'valid' | 'error' | 'duplicate'; error?: string; line?: StatementLine}[]; validCount: number; errorCount: number; duplicateCount: number }
/** Include reversals, allocating their lines to the original item even for legacy deal postings. */
export function aging(entries: JournalEntry[], side: 'ap' | 'ar', asOf: string): Aging {
  const items = new Map<string, AgingItem>(); let glBalance = 0;
  for (const entry of entries.filter(e => e.date.slice(0, 10) <= asOf)) entry.lines.forEach((line, index) => {
    if (!(side === 'ar' ? line.accountCode === '1100' : payableCodes.includes(line.accountCode))) return;
    const id = line.itemId ?? `${entry.reversesEntryId ?? entry.id}-line-${index}`;
    const amount = side === 'ar' ? line.debit - line.credit : line.credit - line.debit;
    const dueDate = line.dueDate ?? entry.date.slice(0, 10);
    const days = Math.floor((Date.parse(asOf) - Date.parse(dueDate)) / 86400000);
    const item = items.get(id) ?? {id, accountId: line.accountId, accountCode: line.accountCode, party: line.party ?? entry.memo, reference: line.reference ?? entry.dealId ?? '', vehicleId: line.vehicleId ?? null, dueDate, balance: 0, bucket: agingLabels[days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4]};
    item.balance += amount; glBalance += amount; items.set(id, item);
  });
  const rows = [...items.values()].filter(i => i.balance !== 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  return {asOf, rows, buckets: agingLabels.map(label => ({label, amount: rows.filter(i => i.bucket === label).reduce((s, i) => s + i.balance, 0)})), total: rows.reduce((s, i) => s + i.balance, 0), glBalance};
}
export function cashRegister(entries: JournalEntry[], accountId: string): RegisterEntry[] {
  let balance = 0;
  return [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).flatMap(entry => entry.lines.flatMap((line, index) => {
    if (line.accountId !== accountId) return [];
    const amount = line.debit - line.credit; balance += amount;
    return [{id: `${entry.id}-line-${index}`, entryId: entry.id, date: entry.date.slice(0, 10), memo: entry.memo, amount, balance}];
  }));
}
export function reconciliationView(record: BankReconciliation, register: RegisterEntry[], periods: BankReconciliation[]): ReconciliationView {
  const matched = new Set([...periods.filter(p => p.id !== record.id && p.status === 'reconciled' && p.to < record.from), record].flatMap(p => p.lines.flatMap(l => l.registerId ? [l.registerId] : [])));
  const eligible = register.filter(r => r.date <= record.to);
  const bookBalance = eligible.reduce((s, r) => s + r.amount, 0);
  const outstanding = eligible.filter(r => !matched.has(r.id)).reduce((s, r) => s + r.amount, 0);
  return {...record, bookBalance, outstanding, difference: record.closing - (bookBalance - outstanding), statementDifference: record.closing - record.opening - record.lines.reduce((s, l) => s + l.amount, 0), unmatchedCount: record.lines.filter(l => !l.registerId).length};
}
