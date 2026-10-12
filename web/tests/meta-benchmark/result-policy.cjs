#!/usr/bin/env node
// Dry run of the timeline result rules (core.js inferResult) on a harvester work dir, read-only.
//   node result-policy.cjs [WORK_DIR]   (default ~/Desktop/Projects/PoGo Recorder/src/yt-harvest)
// Prints, from the saved results (no decoding) and feedback.json:
// - each rule's precision against results read from a result screen (the rule run as if none had been read) and
//   against reviewer answers;
// - what the next refit does with the open result questions (learning-loop.cjs resultResolution): settled by the
//   timeline, closed as unresolvable (policy), or still asked.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),C=require('../../includes/meta/core.js'),{resultResolution}=require('./learning-loop.cjs');
const WORK=process.argv[2]||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const fb=read(path.join(WORK,'feedback.json'))||{answers:{},resolutions:{},questions:{},manualReview:{}};
const video=q=>q.video?.id||String(q.recording||'').replace(/\.mp4$/,'');
const runs=new Map();for(const f of fs.readdirSync(path.join(WORK,'results'))){if(!/^[^.]+\.json$/.test(f))continue;const d=read(path.join(WORK,'results',f));if(Array.isArray(d?.full)&&d.full.length)runs.set(f.slice(0,-5),d);}
const human=new Map();for(const a of Object.values(fb.answers||{}))if(a?.kind==='result'&&a.value!=null&&a.source!=='model'&&!a.modelResolved)human.set(video(a)+':'+a.battle,a.value);
const precision={},add=(k,ok)=>{const p=precision[k]=precision[k]||{right:0,total:0};p.total++;if(ok)p.right++;},count={},inc=k=>count[k]=(count[k]||0)+1;
const derived=new Map();
for(const [vid,raw] of runs){const full=raw.full,end=C.runEnd(raw);
 full.forEach((b,i)=>{const r=C.inferResult({...b,result:'Unknown',resultSource:''},{next:full[i+1]?.start??null,videoEnd:end}),h=human.get(vid+':'+i),value=r?.result&&(r.ending==='you-forfeit'?'Loss:you-forfeit':r.result);
  if(b.resultSource==='result screen'){if(value)add(`${r.source} vs read result screens`,r.result===b.result);if(r?.source==='unresolvable')inc('read result screens the policy would have called unresolvable');}
  if(h){inc(`reviewer answers → ${r?r.source:'still asked'}`);if(value)add(`${r.source} vs reviewer answers`,value===h);}});
 const copy=structuredClone(raw);C.applyInferredResults(copy.full,{videoEnd:end});derived.set(vid,copy);}
const qs={};const vdir=path.join(WORK,'validation');for(const d of fs.existsSync(vdir)?fs.readdirSync(vdir):[]){const p=path.join(vdir,d);if(!fs.statSync(p).isDirectory())continue;for(const f of fs.readdirSync(p)){if(!f.endsWith('.json')||f==='manifest.json')continue;const q=read(path.join(p,f));if(q?.qid)qs[q.qid]=q;}}
Object.assign(qs,fb.questions||{});const open={};
for(const [qid,q] of Object.entries(qs)){if(q.kind!=='result')continue;const a=fb.answers?.[qid];if(a&&a.value!=null)continue;if(fb.resolutions?.[qid]||fb.manualReview?.[qid])continue;
 const run=derived.get(video(q)),r=run&&resultResolution({...q,options:q.options||require('../../includes/meta/questions.js').RESULT_OPTIONS},run,0);
 const k=!run?'no saved run':r?(r.source==='policy'?'closed as unresolvable (policy)':`settled by the timeline (${r.rule})`):run.full[q.battle]?.resultSource==='result screen'?'read in the saved run (stale question)':'still asked';open[k]=(open[k]||0)+1;}
console.log(JSON.stringify({precision,count,openResultQuestions:open},null,1));
