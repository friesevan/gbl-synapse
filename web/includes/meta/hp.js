// HP bars for the Meta Extractor. Each active Pokémon has a white-outlined bar (253 px wide at an
// 886 px wide frame); a fast-move hit shrinks the fill and shows the lost HP as an orange trail
// that drains over ~0.5 s. The trail's jump is a clean measure of one hit's damage.
(function(root){
'use strict';
const REF_W=886,FILL_W=246;
// Detector settings (2026-10-11, tuned on YouTube crops and the owner's recordings; README "HP bars on
// YouTube footage"). Fill and trail are hue windows, not RGB distances: YouTube re-encodes shift the
// teal fill from (30,254,194) to about (0,228,172), which the old distance-70 test rejected.
const BAR={vMin:.7,sMin:.38,teal:[148,186],yellow:[47,72],red:[344,12],trail:[20,46],trailS:.6,
 minRun:6,gapPx:3,linkX:2,spanX:4,hMin:9,hMax:18,lineC:15,frameMin:.5,sides:{my:[30,80],opponent:[230,600]}};
// Rows (reference px) searched for bars. Bars sit above the Pokémon, so large ones (Primal Kyogre,
// Necrozma) and short 16:9 screens put them as high as y ≈ 370; the old 450–1350 band cut those off.
const BAND=[300,1450];
// Pixel classes inside a bar: 1 = HP fill (teal above half HP, yellow, red when low); 2 = the orange
// damage trail. Dark or grey pixels are rejected before any hue arithmetic.
function cls(d,i,P=BAR){const r=d[i],g=d[i+1],b=d[i+2],mx=r>g?(r>b?r:b):(g>b?g:b);if(mx<P.vMin*255)return 0;const mn=r<g?(r<b?r:b):(g<b?g:b),c=mx-mn;if(c<P.sMin*mx)return 0;
 let h=mx===r?((g-b)/c+6)%6:mx===g?(b-r)/c+2:(r-g)/c+4;h*=60;
 if(h>=P.teal[0]&&h<=P.teal[1]||h>=P.yellow[0]&&h<=P.yellow[1]||h>=P.red[0]||h<=P.red[1])return 1;return h>=P.trail[0]&&h<P.trail[1]&&c>=P.trailS*mx?2:0;}
// HP bars are found from their fill: a solid rectangle 9–18 rows tall whose left edge is straight. Each
// candidate must then show the bar's outline (white for the opponent, light blue for you, thin and
// semi-transparent): a bright line a few rows above or below the fill along most of the bar. Scenery,
// grass and attack effects make many fill-coloured blobs; on 223 YouTube and phone frames 94% of the
// blobs at the bars' x positions had no outline (score < 0.1), while real bars score ≥ 0.9.
// img: {data RGBA, width, height}; yOffset: frame y of row 0. Returns bars left to right with
// fill and trail as fractions of the full bar width, and `frame`, the outline score.
// Speed (2026-10-11): cls depends only on a pixel's RGB, so findBars memoises it in a 16M-colour table
// packed 2 bits per colour (class + 1; 0 = not computed yet, 4 MB): identical classes without repeating
// the hue arithmetic. Dark pixels (cls's first test) skip the table. One table per settings object.
const LUTS=new Map();
function classTable(P){const key=JSON.stringify(P);let t=LUTS.get(key);if(!t){if(LUTS.size>=2)LUTS.clear();t=new Uint8Array(1<<22);LUTS.set(key,t);}return t;}
function findBars(img,yOffset=0,P=BAR){const s=img.width/REF_W,w=img.width,h=img.height,d=img.data,rows=[],minRun=P.minRun*s,maxRun=FILL_W*s*1.04,gapMax=P.gapPx*s,lut=classTable(P);
 const vm=Math.ceil(P.vMin*255),C=i=>{const r=d[i],g=d[i+1],b=d[i+2];if(r<vm&&g<vm&&b<vm)return 0;const q=r<<16|g<<8|b,sh=(q&3)<<1;let c=lut[q>>2]>>sh&3;if(c===0){c=cls(d,i,P)+1;lut[q>>2]|=c<<sh;}return c-1;};
 // Speed: bars are at least 9 rows tall, so a coarse pass over every 3rd row (every 2nd pixel) finds
 // the rows worth scanning; only rows within 3 of a coarse hit are scanned in full.
 // A hit is R consecutive classified samples (even x). Any R consecutive samples include exactly one
 // x that is a multiple of 2R, so only those are tested first, then the samples on either side.
 const R=Math.max(1,Math.ceil(minRun/2)),want=new Uint8Array(h);
 for(let y=0;y<h;y+=3){const r0=y*w*4;let hit=false;for(let x=0;x<w&&!hit;x+=2*R){if(!C(r0+x*4))continue;let n=1;for(let u=x-2;u>=0&&n<R&&C(r0+u*4);u-=2)n++;for(let u=x+2;u<w&&n<R&&C(r0+u*4);u+=2)n++;hit=n>=R;}
  if(hit)for(let k=Math.max(0,y-3);k<=Math.min(h-1,y+3);k++)want[k]=1;}
 for(let y=0;y<h;y++){if(!want[y])continue;const r0=y*w*4;let x=0;while(x<w){const c=C(r0+x*4);if(!c){x++;continue;}const x0=x;let fillEnd=x0,end=x0,gap=0;
   // A few unclassified pixels (compression ringing between fill and trail) don't end a run.
   while(x<w){const k=C(r0+x*4);if(!k){if(++gap>gapMax)break;x++;continue;}gap=0;if(k===1&&end===fillEnd)fillEnd=x+1;end=x+1;x++;}
   if(end-x0>=minRun&&end-x0<=maxRun)rows.push({y,x0,fillEnd,end});}}
 // Rows join a blob when the left edge moves ≤ 2 px from the previous row and stays within 4 px overall
 // (blurred edges wobble), and the fill or the trail end lines up. Only blobs that reached the previous
 // row can take a row, so they are kept in their own list (in creation order, as a full search finds them).
 const blobs=[],linkX=P.linkX*s,spanX=P.spanX*s,endTol=3*s;let open=[],next=[],cur=-1;
 for(const r of rows){if(r.y!==cur){if(r.y===cur+1){open=next;open.sort((p,q)=>p.id-q.id);}else open=[];next=[];cur=r.y;}let b=null;
  for(let j=0;j<open.length;j++){const o=open[j];if(o.last!==r.y-1)continue;if(Math.abs(o.lastX0-r.x0)<=linkX&&Math.max(o.maxX0,r.x0)-Math.min(o.minX0,r.x0)<=spanX&&(Math.abs(o.ends[o.ends.length-1]-r.end)<=endTol||Math.abs(o.fills[o.fills.length-1]-r.fillEnd)<=endTol)){b=o;break;}}
  if(b){b.last=r.y;b.lastX0=r.x0;b.minX0=Math.min(b.minX0,r.x0);b.maxX0=Math.max(b.maxX0,r.x0);b.x0s.push(r.x0);b.ends.push(r.end);b.fills.push(r.fillEnd);next.push(b);}
  else{b={id:blobs.length,first:r.y,last:r.y,lastX0:r.x0,minX0:r.x0,maxX0:r.x0,x0s:[r.x0],ends:[r.end],fills:[r.fillEnd]};blobs.push(b);next.push(b);}}
 // Fill and trail ends: trimmed mean over rows (middle half) gives sub-pixel steps on small hits.
 const med=a=>[...a].sort((p,q)=>p-q)[a.length>>1],mid=a=>{const s=[...a].sort((p,q)=>p-q),k=a.length>>2,m=s.slice(k,a.length-k);return m.reduce((p,q)=>p+q,0)/m.length;},near=x=>Object.values(P.sides).some(([lo,hi])=>x>=(lo-5)*s&&x<=(hi+5)*s),out=[];
 for(const b of blobs){const bh=b.last-b.first+1;if(bh<P.hMin*s||bh>P.hMax*s)continue;const x0=med(b.x0s);if(!near(x0))continue;
  const frame=outline(img,x0,b.first,b.last,s,P);if(frame<P.frameMin)continue;const end=mid(b.ends),fe=mid(b.fills);
  out.push({x0,y0:b.first+yOffset,x1:x0+Math.round(FILL_W*s),y1:b.last+yOffset,fill:(fe-x0)/(FILL_W*s),trail:(end-fe)/(FILL_W*s),frame:+frame.toFixed(2)});}
 return out.sort((a,b)=>a.x0-b.x0);}
// Outline score of a fill blob: the best share of columns along the bar where one row 2–10 px above
// (or below) the fill is brighter (max channel) than the rows 3 px above and below it by ≥ lineC.
function outline(img,x0,y0,y1,s,P=BAR){const w=img.width,h=img.height,d=img.data,o=Math.max(2,Math.round(3*s)),V=(x,y)=>{const i=(y*w+x)*4,r=d[i],g=d[i+1],b=d[i+2];return r>g?(r>b?r:b):(g>b?g:b);};
 const band=(lo,hi)=>{let best=0;for(let y=Math.max(o,Math.round(lo));y<=Math.min(h-1-o,Math.round(hi));y++){let n=0,k=0;for(let x=Math.round(x0+4*s);x<Math.min(w,x0+240*s);x+=2){k++;const v=V(x,y);if(v-V(x,y-o)>=P.lineC&&v-V(x,y+o)>=P.lineC)n++;}if(k&&n/k>best)best=n/k;}return best;};
 const top=band(y0-10*s,y0-2*s);return top>=P.frameMin?top:Math.max(top,band(y1+2*s,y1+10*s));}
// Kept for callers that measure a known bar: the values come from findBars.
const measureBar=(img,bar)=>({fill:bar.fill,trail:bar.trail});
// Your bar starts near the left edge (x ≈ 50 of 886); the opponent's starts mid-screen (x ≈ 400–590).
// Bench tiles and buttons carry small bars elsewhere and are ignored. The clearest outline wins.
// Where your bar starts depends on the screen's shape (width/height after cropping) and on the Pokémon
// (2026-10-13, each of your Pokémon's usual x0 on 19 videos at 0.45–0.75). Phones taller than 16:9
// (0.45–0.544) keep it within 52–78, most at the left limit (≈ 55). From 16:9 (0.56) up it moves right as
// the screen widens, more for some Pokémon than others (0.56: 56–150, Zekrom 122, Lunala 150; 0.58–0.64:
// 56–140; 0.67: 126–142; 0.75: 154–160), outside the phone window, so your HP was lost. It jumps at 16:9
// (Zekrom 76 at 0.531) and differs between devices of one shape, so the rule is a cutoff, not a window
// that scales with the aspect. In a charged-attack cutscene the attacker's bar is drawn centred (x ≈ 320)
// whoever attacks, inside the opponent's window: your cutscene bar was read as the opponent's (aura, HP),
// and where the opponent's own bar showed less often the cutscene bar became their series (false 13–29%
// "hits"). Screens ≥ 0.55 use x 30–230 for your bar and skip centred bars. Phone screens keep the original
// windows; their HP series (track) skip centred bars too, but assignBars (the aura box and effect-text
// strip) still counts a centred bar as the opponent's there (2026-10-13, 92 labelled phone videos
// re-extracted: in track it removed 696 matchups of cutscene-bar series and held-out fast moves went
// 169 → 171/196; in assignBars it cost the Shadow classifier 4 held-out calls and log-loss, so it stays).
// Outline colour was measured too (white vs light blue) but differs by video and encoding, so it isn't used.
const WIDE_ASPECT=.55,BAR_WIDE={...BAR,sides:{my:[30,230],opponent:[230,600]}};
const isWide=(width,height)=>height>0&&width/height>=WIDE_ASPECT;
// findBars settings for a frame of this size (height = the analysed screen's full height).
const barSettings=(width,height)=>isWide(width,height)?BAR_WIDE:BAR;
// The bars findBars returns with the phone settings (the Shadow classifier's focus shots keep using these).
const phoneBars=(bars,width)=>{const s=width/REF_W;return bars.filter(b=>Object.values(BAR.sides).some(([lo,hi])=>b.x0>=(lo-5)*s&&b.x0<=(hi+5)*s));};
const centred=(b,width)=>Math.abs(b.x0+FILL_W*width/REF_W/2-width/2)<=10*width/REF_W;
function assignBars(bars,width,height=0){const s=width/REF_W,pick=list=>list.sort((a,b)=>(b.frame??0)-(a.frame??0)||(b.y1-b.y0)-(a.y1-a.y0)||b.fill-a.fill)[0]||null;
 if(isWide(width,height)){const [m,o]=[BAR_WIDE.sides.my,BAR_WIDE.sides.opponent],ok=bars.filter(b=>!centred(b,width));
  return {my:pick(ok.filter(b=>b.x0>=m[0]*s&&b.x0<m[1]*s)),opponent:pick(ok.filter(b=>b.x0>=o[0]*s&&b.x0<=o[1]*s))};}
 const [m,o]=[BAR.sides.my,BAR.sides.opponent];
 return {my:pick(bars.filter(b=>b.x0>=m[0]*s&&b.x0<=m[1]*s)),opponent:pick(bars.filter(b=>b.x0>=o[0]*s&&b.x0<=o[1]*s))};}
// series: [{t, fill, trail}] for one side (null when the bar is hidden; bars often vanish for a frame
// as a hit lands). HP never rises during a matchup, so the bar is read as a descending staircase:
// upward readings (attack glow sweeping over the bar) are ignored, and a step down counts once two
// consecutive readings confirm it. A hit's size is the difference between plateau levels.
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
const HIT_NOISE_K=3;
function hits(series,{minDrop=.015,maxHit=.35,confirmWithin=.6,chargedGap=1.2,noiseK=HIT_NOISE_K}={}){const valid=series.filter(Boolean);if(valid.length<3)return [];
 // Heavily compressed footage makes the fill end flicker by 1–3% between frames, which the fixed 1.5%
 // step would read as hits. The step must also clear noiseK × this series' own median frame-to-frame jitter.
 if(noiseK){const d=[];for(let i=1;i<valid.length;i++){const x=Math.abs(valid[i].fill-valid[i-1].fill);if(valid[i].t-valid[i-1].t<=.15&&x<.03)d.push(x);}if(d.length>=5)minDrop=Math.max(minDrop,noiseK*median(d));}
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
// OCR text → 'super' | 'notVery' | null (tolerates a misread letter or two). Other UI languages (game strings
// super_effective / not_very_effective) are tried only when the English rule finds nothing: "Nicht sehr effektiv",
// "Pas très efficace", "Non è molto efficace", "No muy eficaz", "Não é muito eficaz" ("Sehr effektiv",
// "Super efficace", "Superefficace", "Supereficaz"), and CJK text read with that language's model.
const effectKind=text=>{const t=String(text).toLowerCase().replace(/[^a-z ]/g,'');const en=/\bnot\b|v[ae]ry\s*eff/.test(t)&&/eff|v[ae]ry/.test(t)?'notVery':/sup[ae]r|eff[ei]ct/.test(t)?'super':null;if(en)return en;
 const l=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ');
 if(/\bnicht\s*sehr|\bpas\s*tres\s*eff|\bnon\s*e?\s*molto\s*eff|\bno\s*muy\s*efi|\bnao\s*e?\s*muito\s*efi/.test(l))return 'notVery';if(/\bsehr\s*effektiv|efficace|eficaz/.test(l))return 'super';
 const c=String(text).normalize('NFKC').replace(/\s+/g,'');return /いまひとつ|イマヒトツ|별로인|不太好|效果不好/.test(c)?'notVery':/ばつぐん|バツグン|굉장했|絕佳|绝佳/.test(c)?'super':null;};
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
// Screens ≥ 0.55 (assignBars): your window is x 30–230. Centred cutscene bars are skipped on every screen:
// the attacker's bar (yours about as often as theirs) is not one side's HP.
function track(frames,width,height=0){const s=width/REF_W,out={my:[],opponent:[]},wide=isWide(width,height),use=b=>!centred(b,width);
 for(const [side,lo,hi] of wide?[['my',30,229.99],['opponent',230,600]]:[['my',30,80],['opponent',230,600]]){const xs=new Map();for(const f of frames)for(const b of f.bars)if(use(b)&&b.x0>=lo*s&&b.x0<=hi*s){const k=Math.round(b.x0/(3*s));xs.set(k,(xs.get(k)||0)+1);}
  if(!xs.size){out[side]=frames.map(()=>null);continue;}const best=[...xs].sort((a,b)=>b[1]-a[1])[0][0]*3*s;let lastY=null;
  out[side]=frames.map(f=>{const c=f.bars.filter(b=>use(b)&&Math.abs(b.x0-best)<=4*s).sort((a,b)=>(lastY===null?0:Math.abs(a.y0-lastY)-Math.abs(b.y0-lastY))||(b.y1-b.y0)-(a.y1-a.y0));const b=c[0];if(!b)return null;lastY=b.y0;return {t:f.t,fill:b.fill,trail:b.trail};});}
 return out;}
const api={BAR,BAR_WIDE,WIDE_ASPECT,barSettings,phoneBars,BAND,cls,outline,hpTimeline,findBars,measureBar,assignBars,track,hits,cadence,chargedDamage,effectBox,effectSig,effectShape,effectKind};if(typeof module!=='undefined')module.exports=api;root.MetaHp=api;
})(typeof window==='undefined'?globalThis:window);
