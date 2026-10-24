import { repairOrderTotals, type GlAccount, type JournalEntry, type JournalLine, type RepairOrder, type PartsSale, type Principal } from '@freedms/shared';
import { assertBalanced, ensureDefaultAccounts, write } from './accounting.js';
import { missing } from './errors.js';
import type { TenantRepository, CrmWrite } from './repository.js';

export async function stockedCost(repo: TenantRepository, ro: RepairOrder): Promise<number> {
  let cost = 0;
  for (const line of ro.lineItems) if (line.kind === 'parts' && line.partId) {
    const part = await repo.crmGet('part', line.partId); if (!part) throw missing();
    cost += line.quantity! * part.costCents;
  }
  return cost;
}
export function fixedPosting(record: RepairOrder | PartsSale, accounts: GlAccount[], cost: number, now: Date): JournalEntry | undefined {
  const service = record.kind === 'repair-order';
  const totals = service ? repairOrderTotals(record.lineItems) : undefined;
  const total = totals?.totalCents ?? (record as PartsSale).totalCents;
  const lines: JournalLine[] = [];
  const ref = `${service ? 'Repair order' : 'Counter sale'} ${record.id}`;
  const line = (code: string, side: 'debit' | 'credit', amount: number, explanation: string) => {
    if (amount === 0) return;
    const account = accounts.find(a => a.code === code); if (!account) throw missing();
    lines.push({accountId:account.id, accountCode:code, accountName:account.name, debit:side === 'debit' ? amount : 0, credit:side === 'credit' ? amount : 0, explanation:`${explanation} — ${ref}`});
  };
  // ROs and counter sales carry no tax today; add a tax line if/when they carry tax.
  line('1150','debit',total,`${ref} receivable — ${record.customerName ?? 'Walk-in'}`);
  line(service ? '5300' : '5400','debit',cost,'Parts cost');
  if (totals) { line('4300','credit',totals.laborCents,'Labor income'); line('4400','credit',totals.partsCents,'Parts income'); }
  else line('4500','credit',total,'Counter parts income');
  line('1300','credit',cost,'Parts out of inventory');
  if (!lines.length) return;
  assertBalanced(lines);
  return {id:service ? `service-posting-${record.id}-v${record.version}` : `parts-posting-${record.id}`, tenantId:record.tenantId, version:1, createdAt:now.toISOString(), updatedAt:now.toISOString(), date:now.toISOString(), kind:'journal-entry', dealId:null,
    ...(service ? {repairOrderId:record.id} : {partsSaleId:record.id}), source:service ? 'service-posting' : 'parts-posting',
    memo:service ? `Service posting — ${record.customerName} / ${record.vehicleDescription} / ${record.id}` : `Counter parts sale — ${record.partNumber} · ${record.description} / ${record.id}`,
    lines, reversesEntryId:null, reversedByEntryId:null};
}
export async function reconcilePosting(repo: TenantRepository, principal: Principal, now: Date, old: RepairOrder | undefined, record: RepairOrder): Promise<CrmWrite[]> {
  record.glPosted = old?.glPosted ?? false; record.glPostingEntryId = old?.glPostingEntryId ?? null;
  const finalized = ['completed','picked-up'].includes(record.status);
  const changed = old && JSON.stringify(old.lineItems) !== JSON.stringify(record.lineItems);
  const writes: CrmWrite[] = [];
  if (record.glPosted && (!finalized || changed)) {
    const original = await repo.crmGet('journal-entry', record.glPostingEntryId!); if (!original) throw missing();
    if (!(await repo.crmList('journal-entry')).some(e => e.reversesEntryId === original.id)) {
      const reversal: JournalEntry = {...original, id:`service-reversal-${original.id}`, source:'reversal', version:1, date:now.toISOString(), createdAt:now.toISOString(), updatedAt:now.toISOString(), memo:`Reversal of ${original.memo}`, reversesEntryId:original.id, reversedByEntryId:null,
        lines:original.lines.map(l => ({...l, debit:l.credit, credit:l.debit, explanation:`Reversal: ${l.explanation}`}))};
      assertBalanced(reversal.lines); writes.push(write(reversal, principal));
    }
    record.glPosted = false; record.glPostingEntryId = null;
  }
  if (finalized && !record.glPosted) {
    const accounts = await ensureDefaultAccounts(repo, principal, now);
    const entry = fixedPosting(record, accounts, await stockedCost(repo, record), now);
    if (entry) {
      if (!await repo.crmGet('journal-entry', entry.id)) writes.push(write(entry, principal));
      record.glPosted = true; record.glPostingEntryId = entry.id;
    }
  }
  return writes;
}
