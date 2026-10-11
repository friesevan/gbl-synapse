'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {splitByTeam,correlation}=require('./audit-model.cjs');const {teamKey}=require('./common.cjs');
test('held-out split keeps every lead/bench-equivalent candidate identity in one partition',()=>{
 const rows=Array.from({length:50},(_,i)=>[{team:[i,i+70,i+130]},{team:[i,i+130,i+70]}]).flat();
 for(let fold=0;fold<5;fold++){const {training,test}=splitByTeam(rows,fold),trainKeys=new Set(training.map(r=>teamKey(r.team))),testKeys=new Set(test.map(r=>teamKey(r.team)));assert.ok(training.length&&test.length);for(const k of trainKeys)assert.equal(testKeys.has(k),false);assert.equal(training.length+test.length,rows.length);}
});
test('rank correlation handles ties and undefined constant rankings',()=>{assert.equal(correlation([1,2,2,4],[1,3,3,8]),1);assert.equal(correlation([1,2,3],[3,2,1]),-1);assert.equal(correlation([1,1],[1,2]),null);});
