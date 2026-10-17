#!/usr/bin/env node
// Backfills focus-shot Shadow measurements (MetaAura.focusMoments, README "Shadow classifier") for runs
// analysed before run-node.cjs recorded them. Each battle is decoded from 1 s before its start to 8 s
// after its end (as run-node's dense frames), with the run's own crop and the same 10 fps / 886-wide
// frames; shots are found with or without move banners.
// Writes WORK/focus/<id>.json ({version, battles:[moments per battle]}); results/ is never modified.
// shadow-dataset.cjs and learning-loop.cjs read these sidecars when a run has no b.focus of its own.
//   node focus-backfill.cjs [--force] [--shard K/N] [--video-dir DIR]... [ID ...]   (default: every labelled video found)
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,execFileSync}=require('node:child_process');
const Aura=require('../../includes/meta/aura.js'),Hp=require('../../includes/meta/hp.js'),Placement=require('./placement-plan.cjs');
const WORK=process.env.WORK||path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src/yt-harvest');
const SRC=path.join(os.homedir(),'Desktop/Projects/PoGo Recorder/src');
const VERSION=2,FPS=10;
const readJSON=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return d;}};
// Decodes [a,b] at FPS and calls onFrame({t,data,width,height}) for each frame.
function decode(video,a,b,crop,W,H,onFrame){return new Promise((resolve,reject)=>{const pre=crop?[`crop=${crop[2]-crop[0]}:${crop[3]-crop[1]}:${crop[0]}:${crop[1]}`,'scale=886:-2:flags=bicubic']:[];
 const ff=spawn('ffmpeg',['-v','error','-ss',String(a),'-t',String(b-a),'-i',video,'-vf',[`fps=${FPS}`,...pre].join(','),'-f','rawvideo','-pix_fmt','rgba','-'],{stdio:['ignore','pipe','inherit']});
 const fb=W*H*4,frame=Buffer.alloc(fb);let filled=0,k=0;
 ff.stdout.on('data',chunk=>{let off=0;while(off<chunk.length){const n=Math.min(chunk.length-off,fb-filled);chunk.copy(frame,filled,off,off+n);filled+=n;off+=n;if(filled<fb)break;filled=0;onFrame({t:a+k/FPS,data:frame,width:W,height:H});k++;}});
 ff.on('close',c=>c===0||k?resolve(k):reject(Error('ffmpeg exit '+c)));});}
// Focus moments for every battle of one saved run, measured from the video file.
async function measureRun(raw,video){const [W0,H0]=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height','-of','csv=p=0',video]).toString().trim().split(',').map(Number);
 const crop=raw.crop||null,W=crop?886:W0,H=crop?Math.round((crop[3]-crop[1])*886/(crop[2]-crop[0])/2)*2:H0,Y0=Math.round(450*W/886),Hh=Math.min(H-Y0,Math.round(900*W/886));
 const out=[];let frames=0;
 for(const b of raw.full||[]){const wins=Number.isFinite(b.start)&&Number.isFinite(b.end)?[[Math.max(0,b.start-1),b.end+8]]:[];
  // A run with placements (run-node CROPS) decodes each battle with the box of its start.
  const dense=[];for(const [a,z] of wins)frames+=await decode(video,a,z,Placement.cropAt(raw.placements,b.start,crop),W,H,img=>{const band={data:img.data.subarray(Y0*W*4,(Y0+Hh)*W*4),width:W,height:Hh},bars=Hp.findBars(band,Y0);
   dense.push({t:img.t,bars:bars.map(({x0,x1,y0,y1,fill,trail})=>({x0,x1,y0,y1,fill,trail})),focus:Aura.measureFocus(band,bars,Y0)});});
  out.push(Aura.focusMoments(b,dense,W));}
 return {version:VERSION,builtAt:new Date().toISOString(),frames,battles:out};}
function findVideo(id,dirs){for(const d of dirs){for(const ext of ['.mp4','.webm','.mkv']){const f=path.join(d,id+ext);if(fs.existsSync(f))return f;}}return null;}
// Attaches sidecar focus moments to a run's battles (when the run has none of its own).
function attach(run,id,work=WORK){if(!run?.full||run.full.some(b=>b.focus))return run;const s=readJSON(path.join(work,'focus',id+'.json'),null);if(!s?.battles||s.battles.length!==run.full.length)return run;
 run.full.forEach((b,i)=>{b.focus=s.battles[i];});return run;}
module.exports={measureRun,attach,findVideo,decode,VERSION};
if(require.main===module)(async()=>{const args=process.argv.slice(2),force=args.includes('--force'),dirs=[];for(let i=0;i<args.length;i++)if(args[i]==='--video-dir')dirs.push(args[++i]);
 dirs.push(path.join(SRC,'youtube'),path.join(SRC,'youtube-cc'),SRC);
 let ids=args.filter((a,i)=>!a.startsWith('--')&&!['--video-dir','--shard'].includes(args[i-1]));const shard=args.includes('--shard')?args[args.indexOf('--shard')+1].split('/').map(Number):null;
 if(!ids.length){const {humanAnswers,video}=require('./shadow-dataset.cjs');ids=[...new Set(humanAnswers(WORK).filter(a=>a.kind==='shadow').map(video))];}
 if(shard)ids=ids.filter((_,i)=>i%shard[1]===shard[0]);
 fs.mkdirSync(path.join(WORK,'focus'),{recursive:true});let done=0,skipped=0,missing=[];
 for(const id of ids){const out=path.join(WORK,'focus',id+'.json');if(!force&&readJSON(out,null)?.version===VERSION){skipped++;continue;}
  const raw=readJSON(path.join(WORK,'results',id+'.json'),null),video=findVideo(id,dirs);if(!raw?.full||!video){missing.push(id);continue;}
  const t=Date.now();try{const r=await measureRun(raw,video);fs.writeFileSync(out+'.tmp',JSON.stringify(r));fs.renameSync(out+'.tmp',out);done++;
   console.log(`${id}: ${r.battles.reduce((s,b)=>s+b.length,0)} focus moments, ${r.frames} frames, ${((Date.now()-t)/1000).toFixed(0)} s`);}catch(e){console.log(`${id}: ${e.message}`);}}
 console.log(`done ${done}, already ${skipped}, no video/results ${missing.length}${missing.length?': '+missing.slice(0,40).join(' '):''}`);})();
