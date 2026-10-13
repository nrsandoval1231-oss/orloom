import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Rendering/authentication check only. The controlled local mission has no
// executing builders, certificates, claimed improvements or verified outcome.
const source = resolve(process.argv[2] ?? '');
const expected = process.argv[3];
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
const git = args => execFileSync('git', ['-C', source, ...args], {encoding:'utf8', windowsHide:true}).trim();
assert.equal(git(['rev-parse','HEAD']), expected);
assert.equal(git(['status','--porcelain']), '');
const load = file => import(pathToFileURL(join(source,'dist',file)).href);
const {createControlPlane} = await load('apps/control-plane/src/server.js');
const {MemoryJobStore} = await load('packages/contracts/src/memory-store.js');
const {MemoryMissionStore} = await load('packages/contracts/src/memory-mission-store.js');
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/nrsan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const out = resolve('work/loom-browser-checks', new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
const token=randomBytes(32).toString('base64url'), store=new MemoryMissionStore();
const mission=await store.submit({repository:'orloom/browser-proof',baseSha:'a'.repeat(40),objective:'Controlled local rendering check — no builders running',acceptance:['Show actual recorded mission state'],budgetCents:60});
const slices=[
  {id:'control-plane',objective:'Owner mission interface',owner:'unassigned',dependencies:[],scopes:['apps/control-plane'],checks:['node-repo-suite-v1'],budgetCents:20},
  {id:'verification',objective:'Independent evidence checks',owner:'unassigned',dependencies:[],scopes:['packages/verification'],checks:['node-repo-suite-v1'],budgetCents:20},
  {id:'delivery',objective:'Reviewed delivery',owner:'unassigned',dependencies:['control-plane','verification'],scopes:['packages/integration'],checks:['node-repo-suite-v1'],budgetCents:20}
];
await store.recommendPlan(mission.id,slices,'controlled-browser-proof');
await store.approvePlan(mission.id);
const server=createControlPlane({mode:'local',port:0,sessionToken:token,workerToken:randomBytes(32).toString('base64url'),capacitySlots:0,maxLanes:6,trustedCheckPolicy:[],trustedCheckPolicyDigest:'c'.repeat(64)},new MemoryJobStore(),store);
await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
const address=server.address();assert(address&&typeof address==='object');
const origin=`http://127.0.0.1:${address.port}`, url=`${origin}/loom?mission=${mission.id}`;
let browser;const pageErrors=[],requests=[];const results={candidate:expected,store:'MemoryMissionStore',controlledMission:true,providerCalls:0,workerExecutions:0,certificates:0,startedUtc:new Date().toISOString()};
try{
  browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage();
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('request',r=>{const u=new URL(r.url());requests.push({method:r.method(),path:u.pathname});});
  await page.goto(url);await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.includes('session'),{},{timeout:15000});
  results.unauthenticated='owner session required';
  const login=await context.request.post(origin+'/session',{data:{token}});assert.equal(login.status(),204);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#live')?.textContent==='Live connection',{},{timeout:15000});
  assert.equal(await page.locator('#slices li').count(),3);
  assert.match(await page.locator('#notice').innerText(),/Open|waiting/i);
  results.webgl=await page.locator('#loom').evaluate(c=>!!c.getContext('webgl2'));
  assert.equal(results.webgl,true);assert.equal(await page.locator('#loom').isVisible(),true);assert.equal(await page.locator('#fallback').isVisible(),false);
  await page.screenshot({path:join(out,'desktop.png'),fullPage:true});
  await page.keyboard.press('Tab');results.keyboardFocus=await page.evaluate(()=>document.activeElement?.tagName);assert.notEqual(results.keyboardFocus,'BODY');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'mobile.png'),fullPage:true});
  results.mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(results.mobileOverflow,false);
  await page.locator('#inspect summary').click();assert.equal(await page.locator('#refresh').isVisible(),true);await page.screenshot({path:join(out,'mobile-inspector.png'),fullPage:true});await context.setOffline(true);await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#live')?.textContent?.includes('Disconnected'),{},{timeout:15000});
  results.offline=await page.locator('#live').innerText();await page.screenshot({path:join(out,'disconnected.png'),fullPage:true});
  await context.setOffline(false);await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#live')?.textContent==='Live connection',{},{timeout:15000});results.reconnected=true;
  const fallback=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  assert.equal((await fallback.request.post(origin+'/session',{data:{token}})).status(),204);
  await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl2'?null:original.call(this,kind,...args);};});
  const fp=await fallback.newPage();fp.on('pageerror',e=>pageErrors.push(e.message));await fp.goto(url);await fp.waitForFunction(()=>document.querySelector('#live')?.textContent==='Live connection',{},{timeout:15000});results.fallbackState=await fp.locator('#fallback').evaluate(e=>({hasHiddenAttribute:e.hasAttribute('hidden'),hiddenProperty:e.hidden,display:getComputedStyle(e).display}));await fp.screenshot({path:join(out,'webgl-fallback.png'),fullPage:true});assert.equal(await fp.locator('#fallback').isVisible(),true);results.fallback=true;await fp.locator('#fallback .slice').first().focus();await fp.keyboard.press('Enter');assert.equal(await fp.locator('#inspect').getAttribute('open'),'');assert.equal(await fp.evaluate(()=>document.activeElement?.matches('#slices li')),true);await fp.setViewportSize({width:1440,height:1000});await fp.locator('#fallback .slice').first().click();assert.equal(await fp.evaluate(()=>document.activeElement?.matches('#slices-desktop li')),true);results.fallbackSelection='mobile Enter and desktop click';
  assert.equal(pageErrors.length,0);assert(requests.filter(r=>r.path.startsWith('/api/')).every(r=>r.method==='GET'));results.status='PASS_RENDERING_ONLY';
}catch(error){results.status='FAIL';results.error=error.message;throw error;}
finally{
  if(browser)await browser.close();await new Promise((resolveClose,reject)=>server.close(e=>e?reject(e):resolveClose()));
  const modules={};for(const file of ['apps/control-plane/src/server.js','apps/control-plane/src/loom-page.js','apps/control-plane/src/loom-projection.js'])modules[file]=createHash('sha256').update(await readFile(join(source,'dist',file))).digest('hex');
  await writeFile(join(out,'result.json'),JSON.stringify({...results,finishedUtc:new Date().toISOString(),pageErrors,requests,modules,limitations:['Memory-store controlled mission; not PostgreSQL durability proof','No live builder, provider, certification or deployment evidence']},null,2));
  console.log(JSON.stringify({status:results.status,evidence:out,candidate:expected}));
}
