'use strict';
// Shared contender panel (opt-in: --retest-panel N).
//
// A retested team normally plays only the round's fresh fixtures, so a contender's
// evidence lives on different opponents than the incumbent's and the two can never be
// compared on matched fixtures. The panel is a fixed list of N opponent fixtures drawn
// once per run. Every retested team, and the incumbent, also plays the panel fixtures it
// has not played yet, so contenders accumulate paired evidence on common opponents.
// Panel outcomes are ordinary labelled fixtures (they enter the checkpoint's observations
// and records) and are tagged source 'retest-panel'. They are training evidence, never
// part of the sealed screening or final panels, which the search rejects an overlap with.
const {teamKey}=require('./common.cjs');
const {summarize,compare,compareFinalists}=require('./evaluation.cjs');

const SEED_OFFSET=810001,BOOTSTRAP_OFFSET=810002,SOURCE='retest-panel';

function createPanel({fixtures,requested,seed}){return {fixtures,requested,seed,teams:{},scores:{}};}
// Teams that must hold the whole panel after this round: the retested team(s) plus the incumbent.
function teamsToPlay(pending,incumbent=null){
 const rows=new Map();
 for(const team of pending.teams)if(pending.sources?.[teamKey(team)]==='retest')rows.set(teamKey(team),team);
 if(incumbent)rows.set(teamKey(incumbent),incumbent);
 return [...rows.values()];
}
function register(panel,teams){for(const team of teams){const key=teamKey(team);panel.teams[key]=team;panel.scores[key]??=[];}}
function complete(panel,key){const scores=panel.scores[key];if(!Array.isArray(scores)||scores.length<panel.fixtures)return false;for(let i=0;i<panel.fixtures;i++)if(!Number.isFinite(scores[i]))return false;return true;}
function row(panel,key){return summarize(panel.scores[key].slice(0,panel.fixtures),{team:panel.teams[key],fixtureSeed:panel.seed,kind:SOURCE,paired:false});}
// Incumbent minus contender on the shared panel, resampling whole fixtures (evaluation.cjs compare).
// delta > 0 means the incumbent scored higher. Per-contender intervals are not corrected for
// the number of contenders; `simultaneous` in the full report is.
function pair(incumbentRow,contenderRow,seed){
 const c=compare(incumbentRow,[contenderRow],{seed});
 return {team:contenderRow.team,score:contenderRow.score,incumbentScore:incumbentRow.score,delta:c.delta,interval95:c.interval95,fixtures:c.fixtures,standing:c.interval95[0]>0?'incumbent-better':c.interval95[1]<0?'contender-better':'unresolved'};
}
// Compact record for history.jsonl: the incumbent against the teams that played the panel this round.
function roundSummary(panel,teams,incumbent,{seed=1}={}){
 const iKey=teamKey(incumbent);if(!complete(panel,iKey))return {fixtures:panel.fixtures,incumbent,comparisons:[],note:'incumbent panel incomplete'};
 const base=row(panel,iKey);
 return {fixtures:panel.fixtures,incumbent,incumbentScore:base.score,teamsOnPanel:Object.keys(panel.scores).filter(key=>complete(panel,key)).length,comparisons:teams.filter(t=>teamKey(t)!==iKey&&complete(panel,teamKey(t))).map(t=>pair(base,row(panel,teamKey(t)),seed))};
}
// Full table for recommendations.json: the best-ranked team with a complete panel against every other.
// `ordered` is the records in selection order, so the reference is the incumbent unless it has not played.
function report(panel,ordered,{seed=1}={}){
 if(!panel)return null;
 const reference=ordered.find(r=>complete(panel,teamKey(r.team)));if(!reference)return {fixtures:panel.fixtures,seed:panel.seed,teams:0,incumbent:null,comparisons:[]};
 const iKey=teamKey(reference.team),base=row(panel,iKey),others=Object.keys(panel.scores).filter(key=>key!==iKey&&complete(panel,key)).sort(),rows=others.map(key=>row(panel,key));
 const comparisons=rows.map(r=>pair(base,r,seed)).sort((a,b)=>a.delta-b.delta);
 return {fixtures:panel.fixtures,seed:panel.seed,teams:others.length+1,incumbent:reference.team,incumbentIsLeader:teamKey(ordered[0].team)===iKey,incumbentScore:base.score,comparisons,simultaneous:rows.length?compareFinalists(base,rows,{seed}):null,method:'incumbent minus contender on shared fixed opponents; whole-fixture paired bootstrap; per-contender intervals are not multiplicity-corrected, simultaneous bands are'};
}
module.exports={SEED_OFFSET,BOOTSTRAP_OFFSET,SOURCE,createPanel,teamsToPlay,register,complete,row,pair,roundSummary,report};
