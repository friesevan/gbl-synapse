#!/usr/bin/env node
// Compares measured HP-bar hits with PvPoke predictions under reviewer-confirmed truth (form/Shadow
// and fast move), to find systematic measurement bias. Usage:
// node calibrate.cjs ANSWERS_DIR rec=RUN.json:GAMEMASTER.json[:league] ...
const fs=require('node:fs'),path=require('node:path'),K=require('../../includes/meta/combat.js');
const [ansDir,...specs]=process.argv.slice(2),answers=new Map();
for(const f of fs.readdirSync(ansDir)){const d=JSON.parse(fs.readFileSync(path.join(ansDir,f),'utf8'));const a=d.data||d;answers.set(a.qid,a);}
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};const out={attack:[],defense:[]};
for(const spec of specs){const [rec,rest]=spec.split('=');const [runPath,gmPath]=rest.split(':');const run=JSON.parse(fs.readFileSync(runPath,'utf8')),gm=JSON.parse(fs.readFileSync(gmPath,'utf8'));for(const m of gm.moves)if(m.turns===undefined&&m.cooldown)m.turns=Math.round(m.cooldown/500);
 const byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),mv=new Map(gm.moves.map(m=>[m.moveId,m]));
 run.full.forEach((b,bi)=>{for(const g of b.matchups){const o=b.opponent.find(p=>p.key===g.opponent),m=b.my.find(p=>p.key===g.my);if(!o||!m||!m.inference||!o.inference)continue;
  const sh=answers.get(`claude-test:${rec}:${bi}:opponent:${o.key}:shadow`),fm=answers.get(`claude-test:${rec}:${bi}:opponent:${o.key}:fast`);
  const oBase=o.inference.forms[0].value,oShadow=sh&&sh.value!==null?sh.value:(o.inference.shadowP>.85?true:o.inference.shadowP<.15?false:null),oMove=fm&&fm.value?fm.value:(o.inference.moves[0].p>.85?o.inference.moves[0].value:null);
  const mId=m.inference.forms[0].value+(m.inference.shadowP>.5?'_shadow':''),mMove=m.inference.moves[0].value;if(oShadow===null)continue;
  const oP=byId.get(oBase+(oShadow?'_shadow':''))||byId.get(oBase),mP=byId.get(mId)||byId.get(m.inference.forms[0].value);if(!oP||!mP)continue;
  // opponent attacking you (needs its fast move), you attacking the opponent (needs your move)
  if(oMove&&g.hitsOnMy?.length>=2){const r=K.hitRange(oP,o.cp,mv.get(oMove),mP,m.cp,1500);if(r)out.attack.push({rec,bi,who:o.key,shadow:oShadow,obs:med(g.hitsOnMy),lo:r[0],hi:r[1]});}
  if(g.hitsOnOpp?.length>=2){const r=K.hitRange(mP,m.cp,mv.get(mMove),oP,o.cp,1500);if(r)out.defense.push({rec,bi,who:o.key,shadow:oShadow,obs:med(g.hitsOnOpp),lo:r[0],hi:r[1]});}}});}
for(const [k,list] of Object.entries(out)){const ratios=list.map(x=>x.obs/((x.lo+x.hi)/2)),inside=list.filter(x=>x.obs>=x.lo-.004&&x.obs<=x.hi+.004).length;
 console.log(`${k}: ${list.length} matchups · observed/predicted median ${med(ratios).toFixed(3)} (IQR ${med(ratios.filter(r=>r<med(ratios))).toFixed(3)}–${med(ratios.filter(r=>r>med(ratios))).toFixed(3)}) · within predicted range ±1px: ${inside}/${list.length}`);
 for(const s of [true,false]){const sub=list.filter(x=>x.shadow===s);if(sub.length)console.log(`   ${s?'Shadow':'regular'} opponents: ${sub.length} · median ratio ${med(sub.map(x=>x.obs/((x.lo+x.hi)/2))).toFixed(3)}`);}}
