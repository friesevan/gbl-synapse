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
function cloneTeamLookaheadRow(row){return {...row,moveset:row.moveset.slice(),buffs:row.buffs.slice(),stats:{...row.stats},baseStats:{...row.baseStats},ivs:{...row.ivs},types:row.types.slice(),native:row.native.slice()};}
function createTeamLookaheadPokemon(row,index,b){
 const p=new Pokemon(row.speciesId,index,b,undefined,{selectedMovesOnly:true,moveset:row.moveset});p.initialize(b.getCP());p.ivs={...row.ivs};p.setLevel(row.level,false);
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
  const b=new Battle();b.simulationOptimizations=options.simulationOptimizations!==false;b.headless=options.simulationOptimizations!==false;b.setCP(options.cp);
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
function prepareTeamLookaheadOutgoing(outgoing){
 if(outgoing.hp>0){outgoing.statBuffs=[0,0];outgoing.startStatBuffs=[0,0];
  if(outgoing.formChange?.resetOnSwitch&&outgoing.activeFormId!==outgoing.originalFormId){outgoing.changeForm(outgoing.originalFormId);outgoing.startFormId=outgoing.originalFormId;}
  outgoing.statBuffs=outgoing.nativeStatBuffs.slice();
 }
}
function prepareTeamLookaheadSwitch(teams,state,choices){teams.forEach((team,i)=>{
 if(choices[i]===state[i].active)return;
 prepareTeamLookaheadOutgoing(team[state[i].active]);
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
// <controller-options>
// Controller options (OBSERVATION_CONTROLLER.md, "Controller options"). The defaults are the v4 controller
// exactly; any other setting is a different controller. teamControllerSuffix() gives it its own mechanics
// identity, so its labels, warm starts and replays never mix with the default's. This section uses no other
// global: next/controller-options.cjs (Node) and scripts/build-neural-replay-v4.cjs (browser) load it as is.
function teamControllerDefaults(){return {replyModel:'worst',replyTemperature:.25,rolloutContinuation:0,switchMargin:.08,shieldPolicy:'default'};}
// A switch margin at or above this never switches voluntarily (forced replacements still happen).
function teamControllerNeverSwitch(){return 1e9;}
function teamControllerPick(o,strict,where){
 const d=teamControllerDefaults(),out={};if(o==null)return out;
 if(typeof o!=='object'||Array.isArray(o))throw Error(where+': controller options must be an object');
 for(const k of Object.keys(o)){
  const v=o[k];if(!(k in d)){if(strict)throw Error(where+': unknown controller option '+k);continue;}if(v===undefined)continue;
  if(k==='replyModel'&&v!=='worst'&&v!=='weighted')throw Error(where+': replyModel must be worst or weighted');
  if(k==='replyTemperature'&&!(typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=10))throw Error(where+': replyTemperature must be a number in (0, 10]');
  if(k==='rolloutContinuation'&&!(Number.isInteger(v)&&v>=0&&v<=24))throw Error(where+': rolloutContinuation must be an integer from 0 to 24');
  if(k==='switchMargin'&&!(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=teamControllerNeverSwitch()))throw Error(where+': switchMargin must be a number from 0 to 1e9');
  if(k==='shieldPolicy'&&v!=='default'&&v!=='always'&&v!=='never')throw Error(where+': shieldPolicy must be default, always or never');
  out[k]=v;
 }
 return out;
}
// Physical side `side`: the defaults, then the battle-wide options, then that side's controllerTeams entry.
function teamControllerSettings(options,side){
 const o=options||{},sides=o.controllerTeams;
 if(sides!=null&&(!Array.isArray(sides)||sides.length!==2))throw Error('controllerTeams must hold one entry per side');
 return Object.assign(teamControllerDefaults(),teamControllerPick(o,false,'controller'),teamControllerPick(sides?.[side],true,'controllerTeams['+side+']'));
}
// The settings that differ from the defaults, in a fixed order (null for the default controller). The reply
// temperature only matters, and is only recorded, for weighted replies.
function teamControllerIdentity(options){
 const d=teamControllerDefaults(),s=Object.assign(teamControllerDefaults(),teamControllerPick(options,false,'controller')),out={};
 if(s.replyModel!==d.replyModel){out.replyModel=s.replyModel;out.replyTemperature=s.replyTemperature;}
 for(const k of ['rolloutContinuation','switchMargin','shieldPolicy'])if(s[k]!==d[k])out[k]=s[k];
 return Object.keys(out).length?out:null;
}
// Appended to the v4 mechanics id of a run whose two sides share a non-default controller, e.g.
// '+controller:replyModel=weighted,replyTemperature=0.25'. Per-side controllers are evaluation-only.
function teamControllerSuffix(options){
 if(options?.controllerTeams?.some(o=>o&&Object.keys(o).length))throw Error('Per-side controllers (controllerTeams) have no single mechanics identity');
 const id=teamControllerIdentity(options);return id?'+controller:'+Object.keys(id).map(k=>k+'='+id[k]).join(','):'';
}
// Each side's controller identity when the two sides differ, else [null,null]: battles where both sides share a
// controller (every search label) keep the orientation and mirrored-team rule of the default controller.
function teamControllerSideKeys(options){
 const ids=[0,1].map(i=>teamControllerIdentity(teamControllerSettings(options,i)));
 return JSON.stringify(ids[0])===JSON.stringify(ids[1])?[null,null]:ids;
}
// Weighted replies: the expected value when the opponent picks each reply with probability proportional to
// exp(u/T), where u is the reply's value for the opponent (the rollout value negated). An exact expectation, so
// deterministic; T -> 0 recovers the worst case. No reply (a finished game) is +Infinity, as in the worst case.
function teamWeightedReply(values,temperature){
 let low=Infinity;for(const v of values)if(v<low)low=v;if(!values.length||low===-Infinity||low===Infinity)return low;
 let total=0,sum=0;for(const v of values){const w=Math.exp((low-v)/temperature);if(w>0){total+=w;sum+=w*v;}}
 return sum/total;
}
// </controller-options>
function installTeamLookahead(battle, players, options) {
 function seeded(key){let h=2166136261^(options.seed>>>0);for(let i=0;i<key.length;i++){h^=key.charCodeAt(i);h=Math.imul(h,16777619);}return function(){h+=0x6D2B79F5;let t=h;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
 const horizon=options.horizon||24, interval=options.interval||4;
 const identity=teamLookaheadIdentity;
 const stats={decisions:0,branches:0,branchCacheHits:0,switches:0,forced:0,beliefWorlds:0};
 // Each physical side's controller (defaults unless options say otherwise). Continuation work is counted only
 // when a side continues rollouts, so the default controller's planner statistics keep their exact shape.
 const controllers=players.map((_,i)=>teamControllerSettings(options,i));
 if(controllers.some(c=>c.rolloutContinuation>0))Object.assign(stats,{rolloutSteps:0,continuations:0,continuationDuels:0,continuationSteps:0});
 const knowledge=players.map(()=>teamObservedKnowledge(options));
 function observe(i){const p=battle.getPokemon()[1-i];if(p)knowledge[i].reveal(teamPublicAppearance(p));}
 const useMove=battle.useMove;
 battle.useMove=function(attacker,defender,move,...args){const result=useMove.call(battle,attacker,defender,move,...args);observe(1-attacker.index);knowledge[1-attacker.index].attack(attacker.speciesId,move.moveId,battle.getTurns());return result;};
 const optimized=options.simulationOptimizations!==false;
 let snapshot=null, cache=new Map(),branchCache=new Map(),stateKeys=new WeakMap(),foeCache=new Map();
 function capturePublic(i){return {own:players[i].getTeam().map(captureTeamLookaheadPokemon),observed:knowledge[i].view(),shields:players.map(p=>p.getShields()),clocks:players.map(p=>p.getSwitchTimer())};}
 const action=battle.getTurnAction;
 battle.getTurnAction=function(p,opponent){const a=action.call(battle,p,opponent);if(a?.type==='charged'&&p.stats.atk===opponent.stats.atk){const combatKey=q=>identity(q)+'@'+players[q.index].getTeam().map(identity).join('::'),ids=[combatKey(p),combatKey(opponent)].sort(),winner=seeded(ids.join('::')+':cmp:'+battle.getTurns())()<.5?ids[0]:ids[1];if(combatKey(p)===winner)a.settings.priority+=.001;}return a;};
 const step=battle.step;
 battle.step=function(){snapshot=null;cache=new Map();branchCache=new Map();stateKeys=new WeakMap();duelForecasts=new Map();rowKeys=new WeakMap();return step.call(battle);};
 const clone=createTeamLookaheadPokemon;
 // Optimized forecasts (simulationOptimizations) reuse read-only pieces. Rows
 // are identified by their complete JSON, the identity the branch cache already
 // uses for whole states. `finished` holds clones that can never change again:
 // bench/outgoing clones, and duel members once their duel is over. Duel
 // forecasts last one step; bench clones (whose rows rarely change while
 // benched) are kept across steps in a small least-recently-used map.
 let sharedClones=new Map(),duelForecasts=new Map(),rowKeys=new WeakMap(),finished=new WeakSet(),pressureMemo=new WeakMap(),cloneBattle=null;
 function forecastBattle(){const b=new Battle();b.simulationOptimizations=options.simulationOptimizations!==false;b.headless=options.simulationOptimizations!==false;b.setCP(options.cp);b.setBattleMode('simulate');b.setBuffChanceModifier(-1);return b;}
 function rowKey(row){let key=rowKeys.get(row);if(key===undefined){key=JSON.stringify(row);rowKeys.set(row,key);}return key;}
 function sharedClone(row,i,outgoing){
  // A bench clone never joins a Battle: it is built from its row in a
  // configured Battle that never receives Pokemon (as every forecast Battle is
  // while its clones are built), then only read by terminal().
  const key=i+(outgoing?':out:':':bench:')+rowKey(row);let p=sharedClones.get(key);
  if(p)sharedClones.delete(key);else{p=clone(row,i,cloneBattle||(cloneBattle=forecastBattle()));if(outgoing)prepareTeamLookaheadOutgoing(p);finished.add(p);if(sharedClones.size>=64)sharedClones.delete(sharedClones.keys().next().value);}
  sharedClones.set(key,p);return p;
 }
 function resource(p){return Math.max(0,p.hp/p.stats.hp)+.18*Math.max(0,p.hp/p.stats.hp)*p.energy/100;}
 // Value the whole surviving roster, not merely the immediate duel. A coverage
 // term rewards preserving counters, but is only a terminal heuristic.
 function terminal(teams,shields,active,locked){
  const live=teams.map(t=>t.filter(p=>p.hp>0)), totals=live.map(t=>t.reduce((s,p)=>s+resource(p),0));
  if(!live[0].length||!live[1].length)return !live[0].length?(!live[1].length?0:-10):10;
  function pressure(a,b){
   // Finished clones are never mutated again, so their pressure is a pure
   // function of the pair (weakly held, like the clones themselves).
   let memo=null;if(optimized&&finished.has(a)&&finished.has(b)){memo=pressureMemo.get(a);if(!memo)pressureMemo.set(a,memo=new WeakMap());const hit=memo.get(b);if(hit!==undefined)return hit;}
   const fast=DamageCalculator.damage(a,b,a.fastMove),dt=a.fastMove.cooldown/500;
   const charged=a.chargedMoves.reduce((best,m)=>Math.max(best,DamageCalculator.damage(a,b,m)/Math.max(1,m.energy)),0);
   const value=(fast+charged*a.fastMove.energyGain)/dt/Math.max(1,b.stats.hp);if(memo)memo.set(b,value);return value;
  }
  function coverage(a,b){return b.reduce((sum,q)=>sum+resource(q)*Math.max(...a.map(p=>Math.tanh(Math.log(Math.max(.0001,pressure(p,q))/Math.max(.0001,pressure(q,p)))))),0)/b.length;}
  const alignment=coverage(live[0],live[1])-coverage(live[1],live[0]);
  const freedom=locked.map((ms,i)=>live[i].length>1?Math.min(ms,45000)/45000:0);
  return totals[0]-totals[1]+.32*(shields[0]-shields[1])+.24*alignment-.12*(freedom[0]-freedom[1]);
 }
 function rollout(state,choices,extend=0){
  let stateKey;
  if(optimized){stateKey=stateKeys.get(state);if(stateKey===undefined){stateKey=JSON.stringify(state);stateKeys.set(state,stateKey);}}
  else stateKey=state===snapshot?'snapshot':JSON.stringify(state);
  // A continued rollout (extend > 0) is a different forecast of the same branch.
  const branchKey=stateKey+':'+choices.join(',')+(extend?'#c'+extend:'');
  // Both controllers inspect the same response matrix. Reuse the deterministic
  // branch forecast rather than simulating it again for the opposing decision.
  if(branchCache.has(branchKey)){stats.branchCacheHits++;return branchCache.get(branchKey);}
  stats.branches++;
  if(optimized)return forecastBranch(state,choices,branchKey,extend);
  const b=new Battle();b.simulationOptimizations=options.simulationOptimizations!==false;b.headless=options.simulationOptimizations!==false;b.setCP(options.cp);b.setBattleMode('simulate');b.setBuffChanceModifier(-1);
  const teams=state.map((s,i)=>s.team.map(p=>clone(p,i,b)));prepareTeamLookaheadSwitch(teams,state,choices);const duel=choices.map((c,i)=>teams[i][c]);
  duel.forEach((p,i)=>{p.startingShields=state[i].shields;if(choices[i]!==state[i].active)p.startCooldown=0;b.setNewPokemon(p,i,false);});
  b.start();
  // Reset also restores species-specific forms; capture the live form above.
  let steps=0;for(;steps<horizon&&duel.every(p=>p.hp>0);steps++)b.step();
  const elapsed=teamLookaheadElapsed(b);
  if(extend){const value=continueRollout(state,choices,teams,duel,duel.map(p=>p.shields),elapsed,steps,extend);branchCache.set(branchKey,value);return value;}
  const shields=duel.map(p=>p.shields),lock=state.map((s,i)=>choices[i]===s.active?Math.max(0,s.timer-elapsed):Math.max(0,45000-elapsed));
  // Unused clones haven't entered the duel; reset from their current saved state.
  // Every clone is restored when created. Resetting benches here would restore
  // a switched-out Pokémon's old buffs/form, reversing the switch transition.
  const value=terminal(teams,shields,choices,lock);branchCache.set(branchKey,value);return value;
 }
 // Same forecast as rollout() above, assembled from reusable pieces. The duel
 // Battle only ever holds the two duel members, so its outcome is a function of
 // their rows, whether each one is switching in, and the shield counts. Belief
 // worlds that imagine the same duel (typically the revealed active opponent
 // staying in) simulate it once per step; terminal() then values each world's
 // own bench. Branch values, statistics and decisions are unchanged.
 function forecastBranch(state,choices,branchKey,extend){
  const incoming=choices.map((c,i)=>c!==state[i].active);
  const duelKey=choices.map((c,i)=>rowKey(state[i].team[c])).join('\n')+'\n'+incoming.join(',')+'\n'+state.map(s=>s.shields).join(',');
  let forecast=duelForecasts.get(duelKey);
  if(!forecast){
   const b=forecastBattle(),duel=choices.map((c,i)=>clone(state[i].team[c],i,b));
   duel.forEach((p,i)=>{if(incoming[i]){p.startCooldown=0;p.cooldown=0;}});
   duel.forEach((p,i)=>{p.startingShields=state[i].shields;if(incoming[i])p.startCooldown=0;b.setNewPokemon(p,i,false);});
   b.start();
   let steps=0;for(;steps<horizon&&duel.every(p=>p.hp>0);steps++)b.step();
   forecast={duel,elapsed:teamLookaheadElapsed(b),shields:duel.map(p=>p.shields),steps};
   duel.forEach(p=>finished.add(p));duelForecasts.set(duelKey,forecast);
  }
  const teams=state.map((s,i)=>s.team.map((p,j)=>j===choices[i]?forecast.duel[i]:sharedClone(p,i,j===s.active&&incoming[i])));
  if(extend){const value=continueRollout(state,choices,teams,forecast.duel,forecast.shields,forecast.elapsed,forecast.steps,extend);branchCache.set(branchKey,value);return value;}
  const lock=state.map((s,i)=>!incoming[i]?Math.max(0,s.timer-forecast.elapsed):Math.max(0,45000-forecast.elapsed));
  const value=terminal(teams,forecast.shields,choices,lock);branchCache.set(branchKey,value);return value;
 }
 // Rollout continuation (controller option rolloutContinuation N > 0). When the forecast duel ends with a
 // Pokémon knocked out and its side still has a living bench, that side brings in a replacement and the duel
 // goes on for up to N more steps, so terminal() values the next matchup rather than a knocked-out pair. Every
 // legal replacement is tried and the replacing side keeps the one whose continued value is best for it (the
 // forecast's side 0 is the decider: it maximises, the opponent minimises; when both sides replace at once,
 // the decider takes the maximin). At most 2 x 2 continuation duels of N steps per branch; their logical work
 // is counted in rolloutSteps, continuations, continuationDuels and continuationSteps on both forecast paths.
 // The reply model never enters this value, so a cached branch is the same under worst and weighted replies.
 function continueRollout(state,choices,teams,duel,shields,elapsed,steps,extend){
  stats.rolloutSteps+=steps;
  const incoming=choices.map((c,i)=>c!==state[i].active);
  const value=(members,extra,now)=>terminal(members,now,choices,state.map((s,i)=>!incoming[i]?Math.max(0,s.timer-elapsed-extra):Math.max(0,45000-elapsed-extra)));
  const fainted=[0,1].filter(i=>duel[i].hp<=0);
  const candidates=[0,1].map(i=>fainted.includes(i)?teams[i].map((p,j)=>j).filter(j=>j!==choices[i]&&teams[i][j].hp>0).sort((a,b)=>state[i].team[a].id.localeCompare(state[i].team[b].id)):[choices[i]]);
  if(!fainted.length||candidates.some(c=>!c.length))return value(teams,0,shields);
  stats.continuations++;
  const entering=[0,1].map(i=>fainted.includes(i));
  function evaluate(picks){
   const forecast=continuationDuel(picks.map((c,i)=>captureTeamLookaheadPokemon(teams[i][c])),entering,shields,extend);
   stats.continuationDuels++;stats.continuationSteps+=forecast.steps;
   return value(teams.map((t,i)=>t.map((p,j)=>j===picks[i]?forecast.duel[i]:p)),forecast.elapsed,forecast.shields);
  }
  if(fainted.length===1){
   const k=fainted[0];let best=null;
   for(const c of candidates[k]){const v=evaluate(k===0?[c,choices[1]]:[choices[0],c]);if(best===null||(k===0?v>best:v<best))best=v;}
   return best;
  }
  let best=-Infinity;
  for(const a of candidates[0]){let worst=Infinity;for(const c of candidates[1])worst=Math.min(worst,evaluate([a,c]));if(worst>best)best=worst;}
  return best;
 }
 // One continuation duel from captured rows: a replacement enters with no cooldown, a survivor keeps its state.
 // The optimised path shares it across belief worlds for the step, like the first duel.
 function continuationDuel(rows,entering,shields,extend){
  const key=optimized?'continue\n'+rows.map(r=>JSON.stringify(r)).join('\n')+'\n'+entering.join(',')+'\n'+shields.join(',')+'\n'+extend:null;
  let forecast=optimized?duelForecasts.get(key):undefined;
  if(!forecast){
   const b=forecastBattle(),duel=rows.map((row,i)=>clone(row,i,b));
   duel.forEach((p,i)=>{if(entering[i]){p.startCooldown=0;p.cooldown=0;}p.startingShields=shields[i];b.setNewPokemon(p,i,false);});
   b.start();
   let steps=0;for(;steps<extend&&duel.every(p=>p.hp>0);steps++)b.step();
   forecast={duel,elapsed:teamLookaheadElapsed(b),shields:duel.map(p=>p.shields),steps};
   if(optimized){duel.forEach(p=>finished.add(p));duelForecasts.set(key,forecast);}
  }
  return forecast;
 }
 function worlds(i){
  observe(i);const views=knowledge[i].hypotheses(1-i,battle,battle.getTurns(),seeded(JSON.stringify(knowledge[i].view())+':belief'),options.beliefSamples||3);
  const own={active:players[i].getTeam().indexOf(battle.getPokemon()[i]),shields:players[i].getShields(),timer:players[i].getSwitchTimer(),team:players[i].getTeam().map(captureTeamLookaheadPokemon)};
  return views.map(other=>{other.shields=players[1-i].getShields();other.timer=players[1-i].getSwitchTimer();other.team.forEach(p=>p.shields=other.shields);// A rollout only reads its captured input. Sharing this immutable own
   // snapshot across worlds avoids serializing a six-Pokemon roster repeatedly.
   return [optimized?own:JSON.parse(JSON.stringify(own)),other];});
 }
 function decide(i,forced){
  const key=i+':'+forced;if(optimized&&cache.has(key))return cache.get(key);const states=worlds(i),own=states[0][0];if(cache.has(key))return cache.get(key);
  const controller=controllers[i];
  const choices=legalTeamLookaheadChoices(own,forced);if(!choices.length)return own.active;
  const before=options.audit?JSON.stringify(capturePublic(i)):null,oldRandom=Math.random;Math.random=()=>.5;
  try{
   stats.decisions++;stats.beliefWorlds+=states.length;let best=-Infinity,selected=choices[0],stay=-Infinity;
   for(const choice of choices){let expected=0;
    for(const state of states){const other=state[1];
     // Weighted replies average the same branch values the worst case takes the minimum of.
     if(controller.replyModel==='weighted'){expected+=teamWeightedReply(legalTeamLookaheadChoices(other,other.team[other.active].hp<=0).map(reply=>rollout(state,[choice,reply],controller.rolloutContinuation)),controller.replyTemperature)/states.length;continue;}
     let worst=Infinity;
     for(const reply of legalTeamLookaheadChoices(other,other.team[other.active].hp<=0)){
      const pair=[choice,reply];worst=Math.min(worst,rollout(state,pair,controller.rolloutContinuation));
     }
     expected+=worst/states.length;
    }
    if(choice===own.active)stay=expected;if(expected>best+1e-9){best=expected;selected=choice;}
   }
   if(!forced&&selected!==own.active&&best<stay+controller.switchMargin)selected=own.active;
   cache.set(key,selected);return selected;
  }finally{Math.random=oldRandom;if(options.audit&&before!==JSON.stringify(capturePublic(i)))throw Error('Lookahead mutated live battle state');}
 }
 function foe(i){
  observe(i);const row=knowledge[i].activeGuess(1-i,battle,battle.getTurns()),shields=players[1-i].getShields();
  if(optimized){
   // decideAction, decideShield and DamageCalculator.damage read this guess's
   // typing, stats, stages, form, tags, level and moves, and its hp and energy.
   // HP, energy and cooldown reach a clone only as start values that reset()
   // copies; nothing else prepared from the row depends on them. One clone per
   // remaining row content is reused across steps, with those three values set
   // exactly as reset() sets them. Only these synchronous checks read it.
   const {hp,energy,cooldown,...fixed}=row,key=i+':'+shields+':'+JSON.stringify(fixed);
   let p=foeCache.get(key);
   if(p)foeCache.delete(key);else{p=clone(row,1-i,battle);p.shields=shields;if(foeCache.size>=16)foeCache.delete(foeCache.keys().next().value);}
   foeCache.set(key,p);p.startHp=p.hp=hp;p.startEnergy=p.energy=energy;p.startCooldown=p.cooldown=cooldown;return p;
  }
  // Damage checks only read this isolated guess; never give it to Battle.
  const p=clone(row,1-i,battle);p.shields=shields;return p;
 }
 players.forEach((player,i)=>{
  const ai=player.getAI();
  // Champion's original methods read hidden opponent moves and energy. Replace
  // them rather than allowing an accidental fallback through that code path.
  ai.evaluateMatchup=function(){observe(i);};
  ai.decideSwitch=function(){stats.forced++;return decide(i,true);};
  ai.decideAction=function(turn,poke){
   observe(i);
   // A side that never switches voluntarily skips the decision (it could only keep the active Pokémon).
   if(controllers[i].switchMargin<teamControllerNeverSwitch()&&player.getSwitchTimer()===0&&player.getRemainingPokemon()>1&&(turn%interval===0||poke.hp/poke.stats.hp<.2)){
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
   const policy=controllers[i].shieldPolicy;if(policy!=='default')return policy==='always'&&player.getShields()>0;
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
