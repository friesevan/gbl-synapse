#!/usr/bin/env node
// Offline active-learning pass: human labels only; evaluate held-out videos before auto-resolution.
const fs=require('node:fs'),path=require('node:path'),Q=require('../../includes/meta/questions.js'),{refitRun,loadGameMaster}=require('./refit.cjs');
const eligible=a=>a&&a.value!==null&&a.value!==undefined&&a.source!=='model'&&!a.modelResolved;
const video=q=>q.video?.id||String(q.recording||'').replace(/\.mp4$/,'');
function learnedFor(answers,exclude){
 const selected=answers.filter(a=>eligible(a)&&(!exclude||video(a)!==exclude));
 const forms=selected.filter(a=>a.kind==='form');
 const corrected=selected.map(a=>{const f=forms.find(f=>video(f)===video(a)&&f.side===a.side&&f.key===a.key&&(f.allBattles||f.battle===a.battle));return f&&a.kind!=='form'?{...a,species:String(f.value).replace(/_shadow$/,'')}:a;});
 return Q.learnedFromAnswers([],new Map(corrected.map(a=>[a.qid,a])));
}
function mergeLearned(base,next){const out=structuredClone(base||{});for(const k of ['moves','shadow']){out[k]=out[k]||{};for(const [sp,counts]of Object.entries(next[k]||{})){out[k][sp]=out[k][sp]||{};for(const [v,n]of Object.entries(counts))out[k][sp][v]=(out[k][sp][v]||0)+n;}}for(const [f,n]of Object.entries(next.forms||{})){out.forms=out.forms||{};out.forms[f]=(out.forms[f]||0)+n;}out.purpleBodied={...(out.purpleBodied||{}),...(next.purpleBodied||{})};return out;}
function wilson(right,total){if(!total)return 0;const z=1.96,p=right/total;return (p+z*z/(2*total)-z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total)))/(1+z*z/total);}
function prediction(run,q){
 const b=run.full?.[q.battle];if(!b)return null;const m=b[q.side]?.find(p=>p.key===q.key),inf=m?.inference;if(!inf)return null;
 let dist;if(q.kind==='shadow')dist=[{value:true,p:inf.shadowP},{value:false,p:1-inf.shadowP}];else if(q.kind==='form')dist=inf.forms;else if(q.kind==='fastMove')dist=inf.moves;else return null;
 if(!dist?.length)return null;dist=[...dist].filter(x=>Number.isFinite(x.p)).sort((a,b)=>b.p-a.p);if(!dist.length)return null;
 const gs=(b.matchups||[]).filter(g=>g[q.side]===q.key),hits=gs.reduce((s,g)=>s+(q.side==='opponent'?g.hitsOnMy?.length||0:g.hitsOnOpp?.length||0),0);
 return {value:dist[0].value,p:dist[0].p,margin:dist[0].p-(dist[1]?.p||0),hits,matchups:inf.matchups||gs.length};
}
function canResolve(q,p,{answers,calibration,version}){
 if(!p||q.audit||!['shadow','form','fastMove'].includes(q.kind)||p.p<.98||p.margin<.9||p.hits<4)return null;
 const support=answers.filter(a=>eligible(a)&&a.kind===q.kind&&a.species===q.species&&video(a)!==video(q));
 if(support.length<8||new Set(support.map(video)).size<3)return null;
 const c=calibration[q.kind];if(!c||c.total<50||c.lowerBound<.9)return null;
 if(!q.options?.some(o=>o.value===p.value))return null;
 return {value:p.value,confidence:p.p,margin:p.margin,modelVersion:version,resolvedAt:new Date().toISOString(),reason:`Re-scored saved damage/cadence evidence; ${support.length} independent species labels; held-out ${q.kind} accuracy ${c.right}/${c.total} (95% lower bound ${(c.lowerBound*100).toFixed(1)}%).`,source:'model'};
}
function applyLeagueLabels(raw,answers,vid,cupCP={}){
 const run=structuredClone(raw);for(const a of answers.filter(a=>eligible(a)&&a.kind==='league'&&video(a)===vid)){
  const cp=cupCP[a.value];if(![500,1500,2500,10000].includes(Number(cp)))continue;
  if(a.allBattles)for(const b of run.full||[])b.leagueCP=Number(cp);else if(run.full?.[a.battle])run.full[a.battle].leagueCP=Number(cp);
 }return run;
}
function execute(input){
 const answers=input.answers.filter(eligible),newOnly=learnedFor(answers),learned=mergeLearned(input.baseline,newOnly),runs=new Map(),fitted=new Map(),calibration={},predictions={},resolutions={},errors=[],independentFits=new Map();
 const gmCache=new Map();const gmFor=r=>{const file=r.gamemaster||'';if(!gmCache.has(file))gmCache.set(file,loadGameMaster(file||undefined));return gmCache.get(file);};
 for(const r of input.runs||[]){try{const raw=JSON.parse(fs.readFileSync(r.path,'utf8'));if(!Array.isArray(raw.full))continue;runs.set(r.videoId,{r,raw});fitted.set(r.videoId,refitRun(applyLeagueLabels(raw,answers,r.videoId,input.cupCP),{learned,league:r.league||1500,gm:gmFor(r)}));}catch(e){errors.push({videoId:r.videoId,error:e.message});}}
 // One refit per labelled video with every label from that video omitted. No conditioning on labels.
 const heldout=new Map(),calibrationSeen=new Set();for(const a of [...answers].sort((a,b)=>a.qid.localeCompare(b.qid))){const vid=video(a),entry=runs.get(vid);if(!entry||!['shadow','form','fastMove'].includes(a.kind))continue;
  if(!heldout.has(vid)){try{heldout.set(vid,refitRun(entry.raw,{learned:learnedFor(answers,vid),league:entry.r.league||1500,gm:gmFor(entry.r)}));}catch(e){heldout.set(vid,null);}}
  const p=prediction(heldout.get(vid)||{},a);if(!p||p.p<.98||p.hits<4||p.margin<.9)continue;
  const unit=vid+':'+a.kind;if(calibrationSeen.has(unit))continue;calibrationSeen.add(unit);
  const c=calibration[a.kind]||(calibration[a.kind]={right:0,total:0,videos:[]});c.total++;if(p.value===a.value)c.right++;if(!c.videos.includes(vid))c.videos.push(vid);
 }
 for(const c of Object.values(calibration)){c.lowerBound=wilson(c.right,c.total);c.videoCount=c.videos.length;delete c.videos;if(c.videoCount<3)c.lowerBound=0;}
 const answered=new Set(answers.map(a=>a.qid));for(const q of input.questions||[]){const run=fitted.get(video(q));if(!run)continue;const p=prediction(run,q);if(!p)continue;predictions[q.qid]={modelTop:p.value,modelP:p.p};if(answered.has(q.qid)||input.manualReview?.[q.qid])continue;if(!canResolve(q,p,{answers,calibration,version:input.version}))continue;
 const entry=runs.get(video(q));if(!independentFits.has(video(q)))independentFits.set(video(q),refitRun(applyLeagueLabels(entry.raw,answers,video(q),input.cupCP),{learned:newOnly,league:entry.r.league||1500,gm:gmFor(entry.r)}));
 const independent=prediction(independentFits.get(video(q)),q);if(!independent||independent.value!==p.value||p.p<.98)continue;
 const resolution=canResolve(q,independent,{answers,calibration,version:input.version});if(resolution){resolution.liveConfidence=p.p;resolutions[q.qid]=resolution;}}
 if(input.outputDir){fs.mkdirSync(input.outputDir,{recursive:true});for(const [vid,run]of fitted)fs.writeFileSync(path.join(input.outputDir,vid+'.json'),JSON.stringify(run));}
 return {learned,predictions,resolutions,calibration,errors,runsRefit:fitted.size};
}
module.exports={execute,prediction,canResolve,learnedFor,mergeLearned,applyLeagueLabels,wilson};
if(require.main===module){const [src,dst]=process.argv.slice(2);fs.writeFileSync(dst,JSON.stringify(execute(JSON.parse(fs.readFileSync(src,'utf8')))));}
