'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../includes/pro');
const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json')));
const archetypes=JSON.parse(fs.readFileSync(path.join(__dirname,'vendor/aiArchetypes.json')));
const {random,defaults}=require('./utils.cjs');
function play(teamA,teamB,policyA=defaults,policyB=defaults,{seed=1,cp=1500}={}){
 let time=0,id=0,result=null,events=0,lastPhase='',timeouts=0;const timers=new Map(),rng=random(seed);
 const schedule=(fn,delay,repeat)=>{const key=++id;timers.set(key,{fn,at:time+delay,repeat});return key;};
 const math=Object.create(Math);math.random=rng;
 const context=vm.createContext({console:{log(){}},Math:math,host:'localhost',webRoot:'',siteVersion:'training',settings:{colorblindMode:false,hardMovesetLinks:false},
 $:{ajax(){},getJSON(url,cb){if(url.includes('aiArchetypes'))cb(archetypes);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}},
 setTimeout:(fn,ms)=>schedule(fn,ms,0),setInterval:(fn,ms)=>schedule(fn,ms,ms),clearTimeout:key=>timers.delete(key),clearInterval:key=>timers.delete(key)});
 const load=f=>vm.runInContext(fs.readFileSync(f,'utf8'),context,{filename:f});
 for(const f of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'])load(path.join(base,'vendor/'+f+'.js'));
 load(path.join(__dirname,'vendor/TrainingAI.js'));load(path.join(__dirname,'vendor/Player.js'));
 context.input={data:structuredClone(data),teams:[teamA,teamB],policies:[policyA,policyB],cp};
 vm.runInContext(`
 var gm=GameMaster.getInstance();gm.data=input.data;gm.originalData=gm.data;gm.createSearchMaps();gm.rankings={};
 var battle=new Battle();battle.setCP(input.cp);
 var players=[new Player(0,3,battle),new Player(1,3,battle)];
 for(var i=0;i<2;i++){
   var team=input.teams[i].map(row=>{var p=new Pokemon(row.speciesId,i,battle);p.initialize(input.cp);p.selectMove('fast',row.moveset[0]);p.selectMove('charged',row.moveset[1],0);p.selectMove('charged',row.moveset[2]||'none',1);if(row.moveset[3]&&p.hasThirdChargedMove())p.selectMove('extra-charged',row.moveset[3],2);return p;});
   players[i].setRoster(team);players[i].setTeam(team);
   var ai=players[i].getAI();
   (function(ai,policy){var choose=ai.chooseOption;ai.chooseOption=function(options){return choose.call(ai,options.map(o=>{var factor=o.name==='SWITCH_BASIC'?policy.switch:o.name==='SWITCH_FARM'?policy.switchFarm:o.name==='BAIT_SHIELDS'?policy.bait:o.name==='FARM'?policy.farm:o.name===true?policy.shield:o.name===false?1/policy.shield:1;return new DecisionOption(o.name,Math.max(0,Math.round(o.weight*factor)));}));};})(ai,input.policies[i]);
 }
 battle.setPlayers(players);for(var i=0;i<2;i++)battle.setNewPokemon(players[i].getTeam()[0],i,false);
 `,context);
 const b=context.battle,players=context.players;
 // The interactive engine explicitly reevaluates side 1 after charged moves.
 // Give side 0 the same opportunity without changing combat rules.
 b.emulate(state=>{
   if(state.phase==='suspend_charged')b.setChargeAmount(1);
   if(state.phase==='suspend_switch'&&state.actors.includes(0)){
     b.queueAction(0,'switch',players[0].getAI().decideSwitch());
   }
   if(state.phase==='neutral'&&lastPhase==='animating'&&b.getPokemon().every(p=>p.hp>0))players[0].getAI().evaluateMatchup(b.getTurns(),b.getPokemon()[0],b.getPokemon()[1],players[1]);
   lastPhase=state.phase;if(state.phase==='game_over')result=players[0].getRemainingPokemon()>0?(players[1].getRemainingPokemon()>0?.5:1):(players[1].getRemainingPokemon()>0?0:.5);
 });
 players[0].getAI().evaluateMatchup(1,b.getPokemon()[0],b.getPokemon()[1],players[1]);
 while(result===null&&events++<30000&&time<600000){
   let key,item;for(const [k,t] of timers)if(!item||t.at<item.at||(t.at===item.at&&k<key)){key=k;item=t;}
   if(!item)throw new Error('Engine stalled without scheduled events');
   time=item.at;if(item.repeat)item.at+=item.repeat;else timers.delete(key);item.fn();
 }
 if(result===null){timeouts++;result=.5;}
 const timeline=b.getTimeline();b.stop();timers.clear();
 return {score:result,turns:b.getTurns(),timedOut:!!timeouts,charged:timeline.filter(e=>e.type.startsWith('charged ')).length,remaining:Array.from(players,p=>p.getRemainingPokemon())};
}
module.exports={play,random,defaults};
