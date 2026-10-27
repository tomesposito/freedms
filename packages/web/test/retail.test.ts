import { brandLogoUrl } from '../src/brand.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuyerDealView, ShareResponse } from '@freedms/shared';
import { buyerHtml, responsesHtml } from '../src/retail.js';
test('buyer HTML escapes text and renders currency, choices and honest upload limits', () => {
  const d: BuyerDealView = {buyersOrderSignature: 'awaiting', documentsAwaitingSignature: 0, dealershipName: 'Dealer', customerName: '<script>buyer</script>', dealType: 'finance', vehicle: {year: 2020, make: 'A', model: 'B', trim: '<img src=x>', vin: 'VIN', stockNumber: 'Stock'}, price: 1000000, docFee: 10000, salesTax: 50000, fiProducts: [], fiRetailTotal: 0, trade: null, down: 100000, amountFinanced: 960000, monthlyPayment: 30000, totalPayments: 1080000, financeCharge: 120000, cashDue: 0, aprBps: 600, termMonths: 36, expiresAt: '2026-10-30T12:00:00Z', paymentOptions: [{id: '36-100000', kind: 'finance', termMonths: 36, down: 100000, monthlyPayment: 30000, amountDue: null}]};
  const html = buyerHtml(d, true); assert.ok(html.includes(`<img src="${brandLogoUrl}" alt="freeDMS">`)); assert.doesNotMatch(html.replace(`<img src="${brandLogoUrl}" alt="freeDMS">`, ''), /<script|<img|gross|cost/i); assert.match(html, /&lt;script/); assert.match(html, /&lt;img/); assert.match(html, /\$300\.00/); assert.match(html, /data-option="36-100000"/); assert.match(html, /40 KiB/); assert.match(html, /Local development link/);
});
test('dealer responses escape buyer text and show empty state', () => {
  const r: ShareResponse = {kind: 'share-response', id: 'r', tenantId: 'A', version: 1, createdAt: '2026-10-23T12:00:00Z', updatedAt: '', dealId: 'd', shareId: 's', responseKind: 'change-request', optionId: null, termMonths: null, down: 0, monthlyPayment: null, amountDue: null, message: '<img src=x onerror=alert(1)>'};
  assert.match(responsesHtml([]), /No buyer responses yet/); const html = responsesHtml([r]); assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); assert.match(html, /Requested a change/);
});
