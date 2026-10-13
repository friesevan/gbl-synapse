'use strict';
// Shared contender panel (--retest-panel N): who plays it, how paired comparisons are formed,
// and what is recorded. The full search loop (resume, sealed-overlap guard, history and
// recommendations.json) is covered in search-acquisition.test.cjs.
const test=require('node:test'),assert=require('node:assert/strict');
const {teamKey}=require('./common.cjs');
const {createPanel,teamsToPlay,register,complete,row,pair,roundSummary,report,SOURCE}=require('./retest-panel.cjs');

const team=(a,b,c)=>[a,b,c];
const teams=[team(0,10,11),team(1,10,11),team(2,10,11),team(3,10,11)];
const pending=sources=>({teams,sources:Object.fromEntries(teams.map((t,i)=>[teamKey(t),sources[i]]))});
function filled(scores){ // scores: {teamIndex: array}
 const panel=createPanel({fixtures:6,requested:6,seed:77});
 for(const [i,s] of Object.entries(scores)){register(panel,[teams[i]]);panel.scores[teamKey(teams[i])]=s;}
 return panel;
}

test('the retested team and the incumbent play the panel, nobody else',()=>{
 assert.deepEqual(teamsToPlay(pending(['neural','retest','random','uncertainty']),teams[3]),[teams[1],teams[3]]);
 assert.deepEqual(teamsToPlay(pending(['neural','retest','random','uncertainty']),teams[1]),[teams[1]]); // the incumbent is the retested team
 assert.deepEqual(teamsToPlay(pending(['neural','neural','random','uncertainty']),null),[]);          // no retest, no incumbent yet
 assert.deepEqual(teamsToPlay({teams,sources:{}},teams[0]),[teams[0]]);
});

test('registering teams keeps their identity beside their scores',()=>{
 const panel=createPanel({fixtures:3,requested:3,seed:5});register(panel,[teams[0],teams[2]]);
 assert.deepEqual(Object.keys(panel.scores),[teamKey(teams[0]),teamKey(teams[2])]);assert.deepEqual(panel.teams[teamKey(teams[2])],teams[2]);
 register(panel,[teams[0]]);assert.deepEqual(panel.scores[teamKey(teams[0])],[]); // idempotent, never clears
 panel.scores[teamKey(teams[0])]=[1,1,1];register(panel,[teams[0]]);assert.deepEqual(panel.scores[teamKey(teams[0])],[1,1,1]);
});

test('a panel row needs every fixture: holes and short rows are incomplete',()=>{
 const panel=filled({0:[1,0,1,1,0,1],1:[1,0,1],2:[1,0,undefined,1,0,1],3:[1,0,null,1,0,1]});
 assert.equal(complete(panel,teamKey(teams[0])),true);assert.equal(complete(panel,teamKey(teams[1])),false);
 assert.equal(complete(panel,teamKey(teams[2])),false);assert.equal(complete(panel,teamKey(teams[3])),false);assert.equal(complete(panel,'9,9,9'),false);
 const summary=row(panel,teamKey(teams[0]));assert.equal(summary.kind,SOURCE);assert.equal(summary.fixtureSeed,77);assert.equal(summary.paired,false);assert.equal(summary.games,6);
});

test('comparisons are incumbent minus contender on identical fixtures and say when they cannot separate',()=>{
 const strong=[1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,0],weak=[0,0,1,0,0,0,0,0,1,0,0,0,0,0,0,0],alike=[1,1,1,1,0,0,1,1,1,1,1,1,1,0,1,1];
 const panel=createPanel({fixtures:16,requested:16,seed:3});register(panel,teams.slice(0,3));
 [strong,weak,alike].forEach((s,i)=>panel.scores[teamKey(teams[i])]=s);
 const base=row(panel,teamKey(teams[0])),vsWeak=pair(base,row(panel,teamKey(teams[1])),9),vsAlike=pair(base,row(panel,teamKey(teams[2])),9);
 assert.ok(vsWeak.delta>.5&&vsWeak.interval95[0]>0&&vsWeak.standing==='incumbent-better');assert.equal(vsWeak.fixtures,16);
 assert.ok(Math.abs(vsAlike.delta)<.1&&vsAlike.standing==='unresolved');
 const reverse=pair(row(panel,teamKey(teams[1])),base,9);assert.ok(reverse.delta<-.5&&reverse.standing==='contender-better');
 assert.deepEqual(pair(base,row(panel,teamKey(teams[1])),9),vsWeak); // seeded: reproducible
});

test('the round summary compares the incumbent with the teams that played, skipping itself',()=>{
 const a=[1,1,0,1,1,1],b=[0,1,0,0,1,0],c=[1,0,0,1,1,0];
 const panel=filled({0:a,1:b,2:c});
 const summary=roundSummary(panel,[teams[1],teams[0]],teams[0],{seed:4});
 assert.equal(summary.fixtures,6);assert.deepEqual(summary.incumbent,teams[0]);assert.equal(summary.teamsOnPanel,3);
 assert.equal(summary.comparisons.length,1);assert.deepEqual(summary.comparisons[0].team,teams[1]);assert.ok(summary.comparisons[0].delta>0);
 assert.equal(summary.incumbentScore,a.reduce((x,y)=>x+y,0)/6);
 // An incumbent whose panel is incomplete yields no comparisons rather than a partial one.
 panel.scores[teamKey(teams[0])]=[1,1,0];assert.deepEqual(roundSummary(panel,[teams[1]],teams[0]).comparisons,[]);
});

test('the full report uses the best-ranked team with a complete panel and corrects for several contenders',()=>{
 const panel=filled({0:[1,1,0,1,1,1],1:[0,1,0,0,1,0],2:[1,0,0,1,1,0],3:[1,1]});
 const ordered=teams.map(t=>({team:t}));
 const full=report(panel,ordered,{seed:2});
 assert.deepEqual(full.incumbent,teams[0]);assert.equal(full.incumbentIsLeader,true);assert.equal(full.teams,3);assert.equal(full.comparisons.length,2);
 assert.ok(full.comparisons[0].delta<=full.comparisons[1].delta,'strongest challenger first');
 assert.equal(full.simultaneous.comparisons.length,2);assert.equal(full.simultaneous.fixtures,6);
 // The leader has not played the panel (e.g. a new leader this round): fall back and say so.
 const reordered=[{team:teams[3]},...ordered.slice(0,3)],fallback=report(panel,reordered,{seed:2});
 assert.deepEqual(fallback.incumbent,teams[0]);assert.equal(fallback.incumbentIsLeader,false);
 assert.equal(report(null,ordered),null);assert.equal(report(createPanel({fixtures:6,requested:6,seed:1}),ordered).incumbent,null);
});
