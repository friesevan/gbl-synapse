'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {propose}=require('./propose.cjs');const {validTeam}=require('./common.cjs');
test('proposals preserve exploration, team legality and source labels',()=>{
 const variants=Array.from({length:24},(_,i)=>({dex:Math.floor(i/3)+1})),known=[{team:[0,4,8]}],seen=new Map([['0,4,8',known[0]]]),predict=t=>({mean:t[0]/24,uncertainty:t[1]/24});
 const a=propose({variants,known,seen,predict,seed:12,candidates:100,batchTeams:12}),b=propose({variants,known,seen,predict,seed:12,candidates:100,batchTeams:12});assert.deepEqual(a,b);assert.equal(a.teams.length,12);a.teams.forEach(t=>assert.ok(validTeam(t,variants)));assert.equal(new Set(a.teams.map(t=>t.join(','))).size,12);
 const counts=Object.values(a.sources).reduce((r,k)=>(r[k]=(r[k]||0)+1,r),{});assert.deepEqual(counts,{neural:5,uncertainty:3,random:3,retest:1});
});

test('precomputed candidate scores preserve identical proposal selection and random exploration',()=>{const {generateCandidates,selectCandidates}=require('./propose.cjs'),variants=Array.from({length:24},(_,i)=>({dex:Math.floor(i/3)+1})),options={variants,known:[{team:[0,4,8]}],seen:new Map([['0,4,8',true]]),predict:t=>({mean:t[0]/24,uncertainty:t[1]/24}),seed:12,candidates:100,batchTeams:12},generated=generateCandidates(options);assert.deepEqual(selectCandidates(options,generated,generated.teams.map(options.predict)),propose(options));});

test('local mutations explore other movesets and leads without treating bench permutations as candidates',()=>{
 const {mutateCandidate}=require('./propose.cjs'),variants=Array.from({length:900},(_,i)=>({speciesId:'p'+Math.floor(i/3),dex:Math.floor(i/3)+1})),team=[0,4,8],sequence=values=>()=>values.shift();
 const moves=mutateCandidate(team,variants,sequence([.1,.4,.8]));assert.deepEqual(moves,[0,5,8]);assert.deepEqual(moves.map(i=>variants[i].speciesId),team.map(i=>variants[i].speciesId));
 const lead=mutateCandidate(team,variants,sequence([.4,.1]));assert.deepEqual(lead,[4,0,8]);assert.notEqual(lead[0],team[0]);assert.deepEqual(team,[0,4,8]);
});

test('promising exploration favors competitive uncertainty over uncertainty alone',()=>{
 const {explorationScore}=require('./propose.cjs');
 const weak={mean:.2,uncertainty:.15},strong={mean:.7,uncertainty:.05};
 assert.ok(explorationScore(weak,'disagreement')>explorationScore(strong,'disagreement'));
 assert.ok(explorationScore(strong)>explorationScore(weak));
 assert.throws(()=>explorationScore(strong,'invalid'),/mode/);
});
test('local neighborhood covers every single-member moveset substitution and both leads',()=>{
 const {localNeighbors,generateCandidates}=require('./propose.cjs');
 const variants=Array.from({length:15},(_,i)=>({speciesId:'p'+Math.floor(i/5),dex:Math.floor(i/5)+1})),team=[0,5,10];
 const neighbors=localNeighbors(team,variants);assert.equal(neighbors.length,14);
 for(const t of neighbors)assert.ok(validTeam(t,variants));
 assert.ok(neighbors.some(t=>t.join(',')==='0,9,10'));assert.ok(neighbors.some(t=>t[0]===10));
 const generated=generateCandidates({variants,known:[{team}],seen:new Map([[team.join(','),true]]),seed:1,candidates:40});
 for(const t of neighbors)assert.ok(generated.teams.some(row=>row.join(',')===t.join(',')));
});
test('retests rotate seven challengers and retain regular incumbent checks',()=>{
 const {retestTeam}=require('./propose.cjs'),known=Array.from({length:10},(_,i)=>({team:[i,20,30]}));
 const chosen=Array.from({length:12},(_,round)=>retestTeam(known,round));
 assert.equal(chosen.filter(t=>t===known[0].team).length,4);
 assert.equal(new Set(chosen.map(t=>t[0])).size,8);assert.equal(retestTeam([],0),null);
});
test('moveset rivals include their known parent for a common-round comparison',()=>{
 const {movesetRival,selectCandidates,generateCandidates}=require('./propose.cjs');
 const variants=Array.from({length:18},(_,i)=>({speciesId:'p'+Math.floor(i/3),dex:Math.floor(i/3)+1})),known=[{team:[9,12,15]},{team:[0,3,6]}];
 assert.deepEqual(movesetRival([[1,6,3]],known,variants),known[1].team);
 assert.equal(movesetRival([[3,0,6]],known,variants),null); // Different lead.
 const opts={variants,known,seen:new Map(known.map(r=>[r.team.join(','),r])),seed:1,candidates:100,batchTeams:4,round:0},generation=generateCandidates(opts);
 const selected=selectCandidates(opts,generation,generation.teams.map(t=>({mean:t.join(',')==='1,3,6'?1:0,uncertainty:0})));
 assert.equal(selected.sources['0,3,6'],'retest');assert.ok(selected.teams.some(t=>t.join(',')==='1,3,6'));
 assert.deepEqual(selected.predictions['1,3,6'],{mean:1,uncertainty:0});
});
