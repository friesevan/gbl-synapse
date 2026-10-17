#!/usr/bin/env node
'use strict';
// Offline replay of acquisition policies on recorded battle outcomes. It never simulates a battle
// and never writes into a run directory. Each reconstructed batch is the set of teams that played
// one round's opponent fixtures; a policy decides, from the scores it has seen so far, which
// teams get more fixtures. We measure battles spent per batch and how often the teams that are
// truly best (by their full-length mean) end up fully measured.
//
// Three data sources:
//   v1   the published v1 per-team fixtures (web/includes/pro/data/team-teams): 24-team batches in
//        which every team has all 64 fixtures. Exact: no value is invented.
//   v4   a completed v4 checkpoint: one batch per round. The staged run fully measured only the 12
//        promoted teams (64 fixtures); the other 12 have the shared 8-fixture prefix. The missing
//        fixtures are filled by a stated posterior-predictive model (see completeBatch), so these
//        results are model-based for 43.75% of the cells.
//   elite  the v4 run's sealed screening panel (24 training leaders x 512 fixtures), cut into
//        windows of 64 fixtures: a hard, homogeneous regime. Exact.
//
// Every decision uses the production functions of acquisition.cjs (promoteCandidates,
// adaptiveNext, pessimisticScore), with the ensemble-spread term at 0 because the checkpoints do
// not keep per-round predictions.
const fs=require('node:fs'),path=require('node:path');
const {teamKey,options,atomic}=require('./common.cjs');const {random}=require('../utils.cjs');
const A=require('./acquisition.cjs');

// ---------- data: reconstruct batches ----------
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
function finiteScores(row){return row.every(value=>Number.isFinite(value)&&value>=0&&value<=1);}

// The published v1 export lists, per team, every training fixture as [opponent, seed, score].
// Fixtures that exactly the same set of teams played form one panel; a panel of 24 teams and 64
// fixtures is one clean batch. Retested teams appear in several panels and are handled naturally.
function loadPublishedV1(directory,{teams=24,fixtures=64}={}){
 const index=JSON.parse(fs.readFileSync(path.join(directory,'index.json'))),training=new Map();
 for(const chunk of new Set(index.rows.map(row=>row.chunk))){
  const rows=JSON.parse(fs.readFileSync(path.join(directory,chunk+'.json')));
  for(const [id,value] of Object.entries(rows))training.set(Number(id),value.training||[]);
 }
 const key=f=>f[0].join(',')+'|'+f[1],played=new Map(),own=new Map();
 for(const [id,list] of training){const map=new Map();for(const f of list){map.set(key(f),f[2]);if(!played.has(key(f)))played.set(key(f),[]);played.get(key(f)).push(id);}own.set(id,{map,order:list.map(key)});}
 const panels=new Map();
 for(const [fixture,ids] of played){const id=ids.slice().sort((a,b)=>a-b).join(',');if(!panels.has(id))panels.set(id,[]);panels.get(id).push(fixture);}
 const batches=[],skipped={};let ordered=0;
 for(const [id,keys] of panels){
  const members=id.split(',').map(Number);
  if(members.length!==teams||keys.length!==fixtures){const shape=members.length+'x'+keys.length;skipped[shape]=(skipped[shape]||0)+1;continue;}
  const wanted=new Set(keys),order=own.get(members[0]).order.filter(k=>wanted.has(k));
  const scores=members.map(member=>order.map(k=>own.get(member).map.get(k)));
  if(!scores.every(finiteScores))continue;
  if(members.every(member=>own.get(member).order.filter(k=>wanted.has(k)).every((k,i)=>k===order[i])))ordered++;
  batches.push({dataset:'v1',id:'v1-'+batches.length,full:fixtures,teamIds:members,scores,observed:members.map(()=>fixtures),sources:null});
 }
 return {batches,skipped,sameOrderBatches:ordered,panels:panels.size};
}

// A completed v4 checkpoint: one batch per round. Teams that played more than the shared prefix
// were fully expanded; the rest carry only the prefix (their later cells are null here).
function loadV4(checkpoint,{teams=24,prefix=8,full=64}={}){
 const state=typeof checkpoint==='string'?JSON.parse(fs.readFileSync(checkpoint)):checkpoint,{opponentFixtureKey}=A;
 const rounds=new Map();
 for(const o of state.observations){
  if(!Number.isInteger(o.round))continue;
  if(!rounds.has(o.round))rounds.set(o.round,new Map());
  const byTeam=rounds.get(o.round),k=teamKey(o.team);
  if(!byTeam.has(k))byTeam.set(k,{team:o.team,source:o.source||'initial',rows:[]});
  byTeam.get(k).rows.push({key:opponentFixtureKey(o.opponent,o.seed),score:o.score});
 }
 const batches=[],skipped={};
 for(const [round,byTeam] of [...rounds].sort((a,b)=>a[0]-b[0])){
  const members=[...byTeam.values()],counts=members.map(m=>m.rows.length),reject=why=>{skipped[why]=(skipped[why]||0)+1;};
  if(members.length!==teams){reject('teams '+members.length);continue;}
  if(!counts.every(n=>n===prefix||n===full)){reject('uneven counts');continue;}
  const sets=members.map(m=>new Set(m.rows.map(r=>r.key))),shared=[...sets[0]].filter(k=>sets.every(s=>s.has(k)));
  const survivors=members.filter(m=>m.rows.length===full);
  if(!survivors.length||shared.length!==prefix){reject('no common prefix');continue;}
  const everything=new Set(survivors.flatMap(m=>m.rows.map(r=>r.key)));
  if(everything.size!==full||!survivors.every(m=>m.rows.every(r=>everything.has(r.key)))){reject('survivors disagree');continue;}
  // The prefix first (it is the common panel every team played), then the rest in a fixed order.
  // Fixtures are i.i.d. draws from the meta, so the order beyond the prefix carries no information.
  const order=[...shared.sort(),...[...everything].filter(k=>!shared.includes(k)).sort()];
  const scores=members.map(m=>{const map=new Map(m.rows.map(r=>[r.key,r.score]));return order.map(k=>map.has(k)?map.get(k):null);});
  batches.push({dataset:'v4',id:'v4-round-'+round,full,prefix,teamIds:members.map(m=>teamKey(m.team)),scores,observed:counts,sources:members.map(m=>m.source)});
 }
 return {batches,skipped,rounds:rounds.size};
}
// The sealed screening panel: every team has the same 512 fixtures, so each window of 64 is an exact batch.
function loadV4Elite(checkpoint,{full=64}={}){
 const state=typeof checkpoint==='string'?JSON.parse(fs.readFileSync(checkpoint)):checkpoint,rows=(state.screenResults||[]).filter(r=>Array.isArray(r.pairs)&&r.paired===false);
 if(rows.length<2||!rows.every(r=>r.fixtureSeed===rows[0].fixtureSeed&&r.pairs.length===rows[0].pairs.length))return {batches:[],note:'no common sealed screening panel'};
 const windows=Math.floor(rows[0].pairs.length/full),batches=[];
 for(let w=0;w<windows;w++)batches.push({dataset:'elite',id:'elite-window-'+w,full,teamIds:rows.map(r=>teamKey(r.team)),scores:rows.map(r=>r.pairs.slice(w*full,(w+1)*full)),observed:rows.map(()=>full),sources:null});
 return {batches,fixtures:rows[0].pairs.length};
}

// ---------- imputation for the cells a staged run never played ----------
function gaussian(r){let u=0;while(u===0)u=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*r());}
function gamma(shape,r){ // Marsaglia and Tsang
 if(shape<1)return gamma(shape+1,r)*Math.pow(r()||1e-12,1/shape);
 const d=shape-1/3,c=1/Math.sqrt(9*d);
 for(;;){let x,v;do{x=gaussian(r);v=1+c*x;}while(v<=0);v=v*v*v;const u=r();if(u<1-.0331*x**4||Math.log(u)<.5*x*x+d*(1-v+Math.log(v)))return d*v;}
}
const beta=(a,b,r)=>{const x=gamma(a,r),y=gamma(b,r);return x/(x+y);};
// Opponent difficulty is shared: in the v4 run the survivors' per-fixture means have about three
// times the variance independent battles would give, so fixture effects are estimated per round from the
// recorded cells (additive team + fixture model; the 8 prefix fixtures from all 24 teams, the
// later ones from the survivors) and shrunk by their estimated reliability.
function fixtureEffects(batch){
 const rows=batch.scores,teamMean=rows.map(row=>mean(row.filter(v=>v!==null))),overall=mean(teamMean),noise=Math.max(.05,overall*(1-overall));
 const raw=Array.from({length:batch.full},(_,j)=>{const cells=rows.map((row,i)=>row[j]===null?null:row[j]-teamMean[i]).filter(v=>v!==null);return {value:mean(cells),n:cells.length};});
 const centre=mean(raw.map(f=>f.value)),observed=mean(raw.map(f=>(f.value-centre)**2)),sampling=mean(raw.map(f=>noise/f.n)),tau2=Math.max(observed-sampling,0);
 return raw.map(f=>tau2/(tau2+noise/f.n)*(f.value-centre));
}
// Per-source Beta prior for a team's true mean, fitted from the shared prefix, which every team
// played and which is therefore not selected: moment matching on prefix means adjusted for fixture
// difficulty, with the within-team sampling variance removed. Posterior-predictive completion treats
// a team's later fixtures as draws from its own posterior, shifted by each fixture's estimated
// difficulty. It assumes teams of one source share a prior; the fit finds it fairly tight for neural
// proposals (between-team sd about 7 points), so their ranking within a round is largely sampling noise.
function fitPriors(batches){
 const groups=new Map();let draws=0,cells=0;
 for(const batch of batches){
  const prefix=batch.prefix,effects=batch.effects||(batch.effects=fixtureEffects(batch));
  batch.scores.forEach((row,i)=>{
   const head=row.slice(0,prefix).map((v,j)=>v-effects[j]),source=batch.sources?.[i]||'unknown';
   if(!groups.has(source))groups.set(source,[]);groups.get(source).push(head);
   for(const value of row)if(value!==null){cells++;if(value===.5)draws++;}
  });
 }
 const priors={};
 for(const [source,heads] of groups){
  const n=heads[0].length,means=heads.map(mean),mu=Math.min(.98,Math.max(.02,mean(means))),total=mean(means.map(m=>(m-mean(means))**2)),within=mean(heads.map(h=>{const m=mean(h);return h.reduce((s,v)=>s+(v-m)**2,0)/(n-1);}))/n;
  const between=Math.max(total-within,1e-4),k=Math.min(200,Math.max(2,mu*(1-mu)/between-1));
  priors[source]={teams:heads.length,prefixMean:mu,betweenVariance:between,a:mu*k,b:(1-mu)*k,strength:k};
 }
 return {priors,drawRate:cells?draws/cells:0};
}
const clip01=v=>Math.min(1,Math.max(0,v));
function completeBatch(batch,model,r){
 const prefix=batch.prefix,effects=batch.effects||(batch.effects=fixtureEffects(batch)),imputed=[];
 const scores=batch.scores.map((row,i)=>{
  if(row.every(v=>v!==null)){imputed.push(false);return row;}
  const prior=model.priors[batch.sources?.[i]]||model.priors.unknown||Object.values(model.priors)[0],head=row.slice(0,prefix),wins=head.reduce((a,v,j)=>a+clip01(v-effects[j]),0);
  const p=beta(prior.a+wins,prior.b+head.length-wins,r),d=model.drawRate;
  imputed.push(true);
  return row.map((v,j)=>{if(v!==null)return v;const win=Math.min(1-d,Math.max(0,clip01(p+effects[j])-d/2)),u=r();return u<win?1:u<win+d?.5:0;});
 });
 return {scores,imputed};
}

// ---------- policies, replayed with the production decision functions ----------
const pendingFor=scores=>({teams:scores.map((_,i)=>[i]),scores:{},sources:{},predictions:{},stage:'screening'});
function fill(pending,scores,teams,n){for(const team of teams){const own=pending.scores[teamKey(team)]??=[];for(let i=own.length;i<n;i++)own[i]=scores[team[0]][i];}}
const countsOf=(pending)=>pending.teams.map(team=>A.prefixScores(pending,team).length);
// Fixed prefix, then the top `promoted` teams to the full count (promoteCandidates).
function replayStaged(scores,{prefix,full,promoted}){
 const p=pendingFor(scores);fill(p,scores,p.teams,prefix);
 const chosen=prefix>=full?p.teams:A.promoteCandidates(p,{fixtures:prefix,fraction:(promoted-.5)/p.teams.length});
 fill(p,scores,chosen,full);return countsOf(p);
}
// Common prefix, then `step` fixtures at a time for the teams that can still be among the best k.
function replayAdaptive(scores,{prefix,full,step,fraction,margin=A.DEFAULT_MARGIN}){
 const p=pendingFor(scores);fill(p,scores,p.teams,prefix);let active=p.teams,level=prefix;
 for(;;){const next=A.adaptiveNext(p,{active,level,step,full,fraction,margin});if(!next)break;fill(p,scores,next.active,next.level);active=next.active;level=next.level;}
 return countsOf(p);
}
// Battles dispatched per synchronisation barrier (the common prefix, then each extension level) and the
// share of worker time lost to those barriers, assuming equal battle times: a barrier leaves workers idle
// whenever a level's job count is not a multiple of the worker count. Reconstructed from final counts.
function stageJobs(counts,{prefix,step,full}){
 const jobs=[counts.length*prefix];let previous=prefix;
 while(previous<full){const level=Math.min(previous+step,full),active=counts.filter(n=>n>=level).length;if(!active)break;jobs.push(active*(level-previous));previous=level;}
 return jobs;
}
function idleShare(jobs,workers){return 1-jobs.reduce((a,b)=>a+b,0)/jobs.reduce((total,j)=>total+Math.ceil(j/workers)*workers,0);}
function metrics(scores,counts,full,ks,stages=null){
 const means=scores.map(row=>mean(row.slice(0,full))),order=means.map((_,i)=>i).sort((a,b)=>means[b]-means[a]||a-b),measured=counts.map(n=>n>=full);
 const recall=Object.fromEntries(ks.map(k=>{const top=order.slice(0,k);return [k,top.filter(i=>measured[i]).length/k];}));
 // The training leader is the team with the best selection score over the fixtures it actually has.
 const selection=counts.map((n,i)=>A.pessimisticScore(scores[i].slice(0,n))),pick=selection.reduce((best,v,i)=>v>selection[best]?i:best,0),best=means[order[0]];
 const bestMeasured=Math.max(...means.filter((_,i)=>measured[i]));
 return {spent:counts.reduce((a,b)=>a+b,0),fullyMeasured:measured.filter(Boolean).length,recall,allTop3:ks.includes(3)&&order.slice(0,3).every(i=>measured[i])?1:0,
  measuredRegret:Number.isFinite(bestMeasured)?best-bestMeasured:best-Math.min(...means),pickRegret:best-means[pick],pickTop3:order.slice(0,3).includes(pick)?1:0,
  stoppedAt:counts.filter(n=>n<full).length,idle12:stages?idleShare(stageJobs(counts,{...stages,full}),12):null};
}

// ---------- aggregation, equal-spend comparison ----------
const sum=a=>a.reduce((x,y)=>x+y,0);
function standardError(values){if(values.length<2)return null;const m=mean(values);return Math.sqrt(sum(values.map(v=>(v-m)**2))/(values.length-1)/values.length);}
function summarizeRows(rows,ks){ // rows: one metrics object per batch (already averaged over replicates)
 const field=f=>rows.map(f),out={batches:rows.length,idle12:mean(field(r=>r.idle12??0)),spent:mean(field(r=>r.spent)),spentSE:standardError(field(r=>r.spent)),fullyMeasured:mean(field(r=>r.fullyMeasured)),stoppedAt:mean(field(r=>r.stoppedAt)),
  allTop3:mean(field(r=>r.allTop3)),measuredRegret:mean(field(r=>r.measuredRegret)),pickRegret:mean(field(r=>r.pickRegret)),pickTop3:mean(field(r=>r.pickTop3)),recall:{},recallSE:{}};
 for(const k of ks){out.recall[k]=mean(field(r=>r.recall[k]));out.recallSE[k]=standardError(field(r=>r.recall[k]));}
 return out;
}
function averageRows(list,ks){ // average the metrics of several replicates of one batch
 return {idle12:mean(list.map(r=>r.idle12??0)),spent:mean(list.map(r=>r.spent)),fullyMeasured:mean(list.map(r=>r.fullyMeasured)),stoppedAt:mean(list.map(r=>r.stoppedAt)),allTop3:mean(list.map(r=>r.allTop3)),measuredRegret:mean(list.map(r=>r.measuredRegret)),pickRegret:mean(list.map(r=>r.pickRegret)),pickTop3:mean(list.map(r=>r.pickTop3)),
  recall:Object.fromEntries(ks.map(k=>[k,mean(list.map(r=>r.recall[k]))])),truthImputed:mean(list.map(r=>r.truthImputed||0))};
}
// Linear interpolation on a monotone-in-spend curve of [spent, value] points.
function interpolate(points,x){
 if(!points.length)return null;if(x<=points[0][0])return points[0][1];
 for(let i=1;i<points.length;i++)if(x<=points[i][0]){const [x0,y0]=points[i-1],[x1,y1]=points[i];return x1===x0?y1:y0+(y1-y0)*(x-x0)/(x1-x0);}
 return points.at(-1)[1];
}
// The smallest spend at which the curve reaches `target` (linear between points), or null if it never does.
function spendAt(points,target){
 if(!points.length)return null;if(points[0][1]>=target)return points[0][0];
 for(let i=1;i<points.length;i++)if(points[i][1]>=target){const [x0,y0]=points[i-1],[x1,y1]=points[i];return y1===y0?x1:x0+(x1-x0)*(target-y0)/(y1-y0);}
 return null;
}
function bootstrapDelta(adaptive,staged,k,{samples=1000,seed=1}={}){
 // adaptive: per-batch {spent,recall}; staged: array over promoted counts of per-batch {spent,recall}. Resample whole batches.
 const n=adaptive.length,r=random(seed),deltas=[];
 for(let s=0;s<samples;s++){
  const idx=Array.from({length:n},()=>Math.floor(r()*n));
  const spent=mean(idx.map(i=>adaptive[i].spent)),got=mean(idx.map(i=>adaptive[i].recall[k]));
  const curve=staged.map(rows=>[mean(idx.map(i=>rows[i].spent)),mean(idx.map(i=>rows[i].recall[k]))]);
  deltas.push(got-interpolate(curve,spent));
 }
 deltas.sort((a,b)=>a-b);return [deltas[Math.floor(samples*.025)],deltas[Math.ceil(samples*.975)-1]];
}

// ---------- the audit ----------
function auditDataset(batches,{prefix=8,steps=[4,8,16],fractions=[.125,.25,.375,.5],margins=[A.DEFAULT_MARGIN],replicates=20,seed=1,ks=[1,3,6,12],model=null,bootstrap=1000}={}){
 if(!batches.length)return null;
 const full=batches[0].full,teams=batches[0].scores.length,stagedCounts=Array.from({length:teams},(_,i)=>i+1);
 const adaptivePolicies=steps.flatMap(step=>fractions.flatMap(fraction=>margins.map(margin=>({name:'adaptive step '+step+' k='+Math.ceil(teams*fraction)+(margin===A.DEFAULT_MARGIN?'':' margin '+margin),kind:'adaptive',step,fraction,margin,k:Math.ceil(teams*fraction)}))));
 const policies=[...stagedCounts.map(m=>({name:'staged m='+m,kind:'staged',promoted:m})),...adaptivePolicies];
 const perBatch=policies.map(()=>[]);
 batches.forEach((batch,bi)=>{
  const needsImputation=batch.scores.some(row=>row.some(v=>v===null)),runs=needsImputation?replicates:1,reps=policies.map(()=>[]);
  for(let rep=0;rep<runs;rep++){
   const filled=needsImputation?completeBatch(batch,model,random((seed*1000003+bi*7919+rep*104729)>>>0)):{scores:batch.scores,imputed:batch.scores.map(()=>false)};
   // True top-3 membership of imputed (never observed) teams, a diagnostic of how model-based the truth is.
   const means=filled.scores.map(mean),top=means.map((_,i)=>i).sort((a,b)=>means[b]-means[a]||a-b).slice(0,3),truthImputed=top.filter(i=>filled.imputed[i]).length/3;
   policies.forEach((policy,pi)=>{
    const counts=policy.kind==='staged'?replayStaged(filled.scores,{prefix,full,promoted:policy.promoted}):replayAdaptive(filled.scores,{prefix,full,step:policy.step,fraction:policy.fraction,margin:policy.margin});
    reps[pi].push({...metrics(filled.scores,counts,full,ks,{prefix,step:policy.kind==='staged'?full-prefix:policy.step}),truthImputed});
   });
  }
  reps.forEach((list,pi)=>perBatch[pi].push(averageRows(list,ks)));
 });
 const stagedRows=perBatch.slice(0,teams),stagedSummary=stagedRows.map((rows,i)=>({policy:policies[i],...summarizeRows(rows,ks),truthImputed:mean(rows.map(r=>r.truthImputed))}));
 const stagedCurve=k=>stagedSummary.map(row=>[row.spent,row.recall[k]]);
 const adaptiveSummary=adaptivePolicies.map((policy,i)=>{
  const rows=perBatch[teams+i],summary=summarizeRows(rows,ks),k=3,curve=stagedCurve(k),equalSpend=interpolate(curve,summary.spent),equalRecall=spendAt(curve,summary.recall[k]);
  return {policy,...summary,truthImputed:mean(rows.map(r=>r.truthImputed)),
   stagedRecall3AtSameSpend:equalSpend,deltaRecall3:summary.recall[k]-equalSpend,
   deltaRecall3Interval95:bootstrap?bootstrapDelta(rows,stagedRows,k,{samples:bootstrap,seed:seed+7}):null,
   stagedSpendAtSameRecall3:equalRecall,spendSavingAtSameRecall3:equalRecall?1-summary.spent/equalRecall:null};
 });
 return {batches:batches.length,teams,full,prefix,imputedCells:imputedShare(batches),ks,staged:stagedSummary,adaptive:adaptiveSummary};
}
function imputedShare(batches){let nulls=0,cells=0;for(const b of batches)for(const row of b.scores)for(const v of row){cells++;if(v===null)nulls++;}return cells?nulls/cells:0;}
// Imputation-free: the decision after the shared prefix uses recorded data only. Of the recorded
// fully expanded teams (the survivors), how many of the best three does each rule keep going?
function firstDecision(batches,{prefix=8,fractions=[.25,.5]}={}){
 const rows=[];
 for(const batch of batches){
  const full=batch.full,survivors=batch.scores.map((row,i)=>row.every(v=>v!==null)?i:-1).filter(i=>i>=0);if(survivors.length<3)continue;
  const means=Object.fromEntries(survivors.map(i=>[i,mean(batch.scores[i])])),top=survivors.slice().sort((a,b)=>means[b]-means[a]||a-b).slice(0,3);
  const p=pendingFor(batch.scores);fill(p,batch.scores,p.teams,prefix);
  const entry={staged:{}};
  const promoted=new Set(A.promoteCandidates(p,{fixtures:prefix,fraction:.5}).map(teamKey));entry.staged={kept:top.filter(i=>promoted.has(String(i))).length/3,continued:promoted.size};
  for(const fraction of fractions){const next=A.adaptiveNext(p,{level:prefix,step:8,full,fraction}),live=new Set((next?.active||[]).map(teamKey));entry[fraction]={kept:top.filter(i=>live.has(String(i))).length/3,continued:live.size};}
  rows.push(entry);
 }
 if(!rows.length)return null;
 const fieldsOf=key=>({keptTop3:mean(rows.map(r=>r[key].kept)),continued:mean(rows.map(r=>r[key].continued))});
 return {batches:rows.length,prefix,staged:fieldsOf('staged'),...Object.fromEntries(fractions.map(f=>['adaptive k='+Math.ceil(24*f),fieldsOf(f)]))};
}

function run(o){
 const list=text=>String(text).split(',').map(Number).filter(Number.isFinite),report={generated:new Date().toISOString(),settings:{prefix:o.prefix,full:o.full,steps:list(o.steps),fractions:list(o.fractions),margins:list(o.margins),replicates:o.replicates,seed:o.seed,bootstrap:o.bootstrap},datasets:{},notes:[
  'Offline replay on recorded outcomes; no battle was simulated. Policy decisions use the production functions of acquisition.cjs.',
  'Model-uncertainty bonus is 0 in every replay (per-round predictions are not stored), so replayed staged promotion can differ from the promotion the run actually made.',
  'Fully measured means the team reached the full fixture count. Truth is each team\'s mean over the full count; recall@k is the share of the true top k that ended fully measured.']};
 const settings={prefix:o.prefix,steps:list(o.steps),fractions:list(o.fractions),margins:list(o.margins),replicates:o.replicates,seed:o.seed,bootstrap:o.bootstrap};
 if(o.v1){const v1=loadPublishedV1(path.resolve(o.v1),{teams:24,fixtures:o.full});report.datasets.v1={source:'published v1 per-team fixtures (exact, no imputation)',skippedPanels:v1.skipped,sameFixtureOrder:v1.sameOrderBatches+' of '+v1.batches.length,...auditDataset(v1.batches,settings)};}
 if(o.v4){
  const state=JSON.parse(fs.readFileSync(path.resolve(o.v4))),rounds=loadV4(state,{teams:24,prefix:o.prefix,full:o.full}),model=fitPriors(rounds.batches);
  report.datasets.v4={source:'completed v4 checkpoint rounds; fixtures the staged run never played are imputed',skippedRounds:rounds.skipped,imputation:model,firstDecisionExact:firstDecision(rounds.batches,{prefix:o.prefix,fractions:[.25,.5]}),...auditDataset(rounds.batches,{...settings,model})};
  const elite=loadV4Elite(state,{full:o.full});if(elite.batches.length)report.datasets.elite={source:'v4 sealed screening panel, windows of '+o.full+' fixtures (exact, 24 training leaders)',panelFixtures:elite.fixtures,...auditDataset(elite.batches,{...settings,bootstrap:o.bootstrap})};
 }
 return report;
}
const pct=v=>v===null||v===undefined?'-':(100*v).toFixed(1)+'%',num=v=>v===null||v===undefined?'-':v.toFixed(1);
function markdown(report){
 const lines=[];
 for(const [name,data] of Object.entries(report.datasets)){
  if(!data)continue;
  lines.push('### '+name+' · '+data.batches+' batches of '+data.teams+' teams · '+data.full+' fixtures · prefix '+data.prefix+(data.imputedCells?' · '+pct(data.imputedCells)+' of cells imputed':''),'');
  lines.push('| Policy | Battles / batch | Fully measured | Recall@1 | Recall@3 | All top 3 | Recall@6 | Recall@12 | Leader regret (pts) | Barrier idle, 12 workers |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const show=data.staged.filter(r=>[3,6,9,12,15,18,24].includes(r.policy.promoted));
  const row=r=>'| '+r.policy.name+' | '+num(r.spent)+' | '+num(r.fullyMeasured)+' | '+pct(r.recall[1])+' | '+pct(r.recall[3])+' | '+pct(r.allTop3)+' | '+pct(r.recall[6])+' | '+pct(r.recall[12])+' | '+(100*r.pickRegret).toFixed(2)+' | '+pct(r.idle12)+' |';
  for(const r of show)lines.push(row(r));for(const r of data.adaptive)lines.push(row(r));
  lines.push('','Adaptive against the staged curve at the same spend (recall@3):','','| Adaptive policy | Battles | Recall@3 | Staged at same spend | Difference (95% interval) | Staged spend for same recall | Spend saved |','| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const r of data.adaptive)lines.push('| '+r.policy.name+' | '+num(r.spent)+' | '+pct(r.recall[3])+' | '+pct(r.stagedRecall3AtSameSpend)+' | '+(100*r.deltaRecall3).toFixed(1)+' ('+(r.deltaRecall3Interval95?r.deltaRecall3Interval95.map(v=>(100*v).toFixed(1)).join(' to '):'-')+') | '+num(r.stagedSpendAtSameRecall3)+' | '+pct(r.spendSavingAtSameRecall3)+' |');
  lines.push('');
 }
 return lines.join('\n');
}
if(require.main===module){
 const o=options(process.argv.slice(2),{v1:path.resolve(__dirname,'../../includes/pro/data/team-teams'),v4:'',out:'',markdown:'',prefix:8,full:64,steps:'4,8,16',fractions:'0.125,0.25,0.375,0.5',margins:'1.28',replicates:20,seed:20261013,bootstrap:1000});
 if(o.help){console.log('node training/team-search/audit-acquisition-offline.cjs [--v1 TEAM_TEAMS_DIR] [--v4 CHECKPOINT] [--prefix 8] [--full 64] [--steps 4,8,16] [--fractions 0.125,0.25,0.375,0.5] [--margins 1.28] [--replicates 20] [--seed N] [--bootstrap 1000] [--out FILE] [--markdown FILE]');process.exit(0);}
 const report=run(o),text=markdown(report);console.log(text);
 if(o.out)atomic(path.resolve(o.out),report);if(o.markdown)fs.writeFileSync(path.resolve(o.markdown),text+'\n');
}
module.exports={stageJobs,idleShare,loadPublishedV1,loadV4,loadV4Elite,fixtureEffects,fitPriors,completeBatch,replayStaged,replayAdaptive,metrics,interpolate,spendAt,auditDataset,firstDecision,run,markdown,beta,gamma};
