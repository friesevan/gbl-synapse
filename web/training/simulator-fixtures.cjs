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
module.exports={simulatorFixtures,beliefRoster};
