#!/usr/bin/env node
// Offline active-learning pass: human labels only; evaluate held-out videos before auto-resolution.
const fs=require('node:fs'),path=require('node:path'),Q=require('../../includes/meta/questions.js'),{refitRun,loadGameMaster}=require('./refit.cjs'),D=require('./movefit-data.cjs'),T=require('./movefit-threshold.cjs');
const Shadow=require('../../includes/meta/shadow-model.js'),{trainShadow}=require('./shadow-cv.cjs');
// Fast moves and forms resolve at a confidence threshold chosen from video-grouped held-out predictions:
// the lowest posterior at which held-out answers are ≥ target correct (also at every higher threshold),
// with enough answers, videos and a Wilson 95% lower bound ≥ minLower. Shadow keeps its own gates below.
const MOVE_POLICY={target:.95,minTotal:30,minLower:.9,minVideos:5,minMargin:.8,floor:.9};
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
 const b=run.full?.[q.battle];if(!b)return null;const m=b[q.side]?.find(p=>p.key===q.key),inf=m?.inference,sp=inf?inf.shadowP:m?.shadowModel?.p;if(!inf&&!(q.kind==='shadow'&&Number.isFinite(sp)))return null;
 let dist;if(q.kind==='shadow')dist=[{value:true,p:sp},{value:false,p:1-sp}];else if(q.kind==='form')dist=inf.forms;else if(q.kind==='fastMove')dist=inf.moves;else return null;
 if(!dist?.length)return null;dist=[...dist].filter(x=>Number.isFinite(x.p)).sort((a,b)=>b.p-a.p);if(!dist.length)return null;
 const gs=(b.matchups||[]).filter(g=>g[q.side]===q.key),hits=gs.reduce((s,g)=>s+(q.side==='opponent'?g.hitsOnMy?.length||0:g.hitsOnOpp?.length||0),0);
 return {value:dist[0].value,p:dist[0].p,margin:dist[0].p-(dist[1]?.p||0),hits,matchups:inf?.matchups||gs.length};
}
// Shadow questions are resolved by the Shadow classifier (includes/meta/shadow-model.js) when its
// video-grouped out-of-fold calls in the same direction (Shadow / not Shadow) were ≥ 95% right at this
// confidence, over ≥ 25 calls from ≥ 5 videos with a 95% Wilson lower bound ≥ 0.80. Evidence for these
// gates (README "Shadow classifier"): the per-species/50-check gates never pass at this data volume,
// while the threshold rule chosen without the test video was 19/19 right on held-out videos.
const SHADOW_GATE={accuracy:.95,calls:25,lowerBound:.8,videos:5};
function shadowGate(model,value){const t=model?.thresholds?.[value?'shadow':'regular'];return t&&t.accuracy>=SHADOW_GATE.accuracy&&t.n>=SHADOW_GATE.calls&&t.lowerBound>=SHADOW_GATE.lowerBound&&(t.videos||0)>=SHADOW_GATE.videos?t:null;}
function canResolveShadow(q,p,{shadowModel,version}){if(!p||q.audit||q.kind!=='shadow')return null;const t=shadowGate(shadowModel,p.value);if(!t||p.p<t.confidence)return null;if(!q.options?.some(o=>o.value===p.value))return null;
 return {value:p.value,confidence:p.p,margin:p.margin,modelVersion:version,resolvedAt:new Date().toISOString(),reason:`Shadow classifier (aura, damage, species rates); held-out ${p.value?'Shadow':'not-Shadow'} calls at ≥${(t.confidence*100).toFixed(0)}% confidence were right ${t.right}/${t.n} on ${t.videos} videos (95% lower bound ${(t.lowerBound*100).toFixed(1)}%).`,source:'model'};}
function canResolveMove(q,p,{calibration,version}){const c=calibration[q.kind];if(!p||q.audit||!c?.threshold||c.lowerBound<MOVE_POLICY.minLower)return null;const t=Math.max(MOVE_POLICY.floor,c.threshold);
 if(p.p<t||p.margin<MOVE_POLICY.minMargin||!q.options?.some(o=>o.value===p.value))return null;
 return {value:p.value,confidence:p.p,margin:p.margin,modelVersion:version,resolvedAt:new Date().toISOString(),reason:`Re-scored saved damage/timing/energy/icon evidence; held-out ${q.kind} answers at p ≥ ${t}: ${c.right}/${c.total} right over ${c.videoCount} videos (95% lower bound ${(c.lowerBound*100).toFixed(1)}%).`,source:'model'};}
function canResolve(q,p,ctx){const {answers,calibration,version,shadowModel}=ctx;
 if(q?.kind==='shadow')return canResolveShadow(q,p,{shadowModel,version});
 if(['fastMove','form'].includes(q?.kind)&&calibration?.[q.kind]?.threshold!==undefined)return canResolveMove(q,p,ctx);
 if(!p||q.audit||!['shadow','form','fastMove'].includes(q.kind)||p.p<.98||p.margin<.9||p.hits<4)return null;
 const support=answers.filter(a=>eligible(a)&&a.kind===q.kind&&a.species===q.species&&video(a)!==video(q));
 if(support.length<8||new Set(support.map(video)).size<3)return null;
 const c=calibration[q.kind];if(!c||c.total<50||c.lowerBound<.9)return null;
 if(!q.options?.some(o=>o.value===p.value))return null;
 return {value:p.value,confidence:p.p,margin:p.margin,modelVersion:version,resolvedAt:new Date().toISOString(),reason:`Re-scored saved damage/cadence evidence; ${support.length} independent species labels; held-out ${q.kind} accuracy ${c.right}/${c.total} (95% lower bound ${(c.lowerBound*100).toFixed(1)}%).`,source:'model'};
}
// Archived human labels (labels/*.json `verified`) that feedback.json lacks: used only to train the
// Shadow classifier (their aggregates are already in baseline-learned.json, so never as priors).
function archivedLabels(input,answers){const dir=input.labelsDir||(input.runs?.[0]?.path?path.join(path.dirname(path.dirname(input.runs[0].path)),'labels'):null),seen=new Set(answers.map(a=>a.qid)),out=[];
 if(!dir||!fs.existsSync(dir))return out;for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){let v;try{v=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).verified||{};}catch{continue;}
  for(const a of Array.isArray(v)?v:Object.values(v))if(a?.qid&&a.kind==='shadow'&&typeof a.value==='boolean'&&!seen.has(a.qid)){seen.add(a.qid);out.push(a);}}return out;}
// Classifier rows from held-out refits: features of the labelled Pokémon, label, video.
function shadowRows(labels,runFor){const rows=[];for(const a of labels){if(a.kind!=='shadow'||typeof a.value!=='boolean')continue;const vid=video(a),run=runFor(vid);if(!run?.full)continue;
  const bs=a.side==='my'?run.full:[run.full[a.battle]].filter(Boolean),m=bs.map(b=>(b[a.side]||[]).find(p=>p.key===a.key)).find(p=>p?.shadowModel);if(m)rows.push({qid:a.qid,video:vid,x:m.shadowModel.x,y:a.value?1:0});}return rows;}
function applyLeagueLabels(raw,answers,vid,cupCP={}){
 const run=structuredClone(raw);for(const a of answers.filter(a=>eligible(a)&&a.kind==='league'&&video(a)===vid)){
  const cp=cupCP[a.value];if(![500,1500,2500,10000].includes(Number(cp)))continue;
  if(a.allBattles)for(const b of run.full||[])b.leagueCP=Number(cp);else if(run.full?.[a.battle])run.full[a.battle].leagueCP=Number(cp);
 }return run;
}
// Held-out fast-move/form predictions over every traceable human label (reviewer answers plus archived
// legacy labels in WORK/labels), each video refit with priors from the other videos only.
function moveCalibration(input,answers,runs,gmFor,errors){const kinds=['fastMove','form'],seen=new Set(answers.map(a=>a.qid)),labels=answers.filter(a=>kinds.includes(a.kind)).map(a=>({...a,video:video(a)}));
 const all=[...answers.map(a=>({...a,video:video(a)})),...(input.workDir?D.loadLabels(input.workDir).filter(l=>!seen.has(l.qid)):[])];for(const l of all)if(kinds.includes(l.kind)&&!seen.has(l.qid))labels.push(l);
 const rows=[],reg=D.registry();for(const vid of [...new Set(labels.map(l=>l.video))]){// Live runs carry feedback.py's league and dated game data; archived ones are re-read with their date's game data.
  const e=runs.get(vid);let raw=e?.live?e.raw:null,ctx=e?.live?e.r:null;
  if(!raw&&input.workDir){const c=D.runContext(vid,input.workDir,reg);if(c){raw=c.raw;ctx={league:c.league||1500,gamemaster:c.gamemaster,channel:c.channel};}}if(!raw&&e){raw=e.raw;ctx=e.r;}if(!raw)continue;
  const others=all.filter(l=>l.video!==vid),learned=Q.learnedFromAnswers([],new Map(others.map(l=>[l.qid,l])));learned.channels=D.channelLearned(others,v=>reg.get(v)?.channel);if(input.fit)learned.fit=input.fit;
  let run;try{run=refitRun(raw,{learned,league:ctx.league||1500,gm:gmFor(ctx),channel:ctx.channel});}catch(e){errors.push({videoId:vid,error:e.message});continue;}
  for(const l of labels.filter(l=>l.video===vid)){const p=prediction(run,l);if(!p)continue;const norm=v=>l.kind==='form'?String(v).replace(/_shadow$/,''):v;rows.push({kind:l.kind,video:vid,p:p.p,right:norm(p.value)===norm(l.value)});}}
 const out={};for(const kind of kinds){const rs=rows.filter(r=>r.kind===kind),{pick,sweep}=T.choose(rs,MOVE_POLICY.target),ok=pick&&pick.n>=MOVE_POLICY.minTotal&&pick.videos>=MOVE_POLICY.minVideos&&pick.lower>=MOVE_POLICY.minLower;
  out[kind]={heldOut:rs.length,heldOutRight:rs.filter(r=>r.right).length,threshold:ok?pick.t:null,sweep:sweep.map(x=>[x.t,x.right,x.n]),right:pick?.right||0,total:pick?.n||0,videoCount:pick?.videos||0,lowerBound:ok?pick.lower:0};}
 return out;}
function execute(input){
 const answers=input.answers.filter(eligible),newOnly=learnedFor(answers),learned=mergeLearned(input.baseline,newOnly);if(input.fitParams&&fs.existsSync(input.fitParams)){try{input.fit=JSON.parse(fs.readFileSync(input.fitParams,'utf8')).params;}catch{}}if(input.fit)learned.fit=input.fit;learned.channels=D.channelLearned(answers.map(a=>({...a,channel:a.video?.channel})));
 const runs=new Map(),fitted=new Map(),calibration={},predictions={},resolutions={},errors=[],independentFits=new Map();
 const gmCache=new Map();const gmFor=r=>{const file=r.gamemaster||'';if(!gmCache.has(file))gmCache.set(file,loadGameMaster(file||undefined));return gmCache.get(file);};
 for(const r of input.runs||[]){try{const raw=JSON.parse(fs.readFileSync(r.path,'utf8'));if(!Array.isArray(raw.full))continue;runs.set(r.videoId,{r,raw,live:true});}catch(e){errors.push({videoId:r.videoId,error:e.message});}}
 const archived=archivedLabels(input,answers),resultsDir=input.runs?.[0]?.path?path.dirname(input.runs[0].path):null;
 for(const vid of new Set(archived.map(video)))if(!runs.has(vid)&&resultsDir){const f=path.join(resultsDir,vid+'.json');try{const raw=JSON.parse(fs.readFileSync(f,'utf8'));if(Array.isArray(raw.full))runs.set(vid,{r:{videoId:vid,path:f,league:raw.learningContext?.league||1500,gamemaster:raw.learningContext?.gamemaster},raw});}catch{}}
 // One refit per labelled video with every label from that video omitted (and its footage left out of
 // the species purple baseline). No conditioning on labels; the Shadow classifier is not applied here.
 const heldout=new Map(),heldoutFor=vid=>{const entry=runs.get(vid);if(!entry)return null;if(!heldout.has(vid)){try{heldout.set(vid,refitRun(entry.raw,{learned:learnedFor(answers,vid),league:entry.r.league||1500,gm:gmFor(entry.r),shadowModel:false,speciesPurple:Shadow.speciesPurple([...runs].filter(([k])=>k!==vid).map(([,e])=>e.raw))}));}catch(e){heldout.set(vid,null);}}return heldout.get(vid);};
 const shadowModel=trainShadow(shadowRows([...answers,...archived],heldoutFor));
 if(shadowModel){shadowModel.version=input.version;shadowModel.speciesPurple=Shadow.speciesPurple([...runs.values()].map(e=>e.raw));learned.shadowModel=shadowModel;}
 for(const [vid,{r,raw,live}] of runs){if(!live)continue;try{fitted.set(vid,refitRun(applyLeagueLabels(raw,answers,vid,input.cupCP),{learned,league:r.league||1500,gm:gmFor(r),channel:r.channel}));}catch(e){errors.push({videoId:vid,error:e.message});}}
 const calibrationSeen=new Set();for(const a of [...answers].sort((a,b)=>a.qid.localeCompare(b.qid))){const vid=video(a);if(!runs.get(vid)?.live||!['form','fastMove'].includes(a.kind))continue;
  const p=prediction(heldoutFor(vid)||{},a);if(!p||p.p<.98||p.hits<4||p.margin<.9)continue;
  const unit=vid+':'+a.kind;if(calibrationSeen.has(unit))continue;calibrationSeen.add(unit);
  const c=calibration[a.kind]||(calibration[a.kind]={right:0,total:0,videos:[]});c.total++;if(p.value===a.value)c.right++;if(!c.videos.includes(vid))c.videos.push(vid);
 }
 for(const c of Object.values(calibration)){c.lowerBound=wilson(c.right,c.total);c.videoCount=c.videos.length;delete c.videos;if(c.videoCount<3)c.lowerBound=0;}
 Object.assign(calibration,moveCalibration(input,answers,runs,gmFor,errors));
 const st=shadowModel?.thresholds?.regular;calibration.shadow=st?{right:st.right,total:st.n,lowerBound:st.lowerBound,videoCount:st.videos,confidence:st.confidence,direction:'not Shadow',model:'classifier'}:{right:0,total:0,lowerBound:0,videoCount:0,model:shadowModel?'classifier':'default'};
 const answered=new Set(answers.map(a=>a.qid));for(const q of input.questions||[]){const run=fitted.get(video(q));if(!run)continue;const p=prediction(run,q);if(!p)continue;predictions[q.qid]={modelTop:p.value,modelP:p.p};if(answered.has(q.qid)||input.manualReview?.[q.qid])continue;if(!canResolve(q,p,{answers,calibration,version:input.version,shadowModel:learned.shadowModel}))continue;
 const entry=runs.get(video(q));if(!independentFits.has(video(q)))independentFits.set(video(q),refitRun(applyLeagueLabels(entry.raw,answers,video(q),input.cupCP),{learned:{...newOnly,shadowModel:learned.shadowModel,fit:input.fit},league:entry.r.league||1500,gm:gmFor(entry.r),channel:entry.r.channel}));
 const independent=prediction(independentFits.get(video(q)),q);if(!independent||independent.value!==p.value||(!['shadow','fastMove','form'].includes(q.kind)&&p.p<.98))continue;
 const resolution=canResolve(q,independent,{answers,calibration,version:input.version,shadowModel:learned.shadowModel});if(resolution){resolution.liveConfidence=p.p;resolutions[q.qid]=resolution;}}
 if(input.outputDir){fs.mkdirSync(input.outputDir,{recursive:true});for(const [vid,run]of fitted)fs.writeFileSync(path.join(input.outputDir,vid+'.json'),JSON.stringify(run));}
 return {learned,predictions,resolutions,calibration,errors,runsRefit:fitted.size,shadowModel:shadowModel&&{cv:shadowModel.cv,thresholds:shadowModel.thresholds,n:shadowModel.n,videos:shadowModel.videos}};
}
module.exports={execute,prediction,canResolve,canResolveShadow,shadowGate,shadowRows,archivedLabels,SHADOW_GATE,learnedFor,mergeLearned,applyLeagueLabels,wilson};
if(require.main===module){const [src,dst]=process.argv.slice(2);fs.writeFileSync(dst,JSON.stringify(execute(JSON.parse(fs.readFileSync(src,'utf8')))));}
