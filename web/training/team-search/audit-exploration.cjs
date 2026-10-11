#!/usr/bin/env node
'use strict';
// Retrospective proposal-quality diagnostic. Never edits the source run and
// never treats its previously observed scores as fresh validation.
const fs=require('node:fs'),path=require('node:path');
const {features,digest,teamKey,options,atomic}=require('./common.cjs');
const {random}=require('../utils.cjs');
const {Network,reference}=require('./interaction.cjs');
const {predictParallel}=require('./predict.cjs');
const {createMeta}=require('./meta.cjs');
const {explorationScore}=require('./propose.cjs');
function choose(rows,mode,n=6){return rows.slice().sort((a,b)=>explorationScore(b,mode)-explorationScore(a,mode)).slice(0,n);}
async function audit(opts){
 const state=JSON.parse(fs.readFileSync(opts.checkpoint)),pool=JSON.parse(fs.readFileSync(opts.pool));
 if(state.config.poolHash!==pool.hash)throw Error('Checkpoint/pool mismatch');
 if(state.config.algorithm!=='interaction-neural-v5-common-panel')throw Error('Diagnostic requires the frozen v5 model with its documented candidate holdout');
 if(!state.models?.length)throw Error('Need fitted models');
 const heldout=state.records.filter(r=>parseInt(digest(teamKey(r.team)).slice(0,8),16)%5===0);
 if(heldout.length<24)throw Error('Too few unseen fitting identities');
 const speciesMap=new Map(pool.species.map(s=>[s.speciesId,s])),m=state.config.meta;
 if(m.observedShare>0)throw Error('Observed meta requires its original usage file; this diagnostic supports synthetic runs');
 const meta=createMeta(pool.species,{mode:m.mode,weightPower:m.weightPower});
 const refs=meta.fixtures(state.config.referenceOpponents,state.config.seed+500001).map(row=>features([0,1,2],row.team.map(s=>speciesMap.get(s.speciesId))));
 const models=state.models.map(Network.fromJSON),scores=await predictParallel(heldout.map(r=>features(r.team,pool.variants)),models,reference(models,refs),{workers:opts.workers});
 const all=heldout.map((r,i)=>({...scores[i],actual:r.reward/r.games,key:teamKey(r.team),fixtures:r.games})),panels=[];
 const rng=random(opts.seed),n=Math.min(opts.panel,all.length);
 for(let iteration=0;iteration<opts.repeats;iteration++){
  const rows=all.slice();for(let i=0;i<n;i++){const j=i+Math.floor(rng()*(rows.length-i));[rows[i],rows[j]]=[rows[j],rows[i]];}
  const candidates=rows.slice(0,n).sort((a,b)=>b.mean-a.mean),remaining=candidates.slice(11);
  const mean=a=>a.reduce((sum,r)=>sum+r.actual,0)/a.length;
  panels.push({disagreement:mean(choose(remaining,'disagreement')),promising:mean(choose(remaining,'promising'))});
 }
 const avg=k=>panels.reduce((s,r)=>s+r[k],0)/panels.length;
 const groups=new Map();for(const h of state.history||[])for(const s of h.proposalScores||[]){const g=groups.get(s.source)||{teams:0,reward:0};g.teams+=s.teams;g.reward+=s.teams*s.meanScore;groups.set(s.source,g);}
 const result={checkpointHash:digest(state),heldoutTeams:all.length,repeatedPanels:opts.repeats,panelSize:n,seed:opts.seed,disagreement:avg('disagreement'),promising:avg('promising'),difference:avg('promising')-avg('disagreement'),historicalProposalScores:Object.fromEntries([...groups].map(([key,g])=>[key,{teams:g.teams,mean:g.reward/g.teams}])),warning:'Retrospective on fitting-held-out candidate identities. Their observed scores have unequal samples and different opponent panels. Repeated subsets overlap and are not independent experiments. This diagnoses acquisition quality; it does not validate a new best team or equal-compute search advantage.'};
 if(opts.out)atomic(path.resolve(opts.out),result);return result;
}
if(require.main===module){const opts=options(process.argv.slice(2),{checkpoint:'',pool:'',workers:12,repeats:100,panel:200,seed:20261011,out:''});audit(opts).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={audit,choose};
