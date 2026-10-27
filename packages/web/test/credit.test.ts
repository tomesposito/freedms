import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskedSsn, type CreditApplication, type CreditApplicant, type PayoffQuote } from '@freedms/shared';
import { adverseActionHtml, creditHtml, payoffHtml } from '../src/credit.js';
const applicant: CreditApplicant = {fullName: '<script>Buyer</script>', dateOfBirth: '1990-01-01', ssnLast4: '6789', address: '<img>', phone: '', email: '', housingStatus: 'rent', monthlyHousingPayment: 100000, yearsAtAddress: 1, employerName: '', jobTitle: '', yearsEmployed: 0, grossMonthlyIncome: 500000, otherMonthlyIncome: 0, otherIncomeSource: ''};
const a: CreditApplication = {kind: 'credit-application', id: 'deal', dealId: 'deal', customerId: 'customer', tenantId: 'A', version: 1, createdAt: '', updatedAt: '', applicant, coApplicant: {...applicant, ssnLast4: '4321'}, consentAt: '2026-10-23T12:00:00Z', status: 'draft', decision: null};
const q: PayoffQuote = {kind: 'payoff-quote', id: 'quote', dealId: 'deal', tenantId: 'A', version: 1, createdAt: '', updatedAt: '', lenderName: '<img>Bank', payoffAmount: 12345, goodThroughDate: '2026-11-01', accountLast4: '1111', quotedAt: '', notes: '<script>'};
test('Credit rendering masks identifiers, escapes text and states the offline boundary honestly', () => {
  const html = creditHtml(a, [q]);
  assert.match(html, /•••-••-6789/); assert.match(html, /•••-••-4321/); assert.match(html, /••••1111/);
  assert.match(html, /Not submitted anywhere/); assert.match(html, /No credit bureau was pulled/); assert.match(html, /no lender has received/);
  assert.match(html, /Decisions are recorded manually/); assert.match(html, /type="password" autocomplete="off"/);
  assert.doesNotMatch(html, /123-45-6789|123456789|987-65-4321|987654321|4111111111111111|<script>|<img>/);
  assert.doesNotMatch(html, /(?:Successfully|We) (?:pulled|submitted)|submitted to (?:the )?lender|bureau was pulled successfully/i);
  assert.match(html, /&lt;script&gt;/); assert.match(payoffHtml([q]), /\$123.45/);
  assert.match(creditHtml(null, []), /No credit application on file/); assert.match(payoffHtml([]), /No payoff quotes/);
  assert.equal(maskedSsn(''), 'Not on file'); assert.equal(maskedSsn('123456789'), 'Not on file');
});
test('Credit decision rendering is locked and adverse notices exist only when supplied', () => {
  assert.equal(adverseActionHtml(null), '');
  const notice = adverseActionHtml({applicantName: '<script>', decidedAt: '2026-10-23T12:00:00Z', lenderName: '<img>', reasons: ['insufficient-income']});
  assert.match(notice, /Adverse action notice/); assert.match(notice, /Insufficient income/); assert.doesNotMatch(notice, /<script>|<img>/);
  const html = creditHtml({...a, status: 'decision-recorded', decision: {outcome: 'conditioned', lenderName: 'Bank', termsNote: 'Proof of income', decidedAt: '', decidedBy: 'dealer', adverseReasons: []}}, []);
  assert.match(html, /fieldset disabled/); assert.match(html, /This application is locked/); assert.match(html, /Proof of income/);
  assert.doesNotMatch(html, /Adverse action notice/);
});
test('Printed packet includes the adverse action article only for declined decisions', async () => {
  const {renderPacket} = await import('../src/jacket.js');
  const {pencilMath} = await import('@freedms/shared');
  const base = {id: 'id', tenantId: 'A', version: 1, createdAt: '', updatedAt: ''};
  const vehicle: import('@freedms/shared').Vehicle = {...base, mileage: null, stockNumber: 'stock', vin: '1HGCM82633A004352', year: 2003, make: 'Test', model: 'Car', trim: '', status: 'available', cost: 100000, listPrice: 200000, reconCosts: [], dateStocked: '2026-10-23', location: '', notes: '', priceHistory: []};
  const customer: import('@freedms/shared').Customer = {...base, kind: 'customer', name: 'Buyer', phone: '', email: '', address: '', notes: '', consent: {status: 'unknown', timestamp: null, source: ''}};
  const pencil = {type: 'cash' as const, id: 'p', name: 'Pencil', fiSelections: [], lease: null, price: 200000, down: 0, term: 36, aprBps: 0};
  const deal: import('@freedms/shared').DealView = {...base, kind: 'deal', vehicleId: vehicle.id, customerId: customer.id, leadId: null, type: 'cash', trade: null, pencils: [pencil], workingPencilId: pencil.id, status: 'approved', history: [], taxRateBps: 0, taxTradeDifference: false, docFee: 0, vehicle, customer};
  for (const outcome of [null, 'approved', 'conditioned', 'declined'] as const) {
    const jacket: import('@freedms/shared').DealJacket = {signatures: [], buyersOrderSignature: {status: 'awaiting', hash: ''}, compliance: {checklist: [], checks: [], complete: false}, deal, pencil, numbers: pencilMath(pencil, null, deal, vehicle, 'cash'), buyersGuide: {vehicle, asIs: true, dealerWarranty: null, manufacturerWarranty: null}, fiProducts: [], documents: [], checklist: [], payoffQuotes: [q],
      credit: outcome ? {status: 'decision-recorded', decisionOutcome: outcome, lenderName: 'Bank', applicantSsnLast4: '6789'} : null,
      adverseAction: outcome === 'declined' ? {applicantName: applicant.fullName, decidedAt: '2026-10-23T12:00:00Z', lenderName: 'Bank', reasons: ['credit-history']} : null};
    const html = renderPacket(jacket);
    assert.equal(html.includes('Adverse action notice'), outcome === 'declined');
    assert.doesNotMatch(html, /123-45-6789|123456789|<script>/);
    if (outcome === 'declined') { assert.match(html, /Credit history/); assert.match(html, /dealer’s manual decision/); }
  }
});
