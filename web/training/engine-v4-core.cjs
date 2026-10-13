'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'../includes/pro');
// Every encounter gets its own fresh Game Master. `data` is the parse of this
// text and is never mutated, so parsing the text again yields exactly the
// structure structuredClone(data) would, at about half the cost.
const gameMasterText=fs.readFileSync(path.join(base,'data/gamemaster.json'),'utf8'),data=JSON.parse(gameMasterText);
const archetypes=JSON.parse(fs.readFileSync(path.join(__dirname,'vendor/aiArchetypes.json')));
const {random,defaults}=require('./utils.cjs');
// Compile once per worker, rather than rereading/parsing the simulator for every
// training label. Each encounter still gets a fresh isolated VM and Game Master.
const scripts=new Map();
function runFile(file,context){let script=scripts.get(file);if(!script){script=new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});scripts.set(file,script);}script.runInContext(context);}
function play(teamA,teamB,policyA=defaults,policyB=defaults,{seed=1,cp=1500,lookahead=false,horizon=24,interval=4,trace=false,audit=false,neutralPriority=false,plannerTeams=[true,true],beliefRoster=[],beliefTeams=[],beliefSamples=3,simulationOptimizations=true}={}){
 let time=0,id=0,result=null,events=0,lastPhase='',timeouts=0;const timers=new Map(),rng=random(seed);
 const schedule=(fn,delay,repeat)=>{const key=++id;timers.set(key,{fn,at:time+delay,repeat});return key;};
 const math=Object.create(Math);math.random=rng;
 const globals={console:{log(){}},Math:math,host:'localhost',webRoot:'',siteVersion:'training',settings:{colorblindMode:false,hardMovesetLinks:false},
 $:{ajax(){},getJSON(url,cb){if(url.includes('aiArchetypes'))cb(archetypes);},each(items,cb){for(let i=0;i<items.length;i++)if(cb(i,items[i])===false)break;}},
 setTimeout:(fn,ms)=>schedule(fn,ms,0),setInterval:(fn,ms)=>schedule(fn,ms,ms),clearTimeout:key=>timers.delete(key),clearInterval:key=>timers.delete(key)};
 // A contextified sandbox resolves every global name (Math, Pokemon, ...)
 // through interceptors, which made each lookup cost hundreds of nanoseconds.
 // The optimized path installs the same globals on an ordinary context global
 // (Node 20.18+; older Node falls back to a contextified empty sandbox).
 const context=simulationOptimizations?Object.assign(vm.createContext(vm.constants?.DONT_CONTEXTIFY),globals):vm.createContext(globals);
 const load=f=>runFile(f,context);
 for(const f of ['GameMaster','DamageCalculator','ActionLogic','TimelineEvent','TimelineAction','DecisionOption','Battle','Pokemon'])load(path.join(base,'vendor/'+f+'.js'));
 load(path.join(__dirname,'vendor/TrainingAI.js'));load(path.join(__dirname,'vendor/Player.js'));
 load(path.join(__dirname,'next/lookahead-v4.js'));load(path.join(__dirname,'next/observations.js'));
 context.input={simulationOptimizations,trace,beliefRoster,beliefTeams,beliefSamples,plannerTeams,neutralPriority,lookahead,horizon,interval,audit,seed,data:simulationOptimizations?JSON.parse(gameMasterText):structuredClone(data),teams:[teamA,teamB],policies:[policyA,policyB],cp};
 vm.runInContext(`
 var gm=GameMaster.getInstance();gm.data=input.data;gm.originalData=gm.data;gm.createSearchMaps();gm.rankings={};
 installTeamSimulationSafety(input);
 var battle=new Battle();battle.simulationOptimizations=input.simulationOptimizations;battle.headless=input.simulationOptimizations&&!input.trace;battle.setCP(input.cp);
 var players=[new Player(0,3,battle),new Player(1,3,battle)];
 for(var i=0;i<2;i++){
   var team=input.teams[i].map(row=>{var p=new Pokemon(row.speciesId,i,battle);p.initialize(input.cp);p.selectMove('fast',row.moveset[0]);p.selectMove('charged',row.moveset[1],0);p.selectMove('charged',row.moveset[2]||'none',1);if(row.moveset[3]&&p.hasThirdChargedMove())p.selectMove('extra-charged',row.moveset[3],2);return p;});
   players[i].setRoster(team);players[i].setTeam(team);
   var ai=players[i].getAI();

   (function(ai,policy){var choose=ai.chooseOption;ai.chooseOption=function(options){return choose.call(ai,options.map(o=>{var factor=o.name==='SWITCH_BASIC'?policy.switch:o.name==='SWITCH_FARM'?policy.switchFarm:o.name==='BAIT_SHIELDS'?policy.bait:o.name==='FARM'?policy.farm:o.name===true?policy.shield:o.name===false?1/policy.shield:1;return new DecisionOption(o.name,Math.max(0,Math.round(o.weight*factor)));}));};})(ai,input.policies[i]);
 }
 battle.setPlayers(players);
 if(input.neutralPriority)players.forEach(p=>p.setPriority(0));
 if(input.lookahead){var plannerStats=installTeamLookahead(battle,players,input);}
 for(var i=0;i<2;i++)battle.setNewPokemon(players[i].getTeam()[0],i,false);
 `,context);
 const b=context.battle,players=context.players;
 const samples=[];
 const capture=()=>{if(!trace)return;const row=[time/1000,b.getTurns()||0,Array.from(players,p=>Array.from(p.getTeam(),m=>Math.max(0,m.hp))).flat(),Array.from(b.getPokemon(),p=>p.speciesId),Array.from(players,p=>p.getShields())];const last=samples.at(-1);if(!last||JSON.stringify(row.slice(2))!==JSON.stringify(last.slice(2)))samples.push(row);};
 const teamStats=trace?Array.from(players,p=>Array.from(p.getTeam(),m=>({speciesId:m.speciesId,name:m.speciesName,maxHP:m.stats.hp}))):null;
 capture();
 const queue=b.queueAction;
 b.queueAction=function(index,type,value){
   // A delayed vendor forced-switch callback can arrive after this trainer has
   // already replaced that Pokémon. It must not start a fake voluntary clock.
   if(type==='switch'&&players[index].getTeam()[value]===b.getPokemon()[index])return false;
   return queue.call(b,index,type,value);
 };
 const decrement=players[0].decrementSwitchTimer;
 players[0].decrementSwitchTimer=function(ms){const expires=this.getSwitchTimer()>0&&this.getSwitchTimer()<=ms;decrement.call(this,ms);if(expires)this.getAI().evaluateMatchup(b.getTurns(),b.getPokemon()[0],b.getPokemon()[1],players[1]);};
 // The interactive engine explicitly reevaluates side 1 after charged moves.
 // Give side 0 the same opportunity without changing combat rules.
 b.emulate(state=>{
   if(state.phase==='suspend_charged')b.setChargeAmount(1);
   if(state.phase==='suspend_switch'){
     for(const index of state.actors)b.queueAction(index,'switch',players[index].getAI().decideSwitch());
   }
   if(state.phase==='neutral'&&lastPhase==='animating'&&b.getPokemon().every(p=>p.hp>0))players[0].getAI().evaluateMatchup(b.getTurns(),b.getPokemon()[0],b.getPokemon()[1],players[1]);
   lastPhase=state.phase;if(state.phase==='game_over')result=players[0].getRemainingPokemon()>0?(players[1].getRemainingPokemon()>0?.5:1):(players[1].getRemainingPokemon()>0?0:.5);
 });
 players[0].getAI().evaluateMatchup(1,b.getPokemon()[0],b.getPokemon()[1],players[1]);
 while(result===null&&events++<30000&&time<600000){
   let key,item;for(const [k,t] of timers)if(!item||t.at<item.at||(t.at===item.at&&k<key)){key=k;item=t;}
   if(!item)throw new Error('Engine stalled without scheduled events');
   time=item.at;if(item.repeat)item.at+=item.repeat;else timers.delete(key);item.fn();capture();
 }
 if(result===null){timeouts++;result=.5;}
 capture();const timeline=b.getTimeline();b.stop();timers.clear();const planner=lookahead?{...context.plannerStats}:null;if(planner?.observed)planner.observed=JSON.parse(JSON.stringify(planner.observed()));
 return {...(trace?{samples,teamStats,timeline:Array.from(timeline,e=>({turn:e.turn,time:e.time,type:e.type,name:e.name,actor:e.actor})).filter(e=>/^(fast |charged |switch|faint|shield)/.test(e.type))}:{}),score:result,turns:b.getTurns(),timedOut:!!timeouts,charged:timeline.filter(e=>e.type.startsWith('charged ')).length,remaining:Array.from(players,p=>p.getRemainingPokemon()),...(lookahead?{planner}:{})};
}
module.exports={play,random,defaults};
