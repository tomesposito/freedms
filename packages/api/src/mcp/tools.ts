import { documentTypes, webhookEventTypes, vehicleStatuses, reportDatasets, accountTypes, appointmentStatuses, repairOrderStatuses, repairOrderPayTypes, serviceSkills, communicationTypes, dealStatuses, fiCategories, housingStatuses, leadSources, leadStages } from '@freedms/shared';
const string = {type: 'string'}, integer = {type: 'integer'}, money = {type: 'integer', minimum: 0, description: 'Integer USD cents'};
const signedMoney = {type: 'integer', description: 'Signed integer USD cents'};
const payableFields = {amount: money, party: string, reference: string, dueDate: string, offsetAccountId: string, vehicleId: {type: ['string', 'null']}};
const paymentFields = {id: string, amount: money, cashAccountId: string, reference: string};
const periodVersion = {id: string, version: integer};
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
const dealType = {type: 'string', enum: ['cash', 'finance', 'lease']};
const fiSelections = {type: 'array', maxItems: 50, items: {type: 'object', properties: {
  productId: string, status: {type: 'string', enum: ['accepted', 'declined']},
}, required: ['productId', 'status'], additionalProperties: false}};
const lease = {type: ['object', 'null'], properties: {
  msrp: money, residualPercentBps: integer, residualAmount: money, moneyFactorMicro: integer,
  acquisitionFee: money, securityDeposit: money, milesPerYear: integer,
}, required: ['msrp', 'moneyFactorMicro', 'acquisitionFee', 'securityDeposit', 'milesPerYear'],
  oneOf: [{type: 'object', required: ['residualPercentBps']}, {type: 'object', required: ['residualAmount']}, {type: 'null'}], additionalProperties: false};
const pencilFields = {type: dealType, name: string, price: money, down: money, term: integer, aprBps: integer,
  fiSelections, lease, sourcePencilId: string};
const requiredPencil = ['name', 'price', 'down', 'term', 'aprBps'];
const tradeFields = {year: string, make: string, model: string, vin: string, allowance: money, payoff: money, actualCashValue: money};
const fiFields = {name: string, category: {type: 'string', enum: fiCategories}, cost: money, retailPrice: money, termNotes: string, active: {type: 'boolean'}};
const applicant = {type: 'object', properties: {
  fullName: string, dateOfBirth: string, ssn: string, address: string, phone: string, email: string,
  housingStatus: {type: 'string', enum: housingStatuses}, monthlyHousingPayment: money, yearsAtAddress: integer,
  employerName: string, jobTitle: string, yearsEmployed: integer, grossMonthlyIncome: money, otherMonthlyIncome: money, otherIncomeSource: string,
}, required: ['fullName', 'dateOfBirth', 'address', 'housingStatus', 'monthlyHousingPayment', 'yearsAtAddress', 'yearsEmployed', 'grossMonthlyIncome', 'otherMonthlyIncome'], additionalProperties: false};
// Certification and decision attestations are human-only; never expose status or decision here.
const creditFields = {applicant, coApplicant: {...applicant, type: ['object', 'null']}, consentAt: string};
const skill = {type: 'string', enum: serviceSkills};
const dispatchFields = {technicianId: nullableString, requiredSkill: {...skill, type: ['string', 'null'], enum: [...serviceSkills, null]},
  acknowledgeSkillMismatch: {type: 'boolean', description: 'Explicitly acknowledge assigning a technician without the required skill.'}};
const serviceFields = {vehicleId: nullableString, vehicleDescription: string, advisorId: nullableString, concern: string, ...dispatchFields};
const appointmentFields = {...serviceFields, scheduledStart: string, scheduledEnd: string, status: {type: 'string', enum: appointmentStatuses}};
const stockAcknowledgements = {
  allowNegativeStock: {type: 'boolean', description: 'Explicitly allow this operation to drive stock below zero.'},
  acknowledgeReservedStock: {type: 'boolean', description: 'Explicitly acknowledge consuming stock reserved for other repair orders’ special orders; recorded with your user identity.'},
};
const roStatus = {type: 'string', enum: repairOrderStatuses};
const roFields = {...serviceFields, payType: {type: 'string', enum: repairOrderPayTypes},
  lineItems: {type: 'array', maxItems: 100, description: 'Full replacement array; retain existing lines to preserve them.', items: {type: 'object', properties: {
    id: string, kind: {type: 'string', enum: ['labor', 'parts']}, description: string,
    skill: {...skill, type: ['string', 'null'], enum: [...serviceSkills, null]}, flaggedHoursHundredths: {type: ['integer', 'null'], minimum: 0, maximum: 100000},
    laborHoursHundredths: {type: ['integer', 'null'], minimum: 1, maximum: 100000}, laborRateCents: {...money, type: ['integer', 'null']},
    quantity: {type: ['integer', 'null'], minimum: 1, maximum: 100000}, unitPriceCents: {...money, type: ['integer', 'null']}, partId: nullableString,
  }, required: ['kind', 'description', 'laborHoursHundredths', 'quantity', 'unitPriceCents'], additionalProperties: false}},
  inspection: {type: 'array', maxItems: 100, items: {type: 'object', properties: {
    id: string, label: string, status: {type: 'string', enum: ['ok', 'monitor', 'needs-attention']}, skill, laborHoursHundredths: integer, partId: nullableString,
  }, required: ['label', 'status'], additionalProperties: false}},
  recommendationDecision: {type: 'object', properties: {id: string, status: {type: 'string', enum: ['approved', 'declined']}}, required: ['id', 'status'], additionalProperties: false},
};
const technicianFields = {name: string, skills: {type: 'array', maxItems: serviceSkills.length, items: skill}};
const partFields = {partNumber: string, description: string, location: string, binLocation: string, costCents: money,
  retailPriceCents: money, quantityOnHand: integer, reorderPoint: integer};
const poLines = {type: 'array', minItems: 1, maxItems: 8, items: {type: 'object', properties: {
  partId: string, quantityOrdered: integer, costCents: money, specialOrder: {type: ['object', 'null'], properties: {
    customerId: nullableString, repairOrderId: nullableString,
  }, additionalProperties: false},
}, required: ['partId', 'quantityOrdered', 'costCents'], additionalProperties: false}};
const documentType = {type: 'string', enum: documentTypes};
const confirm = {type: 'boolean', description: 'Explicit confirmation of this destructive operation; must be true.'};
const userFields = {name: string, email: string, role: {type: 'string', enum: ['admin', 'staff']}};
const webhookFields = {url: string, eventTypes: {type: 'array', items: {type: 'string', enum: webhookEventTypes}}};
const reportFields = {name: string, dataset: {type: 'string', enum: Object.keys(reportDatasets)}, columns: {type: 'array', items: string}, ...range, groupBy: string};
function tool(name: string, path: string, properties: Record<string, unknown> = {}, required: string[] = [], method = 'GET', description = name.replaceAll('_', ' ')) {
  return {name, path, method, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}};
}
export const tools = [

  tool('search_documents', '/documents', {name: string, type: documentType, buyer: string, ...range}),
  tool('list_past_retention_documents', '/documents/past-retention'),
  tool('get_document_retention', '/documents/retention'),
  tool('get_document_content', '/deals/:id/documents/:documentId/content', {id: string, documentId: string}, ['id', 'documentId']),
  tool('upload_document', '/deals/:id/documents', {id: string, name: string, type: documentType, content: string}, ['id', 'name', 'type', 'content'], 'POST'),
  tool('update_document_retention', '/documents/retention', {version: integer, retentionDays: {type: ['integer', 'null'], minimum: 1, maximum: 36500}}, ['version', 'retentionDays'], 'PUT'),
  tool('dispose_document', '/documents/:id/dispose', {...periodVersion, confirm}, ['id', 'version', 'confirm'], 'POST'),
  tool('list_users', '/admin/users'),
  tool('list_invites', '/admin/invites'),
  tool('create_user', '/admin/users', userFields, Object.keys(userFields), 'POST'),
  tool('invite_user', '/admin/invites', userFields, Object.keys(userFields), 'POST'),
  tool('set_user_role', '/admin/users/:id/role', {...periodVersion, role: userFields.role}, ['id', 'version', 'role'], 'POST'),
  tool('deactivate_user', '/admin/users/:id/deactivate', {...periodVersion, confirm}, ['id', 'version', 'confirm'], 'POST'),
  tool('reactivate_user', '/admin/users/:id/reactivate', periodVersion, ['id', 'version'], 'POST'),
  tool('reissue_invite', '/admin/invites/:id/reissue', periodVersion, ['id', 'version'], 'POST'),
  tool('revoke_invite', '/admin/invites/:id/revoke', {...periodVersion, confirm}, ['id', 'version', 'confirm'], 'POST'),
  tool('get_workspace_settings', '/settings'),
  tool('list_webhook_endpoints', '/webhooks/endpoints'),
  tool('list_webhook_deliveries', '/webhooks/deliveries'),
  tool('get_feed_config', '/feeds/config'),
  tool('list_feed_runs', '/feeds/runs'),
  tool('update_workspace_settings', '/settings', {version: integer, taxRateBps: integer, taxTradeDifference: {type: 'boolean'}, docFee: money, commissionRateBps: integer, shareExpiryDays: integer}, ['version', 'taxRateBps', 'taxTradeDifference', 'docFee', 'commissionRateBps', 'shareExpiryDays'], 'PUT'),
  tool('create_webhook_endpoint', '/webhooks/endpoints', webhookFields, ['url', 'eventTypes'], 'POST'),
  tool('update_webhook_endpoint', '/webhooks/endpoints/:id', {...periodVersion, ...webhookFields, enabled: {type: 'boolean'}}, ['id', 'version'], 'PUT'),
  tool('rotate_webhook_secret', '/webhooks/endpoints/:id/rotate-secret', periodVersion, ['id', 'version'], 'POST'),
  tool('dispatch_webhooks', '/webhooks/dispatch', {}, [], 'POST'),
  tool('update_feed_config', '/feeds/config', {formats: {type: 'array', items: {type: 'string', enum: ['csv', 'json']}}, includedStatuses: {type: 'array', items: {type: 'string', enum: vehicleStatuses}}, requirePrice: {type: 'boolean'}, schedule: {type: 'string', enum: ['manual', 'daily', 'weekly']}}, ['formats', 'includedStatuses', 'requirePrice', 'schedule'], 'PUT'),
  tool('generate_feed', '/feeds/generate', {}, [], 'POST'),
  tool('download_feed_run_csv', '/feeds/runs/:id.csv', {id: string}, ['id']),
  tool('download_feed_run_json', '/feeds/runs/:id.json', {id: string}, ['id']),
  tool('list_saved_reports', '/reports/saved'),
  tool('get_saved_report', '/reports/saved/:id', {id: string}, ['id']),
  tool('create_saved_report', '/reports/saved', reportFields, ['name', 'dataset', 'columns'], 'POST'),
  tool('update_saved_report', '/reports/saved/:id', {...periodVersion, ...reportFields}, ['id', 'version', 'name', 'dataset', 'columns'], 'PUT'),
  tool('export_custom_report_csv', '/reports/custom.csv', {dataset: reportFields.dataset, columns: string, ...range, groupBy: string}, ['dataset', 'columns'], 'GET', 'Export CSV using a saved report definition, with columns joined by commas, exactly as the UI does.'),
  tool('export_turn_report_csv', '/reports/turn.csv', range),
  tool('export_fi_report_csv', '/reports/fi.csv', range),
  tool('export_sales_report_csv', '/reports/sales.csv', range),
  tool('export_inventory_report_csv', '/reports/inventory.csv'),
  tool('export_lead_report_csv', '/reports/leads.csv'),
  tool('export_accounting_report_csv', '/reports/accounting.csv', range),


  tool('list_gl_accounts', '/accounting/accounts'),
  tool('create_gl_account', '/accounting/accounts', {code: string, name: string, type: {type: 'string', enum: accountTypes}, active: {type: 'boolean'}}, ['code', 'name', 'type'], 'POST'),
  tool('update_gl_account', '/accounting/accounts/:id', {...periodVersion, name: string, active: {type: 'boolean'}}, ['id', 'version', 'name', 'active'], 'PUT'),
  tool('list_journal_entries', '/accounting/journal', {...range, accountId: string, dealId: string, repairOrderId: string, partsSaleId: string}),
  // The UI reverses on a single click without a confirmation dialog; no confirm argument is needed.
  tool('reverse_journal_entry', '/accounting/journal/:id/reverse', {id: string}, ['id'], 'POST'),
  // Deal posting remains automatic via set_deal_status; there is deliberately no separate posting tool.
  tool('get_deal_accounting', '/accounting/deals/:id', {id: string}, ['id']),
  tool('get_commissions', '/accounting/commissions', range),
  tool('get_account_balances', '/accounting/balances'),
  tool('get_departmental_statement', '/accounting/departmental', range),
  tool('get_ap_aging', '/accounting/ap', {asOf: string}),
  tool('get_ar_aging', '/accounting/ar', {asOf: string}),
  tool('create_ap_bill', '/accounting/ap', payableFields, ['amount', 'party', 'reference', 'dueDate', 'offsetAccountId'], 'POST'),
  tool('create_ar_invoice', '/accounting/ar', payableFields, ['amount', 'party', 'reference', 'dueDate', 'offsetAccountId'], 'POST'),
  tool('record_ap_payment', '/accounting/ap/:id/payments', paymentFields, Object.keys(paymentFields), 'POST', 'Record payment against an item id from get_ap_aging.'),
  tool('record_ar_payment', '/accounting/ar/:id/payments', paymentFields, Object.keys(paymentFields), 'POST', 'Record payment against an item id from get_ar_aging.'),
  tool('list_cash_accounts', '/accounting/cash'),
  tool('get_cash_register', '/accounting/cash/:id', {id: string}, ['id']),
  tool('create_cash_account', '/accounting/cash', {code: string, name: string}, ['code', 'name'], 'POST'),
  tool('list_reconciliations', '/accounting/reconciliations'),
  tool('get_reconciliation', '/accounting/reconciliations/:id', {id: string}, ['id']),
  tool('create_reconciliation', '/accounting/reconciliations', {accountId: string, ...range, opening: signedMoney, closing: signedMoney}, ['accountId', 'from', 'to', 'opening', 'closing'], 'POST'),
  tool('preview_reconciliation_statement', '/accounting/reconciliations/:id/preview', {id: string, csv: string}, ['id', 'csv'], 'POST', 'Preview statement CSV (id,date,description,amountCents); changes nothing and returns the token required for import.'),
  tool('import_reconciliation_statement', '/accounting/reconciliations/:id/import', {...periodVersion, csv: string, previewToken: string}, ['id', 'version', 'csv', 'previewToken'], 'POST'),
  tool('add_reconciliation_line', '/accounting/reconciliations/:id/lines', {...periodVersion, line: {type: 'object', properties: {id: string, date: string, description: string, amount: {...signedMoney, not: {const: 0}}}, required: ['id', 'date', 'description', 'amount'], additionalProperties: false}}, ['id', 'version', 'line'], 'POST'),
  tool('amend_reconciliation', '/accounting/reconciliations/:id/amend', {...periodVersion, closing: signedMoney}, ['id', 'version', 'closing'], 'POST'),
  tool('remove_reconciliation_line', '/accounting/reconciliations/:id/remove', {...periodVersion, lineId: string}, ['id', 'version', 'lineId'], 'POST'),
  tool('match_reconciliation_line', '/accounting/reconciliations/:id/match', {...periodVersion, lineId: string, registerId: nullableString}, ['id', 'version', 'lineId', 'registerId'], 'POST', 'Match a statement line to a cash register entry; pass null to unmatch.'),
  tool('close_reconciliation', '/accounting/reconciliations/:id/close', periodVersion, ['id', 'version'], 'POST'),
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
  tool('list_fi_products', '/fi-products'),
  tool('get_credit_application', '/deals/:id/credit-application', {id: string}, ['id']),
  tool('get_deal_jacket', '/deals/:id/jacket', {id: string}, ['id']),
  // These desking, deal, F&I and credit operations ask for no UI confirmation; no confirm argument is needed.
  tool('create_deal', '/deals', {vehicleId: string, customerId: string, leadId: nullableString, type: dealType}, ['vehicleId', 'customerId', 'type'], 'POST'),
  tool('update_deal', '/deals/:id', {id: string, version: integer, type: dealType,
    trade: {type: ['object', 'null'], properties: tradeFields, required: Object.keys(tradeFields), additionalProperties: false}, docFee: money,
    pencils: {type: 'array', items: {type: 'object', properties: {id: string, ...pencilFields}, required: ['id', ...requiredPencil], additionalProperties: false}},
    workingPencilId: string}, ['id', 'version'], 'PUT'),
  tool('set_deal_status', '/deals/:id', {id: string, version: integer, status: {type: 'string', enum: dealStatuses}}, ['id', 'version', 'status'], 'PUT'),
  tool('create_pencil', '/deals/:id', {id: string, version: integer, pencilId: string, ...pencilFields}, ['id', 'version', 'pencilId', ...requiredPencil], 'PUT'),
  tool('update_pencil', '/deals/:id', {id: string, version: integer, pencilId: string, ...pencilFields}, ['id', 'version', 'pencilId', ...requiredPencil], 'PUT'),
  tool('set_working_pencil', '/deals/:id', {id: string, version: integer, pencilId: string}, ['id', 'version', 'pencilId'], 'PUT'),
  tool('create_fi_product', '/fi-products', fiFields, ['name', 'category', 'cost', 'retailPrice', 'termNotes'], 'POST'),
  tool('update_fi_product', '/fi-products/:id', {id: string, version: integer, ...fiFields}, ['id', 'version', ...Object.keys(fiFields)], 'PUT'),
  tool('create_credit_application', '/deals/:id/credit-application', {id: string, ...creditFields}, ['id', 'applicant', 'consentAt'], 'POST'),
  tool('update_credit_application', '/deals/:id/credit-application', {id: string, version: integer, ...creditFields}, ['id', 'version', ...Object.keys(creditFields)], 'PUT'),
  // Service/parts confirmations are explicit acknowledgements, never implicit overrides.
  tool('create_appointment', '/service/appointments', {customerId: string, ...appointmentFields}, ['customerId', 'scheduledStart', 'scheduledEnd'], 'POST'),
  tool('update_appointment', '/service/appointments/:id', {id: string, version: integer, ...appointmentFields}, ['id', 'version'], 'PUT'),
  tool('create_repair_order', '/service/repair-orders', {customerId: string, appointmentId: nullableString, ...roFields}, ['payType'], 'POST', 'Create a repair order with a customerId or an existing appointmentId.'),
  tool('update_repair_order', '/service/repair-orders/:id', {id: string, version: integer, ...roFields, status: roStatus, ...stockAcknowledgements}, ['id', 'version'], 'PUT'),
  tool('set_repair_order_status', '/service/repair-orders/:id', {id: string, version: integer, status: roStatus, ...stockAcknowledgements}, ['id', 'version', 'status'], 'PUT'),
  tool('create_technician', '/service/technicians', technicianFields, ['name', 'skills'], 'POST'),
  tool('update_technician', '/service/technicians/:id', {id: string, version: integer, ...technicianFields}, ['id', 'version'], 'PUT'),
  tool('create_labor_rate', '/service/labor-rates', {skill, laborRateCents: money}, ['skill', 'laborRateCents'], 'POST'),
  tool('update_labor_rate', '/service/labor-rates/:id', {id: skill, version: integer, skill, laborRateCents: money}, ['id', 'version'], 'PUT', 'Update a labor rate by its skill id; the skill cannot change.'),
  tool('create_part', '/parts', partFields, Object.keys(partFields).filter(k => k !== 'location'), 'POST'),
  tool('update_part', '/parts/:id', {id: string, version: integer, ...partFields}, ['id', 'version'], 'PUT'),
  tool('record_part_sale', '/parts/sales', {partId: string, quantity: integer, customerId: nullableString, unitPriceCents: money, allowNegativeStock: stockAcknowledgements.allowNegativeStock}, ['partId', 'quantity'], 'POST'),
  tool('create_purchase_order', '/parts/purchase-orders', {vendorName: string, lines: poLines}, ['vendorName', 'lines'], 'POST'),
  tool('receive_purchase_order', '/parts/purchase-orders/:id/receive', {id: string, version: integer,
    lines: {type: 'array', minItems: 1, maxItems: 8, items: {type: 'object', properties: {lineId: string, quantity: integer}, required: ['lineId', 'quantity'], additionalProperties: false}}}, ['id', 'version', 'lines'], 'POST'),
  tool('fulfill_special_order', '/parts/purchase-orders/:id/special-fulfill', {id: string, version: integer, lineId: string}, ['id', 'version', 'lineId'], 'POST'),
  tool('create_part_return', '/parts/returns', {partId: string, vendorName: string, quantity: integer, reason: string, purchaseOrderId: nullableString, costCents: money}, ['partId', 'vendorName', 'quantity', 'reason'], 'POST'),
  tool('update_pricing_matrix', '/parts/pricing-matrix', {version: integer, enabled: {type: 'boolean'}, brackets: {type: 'array', maxItems: 10,
    items: {type: 'object', properties: {maxCostCents: {...money, type: ['integer', 'null']}, markupBps: integer}, required: ['maxCostCents', 'markupBps'], additionalProperties: false}}}, ['version', 'enabled', 'brackets'], 'PUT'),
  tool('create_part_reservation', '/parts/reservations', {partId: string, repairOrderId: string, customerId: nullableString, quantity: integer}, ['partId', 'repairOrderId', 'quantity'], 'POST'),
  tool('release_part_reservation', '/parts/reservations/:id/release', {id: string, version: integer, quantity: integer}, ['id', 'version'], 'POST'),
];
