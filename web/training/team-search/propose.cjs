'use strict';
const {random}=require('../utils.cjs');const {randomTeam,canonicalTeam,teamKey}=require('./common.cjs');
function variantGroups(variants){const groups=new Map();variants.forEach((v,i)=>{const key=v.speciesId??v.dex;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);});return groups;}
function mutateCandidate(team,variants,r,groups=variantGroups(variants)){
 const t=team.slice(),choice=r();
 // Random replacement among hundreds of species almost never tests another
 // moveset of the same Pokémon. Reserve explicit local moveset mutations.
 if(choice<.35){const eligible=t.map((index,slot)=>({slot,choices:groups.get(variants[index].speciesId??variants[index].dex).filter(i=>i!==index)})).filter(row=>row.choices.length);
  if(eligible.length){const row=eligible[Math.floor(r()*eligible.length)];t[row.slot]=row.choices[Math.floor(r()*row.choices.length)];return canonicalTeam(t);}
 }
 if(choice>=.35&&choice<.55){const slot=1+Math.floor(r()*2);[t[0],t[slot]]=[t[slot],t[0]];}
 else{const slot=Math.floor(r()*3);for(let n=0;n<1000;n++){const i=Math.floor(r()*variants.length);if(i!==t[slot]&&t.every((j,k)=>k===slot||variants[j].dex!==variants[i].dex)){t[slot]=i;break;}}}
 return canonicalTeam(t);
}
// Exhaust the cheap local moveset and lead neighborhood before random mutations.
function localNeighbors(team,variants,groups=variantGroups(variants)){
 const rows=new Map(),add=t=>{t=canonicalTeam(t);if(teamKey(t)!==teamKey(team))rows.set(teamKey(t),t);};
 for(let slot=0;slot<3;slot++)for(const index of groups.get(variants[team[slot]].speciesId??variants[team[slot]].dex)){
  const t=team.slice();t[slot]=index;add(t);
 }
 for(let slot=1;slot<3;slot++){const t=team.slice();[t[0],t[slot]]=[t[slot],t[0]];add(t);}
 return [...rows.values()];
}
function explorationScore(score,mode='promising'){
 if(!['promising','disagreement'].includes(mode))throw Error('Unknown exploration mode');
 // A search priority, not a statistical confidence bound.
 return mode==='disagreement'?score.uncertainty:score.mean+score.uncertainty;
}
function retestTeam(known,round=0){
 // Alternate the leader with rotating top contenders. Every third retest is
 // the incumbent; other turns cover the next seven, including moveset rivals.
 if(!known.length)return null;
 const rivals=known.slice(1,8);return round%3===0||!rivals.length?known[0].team:rivals[(round-Math.floor(round/3)-1)%rivals.length].team;
}
function generateCandidates({variants,known,seen,seed,candidates=12000,localSearch=true}){
 const r=random(seed),unique=new Map(),groups=variantGroups(variants);let attempts=0;
 if(localSearch)for(const row of known.slice(0,8))for(const t of localNeighbors(row.team,variants,groups)){
  if(unique.size>=candidates)break;if(!seen.has(teamKey(t)))unique.set(teamKey(t),t);
 }
 while(unique.size<candidates&&attempts++<candidates*30){const t=known.length&&r()<.6?mutateCandidate(known[Math.floor(r()*known.length)].team,variants,r,groups):randomTeam(variants,r);if(!seen.has(teamKey(t)))unique.set(teamKey(t),t);}
 return {teams:[...unique.values()],random:r};
}
function selectCandidates({variants,known,seen,batchTeams=24,exploration='promising',round=0},generation,scores){
 if(scores.length!==generation.teams.length)throw Error('Candidate score count mismatch');
 if(scores.some(s=>!Number.isFinite(s.mean)||!Number.isFinite(s.uncertainty)||s.uncertainty<0))throw Error('Candidate predictions must be finite');
 const r=generation.random,ranked=generation.teams.map((team,i)=>({team,...scores[i]})),teams=[],sources={},used=new Set();
 const add=(team,source)=>{const key=teamKey(team);if(!used.has(key)){teams.push(team);used.add(key);sources[key]=source;}};
 const retest=known.length?1:0,randomSlots=Math.floor(batchTeams*.25),uncertaintySlots=Math.floor(batchTeams*.25),neuralSlots=batchTeams-randomSlots-uncertaintySlots-retest;
 ranked.sort((a,b)=>b.mean-a.mean);for(const row of ranked){if(teams.length>=neuralSlots)break;add(row.team,'neural');}
 ranked.sort((a,b)=>explorationScore(b,exploration)-explorationScore(a,exploration));for(const row of ranked){if(teams.length>=neuralSlots+uncertaintySlots)break;add(row.team,'uncertainty');}
 // Genuine uniform exploration, independent of the neural/mutation proposal shortlist.
 for(let tries=0;teams.length<batchTeams-retest&&tries<batchTeams*1000;tries++){const team=randomTeam(variants,r);if(!seen.has(teamKey(team)))add(team,'random');}
 if(retest)add(retestTeam(known,round),'retest');
 return {teams,sources};
}
function propose(options){const generation=generateCandidates(options);return selectCandidates(options,generation,generation.teams.map(options.predict));}
module.exports={propose,generateCandidates,selectCandidates,mutateCandidate,localNeighbors,explorationScore,retestTeam};
