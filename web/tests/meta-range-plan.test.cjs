'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('./meta-benchmark/range-plan.cjs');
test('a global probe is clipped to each batch chunk with its existing six-minute overlap',()=>{
 const ranges=[[100,400],[1250,1550],[2100,2300]];
 const first=P.planWindow({ranges,start:0,end:1560});
 const second=P.planWindow({ranges,start:1200,end:2400});
 assert.deepEqual(first.ranges,[[100,400],[1250,1550]]);
 assert.deepEqual(second.ranges,[[1250,1550],[2100,2300]]);
 assert.equal(first.seconds,600);assert.equal(second.seconds,500);
 assert.equal(first.RANGES,'100-400,1250-1550');
 // Source times are untouched; overlap is retained so merge still owns battles by start.
 assert.deepEqual(ranges,[[100,400],[1250,1550],[2100,2300]]);
});
test('absent plans decode the requested window; explicit empty windows must skip the task',()=>{
 assert.equal(P.planWindow({start:600,end:1200}).mode,'full');
 assert.equal(P.planWindow({ranges:[],start:600,end:1200}).mode,'empty');
 assert.equal(P.planWindow({ranges:[[0,300]],start:600,end:1200}).mode,'empty');
});
test('reviewer full pass ignores stale range metadata and retains exact chunk bounds',()=>{
 const plan=P.planWindow({ranges:[[NaN,-1]],start:1200,end:2400,forceFull:true});
 assert.equal(plan.mode,'full');assert.equal(plan.seconds,1200);assert.equal(plan.RANGES,'');
});
test('merge overlaps and duplicate boundaries, preserve real gaps and fractional source times',()=>{
 assert.deepEqual(P.clipRanges([[20.25,30],[1.5,10],[8,15],[15,20],[20,20.25]],2,25),[[2,25]]);
 assert.deepEqual(P.normalizeRanges([{start:10,end:20},{start:1,end:5}]),[[1,5],[10,20]]);
});
test('invalid explicit ranges and bounds are rejected rather than silently dropping footage',()=>{
 for(const ranges of [[[10,9]],[[0,Infinity]],[[-1,3]],[[1,2,3]],[[NaN,3]],'1-3'])assert.throws(()=>P.planWindow({ranges}));
 for(const [start,end] of [[-1,10],[10,10],[10,1],[0,NaN]])assert.throws(()=>P.planWindow({start,end}));
});
const valid={box:[718,0,1202,1080],keyInterval:2,coverage:.6,ranges:[{start:20,end:500},{start:1100,end:1500}]};
test('optional batch column and inherited environment ranges use the same strict parser',()=>{
 assert.equal(P.parseRanges(''),null);assert.deepEqual(P.parseRanges('[]'),[]);
 assert.deepEqual(P.parseRanges('1.5-2,3-4'),[[1.5,2],[3,4]]);
 assert.deepEqual(P.parseRanges('[{"start":1,"end":2}]'),[[1,2]]);
 for(const bad of ['1-2,garbage','-1-2','1-Infinity','[null]'])assert.throws(()=>P.parseRanges(bad));
 assert.equal(P.parseRanges('stale-malformed-plan',{forceFull:true}),null);
});
test('unverified probe metadata and reviewers always cause a whole pass',()=>{
 assert.equal(P.probeWindow(valid,{end:1800}).mode,'full');
 assert.equal(P.probeWindow(valid,{verified:true,end:1800,forceFull:true}).mode,'full');
});
test('validated probe gets identical padded battle ranges, clipped to the chunk',()=>{
 const plan=P.probeWindow(valid,{verified:true,start:1200,end:1800});
 assert.deepEqual(plan.ranges,[[1200,1500]]);assert.equal(plan.CROP,'718,0,1202,1080');
 const empty=P.probeWindow(valid,{verified:true,start:1600,end:1800});assert.equal(empty.mode,'empty');
});
test('empty HUD evidence, coarse probes and inconsistent metadata never skip an entire source',()=>{
 for(const patch of [{ranges:[]},{keyInterval:30},{keyInterval:null},{coverage:1.1},{coverage:.9},{box:[1,1,0,0]},{ranges:[[30,20]]}]){
  assert.equal(P.probeWindow({...valid,...patch},{verified:true,end:1800}).mode,'full');
 }
});
