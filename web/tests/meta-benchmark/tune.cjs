#!/usr/bin/env node
// Picks fit settings by how well they predict reviewer answers (Shadow and fast move). Each setting is
// scored by the mean log-probability the model gives the reviewer's answer, after re-scoring every
// matchup and pooling exactly as the app does. Usage like calibrate.cjs.
const fs=require('node:fs'),path=require('node:path'),K=require('../../includes/meta/combat.js');
const [ansDir,...specs]=process.argv.slice(2),answers=new Map();
for(const f of fs.readdirSync(ansDir)){const d=JSON.parse(fs.readFileSync(path.join(ansDir,f),'utf8'));const a=d.data||d;answers.set(a.qid,a);}
const runs=specs.map(spec=>{const [rec,rest]=spec.split('=');const [runPath,gmPath,league='1500']=rest.split(':');const gm=JSON.parse(fs.readFileSync(gmPath,'utf8'));for(const m of gm.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);
 return {rec,runPath,gm,league:Number(league),rankings:new Map(require(`../../includes/pro/data/league-${league}.json`).overall.map(r=>[r.speciesId,r])),byId:new Map(gm.pokemon.map(p=>[p.speciesId,p])),movesById:new Map(gm.moves.map(m=>[m.moveId,m]))};});
const summary=(sizes,turns)=>sizes?.length>=2?{sizes,turns:turns??null,repeats:Math.max(0,sizes.length-2)}:null;
function evaluate(params,{learnedFrom}={}){let logp=0,n=0;const per={shadow:[0,0,0],fastMove:[0,0,0]};
 for(const R of runs){const run=JSON.parse(fs.readFileSync(R.runPath,'utf8'));const entries=p=>(p.candidates||[]).filter(c=>!/_(mega|primal)/.test(c.id)).map(c=>R.byId.get(c.id)).filter(Boolean);
  for(const b of run.full)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,R.rankings);
  for(const b of run.full)for(const g of b.matchups){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);if(!o||!m){g.result=null;continue;}
   g.result=K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},hitsOnMy:summary(g.hitsOnMy,g.cadenceOnMy),hitsOnOpp:summary(g.hitsOnOpp,g.cadenceOnOpp),moves:R.gm.moves,rankings:R.rankings,league:R.league,learned:learnedFrom?.(R.rec),...params});}
  const pooled=K.poolMine(run.full);run.full.forEach((b,bi)=>{K.attachInference(b,pooled);for(const o of b.opponent){if(!o.inference)continue;
   for(const kind of ['shadow','fastMove']){const a=answers.get(`claude-test:${R.rec}:${bi}:opponent:${o.key}:${kind==='shadow'?'shadow':'fast'}`);if(!a||a.value===null||a.value===undefined)continue;
    const p=kind==='shadow'?(a.value?o.inference.shadowP:1-o.inference.shadowP):(o.inference.moves.find(x=>x.value===a.value)?.p||0);const top=kind==='shadow'?(o.inference.shadowP>=.5)===a.value:o.inference.moves[0].value===a.value;
    logp+=Math.log(Math.max(p,1e-3));n++;per[kind][0]++;per[kind][1]+=top?1:0;per[kind][2]+=Math.log(Math.max(p,1e-3));}}});}
 return {score:logp/n,n,shadow:`${per.shadow[1]}/${per.shadow[0]}`,fast:`${per.fastMove[1]}/${per.fastMove[0]}`,shadowLL:(per.shadow[2]/per.shadow[0]).toFixed(3),fastLL:(per.fastMove[2]/per.fastMove[0]).toFixed(3)};}
module.exports={evaluate,runs,answers};
if(require.main===module&&!process.env.NO_GRID){const grid=[];for(const sigma of [.004,.0065,.009])for(const relSigma of [0,.08,.12])for(const scale of [1,.97])for(const outlier of [.08])grid.push({sigma,relSigma,scale,outlier});
 const res=grid.map(p=>({p,...evaluate(p)})).sort((a,b)=>b.score-a.score);for(const r of res.slice(0,8))console.log(JSON.stringify(r.p),'mean log p',r.score.toFixed(3),'shadow',r.shadow,r.shadowLL,'fast',r.fast,r.fastLL);
 const cur=res.find(r=>r.p.sigma===.0065&&r.p.relSigma===0&&r.p.scale===1);console.log('current settings:','mean log p',cur.score.toFixed(3),'shadow',cur.shadow,cur.shadowLL,'fast',cur.fast,cur.fastLL);}
