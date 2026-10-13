'use strict';
// The offline acquisition audit, on synthetic recorded outcomes with known structure.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {teamKey}=require('./common.cjs');
const A=require('./acquisition.cjs'),O=require('./audit-acquisition-offline.cjs');
const {random}=require('../utils.cjs');

// A reproducible win/loss draw with probability p.
const draw=(p,seed)=>{const x=Math.sin(seed*12.9898)*43758.5453;return (x-Math.floor(x))<p?1:0;};
// strength[i] is team i's true win rate; fixture f of team i is an independent draw.
const sequence=(p,teamId,batch,n)=>Array.from({length:n},(_,f)=>draw(p,teamId*7919+batch*104729+f*31+1));
const strengths=Array.from({length:24},(_,i)=>.15+i*.03); // team 23 is the strongest
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pvp-audit-'));

function writeV1(directory,{batches=2,extra=true}={}){
 // Team ids 0..23 play every batch's 64 fixtures, as a retested incumbent would across rounds.
 const training={};const add=(id,list)=>{(training[id]??=[]).push(...list);};
 for(let b=0;b<batches;b++)for(let t=0;t<24;t++){const id=b*10+t;add(id,sequence(strengths[t],t,b,64).map((score,f)=>[[b,f,0],5000*b+f,score]));}
 if(extra){ // decoys: 23 teams x 64 fixtures and 24 teams x 32 fixtures are not clean batches
  for(let t=0;t<23;t++)add(1000+t,sequence(.5,t,90,64).map((score,f)=>[[90,f,0],90000+f,score]));
  for(let t=0;t<24;t++)add(2000+t,sequence(.5,t,91,32).map((score,f)=>[[91,f,0],91000+f,score]));
 }
 const ids=Object.keys(training).map(Number),chunkOf=id=>id%2,chunks={0:{},1:{}};
 for(const id of ids)chunks[chunkOf(id)][id]={training:training[id],screen:[],test:[],baseline:[]};
 fs.writeFileSync(path.join(directory,'index.json'),JSON.stringify({version:1,rows:ids.map(id=>({id,chunk:chunkOf(id)}))}));
 for(const c of [0,1])fs.writeFileSync(path.join(directory,c+'.json'),JSON.stringify(chunks[c]));
 return training;
}

// A v4-like checkpoint: per round 24 teams, 12 expanded to 64 fixtures and 12 left at the shared 8.
function v4State({rounds=3,teams=24,mix=true}={}){
 const sources=['neural','neural','neural','uncertainty','uncertainty','random','random','retest'],observations=[];
 for(let round=1;round<=rounds;round++){
  const prefix=Array.from({length:8},(_,j)=>j);
  for(let t=0;t<teams;t++){
   // The strongest 12 of each round survive, like a promotion that works.
   const survives=t>=12,count=survives?64:8,source=mix?sources[t%sources.length]:'neural';
   for(let j=0;j<(survives?64:8);j++)observations.push({team:[t,200,201],opponent:['a'+j,'b','c'],score:draw(strengths[t],t*7919+round*104729+j*31+1),seed:round*1000+j,round,source});
  }
 }
 // Round 0 (128 teams) and an irregular round (23 teams) are not 24-team batches and must be skipped.
 for(let t=0;t<128;t++)observations.push({team:[t,300,301],opponent:['z','b','c'],score:.5,seed:5,round:0,source:'initial'});
 for(let t=0;t<23;t++)for(let j=0;j<8;j++)observations.push({team:[t,400,401],opponent:['y'+j,'b','c'],score:.5,seed:9000+j,round:rounds+1,source:'neural'});
 const screenResults=Array.from({length:24},(_,t)=>({team:[t,500,501],paired:false,fixtureSeed:77,pairs:sequence(strengths[t],t,50,256),score:.5,games:256}));
 return {observations,screenResults};
}

test('published v1 per-team fixtures become exact 24x64 batches; other panel shapes are reported and skipped',()=>{
 const dir=tmp();try{
  const training=writeV1(dir),{batches,skipped,panels,sameOrderBatches}=O.loadPublishedV1(dir);
  assert.equal(batches.length,2);assert.deepEqual(skipped,{'23x64':1,'24x32':1});assert.equal(panels,4);assert.equal(sameOrderBatches,2);
  for(const [b,batch] of batches.entries()){
   assert.equal(batch.dataset,'v1');assert.equal(batch.full,64);assert.equal(batch.scores.length,24);assert.ok(batch.scores.every(row=>row.length===64&&row.every(v=>v===0||v===.5||v===1)));
   assert.deepEqual(batch.observed,Array(24).fill(64));
   // Every cell is a recorded outcome: team t's fixture f.
   const members=batch.teamIds;for(const [row,id] of members.entries()){const own=training[id].filter(x=>x[0][0]===b).map(x=>x[2]);assert.deepEqual(batch.scores[row],own);}
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a v4 checkpoint becomes one batch per 24-team round with the shared prefix first; irregular rounds are skipped',()=>{
 const {batches,skipped}=O.loadV4(v4State(),{});
 assert.equal(batches.length,3);assert.deepEqual(skipped,{'teams 128':1,'teams 23':1});
 for(const batch of batches){
  assert.equal(batch.full,64);assert.equal(batch.prefix,8);assert.equal(batch.scores.length,24);assert.equal(batch.observed.filter(n=>n===64).length,12);assert.equal(batch.observed.filter(n=>n===8).length,12);
  batch.scores.forEach((row,i)=>{const expanded=batch.observed[i]===64;assert.equal(row.filter(v=>v!==null).length,batch.observed[i]);assert.ok(row.slice(0,8).every(v=>v!==null));assert.equal(row.slice(8).every(v=>v!==null),expanded);assert.equal(row.slice(8).every(v=>v===null),!expanded);});
  assert.equal(batch.sources.length,24);
 }
 // Prefix fixtures are exactly the fixtures every team played: their per-team sum equals the recorded prefix sum.
 const state=v4State(),first=O.loadV4(state).batches[0],recorded=state.observations.filter(o=>o.round===1&&o.team[0]===23&&o.seed%1000<8).reduce((a,o)=>a+o.score,0);
 assert.equal(first.scores[first.teamIds.indexOf('23,200,201')].slice(0,8).reduce((a,b)=>a+b,0),recorded);
});

test('the sealed screening panel is cut into exact 64-fixture windows',()=>{
 const {batches,fixtures}=O.loadV4Elite(v4State());assert.equal(fixtures,256);assert.equal(batches.length,4);
 assert.ok(batches.every(b=>b.scores.length===24&&b.scores.every(row=>row.length===64)&&b.observed.every(n=>n===64)));
 assert.equal(O.loadV4Elite({screenResults:[]}).batches.length,0);
});

test('imputation keeps every recorded cell, fills the rest with legal outcomes, tracks each team, and is seeded',()=>{
 const {batches}=O.loadV4(v4State({rounds:6})),model=O.fitPriors(batches);
 assert.ok(model.priors.neural&&model.priors.random&&model.priors.retest&&model.drawRate===0);
 for(const prior of Object.values(model.priors)){assert.ok(prior.a>0&&prior.b>0&&prior.strength>=2&&prior.strength<=200);}
 const batch=batches[0],a=O.completeBatch(batch,model,random(5)),b=O.completeBatch(batch,model,random(5)),c=O.completeBatch(batch,model,random(6));
 assert.deepEqual(a,b);assert.notDeepEqual(a.scores,c.scores);
 a.scores.forEach((row,i)=>{assert.equal(row.length,64);assert.ok(row.every(v=>v===0||v===.5||v===1));batch.scores[i].forEach((v,j)=>{if(v!==null)assert.equal(row[j],v);});assert.equal(a.imputed[i],batch.observed[i]<64);});
 // A cut team that won its whole prefix is imputed higher than one that lost it.
 const pending={...batch,scores:[Array(8).fill(1).concat(Array(56).fill(null)),Array(8).fill(0).concat(Array(56).fill(null)),...batch.scores.slice(2)]};
 const mean=rows=>rows.reduce((x,y)=>x+y,0)/rows.length,hi=[],lo=[];for(let s=1;s<=60;s++){const f=O.completeBatch(pending,model,random(s));hi.push(mean(f.scores[0].slice(8)));lo.push(mean(f.scores[1].slice(8)));}
 assert.ok(mean(hi)>mean(lo)+.05,'posterior follows the prefix: '+mean(hi)+' vs '+mean(lo));
 assert.ok(Math.abs(O.beta(5,5,random(1))-.5)<.5&&O.gamma(.5,random(2))>0&&O.gamma(3,random(3))>0);
});

test('staged replay spends the arithmetic of the staged rule and fully measures the promoted teams',()=>{
 const scores=strengths.map((p,i)=>sequence(p,i,3,64)),counts=O.replayStaged(scores,{prefix:8,full:64,promoted:12});
 assert.equal(counts.reduce((a,b)=>a+b,0),24*8+12*56);assert.equal(counts.filter(n=>n===64).length,12);assert.equal(counts.filter(n=>n===8).length,12);
 for(const m of [1,5,24])assert.equal(O.replayStaged(scores,{prefix:8,full:64,promoted:m}).filter(n=>n===64).length,m);
 // Promotion is by the production rule: the teams with the best 8-fixture results.
 const first=scores.map(r=>r.slice(0,8).reduce((a,b)=>a+b,0)),best=counts.map((n,i)=>n===64?first[i]:null).filter(v=>v!==null),others=counts.map((n,i)=>n===8?first[i]:null).filter(v=>v!==null);
 assert.ok(Math.min(...best)>=Math.max(...others));
 assert.deepEqual(O.replayStaged(scores,{prefix:64,full:64,promoted:3}),Array(24).fill(64));
});

test('adaptive replay is the production rule: same counts as the resumable driver, bounded by prefix and full',async()=>{
 const scores=strengths.map((p,i)=>sequence(p,i,4,64));
 for(const [step,fraction,margin] of [[8,.5,1.28],[4,.25,1.28],[16,.125,.5],[8,.5,0]]){
  const counts=O.replayAdaptive(scores,{prefix:8,full:64,step,fraction,margin});
  assert.ok(counts.every(n=>n>=8&&n<=64));assert.ok(counts.every(n=>n===8||(n-8)%step===0||n===64));
  const pending={teams:scores.map((_,i)=>[i]),scores:{},sources:{},predictions:{},stage:'screening'};
  await A.runAdaptive(pending,{prefix:8,full:64,step,fraction,margin,evaluate:async(teams,n)=>{for(const t of teams){const own=pending.scores[teamKey(t)]??=[];for(let i=own.length;i<n;i++)own[i]=scores[t[0]][i];}return true;}});
  assert.deepEqual(pending.teams.map(t=>A.prefixScores(pending,t).length),counts,'step '+step);
 }
});

test('metrics: spend, fully measured, top-k recall, leader regret',()=>{
 const scores=[[1,1,1,1],[1,1,1,0],[1,0,0,0],[0,0,0,0]],ks=[1,2];
 let m=O.metrics(scores,[4,4,2,2],4,ks);assert.equal(m.spent,12);assert.equal(m.fullyMeasured,2);assert.deepEqual(m.recall,{1:1,2:1});assert.equal(m.stoppedAt,2);assert.equal(m.measuredRegret,0);
 m=O.metrics(scores,[2,4,4,2],4,ks);assert.deepEqual(m.recall,{1:0,2:.5});assert.equal(m.measuredRegret,.25); // the true best (mean 1) was never fully measured; the best measured is .75
 assert.ok(m.pickRegret>=0&&(m.pickTop3===0||m.pickTop3===1));
 // The leader pick uses the shrunk selection score over each team's own fixtures.
 m=O.metrics([[1,1],[1,1,1,1,1,1,1,1]],[2,8],8,[1]);assert.equal(m.pickRegret,0);
});

test('equal-spend interpolation and its inverse',()=>{
 const curve=[[100,.2],[200,.6],[300,.9],[400,.9]];
 assert.equal(O.interpolate(curve,50),.2);assert.equal(O.interpolate(curve,150),.4);assert.ok(Math.abs(O.interpolate(curve,250)-.75)<1e-12);assert.equal(O.interpolate(curve,999),.9);assert.equal(O.interpolate([],5),null);
 assert.equal(O.spendAt(curve,.2),100);assert.equal(O.spendAt(curve,.4),150);assert.ok(Math.abs(O.spendAt(curve,.75)-250)<1e-9);assert.equal(O.spendAt(curve,.95),null);
});

test('auditing a dataset reports the trade-off, the equal-spend comparison and is exactly reproducible',()=>{
 const dir=tmp();try{
  writeV1(dir,{batches:6,extra:false});const {batches}=O.loadPublishedV1(dir);assert.equal(batches.length,6);
  const options={steps:[4,8],fractions:[.25,.5],margins:[1.28,.5],replicates:1,seed:3,bootstrap:100,ks:[1,3,6,12]},one=O.auditDataset(batches,options),two=O.auditDataset(batches,options);
  assert.deepEqual(one,two);assert.equal(one.batches,6);assert.equal(one.teams,24);assert.equal(one.staged.length,24);assert.equal(one.adaptive.length,2*2*2);assert.equal(one.imputedCells,0);
  // The staged curve spends exactly 24*8+m*56 and recall never falls as more teams are promoted.
  one.staged.forEach((row,i)=>{assert.equal(row.spent,24*8+(i+1)*56);assert.equal(row.fullyMeasured,i+1);if(i)assert.ok(row.recall[3]>=one.staged[i-1].recall[3]-.15);});
  assert.equal(one.staged.at(-1).recall[3],1);
  for(const row of one.adaptive){
   assert.ok(row.spent>=24*8&&row.spent<=24*64);assert.ok(row.recall[1]>=0&&row.recall[1]<=1);assert.ok(row.deltaRecall3Interval95[0]<=row.deltaRecall3Interval95[1]);
   assert.ok(Number.isFinite(row.stagedRecall3AtSameSpend)&&Number.isFinite(row.deltaRecall3));assert.ok(/adaptive step (4|8) k=(6|12)/.test(row.policy.name));
  }
  // A smaller margin never spends more than the specified one, other settings equal.
  for(const step of [4,8])for(const k of [6,12]){const by=m=>one.adaptive.find(r=>r.policy.step===step&&r.policy.k===k&&r.policy.margin===m);assert.ok(by(.5).spent<=by(1.28).spent);}
  assert.equal(O.auditDataset([],{}),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the full audit runs on v1 and v4 inputs, records the imputation, and renders a report',()=>{
 const dir=tmp();try{
  writeV1(dir,{batches:3});const checkpoint=path.join(dir,'checkpoint.json');fs.writeFileSync(checkpoint,JSON.stringify(v4State({rounds:4})));
  const o={v1:dir,v4:checkpoint,prefix:8,full:64,steps:'8',fractions:'0.25,0.5',margins:'1.28',replicates:2,seed:11,bootstrap:50};
  const report=O.run(o);
  assert.deepEqual(Object.keys(report.datasets),['v1','v4','elite']);
  assert.equal(report.datasets.v1.batches,3);assert.equal(report.datasets.v1.imputedCells,0);
  assert.equal(report.datasets.v4.batches,4);assert.ok(Math.abs(report.datasets.v4.imputedCells-.4375)<1e-9);assert.ok(report.datasets.v4.imputation.priors.neural);
  assert.equal(report.datasets.elite.batches,4);assert.equal(report.datasets.elite.imputedCells,0);
  const exact=report.datasets.v4.firstDecisionExact;assert.equal(exact.batches,4);assert.equal(exact.staged.continued,12);assert.ok(exact['adaptive k=6'].continued>=1&&exact['adaptive k=6'].keptTop3>=0);
  const again=O.run(o);delete report.generated;delete again.generated;assert.deepEqual(report,again);
  const text=O.markdown(report);for(const part of ['### v1','### v4','### elite','staged m=12','adaptive step 8 k=12','Spend saved'])assert.ok(text.includes(part),part);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('barrier idle time is reconstructed from the final counts: one barrier per level',()=>{
 assert.deepEqual(O.stageJobs([8,8,64,64],{prefix:8,step:56,full:64}),[32,112]);        // staged: prefix, then the promoted teams
 assert.deepEqual(O.stageJobs([8,16,24,24],{prefix:8,step:8,full:24}),[32,24,16]);      // adaptive: 3 teams reach 16, 2 reach 24
 assert.deepEqual(O.stageJobs([10,10],{prefix:10,step:4,full:10}),[20]);                 // nothing to extend
 assert.ok(Math.abs(O.idleShare([32,112],12)-(1-144/156))<1e-12);assert.equal(O.idleShare([24,48],12),0);assert.ok(O.idleShare([1],12)>.9);
 const scores=strengths.map((p,i)=>sequence(p,i,5,64)),counts=O.replayStaged(scores,{prefix:8,full:64,promoted:12}),m=O.metrics(scores,counts,64,[1],{prefix:8,step:56});
 assert.ok(Math.abs(m.idle12-(1-864/(12*(Math.ceil(192/12)+Math.ceil(672/12)))))<1e-12);assert.equal(O.metrics(scores,counts,64,[1]).idle12,null);
});
