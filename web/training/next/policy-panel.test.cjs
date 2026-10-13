'use strict';
// The policy-diversity panel (policy-panel.cjs): job layout, the completed common prefix, the statistics, and a
// real tiny panel in which the default style reproduces the ordinary search battle exactly.
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./policy-panel.cjs'),{play}=require('../engine-v4.cjs'),{searchFixtures}=require('../simulator-fixtures.cjs'),core=require('../../includes/pro/neural-report-core.js');

test('jobs are fixture-major; the default style is the plain search battle and the given teams keep their controller',()=>{
 const teams=[['a'],['b']],fixtures=[{team:['x'],seed:11},{team:['y'],seed:12}],engine={cp:1500,horizon:24};
 const {jobs,index}=P.buildJobs({teams,fixtures,engine});
 assert.equal(jobs.length,2*P.STYLES.length*2);assert.deepEqual(index.slice(0,3),[{fixture:0,style:0,team:0},{fixture:0,style:0,team:1},{fixture:0,style:1,team:0}]);
 assert.deepEqual(jobs[0][4],{cp:1500,horizon:24,seed:11});assert.equal(jobs[0][4].controllerTeams,undefined);
 assert.deepEqual(jobs[2][4].controllerTeams,[null,{replyModel:'weighted',replyTemperature:.25}]);
 const own=P.buildJobs({teams,fixtures,engine,own:{replyModel:'weighted',replyTemperature:.25,rolloutContinuation:0}}).jobs;
 assert.deepEqual(own[0][4].controllerTeams,[{replyModel:'weighted',replyTemperature:.25},null]);
 assert.deepEqual(own[2][4].controllerTeams,[{replyModel:'weighted',replyTemperature:.25},{replyModel:'weighted',replyTemperature:.25}]);
 assert.deepEqual(P.STYLES.map(s=>s.name),['default','weighted-replies','no-voluntary-switches','eager-switches','always-shield','never-shield']);
 assert.throws(()=>P.checkSize(-1));assert.throws(()=>P.checkSize(1.5));assert.equal(P.checkSize(0),0);
});

test('a stopped panel keeps the common prefix of whole fixtures; means, spread and bands are paired',async()=>{
 const teams=[['t0'],['t1']],fixtures=Array.from({length:6},(_,i)=>({team:['o'+i],seed:i+1}));
 // Team 0 scores 1 except against never-shield; team 1 depends on nothing. The last fixture never finishes.
 const score=(team,style,fixture)=>team[0]==='t0'?(style==='never-shield'?0:1):fixture%2;
 const run=async(jobs,{onResult})=>{jobs.forEach((job,i)=>{const style=job[4].controllerTeams?.[1]?P.STYLES.find(s=>JSON.stringify(s.controller&&{...s.controller})===JSON.stringify(job[4].controllerTeams[1]))?.name:'default',fixture=job[4].seed-1;if(fixture<5)onResult({score:score(job[0],style,fixture)},i);});return null;};
 let battles=0;const r=await P.runPanel({teams,ids:[[0,1,2],[3,4,5]],labels:['zero','one'],fixtures,engine:{},run,onBattle:()=>battles++,seed:77,bootstrapSeed:5,samples:500});
 assert.equal(r.fixtures.completed,5);assert.equal(r.fixtures.requested,6);assert.equal(battles,5*P.STYLES.length*2);
 const [a,b]=r.teams;
 assert.equal(a.scores.default,1);assert.equal(a.scores['never-shield'],0);assert.equal(a.min,0);assert.equal(a.max,1);assert.equal(a.spread,1);assert.equal(a.worstStyle,'never-shield');
 assert.equal(a.mean,5/6);assert.deepEqual(a.spreadInterval95,[1,1]);
 const never=a.versusDefault.find(v=>v.style==='never-shield');assert.equal(never.delta,-1);assert.equal(never.verdict,'lower');
 assert.equal(b.spread,0);assert.equal(b.scores.default,.4);assert.ok(b.versusDefault.every(v=>v.delta===0&&v.verdict==='unresolved'));
 assert.equal(a.fixtureScores[0].length,5);assert.equal(P.compact(r).teams[0].fixtureScores,undefined);
 assert.match(P.formatTable({...r,meta:null}),/Spread \[95%\]/);
});

test('a real tiny panel: six opponent styles, the default style equals the search battle, and the result validates',async()=>{
 const fixtures=searchFixtures(2,{seed:20261013}),teams=[fixtures[0][0],fixtures[1][0]],engine={...fixtures[0][4]};delete engine.seed;
 const cases=fixtures.map(f=>({team:f[1],seed:f[4].seed}));
 const run=async(jobs,{onResult})=>jobs.map((job,i)=>{const r=play(...job);onResult(r,i);return r;});
 const r=await P.runPanel({teams,ids:[[0,1,2],[3,4,5]],fixtures:cases,engine,run,seed:1,samples:200});
 assert.equal(r.fixtures.completed,2);assert.equal(r.battles,2*2*P.STYLES.length);
 for(const [t,team] of teams.entries())for(const [f,c] of cases.entries())assert.equal(r.teams[t].fixtureScores[0][f],play(team,c.team,undefined,undefined,{...engine,seed:c.seed}).score);
 // The panel block the portable report carries passes the viewer's validator.
 const variants=Array.from({length:6},(_,i)=>({speciesId:'s'+i,speciesName:'S'+i,moveset:['A','B'],recommended:['A','B']}));
 const report={format:'pvp-team-report',schemaVersion:1,engineVersion:'neural-team-search-v3',fixtureMode:'single',table:{rows:[],variants,opponents:variants,matches:{}},snapshot:{gameMaster:{pokemon:[],moves:[]},published:[],overrides:[],meta:[]},policyPanel:P.compact(r)};
 assert.doesNotThrow(()=>core.validate(report));
 assert.throws(()=>core.validate({...report,policyPanel:{...P.compact(r),teams:[{...P.compact(r).teams[0],team:[0,1,99]}]}}),/policy panel/);
 assert.throws(()=>core.validate({...report,policyPanel:{...P.compact(r),teams:[{...P.compact(r).teams[0],scores:{}}]}}),/policy panel/);
});
