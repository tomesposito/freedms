/** Explicit operator migration only. Never imported by Lambda or local startup. */
import { DynamoRepositories } from './dynamo.js';
import { scrubLegacyInvites } from './invites.js';
import { requireId } from './errors.js';
const tenantId = requireId(process.argv[2]);
if (!process.env.TABLE_NAME) throw new Error('TABLE_NAME is required');
const repositories = new DynamoRepositories(process.env.TABLE_NAME, undefined, true);
const scrubbed = await scrubLegacyInvites(repositories.forTenant(tenantId));
console.log(`Legacy invite plaintext tokens removed: ${scrubbed}.`);
