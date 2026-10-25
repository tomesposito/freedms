import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportsP3Html } from '../src/reports-p3.js';
test('P3 report UI labels projections, missing flags, escaping and honest empty states',()=>{
  const empty={projection:null,basis:{from:'2026-10-01',to:'2026-10-24',sampleSize:0},method:'Local history',insufficientReason:'Need more history'};
  const departments={from:null,to:null,departments:[],totals:{income:0,expenses:0,grossProfit:0},locations:[]};
  const forecasts={inventory:empty,service:empty,parts:empty};
  const html=reportsP3Html({from:null,to:null,rows:[]},departments,forecasts);
  assert.match(html,/No RO labor/);assert.match(html,/No posted income/);assert.match(html,/No finalized ROs/);
  assert.equal(html.split('Projection — based on 2026-10-01 to 2026-10-24').length-1,3);
  assert.equal(html.split('Insufficient history').length-1,3);
  const known=reportsP3Html({from:null,to:null,rows:[{technicianId:'',technician:'<Unassigned>',soldHoursHundredths:150,flaggedHoursHundredths:null,efficiencyPercent:null,missingFlaggedLines:1,roCount:1}]},departments,forecasts);
  assert.match(known,/&lt;Unassigned&gt;/);assert.match(known,/1\.50/);assert.match(known,/<td>—<\/td>/);assert.doesNotMatch(known,/NaN|Infinity/);
});
