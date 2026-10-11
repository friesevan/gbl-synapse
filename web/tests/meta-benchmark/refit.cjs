#!/usr/bin/env node
// Re-score saved physical HP/cadence evidence, without decoding footage or conditioning on answers.
const fs=require('node:fs'),K=require('../../includes/meta/combat.js'),Aura=require('../../includes/meta/aura.js'),Shadow=require('../../includes/meta/shadow-model.js');
function loadGameMaster(file){const g=file?JSON.parse(fs.readFileSync(file,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;}
// League CP for one battle when no label sets it: the video's league unless the nameplate CPs rule it out
// (a CP above the cap means a higher league; three or more CPs, all at most 500, mean Little Cup).
function battleLeague(b,league){const cps=[...(b.my||[]),...(b.opponent||[])].map(p=>Number(p.cp)).filter(c=>c>=10&&c<9000);if(!cps.length)return league;const top=Math.max(...cps);
 if(top>league)return top<=1500?1500:top<=2500?2500:10000;if(top<=500&&cps.length>=3&&league>500)return 500;return league;}
function refitRun(input,{learned,league=1500,gm=loadGameMaster(),rankings,params={},channel,shadowModel,speciesPurple}={}){
 const run=structuredClone(input),byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),cache=new Map();
 const ranks=cp=>{if(rankings)return rankings;if(!cache.has(cp)){const f=require(`../../includes/pro/data/league-${cp}.json`);cache.set(cp,new Map(f.overall.map(r=>[r.speciesId,r])));}return cache.get(cp);};
 const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
 const summary=(sizes,turns,times)=>sizes?.length>=2?{sizes,times:times?.length===sizes.length?times:undefined,turns:turns??null,repeats:Math.max(0,sizes.length-2)}:null;
 const fit={...(learned?.fit||{}),...params},movesById=new Map(gm.moves.map(m=>[m.moveId,m])),myMoves=K.channelMoves(learned,channel,fit.channelWeight??K.FIT.channelWeight);
 const iconModel=K.iconModel(run.full||[],{...K.FIT.icons,...(fit.icons||{})}.alpha);
 const leagueOf=[];for(const [bi,b] of (run.full||[]).entries()){const cp=[500,1500,2500,10000].includes(Number(b.leagueCP))?Number(b.leagueCP):params.cpLeague===false?league:battleLeague(b,league),r=ranks(cp);leagueOf[bi]=cp;
  // An answer-conditioned posterior is never recycled as evidence for the next prediction.
  delete b.answers;for(const side of ['my','opponent'])for(const p of b[side]||[]){delete p.answers;delete p.inference;K.narrowByRankings(p,r);}
  const icons={...K.FIT.icons,...(fit.icons||{})};if(icons.w)for(const side of ['my','opponent'])for(const p of b[side]||[])p.typeLL=K.iconLogL(p,iconModel,icons);
  for(const g of b.matchups||[]){const o=(b.opponent||[]).find(p=>p.key===g.opponent),m=(b.my||[]).find(p=>p.key===g.my);if(!o||!m){g.result=null;continue;}
   g.result=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp,typeLL:o.typeLL},my:{candidates:entries(m),cp:m.cp,typeLL:m.typeLL,learnedMoves:myMoves},hitsOnMy:summary(g.hitsOnMy,g.cadenceOnMy,g.hitTimesOnMy),hitsOnOpp:summary(g.hitsOnOpp,g.cadenceOnOpp,g.hitTimesOnOpp),charged:g.charged||{onMy:g.chargedOnMy||[],onOpp:g.chargedOnOpp||[]},effects:g.effects,moves:gm.moves,rankings:r,league:cp,learned,...params});
   g.fit=g.result&&g.result.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:h.evidence,oppPrior:h.oppPrior,myPrior:h.myPrior}));
  }
  // Energy checks are recomputed with clock fighting time (saved checks counted visible-bar frames).
  if(b.segments&&b.events)b.evidence=K.battleEvidence(b,movesById,K.clockFight(b,fit.energy));
  for(const side of ['my','opponent'])for(const [key,info]of Object.entries(b.evidence?.[side]||{}))K.applyBattleEvidence((b.matchups||[]).filter(g=>g[side]===key).map(g=>g.result),side,info,byId,r,movesById,fit);
 }
 const pooled=K.poolMine(run.full||[]);for(const [bi,b] of (run.full||[]).entries()){K.attachInference(b,pooled,fit);
  // Pokémon never measured in a matchup still get a prior-only answer (forms, icons, labels).
  for(const side of ['my','opponent'])for(const p of b[side]||[])if(!p.inference){const c=entries(p);if(c.length)p.inference=K.priorInference(c,{learned,rankings:ranks(leagueOf[bi]),typeLL:p.typeLL,fit,learnedMoves:side==='my'?myMoves:undefined});}Aura.applyToBattle(b,undefined,learned);}
 Shadow.applyToBattles(run.full||[],shadowModel,{learned,speciesPurple,rankings:ranks(league),moveTypes:new Map(gm.moves.map(m=>[m.moveId,m.type]))});for(const b of run.full||[])for(const g of b.matchups||[])delete g.result;return run;
}
module.exports={refitRun,loadGameMaster,battleLeague};
if(require.main===module){const [inPath,outPath,learnedPath]=process.argv.slice(2),t=Date.now();const out=refitRun(JSON.parse(fs.readFileSync(inPath,'utf8')),{learned:learnedPath?JSON.parse(fs.readFileSync(learnedPath,'utf8')):undefined,league:Number(process.env.LEAGUE||1500),gm:loadGameMaster(process.env.GAMEMASTER)});fs.writeFileSync(outPath,JSON.stringify(out));console.log(`refit in ${((Date.now()-t)/1000).toFixed(1)} s`);}
