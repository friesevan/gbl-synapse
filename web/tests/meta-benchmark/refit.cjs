#!/usr/bin/env node
// Re-score saved physical HP/cadence evidence, without decoding footage or conditioning on answers.
const fs=require('node:fs'),K=require('../../includes/meta/combat.js'),Aura=require('../../includes/meta/aura.js');
function loadGameMaster(file){const g=file?JSON.parse(fs.readFileSync(file,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;}
function refitRun(input,{learned,league=1500,gm=loadGameMaster(),rankings}={}){
 const run=structuredClone(input),byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),cache=new Map();
 const ranks=cp=>{if(rankings)return rankings;if(!cache.has(cp)){const f=require(`../../includes/pro/data/league-${cp}.json`);cache.set(cp,new Map(f.overall.map(r=>[r.speciesId,r])));}return cache.get(cp);};
 const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
 const summary=(sizes,turns)=>sizes?.length>=2?{sizes,turns:turns??null,repeats:Math.max(0,sizes.length-2)}:null;
 for(const b of run.full||[]){const cp=[500,1500,2500,10000].includes(Number(b.leagueCP))?Number(b.leagueCP):league,r=ranks(cp);
  // An answer-conditioned posterior is never recycled as evidence for the next prediction.
  delete b.answers;for(const side of ['my','opponent'])for(const p of b[side]||[]){delete p.answers;delete p.inference;K.narrowByRankings(p,r);}
  for(const g of b.matchups||[]){const o=(b.opponent||[]).find(p=>p.key===g.opponent),m=(b.my||[]).find(p=>p.key===g.my);if(!o||!m){g.result=null;continue;}
   g.result=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},hitsOnMy:summary(g.hitsOnMy,g.cadenceOnMy),hitsOnOpp:summary(g.hitsOnOpp,g.cadenceOnOpp),charged:g.charged||{onMy:g.chargedOnMy||[],onOpp:g.chargedOnOpp||[]},effects:g.effects,moves:gm.moves,rankings:r,league:cp,learned});
   g.fit=g.result&&g.result.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:h.evidence,oppPrior:h.oppPrior,myPrior:h.myPrior}));
  }
  for(const side of ['my','opponent'])for(const [key,info]of Object.entries(b.evidence?.[side]||{}))K.applyBattleEvidence((b.matchups||[]).filter(g=>g[side]===key).map(g=>g.result),side,info,byId,r,new Map(gm.moves.map(m=>[m.moveId,m])));
 }
 const pooled=K.poolMine(run.full||[]);for(const b of run.full||[]){K.attachInference(b,pooled);Aura.applyToBattle(b,undefined,learned);for(const g of b.matchups||[])delete g.result;}return run;
}
module.exports={refitRun,loadGameMaster};
if(require.main===module){const [inPath,outPath,learnedPath]=process.argv.slice(2),t=Date.now();const out=refitRun(JSON.parse(fs.readFileSync(inPath,'utf8')),{learned:learnedPath?JSON.parse(fs.readFileSync(learnedPath,'utf8')):undefined,league:Number(process.env.LEAGUE||1500),gm:loadGameMaster(process.env.GAMEMASTER)});fs.writeFileSync(outPath,JSON.stringify(out));console.log(`refit in ${((Date.now()-t)/1000).toFixed(1)} s`);}
