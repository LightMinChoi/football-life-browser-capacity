import assert from 'node:assert/strict';
import {createPlaytestUi} from './playtest-ui.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
try{
 const page=await browser.newPage();
 await page.setContent(`<button id="pause-btn" onclick="window.pauses++">Pause</button><button data-training onclick="window.trainings++">Training</button><dialog id="decision-dialog"><div id="decision-options"><button data-choice="practice" onclick="this.closest('dialog').close();window.choices++">Practice</button></div></dialog><dialog id="unexpected-dialog">Unknown</dialog><script>window.pauses=0;window.trainings=0;window.choices=0;</script>`);
 // Reproduce the original sequential-poll race before checking the repaired snapshot.
 async function legacyDrain(){
  for(const id of ['cutscene-dialog','result-dialog','story-dialog','decision-dialog']){
   const count=await page.locator('#'+id+'[open]').count();
   if(id==='decision-dialog')await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());
   if(count)return;
  }
  assert.equal(await page.locator('dialog[open]').count(),0,'Unknown dialog');
 }
 await assert.rejects(legacyDrain(),/Unknown dialog/);
 await page.locator('[data-choice]').click();
 let injectAfterSnapshot=true;
 const snapshotPage={addLocatorHandler:(...args)=>page.addLocatorHandler(...args),removeLocatorHandler:(...args)=>page.removeLocatorHandler(...args),locator(selector){const locator=page.locator(selector);if(selector!=='dialog[open]')return locator;return {first:()=>locator.first(),async evaluateAll(fn){const ids=await locator.evaluateAll(fn);if(injectAfterSnapshot){injectAfterSnapshot=false;await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());}return ids;}};}};
 const actions=[];let choices=0;
 const ui=createPlaytestUi({page:snapshotPage,scenario:'soak',actions,onChoice:()=>choices++});
 await ui.drain(); // Empty atomic snapshot stays valid despite the subsequent known dialog.
 await ui.drain();assert.equal(choices,1);
 // The old direct final-pause click fails when a known modal intercepts it.
 await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());
 await assert.rejects(page.locator('#pause-btn').click({timeout:100}),error=>error.name==='TimeoutError');
 assert.equal(await page.evaluate(()=>window.pauses),0);
 await page.locator('[data-choice]').click();
 // Open a modal after the nonmodal action snapshot, while Playwright is attempting its click.
 injectAfterSnapshot=true;
 await ui.action('pause','#pause-btn');
 assert.equal(await page.evaluate(()=>window.pauses),1);assert.equal(choices,2);
 assert.equal(actions.filter(action=>action.label==='pause').length,1);
 assert(Number.isFinite(actions.find(action=>action.label==='pause').endMs));
 await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());
 await ui.action('training-review','[data-training]');
 assert.equal(await page.evaluate(()=>window.trainings),1);assert.equal(choices,3);
 await page.evaluate(()=>document.querySelector('#unexpected-dialog').showModal());
 await assert.rejects(ui.drain(),/Unknown dialog: unexpected-dialog/);
 await assert.rejects(ui.action('pause','#pause-btn'),/Unknown dialog: unexpected-dialog/);
 assert.equal(await page.evaluate(()=>window.pauses),1,'Unknown dialog must not be bypassed');
 await page.evaluate(()=>document.querySelector('#unexpected-dialog').close());
 await assert.rejects(ui.action('training-review','#missing-target'),error=>error.name==='TimeoutError');
 const guardedActions=[];
 const guarded=createPlaytestUi({page:snapshotPage,scenario:'soak',actions:guardedActions,readState:()=>page.evaluate(()=>({mode:window.mode,paused:window.paused}))});
 await page.evaluate(()=>document.querySelector('[data-choice]').addEventListener('click',()=>{
  if(window.retireOnChoice){window.mode='retired';document.querySelector('#pause-btn').hidden=true;}
  if(window.pauseOnChoice)window.paused=true;
 }));
 for(const late of [false,true]){
  await page.evaluate(()=>{window.mode='playing';window.paused=false;window.retireOnChoice=true;document.querySelector('#pause-btn').hidden=false;});
  if(late)injectAfterSnapshot=true;else await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());
  await guarded.action('pause','#pause-btn');
  assert.equal(await page.evaluate(()=>window.mode),'retired');
  assert.equal(await page.evaluate(()=>window.pauses),1,'Retirement during known-modal drain must not click hidden pause');
  assert.equal(guardedActions.findLast(action=>action.label==='pause').skippedReason,'retired');
  assert.equal(guardedActions.findLast(action=>action.label==='pause').endMs,undefined,'Skipped pause is not successful-click evidence');
 }
 await page.evaluate(()=>{window.mode='playing';window.paused=false;window.retireOnChoice=false;window.pauseOnChoice=true;document.querySelector('#pause-btn').hidden=false;document.querySelector('#decision-dialog').showModal();});
 await guarded.action('pause','#pause-btn');assert.equal(guardedActions.findLast(action=>action.label==='pause').skippedReason,'already-paused');
 assert.equal(await page.evaluate(()=>window.pauses),1,'Already-paused state must not toggle back to running');
 await page.evaluate(()=>document.querySelector('#unexpected-dialog').showModal());
 await assert.rejects(guarded.action('pause','#pause-btn'),/Unknown dialog: unexpected-dialog/);
 await page.evaluate(()=>{document.querySelector('#unexpected-dialog').close();window.mode='playing';window.paused=false;document.querySelector('#pause-btn').hidden=true;});
 await assert.rejects(guarded.action('pause','#pause-btn'),error=>error.name==='TimeoutError');
 // A natural retirement can hide game controls after the loop sampled playing state.
 await page.evaluate(()=>{window.mode='playing';window.paused=false;document.querySelector('#pause-btn').hidden=false;document.querySelector('[data-training]').hidden=false;});
 let retireOnTrainingClick=true;
 const retiringPage={addLocatorHandler:(...args)=>page.addLocatorHandler(...args),removeLocatorHandler:(...args)=>page.removeLocatorHandler(...args),locator(selector){const locator=page.locator(selector);if(selector!=='[data-training]')return locator;return {first(){return {async click(options){
  if(retireOnTrainingClick){retireOnTrainingClick=false;await page.evaluate(()=>{window.mode='retired';document.querySelector('[data-training]').hidden=true;});}
  return locator.first().click(options);
 }}}};}};
 const retirementActions=[];
 const retiring=createPlaytestUi({page:retiringPage,scenario:'soak',actions:retirementActions,readState:()=>page.evaluate(()=>({mode:window.mode,paused:window.paused}))});
 assert.equal(await retiring.action('training-review','[data-training]'),undefined);
 assert.equal(retirementActions[0].skippedReason,'retired');assert.equal(retirementActions[0].endMs,undefined);
 assert.equal(await page.evaluate(()=>window.trainings),1,'Retirement must not force a hidden training click');
 for(const label of ['open-history','return-play']){await retiring.action(label,'#missing-navigation');assert.equal(retirementActions.at(-1).skippedReason,'retired');assert.equal(retirementActions.at(-1).endMs,undefined);}
 await page.evaluate(()=>document.querySelector('#unexpected-dialog').showModal());
 await assert.rejects(retiring.action('training-review','[data-training]'),/Unknown dialog: unexpected-dialog/);
 await page.evaluate(()=>{document.querySelector('#unexpected-dialog').close();window.mode='playing';});
 await assert.rejects(retiring.action('training-review','[data-training]'),error=>error.name==='TimeoutError');
 const slowPage=await browser.newPage();
 async function slowPauseFixture(){
  await slowPage.setContent(`<button id="pause" onclick="window.clicks++;window.paused=!window.paused;const end=performance.now()+1100;while(performance.now()<end){}window.handlerDone=true">Pause</button><script>window.clicks=0;window.paused=false;window.handlerDone=false</script>`);
 }
 // A delivered click can time out while its synchronous handler is still running.
 await slowPauseFixture();
 await assert.rejects(slowPage.locator('#pause').click({timeout:750}),error=>error.name==='TimeoutError'&&error.message.includes('performing click action'));
 assert.deepEqual(await slowPage.evaluate(()=>({clicks,paused,handlerDone})),{clicks:1,paused:true,handlerDone:true});
 await slowPauseFixture();
 const slowActions=[];
 const slowUi=createPlaytestUi({page:slowPage,scenario:'soak',actions:slowActions});
 assert.equal(await slowUi.action('pause','#pause'),true);
 assert.deepEqual(await slowPage.evaluate(()=>({clicks,paused,handlerDone})),{clicks:1,paused:true,handlerDone:true});
 assert(slowActions[0].endMs-slowActions[0].startMs>=1100,'Completed action timing includes handler work beyond the probe budget');
 assert(slowActions[0].endMs-slowActions[0].startMs<15000);
 // Already-selected training gives no transition evidence; actual click completion must still be awaited.
 await slowPage.route('https://ui-regression.test/**',async route=>{
  if(route.request().url().endsWith('/slow'))await new Promise(resolve=>setTimeout(resolve,1100));
  await route.fulfill({contentType:'text/html',body:'<p>Navigation completed</p>'});
 });
 async function trainingNavigationFixture(){
  await slowPage.goto('https://ui-regression.test/start');
  await slowPage.setContent(`<button id="training" aria-pressed="true" onclick="sessionStorage.clicks=Number(sessionStorage.clicks)+1;location.href='/slow'">Training</button><script>sessionStorage.clicks=0</script>`);
 }
 await trainingNavigationFixture();
 await assert.rejects(slowPage.locator('#training').click({timeout:750}),error=>error.name==='TimeoutError'&&error.message.includes('waiting for scheduled navigations to finish'));
 await slowPage.waitForURL('https://ui-regression.test/slow');
 assert.equal(await slowPage.evaluate(()=>Number(sessionStorage.clicks)),1);
 await trainingNavigationFixture();
 assert.equal(await slowUi.action('training-review','#training'),true);
 assert.equal(slowPage.url(),'https://ui-regression.test/slow');
 assert.equal(await slowPage.evaluate(()=>Number(sessionStorage.clicks)),1);
 assert(slowActions[1].endMs-slowActions[1].startMs>=1100,'Completed action timing includes navigation after the delivered click');
 assert(slowActions[1].endMs-slowActions[1].startMs<15000);
 // A known modal racing after a successful trial must be drained before one real input dispatch.
 await slowPage.setContent(`<button id="target" onclick="window.clicks++">Target</button><dialog id="decision-dialog"><div id="decision-options"><button data-choice="practice" onclick="this.closest('dialog').close()">Practice</button></div></dialog><script>window.clicks=0</script>`);
 let realAttempts=0,interceptAfterTrial=true,realTimeout=1000,injectedDialog='decision-dialog',insideHandler=false,injectAfterHandlerSnapshot=false,handlerInvocations=0;
 const afterTrialPage={addLocatorHandler:(locator,handler,options)=>slowPage.addLocatorHandler(locator,async()=>{insideHandler=true;handlerInvocations++;try{await handler();}finally{insideHandler=false;}},options),removeLocatorHandler:(...args)=>slowPage.removeLocatorHandler(...args),locator(selector){const locator=slowPage.locator(selector);if(selector==='dialog[open]')return {first:()=>locator.first(),async evaluateAll(fn){const ids=await locator.evaluateAll(fn);if(insideHandler&&!ids.length&&injectAfterHandlerSnapshot){injectAfterHandlerSnapshot=false;await slowPage.evaluate(()=>document.querySelector('#story-dialog').showModal());}return ids;}};if(selector!=='#target')return locator;return {first(){return {async click(options){
  if(!options.trial){realAttempts++;if(interceptAfterTrial)await slowPage.evaluate(id=>document.getElementById(id).showModal(),injectedDialog);}
  return locator.first().click(options.trial?options:{...options,timeout:Math.min(realTimeout,options.timeout)});
 }}}};}};
 const afterTrialActions=[];
 const afterTrialUi=createPlaytestUi({page:afterTrialPage,scenario:'soak',actions:afterTrialActions});
 assert.equal(await afterTrialUi.action('training-review','#target'),true);
 assert.equal(realAttempts,1);assert.equal(await slowPage.evaluate(()=>window.clicks),1);
 assert(Number.isFinite(afterTrialActions[0].endMs));
 // A delivered action that opens a known dialog before timing out is equally unsafe to repeat.
 interceptAfterTrial=false;realAttempts=0;realTimeout=100;
 await slowPage.evaluate(()=>{window.clicks=0;document.querySelector('#target').onclick=()=>{window.clicks++;document.querySelector('#decision-dialog').showModal();const end=performance.now()+350;while(performance.now()<end){}};});
 await assert.rejects(afterTrialUi.action('training-review','#target'),error=>error.name==='TimeoutError');
 assert.equal(await slowPage.evaluate(()=>window.clicks),1);assert.equal(realAttempts,1);
 assert.equal(afterTrialActions.findLast(action=>action.label==='training-review').endMs,undefined,'Late observed effect cannot turn a timed-out dispatch into a completed action');
 await assert.rejects(slowPage.locator('#target').click({trial:true,timeout:100}),error=>error.name==='TimeoutError');
 assert.equal(await slowPage.locator('#decision-dialog[open]').count(),1,'Failed action must remove its native handler');
 await afterTrialUi.drain();
 // Unknown late overlays fail through the handler without dispatch or an unhandled callback rejection.
 await slowPage.evaluate(()=>{window.clicks=0;document.querySelector('#target').onclick=()=>window.clicks++;document.body.insertAdjacentHTML('beforeend','<dialog id="unexpected-dialog">Unknown</dialog>');});
 interceptAfterTrial=true;injectedDialog='unexpected-dialog';realTimeout=1000;realAttempts=0;
 await assert.rejects(afterTrialUi.action('training-review','#target'),/Unknown dialog: unexpected-dialog/);
 assert.equal(realAttempts,1);assert.equal(await slowPage.evaluate(()=>window.clicks),0);
 await assert.rejects(slowPage.locator('#target').click({trial:true,timeout:100}),error=>error.name==='TimeoutError');
 await slowPage.evaluate(()=>document.querySelector('#unexpected-dialog').close());
 // Native cancellation must actually stop the pending click, including when its target later becomes visible.
 await slowPage.evaluate(()=>{document.querySelector('#target').hidden=true;});
 const abort=new AbortController(),abortStarted=Date.now();
 const aborted=slowPage.locator('#target').click({timeout:15000,signal:abort.signal});
 setTimeout(()=>abort.abort(),50);
 await assert.rejects(aborted,error=>error.name==='AbortError');assert(Date.now()-abortStarted<1000);
 await slowPage.evaluate(()=>document.querySelector('#target').hidden=false);await slowPage.waitForTimeout(150);
 assert.equal(await slowPage.evaluate(()=>window.clicks),0,'Aborted click must not dispatch after the target becomes visible');
 // A native handler may retire the game or pause it; abort before the original input can toggle state.
 injectedDialog='decision-dialog';
 const stoppedActions=[];
 const stoppedUi=createPlaytestUi({page:afterTrialPage,scenario:'soak',actions:stoppedActions,readState:()=>slowPage.evaluate(()=>({mode:window.mode,paused:window.paused}))});
 for(const reason of ['retired','already-paused']){
  realAttempts=0;
  await slowPage.evaluate(reason=>{
   window.mode='playing';window.paused=false;window.clicks=0;document.querySelector('#target').hidden=false;
   document.querySelector('#target').onclick=()=>{window.clicks++;window.paused=!window.paused;};
   document.querySelector('[data-choice]').onclick=function(){this.closest('dialog').close();if(reason==='retired'){window.mode='retired';document.querySelector('#target').hidden=true;}else window.paused=true;};
  },reason);
  assert.equal(await stoppedUi.action('pause','#target'),undefined);
  assert.equal(realAttempts,1);assert.equal(await slowPage.evaluate(()=>window.clicks),0);
  assert.equal(stoppedActions.findLast(action=>action.label==='pause').skippedReason,reason);
  assert.equal(stoppedActions.findLast(action=>action.label==='pause').endMs,undefined);
  await slowPage.evaluate(()=>document.querySelector('#target').hidden=false);await slowPage.waitForTimeout(150);
  assert.equal(await slowPage.evaluate(()=>window.clicks),0,'Stopped original click must stay cancelled after modal handling');
 }
 // Chained known dialogs drain inside the same native handler without reentrancy or extra primary input.
 await slowPage.evaluate(()=>{
  window.mode='playing';window.paused=false;window.clicks=0;window.chain=[];
  document.querySelector('#target').onclick=()=>window.clicks++;
  document.body.insertAdjacentHTML('beforeend','<dialog id="result-dialog"><button id="result-confirm">Result</button></dialog><dialog id="story-dialog"><button data-story-choice>Story</button></dialog><dialog id="cutscene-dialog">Cutscene</dialog>');
  document.querySelector('#result-confirm').onclick=function(){window.chain.push('result');this.closest('dialog').close();document.querySelector('#story-dialog').showModal();};
  document.querySelector('[data-story-choice]').onclick=function(){window.chain.push('story');this.closest('dialog').close();document.querySelector('#decision-dialog').showModal();};
  document.querySelector('[data-choice]').onclick=function(){window.chain.push('decision');this.closest('dialog').close();};
 });
 injectedDialog='result-dialog';realAttempts=0;
 assert.equal(await afterTrialUi.action('training-review','#target'),true);
 assert.equal(realAttempts,1);assert.equal(await slowPage.evaluate(()=>window.clicks),1);
 assert.deepEqual(await slowPage.evaluate(()=>window.chain),['result','story','decision']);
 // A new dialog can appear between the handler's empty snapshot and native post-handler waiting.
 injectAfterHandlerSnapshot=true;realAttempts=0;handlerInvocations=0;
 await slowPage.evaluate(()=>{window.clicks=0;window.chain=[];});
 assert.equal(await afterTrialUi.action('training-review','#target'),true);
 assert.equal(realAttempts,1);assert.equal(handlerInvocations,2);assert.equal(await slowPage.evaluate(()=>window.clicks),1);
 assert.deepEqual(await slowPage.evaluate(()=>window.chain),['result','story','decision','story','decision']);
 // Handler cutscene waiting must share the remaining action deadline, never start its old 30-second wait.
 injectedDialog='cutscene-dialog';realAttempts=0;
 const boundedStarted=Date.now();
 await assert.rejects(afterTrialUi.action('training-review','#target',{deadline:boundedStarted+600}),error=>error.name==='TimeoutError'||/deadline/.test(error.message));
 assert(Date.now()-boundedStarted<1200,'Modal draining stays inside the inherited action budget');
 assert.equal(realAttempts,1);assert.equal(await slowPage.evaluate(()=>window.clicks),1);
 await slowPage.evaluate(()=>document.querySelector('#cutscene-dialog').close());await slowPage.waitForTimeout(150);
 assert.equal(await slowPage.evaluate(()=>window.clicks),1,'Timed-out handler must not leave pending input');
 console.log('playtest UI local regression passed: existing modal/retirement cases; real 750ms handler/navigation false failures; post-trial modal recovery with one click; delivered-timeout no retry; unknown overlay failure; native cancellation and handler cleanup; post-handler retirement/already-paused skip; chained dialogs, post-handler modal gap and shared handler deadline');
}finally{await browser.close();}
