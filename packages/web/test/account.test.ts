import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCognito, accountError, accountUser} from '../src/cognito';
import {hostedAccountRoute, profileValues, profileHtml, passwordHtml, authenticatorHtml, enrollmentHtml, otpauthUrl} from '../src/hosted-account';
// @ts-ignore Node-only protocol fixture
import {mockCognito} from './mock-cognito.mjs';

test('hosted profile uses tenant record, Cognito and claims with escaped nonempty fallbacks', () => {
  const token = `e30.${Buffer.from(JSON.stringify({email:'claims@example.test'})).toString('base64url')}.fixture`;
  assert.equal(profileValues(undefined, undefined, token).email, 'claims@example.test');
  assert.equal(profileValues(undefined, {email:'cognito@example.test', enabled:false}, token).email, 'cognito@example.test');
  const session = {user:{name:'<script>',email:'tenant@example.test'},tenant:{name:'<img>'},principal:{role:'<role>'}} as any;
  const profile = profileValues(session, {name:'Cognito', email:'cognito@example.test',enabled:false}, token);
  assert.equal(profile.email,'tenant@example.test');
  const html = profileHtml(profile);
  for (const tag of ['script', 'img', 'role']) { assert.ok(!html.includes(`<${tag}>`)); assert.ok(html.includes(`&lt;${tag}&gt;`)); }
  assert.ok(!profileHtml(profileValues()).includes('undefined'));
  assert.equal(profileValues().name,'Not provided');
});

test('hosted forms provide accessible inputs, enabled/empty states and a locally encoded QR', () => {
  assert.match(passwordHtml(), /autocomplete="current-password"/);
  assert.equal(passwordHtml().match(/autocomplete="new-password"/g)?.length, 2);
  assert.match(authenticatorHtml(false), /Not set/); assert.match(authenticatorHtml(false), /Enroll authenticator/);
  assert.match(authenticatorHtml(true), /Enabled/); assert.match(authenticatorHtml(true), /Replace authenticator/);
  assert.match(authenticatorHtml(true), /pilot operator/);
  const html = enrollmentHtml('JBSWY3DPEHPK3PXP','pilot@example.test');
  assert.match(html, /<svg/); assert.match(html, /<path/); assert.match(html, /JBSWY3DPEHPK3PXP/);
  assert.match(html, /autocomplete="one-time-code"/); assert.ok(!html.includes('<img'));
  assert.equal(otpauthUrl('JBSWY3DPEHPK3PXP','pilot@example.test'), 'otpauth://totp/freeDMS:pilot%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=freeDMS&algorithm=SHA1&digits=6&period=30');
  assert.match(enrollmentHtml('<secret>','<account>'), /&lt;secret&gt;/);
});

test('Cognito account status recognizes TOTP fields without mistaking SMS for TOTP', () => {
  assert.equal(accountUser({UserMFASettingList:['SOFTWARE_TOKEN_MFA']}).enabled,true);
  assert.equal(accountUser({PreferredMfaSetting:'SOFTWARE_TOKEN_MFA'}).enabled,true);
  assert.equal(accountUser({MFAOptions:[{DeliveryMedium:'SOFTWARE_TOKEN_MFA'}]}).enabled,true);
  assert.equal(accountUser({MFAOptions:[{DeliveryMedium:'SMS',AttributeName:'phone_number'}]}).enabled,false);
  assert.equal(accountUser({}).enabled,false);
});

test('hosted change password succeeds and preserves policy wording and wrong-current error', async () => {
  const mock = await mockCognito(0);
  try {
    const client = createCognito({poolId:'us-east-1_offline',clientId:'offline',endpoint:mock.endpoint});
    await assert.rejects(client.changePassword('access','wrong','ChangedPassword123!'), {message:'Current password is incorrect.'});
    await assert.rejects(client.changePassword('access','FixturePassword123!','weak'), {message:'Password must have length greater than or equal to 12'});
    await client.changePassword('access','FixturePassword123!','ChangedPassword123!');
    await client.changePassword('access','ChangedPassword123!','ChangedAgain123!');
    assert.deepEqual(mock.calls, Array(4).fill('ChangePassword'));
  } finally { await new Promise<void>(resolve => mock.server.close(() => resolve())); }
});

test('hosted authenticator enroll and replace each associate, verify, then enable preference', async () => {
  const mock = await mockCognito(0);
  try {
    const client = createCognito({poolId:'us-east-1_offline',clientId:'offline',endpoint:mock.endpoint});
    assert.equal((await client.getUser('access')).enabled,false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = mock.calls.length;
      const secret = await client.associateSoftwareToken('access');
      assert.match(enrollmentHtml(secret,'pilot@example.test'), /JBSWY3DPEHPK3PXP/);
      await assert.rejects(client.verifySoftwareToken('access','000000'), {message:'The code is incorrect. Please try again.'});
      await assert.rejects(client.setTotpPreference('access',true), /pilot operator/);
      await client.verifySoftwareToken('access','123456');
      await client.setTotpPreference('access',true);
      const user = await client.getUser('access');
      assert.equal(user.enabled,true); assert.equal(user.email,'pilot@example.test'); assert.equal(user.name,'Pilot User');
      assert.deepEqual(mock.calls.slice(start), ['AssociateSoftwareToken','VerifySoftwareToken','SetUserMFAPreference','VerifySoftwareToken','SetUserMFAPreference','GetUser']);
    }
  } finally { await new Promise<void>(resolve => mock.server.close(() => resolve())); }
});

test('account errors hide provider details except actionable password policy', async () => {
  assert.ok(!accountError({__type:'Other',message:'SECRET'},'GetUser').message.includes('SECRET'));
  assert.match(accountError({__type:'NotAuthorizedException'},'GetUser').message,/pilot operator/);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({Status:'ERROR'}));
    const client = createCognito({poolId:'us-east-1_offline',clientId:'offline',endpoint:'http://offline.invalid'});
    await assert.rejects(client.verifySoftwareToken('access','123456'), /pilot operator/);
  } finally { globalThis.fetch = original; }
});


test('redirect-only account loads the session profile without self-service buttons', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true,value:{getItem:() => null}});
  try {
    let html = ''; const paths: string[] = [];
    const session = {user:{name:'Pilot',email:'pilot@example.test'},tenant:{name:'Workspace'},principal:{role:'admin'}};
    await hostedAccountRoute({api:async <T>(path: string) => { paths.push(path); return session as T; },shell:value => {html = value;},flash:() => assert.fail('Unexpected error'),current:() => true,refresh:() => {},admin:false});
    assert.deepEqual(paths, ['/session']); assert.match(html, /pilot@example.test/);
    assert.match(html, /not available in this sign-in mode/); assert.match(html, /pilot operator/);
    assert.ok(!html.includes('<button')); assert.ok(!html.includes('<form'));
  } finally { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});

test('failed Cognito settings retain tenant profile and actionable operator notice', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable:true,value:{getItem:() => 'access'}});
  try {
    let html = '';
    const client = createCognito({poolId:'us-east-1_offline',clientId:'offline'});
    client.getUser = async () => { throw new Error('Account unavailable'); };
    await hostedAccountRoute({api:async <T>() => ({user:{name:'Pilot',email:'pilot@example.test'},tenant:{name:'Workspace'},principal:{role:'admin'}} as T),shell:value => {html = value;},flash:() => assert.fail('Unexpected error'),current:() => true,refresh:() => {},admin:false}, client);
    assert.match(html, /pilot@example.test/); assert.match(html, /Account settings could not be loaded/);
    assert.ok(!html.includes('<button')); assert.ok(!html.includes('<form'));
  } finally { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
});
