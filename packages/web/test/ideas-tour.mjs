// Offline browser tour: real memory repositories/handler and the normal demo seed.
// Run from the repository root with: node --import tsx packages/web/test/mobile-tour.mjs
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {MemoryRepositories} from '../../api/src/memory.ts';
import {createHandler} from '../../api/src/handler.ts';
import {seedDemo} from '../../api/src/demo-seed.ts';
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`, 'package.json'));
const {chromium}=require('playwright-core');
const out=process.env.SCREENSHOT_DIR || '.pilot/ideas-tour';
const repositories=new MemoryRepositories();
const now=new Date();
await repositories.forTenant('mobile-demo').provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
await seedDemo(repositories,'mobile-demo','admin',now);
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:now.getTime()/1000+3600,token_use:'id'};
const handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now,undefined,undefined,undefined,undefined,{pilotOperator:{tenantId:'mobile-demo',userId:'admin'}});
const call=async(path,method='GET',body)=>{
  const url=new URL(path,'http://offline');
  const r=await handle({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body:body===undefined?undefined:JSON.stringify(body),claims});
  assert.ok(r.statusCode<400,`${path}: ${r.body}`); return JSON.parse(r.body).data;
};
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5198','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'',VITE_API_URL:'/api'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5198');break;}catch{await new Promise(r=>setTimeout(r,100));}}
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
  await page.goto('http://127.0.0.1:5198/#/ideas',{waitUntil:'networkidle'});
  await page.getByText('No ideas yet',{exact:true}).waitFor();
  await page.screenshot({path:`${out}/empty.png`,fullPage:true});
  await page.getByLabel('Title',{exact:true}).fill('Remember inventory search filters');
  await page.getByLabel('Description',{exact:true}).fill('When I return from a vehicle detail page, keep the search and status filters I was using. This would help me work through the lot without starting over.');
  await page.getByRole('button',{name:'Submit idea',exact:true}).click();
  await page.getByText('Received',{exact:true}).waitFor();
  const [idea]=await call('/ideas');
  assert.equal(idea.surface,'/ideas');assert.equal(idea.productVersion,'0.1.0');
  await page.screenshot({path:'docs/screenshots/ideas.png',fullPage:true});
  await page.goto('http://127.0.0.1:5198/#/ideas-review',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Ideas review',exact:true}).waitFor();
  await page.locator('select[name=status]').selectOption('Under review');
  await page.getByRole('button',{name:'Save review',exact:true}).click();
  await page.locator('.badge').filter({hasText:'Under review'}).waitFor();
  await page.screenshot({path:'docs/screenshots/ideas-operator.png',fullPage:true});
  await page.locator('select[name=status]').selectOption('Declined');
  await page.getByLabel('Decline reason (required when declining)').fill('Tour-only review: this example is outside the current scope.');
  await page.getByRole('button',{name:'Save review',exact:true}).click();
  await page.locator('.badge').filter({hasText:'Declined'}).waitFor();
  await page.goto('http://127.0.0.1:5198/#/ideas',{waitUntil:'networkidle'});
  await page.getByText('Tour-only review: this example is outside the current scope.',{exact:false}).waitFor();
  for(const path of ['/ideas','/ideas-review']){
    await page.setViewportSize({width:390,height:844});
    await page.goto(`http://127.0.0.1:5198/#${path}`,{waitUntil:'networkidle'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path);
    await page.screenshot({path:`${out}/${path.slice(1)}-mobile.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: empty state, real submission, operator review, decline reason, and mobile layouts; README captures refreshed.');
} finally {await browser?.close();vite.kill();}
