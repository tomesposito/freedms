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
const out=process.env.SCREENSHOT_DIR || '.pilot/mobile-tour';
const repositories=new MemoryRepositories();
const now=new Date();
await repositories.forTenant('mobile-demo').provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
await seedDemo(repositories,'mobile-demo','admin',now);
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:now.getTime()/1000+3600,token_use:'id'};
const handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now);
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
// Include nested editors, record details and public routes as well as sidebar destinations.
const routes=[
  '/',
  '/welcome',
  '/new',
  '/leads',
  '/leads/new',
  '/leads/equity',
  `/leads/${lead.id}`,
  `/vehicles/${vehicle.id}`,
  `/vehicles/${vehicle.id}/edit`,
  '/deals',
  '/deals/new',
  '/deals/settings',
  `/deals/new/lead/${lead.id}`,
  `/deals/new/vehicle/${vehicle.id}`,
  `/deals/${deal.id}`,
  `/deals/${deal.id}/credit`,
  `/deals/${deal.id}/compliance`,
  `/deals/${deals.find(d=>d.status==='sold').id}/jacket`,
  '/service',
  '/service/settings',
  '/service/appointments/new',
  '/service/repair-orders/new',
  `/service/appointments/${appointments[0].id}`,
  `/service/repair-orders/${ros[0].id}`,
  `/service/repair-orders/new/${appointments[0].id}`,
  `/service/history/vehicle/${vehicle.id}`,
  `/service/history/customer/${lead.customerId}`,
  '/parts',
  '/parts/new',
  `/parts/${parts[0].id}`,
  '/accounting',
  '/accounting/ap',
  '/accounting/ar',
  '/accounting/cash',
  `/accounting/cash/${bank.id}`,
  '/accounting/reconciliations',
  `/accounting/reconciliations/${period.id}`,
  `/accounting/deals/${deal.id}`,
  '/reports',
  '/documents',
  '/compliance',
  '/compliance/privacy',
  '/compliance/audit',
  '/fi-products',
  '/import',
  '/feeds',
  '/webhooks',
  '/account',
  '/users',
  '/terms',
  '/privacy',
  `/share/${share.token}`,
  '/invite/invalid',
  '/join'
];
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
  const log=[];
  for(const [index,path] of routes.entries()){
    await page.goto(`http://127.0.0.1:5198/?route=${encodeURIComponent(path)}#${path}`,{waitUntil:'networkidle'});
    await page.locator('h1, h2').first().waitFor({timeout:10000});
    assert.equal(await page.locator('#retry-load, #message:visible').count(),0,`${path}: load error`);
    const result=await page.evaluate(()=>({width:document.documentElement.scrollWidth,heading:document.querySelector('h1, h2').textContent,offenders:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>390 && !e.closest('.table-wrap, #service-totals')).map(e=>`${e.tagName}.${e.className}#${e.id}`).slice(0,15)}));
    const layoutErrors=await page.evaluate(()=>{
      const failures=[];
      for(const row of document.querySelectorAll('.filters, #service-date, .vin-row')){
        const controls=[...row.querySelectorAll('input, select, button')].filter(e=>e.getClientRects().length);
        for(const [i,control] of controls.entries()){
          const a=control.getBoundingClientRect();
          if(control.matches('input, select') && a.width<180) failures.push('Squeezed field: '+control.name);
          for(const other of controls.slice(i+1)){
            const b=other.getBoundingClientRect();
            if(a.left<b.right && b.left<a.right && a.top<b.bottom && b.top<a.bottom) failures.push('Overlapping controls');
          }
        }
      }
      for(const wrap of document.querySelectorAll('.table-wrap')){
        const a=wrap.getBoundingClientRect();
        if(a.right>390 || a.left<0) failures.push('Table container outside viewport');
        if(wrap.scrollWidth>wrap.clientWidth){
          wrap.scrollLeft=50;
          if(wrap.scrollLeft===0) failures.push('Wide table cannot scroll');
          wrap.scrollLeft=0;
        }
      }
      return failures;
    });
    assert.deepEqual(layoutErrors,[],path);
    if(await page.locator('.menu-toggle').count()){
      await page.locator('.menu-toggle').click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390),`${path}: open menu`);
      await page.locator('.menu-toggle').click();
    }
    log.push({path,...result});console.log(path,JSON.stringify(result));
    await page.screenshot({path:`${out}/${String(index).padStart(2,'0')}.png`,fullPage:true});
    if(['/leads','/reports','/accounting','/parts'].includes(path)) await page.screenshot({path:`docs/screenshots/${path.slice(1)}-mobile.png`,clip:{x:0,y:0,width:390,height:1200}});
  }
  await writeFile(`${out}/scroll-width.json`,JSON.stringify(log,null,2)+'\n');
  assert.deepEqual(log.filter(r=>r.width>390),[],'Document overflow');
  await writeFile('docs/screenshots/mobile-scroll-width.json',JSON.stringify(log,null,2)+'\n');
  assert.deepEqual(errors,[]);
  for(const path of ['/','/leads','/reports','/accounting','/parts','/service']){
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`http://127.0.0.1:5198/?route=${encodeURIComponent(path)}#${path}`,{waitUntil:'networkidle'});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path);
    await page.locator('#sidebar-toggle').click();
    assert.ok(await page.evaluate(()=>getComputedStyle(document.querySelector('.sidebar')).position==='fixed' && document.documentElement.scrollWidth<=innerWidth),`${path}: slim sidebar`);
    await page.locator('#sidebar-toggle').click();
    await page.screenshot({path:`${out}/desktop-${path.slice(1)||'inventory'}.png`,fullPage:true});
    if(['/leads','/reports','/accounting','/parts','/service'].includes(path)) await page.screenshot({path:`docs/screenshots/${({'/leads':'leads-list','/parts':'parts-catalog','/service':'service-board'})[path] || path.slice(1)}.png`,fullPage:true});
  }
  console.log(`PASS: ${routes.length} routes at 390px plus desktop checks. Evidence: ${out}`);
} finally {await browser?.close();vite.kill();}
