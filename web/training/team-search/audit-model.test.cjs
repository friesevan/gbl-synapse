'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {splitByTeam,correlation}=require('./audit-model.cjs');const {teamKey}=require('./common.cjs');
test('held-out split keeps every lead/bench-equivalent candidate identity in one partition',()=>{
 const rows=Array.from({length:50},(_,i)=>[{team:[i,i+70,i+130]},{team:[i,i+130,i+70]}]).flat();
 for(let fold=0;fold<5;fold++){const {training,test}=splitByTeam(rows,fold),trainKeys=new Set(training.map(r=>teamKey(r.team))),testKeys=new Set(test.map(r=>teamKey(r.team)));assert.ok(training.length&&test.length);for(const k of trainKeys)assert.equal(testKeys.has(k),false);assert.equal(training.length+test.length,rows.length);}
});
test('rank correlation handles ties and undefined constant rankings',()=>{assert.equal(correlation([1,2,2,4],[1,3,3,8]),1);assert.equal(correlation([1,2,3],[3,2,1]),-1);assert.equal(correlation([1,1],[1,2]),null);});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseVariants,loadObservations,audit,format,PRESETS}=require('./audit-model.cjs'),H=require('./holdout.cjs'),{digest}=require('./common.cjs');
test('variant specifications accept presets and explicit overrides and reject nonsense',()=>{
 const base={hidden:16,epochs:6,l2:1,rank:0};
 assert.deepEqual(parseVariants('',base),[{name:'base',...base}]);
 const list=parseVariants('base;h32;l2x3;e9;rank4;hidden=24,epochs=9,rank=2',base);
 assert.deepEqual(list.map(v=>v.name),['base','h32','l2x3','e9','rank4','hidden=24,epochs=9,rank=2']);
 assert.equal(list[1].hidden,32);assert.equal(list[2].l2,3);assert.equal(list[3].epochs,9);assert.equal(list[4].rank,4);assert.deepEqual([list[5].hidden,list[5].epochs,list[5].rank],[24,9,2]);
 assert.equal(list[1].epochs,6,'unchanged settings keep the command-line values');
 assert.deepEqual(parseVariants('h24',{...base,epochs:3})[0],{name:'h24',hidden:24,epochs:3,l2:1,rank:0});
 for(const bad of ['nonsense','hidden=x','rank=20','rank=-1','hidden=0','epochs=1.5','l2=-1','base;base','color=3'])assert.throws(()=>parseVariants(bad,base),/variant|Variant/,bad);
 for(const name of Object.keys(PRESETS))assert.doesNotThrow(()=>parseVariants(name,base),name);
});

test('the published v1 per-team data loads as fixture observations',()=>{
 const dir=path.join(__dirname,'../../includes/pro/data/team-teams'),index=JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'));
 const {rows,source}=loadObservations({v1:dir,pool:{variants:index.variants}});
 assert.equal(rows.length,index.counts.trainingFixtures);assert.equal(source.kind,'published-v1');assert.equal(source.observedMeta,false);
 const sample=rows[12345];assert.equal(sample.team.length,3);assert.equal(sample.opponent.length,3);assert.ok(sample.opponent.every(id=>typeof id==='string'));assert.ok(rows.every(r=>r.score>=0&&r.score<=1));
 assert.equal(new Set(rows.map(r=>r.team.join(','))).size<=index.rows.length,true);
 // Both holdout designs have something on each side.
 for(const grouping of H.GROUPINGS){const {training,test}=H.split(rows,{grouping});assert.ok(training.length>1000&&test.length>100,grouping);}
 assert.throws(()=>loadObservations({v1:dir,pool:{variants:index.variants.slice(1)}}),/do not match the pool/);
 const swapped=index.variants.map((v,i)=>i===0?{...v,moveset:['X','Y','Z']}:v);assert.throws(()=>loadObservations({v1:dir,pool:{variants:swapped}}),/do not match the pool/);
});

// A synthetic pool and checkpoint small enough to fit in a second, with a planted strength so that fitting has something to find.
function syntheticAudit(directory,{models=0}={}){
 const gm=require('../../includes/pro/data/gamemaster.json'),published=require('../../includes/pro/data/league-1500.json').overall,used=new Set(),species=[];
 for(const row of published){const p=gm.pokemon.find(p=>p.speciesId===row.speciesId);if(!p||used.has(p.dex))continue;used.add(p.dex);const i=species.length;species.push({speciesId:p.speciesId,speciesName:p.speciesName,dex:p.dex,types:p.types,moveset:row.moveset,weight:1,features:[i/12,(i*5%12)/12],scoutByType:Array.from({length:18},(_,t)=>((i+t)%12)/12),scoutScore:.5,ivs:{atk:0,def:15,hp:15},cp:1500,level:30});if(species.length===12)break;}
 const pool={config:{version:'neural-team-search-v4',cp:1500,movesets:1},species,variants:species};pool.hash=digest(pool);
 const r=require('../utils.cjs').random(5),pick=()=>{const ids=[];while(ids.length<3){const i=Math.floor(r()*12);if(!ids.includes(i))ids.push(i);}return ids;};
 const teams=Array.from({length:40},pick),opponents=Array.from({length:30},()=>pick().map(i=>species[i].speciesId));
 const strength=ids=>ids.reduce((s,i)=>s+i,0)/36,observations=[];
 for(const team of teams)for(let k=0;k<50;k++){const opponent=opponents[Math.floor(r()*opponents.length)],p=1/(1+Math.exp(-3*(strength(team)-strength(opponent.map(id=>species.findIndex(s=>s.speciesId===id))))));observations.push({team,opponent,score:r()<p?1:0,seed:k,round:0});}
 const poolFile=path.join(directory,'pool.json'),checkpoint=path.join(directory,'checkpoint.json');
 fs.writeFileSync(poolFile,JSON.stringify(pool));const {Network}=require('./interaction.cjs'),width=require('./common.cjs').features([0,1,2],pool.variants).length;fs.writeFileSync(checkpoint,JSON.stringify({config:{poolHash:pool.hash,mechanicsHash:'test',features:'test',meta:{}},observations,models:Array.from({length:models},(_,i)=>new Network(width,6,50+i).toJSON())}));
 return {poolFile,checkpoint,pool,observations};
}

test('the audit fits every grouping and variant, scores only held-out fixtures, writes a resumable report and pairs variants with the baseline',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-audit-')),{poolFile,checkpoint,observations}=syntheticAudit(directory),out=path.join(directory,'audit.json');
 try{
  const opts={checkpoint,pool:poolFile,grouping:'candidate,opponent,block',variants:'base;rank2;l2x3',cap:400,hidden:6,epochs:2,ensemble:2,workers:1,repeats:2,referenceOpponents:8,bootstrap:'fixture',minTeamFixtures:1,seed:11,out,quiet:true};
  const report=await audit(opts);
  assert.equal(report.results.length,3*3*2);assert.equal(report.groupings.join(),'candidate,opponent,block');assert.equal(report.reference,'pool','a checkpoint without an observed meta uses the pool weights');
  for(const grouping of H.GROUPINGS){
   const rows=report.results.filter(r=>r.grouping===grouping),{training,test,dropped}=H.split(observations,{grouping});
   assert.equal(rows.length,6);assert.ok(rows.every(r=>r.trainingFixtures===training.length&&r.heldoutFixtures===test.length&&r.droppedFixtures===dropped));
   assert.ok(rows.every(r=>r.fitFixtures===Math.min(400,training.length)));
   for(const r of rows){for(const key of ['pairMSE','constantPairMSE','logLoss','constantLogLoss','teamMSE','conditionalTeamMSE','constantTeamMSE','noiseFloorTeamMSE','explainedVariance','meanFixtureSD','meanEnsembleSD'])assert.ok(Number.isFinite(r[key]),grouping+' '+key);assert.ok(r.pairMSE>0&&r.pairMSE<.5);}
   assert.ok(rows.every(r=>r.rank===(r.variant==='rank2'?2:0)&&r.l2===(r.variant==='l2x3'?3:1)));
  }
  assert.ok(report.results.filter(r=>r.grouping==='block').every(r=>r.droppedFixtures>0),'the block design drops the mixed fixtures');
  // The fitted data of the block design excludes every held-out identity of either kind.
  const block=H.split(observations,{grouping:'block'}),seenTeams=new Set(block.training.map(r=>r.team.join())),seenOpps=new Set(block.training.map(r=>H.opponentKey(r.opponent)));
  assert.ok(block.test.every(r=>!seenOpps.has(H.opponentKey(r.opponent))&&![...seenTeams].some(k=>k===require('./common.cjs').teamKey(r.team))));
  // Paired summary: base has no comparison, the others do, on the same repeats.
  const summary=report.summary;assert.equal(summary.length,9);
  assert.equal(summary.find(e=>e.variant==='base'&&e.grouping==='opponent').versusBaseline,null);
  const rank2=summary.find(e=>e.variant==='rank2'&&e.grouping==='candidate');assert.equal(rank2.versusBaseline.pairMSE.repeats,2);assert.equal(rank2.versusBaseline.pairMSE.improvements.length,2);
  // l2 = 3 changes the fit; rank 2 changes the model; the baseline repeats differ from each other (different seeds and samples are not forced equal).
  const same=(a,b)=>report.results.find(r=>r.grouping==='candidate'&&r.variant===a&&r.repeat===0).pairMSE===report.results.find(r=>r.grouping==='candidate'&&r.variant===b&&r.repeat===0).pairMSE;
  assert.equal(same('base','rank2'),false);assert.equal(same('base','l2x3'),false);
  // The report on disk matches, and printing it names each section.
  const saved=JSON.parse(fs.readFileSync(out,'utf8'));assert.equal(saved.results.length,18);assert.equal(saved.configHash,report.configHash);
  const text=format(saved);for(const word of ['candidate holdout','opponent holdout','block holdout','paired improvement over base','calibration of base'])assert.match(text,new RegExp(word));
  // Resuming with the same settings refits nothing (the saved fit times come back unchanged); different settings are refused.
  const again=await audit({...opts,resume:true});assert.deepEqual(again.results.map(r=>r.fitSeconds),report.results.map(r=>r.fitSeconds));assert.equal(again.results.length,18);
  await assert.rejects(()=>audit({...opts,resume:true,cap:300}),/different settings/);
  // Drawing a new sample per repeat is an option; the run completes with the same number of fits.
  const resampled=await audit({...opts,variants:'base',resample:1,out:''});assert.equal(resampled.results.length,6);
  await assert.rejects(()=>audit({...opts,grouping:'both'}),/grouping must be/);
  await assert.rejects(()=>audit({...opts,checkpoint:'',v1:''}),/Pass --pool/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('the checkpoint\'s own fitted models can be scored without refitting, on the holdout they were fitted under',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-audit-saved-')),{poolFile,checkpoint}=syntheticAudit(directory,{models:3});
 try{
  const opts={checkpoint,pool:poolFile,grouping:'candidate,opponent',variants:'base',cap:300,hidden:6,epochs:1,ensemble:2,workers:1,repeats:1,referenceOpponents:8,bootstrap:'fixture',minTeamFixtures:1,seed:11,quiet:true,saved:1};
  const report=await audit(opts),saved=report.results.filter(r=>r.variant==='saved');
  assert.equal(saved.length,1,'only the candidate holdout is honest for models fitted with candidate fold 0 held out');assert.equal(saved[0].grouping,'candidate');assert.equal(saved[0].ensemble,3);assert.equal(saved[0].bootstrap,'saved');
  assert.ok(Number.isFinite(saved[0].pairMSE)&&Number.isFinite(saved[0].teamMSE));assert.ok(saved[0].calibration===null||saved[0].calibration.teams>0);
  assert.equal(report.results.length,3,'one saved evaluation plus the base fit for each holdout');
  assert.match(format(report),/saved/);
  const other=await audit({...opts,fold:1,grouping:'candidate'});assert.equal(other.results.some(r=>r.variant==='saved'),false,'a different fold has no honest saved-model evaluation');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
 const bare=fs.mkdtempSync(path.join(os.tmpdir(),'pvp-audit-nosaved-')),made=syntheticAudit(bare);
 try{await assert.rejects(()=>audit({checkpoint:made.checkpoint,pool:made.poolFile,saved:1,quiet:true,cap:100,ensemble:1,workers:1,repeats:1,hidden:4,epochs:1}),/needs a checkpoint with fitted models/);}finally{fs.rmSync(bare,{recursive:true,force:true});}
});
