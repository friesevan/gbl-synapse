#!/usr/bin/env node
// Video-grouped cross-validation of the Shadow classifier on shadow-dataset.cjs rows: every row is
// predicted by a model fitted without any row from its video. Reports accuracy, log-loss, Brier and
// calibration for the old posterior and the classifier on the same rows, and picks the confidence
// threshold at which out-of-fold calls are ≥ TARGET correct (for model resolution).
//   node shadow-cv.cjs [DATASET] [--diag] [--write-default]   (--write-default refits DEFAULT_MODEL in shadow-model.js)
const fs=require('node:fs'),path=require('node:path'),Shadow=require('../../includes/meta/shadow-model.js');
const clip=p=>Math.min(1-1e-3,Math.max(1e-3,p));
function metrics(ps,ys){const n=ys.length;let right=0,ll=0,br=0;for(let i=0;i<n;i++){const p=clip(ps[i]);right+=(p>=.5)===!!ys[i];ll-=ys[i]?Math.log(p):Math.log(1-p);br+=(p-ys[i])**2;}
 return {n,right,accuracy:right/n,logLoss:ll/n,brier:br/n,auc:auc(ps,ys)};}
function auc(ps,ys){const pos=ps.filter((_,i)=>ys[i]),neg=ps.filter((_,i)=>!ys[i]);if(!pos.length||!neg.length)return null;let s=0;for(const a of pos)for(const b of neg)s+=a>b?1:a===b?.5:0;return s/(pos.length*neg.length);}
function calibration(ps,ys,bins=[0,.1,.3,.5,.7,.9,1.0001]){const out=[];for(let k=0;k<bins.length-1;k++){const idx=ps.map((p,i)=>i).filter(i=>ps[i]>=bins[k]&&ps[i]<bins[k+1]);if(idx.length)out.push({bin:`${bins[k].toFixed(1)}-${Math.min(1,bins[k+1]).toFixed(1)}`,n:idx.length,meanP:+(idx.reduce((s,i)=>s+ps[i],0)/idx.length).toFixed(3),rate:+(idx.reduce((s,i)=>s+ys[i],0)/idx.length).toFixed(3)});}return out;}
// Out-of-fold predictions: one fold per video (leave-one-video-out).
// mask(x) → x changes the test rows only (e.g. focus features removed, as for runs without them).
function crossValidate(rows,opts={},mask){const vids=[...new Set(rows.map(r=>r.video))],p=new Array(rows.length);
 for(const v of vids){const train=rows.filter(r=>r.video!==v),m=Shadow.fit(train,opts);rows.forEach((r,i)=>{if(r.video===v)p[i]=Shadow.predict(mask?mask(r.x):r.x,m);});}return p;}
const FOCUS=Shadow.FEATURES.filter(k=>/^(focus|sideFocus)/.test(k)),noFocus=x=>({...x,...Object.fromEntries(FOCUS.map(k=>[k,null])),focusN:0});
// Smallest confidence c (|p−.5|+.5 ≥ c) whose out-of-fold calls are ≥ target correct, with ≥ minN calls.
// Smallest confidence c (max(p,1−p) ≥ c) whose out-of-fold calls are ≥ target correct, with ≥ minN calls.
// direction 'regular' / 'shadow' only counts calls of that answer (Shadow calls fail differently:
// purple-bodied species and flames spilling over from the other side make false Shadows).
function threshold(ps,ys,{target=.95,minN=20,direction,videos}={}){const calls=ps.map((p,i)=>({c:Math.max(p,1-p),call:p>=.5,ok:(p>=.5)===!!ys[i],v:videos?.[i]})).filter(x=>!direction||x.call===(direction==='shadow')).sort((a,b)=>b.c-a.c);let best=null,right=0;
 for(let k=0;k<calls.length;k++){right+=calls[k].ok;const n=k+1;if(n>=minN&&right/n>=target&&(k+1===calls.length||calls[k+1].c<calls[k].c))best={confidence:calls[k].c,n,right,accuracy:right/n,lowerBound:wilson(right,n),...(videos?{videos:new Set(calls.slice(0,n).map(x=>x.v)).size}:{})};}return best;}
function wilson(right,total){if(!total)return 0;const z=1.96,p=right/total;return (p+z*z/(2*total)-z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total)))/(1+z*z/total);}
// Accuracy of calls at or above a fixed confidence.
function atConfidence(ps,ys,c){let n=0,right=0;ps.forEach((p,i)=>{if(Math.max(p,1-p)>=c){n++;right+=(p>=.5)===!!ys[i];}});return {confidence:c,n,right,accuracy:n?right/n:null,lowerBound:wilson(right,n)};}
// Fits the classifier on labelled rows and measures it honestly: leave-one-video-out predictions give
// accuracy/log-loss/calibration (old posterior vs classifier on the same rows) and the confidence at
// which out-of-fold calls reach `target` accuracy. Returns null when there is too little data.
function trainShadow(rows,{l2=Shadow.MODEL_L2,names=Shadow.MODEL_FEATURES,target=.95,minCalls=25,minRows=60,minVideos=8}={}){
 rows=rows.filter(r=>r?.x&&(r.y===0||r.y===1));const videos=new Set(rows.map(r=>r.video));if(rows.length<minRows||videos.size<minVideos)return null;
 const ys=rows.map(r=>r.y),vids=rows.map(r=>r.video),oof=crossValidate(rows,{l2,names}),old=rows.map(r=>Shadow.sigmoid(r.x.oldLogit));
 const round=m=>m&&Object.fromEntries(Object.entries(m).map(([k,v])=>[k,typeof v==='number'?+v.toFixed(4):v])),thr=d=>round(threshold(oof,ys,{target,minN:minCalls,direction:d,videos:vids}));
 const usesFocus=names.some(k=>FOCUS.includes(k)),oofNF=usesFocus?crossValidate(rows,{l2,names},noFocus):null,thrNF=d=>round(threshold(oofNF,ys,{target,minN:minCalls,direction:d,videos:vids}));
 return {...Shadow.fit(rows,{l2,names}),videos:videos.size,trainedAt:new Date().toISOString(),thresholds:{target,regular:thr('regular'),shadow:thr('shadow')},...(usesFocus?{thresholdsNoFocus:{target,regular:thrNF('regular'),shadow:thrNF('shadow')}}:{}),cv:{old:round(metrics(old,ys)),new:round(metrics(oof,ys)),calibration:calibration(oof,ys)}};}
// Honest check of the threshold rule itself: for each video, the thresholds are chosen on the other
// videos' out-of-fold predictions only, then applied to that video's rows.
function nestedThreshold(rows,opts={}){const vids=[...new Set(rows.map(r=>r.video))],out={regular:{n:0,right:0},shadow:{n:0,right:0}};
 for(const v of vids){const train=rows.filter(r=>r.video!==v),test=rows.filter(r=>r.video===v),oof=crossValidate(train,opts),m=Shadow.fit(train,opts);
  for(const d of ['regular','shadow']){const t=threshold(oof,train.map(r=>r.y),{target:opts.target||.95,minN:opts.minCalls||25,direction:d});if(!t)continue;
   for(const r of test){const p=Shadow.predict(r.x,m);if((p>=.5)===(d==='shadow')&&Math.max(p,1-p)>=t.confidence){out[d].n++;out[d].right+=(p>=.5)===!!r.y;}}}}
 for(const o of Object.values(out)){o.accuracy=o.n?o.right/o.n:null;o.lowerBound=wilson(o.right,o.n);}return out;}
module.exports={noFocus,FOCUS,trainShadow,nestedThreshold,metrics,auc,calibration,crossValidate,threshold,atConfidence,wilson};
if(require.main===module){const file=process.argv.find(a=>a.endsWith('.json'))||path.join(__dirname,'results/shadow-dataset.json'),diag=process.argv.includes('--diag');
 const d=JSON.parse(fs.readFileSync(file,'utf8')),rows=d.rows,ys=rows.map(r=>r.y),fmt=m=>`${m.right}/${m.n} (${(m.accuracy*100).toFixed(1)}%), log-loss ${m.logLoss.toFixed(3)}, Brier ${m.brier.toFixed(3)}, AUC ${m.auc?.toFixed(3)}`;
 const l2=Number(process.env.L2||Shadow.MODEL_L2),names=process.env.NAMES?process.env.NAMES.split(','):Shadow.MODEL_FEATURES,oof=crossValidate(rows,{l2,names});
 console.log(`rows ${rows.length}, videos ${new Set(rows.map(r=>r.video)).size}, Shadow ${ys.filter(Boolean).length}`);
 console.log('old (held-out priors): '+fmt(metrics(rows.map(r=>r.oldP),ys)));
 const asked=rows.filter(r=>r.askedTop!=null);console.log(`old (at question time): ${asked.filter(r=>r.askedTop===!!r.y).length}/${asked.length}`);
 console.log(`classifier (L2=${l2}): `+fmt(metrics(oof,ys)));
 // Splits: your Pokémon, opponents, and opponents that faced your Shadow (flames spill over) or not.
 const split=[['your Pokémon',r=>r.side==='my'],['opponents',r=>r.side==='opponent'],['opp. vs your Shadow',r=>r.side==='opponent'&&r.otherShadow===1],['opp. vs your regular',r=>r.side==='opponent'&&r.otherShadow===0],['with focus shots',r=>r.info?.focus>0],['no focus shots',r=>!(r.info?.focus>0)]];
 for(const [name,f] of split){const idx=rows.map((r,i)=>i).filter(i=>f(rows[i]));if(idx.length)console.log(`  ${name}: classifier `+fmt(metrics(idx.map(i=>oof[i]),idx.map(i=>ys[i])))+` | old ${idx.filter(i=>(rows[i].oldP>=.5)===!!ys[i]).length}/${idx.length}`);}
 console.log('calibration', JSON.stringify(calibration(oof,ys)));
 for(const d of ['regular','shadow'])console.log(`95% threshold, ${d} calls:`,JSON.stringify(threshold(oof,ys,{target:.95,minN:25,direction:d,videos:rows.map(r=>r.video)})));
 if(names.some(k=>FOCUS.includes(k))){const nf=crossValidate(rows,{l2,names},noFocus);console.log('focus features removed at prediction time: '+fmt(metrics(nf,ys)));for(const d of ['regular','shadow'])console.log(`  95% threshold without focus, ${d} calls:`,JSON.stringify(threshold(nf,ys,{target:.95,minN:25,direction:d,videos:rows.map(r=>r.video)})));}
 console.log('nested (threshold chosen without the test video):',JSON.stringify(nestedThreshold(rows,{l2,names})));
 if(process.argv.includes('--write-default')){const m=trainShadow(rows,{l2,names}),r=v=>Array.isArray(v)?v.map(r):typeof v==='number'?+v.toPrecision(5):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,r(x)])):v;
  const model=r({...m,version:'default',trainedAt:d.builtAt.slice(0,10),speciesPurple:d.speciesPurple}),file=path.join(__dirname,'../../includes/meta/shadow-model.js'),src=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,src.replace(/^const DEFAULT_MODEL=.*$/m,()=>'const DEFAULT_MODEL='+JSON.stringify(model)+';'));console.log(`DEFAULT_MODEL refitted on ${m.n} rows from ${m.videos} videos`);}
 if(diag){const groups=[['side',r=>r.side],['evidence',r=>r.info.inference?'fit':'no fit'],['aura',r=>r.info.aura?'aura':'no aura'],['measured',r=>(r.info.aura?'aura':'no aura')+(r.info.hits?'+hits':'+no hits')],['channel',r=>r.channel||'?']];
  for(const [name,f] of groups){const g=new Map();rows.forEach((r,i)=>{const k=f(r);if(!g.has(k))g.set(k,[]);g.get(k).push(i);});
   for(const [k,idx] of g)if(idx.length>=5)console.log(`${name}=${k}: n ${idx.length}, old ${idx.filter(i=>(rows[i].oldP>=.5)===!!ys[i]).length}, new ${idx.filter(i=>(oof[i]>=.5)===!!ys[i]).length}, shadow ${idx.filter(i=>ys[i]).length}`);}
  for(const k of Shadow.FEATURES)console.log(`AUC ${k}: ${auc(rows.map(r=>r.x[k]),ys)?.toFixed(3)}`);}
}
