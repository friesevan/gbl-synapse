'use strict';
// Per-placement screen boxes (probe.cjs placements, README "Locating the phone screen"). Pure: no decoding.
// Edited compilations place each clip's phone a few pixels apart, and a box reads the HUD only within about 1% of
// its width, so the probe gives each placement its own box and stretches of the video:
//   CROPS="x0,y0,x1,y1@s-e,s-e;x0,y0,x1,y1@s-e"   (source pixels and seconds; every box the size of CROP)
// A time takes the box of the last stretch starting at or before it (the first stretch's box before them all), so
// the stretches only need to mark where the placement changes.
const Range=require('./range-plan.cjs');
function parseCrops(text,crop){
 if(text===undefined||text===null||text==='')return null;
 if(typeof text!=='string')throw TypeError('CROPS must be text');
 if(!Array.isArray(crop)||crop.length!==4)throw Error('CROPS needs an explicit CROP box (the main placement)');
 const out=text.split(';').map(part=>{const m=/^\s*(\d+),(\d+),(\d+),(\d+)@(.+)$/.exec(part);if(!m)throw Error('Invalid CROPS placement');
  const box=m.slice(1,5).map(Number);
  // One decoded frame size for the whole run: a placement is the same screen, moved.
  if(box[2]-box[0]!==crop[2]-crop[0]||box[3]-box[1]!==crop[3]-crop[1])throw Error('CROPS boxes must have the size of CROP');
  return {box,stretches:Range.parseRanges(m[5])};});
 const all=out.flatMap(p=>p.stretches).sort((a,b)=>a[0]-b[0]);
 for(let i=1;i<all.length;i++)if(all[i][0]<all[i-1][1])throw Error('CROPS stretches overlap');
 return out;
}
function formatCrops(placements){return placements.map(p=>p.box.join(',')+'@'+p.stretches.map(s=>Array.isArray(s)?`${s[0]}-${s[1]}`:`${s.start}-${s.end}`).join(',')).join(';');}
// Index of the placement at time t.
function indexAt(placements,t){let k=null,first=null,at=-Infinity;
 placements.forEach((p,i)=>{for(const [s] of p.stretches){if(first===null||s<first[0])first=[s,i];if(s<=t&&s>at){at=s;k=i;}}});
 return k??first?.[1]??null;}
function cropAt(placements,t,crop){if(!placements)return crop;const i=indexAt(placements,t);return i===null?crop:placements[i].box;}
// Decode pieces: each [start,end] (end null = to the end of the file) split where the placement changes, as
// [start,end,index]. Without placements: [start,end,null] per range, as before.
function pieces(ranges,placements){if(!placements)return ranges.map(([a,b])=>[a,b,null]);
 const starts=[...new Set(placements.flatMap(p=>p.stretches.map(([s])=>s)))].sort((a,b)=>a-b),out=[];
 for(const [a0,b] of ranges){let x=a0||0;const end=b??Infinity;
  for(const s of starts){if(s<=x)continue;if(s>=end)break;out.push([x,s,indexAt(placements,x)]);x=s;}
  out.push([x,b??null,indexAt(placements,x)]);}
 // A stretch boundary between two stretches of one placement needs no new decode.
 const merged=[];for(const p of out){const last=merged.at(-1);if(last&&last[2]===p[2]&&last[1]===p[0])last[1]=p[1];else merged.push([...p]);}
 return merged;
}
module.exports={parseCrops,formatCrops,pieces,cropAt,indexAt};
