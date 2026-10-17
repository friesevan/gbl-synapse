'use strict';
// Controller options of the v4 controller (next/lookahead-v4.js, <controller-options>; OBSERVATION_CONTROLLER.md):
// weighted replies, rollout continuation, switch margin and shield policy, battle-wide or per side (controllerTeams).
// The defaults are pinned byte for byte by mechanics-fixtures.test.cjs and forecast-reuse.test.cjs; here every
// option must be deterministic, exact on both forecast paths (so the forecast-reuse caches stay correct), side
// invariant, and must not leak into default battles.
const test=require('node:test'),assert=require('node:assert/strict');
const {play}=require('./engine-v4.cjs');
const {searchFixtures}=require('./simulator-fixtures.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));
const OPTIONS=[
 ['weighted replies',{replyModel:'weighted'}],
 ['weighted replies, T=2',{replyModel:'weighted',replyTemperature:2}],
 ['continuation 8',{rolloutContinuation:8}],
 ['weighted and continuation 4',{replyModel:'weighted',rolloutContinuation:4}],
 ['no voluntary switches',{switchMargin:1e9}],
 ['eager switches',{switchMargin:0}],
 ['always shield',{shieldPolicy:'always'}],
 ['never shield',{shieldPolicy:'never'}],
 ['per side: continuation against weighted',{controllerTeams:[{rolloutContinuation:8},{replyModel:'weighted'}]}],
 ['per side: default against never shield',{controllerTeams:[null,{shieldPolicy:'never'}]}],
 ['per side: eager against no switches',{controllerTeams:[{switchMargin:0},{switchMargin:1e9}]}],
];

test('each controller option is deterministic and exact on the baseline forecast path (forecast caches stay correct)',()=>{
 const fixtures=searchFixtures(3,{seed:31337});
 for(const [name,extra] of OPTIONS)fixtures.forEach((args,k)=>{
  const opts={...args[4],...extra,trace:true,audit:true};
  const optimized=plain(play(...args.slice(0,4),opts)),baseline=plain(play(...args.slice(0,4),{...opts,simulationOptimizations:false}));
  assert.equal(optimized.timedOut,false,name+' '+k);
  if(k===0)assert.deepEqual(plain(play(...args.slice(0,4),opts)),optimized,name+' is deterministic');
  assert.deepEqual(baseline,optimized,name+' optimized equals baseline, fixture '+k);
  const headless=plain(play(...args.slice(0,4),{...args[4],...extra}));
  assert.equal(headless.score,optimized.score,name+' headless '+k);assert.equal(headless.turns,optimized.turns);
 });
});

test('explicit default options are the default controller, byte for byte',()=>{
 const explicit={replyModel:'worst',replyTemperature:.9,rolloutContinuation:0,switchMargin:.08,shieldPolicy:'default',controllerTeams:[{},{replyModel:'worst'}]};
 for(const args of searchFixtures(6,{seed:4242})){
  const opts={...args[4],trace:true,audit:true};
  assert.deepEqual(plain(play(...args.slice(0,4),{...opts,...explicit})),plain(play(...args.slice(0,4),opts)));
 }
});

test('weighted replies at a vanishing temperature reproduce worst-case decisions',()=>{
 for(const args of searchFixtures(6,{seed:777})){
  const opts={...args[4],trace:true};
  assert.deepEqual(plain(play(...args.slice(0,4),{...opts,replyModel:'weighted',replyTemperature:1e-7})),plain(play(...args.slice(0,4),opts)));
 }
});

test('per-side controllers follow their teams when caller order is swapped, and identical teams stay distinguishable',()=>{
 const fixtures=searchFixtures(6,{seed:2718}),x={rolloutContinuation:8},y={shieldPolicy:'never',switchMargin:0};
 for(const args of fixtures){
  const direct=play(args[0],args[1],args[2],args[3],{...args[4],controllerTeams:[x,y]}),swapped=play(args[1],args[0],args[3],args[2],{...args[4],controllerTeams:[y,x]});
  assert.equal(direct.score,1-swapped.score);assert.equal(direct.turns,swapped.turns);assert.deepEqual(direct.remaining,swapped.remaining.slice().reverse());assert.deepEqual(direct.planner,swapped.planner);
 }
 const [a,,pa,,o]=fixtures[0];
 const same=play(a,a,pa,pa,o),different=play(a,a,pa,pa,{...o,controllerTeams:[null,{shieldPolicy:'never'}]}),mirror=play(a,a,pa,pa,{...o,controllerTeams:[{shieldPolicy:'never'},null]});
 assert.equal(same.scoreMode,'identical-team-mirrored-expectation');assert.equal(different.scoreMode,undefined);assert.equal(different.score,1-mirror.score);
 // Two sides with the same non-default controller are one controller: no orientation change, still mirrored.
 assert.equal(play(a,a,pa,pa,{...o,controllerTeams:[{switchMargin:0},{switchMargin:0}]}).scoreMode,'identical-team-mirrored-expectation');
});

test('options change play where they should: switching, shielding and continuation statistics',()=>{
 const fixtures=searchFixtures(8,{seed:99});let eager=0,base=0,alwaysShields=0,defaultShields=0;
 for(const args of fixtures){
  const d=play(...args.slice(0,4),{...args[4],trace:true});base+=d.planner.switches;defaultShields+=d.timeline.filter(e=>e.type==='shield'&&e.actor===1).length;
  // Default planner statistics keep their exact shape.
  assert.deepEqual(Object.keys(d.planner),['decisions','branches','branchCacheHits','switches','forced','beliefWorlds']);
  assert.equal(play(...args.slice(0,4),{...args[4],switchMargin:1e9}).planner.switches,0,'no voluntary switch on either side');
  eager+=play(...args.slice(0,4),{...args[4],switchMargin:0}).planner.switches;
  const never=play(...args.slice(0,4),{...args[4],trace:true,controllerTeams:[null,{shieldPolicy:'never'}]});
  assert.equal(never.timeline.filter(e=>e.type==='shield'&&e.actor===1).length,0,'the never-shield side never shields');
  alwaysShields+=play(...args.slice(0,4),{...args[4],trace:true,controllerTeams:[null,{shieldPolicy:'always'}]}).timeline.filter(e=>e.type==='shield'&&e.actor===1).length;
  const c=play(...args.slice(0,4),{...args[4],rolloutContinuation:8}).planner;
  // Bounded extra work: at most 2 x 2 continuation duels of at most N steps per continued branch.
  assert.ok(c.continuations<=c.branches&&c.continuationDuels<=4*c.continuations&&c.continuationDuels>=c.continuations&&c.continuationSteps<=8*c.continuationDuels&&c.rolloutSteps<=24*c.branches,JSON.stringify(c));
 }
 assert.ok(eager>base,'eager switching switches more: '+eager+' vs '+base);
 assert.ok(alwaysShields>=defaultShields,'always shield uses at least as many shields: '+alwaysShields+' vs '+defaultShields);
});

test('invalid controller options are refused before a battle starts',()=>{
 const [a,b,pa,pb,o]=searchFixtures(1)[0];
 for(const bad of [{replyModel:'average'},{replyTemperature:0},{replyTemperature:-1},{rolloutContinuation:25},{rolloutContinuation:1.5},{switchMargin:-.1},{shieldPolicy:'sometimes'},{controllerTeams:[{}]},{controllerTeams:[{typo:1},{}]}])
  assert.throws(()=>play(a,b,pa,pb,{...o,...bad}),/controller|reply|rollout|switch|shield/i,JSON.stringify(bad));
});
