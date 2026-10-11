#!/usr/bin/env node
'use strict';
// Frozen-data diagnostics only. Never feeds held-out teams into fitting or proposal generation.
const fs=require('node:fs'),path=require('node:path');
const {features,teamKey,digest,fixtures,sampleFixtures,options}=require('./common.cjs');
const {fitParallel}=require('./fit-interaction.cjs');
const {logit,predict,reference}=require('./interaction.cjs');
const {random}=require('../utils.cjs');
function splitByTeam(rows,fold=0){
 if(!Number.isInteger(fold)||fold<0||fold>4)throw Error('fold must be 0–4');
 const isTest=row=>parseInt(digest(teamKey(row.team)).slice(0,8),16)%5===fold;
 return {training:rows.filter(row=>!isTest(row)),test:rows.filter(isTest)};
}
function ranks(values){const order=values.map((value,i)=>({value,i})).sort((a,b)=>a.value-b.value),result=new Array(values.length);for(let start=0;start<order.length;){let end=start+1;while(end<order.length&&order[end].value===order[start].value)end++;for(let i=start;i<end;i++)result[order[i].i]=(start+end-1)/2;start=end;}return result;}
function correlation(a,b){if(a.length<2)return null;const aa=ranks(a),bb=ranks(b),am=aa.reduce((s,v)=>s+v,0)/aa.length,bm=bb.reduce((s,v)=>s+v,0)/bb.length;let dot=0,av=0,bv=0;for(let i=0;i<a.length;i++){const x=aa[i]-am,y=bb[i]-bm;dot+=x*y;av+=x*x;bv+=y*y;}return av*bv?dot/Math.sqrt(av*bv):null;}
async function audit({checkpoint,pool:poolFile,cap=24000,hidden=16,epochs=6,ensemble=4,workers=4,seed=260109,fold=0,repeats=3,referenceOpponents=1024,bootstrap='fixture,team',out=''}={}){
 if(!checkpoint||!poolFile)throw Error('Pass --checkpoint FILE --pool FILE');
 const raw=fs.readFileSync(checkpoint,'utf8'),state=JSON.parse(raw),pool=JSON.parse(fs.readFileSync(poolFile,'utf8'));
 if(state.config.poolHash!==pool.hash)throw Error('Checkpoint pool mismatch');
 const {training,test}=splitByTeam(state.observations,fold);if(!training.length||!test.length)throw Error('Need training and held-out candidate identities');
 const species=new Map(pool.species.map(s=>[s.speciesId,s])),own=new Map(),foes=new Map();
 const a=team=>{const k=teamKey(team);if(!own.has(k))own.set(k,features(team,pool.variants));return own.get(k);};
 const b=ids=>{const key=ids.join(',');if(!foes.has(key))foes.set(key,features([0,1,2],ids.map(id=>species.get(id))));return foes.get(key);};
 const sample=sampleFixtures(training,cap,random(seed)).map(row=>({a:a(row.team),b:b(row.opponent),y:row.score,key:teamKey(row.team)}));
 const heldout=test.map(row=>({a:a(row.team),b:b(row.opponent),y:row.score,key:teamKey(row.team)}));
 const opponents=fixtures(pool.species,referenceOpponents,seed+9311).map(c=>b(c.team.map(s=>s.speciesId)));
 const constant=training.reduce((s,row)=>s+row.score,0)/training.length;
 const baselinePairMSE=heldout.reduce((s,row)=>s+(constant-row.y)**2,0)/heldout.length;
 const results=[];
 for(let repeat=0;repeat<repeats;repeat++)for(const mode of bootstrap.split(',')){
  const start=performance.now(),models=await fitParallel(sample,{workers,size:ensemble,hidden,epochs,seed:seed+repeat*104729,bootstrap:mode}),fitSeconds=(performance.now()-start)/1000,caches=models.map(()=>new Map());
  const forward=(i,x)=>{if(!caches[i].has(x))caches[i].set(x,models[i].forward(x));return caches[i].get(x);};
  let pairMSE=0,logLoss=0;const teams=new Map();
  for(const row of heldout){const p=models.reduce((s,n,i)=>s+1/(1+Math.exp(-logit(n,forward(i,row.a),forward(i,row.b)))),0)/models.length;pairMSE+=(p-row.y)**2;logLoss-=row.y*Math.log(Math.max(p,1e-12))+(1-row.y)*Math.log(Math.max(1-p,1e-12));const t=teams.get(row.key)||{input:row.a,sum:0,conditional:0,n:0};t.sum+=row.y;t.conditional+=p;t.n++;teams.set(row.key,t);}
  const refs=reference(models,opponents),values=[...teams.values()].map(t=>({...t,observed:t.sum/t.n,predicted:predict(models,t.input,refs)}));
  const teamMSE=values.reduce((s,t)=>s+(t.predicted.mean-t.observed)**2,0)/values.length,constantTeamMSE=values.reduce((s,t)=>s+(constant-t.observed)**2,0)/values.length;
  const result={bootstrap:mode,repeat,seed:seed+repeat*104729,fitSeconds,teamMSE,constantTeamMSE,pairMSE:pairMSE/heldout.length,constantPairMSE:baselinePairMSE,conditionalTeamMSE:values.reduce((s,t)=>s+(t.conditional/t.n-t.observed)**2,0)/values.length,logLoss:logLoss/heldout.length,rankCorrelation:correlation(values.map(t=>t.predicted.mean),values.map(t=>t.observed)),meanEnsembleSD:values.reduce((s,t)=>s+t.predicted.uncertainty,0)/values.length};
  results.push(result);console.log(JSON.stringify(result));
 }
 const report={checkpointHash:digest(raw),poolHash:pool.hash,sourceMechanicsHash:state.config.mechanicsHash,sourceFeatures:state.config.features,fold,trainingFixtures:training.length,fitFixtures:sample.length,heldoutFixtures:test.length,heldoutTeams:new Set(test.map(t=>teamKey(t.team))).size,referenceOpponents,hidden,epochs,ensemble,results,warning:'Adaptive held-out candidate diagnostics on frozen historical simulator labels; not an untouched final evaluation of team win rate or new mechanics. Ensemble standard deviation is not a calibrated confidence interval.'};
 if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),JSON.stringify(report,null,2));}return report;
}
if(require.main===module){const o=options(process.argv.slice(2),{checkpoint:'',pool:'',cap:24000,hidden:16,epochs:6,ensemble:4,workers:4,seed:260109,fold:0,repeats:3,referenceOpponents:1024,bootstrap:'fixture,team',out:''});audit(o).then(report=>console.log(JSON.stringify(report,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={audit,splitByTeam,correlation};
