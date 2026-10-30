import { communicationTypes, leadSources, leadStages } from '@freedms/shared';
const string = {type: 'string'}, integer = {type: 'integer'}, money = {type: 'integer', minimum: 0, description: 'Integer USD cents'};
const page = {limit: integer, offset: integer}, range = {from: string, to: string};
export const vehicleFields = {
  stockNumber: string, vin: string, year: integer, make: string, model: string, trim: string,
  mileage: {type: ['integer', 'null']}, status: {type: 'string', enum: ['available', 'reserved', 'sold', 'in recon']},
  listPrice: money, cost: money, reconCosts: {type: 'array', items: {type: 'object', properties: {description: string, amount: money}, required: ['description', 'amount'], additionalProperties: false}},
  dateStocked: string, location: string, notes: string,
};
const requiredVehicleFields = Object.keys(vehicleFields).filter(key => key !== 'mileage');
const nullableString = {type: ['string', 'null']};
const customerFields = {
  name: string, phone: string, email: string, address: string,
  consent: {type: 'object', properties: {
    status: {type: 'string', enum: ['unknown', 'granted', 'revoked']}, timestamp: nullableString, source: string,
  }, required: ['status', 'timestamp', 'source'], additionalProperties: false}, notes: string,
};
const customer = {type: 'object', properties: customerFields, required: Object.keys(customerFields), additionalProperties: false};
const leadFields = {
  customer, vehicleId: nullableString, vehicleDescription: string, source: {type: 'string', enum: leadSources},
  sourceDetail: string, assigneeId: nullableString,
};
const leadStage = {type: 'string', enum: leadStages}, communicationType = {type: 'string', enum: communicationTypes};
function tool(name: string, path: string, properties: Record<string, unknown> = {}, required: string[] = [], method = 'GET', description = name.replaceAll('_', ' ')) {
  return {name, path, method, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}};
}
export const tools = [
  tool('search_vehicles', '/vehicles', {...page, status: vehicleFields.status, search: string}),
  tool('get_vehicle', '/vehicles/:id', {id: string}, ['id']),
  tool('list_leads', '/leads', {...page, search: string, stage: string, assignee: string}),
  tool('get_lead', '/leads/:id', {id: string}, ['id']),
  tool('list_customers', '/customers', {search: string}), tool('get_customer', '/customers/:id', {id: string}, ['id']),
  tool('list_deals', '/deals', {status: string}), tool('get_deal', '/deals/:id', {id: string}, ['id']),
  tool('get_service_board', '/service/board', {...page, date: string}),
  tool('list_parts', '/parts', {search: string, reorder: string, location: string}),
  tool('get_sales_report', '/reports/sales', range), tool('get_inventory_aging', '/reports/inventory'),
  tool('get_trial_balance', '/accounting/trial-balance', range), tool('get_lead_summary', '/reports/leads'),
  tool('create_vehicle', '/vehicles', vehicleFields, requiredVehicleFields, 'POST'),
  tool('update_vehicle', '/vehicles/:id', {...vehicleFields, id: string, version: integer}, [...requiredVehicleFields, 'id', 'version'], 'PUT'),
  tool('set_vehicle_status', '/vehicles/:id', {id: string, version: integer, status: vehicleFields.status}, ['id', 'version', 'status'], 'PUT'),
  tool('import_vehicles', '/vehicles/import', {csv: string, enrich: {type: 'boolean'}}, ['csv'], 'POST',
    'Import inventory using the existing CSV format (CSV cost/listPrice cells are dollars, converted to integer cents by the shared importer).'),
  // These CRM operations have no destructive/deletion confirmation in the UI, so no confirm argument is needed.
  tool('create_lead', '/leads', {customerId: string, ...leadFields}, ['source'], 'POST',
    'Create a lead with either an existing customerId or a new customer, using the UI consent data.'),
  tool('update_lead', '/leads/:id', {id: string, version: integer, stage: leadStage, assigneeId: nullableString, vehicleId: nullableString},
    ['id', 'version', 'stage', 'assigneeId', 'vehicleId'], 'PUT', 'Update the full lead form with optimistic version checking.'),
  tool('set_lead_stage', '/leads/:id', {id: string, version: integer, stage: leadStage}, ['id', 'version', 'stage'], 'PUT',
    'Change lead stage, preserving its assignee and vehicle.'),
  tool('assign_lead', '/leads/:id', {id: string, version: integer, assigneeId: nullableString}, ['id', 'version', 'assigneeId'], 'PUT',
    'Assign a lead to an active workspace member, or pass null to unassign; preserve stage and vehicle.'),
  tool('add_lead_note', '/leads/:id/communications', {id: string, version: integer, type: communicationType,
    direction: {type: 'string', enum: ['inbound', 'outbound']}, summary: string, timestamp: string},
    ['id', 'version', 'type', 'direction', 'summary', 'timestamp'], 'POST', 'Log a communication/note on the lead exactly as the UI does. Nothing is sent.'),
  tool('schedule_follow_up', '/leads/:id/follow-ups', {id: string, version: integer, type: communicationType, dueAt: string},
    ['id', 'version', 'type', 'dueAt'], 'POST', 'Schedule a lead follow-up at a UTC timestamp.'),
  tool('update_follow_up', '/leads/:id/follow-ups/:taskId', {id: string, taskId: string, version: integer, done: {type: 'boolean'}, dueAt: string, dismissed: {type: 'boolean'}},
    ['id', 'taskId', 'version'], 'PUT', 'Update exactly one follow-up action: done, dueAt, or dismissed.'),
  tool('create_customer', '/customers', customerFields, Object.keys(customerFields), 'POST', 'Create a customer and record dealer-collected TCPA consent exactly as in the UI.'),
  tool('update_customer', '/customers/:id', {id: string, version: integer, ...customerFields}, ['id', 'version', ...Object.keys(customerFields)], 'PUT',
    'Update the full customer form, including dealer-collected TCPA consent, with optimistic version checking.'),
  tool('quick_entry_draft', '/quick-entry/lead', {text: string}, ['text'], 'POST', 'Return an AI lead draft for review; saves nothing.'),
  tool('quick_entry_confirm', '/leads', leadFields, ['customer', 'source'], 'POST',
    'Create the lead from a reviewed quick-entry draft. This is the step that saves; the draft step alone saves nothing.'),
];
