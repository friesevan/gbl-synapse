'use strict';
// Per-placement screen boxes (README "Locating the phone screen"): the probe's assignment of keyframes to placements,
// its plan, and run-node's CROPS plan (tests/meta-benchmark/placement-plan.cjs).
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./meta-benchmark/probe.cjs'),M=require('./meta-benchmark/placement-plan.cjs');
// Keyframes every 5 s; scans of the located box (864–1400, centre 1132) and a placement 14 px right (878). The fitted
// screen centre: 1131.7 in the located box's clips, 1145 in the other's; the located box also reads the first 3 keyframes
// of the other clip (a box 3–4 px off still reads some frames), with a fit that puts the centre at 1145.
function scans(){const times=[],a={box:[864,0,1400,1080],hits:[],centres:[]},b={box:[878,0,1414,1080],hits:[],centres:[]};
 const clip=t=>t<100?'a':t<130?null:t<300?'b':t<330?null:'a';
 for(let t=0;t<500;t+=5){const i=times.push(t)-1,c=clip(t);a.hits[i]=c==='a'||(c==='b'&&t<145);b.hits[i]=c==='b';
  a.centres[i]=a.hits[i]?(c==='a'?1131.7:1145):null;b.centres[i]=b.hits[i]?1145:null;}
 return {times,a,b};}
test('probe placements: each HUD keyframe goes to the box whose edge is nearest the phone\'s fitted edge; the timeline splits between clips',()=>{
 const {times,a,b}=scans(),plan=P.placementPlan(times,[a,b],500);
 assert.deepEqual(plan.keep,[0,1]);
 assert.deepEqual(plan.stretches,[[{start:0,end:112.5},{start:312.5,end:500}],[{start:112.5,end:312.5}]]);
 // The located box's reads of the other clip go to the other placement (the fit is nearer it).
 assert.equal(plan.assign[times.indexOf(130)],1);assert.equal(plan.assign[times.indexOf(110)],-1);
});
test('probe placements: a placement nearest on fewer than 4 keyframes, or no ball fits at all, gives none',()=>{
 const {times,a,b}=scans();
 // The other clip only 3 keyframes long: not enough HUD hits.
 const few={...b,hits:b.hits.map((h,i)=>h&&times[i]<145),centres:b.centres.map((x,i)=>times[i]<145?x:null)},a2={...a,hits:a.hits.map((h,i)=>h&&!(times[i]>=145&&times[i]<300))};
 assert.equal(P.placementPlan(times,[a2,few],500),null);
 // Without any ball fit nothing is nearer than the located box.
 assert.equal(P.placementPlan(times,[{...a,centres:a.centres.map(()=>null)},{...b,centres:b.centres.map(()=>null)}],500),null);
 // A spurious candidate (it reads frames, but the phone is never nearest its edge) is dropped.
 const ghost={box:[850,0,1386,1080],hits:a.hits.slice(),centres:a.centres.slice()};
 assert.deepEqual(P.placementPlan(times,[a,b,ghost],500).keep,[0,1]);
});
test('probe plan: placements add CROPS to every plan that decodes, ranges or whole video',()=>{
 const placements=[{box:[864,0,1400,1080],hits:40,stretches:[{start:0,end:115},{start:315,end:500}]},{box:[878,0,1414,1080],hits:34,stretches:[{start:115,end:315}]}];
 const p={box:[864,0,1400,1080],ranges:[{start:0,end:400}],coverage:.5,keyInterval:5,placements},crops='864,0,1400,1080@0-115,315-500;878,0,1414,1080@115-315';
 assert.deepEqual(P.plan(p),{CROP:'864,0,1400,1080',RANGES:'0-400',CROPS:crops});
 assert.deepEqual(P.plan({...p,coverage:.9}),{CROP:'864,0,1400,1080',CROPS:crops});
 assert.deepEqual(P.plan({...p,keyInterval:20}),{CROP:'864,0,1400,1080',CROPS:crops});
 assert.equal(P.plan({...p,ranges:[]}),null);
 // One placement (or none): exactly the old plan.
 assert.deepEqual(P.plan({...p,placements:undefined}),{CROP:'864,0,1400,1080',RANGES:'0-400'});
});
test('run-node CROPS: parsed against CROP, round-trips, and rejects other sizes, overlaps and a missing CROP',()=>{
 const crop=[864,0,1400,1080],text='864,0,1400,1080@0-115,315-500;878,0,1414,1080@115-315',pl=M.parseCrops(text,crop);
 assert.deepEqual(pl,[{box:crop,stretches:[[0,115],[315,500]]},{box:[878,0,1414,1080],stretches:[[115,315]]}]);
 assert.equal(M.formatCrops(pl),text);
 for(const x of [undefined,null,''])assert.equal(M.parseCrops(x,crop),null);
 assert.throws(()=>M.parseCrops('878,0,1416,1080@115-315',crop),/size of CROP/);
 assert.throws(()=>M.parseCrops('864,0,1400,1080@0-120;878,0,1414,1080@115-315',crop),/overlap/);
 assert.throws(()=>M.parseCrops(text,null),/explicit CROP/);assert.throws(()=>M.parseCrops('864,0,1400@0-1',crop),/Invalid CROPS/);
});
test('run-node CROPS: decode ranges are cut where the placement changes; without CROPS they are unchanged',()=>{
 const crop=[864,0,1400,1080],pl=M.parseCrops('864,0,1400,1080@0-115,315-500;878,0,1414,1080@115-315',crop);
 assert.deepEqual(M.pieces([[0,null]],pl),[[0,115,0],[115,315,1],[315,null,0]]);
 assert.deepEqual(M.pieces([[50,100],[110,200],[300,450]],pl),[[50,100,0],[110,115,0],[115,200,1],[300,315,1],[315,450,0]]);
 assert.deepEqual(M.pieces([[0,null]],null),[[0,null,null]]);assert.deepEqual(M.pieces([[12.5,40]],null),[[12.5,40,null]]);
 // Times before the first stretch take its box; gaps take the stretch before them.
 assert.deepEqual(M.cropAt(pl,120,crop),[878,0,1414,1080]);assert.deepEqual(M.cropAt(pl,600,crop),crop);assert.deepEqual(M.cropAt(null,120,crop),crop);
 const gap=M.parseCrops('864,0,1400,1080@10-100;878,0,1414,1080@200-300',crop);assert.equal(M.indexAt(gap,5),0);assert.equal(M.indexAt(gap,150),0);assert.equal(M.indexAt(gap,250),1);
 // Two stretches of one placement with only a gap between them are decoded as one piece.
 assert.deepEqual(M.pieces([[0,300]],M.parseCrops('864,0,1400,1080@0-100,150-200;878,0,1414,1080@210-300',crop)),[[0,210,0],[210,300,1]]);
});
