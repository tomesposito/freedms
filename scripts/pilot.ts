/** Operator-only. Configuration and credential files must stay outside Git. */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DynamoRepositories } from '../packages/api/src/dynamo.js';
import { bootstrapPilot, invitePilot, CognitoPilotIdentity } from '../packages/api/src/pilot-provision.js';
import { seedDemo } from '../packages/api/src/demo-seed.js';
const [operation, configPath] = process.argv.slice(2);
if (!['bootstrap', 'invite', 'demo'].includes(operation) || !configPath) throw new Error('Usage: npm run pilot -- bootstrap|invite|demo /private/config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.region !== 'us-east-1') throw new Error('Pilot region must be us-east-1');
process.env.AWS_REGION = config.region;
const aws = (...args: string[]) => JSON.parse(execFileSync('aws', [...args, '--region', config.region, '--output', 'json'], {encoding: 'utf8'}));
if (aws('sts', 'get-caller-identity').Account !== config.accountId) throw new Error('Unexpected AWS account');
const stack = aws('cloudformation', 'describe-stacks', '--stack-name', config.stackName).Stacks[0];
const outputs = Object.fromEntries(stack.Outputs.map((o: {OutputKey: string; OutputValue: string}) => [o.OutputKey, o.OutputValue]));
const accessPath = resolve(config.accessFile);
await mkdir(dirname(accessPath), {recursive: true, mode: 0o700});
let access: Record<string, string> = {};
try { access = JSON.parse(await readFile(accessPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (access.email && access.email !== config.email.toLowerCase()) throw new Error('Use a separate access file for each person');
const save = async () => { await writeFile(accessPath, JSON.stringify(access, null, 2) + '\n', {mode: 0o600}); await chmod(accessPath, 0o600); };
const repositories = new DynamoRepositories(outputs.TableName);
const identity = new CognitoPilotIdentity(outputs.CognitoUserPoolId, async (email, temporaryPassword) => {
  access = {...access, email, temporaryPassword, signInUrl: outputs.WebUrl}; await save();
});
if (operation === 'bootstrap') {
  const result = await bootstrapPilot(repositories, identity, config);
  access = {...access, ...result, email: config.email.toLowerCase(), signInUrl: outputs.WebUrl}; await save();
} else if (operation === 'invite') {
  const invite = await invitePilot(repositories, identity, config);
  access = {...access, email: config.email.toLowerCase(), inviteUrl: `${outputs.WebUrl}#/invite/${invite.token}`}; await save();
} else {
  if (config.demo !== true || !access.userId || access.tenantId !== config.tenantId) throw new Error('Explicit demo config and matching administrator access file required');
  await seedDemo(repositories, config.tenantId, access.userId);
}
console.log(operation === 'demo' ? 'Fictional demo records loaded.' : `Pilot access prepared in ${accessPath}. No invitation email was sent.`);
