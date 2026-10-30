/** Operator-only bootstrap. Not bundled into Lambda; no public provisioning endpoint. */
import { randomUUID } from 'node:crypto';
import { DynamoRepositories } from './dynamo.js';
import { requireId } from './errors.js';
import { text } from './validation.js';
const [tenantArg, subArg, dealershipArg, nameArg] = process.argv.slice(2);
if (!process.env.TABLE_NAME || !tenantArg || !subArg || !dealershipArg || !nameArg) {
  console.error('Usage: TABLE_NAME=<table> npm run provision -w @freedms/api -- <tenant-id> <cognito-sub> "<dealership>" "<name>"');
  process.exitCode = 1;
} else {
  const tenantId = requireId(tenantArg); const userId = requireId(subArg); const createdAt = new Date().toISOString();
  await new DynamoRepositories(process.env.TABLE_NAME, undefined, true).forTenant(tenantId).provision(
    {id: tenantId, name: text(dealershipArg, 'Dealership'), createdAt},
    {id: userId, name: text(nameArg, 'Name')},
    {tenantId, userId, role: 'admin', active: true},
    {id: randomUUID(), tenantId, actorId: userId, aggregateId: tenantId, aggregateVersion: 1, type: 'tenant.created', occurredAt: createdAt, deliveryStatus: 'pending'}
  );
  console.log('Dealership and administrator membership created.');
}
