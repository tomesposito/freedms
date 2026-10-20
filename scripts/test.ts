// A single entry point keeps test reporting consistent across Node 20 and newer.
import '../packages/api/test/inventory.test.js';
import '../packages/api/test/dynamo.test.js';
import '../packages/api/test/vin.test.js';
import '../packages/web/test/format.test.js';

import '../packages/api/test/crm.test.js';
import '../packages/api/test/desking.test.js';
import '../packages/api/test/jacket.test.js';
import '../packages/api/test/reports.test.js';
