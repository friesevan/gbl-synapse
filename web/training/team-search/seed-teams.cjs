'use strict';
const {validTeam,teamKey}=require('./common.cjs');
// Reuse compositions only. No historical score, fixture or fitted weight is returned.
function seedTeamHints(source,pool,limit=24){
 if(source.config?.poolHash!==pool.hash)throw Error('Seed team ideas require the same candidate pool');
 const candidates=source.finalistTeams?.length?source.finalistTeams:(source.records||[]).slice().sort((a,b)=>b.reward/b.games-a.reward/a.games).map(r=>r.team);
 if(!candidates.length||candidates.some(t=>!validTeam(t,pool.variants)))throw Error('Invalid seed team ideas');
 return [...new Map(candidates.map(t=>[teamKey(t),t.slice()])).values()].slice(0,limit);
}
module.exports={seedTeamHints};
