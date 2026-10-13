'use strict';
const rows=require('../includes/pro/data/league-1500.json').overall;
const data=require('../includes/pro/data/gamemaster.json');
const dex=new Map(data.pokemon.map(p=>[p.speciesId,p.dex]));
const beliefRoster=rows.slice(0,300).map(p=>({speciesId:p.speciesId,dex:dex.get(p.speciesId),moveset:p.moveset,weight:1}));
const team=ids=>ids.map(id=>{const row=rows.find(p=>p.speciesId===id);if(!row)throw Error('Missing fixture species '+id);return row;});
function simulatorFixtures(n=24){
 const special=[
  [team(['cramorant','mimikyu','aegislash_shield']),team(['quagsire_shadow','pidgeot','talonflame'])],
  [team(['greninja','marowak_alolan_shadow','dudunsparce']),team(['cramorant','melmetal','jumpluff'])],
 ];
 return Array.from({length:n},(_,i)=>{
  const [a,b]=i<special.length?special[i]:[rows.slice((i*7)%180,(i*7)%180+3),rows.slice(181+(i*5)%100,184+(i*5)%100)];
  return [a,b,undefined,undefined,{seed:1294861+i*7919,beliefRoster}];
 });
}
// Species with form changes, Shadow entries and other special handling. Every
// fourth own team and every sixth opponent team leads with one of them.
const specialSpecies=['cramorant','aegislash_shield','morpeko_full_belly','darmanitan_galarian_standard','mimikyu','quagsire_shadow','darmanitan_standard_shadow','talonflame_shadow','marowak_alolan_shadow'];
// Search-shaped fixtures: the belief roster and the 2,048-lineup belief bank
// are built exactly as search.cjs builds them (meta.cjs, weight power 1.25,
// default options), opponents are meta draws and own teams are random entries.
// Without a pool the species come from the bundled rankings (the same entries
// and weights a prepared pool holds, without scouting coverage, so coherent
// draws differ); with a pool, own teams are drawn from its retained variants.
function searchFixtures(n=96,{pool=null,usageFile='',usageHalfLifeDays=0,usageAsOf='',usagePriorStrength=500,seed=20261013,beliefFixtureSeed=20881010}={}){
 const {createMeta}=require('./team-search/meta.cjs'),common=require('./team-search/common.cjs'),{random,defaults}=require('./utils.cjs');
 const species=pool?pool.species:common.population(rows,require('../includes/pro/data/overrides-1500.json'),300).map(p=>({...p,dex:dex.get(p.speciesId)}));
 const meta=createMeta(species,{mode:'hybrid',usageFile,weightPower:1.25,halfLifeDays:usageHalfLifeDays,asOf:usageAsOf,priorStrength:usagePriorStrength});
 const beliefRoster=species.map(p=>({speciesId:p.speciesId,dex:p.dex,moveset:p.moveset,weight:p.weight**1.25})),beliefTeams=meta.fixtures(2048,beliefFixtureSeed).map(c=>c.team.map(p=>p.speciesId));
 const entries=pool?pool.variants:species,r=random(seed),cases=meta.fixtures(n,(seed^0x5bd1e995)>>>0);
 const find=list=>id=>{const p=list.find(q=>q.speciesId===id)||rows.find(q=>q.speciesId===id);if(!p)throw Error('Missing fixture species '+id);return p;},ownRow=find(entries),opponentRow=find(species);
 const withLead=(members,lead)=>{const team=[lead,...members.filter(p=>dex.get(p.speciesId)!==dex.get(lead.speciesId))].slice(0,3);return team.length===3?team:null;};
 return cases.map((c,k)=>{
  let own=common.randomTeam(entries,r).map(i=>entries[i]),opponent=c.team;
  if(k%4===0)own=withLead(own,ownRow(specialSpecies[(k/4)%specialSpecies.length]))||own;
  if(k%6===3)opponent=withLead(opponent,opponentRow(specialSpecies[(k*5+1)%specialSpecies.length]))||opponent;
  return [own,opponent,defaults,defaults,{seed:c.seed,cp:1500,beliefRoster,beliefTeams,beliefSamples:3,horizon:24,interval:4}];
 });
}
module.exports={simulatorFixtures,searchFixtures,specialSpecies,beliefRoster};
