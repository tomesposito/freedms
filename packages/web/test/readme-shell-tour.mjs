// Stateful README captures using real handlers and an explicit offline extraction fixture.
// Run from the repository root with: node --import tsx packages/web/test/readme-shell-tour.mjs
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
const out=process.env.SCREENSHOT_DIR || 'docs/screenshots';
const repositories=new MemoryRepositories();
const now=new Date();
await repositories.forTenant('mobile-demo').provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
await seedDemo(repositories,'mobile-demo','admin',now);
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:now.getTime()/1000+3600,token_use:'id'};
// Explicit extraction fixture: no hosted model or external service is called.
// Restore the pre-#106 tour's text Silverado and photo Camry review states.
const textDraft = {year:2019,make:'Chevrolet',model:'Silverado',trim:'LT',listPrice:24995,cost:18500,notes:'88,000 miles'};
const photoDraft = {vin:'1HGCM82633A004352',year:2021,make:'Toyota',model:'Camry',trim:'SE',listPrice:26995};
const provider = {configured:true,supportsVision:true,extractVehicle:async()=>textDraft,extractLead:async()=>({}),extractVehiclePhoto:async()=>photoDraft};
const handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now,undefined,provider);
const call=async(path,method='GET',body)=>{
  const url=new URL(path,'http://offline');
  const r=await handle({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body:body===undefined?undefined:JSON.stringify(body),claims});
  assert.ok(r.statusCode<400,`${path}: ${r.body}`); return JSON.parse(r.body).data;
};
const vehicles=await call('/vehicles'), leads=await call('/leads'), deals=await call('/deals');
const parts=await call('/parts'), ros=await call('/service/repair-orders'), appointments=await call('/service/appointments');
const rows=value=>Array.isArray(value)?value:value.items;
const vehicle=rows(vehicles)[0], lead=rows(leads)[0], deal=deals.find(d=>d.status!=='sold');
const share=await call(`/deals/${deal.id}/share`,'POST',{});
const accounts=await call('/accounting/accounts');
const bank=accounts.find(a=>a.type==='asset' && /cash/i.test(a.name));
const yesterday=new Date(now.getTime()-86400000).toISOString().slice(0,10);
const period=await call('/accounting/reconciliations','POST',{accountId:bank.id,from:yesterday,to:yesterday,opening:0,closing:0});
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','packages/web','--host','127.0.0.1','--port','5198','--strictPort'],{env:{...process.env,VITE_COGNITO_DOMAIN:'',VITE_API_URL:'/api'},stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:5198');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':`${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`),args:['--no-sandbox']});
  await mkdir(out,{recursive:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
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
  await page.setViewportSize({width:1280,height:900});
  const go = path => page.goto(`http://127.0.0.1:5198/#${path}`,{waitUntil:'networkidle'});
  const shot = (name, fullPage=true) => page.screenshot({path:`${out}/${name}.png`,fullPage});
  // Keep the sticky command bar in frame while focusing each caption's section.
  const sectionShot = async (name, heading) => {
    const target = page.getByRole('heading',{name:heading,exact:true});
    await target.waitFor();
    await target.evaluate(el=>window.scrollTo(0,window.scrollY+el.getBoundingClientRect().top-70));
    const box = await target.boundingBox();
    const bar = await page.locator('.command-bar').boundingBox();
    assert.ok(box && box.y >= 42 && box.y + box.height < 800, `${name}: heading in frame`);
    assert.ok(bar && bar.y >= 0 && bar.y + bar.height <= 70, `${name}: command bar in frame`);
    await shot(name,false);
  };
  await go('/parts');
  await sectionShot('parts-catalog','Catalog');
  await sectionShot('parts-counter-sale','Counter sale');
  await sectionShot('parts-orders','Purchase orders');
  await go(`/deals/${deal.id}`);
  await page.locator('#totals').getByText('Amount financed',{exact:false}).first().waitFor();
  await sectionShot('deal-worksheet','Worksheet totals');
  await page.locator('#share-create').waitFor();
  await sectionShot('deal-share','Share with buyer');
  await go('/import');
  await page.locator('#import-file').setInputFiles({name:'inventory.csv',mimeType:'text/csv',buffer:Buffer.from('stockNumber,vin,year,make,model,listPrice,cost\nIMPORT-1,1HGCM82633A004352,2003,Honda,Accord,8000,6000\nIMPORT-2,invalid,2020,Ford,Focus,12000,9000\n')});
  await page.locator('#import-preview').click(); await page.locator('#import-results table').waitFor(); await shot('import-preview');
  await go(`/accounting/reconciliations/${period.id}`);
  await page.locator('#csv [name=file]').setInputFiles({name:'statement.csv',mimeType:'text/csv',buffer:Buffer.from(`id,date,description,amountCents\nBANK-1,${yesterday},Deposit,100000\nBANK-2,${yesterday},Fee,-2500\n`)});
  await page.getByRole('button',{name:'Preview CSV',exact:true}).click(); await page.locator('#confirm-import').waitFor(); await shot('bank-import-preview');
  await go('/');
  await page.locator('#quick-entry textarea').fill('Just took in a 2019 Chevrolet Silverado LT, list $24,995, cost $18,500, 88,000 miles');
  await page.getByRole('button',{name:'Draft vehicle',exact:true}).click(); await page.getByText('Review the AI draft — nothing is saved until you save.',{exact:true}).waitFor(); assert.equal(await page.locator('[name=model]').inputValue(),'Silverado'); assert.equal(await page.locator('[name=listPrice]').inputValue(),'24995.00'); await shot('quick-entry-draft');
  await go('/');
  await page.locator('#quick-entry input[type=file]').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64')});
  await page.getByText('Review the AI draft — nothing is saved until you save.',{exact:true}).waitFor(); assert.equal(await page.locator('[name=model]').inputValue(),'Camry'); assert.equal(await page.locator('[name=listPrice]').inputValue(),'26995.00'); assert.equal(await page.locator('[name=vin]').inputValue(),photoDraft.vin); await shot('quick-entry-photo');
  await go('/welcome'); await shot('invite-welcome');
  assert.deepEqual(errors,[]);
  console.log('PASS: README parts sections, worksheet/share, import, statement, text/photo drafts and welcome shell captures. Extraction uses an explicit offline fixture.');
} finally {await browser?.close();vite.kill();}
