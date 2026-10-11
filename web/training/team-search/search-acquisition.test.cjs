'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {BattlePool}=require('../pool.cjs'),{search}=require('./search.cjs');
const {VERSION,dataHash,digest,teamKey,guardedSeed,screeningSeed}=require('./common.cjs'),{fixtureKey,opponentFixtureKey}=require('./acquisition.cjs');

function testPool(poolPath){
 const gm=require('../../includes/pro/data/gamemaster.json'),published=require('../../includes/pro/data/league-1500.json').overall,used=new Set(),species=[];
 for(const row of published){const p=gm.pokemon.find(p=>p.speciesId===row.speciesId);if(!p||used.has(p.dex))continue;used.add(p.dex);species.push({speciesId:p.speciesId,speciesName:p.speciesName,dex:p.dex,types:p.types,moveset:row.moveset,weight:1,features:[.5],scoutByType:Array(18).fill(.5),scoutScore:.5,ivs:{atk:0,def:15,hp:15},cp:1500,level:30});if(species.length===6)break;}
 const prepared={config:{version:VERSION,cp:1500,inputHash:dataHash(),movesets:1},species,variants:species};prepared.hash=digest(prepared);fs.writeFileSync(poolPath,JSON.stringify(prepared));return {species,prepared};
}

test('search resumes partial candidate fixtures without replay or duplicated accounting and keeps evaluation sealed',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-acquisition-')),poolPath=path.join(directory,'source-pool.json');
 const {species}=testPool(poolPath);
 const opts={pool:poolPath,hours:1,workers:1,initialTeams:8,batchTeams:4,opponents:2,acquisitionFixtures:1,promotionFraction:.5,screenTeams:2,screenOpponents:2,validationTeams:1,validationOpponents:2,baselineCount:3,candidates:8,epochs:1,hidden:4,ensemble:1,referenceOpponents:2,fitFixtures:16,seed:123,validationSeed:902,rounds:1,meta:'independent',lookaheadTurns:4,decisionInterval:4,beliefSamples:1};
 const original=BattlePool.prototype.map,listeners=Object.fromEntries(['SIGINT','SIGTERM'].map(signal=>[signal,process.listeners(signal)]));let interrupt=true,played=[];
 BattlePool.prototype.map=async function(jobs,{onResult=()=>{}}={}){const results=[];for(let i=0;i<jobs.length;i++){const [team,opponent,,,options]=jobs[i],identity=digest([team.map(p=>p.speciesId),opponent.map(p=>p.speciesId),options.seed]);played.push(identity);const result={score:parseInt(identity.slice(0,2),16)%3/2};results.push(result);onResult(result,i);if(interrupt&&played.length===3)throw Error('Injected interruption');}return results;};
 const read=out=>JSON.parse(fs.readFileSync(path.join(out,'checkpoint.json')));
 try{
  const resumed=path.join(directory,'resumed');await assert.rejects(search({...opts,out:resumed}),/Injected interruption/);
  const partial=read(resumed);assert.equal(partial.battles,3);assert.equal(partial.observations.length,3);assert.ok(partial.pending);
  interrupt=false;await search({...opts,out:resumed,resume:true});const completed=read(resumed);
  assert.equal(completed.observations.length,12);assert.equal(completed.records.reduce((sum,row)=>sum+row.fixtures,0),12);assert.equal(completed.records.reduce((sum,row)=>sum+row.games,0),12);
  assert.equal(new Set(completed.observations.map(o=>fixtureKey(o.team,o.opponent,o.seed))).size,12);assert.equal(completed.pending,null);
  assert.equal(completed.history[0].acquisition.promoted,4);assert.ok(completed.history[0].proposalScores.every(row=>row.fixturesPerTeam===1));
  assert.equal(completed.screenPanel.completedFixtures,2);assert.equal(completed.finalPanel.completedFixtures,2);
  const trainingSeeds=new Set(completed.observations.map(o=>o.seed));for(const rows of Object.values(completed.fixturePanels))assert.ok(rows.every(row=>!trainingSeeds.has(row.seed)));
  const resumedIdentities=played.slice();played=[];await search({...opts,out:path.join(directory,'uninterrupted')});const uninterrupted=read(path.join(directory,'uninterrupted'));
  assert.deepEqual(completed.records,uninterrupted.records);assert.deepEqual(completed.observations,uninterrupted.observations);assert.equal(completed.battles,uninterrupted.battles);
  assert.deepEqual(resumedIdentities,played);assert.equal(new Set(completed.records.map(r=>teamKey(r.team))).size,8);
  // Explicit CLI seeds could previously reuse the exact training/reference/
  // belief/baseline RNG stream, even when a derived round seed wraps at 2^32.
  for(const [name,seed,validationSeed] of [['training',opts.seed,opts.seed+400001],['reference',opts.seed,opts.seed+500001],['belief',opts.seed,opts.seed+620001],['baseline',opts.seed,opts.seed+700001],['wrapped-training',2**32+1-400001,1],['screening-training',screeningSeed(opts.validationSeed)-400001,opts.validationSeed]]){
   for(const signal of ['SIGINT','SIGTERM'])for(const listener of process.listeners(signal))if(!listeners[signal].includes(listener))process.removeListener(signal,listener);
   const out=path.join(directory,name);await search({...opts,seed,validationSeed,out});const result=read(out),reserved=[validationSeed,screeningSeed(validationSeed)],meta=require('./meta.cjs').createMeta(species,{mode:'independent',weightPower:1.25});
   for(const [property,offset] of [['referenceFixtureSeed',500001],['beliefFixtureSeed',620001],['baselineFixtureSeed',700001]]){assert.equal(result.config[property],guardedSeed(seed+offset,reserved));assert.ok(!reserved.includes(result.config[property]>>>0));}
   assert.deepEqual(result.beliefPrior.teams,meta.fixtures(2048,result.config.beliefFixtureSeed).map(c=>c.team.map(p=>p.speciesId)));
   const expectedTraining=new Set(meta.fixtures(opts.opponents,guardedSeed(seed+400001,reserved)).map(c=>opponentFixtureKey(c.team,c.seed))),evaluation=new Set(Object.values(result.fixturePanels).flat().map(c=>opponentFixtureKey(c.team,c.seed)));
   assert.ok(result.observations.every(o=>expectedTraining.has(opponentFixtureKey(o.opponent,o.seed))));assert.ok(result.observations.every(o=>!evaluation.has(opponentFixtureKey(o.opponent,o.seed))));
  }
  // Prospective guards cannot erase an aliased panel already inherited from an
  // older algorithm. Reject exact opponent/seed overlap, including bench order.
  const sealed=completed.fixturePanels[opts.validationSeed][0],prior={...completed,observations:[{team:completed.records[0].team,opponent:[sealed.team[0].speciesId,sealed.team[2].speciesId,sealed.team[1].speciesId],seed:sealed.seed,score:1,round:0}]},priorFile=path.join(directory,'contaminated-prior.json');fs.writeFileSync(priorFile,JSON.stringify(prior));
  await assert.rejects(search({...opts,warmStart:priorFile,out:path.join(directory,'rejected-overlap')}),/overlap inherited training evidence/);
 }finally{BattlePool.prototype.map=original;for(const signal of ['SIGINT','SIGTERM'])for(const listener of process.listeners(signal))if(!listeners[signal].includes(listener))process.removeListener(signal,listener);fs.rmSync(directory,{recursive:true,force:true});}
});

test('out-of-order battle completions and worker counts preserve exact neural models, proposals and evidence',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-acquisition-order-')),poolPath=path.join(directory,'pool-source.json');testPool(poolPath);
 const opts={pool:poolPath,hours:1,initialTeams:16,batchTeams:4,opponents:6,acquisitionFixtures:2,promotionFraction:.5,screenTeams:2,screenOpponents:2,validationTeams:1,validationOpponents:2,baselineCount:3,candidates:32,epochs:2,hidden:4,ensemble:3,referenceOpponents:4,fitFixtures:64,seed:123,validationSeed:902,rounds:2,meta:'independent',lookaheadTurns:4,decisionInterval:4,beliefSamples:1};
 const original=BattlePool.prototype.map,listeners=Object.fromEntries(['SIGINT','SIGTERM'].map(signal=>[signal,process.listeners(signal)]));let mode='ordered';const calls={ordered:[],reversed:[],interleaved:[]};
 BattlePool.prototype.map=async function(jobs,options={}){
  // Fitting uses the same pool class with non-battle payloads. Exercise the
  // actual ensemble workers and their fixed seeds rather than mocking models.
  if(jobs.length&&!Array.isArray(jobs[0][0]))return original.call(this,jobs,options);
  const {onResult=()=>{}}=options;
  const results=jobs.map(([team,opponent,,,options])=>{const key=digest([team.map(p=>p.speciesId),opponent.map(p=>p.speciesId),options.seed]);return {score:parseInt(key.slice(0,2),16)%3/2};});
  calls[mode].push(jobs.map(([team,opponent,,,options])=>digest([team.map(p=>p.speciesId),opponent.map(p=>p.speciesId),options.seed])));
  const indices=jobs.map((_,i)=>i);if(mode==='reversed')indices.reverse();if(mode==='interleaved')indices.sort((a,b)=>(b%3)-(a%3)||b-a);
  for(const index of indices)onResult(results[index],index);return results;
 };
 try{
  const states=[],recommendations=[];
  for(const [completion,workers] of [['ordered',1],['reversed',Math.min(2,require('../pool.cjs').availableCores())],['interleaved',1]]){
   mode=completion;const out=path.join(directory,completion);await search({...opts,workers,out});states.push(JSON.parse(fs.readFileSync(path.join(out,'checkpoint.json'))));recommendations.push(JSON.parse(fs.readFileSync(path.join(out,'recommendations.json'))));
   for(const signal of ['SIGINT','SIGTERM'])for(const listener of process.listeners(signal))if(!listeners[signal].includes(listener))process.removeListener(signal,listener);
  }
  assert.equal(states[0].models.length,3);assert.equal(states[0].round,2);assert.ok(states[0].history.every(row=>row.diagnostics&&row.diagnostics.trainingFixtures>=16));
  const stableDiagnostics=state=>{const result={...state.latestDiagnostics};delete result.fitSeconds;return result;};
  for(let i=1;i<states.length;i++){
   assert.deepEqual(states[i].models,states[0].models);assert.deepEqual(states[i].observations,states[0].observations);assert.deepEqual(states[i].records,states[0].records);
   assert.deepEqual(stableDiagnostics(states[i]),stableDiagnostics(states[0]));assert.deepEqual(states[i].validations,states[0].validations);assert.deepEqual(states[i].baselineResults,states[0].baselineResults);
   assert.deepEqual(states[i].history.map(row=>[row.proposalScores,row.acquisition]),states[0].history.map(row=>[row.proposalScores,row.acquisition]));assert.deepEqual(recommendations[i].rows,recommendations[0].rows);
   assert.deepEqual(calls[['ordered','reversed','interleaved'][i]],calls.ordered);
  }
 }finally{BattlePool.prototype.map=original;for(const signal of ['SIGINT','SIGTERM'])for(const listener of process.listeners(signal))if(!listeners[signal].includes(listener))process.removeListener(signal,listener);fs.rmSync(directory,{recursive:true,force:true});}
});
