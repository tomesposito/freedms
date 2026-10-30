const string = {type: 'string'}, integer = {type: 'integer'}, money = {type: 'integer', minimum: 0, description: 'Integer USD cents'};
const page = {limit: integer, offset: integer}, range = {from: string, to: string};
export const vehicleFields = {
  stockNumber: string, vin: string, year: integer, make: string, model: string, trim: string,
  mileage: {type: ['integer', 'null']}, status: {type: 'string', enum: ['available', 'reserved', 'sold', 'in recon']},
  listPrice: money, cost: money, reconCosts: {type: 'array', items: {type: 'object', properties: {description: string, amount: money}, required: ['description', 'amount'], additionalProperties: false}},
  dateStocked: string, location: string, notes: string,
};
const requiredVehicleFields = Object.keys(vehicleFields).filter(key => key !== 'mileage');
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
];
