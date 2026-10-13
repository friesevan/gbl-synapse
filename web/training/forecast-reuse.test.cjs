'use strict';
// Forecast reuse (team-search/findings/speed-forecast.md). The optimized path
// shares duel forecasts across belief worlds, bench clones and pressure terms,
// keeps guessed-opponent clones across steps, parses a fresh Game Master instead
// of cloning it, and runs the simulator in an ordinary (not contextified) VM
// global. None of that may change a battle: the optimized path must reproduce
// the baseline path (simulationOptimizations:false) exactly.
const test=require('node:test'),assert=require('node:assert/strict');
const {play}=require('./engine-v4.cjs');
const {searchFixtures,specialSpecies}=require('./simulator-fixtures.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));
const labels=r=>{const {samples,teamStats,timeline,traceScore,...rest}=r;const planner={...rest.planner};delete planner.observed;return {...rest,planner};};

test('optimized forecasts reproduce the baseline path on 96 search-shaped fixtures, event for event',()=>{
 const fixtures=searchFixtures(96),seen=new Set();let switches=0,forced=0,shadows=0;
 for(const [k,args] of fixtures.entries()){
  const opts={...args[4],trace:true,audit:true};
  const optimized=plain(play(...args.slice(0,4),opts)),baseline=plain(play(...args.slice(0,4),{...opts,simulationOptimizations:false}));
  assert.equal(optimized.timedOut,false,'fixture '+k);
  // Score, turns, remaining, charged count, planner statistics, public
  // observations, every HP sample and every timeline event.
  assert.deepEqual(optimized,baseline,'fixture '+k+' seed '+opts.seed);
  const headless=plain(play(...args.slice(0,4),args[4]));
  assert.deepEqual(labels(headless),labels(optimized),'headless fixture '+k);
  for(const p of [...args[0],...args[1]]){if(specialSpecies.includes(p.speciesId))seen.add(p.speciesId);if(p.speciesId.endsWith('_shadow'))shadows++;}
  switches+=optimized.planner.switches;forced+=optimized.planner.forced;
 }
 // The panel must exercise form changes, Shadow entries and both switch kinds.
 for(const id of ['cramorant','aegislash_shield','morpeko_full_belly','darmanitan_galarian_standard','mimikyu'])assert.ok(seen.has(id),id);
 assert.ok(shadows>=48&&switches>0&&forced>0,JSON.stringify({shadows,switches,forced}));
});

test('forecast reuse is exact under other forecast settings and policies',()=>{
 const fixtures=searchFixtures(12,{seed:777});
 const variants=[{beliefSamples:1},{beliefSamples:5},{horizon:8},{horizon:32,interval:2},{interval:6},{beliefTeams:[]}];
 const policy={switch:2,switchFarm:3,bait:.4,farm:2,shield:.5};
 fixtures.forEach((args,k)=>{
  const opts={...args[4],...variants[k%variants.length],trace:true,audit:true},policies=k%2?[policy,undefined]:[undefined,undefined];
  const optimized=plain(play(args[0],args[1],...policies,opts)),baseline=plain(play(args[0],args[1],...policies,{...opts,simulationOptimizations:false}));
  assert.deepEqual(optimized,baseline,'variant fixture '+k);
 });
});
