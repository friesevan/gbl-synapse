#!/usr/bin/env node
'use strict';
// Regression net for the battle emulator's mechanics (team-search README section 5, "Mechanics fidelity").
//
// reference/mechanics-fixtures.json pins deterministic seeded battles, chosen from the prepared pool to exercise
// the situations where PvPoke's emulator approximates the game: charged-move priority (CMP) ties, buff chances,
// form changes, the switch clock, forced replacements, shields on both sides and Shadow Pokémon. For each battle
// it stores the complete traced outcome: score, turns, remaining, charged counts, planner statistics, the
// observation records the controller was allowed to see, every HP sample and every timeline event.
// mechanics-fixtures.test.cjs replays each battle through engine-v4 and requires exact equality, so any mechanics
// edit is caught and has to be reviewed. A fixture pins what the emulator does; it does not claim the game does
// the same. Agreement with real battles is measured separately by tests/meta-benchmark/engine-vs-footage.cjs.
//
//   node training/mechanics-fixtures.cjs                      re-run every pinned battle and report differences (read-only)
//   node training/mechanics-fixtures.cjs --write --reason "why the outcomes changed"
//                                                             rewrite the expected outcomes. Nothing is written without
//                                                             --write, and a change of any outcome also needs --reason,
//                                                             which is kept in the file's changelog
//   node training/mechanics-fixtures.cjs --select --write --reason "..." [--pool FILE] [--seed N]
//                                                             choose the battles again from the prepared pool
//                                                             (needs training/runs/team-search/pool.json)
//   --ids a,b                                                 re-run only these battles (with the file's other battles kept as they are)
//   --file FILE                                               read and write another fixture file (experiments)
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {play}=require('./engine-v4.cjs');
const {random}=require('./utils.cjs');
const FIXTURE_FILE=path.join(__dirname,'reference/mechanics-fixtures.json');
const POOL_FILE=path.join(__dirname,'runs/team-search/pool.json');
const SCHEMA='mechanics-fixtures-v1';
// Engine options as search.cjs passes them for a battle label. `trace` records HP samples and timeline events;
// `audit` makes the controller prove it never read hidden state and records the observations it was given.
const ENGINE={cp:1500,beliefSamples:3,horizon:24,interval:4};
// vendor/Player.js: a voluntary switch starts a clock of this many seconds of the emulator's clock, which also runs
// through charged-move cutscenes (sample times below are in those seconds).
const SWITCH_CLOCK_SECONDS=45;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=x=>JSON.parse(JSON.stringify(x));

// ---- replaying a pinned battle ----------------------------------------------------------------------------
const toRows=team=>team.map(([speciesId,moveset])=>({speciesId,moveset:[...moveset]}));
const beliefOf=fixture=>({beliefRoster:fixture.beliefRoster.map(([speciesId,dex,moveset,weight])=>({speciesId,dex,moveset,weight})),beliefTeams:fixture.beliefTeams});
const engineOptions=(fixture,spec,extra={})=>({...ENGINE,...beliefOf(fixture),seed:spec.seed,...extra});
// A result as stored: JSON-clean, with the audit's observation records kept apart from the planner counters
// (the production path has no `observed`, and a headless run is compared with the counters only).
function split(result){const out=plain(result),observed=out.planner?.observed;if(out.planner)delete out.planner.observed;return observed===undefined?out:{...out,observed};}
const replay=(fixture,spec,extra={})=>split(play(toRows(spec.a),toRows(spec.b),undefined,undefined,engineOptions(fixture,spec,extra)));
const tracedOutcome=(fixture,spec)=>replay(fixture,spec,{trace:true,audit:true});

// ---- what a traced battle exercised -----------------------------------------------------------------------
// Everything is derived from the stored outcome (HP samples, timeline events, planner counters) and the move
// table, so the test can check that a pinned battle still exercises what it was chosen for.
let tables;
function gameTables(){
 if(!tables){const data=require('../includes/pro/data/gamemaster.json');tables={moves:new Map(data.moves.map(m=>[m.moveId,m])),byName:new Map()};for(const m of data.moves)if(!tables.byName.has(m.name))tables.byName.set(m.name,m);}
 return tables;
}
// Timeline names are display names ("Icy Wind"); the move table is keyed by id. (Both Aura Wheels are just "Aura Wheel".)
const moveByName=name=>gameTables().byName.get(name)||null;
const buffChance=move=>Number(move.buffApplyChance);
// The active Pokémon on `side` at a battle turn: the last HP sample at or before it.
function activeAt(samples,turn,side){let row=samples[0];for(const s of samples){if(s[1]>turn)break;row=s;}return row[3][side];}
const baseId=id=>id.replace(/_shadow$/,'');
// Forms whose attack stat changes in battle: a species-level tie check would be wrong for them.
const STAT_FORMS=/^(aegislash|mimikyu|morpeko|cramorant)/;

function analyse(exp){
 const f={cmpEqualAttack:0,cmpShadowRawTie:0,cmpUnequalAttack:0,voluntarySwitches:[0,0],forcedReplacements:[0,0],switchClockExpired:[0,0],postExpirySwitches:[0,0],
  shields:[0,0],charged:[0,0],shadowActive:[0,0],buffMoves:{},forms:[]};
 const ids=exp.teamStats.map(team=>team.map(m=>m.speciesId)),rows=exp.samples,end=rows[rows.length-1][0];
 // Switches: the active species on a side changes between two HP samples. Voluntary if the Pokémon that left
 // still had HP, a forced replacement if it had fainted.
 for(const [side,team] of ids.entries()){
  let last=null;
  for(let i=1;i<rows.length;i++){
   const was=rows[i-1][3][side],now=rows[i][3][side];if(was===now)continue;
   const old=team.indexOf(was);if(old<0)continue;
   if(rows[i][2][side*3+old]>0){
    f.voluntarySwitches[side]++;
    if(end-rows[i][0]>=SWITCH_CLOCK_SECONDS)f.switchClockExpired[side]++;
    if(last!==null&&rows[i][0]-last>=SWITCH_CLOCK_SECONDS)f.postExpirySwitches[side]++;
    last=rows[i][0];
   }else f.forcedReplacements[side]++;
  }
  if(team.some(id=>/_shadow$/.test(id)&&rows.some(r=>r[3][side]===id)))f.shadowActive[side]=1;
 }
 // Charged moves: shields, buffs and forms, plus the turns on which both sides threw (a CMP decision).
 const byTurn=new Map(),forms=new Set();
 for(const e of exp.timeline){
  if(e.type==='shield')f.shields[e.actor]++;
  if(e.type==='shieldSpecial'&&e.name==='Disguise Busted')forms.add('mimikyu-busted');
  if(!e.type.startsWith('charged '))continue;
  f.charged[e.actor]++;
  const move=moveByName(e.name);
  if(move?.buffs)f.buffMoves[move.moveId]=(f.buffMoves[move.moveId]||0)+1;
  if(!byTurn.has(e.turn))byTurn.set(e.turn,new Set());byTurn.get(e.turn).add(e.actor);
  const species=activeAt(rows,e.turn,e.actor);
  if(/^Gulp Missile/.test(e.name))forms.add('cramorant-gulp');
  if(species==='aegislash_shield')forms.add('aegislash-blade');
  // the display name is just "Aura Wheel"; the move type (electric or dark) shows which form threw it
  if(/^morpeko/.test(species)&&e.name==='Aura Wheel')forms.add('morpeko:'+(/electric/.test(e.type)?'electric':'dark'));
 }
 for(const [turn,actors] of byTurn){
  if(actors.size<2)continue;
  const a=activeAt(rows,turn,0),b=activeAt(rows,turn,1);
  if(a===b&&!STAT_FORMS.test(a))f.cmpEqualAttack++;
  else if(a!==b&&baseId(a)===baseId(b)&&!STAT_FORMS.test(a))f.cmpShadowRawTie++;
  else f.cmpUnequalAttack++;
 }
 const morpeko=[...forms].filter(x=>x.startsWith('morpeko:'));
 f.forms=[...forms].filter(x=>!x.startsWith('morpeko:'));if(new Set(morpeko).size>=2)f.forms.push('morpeko-toggle');
 if(ids.flat().some(id=>/^darmanitan/.test(id)&&rows.some(r=>r[3].includes(id))))f.forms.push('darmanitan-control');
 f.forms.sort();
 return f;
}
// The tags a battle can carry; the test requires every stored tag to still be detected.
function tagsOf(f,spec){
 const t=[];
 if(f.cmpEqualAttack)t.push('cmp-equal-attack');
 if(f.cmpShadowRawTie)t.push('cmp-shadow-raw-tie');
 if(f.cmpUnequalAttack)t.push('cmp-unequal-attack');
 for(const id of Object.keys(f.buffMoves)){const move=gameTables().moves.get(id);t.push('buff:'+id);if(buffChance(move)<1)t.push('buff-chance:'+id);}
 for(const form of f.forms)t.push('form:'+form);
 if(f.voluntarySwitches[0]&&f.voluntarySwitches[1])t.push('switch-voluntary-both');
 if(f.switchClockExpired.some(Boolean))t.push('switch-clock-expiry');
 if(f.postExpirySwitches.some(Boolean))t.push('switch-after-expiry');
 if(f.forcedReplacements[0]&&f.forcedReplacements[1])t.push('replacement-forced-both');
 if(f.shields[0]&&f.shields[1])t.push('shields-both');
 if(f.shadowActive.some(Boolean))t.push('shadow-active');
 if(spec&&JSON.stringify(spec.a)===JSON.stringify(spec.b))t.push('identical-teams');
 return t.sort();
}
// What the pinned set must cover (battles per tag; '*' tags count distinct values).
const REQUIRED={'cmp-equal-attack':3,'cmp-shadow-raw-tie':2,'cmp-unequal-attack':2,
 'buff:ICY_WIND':1,'buff:POWER_UP_PUNCH':1,'buff:LUNGE':1,'buff:ACID_SPRAY':1,'buff-chance:*':4,
 'form:cramorant-gulp':2,'form:aegislash-blade':2,'form:morpeko-toggle':2,'form:mimikyu-busted':2,'form:darmanitan-control':1,
 'switch-voluntary-both':3,'switch-clock-expiry':3,'switch-after-expiry':3,'replacement-forced-both':3,'shields-both':10,'shadow-active':4,'identical-teams':1};
const MIN_BATTLES=24;
function coverage(battles){
 const count=new Map();
 for(const b of battles)for(const tag of b.tags)count.set(tag,(count.get(tag)||0)+1);
 const missing=[];
 for(const [tag,min] of Object.entries(REQUIRED)){
  const have=tag.endsWith('*')?[...count.keys()].filter(k=>k.startsWith(tag.slice(0,-1))).length:count.get(tag)||0;
  if(have<min)missing.push(tag+' ('+have+'/'+min+')');
 }
 if(battles.length<MIN_BATTLES)missing.push('battles ('+battles.length+'/'+MIN_BATTLES+')');
 return {count,missing};
}

// ---- file format ------------------------------------------------------------------------------------------
// One line per sample, event, belief row and observation record: a mechanics change then reads as a line diff.
const line=(x,indent)=>indent+JSON.stringify(x);
function listLines(items,indent){return items.length?'[\n'+items.map(x=>line(x,indent+' ')).join(',\n')+'\n'+indent+']':'[]';}
function formatExpected(e,indent){
 const keys=Object.keys(e),parts=keys.map(k=>{
  const v=e[k],inner=indent+' ';
  if(['samples','timeline','observed'].includes(k)&&Array.isArray(v))return inner+JSON.stringify(k)+': '+listLines(v,inner);
  return inner+JSON.stringify(k)+': '+JSON.stringify(v);
 });
 return '{\n'+parts.join(',\n')+'\n'+indent+'}';
}
function format(fixture){
 const battle=b=>{
  const head=['id','tags','swapOf','a','b','seed','exercised','digest'].filter(k=>b[k]!==undefined).map(k=>'   '+JSON.stringify(k)+': '+JSON.stringify(b[k]));
  return '  {\n'+head.join(',\n')+',\n   "expected": '+formatExpected(b.expected,'   ')+'\n  }';
 };
 const rest=Object.fromEntries(Object.entries(fixture).filter(([k])=>!['beliefRoster','beliefTeams','battles'].includes(k)));
 const meta=Object.entries(rest).map(([k,v])=>' '+JSON.stringify(k)+': '+JSON.stringify(v));
 return '{\n'+meta.join(',\n')+',\n "beliefRoster": '+listLines(fixture.beliefRoster,' ')+',\n "beliefTeams": '+listLines(fixture.beliefTeams,' ')+',\n "battles": [\n'+fixture.battles.map(battle).join(',\n')+'\n ]\n}\n';
}
const load=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const withDigest=b=>({...b,digest:digest({a:b.a,b:b.b,seed:b.seed,expected:b.expected})});

// ---- comparing two outcomes -------------------------------------------------------------------------------
// The first path at which two JSON values differ, for a reviewer to start from.
function firstDifference(x,y,at='$'){
 if(Object.is(x,y))return null;
 if(typeof x!==typeof y||x===null||y===null||typeof x!=='object')return at+': '+JSON.stringify(x)+' pinned, '+JSON.stringify(y)+' now';
 if(Array.isArray(x)!==Array.isArray(y))return at+': array/object mismatch';
 if(Array.isArray(x)&&x.length!==y.length)return at+': length '+x.length+' pinned, '+y.length+' now';
 for(const k of new Set([...Object.keys(x),...Object.keys(y)])){const d=firstDifference(x[k],y[k],at+(Array.isArray(x)?'['+k+']':'.'+k));if(d)return d;}
 return null;
}

// ---- choosing battles from the prepared pool --------------------------------------------------------------
const MOVE_RECIPES={certain:['ICY_WIND','POWER_UP_PUNCH','LUNGE','ACID_SPRAY'],chance:['CRUNCH','NIGHT_SLASH','MOONBLAST','BUG_BUZZ','ENERGY_BALL','MUDDY_WATER']};
function selectionContext(pool,seed){
 const {createMeta}=require('./team-search/meta.cjs'),rng=random(seed),meta=createMeta(pool.species,{mode:'hybrid'}),variants=pool.variants,dex=new Map(pool.species.map(p=>[p.speciesId,p.dex]));
 const beliefRoster=pool.species.map(p=>[p.speciesId,p.dex,p.moveset,p.weight**1.25]),beliefTeams=meta.fixtures(256,(seed^0x2545f491)>>>0).map(c=>c.team.map(p=>p.speciesId));
 const pick=list=>list[Math.floor(rng()*list.length)],row=v=>[v.speciesId,v.moveset];
 const ctx={rng,variants,meta,fixture:{beliefRoster,beliefTeams},pick,row};
 // An own team: the required variants plus random pool variants of other Pokédex numbers.
 ctx.team=(must=[])=>{const team=[...must];while(team.length<3){const v=pick(variants);if(!team.some(m=>dex.get(m.speciesId)===dex.get(v.speciesId)))team.push(v);}return team.map(row);};
 // An opposing team as the search draws it: published recommended movesets from the meta model.
 ctx.opponent=()=>meta.fixtures(1,Math.floor(rng()*0xffffffff))[0].team.map(row);
 ctx.seed=()=>Math.floor(rng()*0xffffffff);
 ctx.withMove=move=>{const list=variants.filter(v=>v.moveset.slice(1).includes(move));return list.length?pick(list):null;};
 ctx.ofSpecies=pattern=>variants.filter(v=>pattern.test(v.speciesId));
 return ctx;
}
function recipes(ctx){
 const {pick,variants}=ctx,shadows=variants.filter(v=>/_shadow$/.test(v.speciesId)),plainLead=()=>pick(variants);
 const vs=(lead,opponentLead)=>({a:ctx.team([lead]),b:opponentLead?ctx.team([opponentLead]):ctx.opponent(),seed:ctx.seed()});
 const withSpecies=pattern=>()=>{const lead=pick(ctx.ofSpecies(pattern));return vs(lead);};
 const list=[
  {id:'cmp-equal-attack',want:3,make:()=>{const lead=plainLead();return vs(lead,pick(variants.filter(v=>v.speciesId===lead.speciesId)));},tag:'cmp-equal-attack'},
  {id:'cmp-equal-attack-shadow',want:2,make:()=>{const lead=pick(shadows);return vs(lead,pick(shadows.filter(v=>v.speciesId===lead.speciesId)));},tag:'cmp-equal-attack'},
  {id:'cmp-shadow-raw-tie',want:2,make:()=>{const lead=pick(shadows),others=variants.filter(v=>v.speciesId===baseId(lead.speciesId));return others.length?vs(lead,pick(others)):null;},tag:'cmp-shadow-raw-tie'},
  {id:'cmp-unequal-attack',want:2,make:()=>vs(plainLead()),tag:'cmp-unequal-attack'},
  ...MOVE_RECIPES.certain.map(move=>({id:'buff-'+move,want:1,make:()=>{const lead=ctx.withMove(move);return lead&&vs(lead);},tag:'buff:'+move})),
  ...MOVE_RECIPES.chance.map(move=>({id:'buff-chance-'+move,want:1,make:()=>{const lead=ctx.withMove(move);return lead&&vs(lead);},tag:'buff-chance:'+move})),
  {id:'cramorant',want:2,make:withSpecies(/^cramorant$/),tag:'form:cramorant-gulp'},
  {id:'aegislash',want:2,make:withSpecies(/^aegislash/),tag:'form:aegislash-blade'},
  {id:'morpeko',want:2,make:withSpecies(/^morpeko/),tag:'form:morpeko-toggle'},
  {id:'mimikyu',want:2,make:withSpecies(/^mimikyu/),tag:'form:mimikyu-busted'},
  {id:'switch-after-expiry',want:3,make:()=>vs(plainLead()),tag:'switch-after-expiry',also:['switch-voluntary-both','replacement-forced-both']},
  {id:'shadow-teams',want:2,make:()=>vs(pick(shadows),pick(shadows)),tag:'shadow-active'},
 ];
 return list;
}
function select(pool,{seed=20261013,log=()=>{}}={}){
 const ctx=selectionContext(pool,seed),chosen=[],seen=new Set();
 const add=(id,spec,exp,extra={})=>{const f=analyse(exp),battle=withDigest({id,tags:tagsOf(f,spec),...extra,a:spec.a,b:spec.b,seed:spec.seed,exercised:summary(f),expected:exp});chosen.push(battle);seen.add(JSON.stringify([spec.a,spec.b,spec.seed]));return battle;};
 for(const recipe of recipes(ctx)){
  const leads=new Set();let got=0;
  for(let tries=0;tries<200&&got<recipe.want;tries++){
   const spec=recipe.make();if(!spec)continue;
   const key=JSON.stringify([spec.a,spec.b,spec.seed]),lead=spec.a[0][0]+'|'+spec.a[0][1].join(',');
   if(seen.has(key)||leads.has(lead))continue;
   const exp=tracedOutcome(ctx.fixture,spec),f=analyse(exp),tags=tagsOf(f,spec);
   if(!tags.includes(recipe.tag)||!(recipe.also||[]).every(t=>tags.includes(t)))continue;
   leads.add(lead);got++;add(recipe.id+(recipe.want>1?'-'+got:''),spec,exp);log(recipe.id+' '+got+'/'+recipe.want+' after '+(tries+1)+' tries: '+spec.a.map(x=>x[0]).join(',')+' vs '+spec.b.map(x=>x[0]).join(','));
  }
  if(got<recipe.want)throw new Error('Could not find '+recipe.want+' battles for '+recipe.id+' (found '+got+')');
 }
 // Fixed additions: Darmanitan (not in the pool's 300; the pinned engine emulates no Zen Mode, so it is a control),
 // identical teams (the engine reports the expectation of the battle and its mirror), and side-swapped copies.
 const extra=[
  {id:'darmanitan-control-1',spec:{a:[['darmanitan_standard',['INCINERATE','ROCK_SLIDE','OVERHEAT']],...ctx.team().slice(0,2)],b:ctx.opponent(),seed:ctx.seed()}},
  {id:'darmanitan-control-2',spec:{a:ctx.team(),b:[['darmanitan_galarian_standard',['ICE_FANG','AVALANCHE','ICE_PUNCH']],...ctx.opponent().slice(0,2)],seed:ctx.seed()}},
 ];
 for(const {id,spec} of extra)add(id,spec,tracedOutcome(ctx.fixture,spec));
 const team=ctx.team(),twin={a:team,b:team,seed:ctx.seed()};add('identical-teams',twin,tracedOutcome(ctx.fixture,twin));
 for(const source of chosen.filter(b=>b.id==='cmp-equal-attack-1'||b.id==='morpeko-1')){
  const spec={a:source.b,b:source.a,seed:source.seed};add(source.id+'-swapped',spec,tracedOutcome(ctx.fixture,spec),{swapOf:source.id});
 }
 return {fixture:ctx.fixture,battles:chosen};
}
// A small readable record of what a battle exercised (for people; the tags are what the test checks).
const summary=f=>({cmpEqualAttack:f.cmpEqualAttack,cmpShadowRawTie:f.cmpShadowRawTie,cmpUnequalAttack:f.cmpUnequalAttack,voluntarySwitches:f.voluntarySwitches,forcedReplacements:f.forcedReplacements,
 switchClockExpired:f.switchClockExpired,postExpirySwitches:f.postExpirySwitches,shields:f.shields,charged:f.charged,shadowActive:f.shadowActive,buffMoves:f.buffMoves,forms:f.forms});

// ---- command line -----------------------------------------------------------------------------------------
function currentHashes(){const {mechanicsHash,dataHash}=require('./team-search/common.cjs');return {mechanicsHash:mechanicsHash({version:'v4'}),dataHash:dataHash()};}
function regenerate(existing,ids=null){
 const battles=existing.battles.map(b=>{
  if(ids&&!ids.includes(b.id))return b;
  const spec={a:b.a,b:b.b,seed:b.seed},expected=tracedOutcome(existing,spec),f=analyse(expected);
  return withDigest({id:b.id,tags:tagsOf(f,spec),...(b.swapOf?{swapOf:b.swapOf}:{}),a:b.a,b:b.b,seed:b.seed,exercised:summary(f),expected});
 });
 return battles;
}
function main(argv){
 const flag=name=>argv.includes('--'+name),value=name=>{const i=argv.indexOf('--'+name);return i>=0?argv[i+1]:undefined;};
 const file=path.resolve(value('file')||FIXTURE_FILE),write=flag('write'),reason=value('reason');
 const existing=fs.existsSync(file)?load(file):null;
 let next,created=false;
 if(flag('select')){
  const poolFile=path.resolve(value('pool')||POOL_FILE);
  if(!fs.existsSync(poolFile))throw new Error('--select needs the prepared pool ('+poolFile+'); copy it from the main checkout or rebuild it with team-search/prepare.cjs');
  const pool=load(poolFile),picked=select(pool,{seed:Number(value('seed')||20261013),log:m=>console.log(m)});
  next={schema:SCHEMA,description:existing?.description||DESCRIPTION,engine:ENGINE,switchClockSeconds:SWITCH_CLOCK_SECONDS,provenance:{pool:{hash:pool.hash,species:pool.species.length,variants:pool.variants.length},...currentHashes(),node:process.version},changelog:existing?.changelog||[],beliefRoster:picked.fixture.beliefRoster,beliefTeams:picked.fixture.beliefTeams,battles:picked.battles};
  created=true;
 }else{
  if(!existing)throw new Error('No fixture file at '+file+'; create it with --select --write --reason "initial selection"');
  const ids=value('ids')?value('ids').split(','):null;
  if(ids&&ids.some(id=>!existing.battles.some(b=>b.id===id)))throw new Error('Unknown battle id in --ids');
  next={...existing,battles:regenerate(existing,ids)};
 }
 const old=new Map((existing?.battles||[]).map(b=>[b.id,b])),changed=[],added=[],removed=[...old.keys()].filter(id=>!next.battles.some(b=>b.id===id));
 for(const b of next.battles){const o=old.get(b.id);if(!o)added.push(b.id);else if(o.digest!==b.digest||JSON.stringify(o.tags)!==JSON.stringify(b.tags))changed.push([b.id,firstDifference(o.expected,b.expected)||'tags: '+JSON.stringify(o.tags)+' pinned, '+JSON.stringify(b.tags)+' now']);}
 const {missing}=coverage(next.battles);
 console.log(next.battles.length+' battles; '+changed.length+' changed, '+added.length+' new, '+removed.length+' removed'+(missing.length?'; coverage missing: '+missing.join(', '):''));
 for(const [id,why] of changed)console.log('  changed '+id+' - '+why);
 for(const id of added)console.log('  new '+id);for(const id of removed)console.log('  removed '+id);
 const hashes=currentHashes();
 if(existing&&!created&&(existing.provenance.mechanicsHash!==hashes.mechanicsHash||existing.provenance.dataHash!==hashes.dataHash))console.log('  provenance: mechanics hash '+(existing.provenance.mechanicsHash===hashes.mechanicsHash?'unchanged':'changed')+', data hash '+(existing.provenance.dataHash===hashes.dataHash?'unchanged':'changed')+' since the fixtures were written');
 if(missing.length){console.error('The pinned set no longer covers every required situation; run with --select to choose battles again.');process.exitCode=1;return;}
 const differs=changed.length||added.length||removed.length;
 if(!write){if(differs){console.log('Nothing written. Review the differences above; to accept them rerun with --write --reason "<why>".');process.exitCode=1;}else console.log('All pinned outcomes reproduce exactly.');return;}
 if(differs&&!reason){console.error('Refusing to overwrite pinned outcomes without --reason "<why the mechanics changed>".');process.exitCode=2;return;}
 if(!created)next.provenance={...existing.provenance,...hashes};
 next.changelog=[...(existing?.changelog||[]),...(differs||created?[{date:new Date().toISOString().slice(0,10),reason:reason||'initial selection',...hashes,changed:changed.map(c=>c[0]),added,removed}]:[])];
 const text=format(next);
 if(existing&&text===fs.readFileSync(file,'utf8')){console.log('Fixture file already up to date.');return;}
 fs.writeFileSync(file,text);console.log('Wrote '+file+' ('+Math.round(text.length/1024)+' KiB).');
}
const DESCRIPTION='Deterministic seeded battles from the prepared pool, with their complete traced outcome under the observation-limited v4 engine. A pin of what the emulator does, not evidence that the game does the same.';
module.exports={FIXTURE_FILE,POOL_FILE,SCHEMA,ENGINE,SWITCH_CLOCK_SECONDS,REQUIRED,MIN_BATTLES,digest,plain,toRows,beliefOf,engineOptions,split,replay,tracedOutcome,analyse,tagsOf,coverage,format,load,firstDifference,gameTables,moveByName,activeAt,select,regenerate};
if(require.main===module)try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
