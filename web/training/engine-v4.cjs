'use strict';
const legacy=require('./engine-v4-core.cjs');
const {random}=require('./utils.cjs');
const rowKey=r=>r.speciesId+'|'+r.moveset.join('|');
const canonicalTeam=t=>[t[0],...t.slice(1).sort((a,b)=>rowKey(a).localeCompare(rowKey(b)))];
const key=(team,policy,planner)=>JSON.stringify([planner,team.map(rowKey),Object.keys(policy).sort().map(k=>[k,policy[k]])]);
function play(a,b,pa=legacy.defaults,pb=legacy.defaults,options={}){
 if(options.lookahead===false||options.plannerTeams?.some(v=>v===false))throw Error('v4 requires observation-limited controllers on both teams');
 a=canonicalTeam(a);b=canonicalTeam(b);
 if(!options.beliefRoster){const ranks=require('../includes/pro/data/league-1500.json').overall,weights=new Map(require('../includes/pro/data/overrides-1500.json').map(p=>[p.speciesId,p.weight]));const data=require('../includes/pro/data/gamemaster.json'),dex=new Map(data.pokemon.map(p=>[p.speciesId,p.dex]));options={...options,beliefRoster:ranks.map(p=>({speciesId:p.speciesId,dex:dex.get(p.speciesId),moveset:p.moveset,weight:weights.get(p.speciesId)??1})).filter(p=>p.weight>0)};}

 // Map caller slots into an identity-based encounter. A seeded coin chooses
 // physical orientation; lexical identity does not always get a privileged slot.
 const planners=options.plannerTeams||[true,true];
 const seed=options.seed??1,ka=key(a,pa,planners[0]),kb=key(b,pb,planners[1]),coin=random(seed^0x7149ab3d)()<.5;
 const reverse=(ka>kb)!==coin;
 const result=reverse?legacy.play(b,a,pb,pa,{...options,plannerTeams:[planners[1],planners[0]],lookahead:options.lookahead!==false,neutralPriority:true}):legacy.play(a,b,pa,pb,{...options,plannerTeams:planners,lookahead:options.lookahead!==false,neutralPriority:true});
 if(reverse){if(result.planner?.observed)result.planner.observed.reverse();result.score=1-result.score;result.remaining.reverse();if(result.samples){result.teamStats.reverse();result.samples.forEach(s=>{s[2]=s[2].slice(3).concat(s[2].slice(0,3));s[3].reverse();s[4].reverse();});result.timeline.forEach(e=>{if(e.actor===0||e.actor===1)e.actor=1-e.actor;});}}
 if(result.samples)result.traceScore=result.score;
 // Identical teams/policies have no distinguishable side identity. Report the
 // expectation of this seeded battle and its mirrored counterpart, explicitly.
 if(ka===kb){const outcome=result.score;result.score=.5;result.scoreMode='identical-team-mirrored-expectation';result.mirroredOutcomes=[outcome,1-outcome];const mean=(result.remaining[0]+result.remaining[1])/2;result.remaining=[mean,mean];}
 result.engineVersion='team-observation-v4';return result;
}
module.exports={play,canonicalTeam,rowKey,random,defaults:legacy.defaults};
