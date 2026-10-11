#!/usr/bin/env node
// Fits the fast-move evidence parameters (combat.js FIT) to human labels by coordinate search on the
// video-grouped cross-validated log-loss (movefit-eval.cjs), from saved evidence only.
//   WORK_DIR=... node movefit-fit.cjs [--kind fastMove|form] [--rounds 2] [--nested 4] [--out params.json]
// --out merges the kind's fitted keys into params.json ({params, fastMove:{…}, form:{…}, labels}), which the
// learning loop applies as learned.fit.
// --nested K: also reports an honest score, with parameters fitted on K-1 groups of videos and scored
// on the remaining group, for each of K groups.
const fs=require('node:fs'),K=require('../../includes/meta/combat.js'),D=require('./movefit-data.cjs'),{evaluate,metrics}=require('./movefit-eval.cjs');
// Search space: dotted path → candidate values.
const SPACE={sigma:[.004,.0065,.009,.013],relSigma:[0,.08,.15,.25],outlier:[.04,.08,.15,.25],merged:[0,.04,.1],scale:[.92,.97,1.02],
 'timing.w':[0,.25,.5,.75,1],'timing.spur':[.05,.15,.3],'timing.q':[.2,.35,.55],'timing.tau':[.12,.2,.3],'timing.pause':[.1,.25,.45],
 'energy.perCharged':[0,2,3,5],'energy.tol':[0,1.5,3],'energy.eps':[.01,.05,.2],'energy.lambda':[0,.03,.08,.15],
 learnWeight:[.5,1,2,4],effectWeight:[0,.25,.5,.8],poolPower:[.5,.7,1],channelWeight:[0,2,4]};
// Regional forms: icon model and ranking prior (fitted on form labels).
const FORM_SPACE={'icons.w':[0,1],'icons.nEff':[2,4,6,10],'icons.alpha':[20,60,200],rankTemp:[2,4,8]};
const get=(o,p)=>p.split('.').reduce((x,k)=>x?.[k],o);
const set=(o,p,v)=>{const out=structuredClone(o),ks=p.split('.');let x=out;for(const k of ks.slice(0,-1))x=x[k]=x[k]||{};x[ks[ks.length-1]]=v;return out;};
function objective(params,labels,contexts,kinds=['fastMove']){const rows=evaluate({labels,kinds,contexts,options:{params}});const m=metrics(rows);return {loss:m.logloss,acc:m.acc,right:m.right,n:m.n,rows};}
function fit(labels,{rounds=2,start=K.FIT,contexts,log=()=>{},kinds=['fastMove'],space=kinds.includes('form')?FORM_SPACE:SPACE}={}){let best=structuredClone(start),cur=objective(best,labels,contexts,kinds);log(`start loss ${cur.loss} ${cur.right}/${cur.n}`);
 for(let r=0;r<rounds;r++){let moved=false;for(const [p,vals] of Object.entries(space)){for(const v of vals){if(get(best,p)===v)continue;const cand=set(best,p,v),o=objective(cand,labels,contexts,kinds);if(o.loss<cur.loss-.001){best=cand;cur=o;moved=true;log(`${p}=${v} loss ${o.loss} ${o.right}/${o.n}`);}}}if(!moved)break;}
 return {params:best,score:cur};}
// The keys a kind's search owns, so a form fit never overwrites fast-move settings and vice versa.
function pick(params,kind){const keys=[...new Set(Object.keys(kind==='form'?FORM_SPACE:SPACE).map(k=>k.split('.')[0]))],out={};for(const k of keys)if(params[k]!==undefined)out[k]=params[k];return out;}
module.exports={fit,objective,SPACE,FORM_SPACE,pick};
if(require.main===module){const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};const labels=D.loadLabels(),rounds=Number(arg('--rounds')||2),nested=Number(arg('--nested')||0),kinds=[arg('--kind')||'fastMove'],start=arg('--start')?JSON.parse(fs.readFileSync(arg('--start'),'utf8')):K.FIT;
 const contexts=new Map();for(const v of new Set(labels.map(l=>l.video))){const c=D.runContext(v);if(c)contexts.set(v,c);}
 const res=fit(labels,{rounds,contexts,kinds,start,log:s=>console.log(s)});console.log('fitted',JSON.stringify(res.params));if(arg('--out')){const out=arg('--out'),prev=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):{};fs.writeFileSync(out+'.tmp',JSON.stringify({...prev,[kinds[0]]:{params:res.params,loss:res.score.loss,right:res.score.right,n:res.score.n,fittedAt:new Date().toISOString()},params:{...(prev.params||{}),...pick(res.params,kinds[0])},labels:labels.filter(l=>['fastMove','form'].includes(l.kind)).length},null,1));fs.renameSync(out+'.tmp',out);}
 if(nested){const vids=[...new Set(labels.filter(l=>l.kind===kinds[0]).map(l=>l.video))].sort(),rows=[],base=[];
  for(let f=0;f<nested;f++){const test=new Set(vids.filter((v,i)=>i%nested===f)),train=labels.filter(l=>!test.has(l.video));const p=fit(train,{rounds,contexts,kinds,start}).params;
   const all=evaluate({labels,kinds,contexts,options:{params:p}}).filter(r=>test.has(r.video)),old=evaluate({labels,kinds,contexts,options:{params:{}}}).filter(r=>test.has(r.video));rows.push(...all);base.push(...old);console.log(`fold ${f}: fitted ${JSON.stringify(metrics(all))}`);}
  const m=metrics(rows),b=metrics(base);console.log(`nested ${nested}-fold: fitted ${m.right}/${m.n} ll ${m.logloss} ece ${m.ece} · defaults ${b.right}/${b.n} ll ${b.logloss} ece ${b.ece}`);}}
