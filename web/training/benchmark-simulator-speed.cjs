#!/usr/bin/env node
'use strict';
const {performance}=require('node:perf_hooks'),path=require('node:path'),fs=require('node:fs');
const {BattlePool,defaultWorkers}=require('./pool.cjs'),{BattleRunner}=require('./runner.cjs');
const {simulatorFixtures}=require('./simulator-fixtures.cjs');
const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)];
async function main(){
 const n=Number(process.argv[2]||192),repeats=Number(process.argv[3]||3),workers=Number(process.argv[4]||defaultWorkers());
 if(!Number.isInteger(n)||n<8||!Number.isInteger(repeats)||repeats<1||!Number.isInteger(workers)||workers<1)throw Error('Usage: node training/benchmark-simulator-speed.cjs [battles>=8] [repeats>=1] [workers>=1] [output.json]');
 const jobs=simulatorFixtures(n),output={createdAt:new Date().toISOString(),node:process.version,workers,battlesPerRun:n,repeats,measurements:[],warning:'Paired full-battle benchmark, including worker startup/recycling. Frozen-reference event parity is tested separately. Hardware load affects throughput; no neural-quality gain is implied.'};
 let reference;
 for(let r=0;r<=repeats;r++)for(const optimized of r%2?[true,false]:[false,true]){
  const pool=new BattlePool(workers,()=>new BattleRunner({workerFile:path.join(__dirname,'battle-worker-v4.cjs'),heapMb:192}));
  const start=performance.now();let rows,peakRssBytes=process.memoryUsage.rss();
  try{rows=await pool.map(jobs.map(j=>[...j.slice(0,4),{...j[4],simulationOptimizations:optimized}]),{onResult:()=>{peakRssBytes=Math.max(peakRssBytes,process.memoryUsage.rss());}});
   if(rows.some(x=>x.timedOut))throw Error('Benchmark battle timed out');
   const labels=rows.map(x=>[x.score,x.turns,x.charged,x.remaining,x.planner]);
   if(reference&&JSON.stringify(reference)!==JSON.stringify(labels))throw Error('Benchmark outcome/planner parity failed');reference=labels;
   const seconds=(performance.now()-start)/1000;
   const result={warmup:r===0,repetition:r,optimized,seconds,battlesPerSecond:n/seconds,peakRssMB:peakRssBytes/1048576,peakWorkerHeapMB:pool.peakWorkerHeapBytes/1048576,recycles:pool.recycles};
   output.measurements.push(result);console.log(JSON.stringify(result));
  }finally{await pool.close();}
 }
 const results=optimized=>output.measurements.filter(m=>!m.warmup&&m.optimized===optimized);
 output.baselineMedianSeconds=median(results(false).map(m=>m.seconds));output.optimizedMedianSeconds=median(results(true).map(m=>m.seconds));output.speedup=output.baselineMedianSeconds/output.optimizedMedianSeconds;
 output.baselineBattlesPerSecond=n/output.baselineMedianSeconds;output.optimizedBattlesPerSecond=n/output.optimizedMedianSeconds;
 if(process.argv[5])fs.writeFileSync(path.resolve(process.argv[5]),JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify({baselineBattlesPerSecond:output.baselineBattlesPerSecond,optimizedBattlesPerSecond:output.optimizedBattlesPerSecond,speedup:output.speedup}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
