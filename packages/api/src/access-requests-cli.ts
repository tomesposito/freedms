/** Operator-only readout; requests never provision accounts or invitations. */
import { DynamoRepositories } from './dynamo.js';
import { listAccessRequests, markAccessRequestHandled } from './access-requests.js';

const args = process.argv.slice(2);
if (!process.env.TABLE_NAME || !(args.length === 0 || (args.length === 2 && args[0] === '--handled' && args[1].trim()))) {
  console.error('Usage: TABLE_NAME=<table> npm run access-requests -w @freedms/api -- [--handled <email>]');
  process.exitCode = 1;
} else {
  try {
    const repositories = new DynamoRepositories(process.env.TABLE_NAME);
    if (args.length) {
      const record = await markAccessRequestHandled(repositories, args[1], new Date());
      console.log(`Marked ${record.email} handled.`);
    } else {
      const records = await listAccessRequests(repositories);
      if (!records.length) console.log('No pending access requests.');
      for (const record of records) console.log([
        `Created: ${record.createdAt}`, `Contact name: ${record.contactName}`, `Dealership: ${record.dealershipName}`,
        `Email: ${record.email}`, `Phone: ${record.phone}`, `Inventory size: ${record.inventorySize}`,
        `Current DMS: ${record.currentDms}`, `Message: ${record.message}`, ''
      ].join('\n'));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to read access requests.');
    process.exitCode = 1;
  }
}
