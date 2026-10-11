#!/usr/bin/env node
// Leave-one-out test of learned priors: every answered opponent question is predicted with priors learned
// from all OTHER answers (never its own Pokémon's), and compared with the same model without priors.
const K=require('../../includes/meta/combat.js'),Q=require('../../includes/meta/questions.js'),Aura=require('../../includes/meta/aura.js');const {runs,answers}=require('./tune.cjs');
// Visual cues per matchup (aura-features.cjs), keyed rec:battle:opponent → [{purple, myShadow}].
const AURA=JSON.parse(process.env.AURA||'{}'),visual=new Map();
for(const [rec,file] of Object.entries(AURA)){for(const a of JSON.parse(require('node:fs').readFileSync(file,'utf8')))if(a.auraOpponent){const k=`${rec}:${a.battle}:${a.opponent}`;if(!visual.has(k))visual.set(k,[]);visual.get(k).push({purple:a.auraOpponent.purple,my:a.my,battle:a.battle,rec});}}
const EDGES=JSON.parse(process.env.BANDS||'null')||undefined;
const fs=require('node:fs'),params=JSON.parse(process.env.PARAMS||'{"scale":0.97}');
const summary=(sizes,turns)=>sizes?.length>=2?{sizes,turns:turns??null,repeats:Math.max(0,sizes.length-2)}:null;
// REHIT=seconds: recompute hits from each matchup's stored HP series, using only its first N seconds
// (0 = whole matchup). Lets window lengths be compared without decoding video (trails aren't stored,
// so sizes come from the bar steps).
const Hp=require('../../includes/meta/hp.js'),REHIT=process.env.REHIT;
function rehit(g){if(REHIT===undefined||!g.series)return null;const s=g.series,cap=Number(REHIT)||Infinity,out={};for(const side of ['my','opponent']){const pts=s[side].map((f,i)=>f==null?null:{t:s.t0+i/s.fps,fill:f,trail:0}).filter((p,i)=>i/s.fps<=cap||!p);let h=Hp.hits(pts);if(h.length>=3){const med=h.map(x=>x.size).sort((a,b)=>a-b)[h.length>>1];h=h.filter(x=>x.size<=med*2.2);}out[side]=h.length>=2?{sizes:h.map(x=>x.size),turns:Hp.cadence(h)?.turns??null,repeats:Math.max(0,h.length-2)}:null;}return out;}
const items=[];
for(const R of runs){const run=JSON.parse(fs.readFileSync(R.runPath,'utf8'));const entries=p=>(p.candidates||[]).filter(c=>!/_(mega|primal)/.test(c.id)).map(c=>R.byId.get(c.id)).filter(Boolean);
 for(const b of run.full)for(const side of ['my','opponent'])for(const p of b[side])K.narrowByRankings(p,R.rankings);
 for(const b of run.full)for(const g of b.matchups){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);g.result=o&&m?K.inferMatchup({opp:{candidates:entries(o),cp:o.cp},my:{candidates:entries(m),cp:m.cp},...(rh=>rh?{hitsOnMy:rh.my,hitsOnOpp:rh.opponent}:{hitsOnMy:summary(g.hitsOnMy,g.cadenceOnMy),hitsOnOpp:summary(g.hitsOnOpp,g.cadenceOnOpp)})(rehit(g)),charged:process.env.NOCHARGED?null:{onMy:g.chargedOnMy,onOpp:g.chargedOnOpp},effects:process.env.NOEFFECTS?null:g.effects,moves:R.gm.moves,rankings:R.rankings,league:R.league,...params}):null;}
 run.full.forEach((b,bi)=>{for(const o of b.opponent){const rs=b.matchups.filter(g=>g.opponent===o.key&&g.result).map(g=>g.result);if(!rs.length)continue;
  const myShadow=new Map(b.my.map(p=>[p.key,!!(p.inference&&p.inference.shadowP>.5)]));const vis=(visual.get(`${R.rec}:${bi}:${o.key}`)||[]).filter(v=>!myShadow.get(v.my)).map(v=>v.purple);
  for(const kind of ['shadow','fast']){const id=`claude-test:${R.rec}:${bi}:opponent:${o.key}:${kind}`,a=answers.get(id);if(a&&a.value!==null&&a.value!==undefined)items.push({id,R,o,rs,kind,value:a.value,vis,ev:process.env.NOEVIDENCE?null:b.evidence?.opponent?.[o.key],prefix:`claude-test:${R.rec}:${bi}:opponent:${o.key}:`});}}});}
function predict(it,learned,table){const lr=table&&it.vis.length?Math.exp(it.vis.reduce((s,x)=>s+Math.log(Aura.likelihoodRatio(x,table)),0)/Math.sqrt(it.vis.length)):1;const cands=[...new Set(it.rs.flatMap(r=>r.all.map(h=>h.opp)))].map(id=>it.R.byId.get(id)).filter(Boolean),fp=learned?K.formPrior(cands,learned,it.R.rankings):null;
 const rs=it.rs.map(r=>({all:r.all.map(h=>{if(!learned)return {...h};const p=it.R.byId.get(h.opp),base=h.opp.replace(/_shadow$/,''),mp=K.movePrior(p,it.R.rankings.get(h.opp),learned.moves[base]);return {...h,oppPrior:Math.log(fp.get(h.opp)||1e-9)+Math.log(mp.get(h.oppMove)||1e-9)};})}));
 if(lr!==1)for(const r of rs)for(const h of r.all)if(/_shadow$/.test(h.opp))h.oppPrior+=Math.log(lr)/rs.length;
 // Charged-move evidence (energy accounting, legal movesets) from the battle's banners.
 if(it.ev)K.applyBattleEvidence(rs,'opponent',it.ev,it.R.byId,it.R.rankings,it.R.movesById);
 const c=K.combineMatchups(rs,'opp');let pShadow=0;for(const r of c.rows)if(/_shadow$/.test(r.id))pShadow+=r.p;return it.kind==='shadow'?{p:it.value?pShadow:1-pShadow,top:(pShadow>=.5)===it.value}:{p:c.move.find(x=>x.value===it.value)?.p||0,top:c.move[0].value===it.value};}
const tally={},dump=[];for(const it of items){const others=new Map([...answers].filter(([id])=>!id.startsWith(it.prefix)));const learned=Q.learnedFromAnswers([],others);
 // Visual bands fitted without this Pokémon (leave-one-out), from other answered opponents.
 const table=Aura.fitBands(EDGES,items.filter(o=>o.kind==='shadow'&&o.prefix!==it.prefix).flatMap(o=>o.vis.map(purple=>({purple,shadow:!!o.value}))));
 const full=predict(it,learned,table);dump.push({id:it.id,kind:it.kind,p:full.p,top:full.top});
 for(const [label,res] of [['without priors',predict(it,null)],['with learned priors (leave-one-out)',predict(it,learned)],['+ visual aura (leave-one-out)',full],['visual aura + damage, no priors',predict(it,null,table)]]){const t=tally[label]=tally[label]||{shadow:[0,0,0],fast:[0,0,0]};const k=t[it.kind];k[0]++;k[1]+=res.top?1:0;k[2]+=Math.log(Math.max(res.p,1e-3));}}
for(const [label,t] of Object.entries(tally))console.log(label.padEnd(36),'shadow right',`${t.shadow[1]}/${t.shadow[0]}`,'log p',(t.shadow[2]/t.shadow[0]).toFixed(3),'· fast move right',`${t.fast[1]}/${t.fast[0]}`,'log p',(t.fast[2]/t.fast[0]).toFixed(3));
if(process.env.DUMP)fs.writeFileSync(process.env.DUMP,JSON.stringify(dump));
