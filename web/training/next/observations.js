/* Information boundary: only this adapter sees the public appearance of a live
 * opponent. It never exposes their moveset, energy, IVs, HP maximum or bench.
 * HP is quantized to the visible bar percentage; default-IV stats are predicted. */
function teamPublicAppearance(p){return {speciesId:p.speciesId,form:p.activeFormId,hpFraction:Math.max(p.hp>0?.01:0,Math.round(100*Math.max(0,p.hp)/Math.max(1,p.stats.hp))/100),buffs:p.statBuffs.slice()};}
function teamObservedKnowledge(options){
 const bySpecies=new Map((options.beliefRoster||[]).map(p=>[p.speciesId,p]));
 const moves=new Map(GameMaster.getInstance().data.moves.map(m=>[m.moveId,m]));
 const seen=new Map(),templates=new Map();
 const optimized=options.simulationOptimizations!==false;
 let active=null,initialLead=null,matchKey='',matchedBank=[];
 function reveal(appearance){
  if(active&&active!==appearance.speciesId){const outgoing=seen.get(active);if(outgoing&&outgoing.hpFraction>0)outgoing.buffs=[0,0];}
  active=appearance.speciesId;initialLead??=active;
  const row=seen.get(active)||{speciesId:active,fast:null,charged:[],energy:0,lastFastTurn:-1000,hpFraction:1,buffs:[0,0],form:active};
  Object.assign(row,appearance);seen.set(active,row);return row;
 }
 function attack(speciesId,moveId,turn){
  // Called only AFTER resolution. A charge being shielded is revealed too, but
  // its actual move is unavailable to the shield decision for this same attack.
  const row=seen.get(speciesId);if(!row)return;
  const m=moves.get(moveId);if(!m)return;
  if(m.energy===0&&m.category!=='charged'){row.fast=moveId;row.energy=Math.min(100,row.energy+m.energyGain);row.lastFastTurn=turn;}
  else{if(m.tags?.includes('uneditable'))return;if(!row.charged.includes(moveId))row.charged.push(moveId);row.energy=Math.max(0,row.energy-(m.energy||0));}
 }
 function compatibleMoves(row,prior){
  const fast=row.fast||prior.moveset[0],charged=row.charged.slice();
  for(const id of prior.moveset.slice(1))if(!charged.includes(id)&&charged.length<2)charged.push(id);
  // Metadata is public; observed unusual moves take precedence over a prior.
  return [fast,...charged];
 }
 function priorFor(id,b){
  if(bySpecies.has(id))return bySpecies.get(id);
  const p=new Pokemon(id,0,b);p.initialize(options.cp);
  return {speciesId:id,dex:p.dex,moveset:[p.fastMove.moveId,...p.chargedMoves.filter(Boolean).map(m=>m.moveId)],weight:1};
 }
 function guessed(row,prior,index,b,turn){
  const selected=compatibleMoves(row,prior),key=JSON.stringify([row.speciesId,selected,row.form,index,b.getCP(),b.getLevelCap()]);
  let template=optimized?templates.get(key):null;
  if(!template){
   const p=new Pokemon(row.speciesId,index,b,undefined,{selectedMovesOnly:true,moveset:selected});p.initialize(options.cp);
   p.selectMove('fast',selected[0]);selected.slice(1).forEach((m,j)=>{if(j<2)p.selectMove('charged',m,j);else if(p.hasThirdChargedMove())p.selectMove('extra-charged',m,j);});
   if(row.form&&p.changeForm)p.changeForm(row.form);
   template={row:captureTeamLookaheadPokemon(p),fastCooldown:p.fastMove.cooldown};
   // Templates hold public/default-IV metadata only; mutable HP, energy,
   // stages and cooldown are copied below for each hypothesized world.
   if(optimized){if(templates.size>=256)templates.delete(templates.keys().next().value);templates.set(key,template);}
  }
  const guess=cloneTeamLookaheadRow(template.row);
  guess.hp=Math.round(guess.stats.hp*row.hpFraction);guess.energy=row.energy;guess.buffs=row.buffs.slice();guess.cooldown=row.fast?Math.max(0,template.fastCooldown-(turn-row.lastFastTurn)*500):0;
  return guess;
 }
 function hypotheses(index,b,turn,r,count=3){
  if(!active)return [];
  const observed=[...seen.values()],known=new Set(observed.map(p=>p.speciesId)),bank=options.beliefTeams||[];
  // Condition joint lineups on the observed lead and revealed species. Finite
  // banks can lack a match; then use the explicit marginal fallback below.
  const key=initialLead+'|'+[...known].sort().join('|');if(key!==matchKey){matchedBank=bank.filter(t=>t[0]===initialLead&&observed.every(p=>t.includes(p.speciesId)));matchKey=key;}const matches=matchedBank;
  const worlds=[];
  for(let n=0;n<count;n++){
   const chosen=observed.map(p=>priorFor(p.speciesId,b));
   const draw=matches.length?matches[Math.floor(r()*matches.length)]:null;
   if(draw)for(const id of draw)if(!known.has(id))chosen.push(priorFor(id,b));
   let tries=0;
   while(chosen.length<3&&tries++<1000){
    const available=[...bySpecies.values()].filter(p=>!chosen.some(q=>q.dex===p.dex));
    const total=available.reduce((sum,p)=>sum+(p.weight||0),0);if(!total)throw Error('Belief prior needs three distinct species');
    let x=r()*total,selected=available.at(-1);for(const p of available){x-=p.weight||0;if(x<0){selected=p;break;}}chosen.push(selected);
   }
   const rows=chosen.slice(0,3).map(prior=>guessed(seen.get(prior.speciesId)||{speciesId:prior.speciesId,hpFraction:1,energy:0,buffs:[0,0],form:prior.speciesId,fast:null,charged:[],lastFastTurn:-1000},prior,index,b,turn));
   worlds.push({active:rows.findIndex(p=>p.speciesId===active),team:rows});
  }
  return worlds;
 }
 return {reveal,attack,hypotheses,activeGuess:(index,b,turn)=>guessed(seen.get(active),priorFor(active,b),index,b,turn),view:()=>({active,initialLead,seen:[...seen.values()].map(p=>({...p,charged:p.charged.slice(),buffs:p.buffs.slice()}))})};
}
