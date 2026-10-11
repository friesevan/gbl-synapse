#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Network,reference}=require('./interaction.cjs'),{predictParallel}=require('./predict.cjs'),{generateCandidates,selectCandidates}=require('./propose.cjs');
const {createMeta}=require('./meta.cjs'),{features,teamKey,mechanicsHash,digest,options,atomic}=require('./common.cjs');
const {BattlePool}=require('../pool.cjs'),{BattleRunner}=require('../runner.cjs'),{defaults}=require('../utils.cjs');
async function benchmark(o){
 const s=JSON.parse(fs.readFileSync(o.checkpoint)),p=JSON.parse(fs.readFileSync(o.pool));
 if(s.config.poolHash!==p.hash||s.config.mechanicsHash!==mechanicsHash())throw Error('Use matching pool and simulator mechanics');
 if(s.config.meta.observedShare>0)throw Error('Synthetic meta only');
 const meta=createMeta(p.species,{mode:s.config.meta.mode,weightPower:s.config.meta.weightPower}),byId=new Map(p.species.map(row=>[row.speciesId,row]));
 const refs=meta.fixtures(s.config.referenceOpponents,s.config.seed+500001).map(row=>features([0,1,2],row.team.map(r=>byId.get(r.speciesId))));
 const models=s.models.map(Network.fromJSON),known=s.records.slice().sort((a,b)=>b.reward/b.games-a.reward/a.games).slice(0,24);
 const params={variants:p.variants,known,seen:new Map(s.records.map(r=>[teamKey(r.team),r])),seed:o.seed,candidates:o.candidates,batchTeams:24,localSearch:false};
 const generation=generateCandidates(params),scores=await predictParallel(generation.teams.map(t=>features(t,p.variants)),models,reference(models,refs),{workers:o.workers});
 const groups=Object.fromEntries(['disagreement','promising'].map(exploration=>{const selected=selectCandidates({...params,exploration},generation,scores);return [exploration,selected.teams.filter(t=>selected.sources[teamKey(t)]==='uncertainty')];}));
 // Freeze both selections before generating or simulating the fresh panel.
 const teams=[...new Map(Object.values(groups).flat().map(t=>[teamKey(t),t])).values()],cases=meta.fixtures(o.opponents,o.seed+900001);
 const oldSeeds=new Set(s.observations.map(r=>r.seed));if(cases.some(c=>oldSeeds.has(c.seed)))throw Error('Fresh panel accidentally overlaps a training seed');
 const jobs=[];for(let i=0;i<cases.length;i++)for(const t of teams)jobs.push([t.map(v=>p.variants[v]),cases[i].team,defaults,defaults,{seed:cases[i].seed,cp:1500,horizon:s.config.lookaheadTurns,interval:s.config.decisionInterval}]);
 console.log('Testing '+teams.length+' unseen teams · '+jobs.length+' canonical battles · '+o.workers+' workers');
 const pool=new BattlePool(o.workers,()=>new BattleRunner({workerFile:path.join(__dirname,'../battle-worker-v2.cjs'),heapMb:192}));let results;
 try{results=await pool.map(jobs);}finally{await pool.close();}
 if(results.some(r=>r.timedOut||!Number.isFinite(r.score)))throw Error('Incomplete/invalid simulation');
 const indices=new Map(teams.map((t,i)=>[teamKey(t),i])),panel=cases.map((_,i)=>Object.fromEntries(Object.entries(groups).map(([k,ts])=>[k,ts.reduce((sum,t)=>sum+results[i*teams.length+indices.get(teamKey(t))].score,0)/ts.length])));
 const mean=k=>panel.reduce((sum,row)=>sum+row[k],0)/panel.length,diffs=panel.map(r=>r.promising-r.disagreement),delta=mean('promising')-mean('disagreement'),se=Math.sqrt(diffs.reduce((sum,v)=>sum+(v-delta)**2,0)/(diffs.length-1)/diffs.length);
 const report={checkpointHash:digest(s),mechanicsHash:mechanicsHash(),seed:o.seed,opponents:o.opponents,battles:results.length,groups,teamNames:Object.fromEntries(Object.entries(groups).map(([k,ts])=>[k,ts.map(t=>t.map(i=>({species:p.variants[i].speciesId,moves:p.variants[i].moveset})))])),scores:{disagreement:mean('disagreement'),promising:mean('promising'),difference:delta,paired95:[delta-1.96*se,delta+1.96*se]},warning:'Fresh-panel diagnostic for two fixed six-team acquisition batches selected from the same frozen neural candidate pool. Conditional on this synthetic meta, model and simulator. Does not establish complete-search advantage, global optimality or live win rates.'};
 atomic(path.resolve(o.out),report);console.log(JSON.stringify(report.scores,null,2));return report;
}
if(require.main===module){const o=options(process.argv.slice(2),{checkpoint:'',pool:'',seed:20261012,candidates:12000,opponents:128,workers:12,out:'acquisition-benchmark.json'});benchmark(o).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={benchmark};
