#!/usr/bin/env node
// Video-grouped cross-validation of fast-move and form predictions against human labels.
// Every labelled video is refit from its saved evidence with priors learned only from the OTHER videos.
//   node movefit-eval.cjs [--model old|new] [--kinds fastMove,form] [--dump OUT.json]
const fs=require('node:fs'),Q=require('../../includes/meta/questions.js'),{refitRun,loadGameMaster}=require('./refit.cjs'),{prediction}=require('./learning-loop.cjs'),D=require('./movefit-data.cjs');
function metrics(rows){const n=rows.length,right=rows.filter(r=>r.right).length,ll=rows.reduce((s,r)=>s-Math.log(Math.max(1e-3,r.pTrue)),0)/Math.max(1,n);
 const bins=[[0,.5],[.5,.7],[.7,.85],[.85,.95],[.95,.99],[.99,1.01]].map(([lo,hi])=>{const b=rows.filter(r=>r.p>=lo&&r.p<hi);return {bin:`${lo}-${Math.min(1,hi)}`,n:b.length,meanP:b.length?+(b.reduce((s,r)=>s+r.p,0)/b.length).toFixed(3):null,acc:b.length?+(b.filter(r=>r.right).length/b.length).toFixed(3):null};});
 const ece=bins.reduce((s,b)=>s+(b.n?b.n*Math.abs(b.meanP-b.acc):0),0)/Math.max(1,n);return {n,right,acc:+(right/Math.max(1,n)).toFixed(3),logloss:+ll.toFixed(3),ece:+ece.toFixed(3),bins};}
function distFor(run,l){const b=run.full?.[l.battle],m=b?.[l.side]?.find(p=>p.key===l.key),inf=m?.inference;if(!inf)return null;return l.kind==='form'?inf.forms:l.kind==='fastMove'?inf.moves:[{value:true,p:inf.shadowP},{value:false,p:1-inf.shadowP}];}
// Form answers name the base form; compare without the Shadow suffix.
const norm=(kind,v)=>kind==='form'?String(v).replace(/_shadow$/,''):v;
function evaluate({labels=D.loadLabels(),kinds=['fastMove','form'],fit=refitRun,options={},prune=true,contexts}={}){const reg=D.registry(),gms=new Map(),rows=[];
 const gmFor=f=>{if(!gms.has(f||''))gms.set(f||'',loadGameMaster(f||undefined));return gms.get(f||'');};
 const videos=[...new Set(labels.filter(l=>kinds.includes(l.kind)).map(l=>l.video))];
 for(const vid of videos){const ctx=contexts?.get(vid)||D.runContext(vid,D.WORK,reg);if(!ctx)continue;const others=labels.filter(l=>l.video!==vid);
  const learned=Q.learnedFromAnswers([],new Map(others.map(l=>[l.qid,l])));learned.channels=D.channelLearned(others,v=>reg.get(v)?.channel);
  // Only matchups that bear on a labelled Pokémon are refit (yours pool across battles): same answers, less work.
  let raw=ctx.raw;if(prune){const mine=new Set(labels.filter(l=>l.video===vid&&l.side==='my').map(l=>l.key)),opp=new Set(labels.filter(l=>l.video===vid&&l.side==='opponent').map(l=>l.battle+':'+l.key));
   raw={...raw,full:raw.full.map((b,i)=>({...b,matchups:(b.matchups||[]).filter(g=>mine.has(g.my)||opp.has(i+':'+g.opponent))}))};}
  const run=fit(raw,{learned,league:ctx.league||1500,gm:gmFor(ctx.gamemaster),channel:ctx.channel||labels.find(l=>l.video===vid&&l.channel)?.channel,...options});
  for(const l of labels.filter(l=>l.video===vid&&kinds.includes(l.kind))){const dist=distFor(run,l)||[];const top=dist[0],t=norm(l.kind,l.value),pTrue=dist.filter(d=>norm(l.kind,d.value)===t).reduce((s,d)=>s+d.p,0);
   const p=prediction(run,l);rows.push({qid:l.qid,kind:l.kind,video:vid,side:l.side,source:l.source,species:l.species,value:l.value,top:top?.value??null,p:top?.p??0,pTrue,right:!!top&&norm(l.kind,top.value)===t,hits:p?.hits??0,margin:p?.margin??0,channel:ctx.channel||l.channel});}}
 return rows;}
function report(rows){const out={};for(const k of [...new Set(rows.map(r=>r.kind))]){const rs=rows.filter(r=>r.kind===k);out[k]={all:metrics(rs),feedback:metrics(rs.filter(r=>r.source==='feedback')),legacy:metrics(rs.filter(r=>r.source==='legacy')),opponent:metrics(rs.filter(r=>r.side==='opponent')),my:metrics(rs.filter(r=>r.side==='my'))};}return out;}
module.exports={evaluate,metrics,report,distFor,norm};
if(require.main===module){const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};const model=arg('--model')||'old',kinds=(arg('--kinds')||'fastMove,form').split(',');
 const fit=model==='new'?require('./movefit-refit.cjs').refitNew:refitRun;const t=Date.now(),rows=evaluate({kinds,fit,options:{params:JSON.parse(process.env.PARAMS||'{}')}});const r=report(rows);
 for(const [k,v] of Object.entries(r))console.log(k,Object.entries(v).map(([s,m])=>`${s} ${m.right}/${m.n} ll ${m.logloss} ece ${m.ece}`).join(' | '));
 if(process.argv.includes('--bins'))for(const [k,v] of Object.entries(r))console.log(k,JSON.stringify(v.all.bins));
 if(arg('--dump'))fs.writeFileSync(arg('--dump'),JSON.stringify(rows));console.log(`${((Date.now()-t)/1000).toFixed(0)} s`);}
