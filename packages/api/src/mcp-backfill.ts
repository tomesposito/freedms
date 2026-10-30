/** Explicit operator migration only. Never imported by Lambda or local startup. */
import { DynamoRepositories } from './dynamo.js';
import { requireId } from './errors.js';
const tenantId = requireId(process.argv[2]);
if (!process.env.TABLE_NAME) throw new Error('TABLE_NAME is required');
const repositories = new DynamoRepositories(process.env.TABLE_NAME, undefined, true);
for (const {membership} of await repositories.forTenant(tenantId).workspaceUsers()) {
  await repositories.bindSubject(tenantId, membership.userId);
}
console.log('Existing membership subject bindings migrated.');
