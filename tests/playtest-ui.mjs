import assert from 'node:assert/strict';

const knownDialogs=['cutscene-dialog','result-dialog','story-dialog','decision-dialog'];

export async function openDialogs(page){
 const ids=await page.locator('dialog[open]').evaluateAll(dialogs=>dialogs.map(dialog=>dialog.id));
 assert(ids.every(id=>knownDialogs.includes(id)),`Unknown dialog: ${ids.filter(id=>!knownDialogs.includes(id)).join(', ')}`);
 return ids;
}

export function createPlaytestUi({page,scenario,check=()=>{},actions=[],onChoice=()=>{},onStoryChoice=()=>{},readState}){
 async function action(label,selector,{modal=!['pause','barrier-resume','training-review','select-training','open-history','return-play','next-year','next-season'].includes(label)}={}){
  check();const row={label,selector,startMs:Date.now()};actions.push(row);
  const deadline=Date.now()+15000;
  const retirementSensitive=['pause','training-review','open-history','return-play'].includes(label);
  while(true){
   if(!modal&&((await openDialogs(page)).length))await drain();
   if(retirementSensitive&&readState){const state=await readState();if(state.mode==='retired'||label==='pause'&&state.paused){row.skippedAtMs=Date.now();row.skippedReason=state.mode==='retired'?'retired':'already-paused';check();return;}}
   const remaining=deadline-Date.now();assert(remaining>0,`UI action exceeded 15 seconds: ${label}`);
   try{await page.locator(selector).first().click({timeout:modal?remaining:Math.min(750,remaining)});break;}
   catch(error){
    if(modal||error.name!=='TimeoutError')throw error;
    // Recheck known modal interception or observed retirement; preserve unrelated click failures.
    if(!(await openDialogs(page)).length){
     if(retirementSensitive&&readState&&(await readState()).mode==='retired')continue;
     throw error;
    }
    await drain();
   }
  }
  row.endMs=Date.now();await new Promise(resolve=>setTimeout(resolve,100));check();return true;
 }
 async function drain(){for(let n=0;n<40;n++){
  check();const ids=await openDialogs(page);
  if(!ids.length)return;
  if(ids.includes('cutscene-dialog')){if(scenario==='soak')await page.locator('#cutscene-dialog[open]').waitFor({state:'hidden',timeout:30000});else await action('dismiss-cutscene','#cutscene-dialog[open] button',{modal:true});continue;}
  if(ids.includes('result-dialog')){await action('acknowledge-match-results','#result-confirm',{modal:true});continue;}
  if(ids.includes('story-dialog')){await action('story-choice','[data-story-choice]',{modal:true});onStoryChoice();continue;}
  if(ids.includes('decision-dialog')){
   const options=await page.locator('#decision-options [data-choice]').evaluateAll(buttons=>buttons.map(button=>button.dataset.choice));
   const choice=[...(scenario==='youth'?[]:['continue-career']),'practice','trial','FW','athlete','sign','rehab','stay','amateur','army'].find(value=>options.includes(value))||options.find(value=>value.startsWith('offer-'))||options[0];assert(choice,'Natural decision has options');
   await action(`decision:${choice}`,`[data-choice="${choice}"]`,{modal:true});onChoice();
  }
 }throw Error('Dialog limit exceeded');}
 return {action,drain};
}
