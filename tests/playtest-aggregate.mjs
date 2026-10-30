import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const completeP95 = values => values.length&&values.every(value=>Number.isFinite(value)&&value>=0)?p95(values):null;
const p95 = values => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1] : null;
async function files(directory, name) {
  const result=[];
  for (const entry of await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
    const full=path.join(directory,entry.name);
    if(entry.isDirectory()) result.push(...await files(full,name));
    else if(entry.name===name) result.push(full);
  }
  return result;
}
export function summarizeHostHealth(rows, clients) {
  const windows=(clients??[]).map(client=>[client.activeStartMs,client.activeEndMs]);
  const validWindows=windows.length>0&&windows.every(([start,end])=>Number.isFinite(start)&&Number.isFinite(end)&&end>start);
  const timedRows=rows.filter(row=>row.type!=='metadata');
  const timestampsValid=timedRows.every((row,index)=>Number.isFinite(Date.parse(row.at))&&(index===0||Date.parse(row.at)>Date.parse(timedRows[index-1].at)));
  const coverageValid=validWindows&&timestampsValid&&windows.every(([start,end])=>{
    const samples=timedRows.filter(row=>Date.parse(row.at)>=start&&Date.parse(row.at)<=end);
    return samples.length>=10&&Date.parse(samples[0].at)-start<=3000&&end-Date.parse(samples.at(-1).at)<=3000&&samples.every((row,index)=>index===0||Date.parse(row.at)-Date.parse(samples[index-1].at)<=3000);
  });
  const active=[];
  for(let index=1;index<rows.length;index++) {
    const row=rows[index],at=Date.parse(row.at),previousAt=Date.parse(rows[index-1].at);
    // CPU is an interval delta: exclude boundary samples that include barrier idle time.
    if(validWindows&&windows.some(([start,end])=>previousAt>=start&&at<=end&&at>previousAt)) active.push(row);
  }
  const summarize=samples=>{
    let streak=0,longest=0;
    for(const row of samples) {streak=Number.isFinite(row.cpuBusyPercent)&&row.cpuBusyPercent>90?streak+1:0;longest=Math.max(longest,streak);}
    const cpu=samples.map(row=>row.cpuBusyPercent).filter(Number.isFinite);
    const memory=samples.map(row=>row.freeMemoryBytes).filter(Number.isFinite);
    return {samples:samples.filter(row=>Number.isFinite(row.cpuBusyPercent)&&Number.isFinite(row.freeMemoryBytes)).length,cpuMeanPercent:mean(cpu),cpuP95Percent:p95(cpu),cpuAbove90ConsecutiveSamples:longest,minFreeMemoryBytes:memory.length?Math.min(...memory):null,receivedMbpsP95:p95(samples.map(row=>row.receivedMbps).filter(Number.isFinite))};
  };
  const result=summarize(active);
  result.activeMetricRows=active.length;
  result.coverageValid=coverageValid;
  result.metricsValid=coverageValid&&result.samples>=10&&active.every(row=>Number.isFinite(row.cpuBusyPercent)&&row.cpuBusyPercent>=0&&row.cpuBusyPercent<=100&&Number.isFinite(row.freeMemoryBytes)&&row.freeMemoryBytes>=0);
  result.runnerBottleneck=result.cpuMeanPercent>90 || result.cpuAbove90ConsecutiveSamples>=10 || (result.minFreeMemoryBytes!==null&&result.minFreeMemoryBytes<512*1024*1024);
  result.lifetime=summarize(rows.filter(row=>Number.isFinite(row.cpuBusyPercent)));
  return result;
}
export async function hostHealth(file, report) {
  const rows=(await fs.readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const metadata=rows.find(row=>row.type==='metadata');
  return {source:path.basename(path.dirname(file)),platform:metadata?.platform,machineId:metadata?.machineId,runnerName:metadata?.runner?.name,...summarizeHostHealth(rows,report?.clients)};
}

const activeActions=client=>(client.actions??[]).filter(action=>Number.isFinite(action.startMs)&&Number.isFinite(action.endMs)&&action.startMs>=client.activeStartMs&&action.endMs<=client.activeEndMs&&action.endMs>=action.startMs);

export function validate(reports, hosts, jobResults={}, mode='youth', layout={totalClients:25,clientsPerShard:2}) {
  const {totalClients,clientsPerShard}=layout,shardCount=Math.ceil(totalClients/clientsPerShard);
  assert(Number.isInteger(totalClients)&&totalClients>=1&&totalClients<=200&&Number.isInteger(clientsPerShard)&&clientsPerShard>=1&&clientsPerShard<=10&&shardCount<=20,'Invalid bounded cohort layout');
  const soak=mode==='soak';
  const failures=[];
  const check=(condition,message)=>{if(!condition)failures.push(message);};
  check(reports.length===shardCount,`Expected ${shardCount} shard reports; found ${reports.length}`);
  check(hosts.length===shardCount,`Expected ${shardCount} host metric files`);
  check(hosts.every(host=>host.metricsValid===true&&host.samples>=10),'Missing or invalid active CPU/RAM host metrics');
  check(hosts.every(host=>host.runnerBottleneck===false),'Runner bottleneck: active CPU or RAM headroom insufficient');
  for(const [name,result] of Object.entries(jobResults)) check(result==='success',`${name} job result: ${result}`);
  const clients=reports.flatMap(report=>report.clients??[]);
  check(clients.length===totalClients,`Expected ${totalClients} clients; found ${clients.length}`);
  check(new Set(clients.map(client=>client.id)).size===totalClients&&clients.every(client=>Number.isInteger(client.id)&&client.id>=0&&client.id<totalClients),`Client IDs must be unique integers 0 through ${totalClients-1}`);
  check(new Set(reports.map(report=>report.shardId)).size===shardCount&&reports.every(report=>Number.isInteger(report.shardId)&&report.shardId>=0&&report.shardId<shardCount),`Shard IDs must be 0 through ${shardCount-1}`);
  check(new Set(reports.map(report=>report.startEpochMs)).size===1&&reports.every(report=>report.startEpochMs>0&&report.durationSeconds===(soak?610:60)&&(!soak||report.scenario==='soak')),`Shards must share one barrier and ${soak?610:60}-second duration`);
  check(new Set(clients.map(client=>client.initialSaveSha256)).size===totalClients,'Save identities must be unique');
  for(const report of reports) {const expectedCount=Math.min(clientsPerShard,totalClients-report.shardId*clientsPerShard);check(report.count===expectedCount&&report.clients?.length===expectedCount,`Shard ${report.shardId} must contain ${expectedCount} clients`);check((report.clients??[]).map(client=>client.id).sort((a,b)=>a-b).every((id,index)=>id===report.shardId*clientsPerShard+index),`Shard ${report.shardId} client IDs do not match shard allocation`);check(report.success===true,'Shard scenario failed');for(const client of report.clients??[])check(Number.isFinite(client.readyAtMs)&&client.readyAtMs<=report.startEpochMs&&client.activeStartMs>=report.startEpochMs&&client.activeStartMs<=report.startEpochMs+5000,`Client ${client.id}: missing common-barrier readiness`);}
  if(soak){
    if(totalClients!==25||clientsPerShard!==2){
      check(reports.every(report=>report.totalClients===totalClients&&report.clientsPerShard===clientsPerShard),'Inconsistent declared cohort layout');
      check(reports.every(report=>report.platform==='linux')&&hosts.every(host=>host.platform==='linux'),'Capacity requires Linux runner provenance');
      check(layout.provenance&&reports.every(report=>report.revision===layout.provenance.revision&&JSON.stringify(report.sourceManifest)===JSON.stringify(layout.provenance.sourceManifest)&&JSON.stringify(report.expectedAssets)===JSON.stringify(layout.provenance.expectedAssets)),'Reports differ from actual aggregation checkout revision, test sources or pinned asset fixture');
      check(reports.every(report=>{
        const expected={requests:Math.min(10000,report.count*512),encodedBytes:Math.min(500e6,report.count*64*1024*1024),decodedBytes:Math.min(2e9,report.count*128*1024*1024)};
        return Object.entries(expected).every(([key,limit])=>report.networkLimits?.[key]===limit&&Number.isFinite(report.networkTotals?.[key])&&report.networkTotals[key]>=0&&report.networkTotals[key]<=limit);
      }),'Missing, exceeded or inconsistent browser network guard');
      check(reports.every(report=>hosts.some(host=>host.source===`browser-shard-${report.shardId}`&&host.machineId===report.machineId&&host.runnerName===report.runnerName)),'Host/report shard identity mismatch');
      for(const key of ['machineId','runnerName']){
        check(reports.every(report=>typeof report[key]==='string'&&report[key].length>0)&&new Set(reports.map(report=>report[key])).size===shardCount,`Missing or reused runner ${key}`);
        check(hosts.every(host=>reports.some(report=>report[key]===host[key]))&&new Set(hosts.map(host=>host[key])).size===shardCount,`Host/report ${key} mismatch`);
      }
    }
    check(reports.every(report=>typeof report.revision==='string'&&/^[a-f0-9]{40}$/.test(report.revision))&&new Set(reports.map(report=>report.revision)).size===1,'Missing or inconsistent workflow source revision');
    for(const key of ['sourceManifest','expectedAssets']) check(reports.every(report=>report[key]&&Object.values(report[key]).length>0&&Object.values(report[key]).every(value=>/^[a-f0-9]{64}$/.test(value)))&&new Set(reports.map(report=>JSON.stringify(report[key]))).size===1,'Missing or inconsistent '+key);
    check(reports.every(report=>['tests/playtest-browser.mjs','tests/load-monitor.mjs','tests/playtest-aggregate.mjs','tests/playtest-ui.mjs'].every(file=>/^[a-f0-9]{64}$/.test(report.sourceManifest?.[file]??''))),'Missing test source fingerprints');
    const observed=new Map();
    for(const client of clients){
      const bodies=client.network?.bodyHashes??[];
      check(bodies.length>0,`Client ${client.id}: no asset body hashes`);
      for(const body of bodies){const previous=observed.get(body.url);check(/^[a-f0-9]{64}$/.test(body.sha256)&&(!previous||previous===body.sha256),`Client ${client.id}: asset body changed: ${body.url}`);observed.set(body.url,body.sha256);}
      const expected=reports[0]?.expectedAssets??{};
      for(const pathname of ['/','/app.js','/engine.js','/data.js','/style.css']){
        const key=pathname==='/'&&expected['/']===undefined?'/index.html':pathname;
        check(/^[a-f0-9]{64}$/.test(expected[key]??''),`Missing pinned core asset ${key}`);
        for(const phase of ['initial','relaunch'])check(bodies.some(body=>body.phase===phase&&new URL(body.url).pathname===pathname&&body.sha256===expected[key]),`Client ${client.id}: missing or mismatched ${phase} ${pathname}`);
      }
      for(const body of bodies){const pathname=new URL(body.url).pathname,key=pathname==='/'&&expected['/']===undefined?'/index.html':pathname;if(expected[key])check(body.sha256===expected[key],`Client ${client.id}: pinned asset mismatch ${pathname}`);}

    }
  }
  check(new Set(clients.map(client=>client.initialSeed)).size===totalClients&&clients.every(client=>Number.isInteger(client.initialSeed)),'Initial seeds must be unique');
  for(const client of clients) {
    const prefix=`Client ${client.id}: `;
    check(client.status==='passed'&&client.savePreserved===true,prefix+'scenario failed or full-save preservation missing');
    check(/^[a-f0-9]{64}$/.test(client.initialSaveSha256??''),prefix+'missing save identity');
    check((soak?client.adultMatchAppearances>0:client.progressed?.age>=18)&&client.matchAppearances>0&&client.choices>0,prefix+'growth/matches/choices target missing');
    check(/^[a-f0-9]{64}$/.test(client.saveBeforeSha256??'')&&client.saveBeforeSha256===client.saveAfterSha256,prefix+'full save changed on browser process reopen');
    check(Array.isArray(client.errors)&&client.errors.length===0,prefix+'browser/scenario errors');
    check(Array.isArray(client.network?.responses)&&client.network.responses.every(response=>response.status<400),prefix+'HTTP errors');
    const times=activeActions(client).map(action=>action.startMs);
    if(soak){
      const samples=client.samples??[];
      check(Number.isFinite(client.readyMs)&&client.readyMs>=0&&Number.isFinite(client.relaunchMs)&&client.relaunchMs>=0,prefix+'missing preparation/relaunch timing');
      check(Number.isFinite(client.activeStartMs)&&Number.isFinite(client.activeEndMs)&&client.activeEndMs-client.activeStartMs>=610000,prefix+'active soak shorter than 610 seconds');
      check(samples.length>=20&&samples.every((row,index)=>Number.isFinite(row.atMs)&&row.atMs>=client.activeStartMs&&row.atMs<=client.activeEndMs&&(index===0||row.atMs>samples[index-1].atMs)&&row.paused===false&&row.speed===1&&row.visibility==='visible'&&row.reducedMotion===false&&Number.isFinite(row.age)&&Number.isFinite(row.progress)&&Number.isFinite(row.evaluationMs)&&Number.isFinite(row.jsHeapUsedBytes)&&row.jsHeapUsedBytes>=0&&Number.isFinite(row.taskDurationSeconds)&&row.taskDurationSeconds>=0),prefix+'missing or invalid natural-motion samples');
      const edges=[client.activeStartMs,...samples.map(row=>row.atMs),client.activeEndMs];
      check(edges.every((time,index)=>index===0||time-edges[index-1]<=30000),prefix+'sample coverage gap exceeds 30 seconds');
      let previous=samples[0],lastChange=client.activeStartMs,changes=0,maxGap=0;
      for(const row of samples.slice(1)){if(row.age!==previous.age||row.progress!==previous.progress||row.name!==previous.name){changes++;maxGap=Math.max(maxGap,row.atMs-lastChange);lastChange=row.atMs;}previous=row;}
      maxGap=Math.max(maxGap,client.activeEndMs-lastChange);
      check(changes>=60&&maxGap<90000,prefix+'automatic progress missing or stalled for 90 seconds');
      check(times.length>=20&&times.every((time,index)=>index===0||time-times[index-1]<=90000),prefix+'missing periodic UI interaction');
      check(['navigationToAppReadyMs','browserLaunchMs','introScreenshotMs'].every(key=>Number.isFinite(client.timings?.initial?.[key])&&client.timings.initial[key]>=0)&&['navigationToAppReadyMs','browserLaunchMs','resumeMs'].every(key=>Number.isFinite(client.timings?.relaunch?.[key])&&client.timings.relaunch[key]>=0),prefix+'missing or invalid loading timings');
    }else{
    check(client.activeEndMs-client.activeStartMs>=60000,prefix+'active window shorter than 60 seconds');
    check(times.every((time,index)=>index===0||time-times[index-1]<=5000),prefix+'actual UI action gap exceeds five seconds');
    check(times.length>=2&&Number.isFinite(client.activeStartMs)&&Number.isFinite(client.activeEndMs),prefix+'missing active action evidence');
    check(times.length>0&&Math.max(...times)-Math.min(...times)>=30000,prefix+'less than 30 seconds of real actions');
    }
  }
  const first=clients.map(client=>soak?client.samples?.[0]?.atMs:Math.min(...activeActions(client).map(action=>action.startMs)));
  const last=clients.map(client=>soak?client.samples?.at(-1)?.atMs:Math.max(...activeActions(client).map(action=>action.startMs)));
  const commonStartMs=clients.length?Math.max(...first):null;
  const commonEndMs=clients.length?Math.min(...last):null;
  const commonOverlapMs=commonEndMs-commonStartMs;
  check(Number.isFinite(commonOverlapMs)&&commonOverlapMs>=(soak?600000:30000),soak?'Observed natural-motion sample windows do not overlap for 600 seconds across all clients':'Actual UI action windows do not overlap for 30 seconds across all clients');
  return {mode,totalClients,clientsPerShard,shardCount,passed:failures.length===0,failures,clientCount:clients.length,totalMatchAppearances:clients.reduce((sum,client)=>sum+(client.matchAppearances??0),0),totalChoices:clients.reduce((sum,client)=>sum+(client.choices??0),0),minimumAge:clients.length?Math.min(...clients.map(client=>client.progressed?.age??0)):null,commonStartMs,commonEndMs,commonOverlapMs,actionP95Ms:p95(clients.flatMap(client=>(client.actions??[]).map(action=>action.endMs-action.startMs)).filter(Number.isFinite)),preparationP95Ms:p95(clients.map(client=>client.readyMs).filter(Number.isFinite)),readyP95Ms:p95(clients.map(client=>client.readyMs).filter(Number.isFinite)),navigationToAppReadyP95Ms:completeP95(clients.map(client=>client.timings?.initial?.navigationToAppReadyMs)),initialBrowserLaunchP95Ms:completeP95(clients.map(client=>client.timings?.initial?.browserLaunchMs)),introScreenshotP95Ms:completeP95(clients.map(client=>client.timings?.initial?.introScreenshotMs)),relaunchBrowserLaunchP95Ms:completeP95(clients.map(client=>client.timings?.relaunch?.browserLaunchMs)),relaunchNavigationToAppReadyP95Ms:completeP95(clients.map(client=>client.timings?.relaunch?.navigationToAppReadyMs)),resumeP95Ms:completeP95(clients.map(client=>client.timings?.relaunch?.resumeMs)),relaunchP95Ms:p95(clients.map(client=>client.relaunchMs).filter(Number.isFinite)),hosts,runnerBottleneck:hosts.some(host=>host.runnerBottleneck),note:'One production browser-play observation. Runner CPU/RAM and NIC traffic do not establish server capacity.'};
}

function selfCheck() {
  assert.equal(completeP95([10,undefined]),null,'Partial timing samples must not appear cohort-wide');
  assert.equal(completeP95([10,20]),20);
  const hash='a'.repeat(64);
  const reports=Array.from({length:13},(_,shard)=>({success:true,shardId:shard,count:shard===12?1:2,startEpochMs:1000,durationSeconds:60,clients:Array.from({length:shard===12?1:2},(_,index)=>({id:shard*2+index,initialSeed:shard*2+index,initialSaveSha256:(shard*2+index).toString(16).padStart(64,'0'),status:'passed',savePreserved:true,progressed:{age:18},matchAppearances:1,choices:1,saveBeforeSha256:hash,saveAfterSha256:hash,errors:[],network:{responses:[]},activeStartMs:1000,activeEndMs:61010,actions:Array.from({length:13},(_,index)=>({startMs:1000+index*5000,endMs:1010+index*5000})),readyAtMs:900,readyMs:100,relaunchMs:200}))}));
  const hosts=Array.from({length:13},()=>({runnerBottleneck:false,metricsValid:true,samples:60}));
  assert.equal(validate(reports,hosts).passed,true);
  const soaks=structuredClone(reports);
  for(const report of soaks){report.scenario='soak';report.durationSeconds=610;report.revision='a'.repeat(40);report.sourceManifest=Object.fromEntries(['tests/playtest-browser.mjs','tests/load-monitor.mjs','tests/playtest-aggregate.mjs','tests/playtest-ui.mjs'].map(file=>[file,hash]));report.expectedAssets=Object.fromEntries(['/','/app.js','/engine.js','/data.js','/style.css'].map(file=>[file,hash]));for(const client of report.clients){
    client.activeEndMs=611000;client.adultMatchAppearances=1;client.network.bodyHashes=['initial','relaunch'].flatMap(phase=>Object.keys(report.expectedAssets).map(file=>({phase,url:'https://example.com'+file,sha256:hash})));
    client.timings={initial:{navigationToAppReadyMs:1,browserLaunchMs:1,introScreenshotMs:1},relaunch:{navigationToAppReadyMs:1,browserLaunchMs:1,resumeMs:1}};
    client.samples=Array.from({length:611},(_,index)=>({atMs:1000+index*1000,age:index/10,name:'test',progress:index/1000,paused:false,speed:1,visibility:'visible',reducedMotion:false,evaluationMs:1,jsHeapUsedBytes:1,taskDurationSeconds:index}));
    client.actions=Array.from({length:40},(_,index)=>({startMs:1000+index*15000,endMs:1010+index*15000}));
  }}
  assert.equal(validate(soaks,hosts,{},'soak').passed,true,'600-second natural cohort passes without five-second UI cadence');
  for(const [totalClients,clientsPerShard] of [[2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],[9,9],[10,10],[40,2],[50,3],[60,3],[80,4],[100,5],[120,6],[140,7],[160,8],[180,9],[200,10]]){
    const layout={totalClients,clientsPerShard,provenance:{revision:soaks[0].revision,sourceManifest:soaks[0].sourceManifest,expectedAssets:soaks[0].expectedAssets}},shardCount=Math.ceil(totalClients/clientsPerShard);
    const expanded=Array.from({length:shardCount},(_,shardId)=>{
      const report=structuredClone(soaks[0]);
      Object.assign(report,{platform:'linux',shardId,totalClients,clientsPerShard,machineId:`vm-${shardId}`,runnerName:`runner-${shardId}`,count:Math.min(clientsPerShard,totalClients-shardId*clientsPerShard)});
      report.networkLimits={requests:Math.min(10000,report.count*512),encodedBytes:Math.min(500e6,report.count*64*1024*1024),decodedBytes:Math.min(2e9,report.count*128*1024*1024)};report.networkTotals={requests:100,encodedBytes:100,decodedBytes:100};
      report.clients=Array.from({length:report.count},(_,index)=>{const client=structuredClone(soaks[0].clients[0]),id=shardId*clientsPerShard+index;return {...client,id,initialSeed:id,initialSaveSha256:id.toString(16).padStart(64,'0')};});return report;
    });
    const expandedHosts=expanded.map(report=>({...hosts[0],platform:'linux',source:`browser-shard-${report.shardId}`,machineId:report.machineId,runnerName:report.runnerName}));
    assert.equal(validate(expanded,expandedHosts,{},'soak',layout).passed,true,`${totalClients}/${clientsPerShard} layout passes`);
    const rejectLayout=mutate=>{const copy=structuredClone(expanded);mutate(copy);assert.equal(validate(copy,expandedHosts,{},'soak',layout).passed,false);};
    rejectLayout(copy=>copy.at(-1).clients.pop());
    rejectLayout(copy=>copy[0].clients[0].id=totalClients);
    rejectLayout(copy=>copy[0].clientsPerShard=clientsPerShard+1);
    rejectLayout(copy=>copy[0].machineId='unknown');
    rejectLayout(copy=>copy[0].networkTotals.requests=copy[0].networkLimits.requests+1);
    rejectLayout(copy=>delete copy[0].networkLimits);
    rejectLayout(copy=>copy.forEach(report=>report.revision='b'.repeat(40)));
    rejectLayout(copy=>copy.forEach(report=>report.sourceManifest['tests/playtest-browser.mjs']='b'.repeat(64)));
    rejectLayout(copy=>copy[0].platform='win32');
    if(shardCount>1){rejectLayout(copy=>copy[1].machineId=copy[0].machineId);rejectLayout(copy=>copy[1].runnerName=copy[0].runnerName);}
  }
  const rejectSoak=mutate=>{const copy=structuredClone(soaks);mutate(copy[0].clients[0],copy);assert.equal(validate(copy,hosts,{},'soak').passed,false);};
  rejectSoak(client=>client.network.bodyHashes[0].sha256='b'.repeat(64));
  rejectSoak((client,copy)=>copy[0].revision='b'.repeat(40));
  rejectSoak(client=>client.samples[1].paused=true);
  rejectSoak(client=>client.samples[1].reducedMotion=true);
  rejectSoak(client=>client.samples[1].visibility='hidden');
  rejectSoak(client=>client.samples[1].speed=2);
  rejectSoak(client=>client.samples=client.samples.filter((_,index)=>index<10||index>50));
  rejectSoak(client=>client.samples.forEach(row=>{row.age=0;row.progress=0;}));
  rejectSoak(client=>client.activeEndMs=600000);
  rejectSoak(client=>delete client.timings.relaunch.resumeMs);
  rejectSoak((client,copy)=>copy[0].scenario='youth');
  const reversed=structuredClone(reports);
  for(const report of reversed)report.clients.reverse();
  assert.equal(validate(reversed,hosts).passed,true,'Concurrent client completion order must not affect valid shard allocation');
  const reject=mutate=>{const copy=structuredClone(reports);mutate(copy);assert.equal(validate(copy,hosts).passed,false);};
  reject(copy=>copy[0].clients.pop());
  reject(copy=>{copy[12].clients.push(structuredClone(copy[12].clients[0]));copy[12].count=2;});
  reject(copy=>copy[12].shardId=11);
  reject(copy=>{for(const action of copy[0].clients[0].actions)action.startMs+=100000;});
  reject(copy=>copy[0].clients[0].id=copy[0].clients[1].id);
  reject(copy=>copy[0].clients[0].saveAfterSha256='b'.repeat(64));
  reject(copy=>copy[0].clients[0].network.responses.push({status:500}));
  reject(copy=>copy[0].clients[0].actions=copy[0].clients[0].actions.filter((_,index)=>index===0||index===12));
  reject(copy=>{const client=copy[0].clients[0];client.activeEndMs=2000;client.actions.push({startMs:120000,endMs:120010});});
  assert.equal(validate(reports.slice(1),hosts).passed,false);
  const healthyRows=Array.from({length:62},(_,index)=>({at:new Date(1000+index*1000).toISOString(),cpuBusyPercent:20,freeMemoryBytes:1024*1024*1024}));
  const healthy=summarizeHostHealth(healthyRows,[reports[0].clients[0]]);
  assert.equal(healthy.metricsValid,true);
  const rejectHost=host=>{const copy=structuredClone(hosts);copy[0]=host;assert.equal(validate(reports,copy).passed,false);};
  rejectHost({...healthy,runnerBottleneck:true});
  for(const key of ['cpuBusyPercent','freeMemoryBytes']) {
    for(const value of [undefined,NaN]) {
      const rows=structuredClone(healthyRows);rows[5][key]=value;
      const health=summarizeHostHealth(rows,[reports[0].clients[0]]);
      assert.equal(health.metricsValid,false,`${key} must be finite in active samples`);rejectHost(health);
    }
  }
  const masked=Array.from({length:182},(_,index)=>({at:new Date(-119000+index*1000).toISOString(),cpuBusyPercent:index<120?0:99,freeMemoryBytes:1024*1024*1024}));
  const busy=summarizeHostHealth(masked,[reports[0].clients[0]]);
  assert(busy.lifetime.cpuMeanPercent<90);assert.equal(busy.cpuMeanPercent,99);assert.equal(busy.runnerBottleneck,true);rejectHost(busy);
  for(const rows of [healthyRows.filter((_,index)=>index<15||index>45),healthyRows.slice(0,15),healthyRows.map((row,index)=>index===15?{...row,at:'invalid'}:row),healthyRows.map((row,index)=>index===15?{...row,at:healthyRows[14].at}:row)]) {
    const health=summarizeHostHealth(rows,[reports[0].clients[0]]);
    assert.equal(health.metricsValid,false,'Missing cadence, truncated window, invalid or duplicate timestamps must fail');rejectHost(health);
  }
  assert.equal(summarizeHostHealth([{type:'metadata'},...healthyRows],[reports[0].clients[0]]).metricsValid,true,'Metadata has no timestamp');
  rejectHost(summarizeHostHealth(healthyRows,[]));
  rejectHost(summarizeHostHealth(healthyRows.map(row=>({...row,freeMemoryBytes:128*1024*1024})),[reports[0].clients[0]]));
  console.log('playtest aggregate self-check passed: legacy 13 shards / 25 clients plus density 2 through 10 pilots and bounded 40 through 200 cohorts, runner identities, reversed client order, missing client/shard, final shard count, duplicate shard, overlap, duplicate ID, full-save mismatch, HTTP error, action gap, late resume, bottleneck gating, missing/NaN CPU and RAM, active-window CPU vs idle lifetime, low RAM');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
if(process.argv[2]==='--self-check') selfCheck();
else if(process.argv[2]==='--pilot') {
  const directory=process.argv[3];
  const health=await hostHealth(path.join(directory,'host-metrics.jsonl'),JSON.parse(await fs.readFile(path.join(directory,'report.json'),'utf8')));
  await fs.writeFile(path.join(directory,'runner-health.json'),JSON.stringify(health,null,2)+'\n');
  assert(health.metricsValid,'Missing or invalid active pilot CPU/RAM host metrics');
  assert(!health.runnerBottleneck,'Runner bottleneck: CPU or RAM headroom insufficient; do not attribute this to production server capacity');
  console.log(JSON.stringify(health));
} else {
  const soak=process.argv[2]==='--soak';
  const [directory,output,totalArg='25',densityArg='2']=process.argv.slice(soak?3:2);
  const layout={totalClients:Number(totalArg),clientsPerShard:Number(densityArg)};
  assert(directory&&output,'Usage: playtest-aggregate.mjs INPUT_DIRECTORY OUTPUT_JSON');
  let report;
  try {
    if(soak&&(layout.totalClients!==25||layout.clientsPerShard!==2)){
      const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
      assert.equal(process.env.GITHUB_SHA,revision,'Workflow SHA must match actual checkout');
      const sha=body=>crypto.createHash('sha256').update(body).digest('hex');
      const sourceManifest=Object.fromEntries(await Promise.all(['tests/playtest-browser.mjs','tests/load-monitor.mjs','tests/playtest-aggregate.mjs','tests/playtest-ui.mjs'].map(async file=>[file,sha(await fs.readFile(file))])));
      const fixture=JSON.parse(await fs.readFile('tests/fixtures/pro-soak-assets-20261030.json','utf8'));
      assert.equal(fixture.origin,'https://football-life.petermin7.workers.dev');
      layout.provenance={revision,sourceManifest,expectedAssets:Object.fromEntries(fixture.assets.map(asset=>[asset.path,asset.sha256]))};
    }
    const reportFiles=(await files(directory,'report.json')).filter(file=>/browser-shard-\d+[\\/]report\.json$/.test(file));
    const hostFiles=(await files(directory,'host-metrics.jsonl')).filter(file=>/browser-shard-\d+[\\/]/.test(file));
    report=validate(await Promise.all(reportFiles.map(async file=>JSON.parse(await fs.readFile(file,'utf8')))),await Promise.all(hostFiles.map(async file=>hostHealth(file,JSON.parse(await fs.readFile(path.join(path.dirname(file),'report.json'),'utf8'))))),Object.fromEntries([['preflight',process.env.PREFLIGHT_RESULT],['play',process.env.PLAY_RESULT]].filter(([,value])=>value)),soak?'soak':'youth',layout);
  } catch(error) {report={passed:false,failures:[String(error)],note:'Aggregation failed; no capacity conclusion is available.'};}
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`## Browser play result\n\nPassed: ${report.passed}. Clients: ${report.clientCount??0}/${layout.totalClients}. Common observed active overlap: ${report.commonOverlapMs??'unavailable'} ms.\n\nUI action p95: ${report.actionP95Ms??'unavailable'} ms; preparation p95: ${report.preparationP95Ms??'unavailable'} ms; navigation to app-ready p95: ${report.navigationToAppReadyP95Ms??'unavailable'} ms; process relaunch p95: ${report.relaunchP95Ms??'unavailable'} ms.\n\nRunner bottleneck: ${report.runnerBottleneck??'unknown'}. ${report.note}\n\n${(report.hosts??[]).map(host=>`- ${host.source}: active CPU mean ${host.cpuMeanPercent?.toFixed(1)??'unavailable'}%, p95 ${host.cpuP95Percent?.toFixed(1)??'unavailable'}%; minimum free RAM ${host.minFreeMemoryBytes===null?'unavailable':(host.minFreeMemoryBytes/1048576).toFixed(0)} MiB; NIC receive p95 ${host.receivedMbpsP95?.toFixed(2)??'unavailable'} Mbps.`).join('\n')}\n\n${report.failures.map(value=>`- ${value}`).join('\n')}\n`);
  console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}

}
