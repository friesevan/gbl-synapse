'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {teamKey}=require('./common.cjs');
const {fixtureKey,uniqueFixtures,stageComplete,promoteCandidates,missingFixtures,sourceDiagnostics}=require('./acquisition.cjs');
const teams=[[0,3,6],[1,3,6],[2,4,7],[0,4,7]];
const cases=Array.from({length:8},(_,i)=>({team:[{speciesId:'a'},{speciesId:'b'},{speciesId:'c'}],seed:20+i}));
function pending(){return {teams,scores:{},sources:Object.fromEntries(teams.map((t,i)=>[teamKey(t),i<2?'neural':'random'])),predictions:{}};}
test('fixture identity deduplicates bench permutations but preserves opponent order and seed',()=>{
 assert.equal(fixtureKey([0,6,3],cases[0].team,20),fixtureKey(teams[0],['a','b','c'],20));
 assert.equal(fixtureKey(teams[0],['a','c','b'],20),fixtureKey(teams[0],['a','b','c'],20));
 assert.notEqual(fixtureKey(teams[0],['a','b','c'],20),fixtureKey(teams[0],['b','a','c'],20));
 assert.notEqual(fixtureKey(teams[0],['a','b','c'],20),fixtureKey(teams[0],['a','b','c'],21));
 assert.equal(uniqueFixtures([...cases,cases[0]]).length,8);
 assert.equal(uniqueFixtures([...cases,{team:[{speciesId:'a'},{speciesId:'c'},{speciesId:'b'}],seed:20}]).length,8);
});
test('promotion rewards competitive scores and genuine uncertainty with deterministic ties',()=>{
 const p=pending();teams.forEach((t,i)=>p.scores[teamKey(t)]=[1,.5,.5,0].map(()=>i===0?1:i===1?.75:0));
 assert.deepEqual(promoteCandidates(p,{fixtures:4,fraction:.5}),teams.slice(0,2));
 p.predictions[teamKey(teams[2])]={uncertainty:.7};assert.deepEqual(promoteCandidates(p,{fixtures:4,fraction:.5}),[teams[2],teams[0]]);
 assert.deepEqual(promoteCandidates(JSON.parse(JSON.stringify(p)),{fixtures:4,fraction:.5}),promoteCandidates(p,{fixtures:4,fraction:.5}));
 assert.throws(()=>promoteCandidates(p,{fixtures:4,fraction:0}),/fraction/);
});
test('interrupted sparse panels retain every result and schedule only missing fixtures on resume',()=>{
 const p=pending(),work=missingFixtures(p,teams,cases,4);
 assert.equal(work.length,16);assert.deepEqual(work.slice(0,4).map(w=>w.fixture),[0,0,0,0]);
 // Worker completion order differs from scheduling, including gaps in a row.
 for(const index of [0,2,7,12]){const w=work[index];(p.scores[teamKey(w.team)]??=[])[w.fixture]=.5;}
 assert.equal(stageComplete(p,teams,4),false);assert.throws(()=>promoteCandidates(p,{fixtures:4}),/Complete/);
 const restored=JSON.parse(JSON.stringify(p)),remaining=missingFixtures(restored,teams,cases,4);
 assert.equal(remaining.length,12);assert.equal(new Set([...remaining,...[0,2,7,12].map(i=>work[i])].map(w=>w.key)).size,16);
 for(const w of remaining)(restored.scores[teamKey(w.team)]??=[])[w.fixture]=.5;
 assert.equal(stageComplete(restored,teams,4),true);
 const promoted=promoteCandidates(restored,{fixtures:4,fraction:.5}),expansion=missingFixtures(restored,promoted,cases,8);
 assert.equal(expansion.length,8);assert.ok(expansion.every(w=>w.fixture>=4));
 assert.equal(16+expansion.length,24); // 25% less work than 4 × 8 fixtures.
});
test('acquisition group diagnostics use the common prefix rather than selected expansion outcomes',()=>{
 const p=pending();teams.forEach(t=>p.scores[teamKey(t)]=[.5,.5]);
 p.scores[teamKey(teams[0])].push(1,1,1,1);p.scores[teamKey(teams[2])].push(0,0);
 const rows=sourceDiagnostics(p,2);assert.deepEqual(rows.map(row=>row.meanScore),[.5,.5]);
 assert.ok(rows.every(row=>row.fixturesPerTeam===2&&row.panel==='common acquisition prefix'));
 assert.throws(()=>sourceDiagnostics(p,6),/complete/);
});
