// Offline J01/J02 shell spot check, following the persona-journey pack.
// node --import tsx packages/web/test/onboarding-shell-tour.mjs
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {MemoryRepositories} from '../../api/src/memory.ts';
import {createHandler} from '../../api/src/handler.ts';
import {localSession} from '../../api/src/local-session.ts';
import {LocalTokens} from '../../api/src/auth.ts';
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`, 'package.json'));
const {chromium}=require('playwright-core');
const repositories=new MemoryRepositories();
const tokens=new LocalTokens('offline-shell-tour-secret-at-least-32-characters');
const handle=createHandler(repositories,{decode:async()=>{throw Error('Offline only');}});
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5197','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'',VITE_API_URL:'/api'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5197');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':`${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.pathname.startsWith('/api/')) {
      const token=request.headers().authorization?.replace(/^Bearer /,'');
      const response=url.pathname==='/api/local/session'
        ? await localSession(request.postData(),repositories,tokens)
        : await handle({method:request.method(),path:url.pathname.slice(4),query:Object.fromEntries(url.searchParams),body:request.postData() || undefined,...(token?{claims:tokens.verify(token)}:{})});
      await route.fulfill({status:response.statusCode,headers:response.headers,body:response.body});
    } else if(url.hostname==='127.0.0.1') await route.continue();
    else { errors.push(`External request: ${url}`); await route.abort(); }
  });
  await page.goto('http://127.0.0.1:5197',{waitUntil:'networkidle'});
  assert.equal(await page.locator('#onboarding').isVisible(),true);
  assert.equal(await page.locator('#join').isVisible(),true);
  assert.match(await page.locator('body').innerText(),/Create an empty local workspace/);
  assert.equal(await page.locator('.command-bar').count(),0);
  console.log('PASS J01: first-visitor setup and sign-in remain distinct, no authenticated chrome.');
  const fill=async values=>{for(const [key,value] of Object.entries(values)) await page.locator(`#onboarding [name="${key}"]`).fill(value);};
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  await fill({name:'Olivia Owner',email:'owner@shell.example.test'}); await click('Next');
  await fill({dealership:'Shell Motors',address:'100 E2E Drive',phone:'555-010-1000'});
  await page.locator('[name=dealerType]').selectOption('independent'); await click('Next');
  await click('Add invite'); await fill({'name-0':'Sam Sales','email-0':'sam@shell.example.test'}); await click('Next');
  assert.match(await page.locator('body').innerText(),/Finish creates your empty workspace/);
  await click('Back'); await click('Back');
  assert.equal(await page.locator('[name=dealership]').inputValue(),'Shell Motors');
  await click('Next'); await click('Next');
  assert.equal(await page.getByRole('button',{name:'Finish',exact:true}).isDisabled(),true);
  assert.equal(await page.locator('[name=termsAccepted]').isVisible(),true);
  await page.locator('[name=termsAccepted]').check(); await click('Finish');
  await page.getByText('Your workspace is ready').waitFor(); await click('Enter workspace');
  await page.getByText('Your lot starts here',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),true);
  assert.match(await page.locator('.sidebar').innerText(),/Shell Motors/);
  assert.match(await page.locator('.sidebar').innerText(),/Olivia Owner/);
  assert.deepEqual(await page.locator('.nav-label').allTextContents(),['Sales','Operations','Back office','Connect','Workspace']);
  const nav=name=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true}).click();
  await nav('Leads'); await page.getByText('Your next customer starts here',{exact:true}).waitFor();
  await nav('Deals'); await page.getByText('Your first deal starts here',{exact:true}).waitFor();
  await nav('Users'); await page.locator('#add-user').waitFor();
  await nav('Inventory'); await page.locator('#command-prompt').click(); await page.locator('#command-input').fill('imaginary');
  await page.getByText('No records match',{exact:true}).waitFor();
  assert.equal(await page.locator('#command-results [data-href]').count(),0);
  await page.keyboard.press('Escape'); await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('.sidebar.is-slim').count(),1);
  await page.reload({waitUntil:'networkidle'}); assert.equal(await page.locator('.sidebar.is-slim').count(),1);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.sidebar-heading .command-bar').count(),1);
  await page.locator('.menu-toggle').click(); assert.equal(await page.getByRole('navigation',{name:'Main navigation'}).isVisible(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS J02: review/terms, empty workspace, identity, navigation, persistent slim layout and one mobile header.');
} finally {await browser?.close();vite.kill();}
