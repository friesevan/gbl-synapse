'use strict';
// Read-only probe of PvPoke's vendor damage code, built exactly the way engine-v4-core.cjs builds a battle
// context (same vendor files, same globals, same GameMaster construction), but without players, timers or
// the controller. It exists so tools can ask the pinned engine "what does DamageCalculator.damage say for
// these two Pokémon and this move?" and compare the answer with something else (the Meta Extractor's copy
// of the formula in includes/meta/combat.js, or hit sizes measured from footage). Nothing here is part of
// the mechanics hash: it only reads the vendor files and never alters them.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../includes/pro');
const VENDOR=['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'];
const sources=new Map();
const compiled=file=>{let s=sources.get(file);if(!s){s=new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});sources.set(file,s);}return s;};
const defaultData=()=>JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json'),'utf8'));
const archetypes=()=>JSON.parse(fs.readFileSync(path.join(__dirname,'vendor/aiArchetypes.json'),'utf8'));
// data: a parsed game master (PvPoke gamemaster.json); cp: the league cap the battle is created for.
// The engine fills in default IVs and levels for that cap, as it does in Team Rankings (cp 1500).
function createProbe({data=defaultData(),cp=1500}={}){
 const aiData=archetypes();
 const context=vm.createContext({console:{log(){},error(){}},Math:Object.create(Math),host:'localhost',webRoot:'',siteVersion:'training',settings:{colorblindMode:false,hardMovesetLinks:false},
  $:{ajax(){},getJSON(url,cb){if(String(url).includes('aiArchetypes'))cb(aiData);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}},
  setTimeout:()=>0,setInterval:()=>0,clearTimeout(){},clearInterval(){}});
 for(const f of VENDOR)compiled(path.join(base,'vendor/'+f+'.js')).runInContext(context);
 context.input={data:structuredClone(data),cp};
 vm.runInContext(`
  var gm=GameMaster.getInstance();gm.data=input.data;gm.originalData=gm.data;gm.createSearchMaps();gm.rankings={};
  var battle=new Battle();battle.setCP(input.cp);
  var nextIndex=0;
  function makePokemon(speciesId,index){var p=new Pokemon(speciesId,index,battle);p.initialize(input.cp);return p;}
 `,context);
 const battle=context.battle;
 // A Pokémon at the engine's default IVs for the cap, or at an explicit level and IV spread (as the Meta
 // Extractor's statCombos enumerates them). moveset: [fast, charged1, charged2?]; unknown moves throw.
 function pokemon(speciesId,{moveset=[],level=null,ivs=null,index=0}={}){
  if(!context.gm.getPokemonById(speciesId))throw new Error('Unknown species '+speciesId);
  const p=context.makePokemon(speciesId,index);
  if(level!==null&&ivs){p.ivs.atk=ivs[0];p.ivs.def=ivs[1];p.ivs.hp=ivs[2];p.setLevel(level,true);}
  if(moveset[0])p.selectMove('fast',moveset[0]);
  moveset.slice(1,3).forEach((m,i)=>m&&p.selectMove('charged',m,i));
  return p;
 }
 // Same call the simulation makes for every fast and charged hit (full charge, no stat stages).
 // (class declarations are not properties of the context object, so fetch the class by evaluating its name)
 const Calculator=vm.runInContext('DamageCalculator',context);
 const damage=(attacker,defender,move)=>Calculator.damage(attacker,defender,move);
 const stats=p=>({speciesId:p.speciesId,level:p.level,ivs:[p.ivs.atk,p.ivs.def,p.ivs.hp],atk:p.stats.atk,def:p.stats.def,hp:p.stats.hp,cp:p.cp,shadow:p.shadowType==='shadow',types:p.types.slice(),cpm:p.cpm});
 // Look a move up by id in the loaded game master (any category).
 const move=id=>context.gm.getMoveById?context.gm.getMoveById(id):null;
 return {context,battle,pokemon,damage,stats,move,cp,data:context.input.data};
}
module.exports={createProbe,defaultData};
