'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {play}=require('./engine-v2.cjs');const rows=require('../includes/pro/data/league-1500.json').overall;
test('v2 outcomes and decisions are invariant to caller side and bench order, without live-state mutation',()=>{
 for(const seed of [42,177,901]){
  const a=rows.slice(0,3),b=rows.slice(3,6),opts={seed,audit:true};
  const direct=play(a,b,undefined,undefined,opts),swapped=play(b,a,undefined,undefined,opts),bench=play([a[0],a[2],a[1]],[b[0],b[2],b[1]],undefined,undefined,opts);
  assert.equal(direct.timedOut,false);assert.equal(direct.score,1-swapped.score);assert.deepEqual(direct.remaining,swapped.remaining.reverse());assert.deepEqual(direct.planner,swapped.planner);assert.deepEqual(direct,bench);assert.ok(direct.planner.branches>direct.planner.decisions);
 }
});
test('identity mapping follows team-specific policies when caller sides reverse',()=>{
 const a=rows.slice(6,9),b=rows.slice(9,12),p={switch:2,switchFarm:3,bait:.4,farm:2,shield:.5},q={switch:1,switchFarm:1,bait:1,farm:1,shield:1};
 const x=play(a,b,p,q,{seed:98,audit:true}),y=play(b,a,q,p,{seed:98,audit:true});assert.equal(x.score,1-y.score);assert.equal(x.turns,y.turns);assert.equal(x.charged,y.charged);
});
test('identical team symmetry is explicitly reported as a mirrored expectation',()=>{const a=rows.slice(0,3),r=play(a,a,undefined,undefined,{seed:123,audit:true});assert.equal(r.score,.5);assert.equal(r.scoreMode,'identical-team-mirrored-expectation');assert.equal(r.mirroredOutcomes[0]+r.mirroredOutcomes[1],1);});
