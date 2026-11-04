// Offline tour: real handler, billing repository records and local assistant provider.
// node --import tsx packages/web/test/assistant-tour.mjs
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir, copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {MemoryRepositories} from '../../api/src/memory.ts';
import {createHandler} from '../../api/src/handler.ts';
import {seedDemo} from '../../api/src/demo-seed.ts';
import {LocalAssistantProvider} from '../../api/src/local-assistant.ts';
import {UnconfiguredAssistantProvider} from '../../api/src/assistant-provider.ts';
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`, 'package.json'));
const {chromium}=require('playwright-core');
const out=process.env.SCREENSHOT_DIR || `${homedir()}/workspace/tools/screenshots/freedms/assistant`;
const now=new Date('2026-11-04T12:00:00Z');
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:9999999999,token_use:'id'};
let handle, repo;
const call=async(path,method='GET',body)=>{
  const r=await handle({path,method,body:body===undefined?undefined:JSON.stringify(body),claims});
  assert.ok(r.statusCode<400,`${path}: ${r.body}`); return JSON.parse(r.body).data;
};
async function setup(state, provider=new LocalAssistantProvider()) {
  const repositories=new MemoryRepositories(); repo=repositories.forTenant('mobile-demo');
  await repo.provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  await seedDemo(repositories,'mobile-demo','admin',now);
  handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now,undefined,undefined,undefined,undefined,{assistantProvider:state==='unconfigured'?new UnconfiguredAssistantProvider():provider,assistantSeedLocalPlan:state!=='paywall'});
  if(state!=='paywall') {
    const pool=await call('/assistant/pool');
    if(state==='disabled') {
      const plan=await repo.assistantPlan();
      await repo.saveAssistantPlan({...plan,disabled:true,version:plan.version+1},plan.version,{id:'disable',tenantId:'mobile-demo',actorId:'admin',aggregateId:plan.id,aggregateVersion:plan.version+1,type:'assistant-plan.updated',occurredAt:now.toISOString(),deliveryStatus:'pending'});
    }
    if(state==='exhausted') {
      const cycle=await repo.assistantCycle(pool.cycleStart);
      await repo.saveAssistantCycle({...cycle,allotmentCredits:0,version:cycle.version+1},cycle.version);
    }
  }
}
await setup('ready');
await call('/vehicles','POST',{stockNumber:'STOCK-100',vin:'1HGCM82633A004352',year:2003,make:'Honda',model:'Accord',trim:'',mileage:null,status:'available',listPrice:100000,cost:50000,reconCosts:[],dateStocked:'2026-11-04',location:'',notes:''});
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5199','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'',VITE_API_URL:'/api'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5199');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':`${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`),args:['--no-sandbox']});
  await mkdir(out,{recursive:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>sessionStorage.setItem('freedms-token','offline'));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/api/')){
      const r=await handle({method:route.request().method(),path:url.pathname.slice(4),query:Object.fromEntries(url.searchParams),body:route.request().postData() || undefined,...(url.pathname.startsWith('/api/share/')||url.pathname.startsWith('/api/invite/')?{}:{claims})});
      await route.fulfill({status:r.statusCode,headers:r.headers,body:r.body});
    }else if(url.hostname==='127.0.0.1') await route.continue();
    else {errors.push(`External request: ${url}`);await route.abort();}
  });
  let visit=0;
  const goto=()=>page.goto(`http://127.0.0.1:5199/?tour=${++visit}#/`,{waitUntil:'networkidle'});
  const open=()=>page.locator('#assistant-trigger').click();
  const shot=async name=>{await page.evaluate(async()=>{await Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})));});await page.screenshot({path:`${out}/${name}.png`,fullPage:false});};
  const input=page.locator('#assistant-input');
  await goto();
  const initial=(await call('/assistant/pool')).balanceCredits;
  await page.locator('#assistant-trigger').filter({hasText:`${initial} credits`}).waitFor();
  assert.equal(await page.locator('#assistant-tray').isVisible(),false);
  await shot('closed');
  await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('.sidebar.is-slim').count(),1);
  await open();
  await page.getByRole('heading',{name:'What do you need done?'}).waitFor();
  assert.equal(await input.isEnabled(),true);
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('#assistant-tray').evaluate(el=>el.getBoundingClientRect().width),400);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#assistant-trigger').evaluate(el=>el===document.activeElement),true);
  await page.locator('#sidebar-toggle').click();
  await open(); await shot('empty');
  await input.fill('Find stock STOCK-100'); await input.press('Enter');
  await page.locator('.assistant-receipt').waitFor();
  await page.locator('.assistant-tool').filter({hasText:'Search inventory'}).waitFor();
  assert.match(await page.locator('.assistant-reply').textContent(),/STOCK-100: 2003 Honda Accord/);
  const used=initial-(await call('/assistant/pool')).balanceCredits;
  assert.ok(used>0);
  assert.equal(await page.locator('.assistant-receipt').textContent(),`This used ${used} ${used===1?'credit':'credits'}`);
  await page.locator('#assistant-trigger').filter({hasText:`${initial-used} credits`}).waitFor({state:'attached'});
  await shot('conversation'); await copyFile(`${out}/conversation.png`,'docs/screenshots/ai-assistant.png');
  // A route render restores the open tray and its in-memory conversation.
  await page.evaluate(()=>{location.hash='#/leads';});
  await page.getByRole('heading',{name:'Leads',exact:true}).waitFor();
  await page.locator('.assistant-receipt').waitFor();
  assert.equal(await page.locator('#assistant-tray').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(Math.abs(await page.locator('#assistant-tray').evaluate(el=>el.getBoundingClientRect().width)-390)<1);
  await shot('mobile');
  await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.reload({waitUntil:'networkidle'}); await open();
  assert.equal(await page.locator('.assistant-user').count(),0);
  await page.setViewportSize({width:1440,height:1000});
  for(const state of ['paywall','disabled','exhausted','unconfigured']) {
    await setup(state); await goto();
    if(state==='disabled') {
      // Since the #100 follow-up (184b71b) a disabled assistant is absent entirely:
      // no trigger, no tray. The admin surface (assistant-admin-tour) is where it is turned back on.
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#assistant-trigger').isVisible(),false);
      assert.equal(await page.locator('#assistant-tray').isVisible(),false);
      await shot(state);
      continue;
    }
    await open();
    if(state==='unconfigured') {await input.fill('Hello');await input.press('Enter');}
    const text={paywall:'The assistant is a paid add-on.',exhausted:'You are out of credits.',unconfigured:"The AI assistant isn't set up."}[state];
    await page.getByRole('heading',{name:text,exact:true}).waitFor();
    assert.equal(await input.isDisabled(),true);
    if(state==='paywall') assert.equal(await page.locator('.assistant-balance').count(),0);
    if(state==='exhausted') assert.match(await page.locator('.assistant-body').textContent(),/December 4, 2026/);
    if(state==='unconfigured') {
      await page.keyboard.press('Escape'); await open();
      assert.equal(await input.isDisabled(),true);
    }
    await shot(state);
  }
  // A provider failure stays visible and retry uses valid alternating history.
  let fail=true;
  const local=new LocalAssistantProvider();
  await setup('ready',{configured:true,converse:async messages=>{await new Promise(r=>setTimeout(r,150));if(fail){fail=false;throw Error('offline failure');}return local.converse(messages);}});
  await goto(); await open(); await input.fill('Hello'); await input.press('Enter');
  await page.getByText('Working…',{exact:true}).waitFor();
  await page.locator('.assistant-error').waitFor();
  assert.equal(await input.isEnabled(),true);
  assert.equal(await page.locator('.assistant-user').first().textContent(),'Hello');
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.locator('.assistant-receipt').waitFor();
  assert.equal(await page.locator('.assistant-receipt').textContent(),'This used 1 credit');
  // Entitlement can change after opening: the chat error must immediately lock.
  const plan=await repo.assistantPlan();
  await repo.saveAssistantPlan({...plan,disabled:true,version:plan.version+1},plan.version,{id:'disable-after-open',tenantId:'mobile-demo',actorId:'admin',aggregateId:plan.id,aggregateVersion:plan.version+1,type:'assistant-plan.updated',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  await input.fill('One more question'); await input.press('Enter');
  // Since 184b71b the disabled state removes the assistant entirely instead of showing a locked tray.
  await page.locator('#assistant-trigger').waitFor({state:'hidden'});
  assert.equal(await page.locator('#assistant-tray').isVisible(),false);
  assert.equal(await page.locator('.assistant-receipt').count(),1);
  await setup('ready');
  const balance=await call('/assistant/pool'), cycle=await repo.assistantCycle(balance.cycleStart);
  await repo.saveAssistantCycle({...cycle,allotmentCredits:1,version:cycle.version+1},cycle.version);
  await goto(); await open(); await input.fill('Hello'); await input.press('Enter');
  await page.getByRole('heading',{name:'You are out of credits.',exact:true}).waitFor();
  assert.equal(await input.isDisabled(),true);
  assert.equal(await page.locator('.assistant-receipt').textContent(),'This used 1 credit');
  assert.deepEqual(errors,[]);
  console.log('PASS: all eight captures, real tool/receipt/balance, locked states, provider retry, route memory, reload reset, focus, slim sidebar and 390px open/closed layout.');
} finally {await browser?.close();vite.kill();}
