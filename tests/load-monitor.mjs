import fs from 'node:fs/promises';
import os from 'node:os';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

function network(text){
  return Object.fromEntries(text.trim().split('\n').slice(2).map(line=>{
    const [name,values]=line.split(':');const fields=values.trim().split(/\s+/).map(Number);
    return [name.trim(),{receivedBytes:fields[0],transmittedBytes:fields[8]}];
  }));
}
function cpu(){return os.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});}
function defaultInterface(text){
  return text.trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/)).filter(row=>row[1]==='00000000'&&row[7]==='00000000'&&(parseInt(row[3],16)&1)).sort((a,b)=>Number(a[6])-Number(b[6]))[0]?.[0]??null;
}
function metrics(previous,current,elapsedMs){
  const delta=current.cpu.total-previous.cpu.total;
  const name=current.receivedInterface,now=current.interfaces[name]?.receivedBytes,before=previous.interfaces[name]?.receivedBytes;
  return {cpuBusyPercent:delta?100*(1-(current.cpu.idle-previous.cpu.idle)/delta):0,receivedMbps:name&&name===previous.receivedInterface&&Number.isFinite(now)&&Number.isFinite(before)?Math.max(0,now-before)*8/(elapsedMs*1000):null};
}
if(process.argv[2]==='--self-check'){
  const interfaces=network('header\nheader\n eth0: 125000 0 0 0 0 0 0 0 90 0 0 0 0 0 0 0');
  assert.equal(interfaces.eth0.transmittedBytes,90);
  const selected=defaultInterface('Iface Destination Gateway Flags RefCnt Use Metric Mask\neth1 00000000 00000000 0001 0 0 100 00000000\neth0 00000000 00000000 0003 0 0 10 00000000\nslave 00000000 00000000 0000 0 0 0 00000000');assert.equal(selected,'eth0');
  interfaces.slave={...interfaces.eth0};
  assert.deepEqual(metrics({cpu:{idle:100,total:200},receivedInterface:selected,interfaces:{eth0:{receivedBytes:0},slave:{receivedBytes:0}}},{cpu:{idle:150,total:400},receivedInterface:selected,interfaces},1000),{cpuBusyPercent:75,receivedMbps:1});
  assert.equal(defaultInterface('Iface Destination Gateway Flags RefCnt Use Metric Mask'),null);
  assert.equal(metrics({cpu:{idle:0,total:0},receivedInterface:null,interfaces:{}},{cpu:{idle:10,total:20},receivedInterface:null,interfaces:{}},1000).receivedMbps,null);
  console.log('monitor self-check passed');
}else{
  const [output,command,...args]=process.argv.slice(2);assert(output&&command,'Usage: load-monitor.mjs OUTPUT COMMAND [ARGS]');
  const interval=Number(process.env.LOAD_MONITOR_INTERVAL_MS||1000);assert([100,1000].includes(interval),'Unsupported monitor interval');
  const file=await fs.open(output,'wx');
  const write=value=>file.write(JSON.stringify(value)+'\n');
  const sample=async()=>({at:new Date().toISOString(),monotonicMs:performance.now(),cpu:cpu(),freeMemoryBytes:os.freemem(),receivedInterface:process.platform==='linux'?defaultInterface(await fs.readFile('/proc/net/route','utf8')):null,interfaces:process.platform==='linux'?network(await fs.readFile('/proc/net/dev','utf8')):{}});
  let nicAdvertisedSpeedMbps=null,nicSpeedInterface=null;if(process.platform==='linux'){nicSpeedInterface=defaultInterface(await fs.readFile('/proc/net/route','utf8'));if(nicSpeedInterface&&/^[a-zA-Z0-9_.-]+$/.test(nicSpeedInterface)){const speed=Number(await fs.readFile(`/sys/class/net/${nicSpeedInterface}/speed`,'utf8').catch(()=>''));if(Number.isFinite(speed)&&speed>0)nicAdvertisedSpeedMbps=speed;}}
  await write({type:'metadata',nicAdvertisedSpeedMbps,nicSpeedInterface,nicSpeedNote:'sysfs advertised speed is diagnostic only; physical path capacity is not verified.',hostname:os.hostname(),machineId:process.platform==='linux'?(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim():os.hostname(),platform:process.platform,release:os.release(),architecture:os.arch(),cpus:os.cpus(),totalMemoryBytes:os.totalmem(),intervalMs:interval,nicSpeedMbps:null,runner:{name:process.env.RUNNER_NAME,os:process.env.RUNNER_OS,arch:process.env.RUNNER_ARCH,image:process.env.ImageOS,imageVersion:process.env.ImageVersion},note:'On non-Linux hosts NIC metrics are unavailable. receivedMbps uses the lowest-metric UP IPv4 default-route interface only, including unrelated traffic. All raw interface counters are retained. Missing/changed route yields null.'});
  let previous=await sample();await write(previous);let pending=Promise.resolve();
  const tick=()=>{pending=pending.then(async()=>{const current=await sample();await write({...current,...metrics(previous,current,current.monotonicMs-previous.monotonicMs)});previous=current;});};
  const timer=setInterval(tick,interval);
  try{
    const child=spawn(command,args,{stdio:'inherit'});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal?1:0)));});
  }finally{clearInterval(timer);tick();await pending;await file.close();}
}
