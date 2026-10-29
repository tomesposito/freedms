import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCognito} from '../src/cognito';
import {loginHtml} from '../src/login';
import {selectAuthFlow, storeTokens, getToken, clearSession, tokenExpired} from '../src/auth';
// @ts-ignore Node-only protocol fixture
import {mockCognito} from './mock-cognito.mjs';
test('auth flow defaults, rollback and missing pool ID', () => {
  const config={domain:'https://example.test',client:'client',poolId:'us-east-1_test'};
  assert.equal(selectAuthFlow(config),'inapp'); assert.equal(selectAuthFlow({...config,flow:'redirect'}),'redirect');
  assert.equal(selectAuthFlow({...config,poolId:undefined}),'redirect'); assert.equal(selectAuthFlow({}),'redirect');
});
test('all login states are accessible and escape errors', () => {
  for(const state of ['sign-in','new-password','totp','totp-setup','forgot','forgot-confirm','error'] as const) {
    const html=loginHtml(state,'<script>'); assert.ok(html.includes('freeDMS')); assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>')); if(state!=='sign-in') assert.ok(html.includes('Back to sign in'));
  }
  assert.match(loginHtml(),/autocomplete="current-password"/); assert.match(loginHtml('new-password'),/autocomplete="new-password"/);
  assert.match(loginHtml('totp-setup', '', '<setup-key>'), /&lt;setup-key&gt;/);
  assert.ok(!loginHtml('sign-in').includes('JBSWY3DPEHPK3PXP'));
});
test('real Cognito SDK offline SRP, challenges, reset, refresh and revoke', async () => {
  const mock=await mockCognito(0);
  try {
    const client=createCognito({poolId:'us-east-1_offline',clientId:'offline',endpoint:mock.endpoint});
    const signed=await client.signIn('pilot@example.test','ExamplePassword123!'); assert.ok('tokens' in signed);
    if(!('tokens' in signed)) return;
    const values=new Map<string,string>();
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
    storeTokens(signed.tokens); assert.equal(getToken(),signed.tokens.id); assert.equal(values.get('freedms-refresh-token'),'offline-refresh'); assert.equal(values.get('freedms-access-token'),signed.tokens.access);
    assert.equal(tokenExpired(signed.tokens.id),false); assert.equal(tokenExpired('invalid'),true);
    for(const username of ['wrong@example.test','unknown@example.test']) await assert.rejects(client.signIn(username,'WrongPassword!'),/Email or password is incorrect\./);
    const first=await client.signIn('newpass@example.test','Temporary123!'); assert.ok('challenge' in first && first.challenge==='new-password');
    if('challenge' in first) assert.ok('tokens' in await client.respondNewPassword(first.session,'NewPassword123!'));
    const totp=await client.signIn('totp@example.test','Password123!'); assert.ok('challenge' in totp && totp.challenge==='totp');
    if('challenge' in totp) {await assert.rejects(client.respondTotp(totp.session,'000000'),/code is incorrect/);assert.ok('tokens' in await client.respondTotp(totp.session,'123456'));}
    for (const username of ['setup@example.test','newpasssetup@example.test']) {
      let setup = await client.signIn(username,'Password123!');
      if ('challenge' in setup && setup.challenge === 'new-password') setup = await client.respondNewPassword(setup.session,'NewPassword123!');
      assert.ok('challenge' in setup && setup.challenge === 'totp-setup');
      if ('challenge' in setup) {
        assert.equal(setup.session.secretCode, 'JBSWY3DPEHPK3PXP');
        await assert.rejects(client.completeTotpSetup(setup.session,'000000'), /code is incorrect/);
        assert.ok('tokens' in await client.completeTotpSetup(setup.session,'123456'));
      }
    }
    assert.ok(mock.calls.includes('AssociateSoftwareToken')); assert.ok(mock.calls.includes('VerifySoftwareToken'));
    await assert.rejects(client.signIn('unsupported@example.test','Password123!'),/not supported/);
    await client.forgotPassword('pilot@example.test'); await assert.rejects(client.confirmForgotPassword('pilot@example.test','000000','NewPassword123!'),/code is incorrect/);
    await client.confirmForgotPassword('pilot@example.test','123456','NewPassword123!');
    const renewed=await client.refresh(signed.tokens.refresh); assert.notEqual(renewed.id,signed.tokens.id); await client.revoke(renewed.refresh); assert.ok(mock.calls.includes('RevokeToken'));
    clearSession(); assert.equal(values.size,0);
  } finally { await new Promise<void>(resolve=>mock.server.close(()=>resolve())); }
});

test('session lifecycle, proactive renewal, sign-out, PKCE rollback and local regression', async () => {
  const {transform}=await import('esbuild'); const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../src/auth.ts',import.meta.url),'utf8');
  const values=new Map<string,string>(); let destination=''; let refreshes=0; let revokes=0;
  const globals=['sessionStorage','location','history','fetch','__authFixture'] as const;
  const descriptors=globals.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const install=(key:string,value:unknown)=>Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const token=(exp:number)=>`e30.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.fixture`;
  install('sessionStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  install('location',{origin:'http://localhost',pathname:'/',hash:'#/invite/fixture',search:'',assign:(url:string)=>{destination=url;}});
  install('history',{replaceState:()=>{}});
  install('__authFixture',{refresh:async()=>{refreshes++;return {id:token(9999999999),refresh:'refresh',access:'access'};},revoke:async()=>{revokes++;throw Error('offline');}});
  const load=async(env:Record<string,unknown>)=>{
    const replaced=source.replace(/import \{ createCognito, type Tokens \} from '.\/cognito';/, 'const createCognito = () => globalThis.__authFixture;');
    const {code}=await transform(replaced,{loader:'ts',format:'esm',define:{'import.meta.env':JSON.stringify(env)}});
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`);
  };
  try {
    const config={VITE_COGNITO_DOMAIN:'https://hosted.example.test',VITE_COGNITO_CLIENT_ID:'client',VITE_COGNITO_USER_POOL_ID:'us-east-1_test'};
    const auth=await load(config); auth.storeTokens({id:token(1),refresh:'refresh',access:'access'});
    assert.equal(await auth.freshToken(),token(9999999999)); assert.equal(refreshes,1);
    await Promise.all([auth.refreshSession(),auth.refreshSession()]); assert.equal(refreshes,2);
    await auth.signOut(); assert.equal(revokes,1);assert.equal(values.size,0);assert.equal(destination,'http://localhost/');
    const rollback=await load({...config,VITE_AUTH_FLOW:'redirect'});await rollback.signIn();assert.match(destination,/oauth2\/authorize/);assert.match(destination,/code_challenge_method=S256/); assert.ok(values.has('freedms-pkce'));
    const state=values.get('freedms-state'); (globalThis.location as any).search=`?code=fixture&state=${state}`;
    install('fetch',async()=>new Response(JSON.stringify({id_token:'callback-id'})));
    await rollback.finishSignIn();assert.equal(values.get('freedms-token'),'callback-id');assert.ok(!values.has('freedms-pkce'));
    await rollback.signOut(); assert.match(destination,/\/logout\?/);
    const fallback=await load({...config,VITE_COGNITO_USER_POOL_ID:undefined});await fallback.signIn();assert.match(destination,/oauth2\/authorize/);
    const local=await load({DEV:true});assert.equal(local.localMode,true);local.setToken('local-token');assert.equal(await local.freshToken(),'local-token');assert.equal(await local.refreshSession(),false);await local.signOut();assert.equal(local.getToken(),null);assert.equal(destination,'http://localhost/');
  } finally { globals.forEach((key,i)=>{const descriptor=descriptors[i];if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}); }
});
