import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {mockCognito} from './mock-cognito.mjs';
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`,'package.json'));
const {chromium}=require('playwright-core');
const out=process.env.SCREENSHOT_DIR || `${homedir()}/workspace/tools/screenshots/freedms`;
const mock=await mockCognito(0);
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5199','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'https://offline.auth.us-east-1.amazoncognito.com',VITE_COGNITO_CLIENT_ID:'offline',VITE_COGNITO_USER_POOL_ID:'us-east-1_offline',VITE_COGNITO_ENDPOINT:mock.endpoint,VITE_API_URL:'/api',VITE_AUTH_FLOW:'inapp'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5199');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':`${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`),args:['--no-sandbox']});
  await mkdir(out,{recursive:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  let sessionAttempts=0;
  await page.route('**/api/**',route=>{sessionAttempts++;return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'UNAUTHORIZED',message:'Offline tour: no application session.'}})});});
  const shot=async name=>{await page.screenshot({path:`${out}/66-login-${name}.png`,fullPage:true});};
  const home=async()=>{await page.goto('http://127.0.0.1:5199');await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();};
  const login=async email=>{await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill('FixturePassword123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();};
  await home();await shot('desktop');await copyFile(`${out}/66-login-desktop.png`,'docs/screenshots/login.png');
  await page.setViewportSize({width:390,height:844});await shot('mobile');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:960});
  await login('wrong@example.test');await page.getByRole('alert').filter({hasText:'Email or password is incorrect.'}).waitFor();await shot('wrong-password');
  await home();await login('newpass@example.test');await page.getByRole('heading',{name:'Choose your password'}).waitFor();await shot('new-password');
  await page.getByLabel('New password').fill('ChangedPassword123!');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('alert').filter({hasText:'Offline tour'}).waitFor();await shot('post-login');assert.equal(sessionAttempts,2);assert.ok(mock.calls.includes('InitiateAuth'));
  await home();await login('totp@example.test');await page.getByRole('heading',{name:'Authenticator code'}).waitFor();await shot('totp');await page.getByLabel('Code',{exact:true}).fill('123456');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('alert').filter({hasText:'Offline tour'}).waitFor();
  await home();await page.getByRole('button',{name:'Forgot password?'}).click();await shot('forgot');await page.getByLabel('Email',{exact:true}).fill('pilot@example.test');await page.getByRole('button',{name:'Send reset code'}).click();await page.getByRole('heading',{name:'Check your email'}).waitFor();await shot('forgot-confirm');await page.getByLabel('Code',{exact:true}).fill('123456');await page.getByLabel('New password').fill('ResetPassword123!');await page.getByRole('button',{name:'Reset password',exact:true}).click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
  await page.unroute('**/api/**');
  let recoveryAttempts=0;
  await page.route('**/api/**', route => {
    recoveryAttempts++;
    return route.fulfill({status:recoveryAttempts===1?401:200,contentType:'application/json',body:JSON.stringify(recoveryAttempts===1?{error:{code:'UNAUTHORIZED',message:'Expired fixture token'}}:{data:{principal:{tenantId:'offline',userId:'offline-user',role:'admin'},tenant:{name:'Offline tour'},user:{id:'offline-user',name:'Offline user',email:'pilot@example.test'},mfaEnabled:true}})});
  });
  await page.goto('http://127.0.0.1:5199/#/welcome');await login('pilot@example.test');await page.locator('#signout').waitFor();assert.equal(recoveryAttempts,2);
  assert.ok(await page.evaluate(()=>sessionStorage.getItem('freedms-refresh-token')));
  await page.locator('#signout').click();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();assert.ok(mock.calls.includes('RevokeToken'));
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('freedms-token')),null);
  await page.unroute('**/api/**');
  let mfaAttempts=0;
  await page.route('**/api/**',route=>{mfaAttempts++;return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'MFA_INVALID',message:'Invalid MFA fixture'}})});});
  await login('pilot@example.test');await page.getByRole('alert').filter({hasText:'Invalid MFA fixture'}).waitFor();assert.equal(mfaAttempts,1);assert.ok(await page.evaluate(()=>sessionStorage.getItem('freedms-token')));
  assert.deepEqual(errors,[]);console.log(`PASS: all login states, challenge completion, reset, and exactly one 401 refresh/retry. Screenshots: ${out}`);
} finally {await browser?.close();vite.kill();await new Promise(r=>mock.server.close(r));}
