import assert from 'node:assert/strict';

const knownDialogs=['cutscene-dialog','result-dialog','story-dialog','decision-dialog'];

export async function openDialogs(page){
 const ids=await page.locator('dialog[open]').evaluateAll(dialogs=>dialogs.map(dialog=>dialog.id));
 assert(ids.every(id=>knownDialogs.includes(id)),`Unknown dialog: ${ids.filter(id=>!knownDialogs.includes(id)).join(', ')}`);
 return ids;
}

export function createPlaytestUi({page,scenario,check=()=>{},actions=[],onChoice=()=>{},onStoryChoice=()=>{},readState}){
 async function action(label,selector,{modal=!['pause','barrier-resume','training-review','select-training','open-history','return-play','next-year','next-season'].includes(label),deadline=Date.now()+15000,signal}={}){
  signal?.throwIfAborted();check();const row={label,selector,startMs:Date.now()};actions.push(row);
  const retirementSensitive=['pause','training-review','open-history','return-play'].includes(label);
  async function skipIfStopped(stopSignal=signal){
   stopSignal?.throwIfAborted();
   if(retirementSensitive&&readState){const state=await readState();stopSignal?.throwIfAborted();if(state.mode==='retired'||label==='pause'&&state.paused){row.skippedAtMs=Date.now();row.skippedReason=state.mode==='retired'?'retired':'already-paused';check();return true;}}
   return false;
  }
  while(true){
   signal?.throwIfAborted();
   if(!modal&&((await openDialogs(page)).length))await drain({deadline,signal});
   if(await skipIfStopped())return;
   const remaining=deadline-Date.now();assert(remaining>0,`UI action exceeded 15 seconds: ${label}`);
   if(modal)break;
   // Probe without dispatching input: a timed-out real click may already have taken effect.
   try{await page.locator(selector).first().click({trial:true,timeout:Math.min(750,remaining),signal});break;}
   catch(error){
    if(error.name!=='TimeoutError')throw error;
    // Recheck known modal interception or observed retirement; preserve unrelated click failures.
    if(!(await openDialogs(page)).length){
     if(retirementSensitive&&readState&&(await readState()).mode==='retired')continue;
     throw error;
    }
    await drain({deadline,signal});
   }
  }
  if(modal){
   signal?.throwIfAborted();const remaining=deadline-Date.now();assert(remaining>0,`UI action exceeded 15 seconds: ${label}`);
   await page.locator(selector).first().click({timeout:remaining,signal});
  }else{
   const dialogs=page.locator('dialog[open]').first(),controller=new AbortController();let handlerFailure;
   // Native checkpoints intercept overlays before input; nested handler actions are not reentrant.
   await page.addLocatorHandler(dialogs,async()=>{
    try{await drain({deadline,signal:controller.signal});if(await skipIfStopped(controller.signal))controller.abort();}
    catch(error){handlerFailure=error;controller.abort();}
   },{noWaitAfter:true}); // The dynamic selector can already point to the next dialog; its next checkpoint drains it.
   try{
    const remaining=deadline-Date.now();assert(remaining>0,`UI action exceeded 15 seconds: ${label}`);
    // One real click call: handler/navigation completion shares the original action deadline.
    await page.locator(selector).first().click({timeout:remaining,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
   }catch(error){if(handlerFailure)throw handlerFailure;if(row.skippedReason&&controller.signal.aborted){check();return;}throw error;}
   finally{controller.abort();await page.removeLocatorHandler(dialogs);}
  }
  row.endMs=Date.now();await new Promise(resolve=>setTimeout(resolve,100));check();return true;
 }
 async function drain({deadline,signal}={}){for(let n=0;n<40;n++){
  signal?.throwIfAborted();check();const ids=await openDialogs(page);signal?.throwIfAborted();
  if(deadline!==undefined)assert(deadline>Date.now(),'UI dialog drain exceeded action deadline');
  if(!ids.length)return;
  if(ids.includes('cutscene-dialog')){if(scenario==='soak')await page.locator('#cutscene-dialog[open]').waitFor({state:'hidden',timeout:deadline===undefined?30000:Math.max(1,Math.min(30000,deadline-Date.now())),signal});else await action('dismiss-cutscene','#cutscene-dialog[open] button',{modal:true,deadline,signal});continue;}
  if(ids.includes('result-dialog')){await action('acknowledge-match-results','#result-confirm',{modal:true,deadline,signal});continue;}
  if(ids.includes('story-dialog')){await action('story-choice','[data-story-choice]',{modal:true,deadline,signal});onStoryChoice();continue;}
  if(ids.includes('decision-dialog')){
   const options=await page.locator('#decision-options [data-choice]').evaluateAll(buttons=>buttons.map(button=>button.dataset.choice));
   const choice=[...(scenario==='youth'?[]:['continue-career']),'practice','trial','FW','athlete','sign','rehab','stay','amateur','army'].find(value=>options.includes(value))||options.find(value=>value.startsWith('offer-'))||options[0];assert(choice,'Natural decision has options');
   await action(`decision:${choice}`,`[data-choice="${choice}"]`,{modal:true,deadline,signal});onChoice();
  }
 }throw Error('Dialog limit exceeded');}
 return {action,drain};
}
