import {createPlaytestUi} from './playtest-ui.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function createPreparationGate(){
 let turn=Promise.resolve(),failure;
 return async()=>{
  let release;const previous=turn;turn=new Promise(resolve=>{release=resolve;});
  await previous;
  if(failure){release();throw new Error('Earlier browser preparation failed',{cause:failure});}
  return error=>{failure ||= error;release();};
 };
}

async function preparationSelfCheck(){
 const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const gate=createPreparationGate(),prepared=Array.from({length:3},deferred),barrier=deferred(),activeEnd=deferred();
 const events=[];let preparing=0,maxPreparing=0,active=0;
 const jobs=prepared.map(async(signal,index)=>{
  const release=await gate();preparing++;maxPreparing=Math.max(maxPreparing,preparing);events.push(`prepare-${index}`);
  await signal.promise;preparing--;events.push(`ready-${index}`);release();
  await barrier.promise;active++;await activeEnd.promise;active--;
 });
 await flush();assert.deepEqual(events,['prepare-0']);
 for(let index=0;index<3;index++){prepared[index].resolve();await flush();assert(events.includes(`ready-${index}`));if(index<2)assert(events.includes(`prepare-${index+1}`));}
 assert.equal(maxPreparing,1);assert.equal(active,0);
 barrier.resolve();await flush();assert.equal(active,3,'Prepared clients resume together before any active client finishes');
 activeEnd.resolve();await Promise.all(jobs);
 const failedGate=createPreparationGate(),release=await failedGate(),failure=Error('preparation failed');
 const waiting=failedGate();release(failure);
 await assert.rejects(waiting,error=>error.cause===failure);
 await assert.rejects(failedGate(),error=>error.cause===failure,'Failure releases queued slots without launching more clients');
 console.log('browser preparation self-check passed: serial readiness, concurrent common-barrier activity, failure propagation and queue release');
}
if(process.argv[2]==='--self-check'){await preparationSelfCheck();process.exit(0);}

const [output='output/browser-play',countArg='1',shardArg='0',epochArg='0',durationArg,scenario='youth',totalArg='25',densityArg='2']=process.argv.slice(2);
const count=Number(countArg),shardId=Number(shardArg),startEpochMs=Number(epochArg),durationSeconds=Number(durationArg||(scenario==='soak'?'600':'60'));assert(['youth','career','soak'].includes(scenario));
const totalClients=Number(totalArg),clientsPerShard=Number(densityArg);
assert(Number.isInteger(totalClients)&&totalClients>=1&&totalClients<=200);assert(Number.isInteger(clientsPerShard)&&clientsPerShard>=1&&clientsPerShard<=10);assert(Math.ceil(totalClients/clientsPerShard)<=20);
assert(Number.isInteger(count)&&count>=1&&count<=clientsPerShard);assert(Number.isInteger(shardId)&&shardId>=0&&shardId<Math.ceil(totalClients/clientsPerShard));assert(shardId*clientsPerShard+count<=totalClients);assert(Number.isFinite(startEpochMs)&&startEpochMs>=0);assert(durationSeconds>=30&&durationSeconds<=(scenario==='soak'?620:120));
const origin='https://football-life.petermin7.workers.dev';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const sha=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
await fs.mkdir(output,{recursive:true});
const sourceManifest=Object.fromEntries(await Promise.all(['tests/playtest-browser.mjs','tests/load-monitor.mjs','tests/playtest-aggregate.mjs','tests/playtest-ui.mjs'].map(async file=>[file,sha(await fs.readFile(file))])));
const assetManifestPath='tests/fixtures/pro-soak-assets-20261030.json';
const assetManifest=await fs.readFile(assetManifestPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT'&&!(scenario==='soak'&&startEpochMs>0))return null;throw error;});
if(assetManifest)assert.equal(assetManifest.origin,origin);
const expectedAssets=assetManifest?Object.fromEntries(assetManifest.assets.map(asset=>[asset.path,asset.sha256])):null;
const report={expectedAssets,sourceManifest,revision:process.env.GITHUB_SHA||null,platform:process.platform,runnerName:process.env.RUNNER_NAME||null,machineId:process.platform==='linux'?(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim():os.hostname(),nodeVersion:process.version,origin,scenario,totalClients,clientsPerShard,count,shardId,startEpochMs,durationSeconds,startedAt:new Date().toISOString(),method:'Distinct temporary persistent profiles and Chromium processes. UI-only natural new games, choices and years. No state injection, fixtures, RNG changes or engine calls. Youth/career use visible pause and next-year controls; soak keeps default speed, automatic clock and animations, with per-VM serial initial preparation and pause before its coordinated barrier and after its active interval. Complete browser close and relaunch with same profile; resume and whole-save equality checked before further actions. External resources are unmodified.',clients:[]};
const boundedCapacity=totalClients!==25||clientsPerShard!==2;
const networkLimits={requests:Math.min(10000,boundedCapacity?count*512:10000),encodedBytes:Math.min(500e6,boundedCapacity?count*64*1024*1024:500e6),decodedBytes:Math.min(2e9,boundedCapacity?count*128*1024*1024:2e9)};
report.networkLimits=networkLimits;
const totals={requests:0,encodedBytes:0,decodedBytes:0};
let networkBudgetFailure;

const pendingBodies=[];
const serialPreparation=scenario==='soak'&&startEpochMs>0;
const enterPreparation=createPreparationGate();
report.preparationMode=serialPreparation?'serial-before-common-barrier':'parallel';
async function client(index){
 const id=shardId*clientsPerShard+index,dir=path.join(output,`client-${id}`);await fs.mkdir(dir,{recursive:true});
 const result={id,startedAtMs:Date.now(),width:scenario==='career'?1440:id%2?1440:390,timings:{initial:{},relaunch:{}},samples:[],checkpoints:[],completedLives:0,status:'running',errors:[],actions:[],network:{requests:0,encodedBytes:0,decodedBytes:0,responses:[],external:[],bodyHashes:[]},choices:0,storyChoices:0,trainingChanges:0,years:0};report.clients.push(result);
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),`football-play-${id}-`));let context,page,phase='initial',fatal,releasePreparation;
 const check=()=>{if(networkBudgetFailure)throw networkBudgetFailure;if(fatal)throw fatal;if(result.errors.length)throw Error(`Browser error: ${JSON.stringify(result.errors[0])}`);};
 const fail=e=>{result.errors.push(e);fatal ||= Error(JSON.stringify(e));if(e.type.endsWith('-cap')){networkBudgetFailure ||= fatal;context?.close().catch(()=>{});}};
 const launch=async()=>{const started=performance.now();
  context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:result.width,height:900},reducedMotion:scenario==='youth'?'reduce':'no-preference',...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  context.on('page',attach);page=context.pages()[0]||await context.newPage();await attach(page);result.timings[phase].browserLaunchMs=performance.now()-started;
 };
 const attached=new WeakSet();
 async function attach(p){
  if(attached.has(p))return;attached.add(p);p.setDefaultTimeout(15000);p.setDefaultNavigationTimeout(45000);
  p.on('pageerror',e=>fail({type:'pageerror',message:e.message}));p.on('console',m=>{if(m.type()==='error')fail({type:'console',message:m.text()});});
  p.on('request',r=>{result.network.requests++;totals.requests++;if(new URL(r.url()).origin!==origin)result.network.external.push({url:r.url(),method:r.method()});if(r.method()!=='GET')fail({type:'unexpected-method',method:r.method(),url:r.url()});if(totals.requests>networkLimits.requests)fail({type:'request-cap'});});
  p.on('requestfailed',r=>fail({type:'requestfailed',url:r.url(),failure:r.failure()}));
  p.on('response',r=>{
   result.network.responses.push({phase,url:r.url(),status:r.status(),atMs:Date.now()});if(r.status()>=400)fail({type:'http',url:r.url(),status:r.status()});
   if(new URL(r.url()).origin===origin){const task=r.body().then(body=>{result.network.decodedBytes+=body.length;totals.decodedBytes+=body.length;const hash=sha(body),pathname=new URL(r.url()).pathname,key=pathname==='/'&&expectedAssets?.['/']===undefined?'/index.html':pathname;result.network.bodyHashes.push({phase,url:r.url(),bytes:body.length,sha256:hash});if(expectedAssets?.[key]&&hash!==expectedAssets[key])fail({type:'asset-hash-mismatch',url:r.url(),expected:expectedAssets[key],actual:hash});if(totals.decodedBytes>networkLimits.decodedBytes)fail({type:'decoded-byte-cap'});}).catch(e=>fail({type:'response-body',url:r.url(),message:e.message}));pendingBodies.push(task);}
  });
  const cdp=await context.newCDPSession(p);await cdp.send('Network.enable');cdp.on('Network.loadingFinished',e=>{result.network.encodedBytes+=e.encodedDataLength;totals.encodedBytes+=e.encodedDataLength;if(totals.encodedBytes>networkLimits.encodedBytes)fail({type:'encoded-byte-cap'});});
 }
 const read=()=>page.evaluate(()=>JSON.parse(window.render_game_to_text()));
 const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('touchline.life.v2')));
 const {action,drain}=createPlaytestUi({page:{locator:(...args)=>page.locator(...args)},scenario,check,readState:read,actions:result.actions,onChoice:()=>result.choices++,onStoryChoice:()=>result.storyChoices++});
 async function shot(label){await page.screenshot({path:path.join(dir,`${label}.png`),fullPage:true});}
 async function pause(){const state=await read();if(state.mode!=='retired'&&!state.paused)await action('pause','#pause-btn');}
 async function navigate(){const started=performance.now();const response=await page.goto(origin+'/',{waitUntil:'domcontentloaded'});assert.equal(response.status(),200);await page.waitForFunction(()=>typeof window.render_game_to_text==='function'&&!document.querySelector('#start-btn').disabled);result.timings[phase].navigationToAppReadyMs=performance.now()-started;check();}
 const timeout=setTimeout(()=>{fatal=Error('Client exceeded bounded scenario wall-clock limit');context?.close().catch(()=>{});},scenario==='soak'?1050000:660000);
 try{
  if(serialPreparation){result.preparationQueuedAtMs=Date.now();releasePreparation=await enterPreparation();result.preparationStartedAtMs=Date.now();}
  await launch();await navigate();const screenshotStarted=performance.now();await shot('intro');result.timings.initial.introScreenshotMs=performance.now()-screenshotStarted;result.readyAtMs=Date.now();result.readyMs=result.readyAtMs-result.startedAtMs;
  async function barrier(){
   if(startEpochMs){assert(Number.isFinite(startEpochMs)&&startEpochMs>Date.now(),'Client ready after barrier');assert(result.readyAtMs<=startEpochMs);while(Date.now()<startEpochMs){check();await sleep(Math.min(100,startEpochMs-Date.now()));}assert(Date.now()<=startEpochMs+5000,'Client missed barrier');}
  }
  if(scenario!=='soak')await barrier();
  result.activeStartMs=Date.now();let end=result.activeStartMs+durationSeconds*1000;
  await action('new-game','#start-btn');await drain();result.initialIdentity=await saved();assert(Number.isInteger(result.initialIdentity.seed));result.initialSeed=result.initialIdentity.seed;result.initialName=result.initialIdentity.name;result.initialSaveSha256=sha(result.initialIdentity);
  await action('begin','#begin-btn');await drain();
  if(scenario!=='soak'){await pause();await drain();}
  else if(startEpochMs){
   await pause();await drain();result.readyAtMs=Date.now();result.readyMs=result.readyAtMs-result.startedAtMs;
   assert(result.readyAtMs<startEpochMs,'Client ready after barrier');
   result.preparationFinishedAtMs=result.readyAtMs;releasePreparation();releasePreparation=null;
   await barrier();await action('barrier-resume','#pause-btn');assert.equal((await read()).paused,false);
  }
  if(scenario==='soak'){
   result.activeStartMs=Date.now();end=result.activeStartMs+durationSeconds*1000;
   const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');let checkpoint=-1,lastInteraction=0,previous=null,changes=0,lastProgress=Date.now(),maxProgressGapMs=0;
   while(Date.now()<end){
    await drain();let state=await read();
    if(state.mode==='retired'){result.completedLives++;await shot(`retired-${result.completedLives}`);await action('new-life','#again-btn');await action('confirm-new-life','#restart-confirm');await drain();await action('begin','#begin-btn');await drain();state=await read();}
    assert.equal(state.paused,false);assert.equal(state.speed,1);
    if(previous&&(previous.age!==state.age||previous.progress!==state.progress||previous.name!==state.name)){changes++;maxProgressGapMs=Math.max(maxProgressGapMs,Date.now()-lastProgress);lastProgress=Date.now();}previous=state;assert(Date.now()-lastProgress<90000,'Automatic clock stalled for 90 seconds');
    const start=performance.now();const ui=await page.evaluate(()=>({domNodes:document.querySelectorAll('*').length,openDialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),visibility:document.visibilityState,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches}));const evaluationMs=performance.now()-start;
    const metrics=(await cdp.send('Performance.getMetrics')).metrics;const metric=name=>metrics.find(x=>x.name===name)?.value;
    result.samples.push({atMs:Date.now(),age:state.age,name:state.name,mode:state.mode,progress:state.progress,paused:state.paused,speed:state.speed,appearances:state.totals?.appearances||0,jsHeapUsedBytes:metric('JSHeapUsedSize'),jsHeapTotalBytes:metric('JSHeapTotalSize'),taskDurationSeconds:metric('TaskDuration'),evaluationMs,...ui});assert.equal(ui.visibility,'visible');assert.equal(ui.reducedMotion,false);
    const minute=Math.floor((Date.now()-result.activeStartMs)/60000);if(minute!==checkpoint){await shot(`soak-minute-${minute}`);result.checkpoints.push({minute,state});checkpoint=minute;await fs.writeFile(path.join(dir,'soak-progress.json'),JSON.stringify({samples:result.samples,checkpoints:result.checkpoints},null,2));}
    if(Date.now()-lastInteraction>15000&&state.age>=6){if(await page.locator('[data-training]:enabled').count()){if(await action('training-review','[data-training]:enabled'))result.trainingChanges++;}if(result.width<720&&(await read()).mode!=='retired'){await action('open-history','[data-section="history"]');await action('return-play','[data-section="play"]');}lastInteraction=Date.now();}await sleep(1000);
   }
   assert(changes>=Math.floor(durationSeconds/10),'Automatic clock keeps progressing');result.progressChanges=changes;result.maxProgressGapMs=Math.max(maxProgressGapMs,Date.now()-lastProgress);result.progressed=await read();result.matchEvidence=await saved();result.matchAppearances=Math.max(result.matchEvidence.totals.appearances,...result.samples.map(sample=>sample.appearances));result.adultMatchAppearances=result.matchAppearances;assert(result.adultMatchAppearances>0,'Soak reaches adult match play');assert(result.maxProgressGapMs<90000);
  }else{
  for(let step=0;step<90;step++){
   const s=await saved();const matches=(s.totals?.appearances||0)+(s.competitions?.youth||[]).flatMap(y=>y.competitions||[]).reduce((n,c)=>n+(c.appearances||0),0);
   if(s.age>=18&&(scenario==='career'?s.totals.appearances>0:matches>0)){result.matchAppearances=matches;result.adultMatchAppearances=s.totals?.appearances||0;break;}
   assert.notEqual(s.phase,'retired','Unexpected retirement before target');assert(s.age<=25,'No recorded match by age 25');
   if(s.age>=6&&await page.locator('[data-training]:enabled').count()){await action('select-training','[data-training]:enabled');result.trainingChanges++;}
   const before=s.age;await action('next-year','#next-btn');await drain();await pause();result.years+=(await saved()).age-before;
  }
  result.progressed=await read();result.matchEvidence=await saved();assert(result.progressed.age>=18);assert(result.matchAppearances>0);assert(result.choices>0);await shot('progressed-match');
  // Keep real interactions through the common window without advancing into retirement.
  let tick=0;while(Date.now()<end){await drain();const choices=await page.locator('[data-training]:enabled').count();assert(choices>0,'Training available during active play');await action('training-review',`[data-training]:enabled:nth-child(${tick%choices+1})`);result.trainingChanges++;if(result.width<720){await action('open-history','[data-section="history"]');await action('return-play','[data-section="play"]');}tick++;await sleep(250);}

   if(scenario==='career'){
    for(let step=0;step<100&&(await saved()).phase!=='retired';step++){const before=await saved();await action('next-season','#next-btn');await drain();await pause();const after=await saved();result.years+=after.age-before.age;result.checkpoints.push({age:after.age,phase:after.phase,appearances:after.totals.appearances,seasons:after.seasons.length});}
    result.career=await saved();assert.equal(result.career.phase,'retired');assert(result.career.totals.appearances>0);assert(result.career.seasons.length>=2);await shot('retirement');
   }
  }
  result.activeEndMs=Date.now();await pause();await drain();assert.equal(await page.locator('#save-status').textContent(),'저장 완료');
  const before=await saved();result.saveBeforeSha256=sha(before);await fs.writeFile(path.join(dir,'save-before.json'),JSON.stringify(before,null,2));
  await Promise.all(pendingBodies);check();await context.close();context=null;result.browserClosedAtMs=Date.now();phase='relaunch';await launch();result.browserRelaunchedAtMs=Date.now();await navigate();assert(await page.locator('#resume-btn').isVisible());const resumeStarted=performance.now();await page.locator('#resume-btn').click();await page.waitForFunction(()=>JSON.parse(window.render_game_to_text()).mode!=='intro');result.timings.relaunch.resumeMs=performance.now()-resumeStarted;
  const after=await saved();assert.deepEqual(after,before,'Whole save survives complete browser process close/relaunch');result.saveAfterSha256=sha(after);result.savePreserved=true;result.relaunchMs=Date.now()-result.browserClosedAtMs;result.restored=await read();assert.equal(result.restored.age,before.age);assert.equal(result.restored.name,before.name);await shot('restored');await Promise.all(pendingBodies);check();result.status='passed';result.passed=true;
 }catch(e){releasePreparation?.(e);releasePreparation=null;result.status='failed';result.passed=false;result.failure=e.stack;try{await shot('failure');result.failureState=await read();}catch{} }
 finally{releasePreparation?.(Error('Browser preparation did not complete'));clearTimeout(timeout);if(context)await context.close().catch(()=>{});await Promise.all(pendingBodies);if(result.errors.length){result.status='failed';result.passed=false;result.failure ||= 'Network or browser error during cleanup';}result.finishedAtMs=Date.now();await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(result,null,2));assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert(path.basename(profile).startsWith(`football-play-${id}-`));await fs.rm(profile,{recursive:true,force:true});}
 return result;
}
await Promise.all(Array.from({length:count},(_,i)=>client(i)));
report.networkTotals=totals;report.finishedAt=new Date().toISOString();report.success=report.clients.every(c=>c.passed)&&new Set(report.clients.map(c=>c.initialSeed)).size===count&&new Set(report.clients.map(c=>c.initialSaveSha256)).size===count;report.passed=report.success;
await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:report.success,output,clients:report.clients.map(c=>({id:c.id,status:c.status,age:c.progressed?.age,matchAppearances:c.matchAppearances,choices:c.choices,savePreserved:c.savePreserved,failure:c.failure,errors:c.errors}))}));if(!report.success)process.exitCode=1;
