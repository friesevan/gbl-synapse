'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const data = require('../includes/pro/data/gamemaster.json');
function setup() {
 const c = vm.createContext({console, host:'localhost', webRoot:'', siteVersion:'test', settings:{hardMovesetLinks:false,colorblindMode:false}, $:{ajax(){},getJSON(){},each(a,cb){a.forEach((p,i)=>cb(i,p));}}});
 for(const name of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon']) vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../includes/pro/vendor',name+'.js'),'utf8'),c);
 c.data = structuredClone(data);
 vm.runInContext('var gm=GameMaster.getInstance();gm.data=data;gm.originalData=data;gm.createSearchMaps();gm.rankings={};',c);
 return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
test('immutable effectiveness tables exactly match every ordered typing and change with form', () => {
 const c = setup();
 vm.runInContext(`var all=Pokemon.getAllTypes(true),checked=0;for(var a of all)for(var b of all.concat(['none'])){var table=DamageCalculator.getCachedTypeEffectiveness([a,b]);if(!Object.isFrozen(table))throw Error('Mutable table');if(table!==DamageCalculator.getCachedTypeEffectiveness([a,b]))throw Error('No reuse');for(var move of all){if(table[move]!==DamageCalculator.getEffectiveness(move,[a,b]))throw Error('Typing mismatch');checked++;}}var battle=new Battle();battle.simulationOptimizations=true;var p=new Pokemon('morpeko_full_belly',0,battle);p.initialize(1500);p.changeForm('morpeko_hangry');var matched=p.typeEffectiveness===DamageCalculator.getCachedTypeEffectiveness(p.types);`,c);
 assert.equal(c.checked,18*18*19);assert.equal(c.matched,true);
});
test('cached move metadata matches original for all moves and isolates mutable fields', () => {
 const c = setup();
 vm.runInContext(`var pairs=data.moves.map(m=>[gm.getMoveById(m.moveId),gm.getSimulationMoveById(m.moveId)]);var x=gm.getSimulationMoveById('ICY_WIND'),y=gm.getSimulationMoveById('ICY_WIND');x.buffs[0]=99;x.tags.push('custom');x.damage=999;var isolated=y.buffs[0]!==99&&!y.tags.includes('custom')&&!('damage' in y);var old=gm.getSimulationMoveById('ICY_WIND');data.moves.find(m=>m.moveId==='ICY_WIND').power+=1;gm.createSearchMaps();var updated=gm.getSimulationMoveById('ICY_WIND');`,c);
 for(const [original,cached] of c.pairs) assert.deepEqual(plain(cached),plain(original));
 assert.equal(c.isolated,true);assert.equal(c.updated.power,c.old.power+1);
});
test('damage caching invalidates all numeric inputs including stages, Shadow, forms, HP methods and charge rules', () => {
 const c = setup();
 vm.runInContext(`var battle=new Battle();battle.setCP(1500);battle.simulationOptimizations=true;var a=new Pokemon('aegislash_shield',0,battle),d=new Pokemon('altaria',1,battle);a.initialize(1500);d.initialize(1500);var m=gm.getSimulationMoveById('SHADOW_BALL');a.initializeMove(m);var checks=0;
 function compare(charge=1,mode='simulate',players=[]){battle.cacheDamage=true;var cached=DamageCalculator.damage(a,d,m,charge,mode,players);var again=DamageCalculator.damage(a,d,m,charge,mode,players);battle.cacheDamage=false;var original=DamageCalculator.damage(a,d,m,charge,mode,players);if(cached!==original||again!==original)throw Error('Damage mismatch');checks++;}
 compare();a.statBuffs[0]=3;compare();d.statBuffs[1]=-2;compare();a.setShadowType('shadow');compare();d.setShadowType('shadow');compare();a.changeForm('aegislash_blade');compare();compare(.4);compare(0);compare(.4,'emulate',[{getAI(){return false;}}]);compare(.4,'emulate',[{getAI(){return {};}}]);m.energyGain=9;compare(.4,'emulate',[{getAI(){return false;}}]);m.power=33;compare();m.stab=1;compare();d.typeEffectiveness=Object.assign([],d.typeEffectiveness,{ghost:1.6});compare();m.damageMethod='percentMaxHP';compare();d.stats.hp=233;compare();m.damageMethod='default';a.tags.push('mega');a.megaLevel=3;m.isMegaMove=true;compare();a.megaLevel=4;compare();d.stats.def+=1;compare();a.stats.atk+=1;compare();`,c);
 assert.equal(c.checks,20);
});
test('forecast-only selected pools preserve initialized selected damage and retain special form pools', () => {
 const c = setup();c.rows=require('../includes/pro/data/league-1500.json').overall.slice(0,30);
 vm.runInContext(`var checked=0,reduced=0;for(var row of rows){var originalBattle=new Battle();originalBattle.setCP(1500);var optimizedBattle=new Battle();optimizedBattle.setCP(1500);optimizedBattle.simulationOptimizations=true;var old=new Pokemon(row.speciesId,0,originalBattle),next=new Pokemon(row.speciesId,0,optimizedBattle,undefined,{selectedMovesOnly:true,moveset:row.moveset});for(var p of [old,next]){p.initialize(1500);p.selectMove('fast',row.moveset[0]);p.selectMove('charged',row.moveset[1],0);p.selectMove('charged',row.moveset[2]||'none',1);p.reset();}if(JSON.stringify(old.stats)!==JSON.stringify(next.stats))throw Error('Stats mismatch');for(var index=0;index<old.chargedMoves.length;index++){if(old.chargedMoves[index].moveId!==next.chargedMoves[index].moveId||old.chargedMoves[index].damage!==next.chargedMoves[index].damage)throw Error('Move mismatch');}if(old.fastMove.damage!==next.fastMove.damage)throw Error('Fast damage mismatch');if(next.chargedMovePool.length<old.chargedMovePool.length)reduced++;checked++;}var b=new Battle();b.simulationOptimizations=true;var row=gm.getPokemonById('morpeko_full_belly'),special=new Pokemon(row.speciesId,0,b,undefined,{selectedMovesOnly:true,moveset:['THUNDER_SHOCK','AURA_WHEEL_ELECTRIC','PSYCHIC_FANGS']});var retained=special.chargedMovePool.length===row.chargedMoves.length;`,c);
 assert.equal(c.checked,30);assert.ok(c.reduced>20);assert.equal(c.retained,true);
});
