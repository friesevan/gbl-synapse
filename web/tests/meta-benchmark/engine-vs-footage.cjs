#!/usr/bin/env node
// Cross-tool fidelity: do the damage formula and move timing that the battle emulator inherits from PvPoke
// agree with what real battles show? The Meta Extractor measures hit sizes and hit times from footage; this
// compares them with (a) the extractor's own copy of the formula (includes/meta/combat.js: statCombos and
// hitRange, over every level/IV pair consistent with both CPs), (b) the emulator's DamageCalculator at default
// IVs, built in a VM exactly as engine-v4-core builds a battle (training/engine-probe.cjs), (c) the move's
// duration in turns, and (d) for banner-named charged moves, the same damage range for charged hits.
//
//   node tests/meta-benchmark/engine-vs-footage.cjs [--work DIR] [--labels DIR] [--no-answers] [--out FILE] [--quiet]
//
// Evidence: every confirmed fast move in tests/meta-benchmark/labels/youtube/*.json (`battles[].verified`,
// "side:key:fast") and, unless --no-answers, every reviewer answer in the harvest's feedback.json (the same
// joined data movefit-data.cjs builds), each joined to the saved extraction in results/<videoId>.json by
// video id, battle (by time overlap for the label files, by index for reviewer answers) and species key.
// Shadow status comes from the confirmed labels; where a Pokémon has none it is assumed regular and the case is
// marked "status unknown", and the headline numbers are given for the confirmed subset as well. Local data
// only: the harvest results and recordings are read, never copied; the saved JSON holds aggregates by video id.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const MetaCombat=require('../../includes/meta/combat.js');
const REPO_DATA=path.resolve(__dirname,'../../includes/pro/data/gamemaster.json');

// ---- statistics ---------------------------------------------------------------------------------------------
function quantile(values,q){
 if(!values.length)return null;
 const s=[...values].sort((a,b)=>a-b),i=(s.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);
 return s[lo]+(s[hi]-s[lo])*(i-lo);
}
const summarize=values=>({n:values.length,median:quantile(values,.5),q1:quantile(values,.25),q3:quantile(values,.75)});
const share=(k,n)=>n?k/n:null;
const round=(x,d=3)=>x===null||x===undefined||!Number.isFinite(x)?null:Math.round(x*10**d)/10**d;

// ---- hit sizes ----------------------------------------------------------------------------------------------
// The extractor's noise model for a hit reading: sigma of the bar's HP (combat.js FIT.sigma, 1.3%) plus a share of
// the hit (the 15% relSigma that the 2026-10-12 refit in the Meta Extractor README settled on).
const NOISE={sigma:.013,rel:.15};
// A predicted range [lo, hi] widened by the measurement noise on each side.
const widen=([lo,hi],noise=NOISE)=>[lo-(noise.sigma+noise.rel*lo),hi+(noise.sigma+noise.rel*hi)];
function hitCheck(sizes,range,noise=NOISE){
 const wide=widen(range,noise),strict=sizes.filter(x=>x>=range[0]&&x<=range[1]).length,band=sizes.filter(x=>x>=wide[0]&&x<=wide[1]).length;
 return {n:sizes.length,inside:strict,insideBand:band};
}
const centre=range=>(range[0]+range[1])/2;
const ratiosTo=(sizes,reference)=>reference>0?sizes.map(x=>x/reference):[];

// ---- hit spacing --------------------------------------------------------------------------------------------
// Share of consecutive-hit gaps within `tol` s of an integer multiple (>= 1) of the move's duration (turns x 0.5 s).
// Gaps above maxGap are charged-attack cutscenes, switches or pauses, not spacing. A move of one turn (0.5 s)
// is vacuous: every gap is within 0.25 s of a multiple of 0.5 s, so those gaps are counted but not scored.
// Measured gaps are noisy (hit times come from 10 fps frames and a drain animation), so the labelled duration
// is also scored against the other candidate durations (2 to 5 turns) on the same gaps: a duration that is
// really in the footage should beat them. `plausible` gaps are those at least one duration long (shorter ones
// are double detections of one hit and cannot be move spacing).
const DURATIONS=[2,3,4,5];
const nearMultiple=(g,d,tol)=>{const k=Math.round(g/d);return k>=1&&Math.abs(g-k*d)<=tol;};
function gapStats(times,turns,{maxGap=4,tol=.25,minGap=.05}={}){
 const d=turns*.5,gaps=[];
 for(let i=1;i<(times||[]).length;i++){const g=times[i]-times[i-1];if(g>minGap&&g<=maxGap)gaps.push(g);}
 const vacuous=d<=2*tol,count=(list,t)=>list.filter(g=>nearMultiple(g,t*.5,tol)).length,plausible=gaps.filter(g=>g>=d-tol);
 const out={gaps:gaps.length,duration:d,vacuous,scored:0,within:0,others:[],plausible:0,withinPlausible:0,multiples:{}};
 if(vacuous)return out;
 out.scored=gaps.length;out.within=count(gaps,turns);out.others=DURATIONS.filter(t=>t!==turns).map(t=>count(gaps,t));
 out.plausible=plausible.length;out.withinPlausible=count(plausible,turns);
 for(const g of gaps){const k=Math.round(g/d);if(k>=1&&Math.abs(g-k*d)<=tol)out.multiples[k]=(out.multiples[k]||0)+1;}
 return out;
}

// ---- joining labels to extraction results -------------------------------------------------------------------
const normalizeName=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g,'');
// The extraction battle that a label-file battle describes: largest overlap of [start, end] (the labels are
// +-4 s), among battles whose opponent keys do not contradict the label's species names.
function matchBattle(label,full,{slack=4}={}){
 let best=-1,bestScore=0;
 full.forEach((b,i)=>{
  const lo=Math.max(label.start,b.start),hi=Math.min(label.end,b.end),overlap=Math.max(0,hi-lo),union=Math.max(label.end,b.end)-Math.min(label.start,b.start);
  const near=Math.abs(label.start-b.start)<=slack*2||overlap>0;if(!near||!union)return;
  const names=new Set((label.opp||[]).map(normalizeName)),keys=(b.opponent||[]).map(p=>normalizeName(p.key));
  const common=keys.filter(k=>names.has(k)).length,score=overlap/union+(names.size&&common?.001*common:0);
  if(names.size&&keys.length&&!common)return;
  if(score>bestScore){bestScore=score;best=i;}
 });
 return bestScore>=.5?best:-1;
}
// Label records from the tracked benchmark files: {video, battle (index into results.full), side, key, kind, value}.
function benchmarkLabels(dir,resultsFor){
 const out=[];
 if(!fs.existsSync(dir))return out;
 for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort()){
  const video=file.replace(/\.json$/,''),doc=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')),full=resultsFor(video)?.full;
  for(const lb of doc.battles||[]){
   const battle=full?matchBattle(lb,full):-1;
   for(const [k,v] of Object.entries(lb.verified||{})){
    const [side,key,...kind]=k.split(':');if(!['my','opponent'].includes(side))continue;
    out.push({video,battle,side,key,kind:kind.join(':')==='fast'?'fastMove':kind.join(':'),value:v.value,source:'benchmark',allBattles:false});
   }
  }
 }
 return out.filter(l=>['fastMove','shadow','form'].includes(l.kind));
}
// Lookup of confirmed Shadow status and form for one Pokémon in one battle: exact battle first, then an
// "all battles" answer for the same side and key.
function labelIndex(labels){
 const exact=new Map(),all=new Map();
 for(const l of labels){
  if(l.kind==='fastMove')continue;
  const k=[l.video,l.side,l.key,l.kind].join('|');
  if(l.allBattles)all.set(k,l.value);else exact.set(k+'|'+l.battle,l.value);
 }
 return {get(video,battle,side,key,kind){const k=[video,side,key,kind].join('|');return exact.has(k+'|'+battle)?exact.get(k+'|'+battle):all.has(k)?all.get(k):undefined;}};
}

// ---- cases --------------------------------------------------------------------------------------------------
function gameData(gm){
 return {pokemon:new Map(gm.pokemon.map(p=>[p.speciesId,p])),moves:new Map(gm.moves.map(m=>[m.moveId,m]))};
}
// Species entry for one member: confirmed form (else the extractor's form read), Shadow from the labels.
function resolveMember(member,labels,ctx,data){
 const {video,battle,side}=ctx,key=member.key;
 const formLabel=labels.get(video,battle,side,key,'form');
 const base=String(formLabel||member.formId||member.inference?.forms?.[0]?.value||(member.candidates?.length===1?member.candidates[0].id:key)).replace(/_shadow$/,'');
 const shadowLabel=labels.get(video,battle,side,key,'shadow'),known=shadowLabel===true||shadowLabel===false;
 let id=base,shadow=false;
 if(shadowLabel===true&&data.pokemon.has(base+'_shadow')){id=base+'_shadow';shadow=true;}
 const entry=data.pokemon.get(id)||null;
 return {key,id,base,entry,cp:Number(member.cp)>0?Number(member.cp):null,shadow,statusKnown:known,formConfirmed:formLabel!==undefined};
}
const sizesOf=(g,toMy)=>toMy?g.hitsOnMy:g.hitsOnOpp,timesOf=(g,toMy)=>toMy?g.hitTimesOnMy:g.hitTimesOnOpp;
const FIRST_WINDOW=12;
// Duration in turns (0.5 s each); older game master files carry only the cooldown.
const turnsOf=move=>move.turns??Math.max(1,Math.round(move.cooldown/500));
// One matchup's evidence for one labelled attacker.
function hitCase({move,attacker,defender,matchup,toMy,league,env}){
 const sizes=(sizesOf(matchup,toMy)||[]).filter(Number.isFinite),times=timesOf(matchup,toMy)||[];
 if(!sizes.length)return null;
 const range=MetaCombat.hitRange(attacker.entry,attacker.cp,move,defender.entry,defender.cp,league);
 if(!range)return null;
 const aligned=times.length===sizes.length,early=aligned?sizes.filter((_,i)=>times[i]<=matchup.start+FIRST_WINDOW):sizes;
 const out={sizes,early,range,times:aligned?times:[],turns:turnsOf(move),engine:null,engineSource:null,engineTurns:null};
 if(env.engine){const e=env.engine(attacker,defender,move,league);if(e){out.engine=e.fraction;out.engineSource=e.source;out.engineTurns=e.turns;}}
 return out;
}
// Fast-move cases for all labelled attackers of one battle.
function fastCasesForBattle({video,battleIndex,battle,fast,labels,data,env}){
 const rows=[],skipped={};
 const skip=why=>{skipped[why]=(skipped[why]||0)+1;};
 const league=env.league(battle);
 for(const l of fast){
  const side=l.side,member=(battle[side]||[]).find(p=>p.key===l.key);
  if(!member){skip('member not in the battle');continue;}
  const move=data.moves.get(l.value);if(!move||!(move.energy===0)){skip('move unknown in the game data');continue;}
  const ctx={video,battle:battleIndex,side},attacker=resolveMember(member,labels,ctx,data);
  if(!attacker.entry){skip('species unknown in the game data');continue;}
  const otherSide=side==='my'?'opponent':'my',toMy=side==='opponent';
  for(const g of battle.matchups||[]){
   if(g[side]!==l.key)continue;
   const dm=(battle[otherSide]||[]).find(p=>p.key===g[otherSide]);if(!dm){skip('defender not in the battle');continue;}
   const defender=resolveMember(dm,labels,{video,battle:battleIndex,side:otherSide},data);
   if(!defender.entry){skip('defender species unknown in the game data');continue;}
   const c=hitCase({move,attacker,defender,matchup:g,toMy,league,env});if(!c){skip('no measured hits');continue;}
   rows.push({video,battle:battleIndex,side,key:l.key,move:move.moveId,source:l.source,overrodeModel:l.modelTop!=null&&l.modelTop!==l.value,attacker:slim(attacker),defender:slim(defender),league,cpKnown:!!(attacker.cp&&defender.cp),statusKnown:attacker.statusKnown&&defender.statusKnown,shadowInvolved:attacker.shadow||defender.shadow,start:g.start,...c});
  }
 }
 return {rows,skipped};
}
const slim=m=>({id:m.id,cp:m.cp,shadow:m.shadow,statusKnown:m.statusKnown});
// Charged-hit cases: every unshielded charged attack with a banner-named move and a measured size.
function chargedCasesForBattle({video,battleIndex,battle,labels,data,env}){
 const rows=[],league=env.league(battle);
 for(const g of battle.matchups||[]){
  const mine=(battle.my||[]).find(p=>p.key===g.my),theirs=(battle.opponent||[]).find(p=>p.key===g.opponent);
  if(!mine||!theirs)continue;
  const my=resolveMember(mine,labels,{video,battle:battleIndex,side:'my'},data),opp=resolveMember(theirs,labels,{video,battle:battleIndex,side:'opponent'},data);
  if(!my.entry||!opp.entry)continue;
  for(const [list,attacker,defender] of [[g.chargedOnOpp,my,opp],[g.chargedOnMy,opp,my]]){
   for(const c of list||[]){
    const move=data.moves.get(c.move);if(!move||!(move.power>0)||!(move.energy>0)||!Number.isFinite(c.size))continue;
    const range=MetaCombat.hitRange(attacker.entry,attacker.cp,move,defender.entry,defender.cp,league);if(!range)continue;
    let engine=null;if(env.engine){const e=env.engine(attacker,defender,move,league);if(e)engine=e.fraction;}
    rows.push({video,battle:battleIndex,move:move.moveId,size:c.size,range,engine,cpKnown:!!(attacker.cp&&defender.cp),statusKnown:attacker.statusKnown&&defender.statusKnown,shadowInvolved:attacker.shadow||defender.shadow,attacker:slim(attacker),defender:slim(defender)});
   }
  }
 }
 return rows;
}

// ---- aggregation --------------------------------------------------------------------------------------------
function aggregateHits(rows,{window='all'}={}){
 const pick=r=>window==='early'?r.early:r.sizes;
 let n=0,inside=0,band=0;const ratioRange=[],ratioEngine=[];
 for(const r of rows){
  const sizes=pick(r);if(!sizes.length)continue;
  const h=hitCheck(sizes,r.range);n+=h.n;inside+=h.inside;band+=h.insideBand;
  ratioRange.push(...ratiosTo(sizes,centre(r.range)));
  if(r.engine!==null)ratioEngine.push(...ratiosTo(sizes,r.engine));
 }
 return {matchups:rows.filter(r=>pick(r).length).length,hits:n,inside:round(share(inside,n)),insideBand:round(share(band,n)),ratioToRangeCentre:cleanSummary(summarize(ratioRange)),ratioToEngineDefault:cleanSummary(summarize(ratioEngine))};
}
const cleanSummary=s=>({n:s.n,median:round(s.median),q1:round(s.q1),q3:round(s.q3)});
// Spacing over many cases. `others` is what the same gaps score against the other candidate durations
// (2 to 5 turns, excluding the labelled one); `verdicts` counts the cases (3+ scored gaps) where the labelled
// duration scores above, equal to, or below the best alternative.
function aggregateGaps(rows){
 let gaps=0,scored=0,within=0,vacuous=0,plausible=0,withinPlausible=0,othersTotal=0,othersN=0;const multiples={},verdicts={better:0,tied:0,worse:0};
 for(const r of rows){
  const g=gapStats(r.times,r.turns);gaps+=g.gaps;
  if(g.vacuous){vacuous+=g.gaps;continue;}
  scored+=g.scored;within+=g.within;plausible+=g.plausible;withinPlausible+=g.withinPlausible;
  othersTotal+=g.others.reduce((a,x)=>a+x,0);othersN+=g.others.length*g.scored;
  for(const [k,v] of Object.entries(g.multiples))multiples[k]=(multiples[k]||0)+v;
  if(g.scored>=3){const best=Math.max(...g.others);verdicts[g.within>best?'better':g.within===best?'tied':'worse']++;}
 }
 const own=share(within,scored),other=share(othersTotal,othersN);
 return {gaps,scored,withinTolerance:round(own),otherDurations:round(other),lift:round(own&&other?own/other:null,2),plausibleGaps:plausible,withinTolerancePlausible:round(share(withinPlausible,plausible)),oneTurnGapsNotScored:vacuous,verdicts,multiples};
}
function aggregateCharged(rows){
 let n=0,inside=0,band=0;const ratioRange=[],ratioEngine=[];
 for(const r of rows){n++;if(r.size>=r.range[0]&&r.size<=r.range[1])inside++;const w=widen(r.range);if(r.size>=w[0]&&r.size<=w[1])band++;ratioRange.push(r.size/centre(r.range));if(r.engine>0)ratioEngine.push(r.size/r.engine);}
 return {hits:n,inside:round(share(inside,n)),insideBand:round(share(band,n)),ratioToRangeCentre:cleanSummary(summarize(ratioRange)),ratioToEngineDefault:cleanSummary(summarize(ratioEngine))};
}
const groupBy=(rows,fn)=>{const m=new Map();for(const r of rows){const k=fn(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;};
function summarizeFast(rows){
 const strata={
  all:rows,
  cpKnown:rows.filter(r=>r.cpKnown),
  statusConfirmed:rows.filter(r=>r.cpKnown&&r.statusKnown),
  confirmedNoShadow:rows.filter(r=>r.cpKnown&&r.statusKnown&&!r.shadowInvolved),
  confirmedShadowInvolved:rows.filter(r=>r.cpKnown&&r.statusKnown&&r.shadowInvolved),
  statusUnknown:rows.filter(r=>r.cpKnown&&!r.statusKnown),
  benchmarkLabels:rows.filter(r=>r.source==='benchmark'),
  reviewerAnswers:rows.filter(r=>r.source!=='benchmark'),
  // A bar step is only measured to about 0.4 to 1.6% of HP, so small hits say little about the formula.
  predictedAtLeast4pct:rows.filter(r=>centre(r.range)>=.04),
  predictedBelow4pct:rows.filter(r=>centre(r.range)<.04),
  // Cases where the reviewer chose a move other than the extractor's own top guess: not circular.
  reviewerOverrodeModel:rows.filter(r=>r.overrodeModel),
 };
 const out={};
 for(const [name,list] of Object.entries(strata))out[name]={cases:list.length,all:aggregateHits(list),first12s:aggregateHits(list,{window:'early'}),timing:aggregateGaps(list)};
 return out;
}

// ---- engine --------------------------------------------------------------------------------------------------
// DamageCalculator.damage at the engine's default IVs for the league, as a fraction of the defender's max HP.
// One probe per (game data file, league), because the engine rebuilds default IVs from the game master.
function makeEngine({probeFactory,gmFor}){
 const probes=new Map();
 const probe=(gmPath,league)=>{const k=gmPath+'|'+league;if(!probes.has(k))probes.set(k,probeFactory(gmPath,league));return probes.get(k);};
 return (attacker,defender,move,league,gmPath=gmFor())=>{
  try{
   const p=probe(gmPath,league),charged=move.energy>0;
   const a=p.pokemon(attacker.id,{moveset:charged?[null,move.moveId]:[move.moveId],index:0}),d=p.pokemon(defender.id,{index:1});
   const m=charged?a.chargedMoves[0]:a.fastMove;
   return {fraction:p.damage(a,d,m)/d.stats.hp,source:gmPath,turns:m.cooldown/500};
  }catch(error){return null;}
 };
}
// Exact parity between the emulator's DamageCalculator and combat.js: for sampled level/IV pairs of the
// attacker and defender that the CPs allow, both must give the same integer damage and the same stats.
function parityCheck({attacker,defender,move,league,probe,pairs=8}){
 const A=MetaCombat.statCombos(attacker.entry,attacker.cp||0),D=MetaCombat.statCombos(defender.entry,defender.cp||0);
 if(!A.length||!D.length)return null;
 const pick=(list,n)=>list.length<=n?list:Array.from({length:n},(_,i)=>list[Math.floor(i*(list.length-1)/(n-1))]);
 let equalDamage=0,equalStats=0,n=0;const charged=move.energy>0;
 const types=MetaCombat.types;
 for(const a of pick(A,Math.ceil(Math.sqrt(pairs)))){
  for(const d of pick(D,Math.ceil(Math.sqrt(pairs)))){
   const ea=probe.pokemon(attacker.id,{moveset:charged?[null,move.moveId]:[move.moveId],level:a.level,ivs:a.ivs,index:0}),ed=probe.pokemon(defender.id,{level:d.level,ivs:d.ivs,index:1});
   const mine=MetaCombat.damage(move,types(attacker.entry),a.atk*(attacker.shadow?MetaCombat.MULT.SHADOW_ATK:1),types(defender.entry),d.def*(defender.shadow?MetaCombat.MULT.SHADOW_DEF:1));
   const theirs=probe.damage(ea,ed,charged?ea.chargedMoves[0]:ea.fastMove);
   n++;if(mine===theirs)equalDamage++;
   if(ea.stats.atk===a.atk&&ed.stats.def===d.def&&ed.stats.hp===d.hp)equalStats++;
  }
 }
 return {n,equalDamage,equalStats};
}

// ---- driver --------------------------------------------------------------------------------------------------
function run(options={}){
 const movefit=require('./movefit-data.cjs');
 const work=options.work||movefit.WORK,labelsDir=options.labels||path.join(__dirname,'labels/youtube');
 if(!fs.existsSync(path.join(work,'results')))throw new Error('No harvest results at '+work+' (use --work DIR); this check needs the extraction results next to the labels');
 const registry=movefit.registry(),contexts=new Map();
 const context=video=>{if(!contexts.has(video))contexts.set(video,movefit.runContext(video,work,registry));return contexts.get(video);};
 const labels=[...benchmarkLabels(labelsDir,v=>context(v)?.raw)];
 if(options.answers!==false)labels.push(...movefit.loadLabels(work).map(l=>({...l,source:l.source==='legacy'?'legacy':'answer'})));
 // One record per (video, battle, side, key, kind); the label files win over answers on a clash.
 const seen=new Set(),unique=[];
 for(const l of labels){const k=[l.video,l.allBattles?'*':l.battle,l.side,l.key,l.kind].join('|');if(seen.has(k))continue;seen.add(k);unique.push(l);}
 const index=labelIndex(unique),fastLabels=unique.filter(l=>l.kind==='fastMove');
 // Game data per video: the PvPoke file cached for the battle date, as the extractor itself uses, else the repository's.
 const gmCache=new Map(),gmLoad=file=>{const f=file&&fs.existsSync(file)?file:REPO_DATA;if(!gmCache.has(f))gmCache.set(f,{file:f,json:JSON.parse(fs.readFileSync(f,'utf8'))});return gmCache.get(f);};
 const {createProbe}=require('../../training/engine-probe.cjs');
 const probeFactory=(file,league)=>createProbe({data:gmLoad(file).json,cp:league});
 const probesForParity=new Map();
 const report={createdAt:new Date().toISOString().slice(0,10),noise:NOISE,inputs:{fastLabels:fastLabels.length,benchmarkFastLabels:fastLabels.filter(l=>l.source==='benchmark').length,answerFastLabels:fastLabels.filter(l=>l.source!=='benchmark').length,unjoined:0,videos:0},skipped:{},perVideo:{}};
 const fastRows=[],chargedRows=[],parity={pairs:0,equalDamage:0,equalStats:0,cases:0};
 const byVideo=groupBy(fastLabels,l=>l.video);
 for(const [video,list] of byVideo){
  const ctx=context(video);if(!ctx){report.inputs.unjoined+=list.length;continue;}
  report.inputs.videos++;
  const gmFile=ctx.gamemaster,data=gameData(gmLoad(gmFile).json),env={league:b=>movefit.leagueFromCPs(b,ctx.league||1500)};
  const engine=makeEngine({probeFactory,gmFor:()=>gmFile});
  env.engine=(a,d,m,league)=>engine(a,d,m,league,gmFile);
  const full=ctx.raw.full,perBattle=new Map();
  for(const l of list){
   const indices=l.allBattles?full.map((b,i)=>i).filter(i=>(full[i][l.side]||[]).some(p=>p.key===l.key)):[l.battle];
   for(const i of indices){if(!full[i]){report.inputs.unjoined++;continue;}if(!perBattle.has(i))perBattle.set(i,[]);perBattle.get(i).push(l);}
  }
  const vRows=[],vCharged=[];
  for(const [i,ls] of perBattle){
   const battle=full[i],{rows,skipped}=fastCasesForBattle({video,battleIndex:i,battle,fast:ls,labels:index,data,env});
   for(const [why,n] of Object.entries(skipped))report.skipped[why]=(report.skipped[why]||0)+n;
   vRows.push(...rows);
   vCharged.push(...chargedCasesForBattle({video,battleIndex:i,battle,labels:index,data,env}));
   // formula parity on the first case of every distinct (attacker, defender, move)
   const done=new Set();
   for(const r of rows){const k=[r.attacker.id,r.defender.id,r.move].join('|');if(done.has(k)||!r.cpKnown)continue;done.add(k);
    const probe=(()=>{const pk=gmFile+'|'+r.league;if(!probesForParity.has(pk))probesForParity.set(pk,probeFactory(gmFile,r.league));return probesForParity.get(pk);})();
    const a={...r.attacker,entry:data.pokemon.get(r.attacker.id),cp:r.attacker.cp},d={...r.defender,entry:data.pokemon.get(r.defender.id),cp:r.defender.cp};
    const c=parityCheck({attacker:a,defender:d,move:data.moves.get(r.move),league:r.league,probe});
    if(c){parity.cases++;parity.pairs+=c.n;parity.equalDamage+=c.equalDamage;parity.equalStats+=c.equalStats;}}
  }
  fastRows.push(...vRows);chargedRows.push(...vCharged);
  report.perVideo[video]={date:ctx.date||null,gameData:gmFile?path.basename(gmFile):'repository',labels:list.length,fast:summarizeFast(vRows).all,charged:aggregateCharged(vCharged)};
 }
 report.fast=summarizeFast(fastRows);
 report.charged={all:aggregateCharged(chargedRows),cpKnown:aggregateCharged(chargedRows.filter(r=>r.cpKnown)),statusConfirmed:aggregateCharged(chargedRows.filter(r=>r.cpKnown&&r.statusKnown)),confirmedNoShadow:aggregateCharged(chargedRows.filter(r=>r.cpKnown&&r.statusKnown&&!r.shadowInvolved)),confirmedShadowInvolved:aggregateCharged(chargedRows.filter(r=>r.cpKnown&&r.statusKnown&&r.shadowInvolved))};
 report.parity={...parity,damageMatch:round(share(parity.equalDamage,parity.pairs),4),statsMatch:round(share(parity.equalStats,parity.pairs),4)};
 const withEngine=fastRows.filter(r=>r.engineTurns!==null);
 report.moveDuration={cases:withEngine.length,engineEqualsGameData:withEngine.filter(r=>r.engineTurns===r.turns).length};
 report.rows={fast:fastRows.length,charged:chargedRows.length};
 return {report,fastRows,chargedRows};
}

// ---- report ---------------------------------------------------------------------------------------------------
const pct=x=>x===null||x===undefined?'  - ':(100*x).toFixed(0).padStart(3)+'%';
const rat=s=>s.n?s.median.toFixed(2)+' ('+s.q1.toFixed(2)+'-'+s.q3.toFixed(2)+')':'-';
const STRATA=['all','predictedAtLeast4pct','predictedBelow4pct','statusConfirmed','confirmedNoShadow','confirmedShadowInvolved','statusUnknown','benchmarkLabels','reviewerAnswers','reviewerOverrodeModel'];
function printReport(report,log=console.log){
 const f=report.fast,i=report.inputs;
 log('Engine vs footage ('+report.createdAt+')');
 log('Inputs: '+i.fastLabels+' confirmed fast moves ('+i.benchmarkFastLabels+' in the benchmark label files, '+i.answerFastLabels+' reviewer answers), '+i.videos+' videos joined, '+i.unjoined+' labels without results; '+report.rows.fast+' matchups with hits, '+report.rows.charged+' banner-named charged hits.');
 if(Object.keys(report.skipped).length)log('Skipped: '+Object.entries(report.skipped).map(([k,v])=>v+' '+k).join('; '));
 log('\n(a)(b) Fast-move hit sizes: measured vs the predicted range (combat.js, every level/IV pair the CPs allow) and vs the engine at default IVs');
 log('stratum'.padEnd(26)+'matchups'.padStart(9)+'hits'.padStart(7)+'in range'.padStart(9)+'in band'.padStart(9)+'  '+'meas/range centre'.padEnd(19)+'meas/engine dflt'.padEnd(19)+'first 12 s in range'.padStart(20));
 for(const name of STRATA){const s=f[name];log(name.padEnd(26)+String(s.cases).padStart(9)+String(s.all.hits).padStart(7)+pct(s.all.inside).padStart(9)+pct(s.all.insideBand).padStart(9)+'  '+rat(s.all.ratioToRangeCentre).padEnd(19)+rat(s.all.ratioToEngineDefault).padEnd(19)+pct(s.first12s.inside).padStart(20));}
 log('"in range" is strict; "in band" widens the range by the extractor\'s noise model ('+(100*report.noise.sigma).toFixed(1)+'% of HP + '+(100*report.noise.rel).toFixed(0)+'% of the hit).');
 log('\n(c) Spacing of consecutive hits vs the labelled move\'s duration (gaps within +-0.25 s of a multiple; moves of one turn are not scoreable)');
 log('stratum'.padEnd(26)+'gaps'.padStart(7)+'scored'.padStart(8)+'within'.padStart(8)+'other durations'.padStart(17)+'lift'.padStart(6)+'  plausible gaps within  cases better/tied/worse');
 for(const name of STRATA){const t=f[name].timing;log(name.padEnd(26)+String(t.gaps).padStart(7)+String(t.scored).padStart(8)+pct(t.withinTolerance).padStart(8)+pct(t.otherDurations).padStart(17)+String(t.lift??'-').padStart(6)+'  '+(pct(t.withinTolerancePlausible)+' of '+t.plausibleGaps).padEnd(22)+'  '+t.verdicts.better+'/'+t.verdicts.tied+'/'+t.verdicts.worse);}
 log('\nPer video (matchups with hits for the labelled attackers)');
 for(const [v,p] of Object.entries(report.perVideo)){const a=p.fast.all,t=p.fast.timing;log(v.padEnd(13)+(p.date||'').padEnd(10)+String(p.labels).padStart(3)+' labels'+String(p.fast.cases).padStart(4)+' matchups'+String(a.hits).padStart(5)+' hits  in range'+pct(a.inside)+'  band'+pct(a.insideBand)+'  meas/range '+rat(a.ratioToRangeCentre).padEnd(18)+' spacing'+pct(t.withinTolerance)+' (others'+pct(t.otherDurations)+')  charged '+String(p.charged.hits).padStart(3)+' in range'+pct(p.charged.inside));}
 log('\n(d) Charged hits named by banners (unshielded, measured size)');
 for(const name of ['all','statusConfirmed','confirmedNoShadow','confirmedShadowInvolved']){const c=report.charged[name];log(name.padEnd(26)+String(c.hits).padStart(6)+' hits  in range'+pct(c.inside)+'  in band'+pct(c.insideBand)+'  meas/range centre '+rat(c.ratioToRangeCentre)+'  meas/engine default '+rat(c.ratioToEngineDefault));}
 log('\nFormula parity, emulator DamageCalculator vs combat.js over sampled level/IV pairs: '+report.parity.cases+' attacker/defender/move triples, '+report.parity.pairs+' pairs, damage equal '+report.parity.equalDamage+' ('+(100*report.parity.damageMatch).toFixed(2)+'%), stats equal '+report.parity.equalStats+' ('+(100*report.parity.statsMatch).toFixed(2)+'%).');
 log('Move duration, emulator move vs game data: '+report.moveDuration.engineEqualsGameData+' of '+report.moveDuration.cases+' labelled moves equal.');
}
function main(argv){
 const value=name=>{const i=argv.indexOf('--'+name);return i>=0?argv[i+1]:undefined;};
 const {report}=run({work:value('work'),labels:value('labels'),answers:!argv.includes('--no-answers')});
 if(!argv.includes('--quiet'))printReport(report);
 const out=value('out')||path.join(__dirname,'engine-vs-footage.json');
 fs.writeFileSync(out,JSON.stringify(report,null,1)+'\n');
 console.log('\nSaved '+out);
}
module.exports={quantile,summarize,widen,hitCheck,gapStats,turnsOf,matchBattle,normalizeName,benchmarkLabels,labelIndex,resolveMember,gameData,hitCase,fastCasesForBattle,chargedCasesForBattle,aggregateHits,aggregateGaps,aggregateCharged,summarizeFast,makeEngine,parityCheck,run,printReport,NOISE};
if(require.main===module)try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
