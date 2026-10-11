'use strict';
const {fixtures}=require('./common.cjs');
function analyzeOpponents(result,pool,{sealedFixtures}={}){
 if(!result?.pairs?.length)return null;
 if(result.paired===false&&!sealedFixtures)throw Error('v2 diagnostics require the saved fixture panel');
 const panel=sealedFixtures||fixtures(pool.species,result.pairs.length,result.fixtureSeed),groups=new Map();
 if(panel.length<result.pairs.length||result.pairs.some(s=>!Number.isFinite(s)||s<0||s>1))throw Error('Opponent diagnostics require a complete finite score for each saved fixture');
 const cases=panel.slice(0,result.pairs.length);
 const rows=cases.map((c,i)=>{const score=result.pairs[i];for(const p of c.team){const g=groups.get(p.speciesId)||{speciesId:p.speciesId,speciesName:p.speciesName,fixtures:0,scoreSum:0};g.fixtures++;g.scoreSum+=score;groups.set(p.speciesId,g);}return {fixture:i+1,battleSeed:c.seed,score,component:c.component||'independent',opponents:c.team.map(p=>({speciesId:p.speciesId,speciesName:p.speciesName,moveset:p.moveset}))};});
 const species=[...groups.values()].map(({scoreSum,...g})=>({...g,score:scoreSum/g.fixtures})).sort((a,b)=>a.score-b.score||b.fixtures-a.fixtures);
 return {fixtureSeed:result.fixtureSeed,primaryTeam:result.team,fixtures:rows,species,note:'Scores are '+(result.paired===false?'canonical single-battle':'mirrored')+' 3v3 team outcomes, conditional on an opponent appearing anywhere on a team. They are not 1v1 ratings or independent species effects.'};
}
module.exports={analyzeOpponents};
