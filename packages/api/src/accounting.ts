import { accountingLock, treasury } from './treasury.js';
import { randomUUID } from 'node:crypto';
import { accountDepartment, departments, accountTypes, commissionFor, debitNormal, defaultAccounts, pencilMath, type AccountBalance, type DealView, type GlAccount, type JournalEntry, type JournalLine, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice } from './crm-validation.js';
import { invalid, onlyKeys, text, version } from './validation.js';
import { dateRange, salesReport } from './reports.js';
import type { CrmWrite, TenantRepository } from './repository.js';
const base = (tenantId: string, now: Date, id: string = randomUUID()) => ({id, tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()});
export function write(record: GlAccount | JournalEntry, principal: Principal, expectedVersion = 0): CrmWrite {
  return {record, expectedVersion, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version,
    type: record.kind === 'journal-entry' ? 'journal-entry.created' : expectedVersion ? 'gl-account.updated' : 'gl-account.created', occurredAt: record.updatedAt, deliveryStatus: 'pending'}};
}
export async function ensureDefaultAccounts(repo: TenantRepository, principal: Principal, now: Date): Promise<GlAccount[]> {
  const accounts = await repo.crmList('gl-account');
  const writes = defaultAccounts.filter(([code]) => !accounts.some(a => a.code === code)).map(([code, name, type]) => write({...base(principal.tenantId, now, `account-${code}`), kind: 'gl-account', code, name, type, active: true, system: true}, principal));
  // Default accounts exceed one CRM transaction. Stable IDs make concurrent lazy seeds safe.
  for (let i = 0; i < writes.length; i += 10) {
    const batch = writes.slice(i, i + 10);
    try { await repo.crmWrite(batch); } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      for (const item of batch) {
        if (await repo.crmGet('gl-account', item.record.id)) continue;
        try { await repo.crmWrite([item]); } catch (retry) {
          if (!(retry instanceof ApiError) || retry.status !== 409 || !await repo.crmGet('gl-account', item.record.id)) throw retry;
        }
      }
    }
  }
  return (await repo.crmList('gl-account')).sort((a, b) => a.code.localeCompare(b.code));
}
export function assertBalanced(lines: JournalLine[]): void {
  if (lines.some(l => !Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || !((l.debit > 0 && l.credit === 0) || (l.credit > 0 && l.debit === 0)))) throw invalid('Invalid journal amounts.');
  const debit = lines.reduce((s, l) => s + l.debit, 0), credit = lines.reduce((s, l) => s + l.credit, 0);
  if (!Number.isSafeInteger(debit) || debit <= 0 || debit !== credit) throw invalid('Journal must have positive, balanced totals.');
}
export function dealPosting(deal: DealView, accounts: GlAccount[], now: Date): JournalEntry {
  const p = deal.pencils.find(p => p.id === deal.workingPencilId)!;
  const m = pencilMath(p, deal.trade, deal, deal.vehicle, deal.type);
  const vc = deal.vehicle.cost + deal.vehicle.reconCosts.reduce((s, r) => s + r.amount, 0);
  const lines: JournalLine[] = [];
  const line = (code: string, side: 'debit' | 'credit', amount: number, explanation: string) => {
    if (amount === 0) return;
    const account = accounts.find(a => a.code === code); if (!account) throw missing();
    lines.push({accountId: account.id, accountCode: account.code, accountName: account.name, debit: side === 'debit' ? amount : 0, credit: side === 'credit' ? amount : 0, explanation});
  };
  line('1000', 'debit', p.down, 'Down payment received');
  if (m.balance > 0) line('1100', 'debit', m.balance, 'Balance owed by buyer (contracts in transit)');
  line('5000', 'debit', vc + m.tradeOverallowance, 'Vehicle cost incl. recon and trade overallowance');
  line('5100', 'debit', m.fiCostTotal, 'F&I product cost');
  line('1200', 'debit', deal.trade?.actualCashValue ?? 0, 'Trade-in at actual cash value');
  line('4000', 'credit', p.price, 'Vehicle sale price');
  line('2000', 'credit', m.salesTax, 'Sales tax collected — owed to the state');
  line('4200', 'credit', deal.docFee + (m.lease?.acquisitionFee ?? 0), m.lease ? 'Dealer document fee and acquisition fee' : 'Dealer document fee');
  line('4100', 'credit', m.fiRetailTotal, 'Accepted F&I products');
  line('1200', 'credit', vc, 'Vehicle out of inventory');
  line('2100', 'credit', deal.trade?.payoff ?? 0, 'Payoff owed on trade-in lien');
  line('2200', 'credit', m.fiCostTotal, 'Owed to F&I product provider');
  if (m.balance < 0) line('2300', 'credit', -m.balance, 'Credit owed to buyer');
  assertBalanced(lines);
  return {...base(deal.tenantId, now, `posting-${deal.id}`), kind: 'journal-entry', date: now.toISOString(), dealId: deal.id, source: 'deal-posting', memo: `${deal.type === 'lease' ? 'Lease inception posting' : 'Deal posting'} — ${deal.customer.name} / ${deal.vehicle.year} ${deal.vehicle.make} ${deal.vehicle.model}`, lines, reversesEntryId: null, reversedByEntryId: null};
}
export function accountBalances(accounts: GlAccount[], entries: JournalEntry[]): AccountBalance[] {
  return accounts.map(a => {
    const lines = entries.flatMap(e => e.lines).filter(l => l.accountId === a.id);
    const debit = lines.reduce((s, l) => s + l.debit, 0), credit = lines.reduce((s, l) => s + l.credit, 0);
    return {accountId: a.id, code: a.code, name: a.name, type: a.type, debit, credit, balance: debitNormal(a.type) ? debit - credit : credit - debit};
  });
}
export async function accounting(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const path = request.path.replace(/\/$/, ''), method = request.method.toUpperCase(), q = request.query ?? {};
  if (/^\/accounting\/(ap|ar|cash|reconciliations)(\/|$)/.test(path)) return treasury(request, principal, repo, now);
  const match = /^\/accounting\/(accounts|journal|balances|trial-balance|departmental|commissions|deals)(?:\/([^/]+))?(\/reverse)?$/.exec(path);
  if (!match) throw missing();
  const [, section, rawId, reverse] = match, id = rawId ? requireId(rawId) : undefined;
  const methods = section === 'accounts' && !reverse ? (id ? ['PUT'] : ['GET', 'POST']) : section === 'journal' ? (id ? reverse ? ['POST'] : [] : reverse ? [] : ['GET']) : !reverse && (section === 'deals' ? !!id : !id) ? ['GET'] : [];
  if (!methods.includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (method !== 'GET') requireWrite(principal, method);
  onlyKeys(q, method === 'GET' && ['journal', 'trial-balance', 'departmental', 'commissions'].includes(section) ? section === 'journal' ? ['from', 'to', 'accountId', 'dealId', 'repairOrderId', 'partsSaleId'] : ['from', 'to'] : []);
  const range = dateRange({from: q.from, to: q.to});
  const accounts = await ensureDefaultAccounts(repo, principal, now);
  if (section === 'accounts') {
    if (method === 'GET') return response(200, {data: accounts});
    const b = parseBody(request.body); onlyKeys(b, id ? ['version', 'name', 'active'] : ['code', 'name', 'type', 'active']);
    const old = id ? await repo.crmGet('gl-account', id) : undefined; if (id && !old) throw missing();
    const expected = id ? version(b.version) : 0; if (old && old.version !== expected) throw conflict();
    const code = old?.code ?? text(b.code, 'Code', 10);
    if (!/^\d{3,10}$/.test(code)) throw invalid('Account code must be 3–10 digits.');
    // Duplicate codes are conflicts, including concurrent creations (stable ID + expectedVersion 0).
    if (!id && accounts.some(a => a.code === code)) throw conflict();
    const active = !id && b.active === undefined ? true : b.active; if (typeof active !== 'boolean') throw invalid('Active must be boolean.');
    const record: GlAccount = {...base(principal.tenantId, now, id ?? `account-${code}`), kind: 'gl-account', code, name: text(b.name, 'Name', 120), type: old?.type ?? choice(b.type, accountTypes, 'account type'), active, system: old?.system ?? false, ...(old?.cash ? {cash: true} : {}), version: expected + 1, createdAt: old?.createdAt ?? now.toISOString()};
    await repo.crmWrite([write(record, principal, expected)]); return response(id ? 200 : 201, {data: record});
  }
  const lock = reverse ? await accountingLock(repo, principal, now) : undefined;
  const all = await repo.crmList('journal-entry');
  const reversed = new Set(all.map(e => e.reversesEntryId).filter(Boolean));
  const entries = all.map(e => ({...e, reversed: reversed.has(e.id)})).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (reverse && id) {
    onlyKeys(parseBody(request.body ?? '{}'), []);
    const original = all.find(e => e.id === id); if (!original) throw missing();
    if (original.source === 'reversal' || reversed.has(id)) throw conflict();
    const record: JournalEntry = {...base(principal.tenantId, now, `reversal-${id}`), kind: 'journal-entry', source: 'reversal', date: now.toISOString(), dealId: original.dealId, repairOrderId: original.repairOrderId, partsSaleId: original.partsSaleId, memo: `Reversal of ${original.memo}`, lines: original.lines.map(l => ({...l, debit: l.credit, credit: l.debit, explanation: `Reversal: ${l.explanation}`})), reversesEntryId: id, reversedByEntryId: null};
    assertBalanced(record.lines); await repo.crmWrite([lock!, write(record, principal)]); return response(201, {data: record});
  }
  const period = entries.filter(e => (!range.from || e.date.slice(0, 10) >= range.from) && (!range.to || e.date.slice(0, 10) <= range.to));
  if (section === 'journal') return response(200, {data: period.filter(e => (!q.accountId || e.lines.some(l => l.accountId === q.accountId)) && (!q.dealId || e.dealId === q.dealId) && (!q.repairOrderId || e.repairOrderId === q.repairOrderId) && (!q.partsSaleId || e.partsSaleId === q.partsSaleId))});
  if (section === 'departmental') {
    return response(200, {data: {...range, ...departmentalStatement(accounts, period)}});
  }
  if (section === 'balances' || section === 'trial-balance') {
    const rows = accountBalances(accounts, section === 'balances' ? entries : period).filter(r => section === 'balances' || r.debit || r.credit);
    const debit = rows.reduce((s, r) => s + r.debit, 0), credit = rows.reduce((s, r) => s + r.credit, 0), totals = {debit, credit, balanced: debit === credit};
    return response(200, section === 'balances' ? {data: rows, totals} : {data: {...range, rows, totals}});
  }
  const rateBps = (await repo.crmGet('settings', 'workspace'))?.commissionRateBps ?? 0;
  if (section === 'commissions') {
    const report = await salesReport(repo, range);
    const rows = report.rows.map(({dealId, soldDate, buyer, vehicle, frontGross}) => ({dealId, soldDate, buyer, vehicle, frontGross, commission: commissionFor(frontGross, rateBps)}));
    return response(200, {data: {...range, rateBps, rows, totals: {frontGross: rows.reduce((s, r) => s + r.frontGross, 0), commission: rows.reduce((s, r) => s + r.commission, 0)}}});
  }
  const deal = await repo.crmGet('deal', id!); if (!deal) throw missing();
  const vehicle = await repo.get(deal.vehicleId), pencil = deal.pencils.find(p => p.id === deal.workingPencilId); if (!vehicle || !pencil) throw missing();
  const numbers = pencilMath(pencil, deal.trade, deal, vehicle, deal.type);
  return response(200, {data: {dealId: deal.id, entries: deal.status === 'sold' ? entries.filter(e => e.dealId === deal.id) : [], commission: deal.status === 'sold' ? commissionFor(numbers.frontGross, rateBps) : 0, numbers}});
}

export function departmentalStatement(accounts: GlAccount[], entries: JournalEntry[]) {
  const balances = accountBalances(accounts, entries).filter(r => ['income', 'expense'].includes(r.type) && (r.debit || r.credit));
  const groups = departments.map(department => {
    const rows = balances.filter(r => accountDepartment(r.code) === department);
    const income = rows.filter(r => r.type === 'income').reduce((s,r) => s+r.balance,0);
    const expenses = rows.filter(r => r.type === 'expense').reduce((s,r) => s+r.balance,0);
    return {department, rows, income, expenses, grossProfit: income-expenses};
  });
  const totals = groups.reduce((s,g) => ({income:s.income+g.income, expenses:s.expenses+g.expenses, grossProfit:s.grossProfit+g.grossProfit}), {income:0, expenses:0, grossProfit:0});
  return {departments: groups, totals};
}
