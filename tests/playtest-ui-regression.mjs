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
 const snapshotPage={locator(selector){const locator=page.locator(selector);if(selector!=='dialog[open]')return locator;return {async evaluateAll(fn){const ids=await locator.evaluateAll(fn);if(injectAfterSnapshot){injectAfterSnapshot=false;await page.evaluate(()=>document.querySelector('#decision-dialog').showModal());}return ids;}};}};
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
 const retiringPage={locator(selector){const locator=page.locator(selector);if(selector!=='[data-training]')return locator;return {first(){return {async click(options){
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
 console.log('playtest UI local regression passed: atomic dialog snapshot, late modal click recovery, final pause, training, unknown modal rejection, unrelated click timeout propagation, retirement/already-paused recheck, training retirement during click, retired navigation, unrelated hidden target rejection');
}finally{await browser.close();}
