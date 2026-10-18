#!/usr/bin/env node
// Result-screen probe: what the seconds after each battle without a result actually show.
//   node result-probe.cjs [WORK_DIR] [--sample N] [--seed S] [--out file.json] [--slice i/n]
// Samples battles whose saved result is Unknown (videos still on disk, stratified by nameplate language), decodes
// [end − 2 s, end + 25 s] at 10 fps, applies core.js's result-band check on every frame (resultCandidate, sized by
// resultScale) plus a looser band (40–260 reference px), OCRs the most text-like frames with the pipeline's own
// preprocessing (white text, two lines; the CJK model for Chinese videos) and sorts each battle into:
//   readable result   a result screen the saved analysis missed (the regression case for run-node's result check)
//   cut               the next battle starts within 12 s and no result screen shows (the evidence model's case)
//   video ends / nothing found / unreadable band
// 2026-10-18, 132 battles, before the every-frame check: 32 readable (26 by the strict band on every frame, 6 only
// by the looser band), the rest cut endings; every readable result that the Poké Ball counts could check agreed.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');
const C=require('../../includes/meta/core.js'),Dialog=require('./surrender-cache.cjs');
const args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const WORK=args.find(a=>!a.startsWith('--')&&!/^\d+$/.test(a))||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const N=Number(opt('sample',120)),SEED=Number(opt('seed',11)),OUT=opt('out',null);
const TESSDATA=process.env.TESSDATA_LOCALES||path.join(os.homedir(),'.cache/gbl-synapse/tessdata');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'result-probe-'));
let seed=SEED;const rand=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;

function videos(){const db=path.join(WORK,'state.sqlite');const rows=execFileSync('sqlite3',['-json',db,"SELECT id, dl_path FROM videos WHERE dl_status='done' AND deleted_date IS NULL"],{maxBuffer:1<<28}).toString();
 return new Map((rows.trim()?JSON.parse(rows):[]).filter(r=>r.dl_path&&fs.existsSync(r.dl_path)).map(r=>[r.id,r.dl_path]));}
function items(){const disk=videos(),out=[];for(const f of fs.readdirSync(path.join(WORK,'results'))){if(!/^[^.]+\.json$/.test(f))continue;const vid=f.slice(0,-5);if(!disk.has(vid))continue;
  let r;try{r=JSON.parse(fs.readFileSync(path.join(WORK,'results',f),'utf8'));}catch{continue;}
  let crop=(r.media||{}).crop;if(!crop||crop==='auto')crop=Array.isArray(r.crop)&&r.crop.length===4?r.crop.join(','):'';if(!crop)continue;
  const bs=r.battles||[];bs.forEach((b,i)=>{if((b.result||'Unknown')!=='Unknown')return;const next=bs[i+1]?.start;
   out.push({vid,path:disk.get(vid),crop,end:b.end,lang:r.nameLanguage||'en',gap:next!=null?next-b.end:null,toEnd:r.videoSeconds?r.videoSeconds-b.end:null,fainted:b.fainted});});}
 return out;}
function probe(it){const [x0,y0,x1,y1]=it.crop.split(',').map(Number),W=886,H=Math.round((y1-y0)*W/(x1-x0)/2)*2,s=Math.max(0,it.end-2);
 const raw=spawnSync('ffmpeg',['-v','error','-ss',String(s),'-t','27','-i',it.path,'-vf',`fps=10,crop=${x1-x0}:${y1-y0}:${x0}:${y0},scale=${W}:${H}`,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:2**31}).stdout||Buffer.alloc(0);
 const fsz=W*H*4,b0=Math.round(H*700/1920),b1=Math.round(H*1180/1920),scale=C.resultScale(W,H),strict=[],loose=[];
 for(let k=0;(k+1)*fsz<=raw.length;k++){const f=raw.subarray(k*fsz,(k+1)*fsz),st=C.bandStats({data:f.subarray(b0*W*4,b1*W*4),width:W,height:b1-b0},{scale});
  if(C.resultCandidate(st))strict.push([s+k/10,k,st]);else if(st.white>=.005&&st.whiteRun>=40&&st.whiteRun<=260)loose.push([s+k/10,k,st]);}
 const input=path.join(tmp,`band-${process.pid}-${Math.round(it.end*10)}.pgm`);
 const ocr=(k,model)=>{fs.writeFileSync(input,Dialog.grayscalePgm({data:raw.subarray(k*fsz,(k+1)*fsz),width:W,height:H},[0,b0,W,b1],{whiteText:true}));
  try{return execFileSync('tesseract',[input,'-','--psm','6',...(model?['-l',model,'--tessdata-dir',TESSDATA]:[])],{stdio:['ignore','pipe','ignore']}).toString().replace(/\s+/g,' ').trim();}catch{return '';}};
 const pick=(arr,n)=>{const score=([,,st])=>(st.whiteRun>=50&&st.whiteRun<=130?10:0)+Math.min(st.white,.2)*20,out=[];for(const c of [...arr].sort((a,b)=>score(b)-score(a))){if(out.every(o=>Math.abs(o[0]-c[0])>=.3))out.push(c);if(out.length>=n)break;}return out;};
 for(const [label,arr] of [['strict',strict],['loose',loose]])for(const [t,k] of pick(arr,10)){let text=ocr(k),value=C.outcome(text);
  if(!value&&it.lang.startsWith('zh')){const t2=ocr(k,it.lang==='zh-Hans'?'chi_sim':'chi_tra');value=C.outcome(t2);text+=' / '+t2;}
  if(value)return {strict:strict.length,loose:loose.length,read:{t:+t.toFixed(1),value,via:label,text:text.slice(0,40)}};}
 return {strict:strict.length,loose:loose.length,read:null};}
function category(o){if(o.read)return o.read.via==='strict'?'readable result (current band check)':'readable result (looser band only)';
 if(o.gap!=null&&o.gap<12)return 'cut: next battle within 12 s';if(o.toEnd!=null&&o.toEnd<12)return 'video ends';return o.strict||o.loose?'unreadable band':'nothing found';}

const all=items(),byLang=new Map();for(const it of all){if(!byLang.has(it.lang))byLang.set(it.lang,[]);byLang.get(it.lang).push(it);}
const sample=[];for(const [,arr] of byLang){for(let i=arr.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}sample.push(...arr.slice(0,Math.max(4,Math.round(N*arr.length/all.length))));}
console.log(`${all.length} unknown battles on disk; probing ${sample.length}`);
const results=[];let next=0;const worker=()=>{while(next<sample.length){const it=sample[next++];results.push({...it,path:undefined,...probe(it)});}};
// --slice i/n probes every n-th sampled battle from i (run n processes by hand to use more cores).
if(opt('slice',null)){const [a,b]=opt('slice').split('/').map(Number);sample.splice(0,sample.length,...sample.filter((_,i)=>i%b===a));}
worker();
const tally={},byLanguage={};for(const o of results){const c=category(o);tally[c]=(tally[c]||0)+1;(byLanguage[o.lang]=byLanguage[o.lang]||{})[c]=(byLanguage[o.lang][c]||0)+1;
 if(o.read){const f=o.fainted||{},lean=(f.opponent||0)>(f.my||0)?'Win':(f.my||0)>(f.opponent||0)?'Loss':null;o.agreesWithCounters=lean?lean===o.read.value:null;}}
console.log(JSON.stringify({tally,byLanguage},null,1));
const checked=results.filter(o=>o.agreesWithCounters!=null);console.log(`readable results checkable by the counters: ${checked.filter(o=>o.agreesWithCounters).length} of ${checked.length} agree`);
if(OUT)fs.writeFileSync(OUT,JSON.stringify(results,null,1));
fs.rmSync(tmp,{recursive:true,force:true});
