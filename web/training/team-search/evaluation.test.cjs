'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {summarize,compare,baselineTeams}=require('./evaluation.cjs');
test('evaluation groups mirrored battles and comparison preserves matched fixtures',()=>{
 const a=summarize([1,1,1,0,.5,.5,0,0],{fixtureSeed:19}),b=summarize([0,0,1,0,0,0,0,0],{fixtureSeed:19});assert.equal(a.score,.5);assert.equal(a.wins,3);assert.equal(a.draws,2);assert.deepEqual(a.pairs,[1,.5,.5,0]);const c=compare(a,[b],{seed:2,samples:1000});assert.equal(c.delta,.375);assert.ok(c.interval95[0]<=c.delta&&c.interval95[1]>=c.delta);assert.throws(()=>compare(a,[{...b,fixtureSeed:20}]),/same opponent/);
});
test('baseline teams include uniform and weighted best-moves and coverage styles without duplicate dex',()=>{
 const species=[1,2,3,4].map(dex=>({speciesId:'p'+dex,dex,weight:1})),variants=species.flatMap(s=>[{...s,scoutScore:.3},{...s,scoutScore:.7}]),pool={species,variants};const rows=baselineTeams(pool,12,22);assert.equal(rows.filter(r=>r.kind==='uniform-random').length,4);assert.equal(rows.filter(r=>r.kind==='greedy-scout-coverage').length,4);for(const row of rows){assert.equal(new Set(row.team.map(i=>variants[i].dex)).size,3);if(row.kind==='weight-sampled-best-moves')row.team.forEach(i=>assert.equal(variants[i].scoutScore,.7));}
});

test('greedy coverage chooses complementary scout profiles without duplicate species',()=>{const {coverageTeam}=require('./evaluation.cjs'),pool={targets:[{weight:1},{weight:1},{weight:1}],variants:[{dex:1,features:[.9,.1,.1]},{dex:1,features:[.8,.2,.2]},{dex:2,features:[.1,.9,.1]},{dex:3,features:[.1,.1,.9]},{dex:4,features:[.4,.4,.4]}]};const team=coverageTeam(pool,0,0);assert.equal(new Set(team.map(i=>pool.variants[i].dex)).size,3);const coverage=[0,1,2].map(j=>Math.max(...team.map(i=>pool.variants[i].features[j])));assert.deepEqual(coverage,[.9,.9,.9]);});

test('deadline-cut panels retain only the same completed opponent prefix for every team',()=>{
 const {panelIndex,commonPanelScores}=require('./evaluation.cjs'),teams=[[0,1,2],[1,2,3],[2,3,4]],partial=teams.map(()=>new Array(5));
 // One worker is slow on fixture 3 while later results finish out of order.
 [0,1,2,3,4,5,6,7,9,10,11].forEach(index=>{const p=panelIndex(index,teams.length);partial[p.team][p.fixture]=p.team/2;});
 const rows=commonPanelScores(teams,partial);assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.scores),[[0,0],[.5,.5],[1,1]]);
 partial[2][2]=1;assert.deepEqual(commonPanelScores(teams,partial).map(r=>r.scores.length),[4,4,4]);
 assert.deepEqual(commonPanelScores(teams,teams.map(()=>[])),[]);
});

test('invalid and incomplete fixture scores cannot become confident evaluations',()=>{
 for(const scores of [[],[1,NaN],[1,Infinity],[1,-.1],[1,2],[1]])assert.throws(()=>summarize(scores),/complete opponent fixtures/);
 assert.equal(summarize([1],{paired:false}).standardError,null);
 const primary=summarize([1],{paired:false,fixtureSeed:1}),other=summarize([0],{paired:false,fixtureSeed:1});assert.deepEqual(compare(primary,[other],{samples:100}).interval95,[-1,1]);assert.deepEqual(require('./evaluation.cjs').compareFinalists(primary,[other],{samples:100}).comparisons[0].interval95,[-1,1]);
});

test('finalist comparison uses paired opponents and simultaneous uncertainty without picking the test winner',()=>{
 const {compareFinalists}=require('./evaluation.cjs'),primary=summarize([1,0,1,0,1,0,1,0],{team:[0,1,2],fixtureSeed:9,paired:false}),other=summarize([0,1,0,1,0,1,0,1],{team:[3,4,5],fixtureSeed:9,paired:false}),worse=summarize([0,0,0,0,0,0,0,0],{team:[6,7,8],fixtureSeed:9,paired:false});
 const comparison=compareFinalists(primary,[other,worse],{seed:13,samples:1000});assert.equal(comparison.primaryTeam,primary.team);assert.equal(comparison.fixtures,8);assert.equal(comparison.comparisons[0].delta,0);assert.equal(comparison.comparisons[0].distinguishable,'unresolved');assert.equal(comparison.primaryResolved,false);assert.deepEqual(comparison,compareFinalists(primary,[other,worse],{seed:13,samples:1000}));
 assert.throws(()=>compareFinalists(primary,[{...other,fixtureSeed:10}]),/same opponent fixtures/);
 const single=compareFinalists(primary,[other],{seed:13,samples:1000});assert.ok(comparison.comparisons[0].interval95[1]-comparison.comparisons[0].interval95[0]>=single.comparisons[0].interval95[1]-single.comparisons[0].interval95[0]);
});
