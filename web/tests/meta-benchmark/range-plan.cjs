'use strict';
// Pure planning only: no file reads, decoding, downloads, or classifier state.
// Bounds are source timestamps. A caller must verify a cached probe's source/code
// identity before setting verified=true. An unverified or empty probe never skips
// footage. A caller-specified empty range list, however, is an intentional empty
// job, and remains distinct from null (no plan: decode the whole requested window).
function normalizeRanges(ranges){
 if(!Array.isArray(ranges))throw TypeError('Ranges must be an array');
 const copy=ranges.map(r=>{
  const pair=Array.isArray(r)?r:[r?.start,r?.end];
  if(pair.length!==2||!pair.every(Number.isFinite)||pair[0]<0||pair[1]<=pair[0])throw Error('Invalid source-time range');
  return [pair[0],pair[1]];
 }).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const merged=[];
 for(const r of copy){const last=merged.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else merged.push(r);}
 return merged;
}
function windowBounds(start=0,end=Infinity){
 if(!Number.isFinite(start)||start<0||!(Number.isFinite(end)||end===Infinity)||end<=start)throw Error('Invalid source-time window');
 return [start,end];
}
function clipRanges(ranges,start=0,end=Infinity){
 windowBounds(start,end);
 return normalizeRanges(ranges).map(([a,b])=>[Math.max(a,start),Math.min(b,end)]).filter(([a,b])=>b>a);
}
function planWindow({ranges=null,start=0,end=Infinity,forceFull=false}={}){
 windowBounds(start,end);
 // Reviewer requests always win, including when stale/invalid range metadata exists.
 if(forceFull||ranges===null)return {mode:'full',ranges:null,RANGES:'',start,end,seconds:Number.isFinite(end)?end-start:null};
 const clipped=clipRanges(ranges,start,end);
 return {mode:clipped.length?'ranges':'empty',ranges:clipped,RANGES:clipped.map(([a,b])=>`${a}-${b}`).join(','),start,end,
  seconds:clipped.reduce((n,[a,b])=>n+b-a,0)};
}
function probeWindow(probe,{verified=false,start=0,end=Infinity,forceFull=false,maxCoverage=.8,maxKeyInterval=12}={}){
 windowBounds(start,end);
 const full=reason=>({...planWindow({start,end}),CROP:'auto',reason});
 if(forceFull)return full('reviewer-full-pass');
 if(!verified)return full('unverified-probe');
 if(!probe||typeof probe!=='object')return full('missing-probe');
 const box=probe.box;
 if(!Array.isArray(box)||box.length!==4||!box.every(Number.isInteger)||box[0]<0||box[1]<0||box[2]<=box[0]||box[3]<=box[1])return full('invalid-screen-box');
 const crop=box.join(',');
 const croppedFull=reason=>({...planWindow({start,end}),CROP:crop,reason});
 // No-HUD observations may miss short battles/scene changes. Retests conservatively
 // retain the full pass; only nonempty verified ranges may skip unrelated footage.
 if(!Array.isArray(probe.ranges)||!probe.ranges.length)return croppedFull('no-confirmed-battle-ranges');
 if(!Number.isFinite(probe.keyInterval)||probe.keyInterval<=0||probe.keyInterval>maxKeyInterval)return croppedFull('coarse-probe');
 if(!Number.isFinite(probe.coverage)||probe.coverage<0||probe.coverage>1)return croppedFull('invalid-coverage');
 if(probe.coverage>=maxCoverage)return croppedFull('mostly-battle-footage');
 try{return {...planWindow({ranges:probe.ranges,start,end}),CROP:crop,reason:'verified-battle-ranges'};}
 catch{return croppedFull('invalid-probe-ranges');}
}
function parseRanges(text,{forceFull=false}={}){
 if(forceFull)return null;
 if(text===undefined||text===null||text==='')return null;
 if(typeof text!=='string')throw TypeError('Range input must be text');
 if(text.trim().startsWith('['))return normalizeRanges(JSON.parse(text));
 return normalizeRanges(text.split(',').map(r=>{
  const m=/^\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*$/.exec(r);
  if(!m)throw Error('Invalid source-time range input');return [Number(m[1]),Number(m[2])];
 }));
}
module.exports={normalizeRanges,clipRanges,planWindow,probeWindow,parseRanges};
