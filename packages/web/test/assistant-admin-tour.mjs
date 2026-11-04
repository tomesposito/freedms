// Offline tour: real handler, billing repository records and local assistant provider.
// node --import tsx packages/web/test/assistant-admin-tour.mjs
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
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`, 'package.json'));
const {chromium}=require('playwright-core');
const out=process.env.SCREENSHOT_DIR || `${homedir()}/workspace/tools/screenshots/freedms/assistant-admin`;
const now=new Date('2026-11-04T12:00:00Z');
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:9999999999,token_use:'id'};
let handle, repo;
const call=async(path,method='GET',body)=>{
  const r=await handle({path,method,body:body===undefined?undefined:JSON.stringify(body),claims});
  assert.ok(r.statusCode<400,`${path}: ${r.body}`); return JSON.parse(r.body).data;
};
async function setup() {
  const repositories=new MemoryRepositories(); repo=repositories.forTenant('mobile-demo');
  await repo.provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  await seedDemo(repositories,'mobile-demo','admin',now);
  handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now,undefined,undefined,undefined,undefined,{assistantProvider:new LocalAssistantProvider(),assistantSeedLocalPlan:true});
  await call('/assistant/pool');
}
await setup();
await call('/vehicles','POST',{stockNumber:'STOCK-100',vin:'1HGCM82633A004352',year:2003,make:'Honda',model:'Accord',trim:'',mileage:null,status:'available',listPrice:100000,cost:50000,reconCosts:[],dateStocked:'2026-11-04',location:'',notes:''});
await call('/assistant/chat','POST',{messages:[{role:'user',text:'Find stock STOCK-100'}]});
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
  await page.goto('http://127.0.0.1:5199/#/account/assistant',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'CONTROLS',exact:true}).waitFor();
  await page.getByRole('heading',{name:'PLAN',exact:true}).waitFor();
  await page.getByRole('heading',{name:'CREDIT POOL',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Manage billing',exact:true}).isDisabled(),true);
  await page.getByRole('status').filter({hasText:"Billing isn't set up yet."}).waitFor();
  await page.screenshot({path:`${out}/admin.png`,fullPage:true});
  await copyFile(`${out}/admin.png`,'docs/screenshots/ai-assistant-admin.png');
  const save = async (action) => {
    const response = page.waitForResponse(r=>r.url().endsWith('/assistant/admin/settings') && r.request().method()==='PUT');
    await action(); assert.equal((await response).status(),200);
    await page.waitForLoadState('networkidle');
    await page.locator('#assistant-request-cap:enabled').waitFor();
  };
  await save(async()=>{await page.locator('#assistant-request-cap').fill('1');await page.locator('#assistant-request-cap').press('Tab');});
  assert.equal((await call('/assistant/admin')).controls.perRequestCreditCap,1);
  page.on('dialog',dialog=>dialog.accept());
  await save(()=>page.locator('#assistant-enabled').uncheck());
  assert.equal((await call('/assistant/admin')).controls.disabled,true);
  const blocked=await handle({method:'POST',path:'/assistant/chat',claims,body:JSON.stringify({messages:[{role:'user',text:'Hello'}]})});
  assert.equal(blocked.statusCode,403);assert.equal(JSON.parse(blocked.body).error.code,'ASSISTANT_DISABLED');
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'CONTROLS',exact:true}).waitFor();
  assert.equal(await page.locator('#assistant-trigger').isVisible(),false);
  await page.screenshot({path:`${out}/disabled.png`,fullPage:true});
  await save(()=>page.locator('#assistant-enabled').check());
  assert.equal((await call('/assistant/admin')).controls.disabled,false);
  await page.reload({waitUntil:'networkidle'});
  await page.locator('#assistant-trigger').waitFor({state:'visible'});
  await save(()=>page.locator('#assistant-overage').check());
  await save(async()=>{await page.locator('[data-setting="overageCapCredits"]').fill('2');await page.locator('[data-setting="overageCapCredits"]').press('Tab');});
  assert.equal((await call('/assistant/admin')).controls.overageCapCredits,2);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/mobile.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: admin plan/pool/controls, unconfigured billing, cap edits, disable/chat rejection/hidden trigger, re-enable, mobile layout.');
} finally {await browser?.close();vite.kill();}
