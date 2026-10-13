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

// ---- Adaptive prefix length (opt-in: --acquisition adaptive) ----
// Staged acquisition gives every candidate a fixed common prefix and then promotes a fixed
// fraction. The adaptive rule keeps the common prefix, then extends candidates by `step`
// fixtures at a time and stops a candidate as soon as it cannot plausibly belong to the
// k best any more. All decisions are made on completed levels (every active candidate has
// exactly `level` fixtures), so they are pure functions of the recorded scores: resuming an
// interrupted round reproduces the uninterrupted run.
function prefixScores(pending,team){
 // Contiguous finite fixtures from index 0. A hole ends the prefix, so a partly
 // dispatched level is never mistaken for a completed one.
 const out=[];for(const score of pending.scores[teamKey(team)]||[]){if(!Number.isFinite(score))break;out.push(score);}return out;
}
function shrunkPosterior(scores){
 if(!scores.length||scores.some(s=>!Number.isFinite(s)||s<0||s>1))throw Error('Adaptive acquisition requires finite scores');
 // Same shrinkage as promotionPriority: eight pseudo-fixtures toward 0.5.
 const n=scores.length,mean=(scores.reduce((a,b)=>a+b,0)+4)/(n+8);
 return {mean,sd:Math.sqrt(mean*(1-mean)/(n+9))};
}
const DEFAULT_MARGIN=1.28;
function pessimisticScore(scores,margin=DEFAULT_MARGIN){
 // Shrunk mean minus `margin` posterior standard deviations (1.28 by default). A search heuristic, not a confidence bound.
 const {mean,sd}=shrunkPosterior(scores);return mean-margin*sd;
}
function adaptiveContinuation(pending,{active=pending.teams,full,fraction=.5,margin=DEFAULT_MARGIN}={}){
 if(!Number.isInteger(full)||full<1)throw Error('Adaptive acquisition needs the full fixture count');
 if(!Number.isFinite(fraction)||fraction<=0||fraction>1)throw Error('Promotion fraction must be in (0, 1]');
 if(!Number.isFinite(margin)||margin<0)throw Error('acquisition-margin must be a non-negative number');
 const all=pending.teams,k=Math.min(all.length,Math.max(1,Math.ceil(all.length*fraction)));
 // At the default margin the optimistic score is exactly promotionPriority; another margin moves both sides of the band.
 const rows=all.map(team=>{const scores=prefixScores(pending,team);return {team,key:teamKey(team),count:scores.length,pessimistic:pessimisticScore(scores,margin),optimistic:promotionPriority(scores,pending.predictions?.[teamKey(team)])+(margin-DEFAULT_MARGIN)*shrunkPosterior(scores).sd};});
 // The k-th best pessimistic score over every candidate, including those already stopped.
 const threshold=rows.map(r=>r.pessimistic).sort((a,b)=>b-a)[k-1],live=new Set(active.map(teamKey));
 // The top k by pessimistic score always satisfy optimistic >= pessimistic >= threshold.
 return {k,threshold,extend:rows.filter(r=>live.has(r.key)&&r.count<full&&r.optimistic>=threshold).map(r=>r.team)};
}
function adaptiveNext(pending,{active=pending.teams,level,step,full,fraction=.5,margin=DEFAULT_MARGIN}){
 if(!Number.isInteger(step)||step<1)throw Error('acquisition-step must be a positive integer');
 const decision=adaptiveContinuation(pending,{active,full,fraction,margin});
 return decision.extend.length?{level:Math.min(level+step,full),active:decision.extend,threshold:decision.threshold,k:decision.k}:null;
}
// Drives one round from its (resumable) pending record. `evaluate(teams, n)` plays the
// missing fixtures of `teams` up to n and returns whether every one completed; the search
// dispatches battles, the offline audit copies recorded outcomes. Stage, level and the
// active list live in `pending`, so a stopped round continues exactly where it stopped.
async function runAdaptive(pending,{prefix,full,step,fraction=.5,margin=DEFAULT_MARGIN,evaluate}){
 const advance=(active,level)=>{
  const next=adaptiveNext(pending,{active,level,step,full,fraction,margin});
  if(!next){pending.promoted=pending.teams.filter(team=>prefixScores(pending,team).length>=full);pending.stage='expanding';delete pending.level;delete pending.active;return true;}
  pending.stage='extending';pending.level=next.level;pending.active=next.active;return false;
 };
 if(pending.stage==='screening'){
  if(!await evaluate(pending.teams,prefix))return false;
  pending.levels=[{fixtures:prefix,teams:pending.teams.length}];
  if(advance(pending.teams,prefix))return true;
 }
 while(pending.stage==='extending'){
  if(!await evaluate(pending.active,pending.level))return false;
  (pending.levels??=[]).push({fixtures:pending.level,teams:pending.active.length});
  if(advance(pending.active,pending.level))return true;
 }
 return true;
}
function adaptiveLabeled(pending){return pending.teams.reduce((sum,team)=>sum+prefixScores(pending,team).length,0);}
module.exports={opponentFixtureKey,fixtureKey,uniqueFixtures,canonicalObservations,candidateScores,stageComplete,promotionPriority,promoteCandidates,missingFixtures,sourceDiagnostics,DEFAULT_MARGIN,prefixScores,pessimisticScore,adaptiveContinuation,adaptiveNext,runAdaptive,adaptiveLabeled};
