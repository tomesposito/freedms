// Offline browser tour: real memory repositories/handler and the normal demo seed.
// Run from the repository root with: node --import tsx packages/web/test/ai-connections-tour.mjs
import {generateKeyPairSync, sign} from 'node:crypto';
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
const out=process.env.SCREENSHOT_DIR || '.pilot/ai-connections-tour';
const repositories=new MemoryRepositories();
const now=new Date();
await repositories.forTenant('mobile-demo').provision({id:'mobile-demo',name:'Demo Motors',createdAt:now.toISOString()}, {id:'admin',name:'Demo Owner',email:'owner@example.test'}, {tenantId:'mobile-demo',userId:'admin',role:'admin',active:true}, {id:'created',tenantId:'mobile-demo',actorId:'admin',aggregateId:'mobile-demo',aggregateVersion:1,type:'tenant.created',occurredAt:now.toISOString(),deliveryStatus:'pending'});
await seedDemo(repositories,'mobile-demo','admin',now);
const claims={sub:'admin','custom:tenant_id':'mobile-demo',iss:'offline',aud:'offline',exp:now.getTime()/1000+3600,token_use:'id'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const mcp={issuer:'https://offline.example/pool',clientId:'offline-client',resource:'http://127.0.0.1:5198/api/mcp',now:()=>now.getTime(),jwks:async()=>({keys:[{...publicKey.export({format:'jwk'}),kid:'offline',alg:'RS256'}]})};
const handle=createHandler(repositories,{decode:async()=>{throw new Error('Offline tour');}},()=>now,undefined,undefined,undefined,undefined,{mcp});
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
  await page.goto('http://127.0.0.1:5198/#/ai-connections',{waitUntil:'networkidle'});
  await page.getByText('No AI connections yet',{exact:true}).waitFor();
  assert.equal(await page.locator('table').count(),0);
  await page.screenshot({path:`${out}/empty.png`,fullPage:true});
  const payload=[{alg:'RS256',kid:'offline'},{sub:'admin',iss:mcp.issuer,client_id:mcp.clientId,scope:'freedms/mcp.read freedms/mcp.write',token_use:'access',exp:now.getTime()/1000+3600}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const used=await handle({path:'/mcp',method:'POST',authorization:`Bearer ${payload}.${sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')}`,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.ok(JSON.parse(used.body).result.tools.length>0);
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'Your connections',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Everyone at this dealership',exact:true}).waitFor();
  assert.equal(await page.getByText('can read and change',{exact:true}).count(),2);
  await page.screenshot({path:'docs/screenshots/ai-connections.png',fullPage:true});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Revoke',exact:true}).first().click();
  await page.getByText('Revoked',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('button',{name:'Revoke',exact:true}).count(),0);
  assert.ok((await call('/ai-connections'))[0].revokedAt);
  await page.screenshot({path:`${out}/revoked.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.reload({waitUntil:'networkidle'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${out}/mobile.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: empty state, real MCP first use, plain scopes, admin view, revoke flow and mobile layout; README capture refreshed.');
} finally {await browser?.close();vite.kill();}
