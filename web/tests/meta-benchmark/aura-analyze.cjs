#!/usr/bin/env node
// How well do the visual Shadow cues (aura-features.cjs) separate confirmed Shadow from regular Pokémon?
// Opponent truth comes from reviewer answers; your side's truth from your team's pooled estimate
// (Electivire Shadow in hour-gl, the rest regular). Usage:
// node aura-analyze.cjs ANSWERS_DIR rec=RUN.json:AURA.json ...
const fs=require('node:fs'),path=require('node:path');
const [ansDir,...specs]=process.argv.slice(2),answers=new Map();
for(const f of fs.readdirSync(ansDir)){const d=JSON.parse(fs.readFileSync(path.join(ansDir,f),'utf8'));const a=d.data||d;answers.set(a.qid,a);}
const rows=[];
for(const spec of specs){const [rec,files]=spec.split('=');const [runPath,auraPath]=files.split(':');
 const run=JSON.parse(fs.readFileSync(runPath,'utf8')),aura=JSON.parse(fs.readFileSync(auraPath,'utf8'));
 for(const a of aura){const b=run.full[a.battle],m=b.my.find(p=>p.key===a.my),myShadow=!!(m?.inference&&m.inference.shadowP>.5);
  const ans=answers.get(`claude-test:${rec}:${a.battle}:opponent:${a.opponent}:shadow`);
  if(ans&&ans.value!==null)rows.push({side:'opponent',id:`${rec}:${a.battle}:${a.opponent}`,truth:!!ans.value,myShadow,f:a.auraOpponent});
  rows.push({side:'my',id:`${rec}:${a.battle}:${a.my}`,truth:myShadow,myShadow,f:a.auraMy});}}
const auc=(pos,neg)=>{let s=0;for(const p of pos)for(const n of neg)s+=p>n?1:p===n?.5:0;return pos.length&&neg.length?s/(pos.length*neg.length):NaN;};
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[s.length>>1]:NaN;};
function report(label,list,feat){const pos=list.filter(r=>r.truth).map(feat).filter(Number.isFinite),neg=list.filter(r=>!r.truth).map(feat).filter(Number.isFinite);
 console.log(`${label.padEnd(44)} Shadow n=${String(pos.length).padStart(3)} median ${med(pos).toFixed(4)} · regular n=${String(neg.length).padStart(3)} median ${med(neg).toFixed(4)} · AUC ${auc(pos,neg).toFixed(2)}`);}
module.exports={rows,auc,med};
if(require.main===module){
 const opp=rows.filter(r=>r.side==='opponent'&&r.f),mine=rows.filter(r=>r.side==='my'&&r.f);
 for(const [name,feat] of [['purple',r=>r.f.purple],['red',r=>r.f.red]]){
  report(`your side · ${name}`,mine,feat);
  report(`opponent · ${name} · all matchups`,opp,feat);
  report(`opponent · ${name} · your Pokémon regular`,opp.filter(r=>!r.myShadow),feat);
  report(`opponent · ${name} · your Pokémon Shadow`,opp.filter(r=>r.myShadow),feat);}
 // opponent matchups pooled per Pokémon (median over its matchups), your Pokémon regular only
 const per=new Map();for(const r of opp.filter(r=>!r.myShadow)){if(!per.has(r.id))per.set(r.id,{truth:r.truth,p:[],red:[]});per.get(r.id).p.push(r.f.purple);per.get(r.id).red.push(r.f.red);}
 const pooled=[...per.values()].map(v=>({truth:v.truth,f:{purple:med(v.p),red:med(v.red)}}));
 report('opponent · purple · per Pokémon (you regular)',pooled,r=>r.f.purple);report('opponent · red · per Pokémon (you regular)',pooled,r=>r.f.red);}
