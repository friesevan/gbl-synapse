// HP bars for the Meta Extractor. Each active Pokémon has a white-outlined bar (253 px wide at an
// 886 px wide frame); a fast-move hit shrinks the fill and shows the lost HP as an orange trail
// that drains over ~0.5 s. The trail's jump is a clean measure of one hit's damage.
(function(root){
'use strict';
const REF_W=886,FILL_W=246;
// Pixel classes inside a bar: 1 = HP fill, which is one of three colours (teal above half HP, yellow,
// red when low); 2 = the orange damage trail.
const FILLS=[[30,254,194],[255,253,120],[239,102,106]];
// Fast reject first: every fill colour has green > 184 or red > 169 within the 70 tolerance, and the
// trail needs red > 200, so most scenery pixels are rejected after two comparisons.
function cls(d,i){const r=d[i],g=d[i+1];if(g<=183&&r<=169)return 0;const b=d[i+2];if(r>200&&g>115&&g<195&&b<50)return 2;for(const f of FILLS)if(Math.abs(r-f[0])+Math.abs(g-f[1])+Math.abs(b-f[2])<70)return 1;return 0;}
// HP bars are found from their fill: a solid rectangle 9–18 rows tall whose left and right edges are
// straight. (The white outline is thin and semi-transparent, and bars bob with flying Pokémon.)
// img: {data RGBA, width, height}; yOffset: frame y of row 0. Returns bars left to right with
// fill and trail as fractions of the full bar width.
function findBars(img,yOffset=0){const s=img.width/REF_W,w=img.width,h=img.height,d=img.data,rows=[],minRun=6*s,maxRun=FILL_W*s*1.04;
 // Speed: bars are at least 9 rows tall, so a coarse pass over every 3rd row (every 2nd pixel) finds
 // the rows worth scanning; only rows within 3 of a coarse hit are scanned in full. Same output as a
 // full scan, ~6–10× less work on typical frames.
 const want=new Uint8Array(h);for(let y=0;y<h;y+=3){let run=0,hit=false;for(let x=0;x<w;x+=2){if(cls(d,(y*w+x)*4)){if(++run*2>=minRun){hit=true;break;}}else run=0;}if(hit)for(let k=Math.max(0,y-3);k<=Math.min(h-1,y+3);k++)want[k]=1;}
 for(let y=0;y<h;y++){if(!want[y])continue;let x=0;while(x<w){const c=cls(d,(y*w+x)*4);if(!c){x++;continue;}const x0=x;let fillEnd=x0,end=x0;
   while(x<w){const k=cls(d,(y*w+x)*4);if(!k)break;if(k===1&&end===fillEnd)fillEnd=x+1;end=x+1;x++;}
   if(end-x0>=minRun&&end-x0<=maxRun)rows.push({y,x0,fillEnd,end});}}
 const blobs=[];for(const r of rows){const b=blobs.find(b=>b.last===r.y-1&&Math.abs(b.x0-r.x0)<=2*s&&Math.abs(b.ends.at(-1)-r.end)<=3*s);if(b){b.last=r.y;b.ends.push(r.end);b.fills.push(r.fillEnd);}else blobs.push({x0:r.x0,first:r.y,last:r.y,ends:[r.end],fills:[r.fillEnd]});}
 const med=a=>[...a].sort((p,q)=>p-q)[a.length>>1];
 return blobs.filter(b=>{const bh=b.last-b.first+1;return bh>=9*s&&bh<=18*s;}).map(b=>{const end=med(b.ends),fe=med(b.fills);return {x0:b.x0,y0:b.first+yOffset,x1:b.x0+Math.round(FILL_W*s),y1:b.last+yOffset,fill:(fe-b.x0)/(FILL_W*s),trail:(end-fe)/(FILL_W*s)};}).sort((a,b)=>a.x0-b.x0);}
// Kept for callers that measure a known bar: the values come from findBars.
const measureBar=(img,bar)=>({fill:bar.fill,trail:bar.trail});
// Your bar starts near the left edge (x ≈ 50 of 886); the opponent's starts mid-screen (x ≈ 300–500).
// Bench tiles and buttons carry small bars elsewhere and are ignored.
function assignBars(bars,width){const s=width/REF_W,pick=list=>list.sort((a,b)=>(b.y1-b.y0)-(a.y1-a.y0)||b.fill-a.fill)[0]||null;
 return {my:pick(bars.filter(b=>b.x0>=30*s&&b.x0<=80*s)),opponent:pick(bars.filter(b=>b.x0>=230*s&&b.x0<=600*s))};}
// series: [{t, fill, trail}] for one side (null when the bar is hidden; bars often vanish for a frame
// as a hit lands). HP never rises during a matchup, so the bar is read as a descending staircase:
// upward readings (attack glow sweeping over the bar) are ignored, and a step down counts once two
// consecutive readings confirm it. A hit's size is the difference between plateau levels.
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
function hits(series,{minDrop=.015,maxHit=.35,confirmWithin=.6,chargedGap=1.2}={}){const valid=series.filter(Boolean);if(valid.length<3)return [];
 const out=[];let level=median(valid.slice(0,3).map(v=>v.fill)),pending=[],lastTrail=median(valid.slice(0,3).map(v=>v.trail)),prevT=valid[0].t,gapBefore=0;
 for(const s of valid){const gap=s.t-prevT;prevT=s.t;
  // A drop starts a new candidate step; stale candidates (no confirming reading in time) are dropped
  // first, so the gap that decides "charged" is the one just before this step's first reading.
  if(s.fill<level-minDrop){pending=pending.filter(p=>s.t-p.t<=confirmWithin);if(!pending.length)gapBefore=gap;pending.push(s);
   if(pending.length>=2){const next=median(pending.slice(0,3).map(p=>p.fill)),stair=level-next,trail=median(pending.slice(0,3).map(p=>p.trail));
    // A fresh trail (none left over from the previous hit) measures the hit exactly, but only when it is
    // actually visible: compressed video can wash the orange out, leaving the step itself as the measure.
    const size=lastTrail<.008&&trail>=minDrop&&Math.abs(trail-stair)<.02?trail:stair;
    // Damage that appears after the bars were hidden for a while is a charged attack, not a fast move.
    if(size<=maxHit)out.push({t:pending[0].t,size,fillBefore:level,charged:gapBefore>chargedGap});level=next;pending=[];}}
  else{if(Math.abs(s.fill-level)<=.008)pending=[];lastTrail=s.trail;}}
 return out.filter(h=>!h.charged);}
// Damage of one charged attack fired at time t (its banner): the bar's last steady reading before the
// cutscene hid it, minus its first steady reading after. null when either side is missing, the change is
// tiny, or the bar ends empty (a knockout only shows a lower bound). Callers skip shielded attacks.
function chargedDamage(series,t,{look=12}={}){const before=series.filter(p=>p&&p.t<t&&p.t>t-look),after=series.filter(p=>p&&p.t>t&&p.t<t+look);if(before.length<2||after.length<3)return null;
 // The bar can reappear for a moment at the old level before the damage lands, and single glitch
 // frames occur: the new level is the first run of three readings below the old one that agree.
 const b=median(before.slice(-3).map(p=>p.fill));for(let i=0;i+2<after.length;i++){const run=after.slice(i,i+3).map(p=>p.fill);if(Math.max(...run)<b-.02&&Math.max(...run)-Math.min(...run)<=.02){const a=median(run),d=b-a;return a>.01?d:null;}}return null;}
// "SUPER EFFECTIVE!" / "NOT VERY EFFECTIVE…" appears just above the HP bar of the Pokémon that was hit,
// left-aligned with the bar. effectBox gives that strip in frame pixels; effectSig fingerprints its white
// letters (96×12) so each distinct appearance is read once.
function effectBox(bar,width){const s=width/REF_W;return [Math.max(0,Math.round(bar.x0-6*s)),Math.round(bar.y0-50*s),Math.min(width,Math.round(bar.x0+320*s)),Math.round(bar.y0-3*s)];}
function effectSig(img,box,yOffset=0){const [x0,y0,x1,y1]=box,sig=new Uint8Array(96*12),d=img.data;let n=0;
 for(let r=0;r<12;r++)for(let c=0;c<96;c++){const x=Math.floor(x0+(c+.5)*(x1-x0)/96),y=Math.floor(y0+(r+.5)*(y1-y0)/12)-yOffset;if(y<0||y>=img.height||x<0||x>=img.width)continue;const i=(y*img.width+x)*4;if(Math.min(d[i],d[i+1],d[i+2])>215){sig[r*96+c]=1;n++;}}
 return {sig,share:n/sig.length};}
// The words sit in the strip's top five rows (of 12), with ink in every one of rows 1–4; arena glare,
// the bar's own edge and move effects light the lower rows instead. Only text-shaped strips are read.
function effectShape(sig){const row=r=>{let n=0;for(let c=0;c<96;c++)n+=sig[r*96+c];return n;};let top=0;for(let r=0;r<6;r++)top+=row(r);for(let r=1;r<5;r++)if(row(r)<8)return false;return top>=50;}
// OCR text → 'super' | 'notVery' | null (tolerates a misread letter or two).
const effectKind=text=>{const t=String(text).toLowerCase().replace(/[^a-z ]/g,'');return /\bnot\b|v[ae]ry\s*eff/.test(t)&&/eff|v[ae]ry/.test(t)?'notVery':/sup[ae]r|eff[ei]ct/.test(t)?'super':null;};
// HP of every Pokémon in a battle at every turn (fraction of max HP, step 0.5 s), from the HP-bar series
// of all its matchups (b.matchups[].series: {t0, fps, my:[], opponent:[]}). Readings are smoothed
// (median of 5, dropping glitch frames) and never rise (HP never goes up in PvP). Before its first
// appearance a Pokémon is null; from entry to its first reading it is full; between readings (benched,
// cutscenes) the last value holds; after it faints it is 0. Faints are credited to the Pokémon on the
// field for that side at the time (segments / "Go" banners).
function hpTimeline(b,{step=.5}={}){const t0=b.start,n=Math.max(1,Math.ceil((b.end-t0)/step)+1),out={t0,step,turns:n,my:{},opponent:{}},evs=b.events||[];
 for(const side of ['my','opponent']){
  const changes=[...(b.segments||[]).map(g=>[g.start,g[side]]),...evs.filter(e=>e.kind==='go'&&(b[side]||[]).some(p=>p.key===e.actor)).map(e=>[e.t,e.actor])].filter(c=>c[1]).sort((x,y)=>x[0]-y[0]);
  const activeAt=t=>{let k=null;for(const [ct,key] of changes){if(ct>t)break;k=key;}return k;};
  const faintOf=new Map();for(const e of evs.filter(e=>e.kind==='faint'&&e.side===side)){const k=activeAt(e.t);if(k&&!faintOf.has(k))faintOf.set(k,e.t);}
  for(const p of b[side]||[]){const pts=[];for(const g of b.matchups||[]){if(g[side]!==p.key||!g.series)continue;const s=g.series;(s[side]||[]).forEach((f,i)=>{if(f!=null)pts.push([s.ts?s.ts[i]:s.t0+i/s.fps,f]);});}
   pts.sort((x,y)=>x[0]-y[0]);const med=pts.map((q,i)=>[q[0],median(pts.slice(Math.max(0,i-2),i+3).map(r=>r[1]))]);
   // Best non-increasing fit (pool-adjacent-violators): a stray low reading is averaged with the later,
   // higher ones instead of becoming a floor, as a running minimum would make it.
   const blocks=[];for(const [t,v] of med){blocks.push({v,w:1,ts:[t]});while(blocks.length>1&&blocks.at(-2).v<blocks.at(-1).v){const b2=blocks.pop(),b1=blocks.pop();blocks.push({v:(b1.v*b1.w+b2.v*b2.w)/(b1.w+b2.w),w:b1.w+b2.w,ts:[...b1.ts,...b2.ts]});}}
   const sm=blocks.flatMap(bl=>bl.ts.map(t=>[t,bl.v]));
   const entry=Math.min(p.first??Infinity,...changes.filter(c=>c[1]===p.key).map(c=>c[0])),dead=faintOf.get(p.key)??Infinity,series=[];let j=0,cur=1;
   for(let k=0;k<n;k++){const t=t0+k*step;if(t<entry-step){series.push(null);continue;}if(t>=dead){series.push(0);continue;}while(j<sm.length&&sm[j][0]<=t){cur=Math.min(cur,sm[j][1]);j++;}series.push(+Math.max(0,Math.min(1,cur)).toFixed(3));}
   out[side][p.key]=series;}}
 return out;}
// Typical spacing of consecutive hits in 0.5 s turns: the most common gap (ties → shorter).
function cadence(list){const gaps=[];for(let i=1;i<list.length;i++){const g=list[i].t-list[i-1].t;if(g>.3&&g<3.2)gaps.push(Math.round(g/.5));}if(!gaps.length)return null;const counts=new Map();for(const g of gaps)counts.set(g,(counts.get(g)||0)+1);
 const [turns,repeats]=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0];return {turns,repeats,gaps};}
// Follows each side's bar through a window of frames: the real bar keeps the same left edge, while
// effects and scenery that happen to match come and go. frames: [{t, bars}] from findBars.
function track(frames,width){const s=width/REF_W,out={my:[],opponent:[]};
 for(const [side,lo,hi] of [['my',30,80],['opponent',230,600]]){const xs=new Map();for(const f of frames)for(const b of f.bars)if(b.x0>=lo*s&&b.x0<=hi*s){const k=Math.round(b.x0/(3*s));xs.set(k,(xs.get(k)||0)+1);}
  if(!xs.size){out[side]=frames.map(()=>null);continue;}const best=[...xs].sort((a,b)=>b[1]-a[1])[0][0]*3*s;let lastY=null;
  out[side]=frames.map(f=>{const c=f.bars.filter(b=>Math.abs(b.x0-best)<=4*s).sort((a,b)=>(lastY===null?0:Math.abs(a.y0-lastY)-Math.abs(b.y0-lastY))||(b.y1-b.y0)-(a.y1-a.y0));const b=c[0];if(!b)return null;lastY=b.y0;return {t:f.t,fill:b.fill,trail:b.trail};});}
 return out;}
const api={hpTimeline,findBars,measureBar,assignBars,track,hits,cadence,chargedDamage,effectBox,effectSig,effectShape,effectKind};if(typeof module!=='undefined')module.exports=api;root.MetaHp=api;
})(typeof window==='undefined'?globalThis:window);
