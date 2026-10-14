#!/usr/bin/env node
'use strict';
// Frozen-data diagnostics only. Never feeds held-out teams into fitting or proposal generation.
// Grouped holdouts (holdout.cjs): by candidate identity, by opponent team identity, or both at once (block);
// calibration of the ensemble spread against the held-out error (calibration.cjs); and model variants
// (hidden width, weight decay, epochs, low-rank antisymmetric interaction) compared on those holdouts.
const fs=require('node:fs'),path=require('node:path');
const {features,teamKey,digest,fixtures,sampleFixtures,options}=require('./common.cjs');
const {fitParallel}=require('./fit-interaction.cjs');
const {Network,logit,predict,reference}=require('./interaction.cjs');
const {random}=require('../utils.cjs');
const {ranks,spearman:correlation}=require('./calibration.cjs');
const H=require('./holdout.cjs');
function splitByTeam(rows,fold=0){
 if(!Number.isInteger(fold)||fold<0||fold>4)throw Error('fold must be 0–4');
 const {training,test}=H.split(rows,{grouping:'candidate',fold});return {training,test};
}
// Named variants for --variants (separated by ';'); a token may also be 'hidden=24,epochs=9' style overrides.
const PRESETS={base:{},h24:{hidden:24},h32:{hidden:32},l2x3:{l2:3},e9:{epochs:9},rank1:{rank:1},rank2:{rank:2},rank4:{rank:4},rank8:{rank:8}};
const VARIANT_KEYS=['hidden','epochs','l2','rank'];
function parseVariants(text,defaults){
 const tokens=String(text||'').split(';').map(s=>s.trim()).filter(Boolean);if(!tokens.length)tokens.push('base');
 const out=[];
 for(const token of tokens){
  let changes;
  if(PRESETS[token])changes=PRESETS[token];
  else{changes={};for(const part of token.split(',')){const [key,value]=part.split('=');if(!VARIANT_KEYS.includes(key)||value===undefined||!Number.isFinite(Number(value)))throw Error('Unknown variant '+token+' (presets: '+Object.keys(PRESETS).join(', ')+'; or '+VARIANT_KEYS.join('=N,')+'=N)');changes[key]=Number(value);}}
  const variant={name:token,...defaults,...changes};
  if(!Number.isInteger(variant.hidden)||variant.hidden<1||!Number.isInteger(variant.epochs)||variant.epochs<1||!Number.isInteger(variant.rank)||variant.rank<0||variant.rank>variant.hidden||!Number.isFinite(variant.l2)||variant.l2<0)throw Error('Invalid variant '+token);
  if(out.some(v=>v.name===variant.name))throw Error('Duplicate variant '+token);out.push(variant);
 }
 return out;
}
// Fixture observations {team, opponent, score} from a search checkpoint or from the published v1 per-team data.
function loadObservations({checkpoint,v1,pool}){
 if(checkpoint){
  const raw=fs.readFileSync(checkpoint,'utf8'),state=JSON.parse(raw);if(state.config.poolHash!==pool.hash)throw Error('Checkpoint pool mismatch');
  return {rows:state.observations,models:state.models||[],source:{kind:'checkpoint',hash:digest(raw),mechanicsHash:state.config.mechanicsHash,features:state.config.features,observedMeta:(state.config.meta?.observedCount||0)>0}};
 }
 const dir=path.resolve(v1),index=JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'));
 if(index.variants.length!==pool.variants.length||index.variants.some((v,i)=>v.speciesId!==pool.variants[i].speciesId||v.moveset.join()!==pool.variants[i].moveset.join()||JSON.stringify(v.ivs)!==JSON.stringify(pool.variants[i].ivs)))throw Error('Published v1 variants do not match the pool');
 const chunks=new Map(),rows=[];
 for(const row of index.rows){
  if(!chunks.has(row.chunk))chunks.set(row.chunk,JSON.parse(fs.readFileSync(path.join(dir,row.chunk+'.json'),'utf8')));
  for(const [ids,seed,score] of chunks.get(row.chunk)[row.id].training)rows.push({team:row.team,opponent:ids.map(i=>index.opponents[i].speciesId),score,seed});
 }
 return {rows,models:[],source:{kind:'published-v1',hash:digest({version:index.version,mechanicsHash:index.mechanicsHash,rows:rows.length,counts:index.counts}),mechanicsHash:index.mechanicsHash,features:'team-features-v4-canonical-bench',observedMeta:false}};
}
async function audit(o={}){
 const {checkpoint='',v1='',pool:poolFile,cap=24000,hidden=16,epochs=6,ensemble=4,workers=4,seed=260109,fold=0,repeats=3,referenceOpponents=1024,bootstrap='fixture,team',l2=1,rank=0,grouping='candidate',variants='',resample=0,reference:referenceMode='auto',minTeamFixtures=1,out='',resume=false,quiet=false,saved=0}=o;
 if(!poolFile||(!checkpoint&&!v1))throw Error('Pass --pool FILE and --checkpoint FILE (or --v1 DIR)');
 if(checkpoint&&v1)throw Error('Pass either --checkpoint or --v1');
 const groupings=String(grouping).split(',').map(s=>s.trim()).filter(Boolean);for(const g of groupings)if(!H.GROUPINGS.includes(g))throw Error('grouping must be one of '+H.GROUPINGS.join(', '));
 if(!groupings.length||!['auto','pool','empirical'].includes(referenceMode)||!Number.isInteger(minTeamFixtures)||minTeamFixtures<1||!Number.isInteger(repeats)||repeats<(saved?0:1))throw Error('Invalid audit settings');
 const variantList=parseVariants(variants,{hidden,epochs,l2,rank}),modes=String(bootstrap).split(',').map(s=>s.trim()).filter(Boolean);
 const pool=JSON.parse(fs.readFileSync(poolFile,'utf8')),{rows:observations,models:savedModels,source}=loadObservations({checkpoint,v1,pool});
 if(saved&&(!savedModels.length||!checkpoint))throw Error('--saved needs a checkpoint with fitted models');
 const mode=referenceMode==='auto'?(source.observedMeta?'empirical':'pool'):referenceMode;
 const species=new Map(pool.species.map(s=>[s.speciesId,s])),own=new Map(),foes=new Map();
 const a=team=>{const k=teamKey(team);if(!own.has(k))own.set(k,features(team,pool.variants));return own.get(k);};
 const b=ids=>{const key=ids.join(',');if(!foes.has(key))foes.set(key,features([0,1,2],ids.map(id=>species.get(id))));return foes.get(key);};
 const config={source:source.hash,saved:!!saved,grouping:groupings,fold,cap,ensemble,seed,repeats,referenceOpponents,reference:mode,bootstrap:modes,resample:!!resample,minTeamFixtures,variants:variantList};
 const configHash=digest(config);let results=[];
 if(resume&&out&&fs.existsSync(path.resolve(out))){const saved=JSON.parse(fs.readFileSync(path.resolve(out),'utf8'));if(saved.configHash!==configHash)throw Error('Cannot resume: the saved audit used different settings');results=saved.results;if(!quiet)console.log('Resuming with '+results.length+' saved fits');}
 const meta={checkpointHash:source.hash,source:source.kind,poolHash:pool.hash,sourceMechanicsHash:source.mechanicsHash,sourceFeatures:source.features,fold,groupings,referenceOpponents,reference:mode,ensemble,cap,repeats,minTeamFixtures,variants:variantList,configHash,
  warning:'Adaptive held-out diagnostics on frozen historical simulator labels; not an untouched final evaluation of team win rate or new mechanics. Ensemble standard deviation is not a calibrated confidence interval, and observed team means carry sampling noise (noiseFloorTeamMSE).'};
 const report=()=>({...meta,results,summary:H.summarize(results)});
 const save=()=>{if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out)+'.tmp',JSON.stringify(report(),null,2));fs.renameSync(path.resolve(out)+'.tmp',path.resolve(out));}};
 const done=(g,v,m,r)=>results.some(x=>x.grouping===g&&x.variant===v&&x.bootstrap===m&&x.repeat===r);
 for(const g of groupings){
  const {training,test,dropped}=H.split(observations,{grouping:g,fold});if(!training.length||!test.length)throw Error('Need training and held-out identities for '+g);
  const constant=training.reduce((s,row)=>s+row.score,0)/training.length,counts={training:H.groupCounts(training),heldout:H.groupCounts(test)};
  const heldout=test.map(row=>({a:a(row.team),b:b(row.opponent),y:row.score,key:teamKey(row.team)}));
  // The reference panel stands in for the opponent meta. 'empirical' draws it from the training opponents (never a held-out one);
  // 'pool' draws independent species by the pool's weights, as the historical v1 meta did.
  const panelRandom=random(seed+9311),panel=mode==='empirical'?Array.from({length:referenceOpponents},()=>b(training[Math.floor(panelRandom()*training.length)].opponent)):fixtures(pool.species,referenceOpponents,seed+9311).map(c=>b(c.team.map(s=>s.speciesId)));
  const scoreModels=models=>{
   const caches=models.map(()=>new Map()),forward=(i,x)=>{if(!caches[i].has(x))caches[i].set(x,models[i].forward(x));return caches[i].get(x);};
   const rows=heldout.map(row=>({key:row.key,y:row.y,members:models.map((n,i)=>1/(1+Math.exp(-logit(n,forward(i,row.a),forward(i,row.b)))))}));
   const refs=reference(models,panel),inputs=new Map(heldout.map(row=>[row.key,row.a])),estimates=new Map();
   for(const [key,input] of inputs)estimates.set(key,predict(models,input,refs));
   return H.evaluate({rows,reference:estimates,constant,minTeamFixtures});
  };
  const describe=(variant,repeat,fitSeconds,bootstrapMode,extra)=>({grouping:g,variant,...extra,bootstrap:bootstrapMode,repeat,fitSeconds,trainingFixtures:training.length,droppedFixtures:dropped,heldoutTeams:counts.heldout.candidates,heldoutOpponents:counts.heldout.opponents,trainingTeams:counts.training.candidates,trainingOpponents:counts.training.opponents});
  // The checkpoint's own fitted ensemble, scored without refitting: it was fitted with candidate fold 0 held out, so only that holdout is honest for it.
  if(saved&&g==='candidate'&&fold===0&&!done(g,'saved','saved',0)){
   const models=savedModels.map(m=>Network.fromJSON(m)),result={...describe('saved',0,0,'saved',{hidden:models[0].hidden,epochs:null,l2:null,rank:models[0].rank||0,seed:null,fitFixtures:null,ensemble:models.length}),...scoreModels(models)};
   results.push(result);if(!quiet)console.log(JSON.stringify(result));save();
  }
  let sample=null;
  for(let repeat=0;repeat<repeats;repeat++){
   if(!sample||resample)sample=sampleFixtures(training,cap,random(seed+(resample?repeat*104729+1:0))).map(row=>({a:a(row.team),b:b(row.opponent),y:row.score,key:teamKey(row.team)}));
   for(const variant of variantList)for(const bootstrapMode of modes){
    if(done(g,variant.name,bootstrapMode,repeat))continue;
    const fitSeed=seed+repeat*104729,start=performance.now(),models=await fitParallel(sample,{workers,size:ensemble,hidden:variant.hidden,epochs:variant.epochs,seed:fitSeed,bootstrap:bootstrapMode,rank:variant.rank,l2:variant.l2}),fitSeconds=(performance.now()-start)/1000;
    const metrics=scoreModels(models);
    const result={...describe(variant.name,repeat,fitSeconds,bootstrapMode,{hidden:variant.hidden,epochs:variant.epochs,l2:variant.l2,rank:variant.rank,seed:fitSeed,fitFixtures:sample.length}),...metrics};
    results.push(result);if(!quiet)console.log(JSON.stringify(result));save();
   }
  }
 }
 return report();
}
const fixed=(x,d=4)=>Number.isFinite(x)?x.toFixed(d):'—',pm=(m,d=4)=>m?fixed(m.mean,d)+(m.sd===null?'':' ± '+fixed(m.sd,d)):'—',count=n=>Number.isFinite(n)?n.toLocaleString():'—';
// A text table of a saved audit: per grouping the variants' means over repeats, then each variant against the baseline on the same repeats.
function format(report){
 const lines=[];lines.push('Source '+report.source+' · fold '+report.fold+' · ensemble '+report.ensemble+' · cap '+report.cap+' · '+report.repeats+' repeats · reference panel '+report.reference+' · teams scored with at least '+report.minTeamFixtures+' held-out fixtures');
 for(const g of report.groupings){
  const rows=report.summary.filter(e=>e.grouping===g);if(!rows.length)continue;const first=report.results.find(r=>r.grouping===g&&r.variant!=='saved')||report.results.find(r=>r.grouping===g);
  lines.push('','== '+g+' holdout · '+count(first.trainingFixtures)+' training fixtures ('+count(first.fitFixtures)+' fitted) · '+count(first.heldoutFixtures)+' held-out fixtures · '+first.teams+' teams scored'+(first.droppedFixtures?' · '+count(first.droppedFixtures)+' mixed fixtures dropped':'')+' ==');
  const c=m=>fixed(rows[0].metrics[m]?.mean);
  lines.push('constant predictor: pair MSE '+c('constantPairMSE')+' · log loss '+c('constantLogLoss')+' · team MSE '+c('constantTeamMSE')+' · team noise floor '+c('noiseFloorTeamMSE'));
  lines.push(['variant','pair MSE','log loss','team MSE','cond. team MSE','explained','cond. explained','rank rho','cond. rho','team SD','fixture SD'].join(' | '));
  for(const e of rows)lines.push([e.variant,pm(e.metrics.pairMSE),pm(e.metrics.logLoss),pm(e.metrics.teamMSE),pm(e.metrics.conditionalTeamMSE),pm(e.metrics.explainedVariance,3),pm(e.metrics.conditionalExplainedVariance,3),pm(e.metrics.rankCorrelation,3),pm(e.metrics.conditionalRankCorrelation,3),pm(e.metrics.meanEnsembleSD),pm(e.metrics.meanFixtureSD)].join(' | '));
  const versus=rows.filter(e=>e.versusBaseline&&e.variant!=='saved');
  if(versus.length){lines.push('','paired improvement over base (positive is better; ✓ = every repeat better and the mean exceeds the paired sd and the base sd, ✗ = clearly worse):');
   for(const e of versus)lines.push(e.variant+': '+['pairMSE','logLoss','teamMSE','conditionalTeamMSE','explainedVariance','conditionalExplainedVariance','rankCorrelation','conditionalRankCorrelation'].map(m=>{const v=e.versusBaseline[m];return v?m+' '+(v.meanImprovement>=0?'+':'')+fixed(v.meanImprovement,/ank|xplained/.test(m)?3:5)+(v.relativeImprovement===null?'':' ('+(100*v.relativeImprovement).toFixed(1)+'%)')+(v.clearsNoise?' ✓':v.clearlyWorse?' ✗':''):m+' —';}).join(' · '));}
  for(const name of [...new Set([rows.find(e=>e.variant!=='saved')?.variant,rows.find(e=>e.variant==='saved')?.variant].filter(Boolean))]){
   const cal=report.results.filter(r=>r.grouping===g&&r.variant===name&&r.calibration);if(!cal.length)continue;
   const mean=f=>{const v=cal.map(f).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;};
   lines.push('','calibration of '+name+' (mean over '+cal.length+' fit'+(cal.length>1?'s':'')+'): k80 '+fixed(mean(r=>r.calibration.k80),2)+' · k90 '+fixed(mean(r=>r.calibration.k90),2)+' · cross-fitted coverage 80/90 '+fixed(mean(r=>r.calibration.coverage80),3)+'/'+fixed(mean(r=>r.calibration.coverage90),3)+' · coverage of ±1 spread '+fixed(mean(r=>r.calibration.coverage1),3)+' · Spearman(spread, |residual|) '+fixed(mean(r=>r.calibration.spearman),3)+' · median spread '+fixed(mean(r=>r.calibration.medianSpread))+' vs median |residual| '+fixed(mean(r=>r.calibration.medianAbsResidual)));
   const well=cal.filter(r=>r.calibration.wellMeasured);if(well.length){const wm=f=>{const v=well.map(f).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;};lines.push('  teams with at least '+well[0].calibration.wellMeasured.minFixtures+' fixtures ('+Math.round(wm(r=>r.calibration.wellMeasured.teams))+' teams): k80 '+fixed(wm(r=>r.calibration.wellMeasured.k80),2)+' · k90 '+fixed(wm(r=>r.calibration.wellMeasured.k90),2)+' · Spearman '+fixed(wm(r=>r.calibration.wellMeasured.spearman),3));}
   const na=cal.filter(r=>r.noiseAwareCalibration),nm=f=>{const v=na.map(f).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null;};
   if(na.length)lines.push("  with each team's sampling noise added to its spread: k80 "+fixed(nm(r=>r.noiseAwareCalibration.k80),2)+' · k90 '+fixed(nm(r=>r.noiseAwareCalibration.k90),2)+' · coverage of ±1 '+fixed(nm(r=>r.noiseAwareCalibration.coverage1),3));
  }
 }
 return lines.join('\n');
}
if(require.main===module){
 const argv=process.argv.slice(2);
 if(argv[0]==='--print'){const file=argv[1];if(!file){console.error('Usage: audit-model.cjs --print AUDIT.json');process.exitCode=1;}else console.log(format(JSON.parse(fs.readFileSync(path.resolve(file),'utf8'))));}
 else{const o=options(argv,{checkpoint:'',v1:'',pool:'',cap:24000,hidden:16,epochs:6,ensemble:4,workers:4,seed:260109,fold:0,repeats:3,referenceOpponents:1024,bootstrap:'fixture,team',l2:1,rank:0,grouping:'candidate',variants:'',resample:0,reference:'auto',minTeamFixtures:1,saved:0,out:''});audit(o).then(report=>console.log(format(report))).catch(e=>{console.error(e);process.exitCode=1;});}
}
module.exports={audit,splitByTeam,correlation,ranks,parseVariants,loadObservations,format,PRESETS};
