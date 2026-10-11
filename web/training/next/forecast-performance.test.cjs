'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const plain=x=>JSON.parse(JSON.stringify(x));
function setup(optimized){
 const c=vm.createContext({Math:Object.create(Math),console:{log(){},error(){}},host:'localhost',webRoot:'',siteVersion:'test',settings:{hardMovesetLinks:false,colorblindMode:false},$:{ajax(){},getJSON(){},each(rows,cb){for(let i=0;i<rows.length;i++)if(cb(i,rows[i])===false)break;}}});
 for(const n of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'])vm.runInContext(fs.readFileSync(path.join(root,'includes/pro/vendor',n+'.js'),'utf8'),c);
 for(const f of ['lookahead-v4.js','observations.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,f),'utf8'),c);
 c.data=structuredClone(require('../../includes/pro/data/gamemaster.json'));c.ranks=require('../../includes/pro/data/league-1500.json').overall;c.optimized=optimized;
 vm.runInContext(`var gm=GameMaster.getInstance();gm.data=data;gm.originalData=data;gm.createSearchMaps();gm.rankings={};installTeamSimulationSafety();var b=new Battle();b.setCP(1500);b.simulationOptimizations=optimized;var options={cp:1500,simulationOptimizations:optimized,beliefTeams:[['melmetal','altaria','cramorant']],beliefRoster:ranks.map(p=>({...p,dex:gm.getPokemonById(p.speciesId).dex,weight:1}))};var initialized=0,OriginalPokemon=Pokemon;Pokemon=function(...args){var p=new OriginalPokemon(...args),initialize=p.initialize;p.initialize=function(...args){initialized++;return initialize.apply(p,args);};return p;};Object.setPrototypeOf(Pokemon,OriginalPokemon);Pokemon.prototype=OriginalPokemon.prototype;var k=teamObservedKnowledge(options);k.reveal({speciesId:'melmetal',form:'melmetal',hpFraction:.71,buffs:[1,-1]});k.attack('melmetal','THUNDER_SHOCK',3);var worlds=k.hypotheses(1,b,4,()=>.1,3);var next=k.activeGuess(1,b,4);`,c);
 return c;
}
test('public default-stat templates replace repeated construction without changing belief worlds',()=>{
 const base=setup(false),fast=setup(true);
 assert.deepEqual(plain(fast.worlds),plain(base.worlds));assert.deepEqual(plain(fast.next),plain(base.next));
 assert.equal(base.initialized,10);assert.equal(fast.initialized,3);
 // A caller can mutate every container in one world without contaminating a
 // later world or its cached template.
 vm.runInContext(`worlds[0].team[0].stats.hp=-1;worlds[0].team[0].ivs.atk=99;worlds[0].team[0].buffs[0]=99;worlds[0].team[0].moveset[0]='invalid';worlds[0].team[0].types[0]='invalid';var isolated=k.activeGuess(1,b,4);`,fast);
 assert.deepEqual(plain(fast.isolated),plain(base.next));assert.equal(fast.initialized,3);
});
test('template keys invalidate after revealed moves and form changes, preserving native stages',()=>{
 const base=setup(false),fast=setup(true);
 const source=`k.reveal({speciesId:'morpeko_full_belly',form:'morpeko_full_belly',hpFraction:.66,buffs:[0,0]});k.attack('morpeko_full_belly','AURA_WHEEL_ELECTRIC',5);var belly=k.activeGuess(1,b,5);k.reveal({speciesId:'morpeko_full_belly',form:'morpeko_hangry',hpFraction:.57,buffs:[2,-2]});var hangry=k.activeGuess(1,b,6);k.reveal({speciesId:'mimikyu',form:'mimikyu_busted',hpFraction:.51,buffs:[1,-2]});var busted=k.activeGuess(1,b,7);`;
 for(const c of [base,fast])vm.runInContext(source,c);
 for(const name of ['belly','hangry','busted'])assert.deepEqual(plain(fast[name]),plain(base[name]));
 assert.equal(fast.hangry.form,'morpeko_hangry');assert.equal(fast.busted.native[1],-1);
});
test('selected-move forecast construction preserves duel outcomes, event timing, and special forms',()=>{
 for(const species of ['melmetal','mimikyu','morpeko_full_belly','aegislash_shield','cramorant']){
  const contexts=[setup(false),setup(true)];
  for(const c of contexts){c.species=species;vm.runInContext(`var p=new Pokemon(species,0,b);p.initialize(1500);if(species==='mimikyu')p.changeForm('mimikyu_busted');if(species==='morpeko_full_belly')p.changeForm('morpeko_hangry');p.hp=Math.round(p.stats.hp*.65);p.energy=47;p.cooldown=500;p.shields=1;p.statBuffs=[1,-1];var saved=captureTeamLookaheadPokemon(p);var duel=new Battle();duel.setCP(1500);duel.simulationOptimizations=optimized;var left=createTeamLookaheadPokemon(saved,0,duel),right=new Pokemon('altaria',1,duel);right.initialize(1500);right.startingShields=1;duel.setNewPokemon(left,0,false);duel.setNewPokemon(right,1,false);duel.setBuffChanceModifier(-1);duel.start();for(var turn=0;turn<24&&left.hp>0&&right.hp>0;turn++)duel.step();var result={left:captureTeamLookaheadPokemon(left),right:captureTeamLookaheadPokemon(right),elapsed:teamLookaheadElapsed(duel),turns:duel.getTurns(),timeline:duel.getTimeline()};`,c);}
  assert.deepEqual(plain(contexts[1].result),plain(contexts[0].result),species);
 }
});
