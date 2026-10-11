/* Next-run switch policy. Loaded inside the battle VM; historical AI is untouched. */
function teamLookaheadIdentity(p){return p.speciesId+'|'+p.fastMove.moveId+'|'+p.chargedMoves.filter(Boolean).map(m=>m.moveId).sort().join('|');}
function captureTeamLookaheadPokemon(p){return {
 id:teamLookaheadIdentity(p),speciesId:p.speciesId,moveset:[p.fastMove.moveId,...p.chargedMoves.filter(Boolean).map(m=>m.moveId)],hp:p.hp,energy:p.energy,cooldown:p.cooldown,
 buffs:p.statBuffs.slice(),stats:{...p.stats},baseStats:{...p.baseStats},ivs:{...p.ivs},level:p.level,cpm:p.cpm,cp:p.cp,form:p.activeFormId,types:p.types.slice(),native:p.nativeStatBuffs.slice(),shields:p.shields
};}
function captureTeamLookaheadState(battle,players){const active=battle.getPokemon();return players.map((player,i)=>({active:player.getTeam().indexOf(active[i]),shields:player.getShields(),timer:player.getSwitchTimer(),team:player.getTeam().map(captureTeamLookaheadPokemon)}));}
function advanceTeamLookaheadState(state,ms=500){state.forEach(s=>{s.timer=Math.max(0,s.timer-ms);if(s.team[s.active])s.team[s.active].cooldown=Math.max(0,s.team[s.active].cooldown-ms);});return state;}
function installTeamSimulationSafety(){
 const OriginalPokemon=Pokemon;
 // PvPoke reset calls changeForm (which applies native stages), then applies
 // those stages a second time. Preserve exactly one native contribution.
 Pokemon=function(...args){const p=new OriginalPokemon(...args),reset=p.reset;p.reset=function(isSwitch=false){reset.call(p,isSwitch);const max=GameMaster.getInstance().data.settings.maxBuffStages;p.statBuffs=p.startStatBuffs.map((v,i)=>Math.max(-max,Math.min(max,v+(p.nativeStatBuffs[i]||0))));p.resetMoves();};return p;};
 Object.setPrototypeOf(Pokemon,OriginalPokemon);Pokemon.prototype=OriginalPokemon.prototype;
}
function createTeamLookaheadPokemon(row,index,b){
 const p=new Pokemon(row.speciesId,index,b);p.initialize(b.getCP());p.ivs={...row.ivs};p.setLevel(row.level,false);
 if(Number.isFinite(row.cpm))p.cpm=row.cpm;
 p.selectMove('fast',row.moveset[0]);row.moveset.slice(1).forEach((m,i)=>{if(i<2)p.selectMove('charged',m,i);else if(p.hasThirdChargedMove())p.selectMove('extra-charged',m,i);});
 if(row.form&&p.changeForm)p.changeForm(row.form);
 p.stats={...row.stats};p.baseStats={...row.baseStats};p.cp=row.cp;p.nativeStatBuffs=row.native.slice();p.types=row.types.slice();
 p.startHp=row.hp;p.startEnergy=row.energy;p.startCooldown=row.cooldown;p.startStatBuffs=row.buffs.map((v,i)=>v-(p.nativeStatBuffs[i]||0));p.startFormId=row.form;p.startingShields=row.shields;
 p.reset();p.baitShields=0;p.optimizeMoveTiming=true;p.priority=0;return p;
}
function isolateTeamScenarioScouting(ai,options){
 // Champion scouting formerly reset the live pair through many 1v1 battles,
 // contaminating their form, native stages, starting values and battle binding.
 const cache=options.scoutingCache||(options.scoutingCache=new Map());
 ai.runScenario=function(type,pokemon,opponent){
  const rows=[pokemon,opponent].map(captureTeamLookaheadPokemon),cacheKey=(type==='NEITHER_BAIT'?'NO_BAIT':type)+':'+JSON.stringify(rows);
  if(cache.has(cacheKey)){const hit=cache.get(cacheKey);return {...hit,name:type,opponent,matchups:hit.matchups.slice()};}
  const oldRandom=Math.random;Math.random=()=>.5;
  try{
  const b=new Battle();b.setCP(options.cp);
  const pair=rows.map((row,i)=>createTeamLookaheadPokemon(row,i,b));
  pair[0].baitShields=type==='BOTH_BAIT'||type==='FARM'?1:0;pair[1].baitShields=type==='BOTH_BAIT'||type==='FARM'?1:0;pair[0].farmEnergy=type==='FARM';
  b.setNewPokemon(pair[0],0,false);b.setNewPokemon(pair[1],1,false);
  const scenario={opponent,name:type,matchups:[],average:0,minShields:3},weights=[4,4,1];let total=0;
  for(let own=0;own<=pokemon.shields;own++)for(let other=0;other<=opponent.shields;other++){
   pair[0].startingShields=own;pair[1].startingShields=other;b.simulate();const rating=b.getBattleRatings()[0],weight=weights[own]*weights[other];
   scenario.matchups.push(rating);scenario.average+=rating*weight;total+=weight;if(rating>=500)scenario.minShields=Math.min(scenario.minShields,own);
  }
  scenario.average/=total;if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(cacheKey,{...scenario,opponent:null,matchups:scenario.matchups.slice()});return scenario;
  }finally{Math.random=oldRandom;}
 };
}
function prepareTeamLookaheadSwitch(teams,state,choices){teams.forEach((team,i)=>{
 if(choices[i]===state[i].active)return;
 const outgoing=team[state[i].active];
 if(outgoing.hp>0){outgoing.statBuffs=[0,0];outgoing.startStatBuffs=[0,0];
  if(outgoing.formChange?.resetOnSwitch&&outgoing.activeFormId!==outgoing.originalFormId){outgoing.changeForm(outgoing.originalFormId);outgoing.startFormId=outgoing.originalFormId;}
  outgoing.statBuffs=outgoing.nativeStatBuffs.slice();
 }
 const incoming=team[choices[i]];incoming.startCooldown=0;incoming.cooldown=0;
 });}
function teamLookaheadElapsed(b){
 // PvPoke's display duration adds spacing to unshielded/CMP timeline events;
 // it is not the emulator's elapsed switch clock. Count the actual charge-up
 // sequences, which pause fast turns while the live switch timer keeps ticking.
 const moveByName=new Map(b.getPokemon().flatMap(p=>p.chargedMovePool.concat(p.chargedMoves.filter(Boolean))).map(m=>[m.name,m]));
 return Math.max(0,b.getTurns()-1)*500+b.getTimeline().reduce((ms,e)=>e.type.startsWith('charged ')?ms+(moveByName.get(e.name)?.hasTag('instant')?3000:10000):ms,0);
}
function legalTeamLookaheadChoices(s,force){return s.team.map((p,j)=>j).filter(j=>s.team[j].hp>0&&(force?j!==s.active:(j===s.active||(s.timer===0&&s.team[s.active].cooldown===0)))).sort((a,b)=>s.team[a].id.localeCompare(s.team[b].id));}
function installTeamLookahead(battle, players, options) {
 function seeded(key){let h=2166136261^(options.seed>>>0);for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619);}return function(){h+=0x6D2B79F5;let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
 const horizon=options.horizon||24, interval=options.interval||4;
 const identity=teamLookaheadIdentity;
 const stats={decisions:0,branches:0,branchCacheHits:0,switches:0,forced:0,beliefWorlds:0};
 const knowledge=players.map(()=>teamObservedKnowledge(options));
 function observe(i){const p=battle.getPokemon()[1-i];if(p)knowledge[i].reveal(teamPublicAppearance(p));}
 const useMove=battle.useMove;
 battle.useMove=function(attacker,defender,move,...args){const result=useMove.call(battle,attacker,defender,move,...args);observe(1-attacker.index);knowledge[1-attacker.index].attack(attacker.speciesId,move.moveId,battle.getTurns());return result;};
 let snapshot=null, cache=new Map(),branchCache=new Map();
 function capturePublic(i){return {own:players[i].getTeam().map(captureTeamLookaheadPokemon),observed:knowledge[i].view(),shields:players.map(p=>p.getShields()),clocks:players.map(p=>p.getSwitchTimer())};}
 const action=battle.getTurnAction;
 battle.getTurnAction=function(p,opponent){const a=action.call(battle,p,opponent);if(a?.type==='charged'&&p.stats.atk===opponent.stats.atk){const combatKey=q=>identity(q)+'@'+players[q.index].getTeam().map(identity).join('::'),ids=[combatKey(p),combatKey(opponent)].sort(),winner=seeded(ids.join('::')+':cmp:'+battle.getTurns())()<.5?ids[0]:ids[1];if(combatKey(p)===winner)a.settings.priority+=.001;}return a;};
 const step=battle.step;
 battle.step=function(){snapshot=null;cache=new Map();branchCache=new Map();return step.call(battle);};
 const clone=createTeamLookaheadPokemon;
 function resource(p){return Math.max(0,p.hp/p.stats.hp)+.18*Math.max(0,p.hp/p.stats.hp)*p.energy/100;}
 // Value the whole surviving roster, not merely the immediate duel. A coverage
 // term rewards preserving counters, but is only a terminal heuristic.
 function terminal(teams,shields,active,locked){
  const live=teams.map(t=>t.filter(p=>p.hp>0)), totals=live.map(t=>t.reduce((s,p)=>s+resource(p),0));
  if(!live[0].length||!live[1].length)return !live[0].length?(!live[1].length?0:-10):10;
  function pressure(a,b){
   const fast=DamageCalculator.damage(a,b,a.fastMove),dt=a.fastMove.cooldown/500;
   const charged=a.chargedMoves.reduce((best,m)=>Math.max(best,DamageCalculator.damage(a,b,m)/Math.max(1,m.energy)),0);
   return (fast+charged*a.fastMove.energyGain)/dt/Math.max(1,b.stats.hp);
  }
  function coverage(a,b){return b.reduce((sum,q)=>sum+resource(q)*Math.max(...a.map(p=>Math.tanh(Math.log(Math.max(.0001,pressure(p,q))/Math.max(.0001,pressure(q,p)))))),0)/b.length;}
  const alignment=coverage(live[0],live[1])-coverage(live[1],live[0]);
  const freedom=locked.map((ms,i)=>live[i].length>1?Math.min(ms,45000)/45000:0);
  return totals[0]-totals[1]+.32*(shields[0]-shields[1])+.24*alignment-.12*(freedom[0]-freedom[1]);
 }
 function rollout(state,choices){
  const branchKey=(state===snapshot?'snapshot':JSON.stringify(state))+':'+choices.join(',');
  // Both controllers inspect the same response matrix. Reuse the deterministic
  // branch forecast rather than simulating it again for the opposing decision.
  if(branchCache.has(branchKey)){stats.branchCacheHits++;return branchCache.get(branchKey);}
  stats.branches++;
  const b=new Battle();b.setCP(options.cp);b.setBattleMode('simulate');b.setBuffChanceModifier(-1);
  const teams=state.map((s,i)=>s.team.map(p=>clone(p,i,b)));prepareTeamLookaheadSwitch(teams,state,choices);const duel=choices.map((c,i)=>teams[i][c]);
  duel.forEach((p,i)=>{p.startingShields=state[i].shields;if(choices[i]!==state[i].active)p.startCooldown=0;b.setNewPokemon(p,i,false);});
  b.start();
  // Reset also restores species-specific forms; capture the live form above.
  for(let n=0;n<horizon&&duel.every(p=>p.hp>0);n++)b.step();
  const elapsed=teamLookaheadElapsed(b);
  const shields=duel.map(p=>p.shields),lock=state.map((s,i)=>choices[i]===s.active?Math.max(0,s.timer-elapsed):Math.max(0,45000-elapsed));
  // Unused clones haven't entered the duel; reset from their current saved state.
  // Every clone is restored when created. Resetting benches here would restore
  // a switched-out Pokémon's old buffs/form, reversing the switch transition.
  const value=terminal(teams,shields,choices,lock);branchCache.set(branchKey,value);return value;
 }
 function worlds(i){
  observe(i);const views=knowledge[i].hypotheses(1-i,battle,battle.getTurns(),seeded(JSON.stringify(knowledge[i].view())+':belief'),options.beliefSamples||3);
  const own={active:players[i].getTeam().indexOf(battle.getPokemon()[i]),shields:players[i].getShields(),timer:players[i].getSwitchTimer(),team:players[i].getTeam().map(captureTeamLookaheadPokemon)};
  return views.map(other=>{other.shields=players[1-i].getShields();other.timer=players[1-i].getSwitchTimer();other.team.forEach(p=>p.shields=other.shields);return [JSON.parse(JSON.stringify(own)),other];});
 }
 function decide(i,forced){
  const states=worlds(i),own=states[0][0],key=i+':'+forced;if(cache.has(key))return cache.get(key);
  const choices=legalTeamLookaheadChoices(own,forced);if(!choices.length)return own.active;
  const before=options.audit?JSON.stringify(capturePublic(i)):null,oldRandom=Math.random;Math.random=()=>.5;
  try{
   stats.decisions++;stats.beliefWorlds+=states.length;let best=-Infinity,selected=choices[0],stay=-Infinity;
   for(const choice of choices){let expected=0;
    for(const state of states){const other=state[1];let worst=Infinity;
     for(const reply of legalTeamLookaheadChoices(other,other.team[other.active].hp<=0)){
      const pair=[choice,reply];worst=Math.min(worst,rollout(state,pair));
     }
     expected+=worst/states.length;
    }
    if(choice===own.active)stay=expected;if(expected>best+1e-9){best=expected;selected=choice;}
   }
   if(!forced&&selected!==own.active&&best<stay+.08)selected=own.active;
   cache.set(key,selected);return selected;
  }finally{Math.random=oldRandom;if(options.audit&&before!==JSON.stringify(capturePublic(i)))throw Error('Lookahead mutated live battle state');}
 }
 function foe(i){observe(i);const p=clone(knowledge[i].activeGuess(1-i,battle,battle.getTurns()),1-i,battle);p.shields=players[1-i].getShields();return p;}
 players.forEach((player,i)=>{
  const ai=player.getAI();
  // Champion's original methods read hidden opponent moves and energy. Replace
  // them rather than allowing an accidental fallback through that code path.
  ai.evaluateMatchup=function(){observe(i);};
  ai.decideSwitch=function(){stats.forced++;return decide(i,true);};
  ai.decideAction=function(turn,poke){
   observe(i);
   if(player.getSwitchTimer()===0&&player.getRemainingPokemon()>1&&(turn%interval===0||poke.hp/poke.stats.hp<.2)){
    const selected=decide(i,false),current=player.getTeam().indexOf(poke);
    if(selected!==current){stats.switches++;return new TimelineAction('switch',i,turn,selected,{priority:poke.priority});}
   }
   const opponent=foe(i),ready=poke.chargedMoves.map((m,j)=>({m,j,damage:DamageCalculator.damage(poke,opponent,m)})).filter(row=>poke.energy>=row.m.energy);
   if(!ready.length)return new TimelineAction('fast',i,turn,0,{priority:poke.priority});
   const fastDamage=DamageCalculator.damage(poke,opponent,poke.fastMove);
   if(opponent.hp<=fastDamage&&poke.hp/poke.stats.hp>.2&&poke.energy<100)return new TimelineAction('fast',i,turn,0,{priority:poke.priority});
   ready.sort((a,b)=>b.damage/Math.max(1,b.m.energy)-a.damage/Math.max(1,a.m.energy)||a.m.energy-b.m.energy);
   // An observed shield count can favor a cheaper bait. The current queued
   // opponent response is deliberately unavailable.
   if(players[1-i].getShields()>0)ready.sort((a,b)=>a.m.energy-b.m.energy||b.damage-a.damage);
   else{const lethal=ready.filter(row=>row.damage>=opponent.hp).sort((a,b)=>a.m.energy-b.m.energy);if(lethal.length)ready.splice(0,ready.length,...lethal);}
   return new TimelineAction('charged',i,turn,ready[0].j,{priority:poke.priority});
  };
  ai.decideShield=function(_attacker,defender,_incomingMove){
   // Ignore the real attacker and the incoming move argument. The attack is
   // revealed only after the shield choice and damage resolution.
   const opponent=foe(i),available=opponent.chargedMoves.filter(m=>m.energy<=opponent.energy+opponent.fastMove.energyGain);
   const plausible=available.length?available:opponent.chargedMoves;
   const damage=plausible.reduce((sum,m)=>sum+DamageCalculator.damage(opponent,defender,m),0)/Math.max(1,plausible.length);
   return player.getShields()>0&&(damage>=defender.hp||damage>=defender.stats.hp*.35);
  };
  for(const name of ['decideAction','decideShield','evaluateMatchup','decideSwitch']){const original=ai[name];ai[name]=function(...args){
   observe(i);const own=player.getTeam().map(p=>[identity(p),p.hp,p.energy,p.cooldown,p.statBuffs]);
   const old=Math.random;Math.random=seeded(JSON.stringify(own)+':'+name+':'+battle.getTurns()+':'+JSON.stringify(knowledge[i].view()));try{return original.apply(ai,args);}finally{Math.random=old;}
  };}
 });
 if(options.audit)stats.observed=()=>knowledge.map(k=>k.view());
 return stats;
}
