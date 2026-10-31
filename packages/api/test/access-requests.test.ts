import { turnstileVerifierFromEnv, type TurnstileVerifier } from '../src/turnstile.js';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { mailSenderFromEnv, SesMailSender, type MailInput } from '../src/mail.js';
import type { AccessRequestMail } from '../src/access-requests.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryRepositories } from '../src/memory.js';
import { DynamoRepositories } from '../src/dynamo.js';
import { gatewayHandler } from '../src/gateway.js';
import { createHandler } from '../src/handler.js';
import { listAccessRequests, markAccessRequestHandled } from '../src/access-requests.js';
import { OPERATOR_TENANT_ID } from '../src/repository.js';
import { localAuth } from '../src/local-auth.js';

const fields = {contactName: 'Test Dealer', dealershipName: 'Test Motors', email: 'dealer@example.com', phone: '555-0100', inventorySize: '26-50', currentDms: 'Manual', message: 'Pilot please'};
const start = new Date('2026-10-30T12:00:00Z');
function setup(mail?: AccessRequestMail, turnstile?: TurnstileVerifier) {
  const repositories = new MemoryRepositories();
  let now = start;
  const handle = createHandler(repositories, {decode: async () => { throw new Error('Unexpected VIN lookup'); }}, () => now, undefined, undefined, undefined, undefined, {mail, turnstile});
  return {repositories, repo: repositories.forTenant(OPERATOR_TENANT_ID), setNow: (date: Date) => { now = date; },
    post: (body: unknown = fields, method = 'POST') => handle({method, path: '/access-requests', body: JSON.stringify(body)})};
}

test('public access capture stores only an operator record, with no membership, tenant or event', async () => {
  const {repositories, repo, post} = setup();
  const result = await post();
  assert.equal(result.statusCode, 201); assert.deepEqual(JSON.parse(result.body), {data: {received: true}});
  const records = await repo.accessRequests(); assert.equal(records.length, 1);
  assert.deepEqual(records[0], {...fields, id: records[0].id, tenantId: 'operator', status: 'pending', handledAt: null, version: 1, createdAt: start.toISOString(), updatedAt: start.toISOString()});
  for (const partition of [repo, repositories.forTenant('real-dealership')]) {
    assert.equal(await partition.tenant(), undefined);
    assert.deepEqual(await partition.users(), []); assert.deepEqual(await partition.workspaceUsers(), []);
    assert.deepEqual(await partition.events(), []); assert.deepEqual(await partition.crmList('invite'), []);
  }
  assert.deepEqual(await repositories.forTenant('real-dealership').accessRequests(), []);
  assert.deepEqual(localAuth('/access-requests/', false, '', {verify: () => { throw new Error('Must be public'); }}), {});
});

test('access capture validates required fields, field types, lengths, inventory and method', async () => {
  const {post, repo} = setup();
  for (const body of [
    {...fields, email: undefined}, {...fields, email: 'bad'}, {...fields, contactName: ''}, {...fields, dealershipName: undefined},
    {...fields, tenantId: 'injected'}, {...fields, inventorySize: '500'}, {...fields, phone: 123},
    {...fields, contactName: 'a'.repeat(121)}, {...fields, dealershipName: 'a'.repeat(161)},
    {...fields, phone: 'a'.repeat(41)}, {...fields, currentDms: 'a'.repeat(121)}, {...fields, message: 'a'.repeat(2001)},
    [], null
  ]) {
    const result = await post(body); assert.equal(result.statusCode, 400); assert.equal(JSON.parse(result.body).error.code, 'VALIDATION');
  }
  assert.equal((await post(fields, 'GET')).statusCode, 405);
  assert.deepEqual(await repo.accessRequests(), []);
});

test('honeypot drops before required validation, but after unknown keys and body limit', async () => {
  const {post, repo} = setup();
  const result = await post({website: ' bot.example '});
  assert.equal(result.statusCode, 201); assert.deepEqual(JSON.parse(result.body), {data: {received: true}});
  assert.equal((await post({website: 'bot', extra: true})).statusCode, 400);
  assert.equal((await post({...fields, website: 'bot', message: 'x'.repeat(16 * 1024)})).statusCode, 400);
  assert.deepEqual(await repo.accessRequests(), []);
});

test('repeated email updates one record and preserves identity, creation and handled status', async () => {
  const {post, repo, repositories, setNow} = setup();
  await post(); const first = (await repo.accessRequests())[0];
  const later = new Date('2026-10-31T12:00:00Z'); setNow(later);
  assert.equal((await post({...fields, email: fields.email.toUpperCase(), contactName: 'Updated'})).statusCode, 201);
  const records = await repo.accessRequests(); assert.equal(records.length, 1);
  assert.equal(records[0].id, first.id); assert.equal(records[0].createdAt, first.createdAt);
  assert.equal(records[0].version, 2); assert.equal(records[0].contactName, 'Updated'); assert.equal(records[0].updatedAt, later.toISOString());
  await markAccessRequestHandled(repositories, fields.email, later);
  await post({...fields, message: 'Again'});
  const handled = (await repo.accessRequests())[0];
  assert.equal(handled.status, 'handled'); assert.equal(handled.handledAt, later.toISOString()); assert.equal(handled.version, 4);
});

test('operator lists pending newest-first with email tie-break and marks handled', async () => {
  const {post, repositories, setNow} = setup();
  await post(); setNow(new Date('2026-10-31T12:00:00Z'));
  await post({...fields, email: 'z@example.com'}); await post({...fields, email: 'a@example.com'});
  assert.deepEqual((await listAccessRequests(repositories)).map(r => r.email), ['a@example.com', 'z@example.com', fields.email]);
  const handled = await markAccessRequestHandled(repositories, 'A@example.com', start);
  assert.equal(handled.status, 'handled'); assert.equal(handled.handledAt, start.toISOString()); assert.equal(handled.version, 2);
  assert.equal((await listAccessRequests(repositories)).length, 2);
  for (const email of ['missing@example.com', 'a@example.com']) await assert.rejects(markAccessRequestHandled(repositories, email, start), {message: 'No pending access request for that email.'});
});

test('memory access request writes reject stale versions and wrong scope and clone records', async () => {
  const {post, repo} = setup(); await post(); const record = (await repo.accessRequests())[0];
  await assert.rejects(repo.saveAccessRequest({...record, version: 2}, 0), /version/);
  await assert.rejects(repo.saveAccessRequest(record, 0), {code: 'CONFLICT'});
  await assert.rejects(repo.saveAccessRequest({...record, tenantId: 'other', version: 2}, 1), /scope/);
  record.message = 'changed'; assert.equal((await repo.accessRequest(fields.email))?.message, fields.message);
});

test('Dynamo access requests use operator keys, conditional writes without events, and paginated prefix queries', async () => {
  const {post, repo} = setup(); await post(); const record = (await repo.accessRequests())[0];
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = []; let pages = 0;
  const client = {send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    commands.push(command);
    if (command instanceof GetCommand) return {Item: {data: record}};
    if (command instanceof QueryCommand) {
      pages++; return {Items: [{data: record}], ...(pages === 1 ? {LastEvaluatedKey: {PK: 'TENANT#operator', SK: 'ACCESSREQUEST#dealer@example.com'}} : {})};
    }
    return {};
  }} as unknown as DynamoDBDocumentClient;
  const dynamo = new DynamoRepositories('fake-table', client).forTenant(OPERATOR_TENANT_ID);
  await dynamo.saveAccessRequest(record, 0); await dynamo.saveAccessRequest({...record, version: 2}, 1);
  for (const command of commands as TransactWriteCommand[]) {
    const items = command.input.TransactItems!; assert.equal(items.length, 1);
    assert.equal(items[0].Put?.Item?.PK, 'TENANT#operator'); assert.equal(items[0].Put?.Item?.SK, 'ACCESSREQUEST#dealer@example.com');
  }
  assert.equal((commands[0] as TransactWriteCommand).input.TransactItems![0].Put?.ConditionExpression, 'attribute_not_exists(PK)');
  const update = (commands[1] as TransactWriteCommand).input.TransactItems![0].Put!;
  assert.equal(update.ConditionExpression, '#d.#v = :v'); assert.equal(update.ExpressionAttributeValues?.[':v'], 1);
  assert.equal((await dynamo.accessRequest(fields.email.toUpperCase()))?.id, record.id);
  assert.deepEqual((commands[2] as GetCommand).input.Key, {PK: 'TENANT#operator', SK: 'ACCESSREQUEST#dealer@example.com'});
  assert.equal((await dynamo.accessRequests()).length, 2); assert.equal(pages, 2);
  for (const command of commands.filter(c => c instanceof QueryCommand)) {
    assert.deepEqual(command.input.ExpressionAttributeValues, {':pk': 'TENANT#operator', ':prefix': 'ACCESSREQUEST#'});
    assert.equal(command.input.ConsistentRead, true);
  }
  await assert.rejects(dynamo.saveAccessRequest({...record, tenantId: 'other'}, 0), /scope/);
  await assert.rejects(dynamo.saveAccessRequest({...record, version: 3}, 0), /version/);
});

test('access capture refuses oversized UTF-8 bodies before saving', async () => {
  const {post, repo} = setup();
  const result = await post({...fields, message: 'é'.repeat(8192)});
  assert.equal(result.statusCode, 400); assert.equal(JSON.parse(result.body).error.code, 'VALIDATION');
  assert.deepEqual(await repo.accessRequests(), []);
});

const notifyTo = `operator-${fields.email}`;
const mailFrom = `sender-${fields.email}`;
function fakeMail(configured = true) {
  const sent: MailInput[] = [];
  return {sent, mail: {notifyTo, sender: {configured, send: async (input: MailInput) => { sent.push(input); }}}};
}

test('new access request emails the operator after saving, and repeats never email again', async () => {
  const {sent, mail} = fakeMail();
  const {post, repo} = setup({...mail, sender: {configured: true, send: async input => {
    assert.equal((await repo.accessRequests()).length, 1);
    sent.push(input);
  }}});
  assert.equal((await post()).statusCode, 201);
  assert.deepEqual(sent, [{to: notifyTo, replyTo: fields.email,
    subject: `New freeDMS pilot access request — ${fields.dealershipName}`,
    text: `Contact name: ${fields.contactName}\nDealership name: ${fields.dealershipName}\nEmail: ${fields.email}\nPhone: ${fields.phone}\nInventory size: ${fields.inventorySize}\nCurrent DMS: ${fields.currentDms}\nMessage: ${fields.message}\nSubmitted: ${start.toISOString()}`}]);
  assert.equal((await post({...fields, message: 'Updated'})).statusCode, 201);
  assert.equal(sent.length, 1);
  assert.equal((await repo.accessRequest(fields.email))?.message, 'Updated');
});

test('notification labels include blank optional fields', async () => {
  const {sent, mail} = fakeMail(); const {post} = setup(mail);
  await post({contactName: fields.contactName, dealershipName: fields.dealershipName, email: fields.email});
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('\nPhone: \nInventory size: \nCurrent DMS: \nMessage: \nSubmitted: '));
});

test('honeypot and rejected requests never send email', async () => {
  const {sent, mail} = fakeMail(); const {post, repo} = setup(mail);
  assert.equal((await post({website: 'bot'})).statusCode, 201);
  assert.equal((await post({...fields, email: ''})).statusCode, 400);
  assert.deepEqual(sent, []); assert.deepEqual(await repo.accessRequests(), []);
});

test('notification failures preserve success and log only the error name', async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  for (const failure of [new TypeError(JSON.stringify(fields)), fields]) {
    const {post, repo} = setup({notifyTo, sender: {configured: true, send: async () => { throw failure; }}});
    const result = await post();
    assert.equal(result.statusCode, 201);
    assert.deepEqual(JSON.parse(result.body), {data: {received: true}});
    assert.equal((await repo.accessRequests()).length, 1);
  }
  assert.deepEqual(logs, [['Access request notification failed:', 'TypeError'], ['Access request notification failed:', 'UnknownError']]);
});

test('absent or blank mail configuration silently stores submissions without sending', async () => {
  for (const recipient of [undefined, '', '  ']) {
    const {sent, mail} = fakeMail(); const {post, repo} = setup({...mail, notifyTo: recipient});
    assert.equal((await post()).statusCode, 201);
    assert.equal((await repo.accessRequests()).length, 1); assert.deepEqual(sent, []);
  }
  const {sent, mail} = fakeMail(false); const {post, repo} = setup(mail);
  assert.equal((await post()).statusCode, 201);
  assert.equal((await repo.accessRequests()).length, 1); assert.deepEqual(sent, []);
  const unconfigured = setup({notifyTo, sender: mailSenderFromEnv({})});
  assert.equal((await unconfigured.post()).statusCode, 201);
  assert.equal((await unconfigured.repo.accessRequests()).length, 1);
});

test('mail factory defaults to no-op and SES shapes text commands with optional reply-to', async () => {
  const commands: SendEmailCommand[] = [];
  const client = {send: async (command: SendEmailCommand) => { commands.push(command); return {}; }};
  const input = {to: notifyTo, subject: 'Test — notification', text: 'Plain text'};
  for (const env of [{}, {MAIL_FROM: ''}, {MAIL_FROM: '  '}]) {
    const sender = mailSenderFromEnv(env, client);
    assert.equal(sender.configured, false); await sender.send(input);
  }
  assert.equal(commands.length, 0);
  const sender = mailSenderFromEnv({MAIL_FROM: `  ${mailFrom}  `}, client);
  assert.equal(sender.configured, true); assert.ok(sender instanceof SesMailSender);
  await sender.send({...input, replyTo: fields.email}); await sender.send(input);
  assert.equal(commands.length, 2);
  const expected = {Source: mailFrom, Destination: {ToAddresses: [notifyTo]}, Message: {
    Subject: {Data: input.subject, Charset: 'UTF-8'}, Body: {Text: {Data: input.text, Charset: 'UTF-8'}}
  }};
  assert.ok(commands[0] instanceof SendEmailCommand);
  assert.deepEqual(commands[0].input, {...expected, ReplyToAddresses: [fields.email]});
  assert.deepEqual(commands[1].input, expected);
});

// Exercise the deployed adapter as well as the in-process handler.
test('hosted access capture is public only for POST and still requires the private origin', async () => {
  const repositories = new MemoryRepositories();
  const handler = createHandler(repositories, {decode: async () => { throw Error('Unexpected VIN lookup'); }});
  const gateway = gatewayHandler(handler, 'issuer', 'audience', 'test-origin');
  const event = (path = '/access-requests', method = 'POST', origin = 'test-origin') => ({
    rawPath: path, headers: {'x-freedms-origin': origin}, body: JSON.stringify(fields), requestContext: {http: {method}}
  });
  assert.equal((await gateway(event('/access-requests', 'POST', ''))).statusCode, 403);
  assert.equal((await gateway(event())).statusCode, 201);
  assert.equal((await repositories.forTenant(OPERATOR_TENANT_ID).accessRequests()).length, 1);
  for (const [path, method] of [['/access-requests', 'GET'], ['/access-requests', 'DELETE'], ['/access-requests/anything', 'POST'], ['/session', 'GET']]) {
    assert.equal((await gateway(event(path, method))).statusCode, 401);
  }
});


test('configured Turnstile verifies before storage and notification, without retaining the token', async () => {
  const {sent, mail} = fakeMail();
  const tokens: string[] = [];
  const {post, repo} = setup(mail, {configured: true, verify: async token => {
    assert.deepEqual(await repo.accessRequests(), []);
    assert.deepEqual(sent, []);
    tokens.push(token); return true;
  }});
  assert.equal((await post({...fields, turnstileToken: 'test-token'})).statusCode, 201);
  assert.deepEqual(tokens, ['test-token']);
  assert.equal((await repo.accessRequests()).length, 1);
  assert.equal(sent.length, 1);
  assert.ok(!JSON.stringify(await repo.accessRequests()).includes('test-token'));
  assert.ok(!JSON.stringify(sent).includes('test-token'));
  assert.ok(!('turnstileToken' in (await repo.accessRequests())[0]));
});

test('configured Turnstile rejects absent, invalid and failed verification without storage or email', async () => {
  for (const verify of [async () => false, async () => { throw Error('Offline'); }]) {
    const {sent, mail} = fakeMail();
    let calls = 0;
    const {post, repo} = setup(mail, {configured: true, verify: async () => { calls++; return verify(); }});
    for (const turnstileToken of [undefined, '', '  ', null, 12, {}, 'invalid-token']) {
      const result = await post({...fields, turnstileToken});
      assert.equal(result.statusCode, 400);
      assert.equal(JSON.parse(result.body).error.code, 'VALIDATION');
    }
    assert.equal(calls, 1);
    assert.deepEqual(await repo.accessRequests(), []);
    assert.deepEqual(sent, []);
  }
});

test('honeypot, unknown keys and body limits precede Turnstile verification', async () => {
  let calls = 0;
  const {sent, mail} = fakeMail();
  const {post, repo} = setup(mail, {configured: true, verify: async () => { calls++; return false; }});
  assert.equal((await post({website: 'bot', turnstileToken: 'token'})).statusCode, 201);
  assert.equal((await post({website: 'bot', extra: true, turnstileToken: 'token'})).statusCode, 400);
  assert.equal((await post({website: 'bot', message: 'x'.repeat(16384), turnstileToken: 'token'})).statusCode, 400);
  assert.equal(calls, 0);
  assert.deepEqual(await repo.accessRequests(), []);
  assert.deepEqual(sent, []);
});

test('unconfigured Turnstile is never invoked and preserves storage and notification', async () => {
  for (const env of [{}, {TURNSTILE_SECRET: ''}, {TURNSTILE_SECRET: '  '}]) {
    const verifier = turnstileVerifierFromEnv(env, async () => { throw Error('Unexpected fetch'); });
    assert.equal(verifier.configured, false);
    verifier.verify = async () => { assert.fail('Unconfigured verifier called'); };
    const {sent, mail} = fakeMail();
    const {post, repo} = setup(mail, verifier);
    assert.equal((await post()).statusCode, 201);
    assert.equal((await repo.accessRequests()).length, 1);
    assert.equal(sent.length, 1);
  }
});

test('Turnstile sends form-encoded credentials via injectable fetch and fails closed', async () => {
  for (const [reply, expected] of [
    [{success: true}, true], [{success: false}, false], [{success: 'true'}, false], [{}, false], [null, false]
  ] as const) {
    const verifier = turnstileVerifierFromEnv({TURNSTILE_SECRET: ' test-secret '}, async (url, options) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(options?.method, 'POST');
      assert.deepEqual(options?.headers, {'content-type': 'application/x-www-form-urlencoded'});
      assert.equal(String(options?.body), 'secret=test-secret&response=token%2B%26');
      return new Response(JSON.stringify(reply));
    });
    assert.equal(verifier.configured, true);
    assert.equal(await verifier.verify('token+&'), expected);
  }
  for (const fetchRequest of [
    async () => { throw Error('Network failure'); },
    async () => new Response('{"success":true}', {status: 503}),
    async () => new Response('invalid json')
  ]) {
    const verifier = turnstileVerifierFromEnv({TURNSTILE_SECRET: 'test-secret'}, fetchRequest);
    const {sent, mail} = fakeMail();
    const {post, repo} = setup(mail, verifier);
    assert.equal((await post({...fields, turnstileToken: 'token'})).statusCode, 400);
    assert.deepEqual(await repo.accessRequests(), []);
    assert.deepEqual(sent, []);
  }
});
