#!/usr/bin/env node
// Dry run of the timeline result rules (core.js inferResult) on a harvester work dir, read-only.
//   node result-policy.cjs [WORK_DIR] [--before=PATH_TO_OLD_core.js]   (default ~/Desktop/Projects/PoGo Recorder/src/yt-harvest)
// Prints, from the saved results (no decoding) and feedback.json:
// - each rule's precision against results read from a result screen (the rule run as if none had been read) and
//   against reviewer answers;
// - the bucket (confident / asked by rule / asked without a guess / unresolvable) of every non-read battle and of the
//   owner's result answers under the current rules, and under --before (an older core.js) for comparison;
// - what the next refit does with the open result questions (learning-loop.cjs resultResolution): settled by the
//   timeline, closed as unresolvable (policy), or still asked.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),C=require('../../includes/meta/core.js'),{resultResolution}=require('./learning-loop.cjs');
const args=process.argv.slice(2),WORK=args.find(a=>!a.startsWith('--'))||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const fb=read(path.join(WORK,'feedback.json'))||{answers:{},resolutions:{},questions:{},manualReview:{}};
const video=q=>q.video?.id||String(q.recording||'').replace(/\.mp4$/,'');
const runs=new Map();for(const f of fs.readdirSync(path.join(WORK,'results'))){if(!/^[^.]+\.json$/.test(f))continue;const d=read(path.join(WORK,'results',f));if(Array.isArray(d?.full)&&d.full.length)runs.set(f.slice(0,-5),d);}
const human=new Map();for(const a of Object.values(fb.answers||{}))if(a?.kind==='result'&&a.value!=null&&a.source!=='model'&&!a.modelResolved)human.set(video(a)+':'+a.battle,a.value);
const Old=args.find(a=>a.startsWith('--before='))?require(path.resolve(args.find(a=>a.startsWith('--before=')).slice(9))):null;
const bucketOf=(core,b,next,end)=>{const r=core.inferResult({...b,result:'Unknown',resultSource:'',resultGuess:undefined},{next,videoEnd:end});return !r?'asked, no guess':r.source==='unresolvable'?'unresolvable':r.source==='guess'?`asked by rule: ${r.rule}`:`confident: ${r.source}`;};
const tally=(m,k)=>m[k]=(m[k]||0)+1;
const precision={},add=(k,ok)=>{const p=precision[k]=precision[k]||{right:0,total:0,videos:new Set()};p.total++;if(ok)p.right++;},count={};
const nonRead={now:{},before:{}},answersIn={now:{},before:{}},derived=new Map();
for(const [vid,raw] of runs){const full=raw.full,end=C.runEnd(raw);
 full.forEach((b,i)=>{if(b.resultSource==='result screen'||b.resultSource==='reviewer')return;const next=full[i+1]?.start??null,h=human.get(vid+':'+i);
  const now=bucketOf(C,b,next,end);tally(nonRead.now,now);if(Old)tally(nonRead.before,bucketOf(Old,b,next,end));
  if(h!=null){tally(answersIn.now,now);if(Old)tally(answersIn.before,bucketOf(Old,b,next,end));
   const r=C.inferResult({...b,result:'Unknown',resultSource:'',resultGuess:undefined},{next,videoEnd:end});
   if(r&&r.source!=='unresolvable'){const rule=r.source==='guess'?r.rule:r.source,val=r.source==='guess'?r.value:(r.ending?`${r.result}:${r.ending}`:r.result);add(`${rule} vs reviewer answers`,C.sameOutcome(val,h));precision[`${rule} vs reviewer answers`].videos.add(vid);}}});
 for(const [i,b] of full.entries()){if(b.resultSource!=='result screen')continue;const r=C.inferResult({...b,result:'Unknown',resultSource:'',resultGuess:undefined},{next:full[i+1]?.start??null,videoEnd:end});
  if(r&&r.source==='guess')add(`guess ${r.rule} vs read result screens`,r.value.split(':')[0]===b.result);else if(r&&r.source!=='unresolvable')add(`${r.source} vs read result screens`,r.result===b.result);}
 const copy=structuredClone(raw);C.applyInferredResults(copy.full,{videoEnd:end});derived.set(vid,copy);
 if(Old){const o=structuredClone(raw);Old.applyInferredResults(o.full,{videoEnd:end});derived.set('before:'+vid,o);}}
for(const [k,p] of Object.entries(precision)){if(/reviewer/.test(k))p.videos=p.videos.size;else delete p.videos;}
const qs={};const vdir=path.join(WORK,'validation');for(const d of fs.existsSync(vdir)?fs.readdirSync(vdir):[]){const p=path.join(vdir,d);if(!fs.statSync(p).isDirectory())continue;for(const f of fs.readdirSync(p)){if(!f.endsWith('.json')||f==='manifest.json')continue;const q=read(path.join(p,f));if(q?.qid)qs[q.qid]=q;}}
Object.assign(qs,fb.questions||{});
const openQ=(prefix)=>{const open={};
 for(const [qid,q] of Object.entries(qs)){if(q.kind!=='result')continue;const a=fb.answers?.[qid];if(a&&a.value!=null)continue;const cur=fb.resolutions?.[qid];if(fb.manualReview?.[qid]||(cur&&!['policy','timeline'].includes(cur.source)))continue;
  if(prefix==='before:'){const k=cur?(cur.source==='policy'?'closed as unresolvable (policy)':`settled by the timeline (${cur.rule})`):'asked';open[k]=(open[k]||0)+1;continue;}
  const run=derived.get(prefix+video(q)),r=run&&resultResolution({...q,options:q.options||require('../../includes/meta/questions.js').RESULT_OPTIONS},run,0),b=run?.full[q.battle];
  const k=!run?'no saved run':r?(r.source==='policy'?'closed as unresolvable (policy)':`settled by the timeline (${r.rule})`):b?.resultSource==='result screen'?'read in the saved run (stale question)':b?.resultGuess?`asked by rule: ${b.resultGuess.rule}`:'asked, no guess';open[k]=(open[k]||0)+1;}
 return open;};
const confusion={};for(const [vid,raw] of runs)raw.full.forEach((b,i)=>{const h=human.get(vid+':'+i);if(h==null||b.resultSource==='result screen'||b.resultSource==='reviewer')return;const r=C.inferResult({...b,result:'Unknown',resultSource:'',resultGuess:undefined},{next:raw.full[i+1]?.start??null,videoEnd:C.runEnd(raw)});if(r?.source==='guess'){const k=`${r.rule} guessed ${r.value}`;(confusion[k]=confusion[k]||{})[h]=(confusion[k][h]||0)+1;}});
const out={confusionOnOwnersAnswers:confusion,nonReadBattles:{now:nonRead.now},ownersAnswersByBucket:{now:answersIn.now},precisionOnOwnersAnswers_and_readScreens:precision,openResultQuestions:{now:openQ('')}};
if(Old){out.nonReadBattles.before=nonRead.before;out.ownersAnswersByBucket.before=answersIn.before;out.openResultQuestions.before=openQ('before:');}
console.log(JSON.stringify(out,null,1));
