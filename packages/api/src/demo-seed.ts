import type { AuthClaims, DealView, Lead, VehicleView } from '@freedms/shared';
import type { RepositoryFactory } from './repository.js';
import { createHandler } from './handler.js';

/** Explicit operator action only; never imported by Lambda or run on application startup. */
export async function seedDemo(repositories: RepositoryFactory, tenantId: string, userId: string, now = new Date()) {
  const repo = repositories.forTenant(tenantId), member = await repo.membership(userId);
  if (!member?.active || member.role !== 'admin' || !await repo.tenant()) throw new Error('Demo loading requires an active administrator');
  const allowed = new Set(['tenant.created', 'user.added', 'invite.created', 'invite.updated', 'invite.accepted']);
  if ((await repo.events()).some(event => !allowed.has(event.type)) || (await repo.list({})).length ||
    (await repo.crmList('customer')).length || (await repo.webhookEndpoints()).length)
    throw new Error('Demo loading requires an empty workspace with no webhooks; no records were changed');
  const handle = createHandler(repositories, {decode: async () => { throw new Error('Demo never contacts VIN services'); }}, () => now,
    undefined, undefined, undefined, async () => { throw new Error('Demo never delivers webhooks'); });
  const claims: AuthClaims = {sub: userId, 'custom:tenant_id': tenantId, iss: 'operator', aud: 'operator', exp: now.getTime() / 1000 + 3600, token_use: 'id'};
  const call = async <T>(method: string, path: string, body: unknown): Promise<T> => {
    const result = await handle({method, path, body: JSON.stringify(body), claims});
    if (result.statusCode >= 400) throw new Error(`Demo stopped at ${method} ${path}: ${JSON.parse(result.body).error.code}. Inspect partial demo records before retrying.`);
    return JSON.parse(result.body).data;
  };
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const inventory = [
    [2022, 'Toyota', 'Camry', 'SE', 2499500, 2090000, 12],
    [2021, 'Honda', 'CR-V', 'EX', 2799500, 2350000, 35],
    [2020, 'Ford', 'F-150', 'XLT', 3199500, 2750000, 62],
    [2023, 'Mazda', 'CX-5', 'Select', 2699500, 2280000, 5],
    [2019, 'Subaru', 'Outback', 'Premium', 1999500, 1630000, 48],
    [2022, 'Hyundai', 'Elantra', 'SEL', 1799500, 1420000, 21]
  ] as const;
  const vehicles: VehicleView[] = [];
  for (const [i, [year, make, model, trim, listPrice, cost, age]] of inventory.entries()) {
    vehicles.push(await call<VehicleView>('POST', '/vehicles', {mileage: null, stockNumber: `DEMO-${101 + i}`,
      vin: `DEMAA00A0AA0000${i + 10}`, year, make, model, trim, status: i === 4 ? 'in recon' : 'available', listPrice, cost,
      reconCosts: [{description: 'Demo inspection and detailing', amount: 27500}], dateStocked: daysAgo(age), location: 'Demo lot',
      notes: 'FICTIONAL DEMO RECORD. VIN is synthetic; do not submit to lenders, listing feeds, or external services.'}));
  }
  const leads: Lead[] = [];
  for (const [i, name] of ['Alex Demo', 'Jordan Example', 'Casey Sample', 'Morgan Demo'].entries()) {
    const result = await call<{lead: Lead}>('POST', '/leads', {customer: {name, email: `buyer${i + 1}@example.test`, phone: '', address: '',
      notes: 'FICTIONAL DEMO CUSTOMER. No real contact information.', consent: {status: 'unknown', timestamp: null, source: ''}},
      source: i % 2 ? 'phone' : 'walk-in', vehicleId: vehicles[i].id});
    leads.push(result.lead);
  }
  await call('PUT', `/leads/${leads[1].id}`, {version: 1, stage: 'contacted', assigneeId: userId, vehicleId: vehicles[1].id});
  await call('PUT', `/leads/${leads[2].id}`, {version: 1, stage: 'appointment', assigneeId: userId, vehicleId: vehicles[2].id});
  for (const i of [0, 1, 3]) {
    let deal = await call<DealView>('POST', '/deals', {vehicleId: vehicles[i].id, customerId: leads[i].customerId, leadId: leads[i].id, type: i === 3 ? 'cash' : 'finance'});
    if (i === 3) {
      deal = await call<DealView>('PUT', `/deals/${deal.id}`, {version: deal.version, status: 'approved'});
      await call('PUT', `/deals/${deal.id}`, {version: deal.version, status: 'sold'});
    }
  }
  for (const [partNumber, description, costCents, retailPriceCents, quantityOnHand] of [
    ['DEMO-OIL', 'Demo oil filter', 450, 1299, 12], ['DEMO-WIPER', 'Demo wiper blade', 900, 2499, 3], ['DEMO-AIR', 'Demo cabin air filter', 1200, 2999, 8]
  ] as const) await call('POST', '/parts', {partNumber, description, costCents, retailPriceCents, quantityOnHand, binLocation: 'DEMO-A1', reorderPoint: 5});
  await call('POST', '/service/repair-orders', {customerId: leads[2].customerId, vehicleId: vehicles[2].id, advisorId: userId,
    concern: 'Demo: inspect vibration and perform oil service', payType: 'customer-pay', lineItems: [
      {id: 'demo-labor', kind: 'labor', description: 'Demo diagnosis and inspection', laborHoursHundredths: 150, laborRateCents: 12500, quantity: null, unitPriceCents: null}
    ]});
  await call('POST', '/service/appointments', {customerId: leads[2].customerId, vehicleId: vehicles[2].id, advisorId: userId,
    concern: 'Demo scheduled inspection', scheduledStart: new Date(now.getTime() + 86400000).toISOString(), scheduledEnd: new Date(now.getTime() + 90000000).toISOString()});
  return {vehicles: 6, customers: 4, leads: 4, deals: 3, parts: 3, repairOrders: 1, appointments: 1};
}
