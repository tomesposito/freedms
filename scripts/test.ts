// A single entry point keeps test reporting consistent across Node 20 and newer.
import '../packages/api/test/inventory.test.js';
import '../packages/api/test/dynamo.test.js';
import '../packages/api/test/vin.test.js';
import '../packages/web/test/format.test.js';

import '../packages/api/test/crm.test.js';
import '../packages/api/test/desking.test.js';
import '../packages/api/test/jacket.test.js';
import '../packages/api/test/reports.test.js';
import '../packages/api/test/quick-entry.test.js';
import '../packages/api/test/analytics.test.js';
import '../packages/web/test/analytics.test.js';

import '../packages/api/test/import.test.js';
import '../packages/api/test/feed.test.js';
import '../packages/web/test/feed.test.js';
import '../packages/api/test/webhooks.test.js';
import '../packages/web/test/webhooks.test.js';
import '../packages/api/test/mfa.test.js';
import '../packages/web/test/mfa.test.js';
import '../packages/web/test/documents.test.js';
import '../packages/api/test/fi.test.js';
import '../packages/web/test/fi.test.js';
import '../packages/api/test/accounting.test.js';
import '../packages/web/test/accounting.test.js';
import '../packages/api/test/credit.test.js';
import '../packages/web/test/credit.test.js';
import '../packages/api/test/treasury.test.js';
import '../packages/web/test/treasury.test.js';
import '../packages/api/test/users.test.js';
import '../packages/web/test/users.test.js';
import '../packages/api/test/retail.test.js';
import '../packages/web/test/retail.test.js';
import '../packages/api/test/local.test.js';
