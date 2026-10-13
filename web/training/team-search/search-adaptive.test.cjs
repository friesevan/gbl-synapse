'use strict';
// The real search loop with the opt-in speed options: --acquisition adaptive and --retest-panel N.
// Battles are replaced by a deterministic hash of (team, opponent, seed), so every run is exactly
// reproducible and an interruption or resume must change nothing.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {BattlePool}=require('../pool.cjs'),{search}=require('./search.cjs');
const {VERSION,dataHash,digest,teamKey,screeningSeed}=require('./common.cjs'),{fixtureKey,opponentFixtureKey}=require('./acquisition.cjs');

function testPool(poolPath){
 const gm=require('../../includes/pro/data/gamemaster.json'),published=require('../../includes/pro/data/league-1500.json').overall,used=new Set(),species=[];
 for(const row of published){const p=gm.pokemon.find(p=>p.speciesId===row.speciesId);if(!p||used.has(p.dex))continue;used.add(p.dex);species.push({speciesId:p.speciesId,speciesName:p.speciesName,dex:p.dex,types:p.types,moveset:row.moveset,weight:1,features:[.5],scoutByType:Array(18).fill(.5),scoutScore:.5,ivs:{atk:0,def:15,hp:15},cp:1500,level:30});if(species.length===6)break;}
 const prepared={config:{version:VERSION,cp:1500,inputHash:dataHash(),movesets:1},species,variants:species};prepared.hash=digest(prepared);fs.writeFileSync(poolPath,JSON.stringify(prepared));return {species,prepared};
}
const REAL_MAP=BattlePool.prototype.map,identityOf=(team,opponent,seed)=>digest([team.map(p=>p.speciesId),opponent.map(p=>p.speciesId),seed]);
const listeners=Object.fromEntries(['SIGINT','SIGTERM'].map(signal=>[signal,process.listeners(signal)]));
const dropListeners=()=>{for(const signal of ['SIGINT','SIGTERM'])for(const listener of process.listeners(signal))if(!listeners[signal].includes(listener))process.removeListener(signal,listener);};
const read=(out,name='checkpoint.json')=>JSON.parse(fs.readFileSync(path.join(out,name)));
const stable=state=>({observations:state.observations,records:state.records,battles:state.battles,round:state.round,pending:state.pending,retestPanel:state.retestPanel||null,
 history:state.history.map(h=>({round:h.round,battles:h.battles,teams:h.teams,bestTraining:h.bestTraining,proposalScores:h.proposalScores,acquisition:h.acquisition,retestPanel:h.retestPanel||null}))});

// Install a deterministic battle mock. Non-battle jobs (neural fits) still use the real pool.
function mockBattles({interruptAt=Infinity,strongSpecies=null}={}){
 const original=REAL_MAP,log={played:[]};
 BattlePool.prototype.map=async function(jobs,options={}){
  if(jobs.length&&!Array.isArray(jobs[0][0]))return original.call(this,jobs,options);
  const {onResult=()=>{}}=options,results=[];
  for(let i=0;i<jobs.length;i++){
   const [team,opponent,,,settings]=jobs[i],id=identityOf(team,opponent,settings.seed);log.played.push(id);
   // Default: a pseudo-random win/draw/loss. With `strongSpecies`, teams containing it win almost always,
   // the others almost never, so there is something for the adaptive rule to separate.
   const noise=parseInt(id.slice(2,8),16)/0x1000000,score=strongSpecies?(noise<(team.some(p=>p.speciesId===strongSpecies)?.95:.05)?1:0):parseInt(id.slice(0,2),16)%3/2;
   const result={score};results.push(result);onResult(result,i);
   if(log.played.length===interruptAt)throw Error('Injected interruption');
  }
  return results;
 };
 return {log,restore:()=>{BattlePool.prototype.map=REAL_MAP;}};
}
const base=poolPath=>({pool:poolPath,hours:1,workers:1,initialTeams:8,batchTeams:4,opponents:6,acquisitionFixtures:1,promotionFraction:.5,screenTeams:2,screenOpponents:2,validationTeams:1,validationOpponents:2,baselineCount:3,candidates:8,epochs:1,hidden:4,ensemble:1,referenceOpponents:2,fitFixtures:16,seed:123,validationSeed:902,rounds:1,meta:'independent',lookaheadTurns:4,decisionInterval:4,beliefSamples:1});

test('adaptive acquisition resumes from an interruption inside any level and reproduces the uninterrupted run',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-adaptive-')),poolPath=path.join(directory,'source-pool.json');testPool(poolPath);
 const {species}=testPool(poolPath),strongSpecies=species[0].speciesId,opts={...base(poolPath),opponents:16,acquisitionFixtures:2,promotionFraction:.25,acquisition:'adaptive',acquisitionStep:4};
 try{
  let mock=mockBattles({strongSpecies});const whole=path.join(directory,'whole');await search({...opts,out:whole});dropListeners();const uninterrupted=read(whole),reference=mock.log.played.slice();mock.restore();
  const config=uninterrupted.config,acquisition=uninterrupted.history[0].acquisition;
  assert.equal(config.acquisition,'adaptive');assert.equal(config.acquisitionStep,4);assert.equal(acquisition.mode,'adaptive');assert.equal(acquisition.step,4);
  assert.equal(acquisition.levels[0].fixtures,2);assert.equal(acquisition.levels[0].teams,8);assert.ok(acquisition.levels.length>=2,'the rule extended at least one level');
  assert.ok(acquisition.levels.every((l,i)=>i===0||(l.fixtures>acquisition.levels[i-1].fixtures&&l.teams<=acquisition.levels[i-1].teams)));
  assert.equal(acquisition.labeledFixtures,uninterrupted.observations.length);assert.ok(acquisition.labeledFixtures<acquisition.maximumFixtures,'fewer battles than full allocation');
  assert.equal(new Set(uninterrupted.observations.map(o=>fixtureKey(o.team,o.opponent,o.seed))).size,uninterrupted.observations.length);
  assert.equal(uninterrupted.pending,null);assert.ok(uninterrupted.history[0].proposalScores.every(row=>row.fixturesPerTeam===2),'diagnostics stay on the shared first prefix');
  // Every candidate keeps the common first fixture.
  const first=new Map();for(const o of uninterrupted.observations)first.set(teamKey(o.team),(first.get(teamKey(o.team))||0)+1);assert.ok([...first.values()].every(n=>n>=1)&&first.size===8);
  for(const stopAt of [3,8,11,23,40,61]){
   if(stopAt>=reference.length)continue;
   const out=path.join(directory,'stop'+stopAt);mock=mockBattles({interruptAt:stopAt,strongSpecies});
   await assert.rejects(search({...opts,out}),/Injected interruption/);dropListeners();
   const partial=read(out);assert.equal(partial.battles,stopAt);assert.ok(partial.pending,'the round is saved mid-way');assert.ok(['screening','extending'].includes(partial.pending.stage));
   const played=mock.log.played.slice();mock.restore();
   const resumed=mockBattles({strongSpecies});resumed.log.played.push(...played);await search({...opts,out,resume:true});dropListeners();
   assert.deepEqual(stable(read(out)),stable(uninterrupted),'stop at '+stopAt);assert.deepEqual(resumed.log.played,reference,'no battle replayed, same dispatch order at '+stopAt);resumed.restore();
  }
  // Defaults are untouched: a staged run records none of the new settings.
  mock=mockBattles({strongSpecies});const staged=path.join(directory,'staged');await search({...base(poolPath),out:staged});dropListeners();mock.restore();
  const stagedConfig=read(staged).config;assert.ok(!('acquisition' in stagedConfig)&&!('acquisitionStep' in stagedConfig)&&!('retestPanel' in stagedConfig)&&!('retestPanelSeed' in stagedConfig));
  assert.ok(!('mode' in read(staged).history[0].acquisition)&&!('retestPanel' in read(staged).history[0]));
  assert.ok(!('retestPanel' in read(staged,'recommendations.json'))&&!('acquisition' in read(staged,'recommendations.json')));
 }finally{BattlePool.prototype.map=REAL_MAP;dropListeners();fs.rmSync(directory,{recursive:true,force:true});}
});

test('invalid acquisition and panel settings are rejected before any battle',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-adaptive-options-')),poolPath=path.join(directory,'source-pool.json');testPool(poolPath);
 try{
  for(const [changes,message] of [[{acquisition:'greedy'},/acquisition must be/],[{acquisition:'adaptive',acquisitionStep:0},/acquisition-step/],[{acquisitionStep:1.5},/acquisition-step/],[{acquisitionMargin:-1},/acquisition-margin/],[{acquisitionMargin:9},/acquisition-margin/],[{retestPanel:-1},/retest-panel/],[{retestPanel:2.5},/retest-panel/]]){
   await assert.rejects(search({...base(poolPath),...changes,out:path.join(directory,'bad-'+Math.random().toString(36).slice(2))}),message);dropListeners();
  }
 }finally{BattlePool.prototype.map=REAL_MAP;dropListeners();fs.rmSync(directory,{recursive:true,force:true});}
});

test('the retest panel gives the incumbent and every retested team the same fixtures, and survives an interruption mid-panel',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-panel-')),poolPath=path.join(directory,'source-pool.json'),{species}=testPool(poolPath);
 const opts={...base(poolPath),initialTeams:16,batchTeams:4,opponents:4,acquisitionFixtures:2,candidates:32,epochs:2,ensemble:3,referenceOpponents:4,fitFixtures:64,rounds:3,retestPanel:3};
 try{
  let mock=mockBattles();const whole=path.join(directory,'whole');await search({...opts,out:whole});dropListeners();const state=read(whole),recommendations=read(whole,'recommendations.json'),reference=mock.log.played.slice();mock.restore();
  const panel=state.retestPanel,screening=screeningSeed(opts.validationSeed);
  assert.equal(state.config.retestPanel,3);assert.ok(![opts.validationSeed,screening].includes(state.config.retestPanelSeed>>>0));assert.equal(panel.seed,state.config.retestPanelSeed);
  assert.equal(panel.fixtures,3);assert.ok(Object.keys(panel.scores).length>=2,'incumbent and at least one retested team');
  for(const [key,scores] of Object.entries(panel.scores)){assert.equal(scores.length,3);assert.ok(scores.every(Number.isFinite),'complete panel for '+key);assert.deepEqual(panel.teams[key].length,3);}
  // Panel outcomes are ordinary labelled fixtures, tagged, never duplicated, never sealed evaluation fixtures.
  const tagged=state.observations.filter(o=>o.source==='retest-panel');assert.equal(tagged.length,Object.keys(panel.scores).length*3);
  assert.equal(new Set(state.observations.map(o=>fixtureKey(o.team,o.opponent,o.seed))).size,state.observations.length);
  const sealed=new Set(Object.values(state.fixturePanels).flat().map(c=>opponentFixtureKey(c.team,c.seed)));assert.ok(state.observations.every(o=>!sealed.has(opponentFixtureKey(o.opponent,o.seed))));
  for(const [key,scores] of Object.entries(panel.scores)){const own=tagged.filter(o=>teamKey(o.team)===key);assert.ok(own.every(o=>scores.includes(o.score)));}
  // Every round recorded the incumbent's panel; later rounds compare it with the retested contender.
  assert.ok(state.history.every(h=>h.retestPanel&&h.retestPanel.fixtures===3));assert.equal(state.history[0].retestPanel.comparisons.length,0);
  const compared=state.history.flatMap(h=>h.retestPanel.comparisons);assert.ok(compared.length>=1,'a contender was compared');
  for(const c of compared){assert.equal(c.fixtures,3);assert.equal(c.interval95.length,2);assert.ok(['incumbent-better','contender-better','unresolved'].includes(c.standing));}
  assert.equal(recommendations.retestPanel.fixtures,3);assert.ok(recommendations.retestPanel.comparisons.length>=1);assert.equal(recommendations.retestPanel.teams,Object.keys(panel.scores).length);
  const retested=state.history.slice(1).length;assert.ok(retested>=1);
  // Interrupt inside the first panel stage (after two panel battles) and resume.
  const panelIdentities=new Set(tagged.map(o=>identityOf(o.team.map(i=>species[i]),o.opponent.map(id=>({speciesId:id})),o.seed))),firstPanel=reference.findIndex(id=>panelIdentities.has(id));
  assert.ok(firstPanel>0);
  for(const offset of [1,2]){
   const out=path.join(directory,'stop'+offset);mock=mockBattles({interruptAt:firstPanel+offset});
   await assert.rejects(search({...opts,out}),/Injected interruption/);dropListeners();
   const partial=read(out);assert.equal(partial.pending.stage,'panel');assert.ok(partial.pending.panelTeams.length>=1);
   const played=mock.log.played.slice();mock.restore();const resumed=mockBattles();resumed.log.played.push(...played);
   await search({...opts,out,resume:true});dropListeners();
   assert.deepEqual(stable(read(out)),stable(state),'panel stop +'+offset);assert.deepEqual(resumed.log.played,reference);
   assert.deepEqual(read(out,'recommendations.json').retestPanel,recommendations.retestPanel);resumed.restore();
  }
 }finally{BattlePool.prototype.map=REAL_MAP;dropListeners();fs.rmSync(directory,{recursive:true,force:true});}
});
