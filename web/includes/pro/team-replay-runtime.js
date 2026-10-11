// Portable replay of training/engine.cjs; parity checked by training/team-search/replay.test.cjs.
function replayTeamBattle(input){
 let time=0,id=0,result=null,events=0,lastPhase='';const timers=new Map(),samples=[];
 let seed=input.seed>>>0;const rng=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=Math.imul(seed^(seed>>>15),1|seed);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
 const schedule=(fn,delay,repeat)=>{const key=++id;timers.set(key,{fn,at:time+delay,repeat});return key;};
 Math.random=rng;globalThis.setTimeout=(fn,ms)=>schedule(fn,ms,0);globalThis.setInterval=(fn,ms)=>schedule(fn,ms,ms);globalThis.clearTimeout=key=>timers.delete(key);globalThis.clearInterval=key=>timers.delete(key);
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

 function capture(){const hp=players.flatMap(p=>Array.from(p.getTeam(),m=>Math.max(0,m.hp))),active=battle.getPokemon().map(p=>p.speciesId),shields=players.map(p=>p.getShields());const row=[time/1000,battle.getTurns(),hp,active,shields];const last=samples.at(-1);if(!last||JSON.stringify(row.slice(2))!==JSON.stringify(last.slice(2)))samples.push(row);}
 capture();

 // The interactive engine explicitly reevaluates side 1 after charged moves.
 // Give side 0 the same opportunity without changing combat rules.
 battle.emulate(state=>{
   if(state.phase==='suspend_charged')battle.setChargeAmount(1);
   if(state.phase==='suspend_switch'&&state.actors.includes(0)){
     battle.queueAction(0,'switch',players[0].getAI().decideSwitch());
   }
   if(state.phase==='neutral'&&lastPhase==='animating'&&battle.getPokemon().every(p=>p.hp>0))players[0].getAI().evaluateMatchup(battle.getTurns(),battle.getPokemon()[0],battle.getPokemon()[1],players[1]);
   lastPhase=state.phase;if(state.phase==='game_over')result=players[0].getRemainingPokemon()>0?(players[1].getRemainingPokemon()>0?.5:1):(players[1].getRemainingPokemon()>0?0:.5);
 });
 players[0].getAI().evaluateMatchup(1,battle.getPokemon()[0],battle.getPokemon()[1],players[1]);
 while(result===null&&events++<30000&&time<600000){
   let key,item;for(const [k,t] of timers)if(!item||t.at<item.at||(t.at===item.at&&k<key)){key=k;item=t;}
   if(!item)throw new Error('Engine stalled without scheduled events');
   time=item.at;if(item.repeat)item.at+=item.repeat;else timers.delete(key);item.fn();capture();
 }
 if(result===null){throw Error("Replay timed out");}

 capture();const timeline=Array.from(battle.getTimeline(),e=>({turn:e.turn,time:e.time,type:e.type,name:e.name,actor:e.actor})).filter(e=>/^(fast |charged |switch|faint|shield)/.test(e.type));
 const teamStats=players.map(p=>Array.from(p.getTeam(),m=>({speciesId:m.speciesId,name:m.speciesName,maxHP:m.stats.hp})));const turns=battle.getTurns();battle.stop();timers.clear();return {score:result,turns,remaining:players.map(p=>p.getRemainingPokemon()),samples,timeline,teamStats};
}
