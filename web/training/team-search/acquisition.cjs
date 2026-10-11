'use strict';
const {digest,teamKey}=require('./common.cjs');

// Opponents have one pinned recommended moveset per species in this search.
// v4 canonicalizes backline order. Preserve the lead and seed, while collapsing
// equivalent bench permutations; stored opponent rows retain their original order.
function opponentIdentity(opponent){const ids=opponent.map(p=>typeof p==='string'?p:p.speciesId);return [ids[0],...ids.slice(1).sort()];}
function opponentFixtureKey(opponent,seed){return digest([opponentIdentity(opponent),seed]);}
function fixtureKey(team,opponent,seed){return digest([teamKey(team),opponentIdentity(opponent),seed]);}
function uniqueFixtures(cases){const seen=new Set();return cases.filter(c=>{const k=opponentFixtureKey(c.team,c.seed);if(seen.has(k))return false;seen.add(k);return true;});}
function canonicalObservations(rows,keyCache=new WeakMap()){
 const key=row=>{if(!keyCache.has(row))keyCache.set(row,fixtureKey(row.team,row.opponent,row.seed));return keyCache.get(row);};
 // Cached fixture identities avoid hashing inside each comparator. Sorting is
 // done at checkpoint/fit boundaries, never for individual worker completions.
 for(const row of rows)key(row);rows.sort((a,b)=>key(a).localeCompare(key(b)));return rows;
}
function candidateScores(pending,team,n){return Array.from((pending.scores[teamKey(team)]||[]).slice(0,n));}
function stageComplete(pending,teams,n){return teams.every(team=>{const scores=candidateScores(pending,team,n);return scores.length===n&&scores.every(Number.isFinite);});}
function promotionPriority(scores,prediction={}){
 if(!scores.length||scores.some(s=>!Number.isFinite(s)||s<0||s>1))throw Error('Promotion requires complete finite screening scores');
 const n=scores.length,mean=(scores.reduce((a,b)=>a+b,0)+4)/(n+8),uncertainty=Number.isFinite(prediction.uncertainty)?Math.max(0,prediction.uncertainty):0;
 // Deliberately optimistic acquisition heuristic, not a confidence interval.
 return mean+1.28*Math.sqrt(mean*(1-mean)/(n+9))+uncertainty;
}
function promoteCandidates(pending,{fixtures,fraction=.5}={}){
 if(!stageComplete(pending,pending.teams,fixtures))throw Error('Complete the shared screening panel before promotion');
 if(!Number.isFinite(fraction)||fraction<=0||fraction>1)throw Error('Promotion fraction must be in (0, 1]');
 const ranked=pending.teams.map(team=>({team,priority:promotionPriority(candidateScores(pending,team,fixtures),pending.predictions?.[teamKey(team)])}));
 ranked.sort((a,b)=>b.priority-a.priority||teamKey(a.team).localeCompare(teamKey(b.team)));
 return ranked.slice(0,Math.max(1,Math.ceil(ranked.length*fraction))).map(row=>row.team);
}
function missingFixtures(pending,teams,cases,n){
 const jobs=[],seen=new Set();
 // A common fixture prefix is dispatched before later fixtures, so comparisons
 // retain matched observations even when the process stops early.
 for(let i=0;i<n;i++)for(const team of teams){
  const key=fixtureKey(team,cases[i].team,cases[i].seed);if(seen.has(key))continue;seen.add(key);
  if(!Number.isFinite(pending.scores[teamKey(team)]?.[i]))jobs.push({team,fixture:i,key});
 }
 return jobs;
}
function sourceDiagnostics(pending,n){
 if(!stageComplete(pending,pending.teams,n))throw Error('Source diagnostics require a complete common fixture panel');
 const grouped=new Map();for(const team of pending.teams){const source=pending.sources?.[teamKey(team)]||'initial',group=grouped.get(source)||{source,teams:0,sum:0};group.teams++;group.sum+=candidateScores(pending,team,n).reduce((a,b)=>a+b,0)/n;grouped.set(source,group);}
 return [...grouped.values()].map(group=>({source:group.source,teams:group.teams,meanScore:group.sum/group.teams,fixturesPerTeam:n,panel:'common acquisition prefix'}));
}
module.exports={opponentFixtureKey,fixtureKey,uniqueFixtures,canonicalObservations,candidateScores,stageComplete,promotionPriority,promoteCandidates,missingFixtures,sourceDiagnostics};
