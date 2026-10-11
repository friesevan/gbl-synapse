#!/usr/bin/env node
// Where fast-move predictions fail: joins each confirmed fast move to its saved hits and compares the
// measured damage/cadence/energy with PvPoke's predictions for the true move and the model's pick.
//   node movefit-diagnose.cjs CV_ROWS.json [--list]     (CV_ROWS from movefit-eval.cjs --dump)
const fs=require('node:fs'),K=require('../../includes/meta/combat.js'),D=require('./movefit-data.cjs'),{loadGameMaster}=require('./refit.cjs');
const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[s.length>>1]:null;};
function memberStats(ctx,l,gm,labels){const byId=new Map(gm.pokemon.map(p=>[p.speciesId,p])),mv=new Map(gm.moves.map(m=>[m.moveId,m])),run=ctx.raw,b=run.full[l.battle],m=b[l.side].find(p=>p.key===l.key);
 const lab=(kind,v,bi,key,side)=>labels.find(x=>x.kind===kind&&x.video===l.video&&x.side===side&&x.key===key&&(x.battle===bi||(x.allBattles&&side==='my')));
 const formOf=(p,bi,side)=>{const f=lab('form',null,bi,p.key,side),sh=lab('shadow',null,bi,p.key,side);let id=f?String(f.value).replace(/_shadow$/,''):p.inference?.forms?.[0]?.value||p.candidates?.[0]?.id;const shadow=sh?sh.value===true:(p.inference?.shadowP??0)>.5;return byId.get(id+(shadow?'_shadow':''))||byId.get(id);};
 const battles=l.side==='my'?run.full.map((x,i)=>[x,i]):[[b,l.battle]],out=[];
 for(const [bb,bi] of battles)for(const g of bb.matchups||[]){if(g[l.side]!==l.key)continue;const self=bb[l.side].find(p=>p.key===l.key),otherSide=l.side==='my'?'opponent':'my',other=bb[otherSide].find(p=>p.key===g[otherSide]);if(!self||!other)continue;
  const A=formOf(self,bi,l.side),Dd=formOf(other,bi,otherSide);if(!A||!Dd)continue;const sizes=l.side==='my'?g.hitsOnOpp||[]:g.hitsOnMy||[],times=l.side==='my'?g.hitTimesOnOpp||[]:g.hitTimesOnMy||[];
  out.push({A,D:Dd,cpA:self.cp,cpD:other.cp,sizes,times,battle:bi,effects:l.side==='my'?g.effects?.onOpp:g.effects?.onMy});}
 return {member:m,fits:out,mv,byId,evidence:b.evidence?.[l.side]?.[l.key]};}
function analyse(rows,labels){const reg=D.registry(),gms=new Map(),res=[];const gmFor=f=>{if(!gms.has(f))gms.set(f,loadGameMaster(f||undefined));return gms.get(f);};
 for(const r of rows.filter(r=>r.kind==='fastMove')){const l=labels.find(x=>x.qid===r.qid),ctx=D.runContext(l.video,D.WORK,reg),gm=gmFor(ctx.gamemaster),s=memberStats(ctx,l,gm,labels);
  const league=D.leagueFromCPs(ctx.raw.full[l.battle],ctx.league||1500),T=s.mv.get(l.value),P=r.top&&s.mv.get(r.top);
  const pred=move=>move?s.fits.map(f=>K.hitRange(f.A,f.cpA,move,f.D,f.cpD,league)).filter(Boolean):[];
  const sizes=s.fits.flatMap(f=>f.sizes),pt=pred(T),pp=pred(P);
  const ratio=(ps)=>{const rs=[];s.fits.forEach((f,i)=>{const p=ps[i];if(p)for(const x of f.sizes)rs.push(x/((p[0]+p[1])/2));});return med(rs);};
  const gaps=s.fits.flatMap(f=>f.times.slice(1).map((t,i)=>Math.round((t-f.times[i])/.5)).filter(g=>g>0&&g<7));
  const learnable=s.fits[0]?.A&&[...(s.fits[0].A.fastMoves||[]),...(s.fits[0].A.eliteMoves||[])].includes(l.value);
  res.push({qid:r.qid,right:r.right,p:r.p,source:r.source,side:l.side,species:l.species,truth:l.value,top:r.top,nHits:sizes.length,matchups:s.fits.length,
   trueTurns:T?.turns,topTurns:P?.turns,trueRatio:ratio(pt),topRatio:ratio(pp),gapMode:med(gaps),gaps:gaps.join(''),
   sameDamage:pt.length&&pp.length?Math.abs((pt[0][0]+pt[0][1])-(pp[0][0]+pp[0][1]))/(pt[0][0]+pt[0][1])<.1:null,
   energyRejectsTruth:s.evidence?K.energyFactor(T,s.evidence.energy)<1:false,energyRejectsTop:s.evidence&&P?K.energyFactor(P,s.evidence.energy)<1:false,
   charged:(s.evidence?.energy||[]).length,learnable,formUsed:s.fits[0]?.A?.speciesId});}
 return res;}
function summarize(res){const wrong=res.filter(r=>!r.right),c=f=>`${res.filter(f).length} (${wrong.filter(f).length} wrong)`;
 const ratios=res.filter(r=>r.trueRatio).map(r=>r.trueRatio);
 return {total:`${res.length}, ${wrong.length} wrong`,
  'fewer than 2 hits (prior only)':c(r=>r.nHits<2),'2-3 hits':c(r=>r.nHits>=2&&r.nHits<4),'4+ hits':c(r=>r.nHits>=4),
  'true move not learnable by form used':c(r=>!r.learnable),
  'truth and pick within 10% damage':c(r=>r.sameDamage===true),'same turns as pick':c(r=>r.top&&r.trueTurns===r.topTurns),
  'saved frame-count energy check rejects truth':c(r=>r.energyRejectsTruth),'saved frame-count energy check rejects pick':c(r=>r.energyRejectsTop),
  'measured/predicted (true move) median':+med(ratios).toFixed(3),'IQR':[+med(ratios.filter(x=>x<med(ratios))).toFixed(3),+med(ratios.filter(x=>x>med(ratios))).toFixed(3)],
  'true ratio off by >15%':c(r=>r.trueRatio&&Math.abs(r.trueRatio-1)>.15),'hit gap mode == true turns':c(r=>r.gapMode===r.trueTurns),'hit gap mode == pick turns':c(r=>r.top&&r.gapMode===r.topTurns&&r.topTurns!==r.trueTurns),
  'opponent side':c(r=>r.side==='opponent'),'my side':c(r=>r.side==='my')};}
module.exports={analyse,summarize};
if(require.main===module){const rows=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),labels=D.loadLabels(),res=analyse(rows,labels);console.log(JSON.stringify(summarize(res),null,1));
 if(process.argv.includes('--list'))for(const r of res.filter(r=>!r.right))console.log(`${r.qid.split(':').slice(1).join(':')} truth=${r.truth}(${r.trueTurns}t r${r.trueRatio?.toFixed(2)}) top=${r.top}(${r.topTurns}t r${r.topRatio?.toFixed(2)}) p=${r.p.toFixed(2)} hits=${r.nHits} gaps=${r.gaps} en=${r.charged}${r.energyRejectsTruth?' ENERGY-REJECTS-TRUTH':''}${r.learnable?'':' NOT-LEARNABLE('+r.formUsed+')'}`);}
