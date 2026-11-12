// Offline UI verification using the real tenant-scoped handler and seeded local data.
// node --import tsx packages/web/test/overview-tour.mjs
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {MemoryRepositories} from '../../api/src/memory.ts';
import {createHandler} from '../../api/src/handler.ts';
import {seedDemo} from '../../api/src/demo-seed.ts';
const require=createRequire(resolve(process.env.PLAYWRIGHT_ROOT || `${homedir()}/workspace/tools/screenshots`, 'package.json'));
const {chromium}=require('playwright-core');
const now=new Date();
const claims={sub:'admin','custom:tenant_id':'overview-demo',iss:'offline',aud:'offline',exp:9999999999,token_use:'id'};
let handle, state='populated', release;
async function setup(seed=true) {
  const repositories=new MemoryRepositories();
  await repositories.forTenant('overview-demo').provision({id:'overview-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'overview-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'overview-demo',actorId:'admin',aggregateId:'overview-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
  if(seed) await seedDemo(repositories,'overview-demo','admin',now);
  handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now);
}
await setup();
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5198','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'',VITE_API_URL:'/api'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5198');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':`${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>sessionStorage.setItem('freedms-token','offline'));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/api/')){
      if(url.pathname==='/api/reports/overview' && state==='loading') await new Promise(r=>{release=r;});
      const r=await handle({method:route.request().method(),path:url.pathname.slice(4),query:Object.fromEntries(url.searchParams),body:route.request().postData() || undefined,claims});
      if(url.pathname==='/api/reports/overview' && ['partial','error'].includes(state)) {
        const body=JSON.parse(r.body);
        for(const source of state==='partial'?['inventory']:['inventory','sales','leads']) body.data[source]={status:'rejected',reason:'The report could not be loaded. Please retry.'};
        r.body=JSON.stringify(body);
      }
      await route.fulfill({status:r.statusCode,headers:r.headers,body:r.body});
    } else if(url.hostname==='127.0.0.1') await route.continue();
    else {errors.push(`External request: ${url}`);await route.abort();}
  });
  await mkdir('docs/screenshots',{recursive:true});
  await mkdir('/tmp/freedms-overview-states',{recursive:true});
  let visit=0;
  const goto=()=>page.goto(`http://127.0.0.1:5198/?tour=${++visit}#/overview`,{waitUntil:'domcontentloaded'});
  const ready=()=>page.locator('.overview-tiles strong').first().waitFor();
  const shot=name=>page.screenshot({path:`/tmp/freedms-overview-states/${name}.png`,fullPage:true});
  await goto(); await ready(); await page.locator('.overview-chart svg').first().waitFor();
  assert.equal(await page.locator('.overview-tile').count(),6);
  await page.screenshot({path:'docs/screenshots/lot-overview.png',fullPage:true});
  await shot('1-populated');
  await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('.overview-tile').count(),6);
  await page.locator('#sidebar-toggle').click();
  for(const width of [900,390,320]){
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(width===390) await shot('5-mobile');
  }
  await page.setViewportSize({width:1440,height:1000});
  state='partial'; await goto(); await ready();
  await page.locator('[data-overview-retry]').waitFor();
  assert.equal(await page.locator('.overview-chart').count(),2); await shot('4-partial-error');
  state='populated'; await page.locator('[data-overview-retry]').click(); await page.locator('.overview-chart svg').first().waitFor();
  state='error'; await goto(); await page.locator('#retry-load').waitFor(); await shot('4-full-error');
  state='populated'; await page.locator('#retry-load').click(); await ready();
  state='loading'; await goto(); await page.getByRole('status').filter({hasText:'Loading reports…'}).waitFor();
  assert.equal(await page.locator('.overview-skeleton').count(),9); await shot('3-loading');
  state='populated'; release(); await ready();
  await setup(false); state='empty'; await goto(); await ready();
  assert.equal(await page.locator('.overview-chart').count(),0);
  assert.equal(await page.getByRole('link',{name:'Add vehicle',exact:true}).count(),1);
  await shot('2-empty');
  assert.deepEqual(errors,[]);
  console.log('Overview tour passed: populated, empty, loading, partial/full errors and Retry, slim rail, 900/390/320px.');
} finally {await browser?.close();vite.kill('SIGTERM');}
