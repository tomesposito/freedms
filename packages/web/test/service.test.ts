import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appointmentStatuses, appointmentStatusLabels, lineItemAmountCents, repairOrderTotals, type ServiceAppointment, type ServiceBoardDay, type RepairOrderView, type RepairOrderLineItem } from '@freedms/shared';
import { serviceBoardHtml, repairOrderLinesHtml, serviceHistoryHtml } from '../src/service.js';
import { currency } from '../src/format.js';
const items: RepairOrderLineItem[] = [{id:'l',kind:'labor',description:'<script>',laborHoursHundredths:255,laborRateCents:12345,quantity:null,unitPriceCents:null},{id:'p',kind:'parts',description:'Filter',laborHoursHundredths:null,laborRateCents:null,quantity:3,unitPriceCents:1234}];
const ro = {id:'ro',createdAt:'2026-10-24T10:00:00Z',customerName:'<img>',concern:'<script>',status:'open',payType:'customer-pay',lineItems:items,totals:repairOrderTotals(items)} as RepairOrderView;
test('Service board labels every status, counts appointments, escapes text and shows RO totals', () => {
  const a = {id:'appointment',customerName:'<img>',concern:'<script>',vehicleDescription:'<b>',advisorId:'advisor',scheduledStart:'2026-10-24T09:00:00Z',scheduledEnd:'2026-10-24T10:00:00Z',status:'scheduled'} as ServiceAppointment;
  const byStatus = Object.fromEntries(appointmentStatuses.map(s=>[s,s==='scheduled'?[a]:[]])) as ServiceBoardDay['byStatus'];
  const html = serviceBoardHtml({date:'2026-10-24',appointments:[a],byStatus,repairOrders:[ro]},[{id:'advisor',name:'<advisor>'}]);
  for (const status of appointmentStatuses) assert.ok(html.includes(`${appointmentStatusLabels[status]} (${status==='scheduled'?1:0})`));
  assert.doesNotMatch(html,/<img>|<script>|<b>|<advisor>/); assert.match(html,/&lt;script&gt;/); assert.ok(html.includes(currency(repairOrderTotals(items).totalCents))); assert.match(html,/#\/service\/appointments\/appointment/);
  const empty = serviceBoardHtml({date:'2026-10-24',appointments:[],byStatus:Object.fromEntries(appointmentStatuses.map(s=>[s,[]])) as ServiceBoardDay['byStatus'],repairOrders:[]});
  assert.match(empty,/No service appointments for this day/); assert.match(empty,/Schedule appointment/); assert.match(empty,/Open walk-in repair order/);
});
test('Repair-order HTML reconciles line amounts and totals and history has honest empty states', () => {
  const html = repairOrderLinesHtml(items); for (const item of items) assert.ok(html.includes(currency(lineItemAmountCents(item))));
  const totals = repairOrderTotals(items); for (const amount of Object.values(totals)) assert.ok(html.includes(currency(amount)));
  assert.match(html,/2\.55/); assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script>/);
  assert.match(serviceHistoryHtml([]),/No service history yet\./); const history = serviceHistoryHtml([ro]); assert.match(history,/#\/service\/repair-orders\/ro/); assert.doesNotMatch(history,/<img>|<script>/);
});
test('Service navigation, history sections and form route are wired into vehicle/customer surfaces', () => {
  const read = (name:string) => readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8');
  const main=read('main'),crm=read('crm'),service=read('service');
  assert.match(main,/<a href="#\/deals">Deals<\/a><a href="#\/service">Service<\/a><a href="#\/accounting">/);
  for (const [source,scope] of [[main,'vehicleId'],[crm,'customerId']]) { assert.ok(source.includes(`/service/repair-orders?${scope}=`)); assert.match(source,/<h2>Service history<\/h2>\$\{serviceHistoryHtml\(serviceHistory\)\}/); }
  assert.match(main,/serviceRoute\(parts/); assert.match(service,/repair-orders\/new\/\$\{encodeURIComponent\(a.id\)\}/); assert.doesNotMatch(service,/disabled/);
});
