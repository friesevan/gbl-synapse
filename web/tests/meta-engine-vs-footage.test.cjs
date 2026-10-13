'use strict';
// Unit tests for tests/meta-benchmark/engine-vs-footage.cjs on synthetic evidence. The real comparison needs the
// local harvest results and is run by hand; these tests check the statistics, the label joins and the damage
// comparisons on inputs whose answers are known in advance, using the repository's own game master.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const evf=require('./meta-benchmark/engine-vs-footage.cjs');
const {createProbe,defaultData}=require('../training/engine-probe.cjs');
const MetaCombat=require('../includes/meta/combat.js');
const data=evf.gameData(defaultData()),probe=createProbe();
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,a+' != '+b);

test('quantiles interpolate and summaries report n, median and quartiles',()=>{
 assert.equal(evf.quantile([],.5),null);
 assert.equal(evf.quantile([5],.9),5);
 assert.equal(evf.quantile([1,2,3,4],.5),2.5);
 const s=evf.summarize([0.8,0.9,1,1.1,1.2]);assert.deepEqual([s.n,s.median,s.q1,s.q3],[5,1,0.9,1.1]);
});
test('a hit is inside the range strictly, or inside it widened by the extractor\'s noise',()=>{
 const range=[0.04,0.05],h=evf.hitCheck([0.039,0.04,0.045,0.05,0.051,0.08,0.2],range);
 assert.deepEqual([h.n,h.inside],[7,3]);
 const [lo,hi]=evf.widen(range);near(lo,0.04-(0.013+0.15*0.04));near(hi,0.05+0.013+0.15*0.05);
 assert.equal(h.insideBand,5,'0.039 to 0.051 are inside the band up to '+hi.toFixed(4)+'; 0.08 and 0.2 are outside');
});
test('spacing: gaps on multiples of the duration score, one-turn moves are not scoreable, other durations are the baseline',()=>{
 // a two-turn move (1.0 s) hit at 0, 1, 2, 4 (a missed hit), with 10 s pause excluded and 0.4 s double detection
 const times=[0,1.0,2.05,4.0,14,14.4];
 const g=evf.gapStats(times,2);
 assert.equal(g.gaps,4,'1.0, 1.05, 1.95 and 0.4 remain; 10 s is a pause');
 assert.equal(g.within,3,'1.0, 1.05 and 1.95 are within 0.25 s of 1 or 2 durations');
 assert.equal(g.plausible,3,'0.4 s is shorter than one duration minus tolerance');
 assert.equal(g.withinPlausible,3);
 assert.deepEqual(g.others.length,3);
 assert.ok(g.others.every(x=>x<g.within),'the labelled duration beats every alternative on these gaps');
 const one=evf.gapStats([0,0.5,1.0,1.5],1);
 assert.equal(one.vacuous,true);assert.equal(one.scored,0);assert.equal(one.gaps,3);
 assert.equal(evf.gapStats([],2).gaps,0);
 assert.equal(evf.gapStats(undefined,3).gaps,0);
});
test('aggregated spacing reports a lift over the other durations and per-case verdicts',()=>{
 const good={times:[0,1,2,3,4],turns:2},wrong={times:[0,1.5,3,4.5],turns:2},none={times:[0,0.5],turns:1};
 const a=evf.aggregateGaps([good,wrong,none]);
 assert.equal(a.oneTurnGapsNotScored,1);
 assert.equal(a.scored,7);
 assert.equal(a.verdicts.better+a.verdicts.tied+a.verdicts.worse,2);
 assert.equal(a.verdicts.better,1,'the evenly spaced 1.0 s case scores best for a two-turn move');
 assert.ok(a.withinTolerance>a.otherDurations);
});
test('labels join to the extraction battle with the largest time overlap and consistent opponents',()=>{
 const full=[{start:20,end:210,opponent:[{key:'melmetal'},{key:'feraligatr'}]},{start:220,end:400,opponent:[{key:'skeledirge'},{key:'umbreon'}]},{start:403,end:560,opponent:[{key:'typhlosion'}]}];
 assert.equal(evf.matchBattle({start:24,end:202,opp:['Melmetal','Feraligatr','Gourgeist']},full),0);
 assert.equal(evf.matchBattle({start:224,end:389,opp:['Skeledirge']},full),1);
 assert.equal(evf.matchBattle({start:404,end:551,opp:['Typhlosion']},full),2);
 assert.equal(evf.matchBattle({start:1000,end:1100,opp:['Melmetal']},full),-1,'no overlap');
 assert.equal(evf.matchBattle({start:24,end:202,opp:['Pikachu','Raichu']},full),-1,'overlapping time but a different opponent team');
 assert.equal(evf.normalizeName('Kommo-o'),'kommoo');
});
test('Shadow status and forms come from the labels: this battle first, an all-battles answer second, otherwise unknown',()=>{
 const idx=evf.labelIndex([{video:'v',battle:2,side:'opponent',key:'feraligatr',kind:'shadow',value:true,allBattles:false},{video:'v',battle:0,side:'my',key:'sableye',kind:'shadow',value:false,allBattles:true},{video:'v',battle:1,side:'my',key:'sableye',kind:'shadow',value:true,allBattles:false},{video:'v',battle:0,side:'my',key:'dialga',kind:'form',value:'dialga_origin',allBattles:false}]);
 assert.equal(idx.get('v',2,'opponent','feraligatr','shadow'),true);
 assert.equal(idx.get('v',3,'opponent','feraligatr','shadow'),undefined);
 assert.equal(idx.get('v',5,'my','sableye','shadow'),false,'applies to every battle');
 assert.equal(idx.get('v',1,'my','sableye','shadow'),true,'a battle-specific answer wins');
 assert.equal(idx.get('v',0,'my','dialga','form'),'dialga_origin');
 const member=evf.resolveMember({key:'feraligatr',cp:1498,formId:'feraligatr'},idx,{video:'v',battle:2,side:'opponent'},data);
 assert.equal(member.id,'feraligatr_shadow');assert.equal(member.shadow,true);assert.equal(member.statusKnown,true);
 const unknown=evf.resolveMember({key:'feraligatr',cp:1498,formId:'feraligatr'},idx,{video:'v',battle:3,side:'opponent'},data);
 assert.equal(unknown.id,'feraligatr');assert.equal(unknown.statusKnown,false);
});

// ---- measured hits equal to what the formulas predict ----------------------------------------------------------
const cpOf=id=>probe.stats(probe.pokemon(id)).cp;
const engineFraction=(attacker,defender,moveId,charged)=>{const a=probe.pokemon(attacker,{moveset:charged?[null,moveId]:[moveId]}),d=probe.pokemon(defender,{index:1});return probe.damage(a,d,charged?a.chargedMoves[0]:a.fastMove)/d.stats.hp;};
const env=()=>({league:()=>1500,engine:evf.makeEngine({probeFactory:()=>probe,gmFor:()=>null})});
function battleFor({attacker,defender,sizes,times,charged}){
 return {start:10,end:80,my:[{key:attacker,cp:cpOf(attacker)}],opponent:[{key:defender,cp:cpOf(defender)}],
  matchups:[{start:10,end:80,my:attacker,opponent:defender,hitsOnOpp:sizes,hitTimesOnOpp:times,hitsOnMy:[],hitTimesOnMy:[],chargedOnOpp:charged||[],chargedOnMy:[]}]};
}
test('hits equal to the engine\'s default-IV damage sit inside the CP-consistent range, ratio 1, with spacing on the move duration',()=>{
 const fraction=engineFraction('sableye','cramorant','SHADOW_CLAW',false),times=[11,12,13,14,15,16];
 const battle=battleFor({attacker:'sableye',defender:'cramorant',sizes:times.map(()=>fraction),times});
 const labels=evf.labelIndex([]),{rows,skipped}=evf.fastCasesForBattle({video:'v',battleIndex:0,battle,fast:[{side:'my',key:'sableye',value:'SHADOW_CLAW',source:'benchmark'}],labels,data,env:env()});
 assert.deepEqual(skipped,{});assert.equal(rows.length,1);
 const r=rows[0];assert.equal(r.turns,2);assert.equal(r.engineTurns,2);assert.equal(r.cpKnown,true);assert.equal(r.statusKnown,false);
 near(r.engine,fraction);
 const agg=evf.aggregateHits(rows);
 assert.equal(agg.hits,6);assert.equal(agg.inside,1,'default IVs are one of the combinations the CPs allow');
 assert.equal(agg.ratioToEngineDefault.median,1);
 assert.ok(Math.abs(agg.ratioToRangeCentre.median-1)<0.2);
 const timing=evf.aggregateGaps(rows);assert.equal(timing.withinTolerance,1);assert.equal(timing.verdicts.better,1);
 const strata=evf.summarizeFast(rows);assert.equal(strata.statusUnknown.cases,1);assert.equal(strata.predictedAtLeast4pct.cases+strata.predictedBelow4pct.cases,1,'every case is in exactly one size stratum');
});
test('a hit three times the predicted size falls outside the range and the band and triples the ratio',()=>{
 const fraction=engineFraction('sableye','cramorant','SHADOW_CLAW',false);
 const battle=battleFor({attacker:'sableye',defender:'cramorant',sizes:[3*fraction,3*fraction],times:[11,12]});
 const {rows}=evf.fastCasesForBattle({video:'v',battleIndex:0,battle,fast:[{side:'my',key:'sableye',value:'SHADOW_CLAW'}],labels:evf.labelIndex([]),data,env:env()});
 const agg=evf.aggregateHits(rows);assert.equal(agg.inside,0);assert.equal(agg.insideBand,0);assert.equal(agg.ratioToEngineDefault.median,3);
});
test('an unknown labelled move, species or an attacker that never appears is skipped with a reason',()=>{
 const battle=battleFor({attacker:'sableye',defender:'cramorant',sizes:[0.03],times:[11]});
 const {rows,skipped}=evf.fastCasesForBattle({video:'v',battleIndex:0,battle,fast:[{side:'my',key:'sableye',value:'NOT_A_MOVE'},{side:'my',key:'ghost',value:'SHADOW_CLAW'},{side:'my',key:'sableye',value:'ICY_WIND'}],labels:evf.labelIndex([]),data,env:env()});
 assert.equal(rows.length,0);
 assert.equal(skipped['move unknown in the game data'],2,'an unknown id and a charged move');
 assert.equal(skipped['member not in the battle'],1);
});
test('charged hits at the engine\'s damage match its range and ratio; a charged move without a size is ignored',()=>{
 const fraction=engineFraction('sableye','cramorant','FOUL_PLAY',true);
 const battle=battleFor({attacker:'sableye',defender:'cramorant',sizes:[],times:[],charged:[{move:'FOUL_PLAY',size:fraction,t:30},{move:'FOUL_PLAY',size:NaN,t:40},{move:'NOT_A_MOVE',size:0.2,t:50}]});
 const rows=evf.chargedCasesForBattle({video:'v',battleIndex:0,battle,labels:evf.labelIndex([]),data,env:env()});
 assert.equal(rows.length,1);
 const agg=evf.aggregateCharged(rows);assert.equal(agg.hits,1);assert.equal(agg.inside,1);assert.equal(agg.ratioToEngineDefault.median,1);
});
test('the emulator\'s DamageCalculator and combat.js agree on every sampled level/IV pair',()=>{
 const make=(id,shadow)=>({id,entry:data.pokemon.get(id),cp:cpOf(id),shadow});
 for(const [a,d,moveId] of [['sableye','cramorant','SHADOW_CLAW'],['quagsire_shadow','pidgeot','MUD_SHOT'],['sableye_shadow','azumarill','SHADOW_CLAW'],['melmetal','mimikyu','DOUBLE_IRON_BASH']]){
  const c=evf.parityCheck({attacker:make(a,/_shadow$/.test(a)),defender:make(d,/_shadow$/.test(d)),move:data.moves.get(moveId),league:1500,probe,pairs:9});
  if(!c)continue;
  assert.ok(c.n>=4);assert.equal(c.equalDamage,c.n,a+' '+moveId+' vs '+d);assert.equal(c.equalStats,c.n);
 }
});
test('the full run refuses to guess when the harvest results are missing',()=>{
 const empty=fs.mkdtempSync(path.join(os.tmpdir(),'evf-'));
 assert.throws(()=>evf.run({work:empty}),/No harvest results/);
 fs.rmSync(empty,{recursive:true});
});
test('the report prints without throwing for a minimal summary',()=>{
 const stratum={cases:0,all:{hits:0,inside:null,insideBand:null,ratioToRangeCentre:{n:0},ratioToEngineDefault:{n:0}},first12s:{inside:null},timing:{gaps:0,scored:0,withinTolerance:null,otherDurations:null,lift:null,plausibleGaps:0,withinTolerancePlausible:null,verdicts:{better:0,tied:0,worse:0}}};
 const fast=Object.fromEntries(['all','predictedAtLeast4pct','predictedBelow4pct','statusConfirmed','confirmedNoShadow','confirmedShadowInvolved','statusUnknown','benchmarkLabels','reviewerAnswers','reviewerOverrodeModel'].map(k=>[k,stratum]));
 const charged={hits:0,inside:null,insideBand:null,ratioToRangeCentre:{n:0},ratioToEngineDefault:{n:0}};
 const lines=[];evf.printReport({createdAt:'2026-01-01',noise:evf.NOISE,inputs:{fastLabels:0,benchmarkFastLabels:0,answerFastLabels:0,unjoined:0,videos:0},skipped:{},perVideo:{},fast,charged:{all:charged,statusConfirmed:charged,confirmedNoShadow:charged,confirmedShadowInvolved:charged},parity:{cases:0,pairs:0,equalDamage:0,equalStats:0,damageMatch:null,statsMatch:null},moveDuration:{cases:0,engineEqualsGameData:0},rows:{fast:0,charged:0}},l=>lines.push(l));
 assert.ok(lines.length>10);
});
