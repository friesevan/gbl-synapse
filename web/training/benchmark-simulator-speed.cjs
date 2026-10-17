#!/usr/bin/env node
'use strict';
const {performance}=require('node:perf_hooks'),path=require('node:path'),fs=require('node:fs');
const {BattlePool,defaultWorkers}=require('./pool.cjs'),{BattleRunner}=require('./runner.cjs');
const {simulatorFixtures,searchFixtures}=require('./simulator-fixtures.cjs');
const median=xs=>xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)];
async function main(){
 // Positional: [battles] [repeats] [workers] [output.json]. Flags:
 // --fixtures legacy|search (default legacy, the fixture set of earlier tables);
 // search builds belief priors and opponents as search.cjs does, from --pool
 // (else the bundled rankings) and optionally --usage-file with
 // --usage-half-life-days, --usage-as-of and --usage-prior-strength.
 const args=process.argv.slice(2),flags={},positional=[];
 for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const [k,v]=args[i].slice(2).split('=');flags[k]=v??args[++i];}else positional.push(args[i]);}
 const n=Number(positional[0]||192),repeats=Number(positional[1]||3),workers=Number(positional[2]||defaultWorkers()),out=positional[3],kind=flags.fixtures||'legacy';
 if(!Number.isInteger(n)||n<8||!Number.isInteger(repeats)||repeats<1||!Number.isInteger(workers)||workers<1||!['legacy','search'].includes(kind))throw Error('Usage: node training/benchmark-simulator-speed.cjs [battles>=8] [repeats>=1] [workers>=1] [output.json] [--fixtures legacy|search] [--pool FILE] [--usage-file FILE --usage-half-life-days N --usage-as-of DATE --usage-prior-strength N]');
 const prepared=flags.pool?JSON.parse(fs.readFileSync(path.resolve(flags.pool))):null;
 const jobs=kind==='search'?searchFixtures(n,{pool:prepared,usageFile:flags['usage-file']||'',usageHalfLifeDays:Number(flags['usage-half-life-days']||0),usageAsOf:flags['usage-as-of']||'',usagePriorStrength:Number(flags['usage-prior-strength']??500)}):simulatorFixtures(n);
 const output={createdAt:new Date().toISOString(),node:process.version,workers,battlesPerRun:n,repeats,fixtures:kind==='search'?{kind,pool:prepared?{path:flags.pool,hash:prepared.hash}:null,usageFile:flags['usage-file']||null,beliefTeams:jobs[0][4].beliefTeams.length}:{kind},loadAverage:require('node:os').loadavg(),measurements:[],warning:'Paired full-battle benchmark, including worker startup/recycling. Frozen-reference event parity is tested separately. Hardware load affects throughput; no neural-quality gain is implied.'};
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
 output.loadAverageAfter=require('node:os').loadavg();
 if(out)fs.writeFileSync(path.resolve(out),JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify({baselineBattlesPerSecond:output.baselineBattlesPerSecond,optimizedBattlesPerSecond:output.optimizedBattlesPerSecond,speedup:output.speedup}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
