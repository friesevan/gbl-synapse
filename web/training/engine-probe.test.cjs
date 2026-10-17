'use strict';
// The engine probe builds the vendor damage code the way engine-v4-core builds a battle. These tests pin that
// it agrees with the game master's default IVs and with the Meta Extractor's copy of the damage formula
// (includes/meta/combat.js) for the same level/IV pairs, so the footage comparison in
// tests/meta-benchmark/engine-vs-footage.cjs compares like with like.
const test=require('node:test'),assert=require('node:assert/strict');
const {createProbe,defaultData}=require('./engine-probe.cjs');
const combat=require('../includes/meta/combat.js');
const data=defaultData(),species=new Map(data.pokemon.map(p=>[p.speciesId,p])),moves=new Map(data.moves.map(m=>[m.moveId,m]));
const rows=require('../includes/pro/data/league-1500.json').overall;
const probe=createProbe();

test('default-IV Pokémon carry the game master\'s level and IVs and respect the cap',()=>{
 for(const id of ['sableye','cramorant','medicham','azumarill','quagsire_shadow','lickitung','melmetal']){
  const p=probe.pokemon(id),s=probe.stats(p),want=species.get(id.replace(/_shadow$/,'')).defaultIVs.cp1500;
  assert.equal(s.level,want[0],id);assert.deepEqual(s.ivs,want.slice(1),id);assert.ok(s.cp<=1500,id+' CP '+s.cp);
 }
});
test('an explicit level and IV pair reproduces the Meta Extractor\'s stat combinations exactly',()=>{
 for(const [id,cp] of [['sableye',1496],['cramorant',1498],['medicham',1495],['azumarill',1500]]){
  const combos=combat.statCombos(species.get(id),cp);assert.ok(combos.length>0,id);
  for(const c of [combos[0],combos[Math.floor(combos.length/2)],combos[combos.length-1]]){
   const p=probe.pokemon(id,{level:c.level,ivs:c.ivs}),s=probe.stats(p);
   assert.equal(s.atk,c.atk);assert.equal(s.def,c.def);assert.equal(s.hp,c.hp);assert.equal(s.cp,cp);
  }
 }
});
test('DamageCalculator and combat.damage give the same integer damage for sampled level/IV pairs, fast and charged, with Shadow',()=>{
 let checked=0;
 const pairs=[['sableye','cramorant'],['quagsire_shadow','pidgeot'],['medicham_shadow','azumarill'],['melmetal','mimikyu'],['lickitung','talonflame_shadow']];
 for(const [a,d] of pairs){
  const ra=rows.find(r=>r.speciesId===a),rd=rows.find(r=>r.speciesId===d);if(!ra||!rd)continue;
  const cp=id=>probe.stats(probe.pokemon(id)).cp,A=combat.statCombos(species.get(a),cp(a)),D=combat.statCombos(species.get(d),cp(d));
  for(const [i,c] of [A[0],A[A.length>>1],A[A.length-1]].entries()){
   const e=D[(i*7)%D.length],ea=probe.pokemon(a,{moveset:ra.moveset,level:c.level,ivs:c.ivs}),ed=probe.pokemon(d,{moveset:rd.moveset,level:e.level,ivs:e.ivs,index:1});
   for(const [id,move] of [[ra.moveset[0],ea.fastMove],[ra.moveset[1],ea.chargedMoves[0]]]){
    const sa=/_shadow$/.test(a)?combat.MULT.SHADOW_ATK:1,sd=/_shadow$/.test(d)?combat.MULT.SHADOW_DEF:1;
    const mine=combat.damage(moves.get(id),combat.types(species.get(a)),c.atk*sa,combat.types(species.get(d)),e.def*sd);
    assert.equal(probe.damage(ea,ed,move),mine,a+' '+id+' vs '+d);checked++;
   }
  }
 }
 assert.ok(checked>=20,'checked '+checked);
});
test('fast-move durations in the game master are whole turns of 0.5 s, the unit the emulator steps in',()=>{
 for(const m of data.moves.filter(m=>m.energy===0&&m.cooldown)){assert.equal(m.cooldown%500,0,m.moveId);assert.equal(m.turns,m.cooldown/500,m.moveId);}
});
test('two probes are independent: a different game master changes damage in its own probe only',()=>{
 const damageIn=pr=>{const a=pr.pokemon('sableye',{moveset:['SHADOW_CLAW']}),b=pr.pokemon('cramorant',{index:1});return pr.damage(a,b,a.fastMove);};
 const before=damageIn(probe);
 const changed=structuredClone(data);changed.moves.find(m=>m.moveId==='SHADOW_CLAW').power=30;
 const other=createProbe({data:changed});
 assert.ok(damageIn(other)>before);
 assert.equal(damageIn(probe),before);
});
