'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {random}=require('../utils.cjs');
const TYPES=['bug','dark','dragon','electric','fairy','fighting','fire','flying','ghost','grass','ground','ice','normal','poison','psychic','rock','steel','water'];
const VERSION='neural-team-search-v4',FEATURE_VERSION='team-features-v4-canonical-bench';
let moveMap;
function moveEffects(row){
 if(!moveMap){const gm=require('../../includes/pro/data/gamemaster.json');moveMap=new Map(gm.moves.map(m=>[m.moveId,m]));}
 const values=[];for(let i=1;i<=3;i++){const m=moveMap.get(row.moveset?.[i]),chance=Number(m?.buffApplyChance)||0,both=m?.buffTarget==='both',self=both?m.buffsSelf:m?.buffTarget==='self'?m.buffs:null,opponent=both?m.buffsOpponent:m?.buffTarget==='opponent'?m.buffs:null;values.push((self?.[0]||0)*chance/4,(self?.[1]||0)*chance/4,(opponent?.[0]||0)*chance/4,(opponent?.[1]||0)*chance/4);}
 values.push(row.speciesId?.includes('_shadow')?1:0);return values;
}

const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Fingerprint simulator code as well as data, preventing reuse across changed mechanics.
function sourceMechanicsHash({version='v2'}={}){const root=path.resolve(__dirname,'..'),vendor=path.resolve(root,'../includes/pro/vendor');const files=[...['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'].map(n=>path.join(vendor,n+'.js')),path.join(root,'engine.cjs'),...(version==='v1'?[]:[...(version==='v4'?[path.join(root,'engine-v4-core.cjs'),path.join(root,'engine-v4.cjs'),path.join(root,'next/lookahead-v4.js'),path.join(root,'next/observations.js'),path.join(root,'battle-worker-v4.cjs')]:[path.join(root,'engine-v2-core.cjs'),path.join(root,'engine-v2.cjs'),path.join(root,'next/lookahead.js'),path.join(root,'battle-worker-v2.cjs')])]),path.join(root,'utils.cjs'),path.join(root,'vendor/TrainingAI.js'),path.join(root,'vendor/Player.js'),path.join(root,'vendor/aiArchetypes.json')];return digest(files.map(f=>[path.basename(f),fs.readFileSync(f,'utf8')]));}
// Only exact, parity-verified implementation snapshots share a mechanics ID.
// Any future source change gets a new hash until it passes the same validation.
function mechanicsHash({version='v2'}={}){const source=sourceMechanicsHash({version});const verified=require('../simulator-compatibility.json');return verified.sources?.[version]?.[source]||source;}
function dataHash(){const base=path.resolve(__dirname,'../../includes/pro/data');return digest([require(base+'/league-1500.json').overall,require(base+'/overrides-1500.json'),require(base+'/gamemaster.json')]);}
function algorithmHash(){const names=['search.cjs','common.cjs','neural.cjs','interaction.cjs','fit-interaction.cjs','interaction-worker.cjs','propose.cjs','acquisition.cjs','retest-panel.cjs','sensitivity.cjs','seed-teams.cjs','predict.cjs','predict-worker.cjs','evaluation.cjs','budget.cjs','meta.cjs','../runner.cjs','../active-clock.cjs'];return digest([names.map(name=>[name,fs.readFileSync(path.join(__dirname,name),'utf8')]),sourceMechanicsHash({version:'v4'})]);}
function screeningSeed(validationSeed){let result=parseInt(digest(['screening',validationSeed]).slice(0,8),16)||1;if(result===validationSeed)result=(result^0x5a5a5a5a)>>>0||1;return result;}
function freshEvaluationSeeds(validationSeed,used=[]){return !used.includes(validationSeed)&&!used.includes(screeningSeed(validationSeed));}
// random() normalizes to unsigned 32 bits, including valid seed zero. Preserve
// historical valid formulas and streams unless they alias a sealed panel.
function guardedSeed(seed,reserved=[]){
 if(!Number.isInteger(seed)||!Number.isFinite(seed))throw Error('Seed must be a finite integer');
 const blocked=new Set(reserved.map(value=>value>>>0));let normalized=seed>>>0;
 if(!blocked.has(normalized))return normalized;
 do{normalized=(normalized+1)>>>0;}while(blocked.has(normalized));return normalized;
}
function nextRound(state){return (state.observations||[]).reduce((round,o)=>Number.isInteger(o.round)?Math.max(round,o.round+1):round,state.round||0);}
function sampleFixtures(rows,cap,r){if(!Number.isInteger(cap)||cap<1)throw Error('Fixture sample cap must be positive');if(rows.length<=cap)return rows;const out=rows.slice();for(let i=0;i<cap;i++){const j=i+Math.floor(r()*(out.length-i));[out[i],out[j]]=[out[j],out[i]];}return out.slice(0,cap);}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);}
function population(published,overrides,n=300){
 const weights=new Map(overrides.map(r=>[r.speciesId,r.weight]));
 return published.map((r,i)=>({...r,rank:i+1,weight:Number.isFinite(weights.get(r.speciesId))?weights.get(r.speciesId):1})).filter(r=>r.weight>0).sort((a,b)=>b.weight-a.weight||a.rank-b.rank).slice(0,n);
}
function validTeam(team,variants){return team.length===3&&new Set(team.map(i=>variants[i]?.dex)).size===3&&team.every(i=>Number.isInteger(i)&&i>=0&&i<variants.length);}
const canonicalTeam=team=>[team[0],...team.slice(1).sort((a,b)=>a-b)];
const teamKey=team=>canonicalTeam(team).join(',');
function randomTeam(variants,r){const team=[];for(let tries=0;team.length<3&&tries<10000;tries++){const i=Math.floor(r()*variants.length);if(!team.some(j=>variants[j].dex===variants[i].dex))team.push(i);}if(!validTeam(team,variants))throw Error('Need three distinct Pokédex numbers');return canonicalTeam(team);}
function mutateTeam(team,variants,r){const t=team.slice();if(r()<.25){const a=Math.floor(r()*3),b=(a+1+Math.floor(r()*2))%3;[t[a],t[b]]=[t[b],t[a]];}else{const slot=Math.floor(r()*3);for(let n=0;n<1000;n++){const i=Math.floor(r()*variants.length);if(t.every((j,k)=>k===slot||variants[j].dex!==variants[i].dex)){t[slot]=i;break;}}}return canonicalTeam(t);}
function weightedTeam(species,r){const chosen=[],weights=species.map(s=>s.weight);for(let k=0;k<3;k++){
 const total=species.reduce((sum,s,i)=>sum+(chosen.some(c=>c.dex===s.dex)?0:weights[i]),0);if(!(total>0))throw Error('Opponent pool needs three distinct Pokédex numbers');let x=r()*total,index=-1;
 for(let i=0;i<species.length;i++){if(chosen.some(c=>c.dex===species[i].dex))continue;x-=weights[i];if(x<0){index=i;break;}}
 if(index<0)index=species.findIndex(s=>!chosen.some(c=>c.dex===s.dex));chosen.push(species[index]);
}return chosen;}
function fixtures(species,n,seed){const r=random(seed);return Array.from({length:n},()=>({team:weightedTeam(species,r),seed:Math.floor(r()*0xffffffff)}));}
function features(team,variants){
 if(!validTeam(team,variants))throw Error('Invalid team');const rows=[variants[team[0]],...team.slice(1).map(i=>variants[i]).sort((a,b)=>String(a.speciesId||a.dex).localeCompare(String(b.speciesId||b.dex))||(a.moveset||[]).join('|').localeCompare((b.moveset||[]).join('|')))],base=rows.flatMap(r=>[...r.features,...moveEffects(r)]);
 // Explicit team coverage helps the MLP learn synergy from limited expensive labels.
 for(let i=0;i<TYPES.length;i++)base.push(Math.max(...rows.map(r=>r.scoutByType[i])),Math.min(...rows.map(r=>r.scoutByType[i])));
 return base;
}
function options(args,defaults){const o={...defaults};for(let i=0;i<args.length;i++){const a=args[i];if(a==='--resume'){o.resume=true;continue;}if(a==='--help'){o.help=true;continue;}const k=a.replace(/^--/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());if(!a.startsWith('--')||!(k in defaults)||args[i+1]===undefined)throw Error('Unknown argument '+a);o[k]=typeof defaults[k]==='number'?Number(args[++i]):args[++i];}return o;}
module.exports={TYPES,VERSION,FEATURE_VERSION,moveEffects,digest,mechanicsHash,sourceMechanicsHash,dataHash,algorithmHash,screeningSeed,freshEvaluationSeeds,guardedSeed,nextRound,sampleFixtures,atomic,population,validTeam,canonicalTeam,teamKey,randomTeam,mutateTeam,weightedTeam,fixtures,features,options};
