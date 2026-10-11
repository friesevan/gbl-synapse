#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {BattlePool,defaultWorkers,availableCores}=require('../pool.cjs');
const {BattleRunner}=require('../runner.cjs'),{defaults}=require('../utils.cjs');
const {options,atomic,teamKey,validTeam,digest,mechanicsHash,dataHash}=require('./common.cjs');
const {createMeta}=require('./meta.cjs');
const {panelIndex,commonPanelScores,summarize,compare}=require('./evaluation.cjs');

function scenarios(opts) {
 const rows=[{name:'Original independent prior',mode:'independent',weightPower:1},
  {name:'Correlated prior',mode:'hybrid',weightPower:1.25},
  {name:'Concentrated correlated prior',mode:'hybrid',weightPower:1.75}];
 if(opts.usageFile) rows.push({name:'Recent observed / prior mixture',mode:'hybrid',weightPower:1.25,usageFile:opts.usageFile,halfLifeDays:opts.usageHalfLifeDays,asOf:opts.usageAsOf,priorStrength:opts.usagePriorStrength});
 return rows;
}

async function audit(opts) {
 for(const k of ['teams','opponents','workers','seed']) if(!Number.isInteger(opts[k])||opts[k]<1) throw Error(k+' must be a positive integer');
 if(opts.teams>24||opts.opponents<2||opts.workers>availableCores()||!Number.isFinite(opts.hours)||opts.hours<=0) throw Error('Invalid audit limits');
 const run=path.resolve(opts.run),directory=path.resolve(opts.out),prepared=JSON.parse(fs.readFileSync(opts.pool||path.join(run,'pool.json'))),recommendations=JSON.parse(fs.readFileSync(path.join(run,'recommendations.json')));
 const original={...prepared};delete original.hash;
 if(digest(original)!==prepared.hash||prepared.config.inputHash!==dataHash()||recommendations.poolHash!==prepared.hash) throw Error('Audit needs the matching, unchanged pool and data');
 const chosen=[...new Map(recommendations.rows.slice(0,opts.teams).map(r=>[teamKey(r.variantIndices),r.variantIndices])).values()];
 if(!chosen.length||chosen.some(t=>!validTeam(t,prepared.variants))) throw Error('No valid preselected teams');
 if(fs.existsSync(path.join(directory,'meta-audit.json'))) throw Error('Use a fresh audit output directory and seed');
 const controllers=opts.controllers.split(',');
 if(controllers.some(c=>!['lookahead','champion'].includes(c))||new Set(controllers).size!==controllers.length) throw Error('Controllers: lookahead,champion');
 let stopped=false;const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const pool=new BattlePool(opts.workers,()=>new BattleRunner({workerFile:path.join(__dirname,'../battle-worker-v2.cjs'),heapMb:192})),start=Date.now(),deadline=start+opts.hours*3600000;
 const result={version:'meta-audit-v1',mechanicsHash:mechanicsHash(),poolHash:prepared.hash,createdAt:new Date().toISOString(),selection:'Teams fixed from the input report before this diagnostic; this does not choose a new primary or fit models',teams:chosen.map(t=>({indices:t,members:t.map(i=>({speciesId:prepared.variants[i].speciesId,speciesName:prepared.variants[i].speciesName,moveset:prepared.variants[i].moveset}))})),panels:[],battles:0};
 try {
  for(const [si,scenario] of scenarios(opts).entries()) {
   const meta=createMeta(prepared.species,scenario),fixtureSeed=(opts.seed+si*104729)>>>0,cases=meta.fixtures(opts.opponents,fixtureSeed);
   for(const controller of controllers) {
    if(stopped||Date.now()>=deadline) break;
    console.log(scenario.name+' · opponent '+controller+' · '+chosen.length+' fixed teams / '+cases.length+' fixtures');
    const jobs=cases.flatMap(c=>chosen.map(t=>[t.map(i=>prepared.variants[i]),c.team,defaults,defaults,{seed:c.seed,cp:1500,plannerTeams:[true,controller==='lookahead']}]));
    const partial=chosen.map(()=>new Array(cases.length));let tick=Date.now();
    await pool.map(jobs,{shouldStop:()=>stopped||Date.now()>=deadline,onResult:(r,index)=>{if(r.timedOut) throw Error('Battle timeout; audit cannot fabricate a draw');const p=panelIndex(index,chosen.length);partial[p.team][p.fixture]=r.score;result.battles++;if(Date.now()-tick>10000){tick=Date.now();console.log('[meta-audit] '+result.battles+' battles · '+((Date.now()-start)/1000).toFixed(0)+' seconds');}}});
    const complete=commonPanelScores(chosen,partial),rows=complete.map(({team,scores})=>summarize(scores,{team,fixtureSeed,paired:false}));
    if(rows.length) result.panels.push({name:scenario.name,meta:meta.description,opponentController:controller,fixtureSeed,requestedFixtures:cases.length,completedFixtures:rows[0].pairs.length,rows,comparisons:rows.slice(1).map(r=>({team:r.team,...compare(rows[0],[r],{seed:opts.seed+si*173,samples:2000})}))});
    result.seconds=(Date.now()-start)/1000;atomic(path.join(directory,'meta-audit.json'),result);
   }
  }
 } finally {await pool.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 result.summary=chosen.map(team=>{
  const scores=result.panels.map(p=>p.rows.find(r=>teamKey(r.team)===teamKey(team)).score);
  return {team,meanAcrossAssumptions:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null,worstAssumption:scores.length?Math.min(...scores):null,spread:scores.length?Math.max(...scores)-Math.min(...scores):null};
 });
 result.seconds=(Date.now()-start)/1000;result.complete=result.panels.length===scenarios(opts).length*controllers.length&&result.panels.every(p=>p.completedFixtures===p.requestedFixtures);
 result.warning='Synthetic scenarios and perfect-information controllers are sensitivity diagnostics, not measured live usage or real GBL win rates. Means weight each assumption equally for display; no claim that those probabilities describe the meta. Pair intervals are exploratory, without adjustment across these scenarios.';
 atomic(path.join(directory,'meta-audit.json'),result);
 const pct=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';
 const names=t=>t.map(i=>prepared.variants[i].speciesName+' ('+prepared.variants[i].moveset.join('/')+')').join(' · ');
 const markdown='# Team sensitivity to the meta and opponent strategy\n\n'+result.warning+'\n\n'+result.battles+' new battles in '+result.seconds.toFixed(1)+' seconds; '+(result.complete?'all requested panels completed':'partial common panels retained')+'.\n\n| Fixed team | Equal-assumption mean | Worst assumption | Spread |\n| --- | ---: | ---: | ---: |\n'+result.summary.map(r=>'| '+names(r.team)+' | '+pct(r.meanAcrossAssumptions)+' | '+pct(r.worstAssumption)+' | '+pct(r.spread)+' |').join('\n')+'\n\n'+result.panels.map(p=>'## '+p.name+' / opponent '+p.opponentController+'\n\n'+p.completedFixtures+' common fixtures; seed '+p.fixtureSeed+'.\n\n| Fixed team | Score | Standard error |\n| --- | ---: | ---: |\n'+p.rows.map(r=>'| '+names(r.team)+' | '+pct(r.score)+' | '+pct(r.standardError)+' |').join('\n')).join('\n\n')+'\n';
 fs.writeFileSync(path.join(directory,'meta-audit.md'),markdown);console.log('Saved '+path.join(directory,'meta-audit.json'));return result;
}
const defaultsOptions={run:'training/runs/team-search-v3',pool:'',out:'training/runs/meta-audit-v3',teams:8,opponents:256,workers:defaultWorkers(),seed:2026101013,hours:1,controllers:'lookahead,champion',usageFile:'',usageHalfLifeDays:0,usageAsOf:'',usagePriorStrength:500};
if(require.main===module){const opts=options(process.argv.slice(2),defaultsOptions);if(opts.help)console.log('node training/team-search/meta-audit.cjs --run RUN --out NEW_DIR [--teams 8] [--opponents 256] [--hours 1] [--controllers lookahead,champion] [--usage-file JSON] [--usage-half-life-days 7 --usage-as-of YYYY-MM-DD]');else audit(opts).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={audit,scenarios,defaultsOptions};
