#!/usr/bin/env node
// Cheap pre-screen before the full Meta Extractor pass (run-node.cjs). It decodes KEYFRAMES ONLY
// (`-skip_frame nokey`; YouTube uploads have one every ~2–6 s), so a 70-minute video takes a few
// CPU-seconds instead of minutes:
//   1. locate: up to 32 evenly spaced keyframes at 960 px → includes/meta/screen.js finds the phone
//      screen (same search as locate-screen.cjs), and a second phone of the same size when the
//      video shows two players' screens (championship broadcasts);
//   2. scan: every keyframe, cropped to that screen at half the reference width → is the battle HUD
//      on screen (both nameplates with Poké Balls; core.js readHud/calibrate)?
// Hits are grouped into time ranges, padded so whole battles are covered (start countdown before
// the first nameplate, result screen after the last). run-node.cjs then decodes only those ranges
// (RANGES=s-e,s-e) with CROP set to the located box.
//
// Usage: node probe.cjs VIDEO [OUT.json]   → {box, screens, dy, hits, samples, ranges, coverage, ...}
//   PROBE_PRE=30 PROBE_POST=45 PROBE_GAP=60   padding (s) and the largest gap merged inside one range
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const Screen=require('../../includes/meta/screen.js'),C=require('../../includes/meta/core.js');
const Scan=require('./hud-scan-plan.cjs');
const SCAN_W=443;          // half the 886-px reference width: HUD boxes stay ≥10 px
const LOCATE_FRAMES=32,LOCATE_W=960;
const num=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&process.env[k]!==''?v:d;};

function probeInfo(video){const out=execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=width,height:format=duration','-of','json',video]).toString();
 const j=JSON.parse(out),s=(j.streams||[])[0]||{};return {W:s.width,H:s.height,duration:Number(j.format?.duration)||0};}

// Streams raw RGBA frames of size w×h from ffmpeg; showinfo's pts_time lines give each frame's time.
function frames(args,w,h,onFrame,{requireTimes=false}={}){return new Promise((resolve,reject)=>{const size=w*h*4,buf=Buffer.alloc(size),times=[];let filled=0,n=0,err='';
 const ff=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
 ff.stderr.on('data',d=>{err+=d;let i;while((i=err.indexOf('\n'))>=0){const line=err.slice(0,i);err=err.slice(i+1);const m=/showinfo.*\bn:\s*(\d+).*\bpts_time:\s*([-\d.e]+)/.exec(line);if(m)times[Number(m[1])]=Number(m[2]);}});
 ff.stdout.on('data',chunk=>{let off=0;while(off<chunk.length){const k=Math.min(chunk.length-off,size-filled);chunk.copy(buf,filled,off,off+k);filled+=k;off+=k;if(filled===size){filled=0;onFrame({data:buf,width:w,height:h},n++);}}});
 ff.on('error',reject);ff.on('close',code=>{
  if(code!==0||filled||!n){reject(Error(`Incomplete keyframe stream (exit ${code}, ${filled} trailing bytes, ${n} frames)`));return;}
  if(requireTimes&&(times.length!==n||Array.from({length:n},(_,i)=>times[i]).some(t=>!Number.isFinite(t)))){reject(Error('Incomplete keyframe timestamps'));return;}
  resolve({count:n,times});});});}

const evenH=(w,W,H)=>Math.max(2,Math.round(H*w/W/2)*2);

// Pass 1: an evenly spaced reservoir of keyframes (stride doubles whenever it fills).
async function locateFrames(video,info){const w=Math.min(LOCATE_W,info.W),h=evenH(w,info.W,info.H),keep=[];let stride=1;
 await frames(['-v','error','-threads','1','-skip_frame','nokey','-i',video,'-an','-fps_mode','passthrough','-vf',`scale=${w}:${h}`,'-f','rawvideo','-pix_fmt','rgba','-'],w,h,(img,i)=>{
  if(i%stride)return;keep.push({data:new Uint8ClampedArray(img.data),width:w,height:h});if(keep.length>=LOCATE_FRAMES*2){for(let j=keep.length-1;j>=0;j--)if(j%2)keep.splice(j,1);stride*=2;}});
 return {frames:keep.filter((_,j)=>j%Math.max(1,Math.floor(keep.length/LOCATE_FRAMES))===0).slice(0,LOCATE_FRAMES),w,h,scale:info.W/w};}

// A second phone screen of the same size elsewhere in the frame (both players' screens side by side).
function secondScreen(frames,box,score){const w=box[2]-box[0],W=frames[0].width,step=Math.max(4,Math.round(w/8));let best=null;
 for(let x=0;x+w<=W;x+=step){const b=[x,box[1],x+w,box[3]];if(Math.max(0,Math.min(b[2],box[2])-Math.max(b[0],box[0]))>w*.3)continue;const s=Screen.hudScore(frames,b);
  if(s.ok>=Math.max(2,Math.ceil(score*.4))&&(!best||s.ok>best.score))best={box:b,score:s.ok,dy:s.dy};}
 return best;}

// Groups hit times into padded ranges. times: seconds of every scanned frame; hits: booleans.
function rangesFrom(times,hits,duration,{pre=30,post=45,gap=60}={}){const t=times.map((x,i)=>[x,hits[i]]).filter(([x,h])=>h&&Number.isFinite(x)).map(([x])=>x).sort((a,b)=>a-b);
 const out=[];for(const x of t){const last=out.at(-1);if(last&&x-last.last<=gap){last.last=x;last.n++;}else out.push({first:x,last:x,n:1});}
 const padded=out.map(r=>({start:Math.max(0,r.first-pre),end:duration?Math.min(duration,r.last+post):r.last+post,hits:r.n}));
 const merged=[];for(const r of padded){const last=merged.at(-1);if(last&&r.start<=last.end+5){last.end=Math.max(last.end,r.end);last.hits+=r.hits;}else merged.push({...r});}
 return merged.map(r=>({start:+r.start.toFixed(1),end:+r.end.toFixed(1),hits:r.hits}));}

function hudAt(img,dys){for(const dy of dys){const h=C.readHud(img,dy);if(h)return dy;}return null;}

async function probe(video,opts={}){const started=Date.now(),info=probeInfo(video),pre=opts.pre??num('PROBE_PRE',30),post=opts.post??num('PROBE_POST',45),gap=opts.gap??num('PROBE_GAP',60);
 const base={version:1,recording:path.basename(video),duration:info.duration,width:info.W,height:info.H,pre,post,gap};
 let L=await locateFrames(video,info),found=Screen.locate(L.frames),locateMethod='keyframes';
 // Keyframes cluster at scene cuts, so their edge statistics can miss a screen that frames at even
 // times show (UI1_o6sq6WQ): then the extractor's own search (16 seeks, locate-screen.cjs) decides.
 if(!found){const S=require('./locate-screen.cjs').sampleFrames(video,16,LOCATE_W),f2=Screen.locate(S.frames);if(f2){L={frames:S.frames,w:S.frames[0].width,h:S.frames[0].height,scale:S.scale};found=f2;locateMethod='seeks';}}
 if(!found)return {...base,box:null,screens:[],ranges:[],hits:0,samples:0,coverage:0,locateFrames:L.frames.length,reason:'phone screen / battle HUD not found in sampled keyframes',seconds:+((Date.now()-started)/1000).toFixed(1)};
 const toSrc=b=>{const s=b.map(v=>Math.round(v*L.scale));for(let i=0;i<4;i++)s[i]-=s[i]%2;return s;};
 const box=toSrc(found.box),second=secondScreen(L.frames,found.box,found.score),screens=[{box,score:found.score}];
 if(second)screens.push({box:toSrc(second.box),score:second.score});screens.sort((a,b)=>a.box[0]-b.box[0]);
 // Pass 2: every keyframe, cropped to the screen.
 const cw=box[2]-box[0],ch=box[3]-box[1],h=evenH(SCAN_W,cw,ch),scanH=Scan.hudScanHeight(SCAN_W,h,found.dy),hits=[],dys=[found.dy??0];let misses=0;
 const scan=await frames(['-v','info','-nostats','-hide_banner','-threads','1','-skip_frame','nokey','-i',video,'-an','-fps_mode','passthrough','-vf',`crop=${cw}:${ch}:${box[0]}:${box[1]},scale=${SCAN_W}:${h},crop=${SCAN_W}:${scanH}:0:0,showinfo`,'-f','rawvideo','-pix_fmt','rgba','-'],SCAN_W,scanH,(img,i)=>{
  // Known offsets first (±8 reference px around them); a full calibration on every 4th miss.
  let dy=hudAt(img,dys.flatMap(d=>[d,d-4,d+4,d-8,d+8]));
  if(dy===null&&(misses++%4===0)){const c=C.calibrate(img);if(c!==null){dy=c;if(!dys.includes(c)&&dys.length<6)dys.push(c);}}
  hits[i]=dy!==null;},{requireTimes:true});
 const times=scan.times.slice(0,scan.count);
 const gaps=times.slice(1).map((t,i)=>t-times[i]).filter(x=>x>0).sort((a,b)=>a-b),keyInterval=gaps.length?gaps[gaps.length>>1]:null;
 const ranges=rangesFrom(times,hits,info.duration,{pre,post,gap}),covered=ranges.reduce((a,r)=>a+r.end-r.start,0);
 return {...base,box,screens,dy:found.dy,locateScore:found.score,locateMethod,...(found.refined?{refined:found.refined}:{}),locateFrames:L.frames.length,scanHeight:scanH,scanFullHeight:h,scanBytes:scan.count*SCAN_W*scanH*4,scanMode:'hud-band-v1',samples:scan.count,keyInterval:keyInterval&&+keyInterval.toFixed(2),
  hits:hits.filter(Boolean).length,hitTimes:times.filter((_,i)=>hits[i]).map(t=>+t.toFixed(1)),ranges,coverage:info.duration?+(covered/info.duration).toFixed(3):0,seconds:+((Date.now()-started)/1000).toFixed(1)};}

// How run-node.cjs should be called for a probe: null = skip (no battle HUD), {} = whole video,
// {RANGES, CROP} = only these ranges. Long keyframe gaps make the scan too coarse to trust.
function plan(p,{fullAbove=.8,maxKeyInterval=12}={}){if(!p)return {};if(p.keyInterval&&p.keyInterval>maxKeyInterval)return {CROP:p.box?p.box.join(','):'auto'};
 if(!p.box||!p.ranges.length)return null;const crop=p.box.join(',');
 if(p.coverage>=fullAbove)return {CROP:crop};return {CROP:crop,RANGES:p.ranges.map(r=>`${r.start}-${r.end}`).join(',')};}

module.exports={probe,plan,rangesFrom,secondScreen,locateFrames,probeInfo,frames};
if(require.main===module){const [video,out]=process.argv.slice(2);if(!video){console.error('usage: node probe.cjs VIDEO [OUT.json]');process.exit(2);}
 probe(video).then(p=>{const s=JSON.stringify(p);if(out)fs.writeFileSync(out,s);console.log(`${p.recording}: ${p.hits}/${p.samples} keyframes with HUD, ${p.ranges.length} ranges, ${(p.coverage*100).toFixed(0)}% of ${(p.duration/60).toFixed(0)} min, screens ${p.screens.length}, ${p.seconds} s`);})
  .catch(e=>{console.error(e.message);process.exit(1);});}
