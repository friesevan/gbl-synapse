'use strict';
// Adaptive prefix length (--acquisition adaptive): the decision rule, its resumable driver,
// and the guarantees the search relies on. The battle-level behaviour (dispatch order,
// interruption and resume against the real search loop) is in search-acquisition.test.cjs.
const test=require('node:test'),assert=require('node:assert/strict');
const {teamKey}=require('./common.cjs');
const {DEFAULT_MARGIN,pessimisticScore,promotionPriority,adaptiveContinuation,adaptiveNext,runAdaptive,prefixScores,adaptiveLabeled}=require('./acquisition.cjs');

const rows=n=>Array.from({length:n},(_,i)=>[i,100,101]);
const constant=(value,n=64)=>Array(n).fill(value);
// Deterministic pseudo-random win/loss sequence with win rate `base`.
const jitter=(base,n=64,seed=1)=>Array.from({length:n},(_,i)=>{const x=Math.sin(seed*997+i*131)*10000;return (x-Math.floor(x))<base?1:0;});
// A recorded-outcome evaluator: copies fixtures [have, n) of each team from its full sequence,
// the way the offline audit does and the way the search plays missing battles.
function replayer(pending,matrix,{stopAfter=Infinity}={}){
 let calls=0,spent=0;
 const evaluate=async(teams,n)=>{
  if(++calls>stopAfter){
   // A stop mid-level: half the teams got their new fixtures, with a hole just before the end,
   // as when workers finish out of order and the process is stopped.
   for(const t of teams.slice(0,Math.ceil(teams.length/2))){const own=pending.scores[teamKey(t)]??=[],source=matrix[t[0]];for(let i=0;i<n;i++)if(i!==n-2&&!Number.isFinite(own[i])){own[i]=source[i];spent++;}}
   return false;
  }
  for(const t of teams){const own=pending.scores[teamKey(t)]??=[],source=matrix[t[0]];for(let i=0;i<n;i++)if(!Number.isFinite(own[i])){own[i]=source[i];spent++;}}
  return true;
 };
 return {evaluate,get spent(){return spent;},get calls(){return calls;}};
}
const fresh=matrix=>{const team=rows(matrix.length);return {team,pending:{teams:team,scores:{},sources:{},predictions:{},stage:'screening'}};};

test('the pessimistic score mirrors the optimistic one: same shrinkage, narrower with more fixtures',()=>{
 const few=pessimisticScore([1,1,1,1,0,0,0,0]),many=pessimisticScore([...Array(32).fill(1),...Array(32).fill(0)]);
 assert.ok(few<.5&&many<.5&&many>few);
 assert.ok(promotionPriority([1,1,0,0])>.5&&pessimisticScore([1,1,0,0])<.5);
 assert.ok(pessimisticScore(Array(8).fill(1))<.7); // eight pseudo-fixtures pull a perfect eight far below 1
 assert.throws(()=>pessimisticScore([]),/finite/);assert.throws(()=>pessimisticScore([2]),/finite/);
});

test('prefixScores stops at the first hole, so a half-dispatched level is never read as complete',()=>{
 const pending={scores:{'0':[1,0,.5,undefined,1]}};
 assert.deepEqual(prefixScores(pending,[0]),[1,0,.5]);assert.deepEqual(prefixScores({scores:{}},[0]),[]);
 assert.deepEqual(prefixScores({scores:{'0':[null,1]}},[0]),[]);
});

test('continuation stops the clearly beaten, keeps contenders, and never stops the leaders',()=>{
 const team=rows(6),pending={teams:team,scores:{},predictions:{}};
 team.forEach((t,i)=>pending.scores[teamKey(t)]=Array(8).fill(i<3?1:0));
 const decision=adaptiveContinuation(pending,{full:64,fraction:.5});
 assert.equal(decision.k,3);assert.deepEqual(decision.extend,team.slice(0,3));assert.ok(Number.isFinite(decision.threshold));
 // Identical teams cannot be separated: every one continues.
 team.forEach(t=>pending.scores[teamKey(t)]=[1,0,1,0,1,0,1,0]);
 assert.equal(adaptiveContinuation(pending,{full:64,fraction:.5}).extend.length,6);
 // The k best by pessimistic score always continue, however the rest look.
 team.forEach((t,i)=>pending.scores[teamKey(t)]=jitter(.2+i*.12,12,i+3));
 const result=adaptiveContinuation(pending,{full:64,fraction:.5}),leaders=team.slice().sort((a,b)=>pessimisticScore(pending.scores[teamKey(b)])-pessimisticScore(pending.scores[teamKey(a)])).slice(0,3);
 for(const t of leaders)assert.ok(result.extend.some(x=>teamKey(x)===teamKey(t)));
 // A candidate that reached the full count is never extended; the live set restricts the answer.
 pending.scores[teamKey(team[0])]=constant(1,64);assert.ok(!adaptiveContinuation(pending,{full:64}).extend.some(t=>teamKey(t)===teamKey(team[0])));
 assert.ok(adaptiveContinuation(pending,{full:64,active:[team[5]]}).extend.every(t=>teamKey(t)===teamKey(team[5])));
 assert.throws(()=>adaptiveContinuation(pending,{full:64,fraction:0}),/fraction/);assert.throws(()=>adaptiveContinuation(pending,{full:0}),/full/);
 assert.throws(()=>adaptiveNext(pending,{level:8,step:0,full:64}),/step/);
});

test('a fraction of 1 keeps every candidate alive: adaptive reduces to full allocation',()=>{
 const team=rows(5),pending={teams:team,scores:{},predictions:{}};
 team.forEach((t,i)=>pending.scores[teamKey(t)]=Array(8).fill(i%2));
 assert.equal(adaptiveContinuation(pending,{full:64,fraction:1}).extend.length,5);
});

test('a model uncertainty bonus keeps an uncertain candidate alive that results alone would stop',()=>{
 const team=rows(4),pending={teams:team,scores:{},predictions:{}};
 team.forEach((t,i)=>pending.scores[teamKey(t)]=Array(8).fill(i<2?1:0));
 assert.ok(!adaptiveContinuation(pending,{full:64}).extend.some(t=>teamKey(t)===teamKey(team[3])));
 pending.predictions[teamKey(team[3])]={uncertainty:.5};
 assert.ok(adaptiveContinuation(pending,{full:64}).extend.some(t=>teamKey(t)===teamKey(team[3])));
});

test('the round runs level by level, caps at the full count and records its levels',async()=>{
 const matrix=[constant(.9),constant(.85),constant(.8),constant(.1),constant(.05),constant(0),jitter(.5,64,5),jitter(.45,64,6)];
 const {team,pending}=fresh(matrix),play=replayer(pending,matrix);
 assert.equal(await runAdaptive(pending,{prefix:8,full:64,step:24,fraction:.375,evaluate:play.evaluate}),true);
 const levels=pending.levels.map(l=>l.fixtures);assert.deepEqual(levels.slice(0,2),[8,32]);assert.ok(levels.every(n=>n<=64));
 assert.equal(pending.levels[0].teams,8);assert.ok(pending.levels.every((l,i)=>i===0||l.teams<=pending.levels[i-1].teams));
 assert.equal(pending.stage,'expanding');assert.ok(pending.promoted.every(t=>prefixScores(pending,t).length===64));
 assert.equal(adaptiveLabeled(pending),play.spent);assert.ok(play.spent<8*64&&play.spent>=8*8);
 // The strong constant teams are measured to the end; the beaten ones stop at the common prefix.
 assert.ok(team.slice(0,3).every(t=>prefixScores(pending,t).length===64));assert.ok(team.slice(3,6).every(t=>prefixScores(pending,t).length===8));
});

test('an interrupted round resumes to exactly the uninterrupted result, wherever it stopped',async()=>{
 const matrix=Array.from({length:12},(_,i)=>jitter(.15+i*.06,64,20+i)),options={prefix:8,full:64,step:8,fraction:.5};
 const run=async stopAfter=>{
  const {pending}=fresh(matrix);let done=await runAdaptive(pending,{...options,evaluate:replayer(pending,matrix,{stopAfter}).evaluate}),restored=pending,resumes=0;
  // A checkpoint is plain JSON: resume from a serialised copy.
  while(!done){restored=JSON.parse(JSON.stringify(restored));resumes++;done=await runAdaptive(restored,{...options,evaluate:replayer(restored,matrix).evaluate});}
  return {pending:restored,resumes};
 };
 const whole=await run(Infinity);assert.equal(whole.resumes,0);assert.ok(whole.pending.levels.length>2);
 for(const stopAfter of [0,1,2,3,5]){const resumed=await run(stopAfter);assert.equal(resumed.resumes,1);assert.deepEqual(resumed.pending.scores,whole.pending.scores);assert.deepEqual(resumed.pending.levels,whole.pending.levels);assert.deepEqual(resumed.pending.promoted,whole.pending.promoted);}
});

test('when the common prefix already equals the full panel nothing is extended',async()=>{
 const matrix=[constant(.7,4),constant(.2,4),constant(.4,4),constant(.6,4)],{team,pending}=fresh(matrix),play=replayer(pending,matrix);
 assert.equal(await runAdaptive(pending,{prefix:4,full:4,step:8,evaluate:play.evaluate}),true);
 assert.deepEqual(pending.promoted,team);assert.equal(play.spent,16);assert.equal(adaptiveNext(pending,{level:4,step:8,full:4}),null);
});

test('the step size changes only how often the rule looks, never the guarantees',async()=>{
 const matrix=Array.from({length:24},(_,i)=>jitter(.1+i*.035,64,40+i));
 for(const step of [1,4,8,16,100]){
  const {team,pending}=fresh(matrix),play=replayer(pending,matrix);
  assert.equal(await runAdaptive(pending,{prefix:8,full:64,step,fraction:.5,evaluate:play.evaluate}),true);
  assert.ok(team.every(t=>prefixScores(pending,t).length>=8),'every candidate keeps the first prefix');
  assert.ok(pending.levels.every(l=>l.fixtures<=64)&&play.spent<=24*64);
  // The two leaders by their own full record are among the fully measured teams.
  const truth=team.slice().sort((a,b)=>matrix[b[0]].reduce((x,y)=>x+y,0)-matrix[a[0]].reduce((x,y)=>x+y,0)).slice(0,2);
  assert.ok(truth.every(t=>pending.promoted.some(p=>teamKey(p)===teamKey(t))),'step '+step);
 }
});

test('the margin widens or narrows the band on both sides; the default is exactly the specified rule',()=>{
 assert.equal(DEFAULT_MARGIN,1.28);
 const scores=[1,0,1,1,0,0,1,0],{mean}={mean:(4+4)/16},sd=Math.sqrt(mean*(1-mean)/17);
 assert.equal(pessimisticScore(scores),pessimisticScore(scores,1.28));assert.ok(Math.abs(pessimisticScore(scores,0)-mean)<1e-12);assert.ok(Math.abs(pessimisticScore(scores,2)-(mean-2*sd))<1e-12);
 // A smaller margin stops more candidates, a larger one fewer, with the same k.
 const team=rows(8),pending={teams:team,scores:{},predictions:{}};team.forEach((t,i)=>pending.scores[teamKey(t)]=jitter(.2+i*.08,8,60+i));
 const kept=margin=>adaptiveContinuation(pending,{full:64,fraction:.25,margin}).extend.length;
 assert.ok(kept(0)<=kept(.75)&&kept(.75)<=kept(1.28)&&kept(1.28)<=kept(3));assert.ok(kept(0)<kept(3));
 assert.deepEqual(adaptiveContinuation(pending,{full:64,fraction:.25}),adaptiveContinuation(pending,{full:64,fraction:.25,margin:1.28}));
 // At the default margin the optimistic side is promotionPriority itself: stopped teams are those promotionPriority ranks below the threshold.
 const decision=adaptiveContinuation(pending,{full:64,fraction:.25});
 for(const t of team){const live=decision.extend.some(x=>teamKey(x)===teamKey(t));assert.equal(live,promotionPriority(pending.scores[teamKey(t)])>=decision.threshold);}
 assert.throws(()=>adaptiveContinuation(pending,{full:64,margin:-1}),/margin/);assert.throws(()=>adaptiveContinuation(pending,{full:64,margin:NaN}),/margin/);
});
