import { randomUUID } from 'node:crypto';
import { adverseActionReasons, creditStatuses, decisionOutcomes, housingStatuses, type CreditApplicant, type CreditApplication, type CreditDecision, type PayoffQuote, type Principal } from '@freedms/shared';
import { requireWrite } from './auth.js';
import { ApiError, conflict, missing, requireId } from './errors.js';
import { parseBody, response, type ApiRequest } from './handler.js';
import { choice, timestamp } from './crm-validation.js';
import { invalid, money, object, onlyKeys, text, version } from './validation.js';
import type { TenantRepository } from './repository.js';
function date(value: unknown, label: string): string {
  const s = text(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw invalid(`Invalid ${label}.`);
  return s;
}
function years(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100) throw invalid('Years must be an integer from 0 to 100.');
  return value;
}
function last4(value: unknown, ssn: boolean, previous = ''): string {
  if (value === undefined) return previous;
  if (typeof value !== 'string' || !(ssn ? /^(?:\d{9}|\d{3}-\d{2}-\d{4})$/ : /^\d{4,34}$/).test(value)) throw invalid(ssn ? 'Invalid SSN format.' : 'Account number must contain 4–34 digits.');
  const digits = value.replace(/-/g, '');
  if (ssn && (/^(\d)\1{8}$/.test(digits) || digits.startsWith('000'))) throw invalid('Invalid SSN.');
  return digits.slice(-4);
}
function applicant(value: unknown, now: Date, old?: CreditApplicant): CreditApplicant {
  const b = object(value);
  onlyKeys(b, ['fullName', 'dateOfBirth', 'ssn', 'address', 'phone', 'email', 'housingStatus', 'monthlyHousingPayment', 'yearsAtAddress', 'employerName', 'jobTitle', 'yearsEmployed', 'grossMonthlyIncome', 'otherMonthlyIncome', 'otherIncomeSource']);
  const ssnLast4 = last4(b.ssn, true, old?.ssnLast4); delete b.ssn;
  const dateOfBirth = date(b.dateOfBirth, 'date of birth');
  if (dateOfBirth > now.toISOString().slice(0, 10)) throw invalid('Date of birth cannot be in the future.');
  const phone = text(b.phone, 'Phone', 50, true), email = text(b.email, 'Email', 254, true).toLowerCase();
  if (phone && phone.replace(/\D/g, '').length < 7) throw invalid('Invalid phone.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Invalid email.');
  return {fullName: text(b.fullName, 'Name', 120), dateOfBirth, ssnLast4, address: text(b.address, 'Address', 1000), phone, email,
    housingStatus: choice(b.housingStatus, housingStatuses, 'housing status'), monthlyHousingPayment: money(b.monthlyHousingPayment, 'Housing payment'), yearsAtAddress: years(b.yearsAtAddress),
    employerName: text(b.employerName, 'Employer', 120, true), jobTitle: text(b.jobTitle, 'Job title', 120, true), yearsEmployed: years(b.yearsEmployed),
    grossMonthlyIncome: money(b.grossMonthlyIncome, 'Income'), otherMonthlyIncome: money(b.otherMonthlyIncome, 'Other income'), otherIncomeSource: text(b.otherIncomeSource, 'Other income source', 500, true)};
}
export async function credit(request: ApiRequest, principal: Principal, repo: TenantRepository, now: Date) {
  const match = /^\/deals\/([^/]+)\/(credit-application|payoff-quotes)\/?$/.exec(request.path);
  if (!match) throw missing();
  onlyKeys(request.query ?? {}, []);
  const deal = await repo.crmGet('deal', requireId(match[1])); if (!deal) throw missing();
  const method = request.method.toUpperCase(), payoff = match[2] === 'payoff-quotes', time = now.toISOString();
  if (!(payoff ? ['GET', 'POST'] : ['GET', 'POST', 'PUT']).includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  const old = payoff ? undefined : await repo.crmGet('credit-application', deal.id);
  if (method === 'GET') {
    if (payoff) return response(200, {data: (await repo.crmList('payoff-quote')).filter(p => p.dealId === deal.id).sort((a, b) => a.quotedAt.localeCompare(b.quotedAt) || a.id.localeCompare(b.id))});
    if (!old) throw missing(); return response(200, {data: old});
  }
  requireWrite(principal, method);
  const b = parseBody(request.body);
  let record: CreditApplication | PayoffQuote, expected = 0;
  if (payoff) {
    onlyKeys(b, ['lenderName', 'payoffAmount', 'goodThroughDate', 'accountNumber', 'notes']);
    const accountLast4 = last4(b.accountNumber, false); delete b.accountNumber;
    record = {kind: 'payoff-quote', id: randomUUID(), tenantId: principal.tenantId, version: 1, createdAt: time, updatedAt: time, dealId: deal.id,
      lenderName: text(b.lenderName, 'Lender', 120), payoffAmount: money(b.payoffAmount, 'Payoff amount'), goodThroughDate: date(b.goodThroughDate, 'good-through date'), accountLast4, quotedAt: time, notes: text(b.notes, 'Notes', 2000, true)};
  } else {
    onlyKeys(b, ['applicant', 'coApplicant', 'consentAt', ...(method === 'PUT' ? ['version', 'status', 'decision'] : [])]);
    if (method === 'POST' && old) throw invalid('An application already exists for this deal.');
    if (method === 'PUT') {
      if (!old) throw missing();
      if (old.status === 'decision-recorded') throw invalid('The recorded decision is final; this application is locked.');
      expected = version(b.version); if (old.version !== expected) throw conflict();
    }
    const person = applicant(b.applicant, now, old?.applicant), coApplicant = b.coApplicant == null ? null : applicant(b.coApplicant, now, old?.coApplicant ?? undefined);
    const status = b.status === undefined ? old?.status ?? 'draft' : choice(b.status, creditStatuses, 'credit status');
    let decision: CreditDecision | null = null;
    if (status === 'decision-recorded') {
      if (old?.status !== 'ready') throw invalid('Mark the application ready before recording a decision.');
      const d = object(b.decision); onlyKeys(d, ['outcome', 'lenderName', 'termsNote', 'adverseReasons']);
      const outcome = choice(d.outcome, decisionOutcomes, 'decision outcome');
      const reasons = d.adverseReasons ?? [];
      if (!Array.isArray(reasons)) throw invalid('Invalid adverse reasons.');
      const adverseReasons = [...new Set(reasons.map(r => choice(r, adverseActionReasons, 'adverse reason')))];
      if ((outcome === 'declined') !== (adverseReasons.length > 0)) throw invalid('Reasons are required only for declined decisions.');
      decision = {outcome, lenderName: text(d.lenderName ?? '', 'Lender', 120, outcome === 'declined'), termsNote: text(d.termsNote, 'Terms note', 2000, true), adverseReasons, decidedAt: time, decidedBy: principal.userId};
    } else if (b.decision !== undefined) throw invalid('A decision requires decision-recorded status.');
    record = {kind: 'credit-application', id: deal.id, tenantId: principal.tenantId, version: expected + 1, createdAt: old?.createdAt ?? time, updatedAt: time,
      dealId: deal.id, customerId: deal.customerId, applicant: person, coApplicant, consentAt: timestamp(b.consentAt, 'Consent'), status, decision};
  }
  try { await repo.crmWrite([{record, expectedVersion: expected, event: {id: randomUUID(), tenantId: principal.tenantId, actorId: principal.userId, aggregateId: record.id, aggregateVersion: record.version,
    type: record.kind === 'payoff-quote' ? 'payoff-quote.created' : expected ? 'credit-application.updated' : 'credit-application.created', occurredAt: time, deliveryStatus: 'pending'}}]); }
  catch (error) {
    // A deterministic application ID also enforces one-per-deal for concurrent POSTs.
    if (!payoff && method === 'POST' && error instanceof ApiError && error.status === 409) throw invalid('An application already exists for this deal.');
    throw error;
  }
  return response(method === 'POST' ? 201 : 200, {data: record});
}
