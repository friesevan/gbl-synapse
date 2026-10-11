#!/usr/bin/env node
// Re-scores a run's saved HP-bar hits with the current fit (combat.js) without decoding video:
// node refit.cjs RUN.json OUT.json [learned.json]. Matchups keep their hits, CPs and candidates.
const fs=require('node:fs'),K=require('../../includes/meta/combat.js');
// GAMEMASTER=path selects PvPoke game data from the recording's date (older files lack `turns`).
const gm=(()=>{const g=process.env.GAMEMASTER?JSON.parse(require('node:fs').readFileSync(process.env.GAMEMASTER,'utf8')):require('../../includes/pro/data/gamemaster.json');for(const m of g.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);return g;})();
const [inPath,outPath,learnedPath]=process.argv.slice(2),run=JSON.parse(fs.readFileSync(inPath,'utf8')),learned=learnedPath?JSON.parse(fs.readFileSync(learnedPath,'utf8')):undefined;
const league=Number(process.env.LEAGUE||1500),rankings=new Map(require(`../../includes/pro/data/league-${league}.json`).overall.map(r=>[r.speciesId,r])),byId=new Map(gm.pokemon.map(p=>[p.speciesId,p]));
const entries=p=>(p.candidates||[]).filter(c=>/mega|primal/i.test(p.label||'')||!/_(mega|primal)/.test(c.id)).map(c=>byId.get(c.id)).filter(Boolean);
const summary=(sizes,turns)=>sizes?.length>=2?{sizes,turns:turns??null,repeats:Math.max(0,sizes.length-2)}:null;
const t0=Date.now();
for(const b of run.full)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,rankings);
for(const b of run.full){for(const g of b.matchups){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);if(!o||!m){g.result=null;continue;}
  const r=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},hitsOnMy:summary(g.hitsOnMy,g.cadenceOnMy),hitsOnOpp:summary(g.hitsOnOpp,g.cadenceOnOpp),moves:gm.moves,rankings,league,learned});
  g.result=r;g.fit=r&&r.all.map(h=>({opp:h.opp,oppMove:h.oppMove,my:h.my,myMove:h.myMove,evidence:+h.evidence.toFixed(4),oppPrior:+h.oppPrior.toFixed(4),myPrior:+h.myPrior.toFixed(4)}));}}
const Aura=require('../../includes/meta/aura.js');const pooled=K.poolMine(run.full);for(const b of run.full){K.attachInference(b,pooled);Aura.applyToBattle(b);for(const g of b.matchups)delete g.result;}
fs.writeFileSync(outPath,JSON.stringify(run));
const mine=new Map();for(const b of run.full)for(const p of b.my)if(p.inference)mine.set(p.label,`${p.inference.moves[0].value}@${p.inference.moves[0].p.toFixed(2)} shadow ${p.inference.shadowP.toFixed(2)}`);
console.log(`refit in ${((Date.now()-t0)/1000).toFixed(1)} s · yours: ${[...mine].map(([k,v])=>k+' '+v).join(' | ')}`);
