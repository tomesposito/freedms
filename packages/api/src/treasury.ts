import { randomUUID, createHash } from 'node:crypto';
import { aging, cashRegister, inventoryCsvRows, reconciliationView, type BankReconciliation, type CrmEntity, type GlAccount, type JournalEntry, type JournalLine, type Principal, type StatementLine, type StatementPreview } from '@freedms/shared';
import { assertBalanced, ensureDefaultAccounts } from './accounting.js';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { dateRange } from './reports.js';
import { invalid, money, object, onlyKeys, text, version } from './validation.js';
import type { CrmWrite, TenantRepository } from './repository.js';
const base = (p: Principal, now: Date, id: string = randomUUID()) => ({id, tenantId: p.tenantId, version: 1, createdAt: now.toISOString(), updatedAt: now.toISOString()});
export function treasuryWrite(record: CrmEntity, p: Principal, expectedVersion = 0): CrmWrite {
  return {record, expectedVersion, event: {id: randomUUID(), tenantId: p.tenantId, actorId: p.userId, aggregateId: record.id, aggregateVersion: record.version, type: `${record.kind}.${expectedVersion ? 'updated' : 'created'}` as CrmWrite['event']['type'], occurredAt: record.updatedAt, deliveryStatus: 'pending'}};
}
/** Optimistic lock serializes allocations and reconciliation across concurrent requests. Read before the ledger. */
export async function accountingLock(repo: TenantRepository, p: Principal, now: Date): Promise<CrmWrite> {
  const old = await repo.crmGet('accounting-lock', 'ledger');
  return treasuryWrite({...base(p, now, 'ledger'), kind: 'accounting-lock', createdAt: old?.createdAt ?? now.toISOString(), version: (old?.version ?? 0) + 1}, p, old?.version ?? 0);
}
const date = (v: unknown) => { const d = text(v, 'Date', 10); dateRange({from: d}); return d; };
const signedMoney = (v: unknown) => { if (typeof v !== 'number') throw invalid('Amount must be integer cents.'); money(Math.abs(v), 'Amount'); return v; };
const isCash = (a: GlAccount) => a.code === '1000' || a.cash === true;
function statementLine(value: unknown, period: BankReconciliation): StatementLine {
  const b = object(value); onlyKeys(b, ['id', 'date', 'description', 'amount']);
  const d = date(b.date); if (d < period.from || d > period.to) throw invalid('Statement date is outside the period.');
  const amount = signedMoney(b.amount); if (!amount) throw invalid('Statement amount must be nonzero.');
  return {id: text(b.id, 'Bank transaction ID', 100), date: d, description: text(b.description, 'Description', 200), amount, registerId: null};
}
export function statementPreview(csv: string, period: BankReconciliation, periods: BankReconciliation[]): StatementPreview {
  let parsed: string[][]; try { parsed = inventoryCsvRows(csv); } catch (error) { throw invalid((error as Error).message); }
  const [headers, ...rows] = parsed;
  if (headers.join(',') !== 'id,date,description,amountCents') throw invalid('CSV headers must be id,date,description,amountCents.');
  const seen = new Set(periods.filter(p => p.accountId === period.accountId).flatMap(p => p.lines.map(l => l.id)));
  const result: StatementPreview['rows'] = rows.map((cells, index) => {
    try {
      if (cells.length !== 4 || !/^-?\d+$/.test(cells[3])) throw invalid('Use four columns and signed integer cents.');
      const line = statementLine({id: cells[0], date: cells[1], description: cells[2], amount: Number(cells[3])}, period);
      if (seen.has(line.id)) return {rowNumber: index + 1, status: 'duplicate', line, error: 'Bank transaction ID already exists.'};
      seen.add(line.id); return {rowNumber: index + 1, status: 'valid', line};
    } catch (error) { return {rowNumber: index + 1, status: 'error', error: (error as Error).message}; }
  });
  return {rows: result, validCount: result.filter(r => r.status === 'valid').length, errorCount: result.filter(r => r.status === 'error').length, duplicateCount: result.filter(r => r.status === 'duplicate').length};
}
export async function treasury(request: ApiRequest, p: Principal, repo: TenantRepository, now: Date) {
  const match = /^\/accounting\/(ap|ar|cash|reconciliations)(?:\/([^/]+))?(?:\/(payments|lines|preview|import|match|close|amend|remove))?$/.exec(request.path.replace(/\/$/, ''));
  if (!match) throw missing();
  const [, section, rawId, action] = match, id = rawId ? requireId(rawId) : undefined, method = request.method.toUpperCase();
  const allowed = section === 'ap' || section === 'ar' ? (!id ? ['GET', 'POST'] : action === 'payments' ? ['POST'] : []) : section === 'cash' ? (!action ? id ? ['GET'] : ['GET', 'POST'] : []) : !action ? id ? ['GET'] : ['GET', 'POST'] : id ? ['POST'] : [];
  if (!allowed.includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (method !== 'GET') requireWrite(p, method);
  onlyKeys(request.query ?? {}, method === 'GET' && (section === 'ap' || section === 'ar') ? ['asOf'] : []);
  const today = now.toISOString().slice(0, 10), asOf = request.query?.asOf ? date(request.query.asOf) : today;
  if (asOf > today) throw invalid('Aging date cannot be in the future.');
  const b = method === 'GET' ? {} : parseBody(request.body, action === 'preview' || action === 'import' ? 1024 * 1024 : 65536);
  const accounts = await ensureDefaultAccounts(repo, p, now);
  const lock = method !== 'GET' && action !== 'preview' ? await accountingLock(repo, p, now) : undefined;
  const entries = await repo.crmList('journal-entry');
  const account = (value: unknown, check: (a: GlAccount) => boolean) => {
    const a = accounts.find(a => a.id === value); if (!a) throw missing();
    if (!a.active || !check(a)) throw invalid('Account is inactive or has an incompatible type.'); return a;
  };
  const line = (a: GlAccount, debit: number, credit: number, explanation: string): JournalLine => ({accountId: a.id, accountCode: a.code, accountName: a.name, debit, credit, explanation});
  if (section === 'ap' || section === 'ar') {
    const report = aging(entries, section, asOf);
    if (method === 'GET') return response(200, {data: report});
    const entry: JournalEntry = {...base(p, now), kind: 'journal-entry', date: now.toISOString(), dealId: null, source: action ? 'payment' : section, memo: '', lines: [], reversesEntryId: null, reversedByEntryId: null};
    const amount = money(b.amount, 'Amount'); if (!amount) throw invalid('Amount must be positive.');
    if (action === 'payments') {
      onlyKeys(b, ['amount', 'cashAccountId', 'reference']);
      const item = report.rows.find(i => i.id === id); if (!item) throw missing();
      if (amount > item.balance) throw invalid('Payment exceeds the open balance.');
      const cash = account(b.cashAccountId, isCash), control = account(item.accountId, () => true);
      const reference = text(b.reference, 'Payment reference', 120);
      entry.memo = `${section.toUpperCase()} payment · ${item.party} · ${reference}`;
      entry.lines = [line(control, section === 'ap' ? amount : 0, section === 'ar' ? amount : 0, reference), line(cash, section === 'ar' ? amount : 0, section === 'ap' ? amount : 0, reference)];
      Object.assign(entry.lines[0], {itemId: item.id, dueDate: item.dueDate, party: item.party, reference: item.reference, vehicleId: item.vehicleId});
    } else {
      onlyKeys(b, ['amount', 'party', 'reference', 'dueDate', 'offsetAccountId', 'vehicleId']);
      const party = text(b.party, section === 'ap' ? 'Vendor' : 'Customer / lender', 120), reference = text(b.reference, 'Reference', 120), dueDate = date(b.dueDate);
      const vehicleId = b.vehicleId ? requireId(text(b.vehicleId, 'Vehicle ID')) : null;
      if (vehicleId && !await repo.get(vehicleId)) throw missing();
      const offset = account(b.offsetAccountId, a => section === 'ap' ? (a.type === 'expense' || (a.type === 'asset' && !isCash(a) && a.code !== '1100')) : a.type === 'income');
      const control = account(`account-${section === 'ap' ? '2400' : '1100'}`, () => true);
      entry.memo = `${section.toUpperCase()} · ${party} · ${reference}`;
      entry.lines = [line(control, section === 'ar' ? amount : 0, section === 'ap' ? amount : 0, reference), line(offset, section === 'ap' ? amount : 0, section === 'ar' ? amount : 0, reference)];
      Object.assign(entry.lines[0], {itemId: `${entry.id}-line-0`, dueDate, party, reference, vehicleId});
    }
    assertBalanced(entry.lines); await repo.crmWrite([lock!, treasuryWrite(entry, p)]); return response(201, {data: entry});
  }
  if (section === 'cash') {
    if (method === 'GET') {
      if (!id) return response(200, {data: accounts.filter(isCash)});
      const a = accounts.find(a => a.id === id && isCash(a)); if (!a) throw missing();
      return response(200, {data: cashRegister(entries, a.id)});
    }
    onlyKeys(b, ['code', 'name']); const code = text(b.code, 'Code', 10);
    if (!/^\d{3,10}$/.test(code)) throw invalid('Account code must be 3–10 digits.');
    if (accounts.some(a => a.code === code)) throw conflict();
    const record: GlAccount = {...base(p, now, `account-${code}`), kind: 'gl-account', code, name: text(b.name, 'Name', 120), type: 'asset', system: false, active: true, cash: true};
    await repo.crmWrite([lock!, treasuryWrite(record, p)]); return response(201, {data: record});
  }
  const periods = await repo.crmList('bank-reconciliation');
  const view = (r: BankReconciliation) => reconciliationView(r, cashRegister(entries, r.accountId), periods.filter(p => p.accountId === r.accountId));
  if (method === 'GET') {
    if (!id) return response(200, {data: periods.map(view).sort((a, b) => b.to.localeCompare(a.to))});
    const r = periods.find(r => r.id === id); if (!r) throw missing(); return response(200, {data: view(r)});
  }
  if (!id) {
    onlyKeys(b, ['accountId', 'from', 'to', 'opening', 'closing']);
    const a = account(b.accountId, isCash), from = date(b.from), to = date(b.to); dateRange({from, to});
    if (to >= today) throw invalid('Reconcile completed days only; the end date must be before today.');
    const prior = periods.filter(r => r.accountId === a.id).sort((a, b) => b.to.localeCompare(a.to))[0];
    if (prior && (prior.status !== 'reconciled' || from !== new Date(Date.parse(prior.to) + 86400000).toISOString().slice(0, 10))) throw invalid('Close the prior period, then start on the following day.');
    const opening = signedMoney(b.opening), closing = signedMoney(b.closing);
    if (opening !== (prior?.closing ?? 0)) throw invalid('Opening must equal the prior statement closing balance (zero for the first period).');
    const r: BankReconciliation = {...base(p, now), kind: 'bank-reconciliation', accountId: a.id, from, to, opening, closing, status: 'open', lines: []};
    await repo.crmWrite([lock!, treasuryWrite(r, p)]); return response(201, {data: view(r)});
  }
  const old = periods.find(r => r.id === id); if (!old) throw missing();
  if (old.status !== 'open') throw conflict();
  const r: BankReconciliation = {...old, lines: old.lines.map(l => ({...l})), version: old.version + 1, updatedAt: now.toISOString()};
  if (action === 'preview' || action === 'import') {
    onlyKeys(b, action === 'preview' ? ['csv'] : ['csv', 'version', 'previewToken']);
    const csv = text(b.csv, 'CSV', 500000), preview = statementPreview(csv, old, periods);
    const previewToken = createHash('sha256').update(JSON.stringify([p.tenantId, old.id, old.version, csv, preview])).digest('hex');
    if (action === 'preview') return response(200, {data: {...preview, previewToken}});
    if (b.previewToken !== previewToken) throw conflict();
    if (preview.errorCount || preview.duplicateCount || !preview.validCount) throw invalid('Fix all invalid and duplicate rows before importing.');
    r.lines.push(...preview.rows.map(row => row.line!));
  } else if (action === 'lines') {
    onlyKeys(b, ['version', 'line']); const l = statementLine(b.line, old);
    if (periods.filter(p => p.accountId === r.accountId).some(p => p.lines.some(existing => existing.id === l.id))) throw conflict();
    r.lines.push(l);
  } else if (action === 'amend') {
    onlyKeys(b, ['version', 'closing']); r.closing = signedMoney(b.closing);
  } else if (action === 'remove') {
    onlyKeys(b, ['version', 'lineId']);
    if (!r.lines.some(l => l.id === b.lineId)) throw missing();
    r.lines = r.lines.filter(l => l.id !== b.lineId);
  } else if (action === 'match') {
    onlyKeys(b, ['version', 'lineId', 'registerId']); const l = r.lines.find(l => l.id === b.lineId); if (!l) throw missing();
    if (b.registerId === null) l.registerId = null;
    else {
      const register = cashRegister(entries, r.accountId).find(row => row.id === b.registerId && row.date <= r.to); if (!register) throw missing();
      if (register.amount !== l.amount) throw invalid('Statement and register amounts must match.');
      if (periods.some(p => p.lines.some(other => other.registerId === register.id))) throw conflict();
      l.registerId = register.id;
    }
  } else if (action === 'close') {
    onlyKeys(b, ['version']); const summary = view(r);
    if (summary.difference !== 0 || summary.statementDifference !== 0 || summary.unmatchedCount !== 0) throw invalid('Match every statement line and resolve both differences to zero before closing.');
    r.status = 'reconciled';
  } else throw missing();
  if (version(b.version) !== old.version) throw conflict();
  if (r.lines.length > 1000 || JSON.stringify(r).length > 250000) throw invalid('Statement exceeds the storage limit.');
  await repo.crmWrite([lock!, treasuryWrite(r, p, old.version)]); return response(200, {data: view(r)});
}
