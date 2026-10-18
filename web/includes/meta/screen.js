// Finds the phone screen inside a wider video frame (YouTube uploads, streams, capture-card
// recordings): the battle UI usually sits in a tall column beside a facecam or background art.
// Candidate edges come from columns/rows that are a sharp, persistent boundary across many frames;
// each candidate rectangle is then checked by reading the battle HUD inside it (MetaExtractorCore),
// and the rectangle where the HUD reads on the most frames wins. A full-frame portrait recording
// simply returns the whole frame.
(function(root){
'use strict';
const C=root.MetaExtractorCore||(typeof require!=='undefined'?require('./core.js'):null);
const lum=(d,i)=>(d[i]*3+d[i+1]*6+d[i+2])/10;
// Share of samples along each column (axis 'x') or row ('y') where the image steps sharply.
function edgeProfile(img,axis){const {width:W,height:H,data:d}=img,n=axis==='x'?W:H,out=new Float32Array(n);
 for(let a=1;a<n;a++){let hit=0,c=0;const len=axis==='x'?H:W;for(let b=0;b<len;b+=4){const i=axis==='x'?(b*W+a)*4:(a*W+b)*4,j=axis==='x'?i-4:i-W*4;c++;if(Math.abs(lum(d,i)-lum(d,j))>24)hit++;}out[a]=hit/c;}return out;}
// Positions where the median (over frames) edge share is a local peak above `min`, plus both borders.
function peaks(profiles,min=.25,keep=8){const n=profiles[0].length,med=new Float32Array(n);
 for(let a=0;a<n;a++){const v=profiles.map(p=>p[a]).sort((x,y)=>x-y);med[a]=v[v.length>>1];}
 const cand=[];for(let a=2;a<n-2;a++)if(med[a]>=min&&med[a]>=med[a-1]&&med[a]>=med[a+1])cand.push([a,med[a]]);
 cand.sort((x,y)=>y[1]-x[1]);const out=[0,n];for(const [a] of cand){if(out.length>=keep+2)break;if(out.every(b=>Math.abs(b-a)>6))out.push(a);}return out.sort((x,y)=>x-y);}
function crop(img,[x0,y0,x1,y1]){const w=x1-x0,h=y1-y0,data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)data.set(img.data.subarray(((y0+y)*img.width+x0)*4,((y0+y)*img.width+x1)*4),y*w*4);return {data,width:w,height:h};}
// How many frames show a readable HUD inside the box (balls on both sides after calibration).
// Static art can pass the ball test on every frame: u2jAMngLVBw's facecam panel (a pale wall beside a palette
// of red and orange dots) read on 29 of 32 frames, more than the phone (24), and won the screen. Its "opponent
// nameplate" never held text. A frame only counts when both name boxes show text (≥ 12 ink cells of the
// 64×12 fingerprint; real names have 100–200).
const inked=s=>{let n=0;for(let i=0;i<s.bits.length;i++)n+=s.bits[i];return n>=12;};
function hudScore(frames,box){let ok=0,dys=[];for(const f of frames){const c=crop(f,box),dy=C.calibrate(c);if(dy===null)continue;const h=C.readHud(c,dy);if(h&&!(inked(h.my)&&inked(h.opponent)))continue;ok++;dys.push(dy);}return {ok,dy:dys.sort((a,b)=>a-b)[dys.length>>1]??null};}
// frames: several RGBA images ({data,width,height}) spread over the video, ideally mid-battle.
// Returns {box:[x0,y0,x1,y1] in frame pixels, score, frames, dy, aspect} or null when no HUD is found.
// Phones run from about 9:16 to 9:21; letterboxed or cropped uploads may lose some height, so
// widths from 0.38 to 0.75 of the height are tried.
function locate(frames,{minAspect=.38,maxAspect=.75}={}){if(!frames.length)return null;
 const xp=frames.map(f=>edgeProfile(f,'x')),yp=frames.map(f=>edgeProfile(f,'y'));
 const candidates=(xs,ys)=>{const tried=[];for(let i=0;i<ys.length;i++)for(let j=i+1;j<ys.length;j++){const y0=ys[i],y1=ys[j],h=y1-y0;if(h<frames[0].height*.5)continue;
  for(let a=0;a<xs.length;a++)for(let b=a+1;b<xs.length;b++){const x0=xs[a],x1=xs[b],r=(x1-x0)/h;if(r<minAspect||r>maxAspect)continue;tried.push([x0,y0,x1,y1]);}}
  return tried;};
 const tried=candidates(peaks(xp),peaks(yp,.35,4));
 // Full-frame portrait recordings: the whole frame is always a candidate.
 const full=[0,0,frames[0].width,frames[0].height];if(!tried.some(b=>b.join()===full.join()))tried.push(full);
 let best=null;const checked=new Set();const check=(boxes,minFrames)=>{for(const box of boxes){const key=box.join();if(checked.has(key))continue;checked.add(key);const s=hudScore(frames,box),w=box[2]-box[0],bw=best?best.box[2]-best.box[0]:0;
  if(s.ok>=minFrames&&(!best||s.ok>best.score||(s.ok===best.score&&(w>bw||(w===bw&&box[3]-box[1]>best.box[3]-best.box[1])))))best={box,score:s.ok,dy:s.dy};}};
 check(tried,1);
 // Branded layouts may have one phone edge against a background of similar brightness. Try
 // weaker persistent boundaries only after the cheap pass fails; require repeated HUD evidence
 // so a pale team card cannot stand in for the actual battle screen.
 const weak=best?[]:candidates(peaks(xp,.12,16),peaks(yp,.18,6));
 if(!best)check(weak,Math.min(frames.length,Math.max(2,Math.ceil(frames.length*.2))));
 // A bezel or frame line just outside the screen can be the strongest edge: a box 1% too wide on one side
 // already reads no HUD at all (maw_a7oKYMM: 0 of 32 frames at x 337, 19 at x 340 of 960). Last resort:
 // every strong-edge candidate with its sides moved inward by 1–3% of its width, screened on 8 frames first.
 if(!best){const few=frames.filter((_,i)=>i%Math.max(1,Math.floor(frames.length/8))===0).slice(0,8),seen=new Set(),inset=[];
  for(const box of tried){const w=box[2]-box[0];for(const l of [0,1,2,3])for(const r of [0,1,2,3]){if(!l&&!r)continue;const b=[box[0]+Math.round(w*l/100),box[1],box[2]-Math.round(w*r/100),box[3]],key=b.join();if(seen.has(key)||checked.has(key))continue;seen.add(key);if(hudScore(few,b).ok>=2)inset.push(b);}}
  check(inset,Math.min(frames.length,Math.max(2,Math.ceil(frames.length*.2))));}
 // An edge that isn't on half the frames is lost to the median: edited compilations place each battle clip a few
 // pixels apart (Npoke's -QiUVfUf8jo: left edge 428–432, right 690–697 of 960 over five clips), and a dark arena
 // against a dark backdrop hides the edge in most scenes (_bnPdUKMYpw: x 607 strong on 6 of 16 frames). Last resort:
 // each frame's own strong edges, kept only when the HUD reads inside them on that frame; the box that reads on
 // the most frames (the commonest placement) wins.
 if(!best){const own=[],seen=new Set();for(let k=0;k<frames.length;k++)for(const b of candidates(peaks([xp[k]]),peaks([yp[k]],.35,4))){const key=b.join();if(seen.has(key)||checked.has(key))continue;if(hudScore([frames[k]],b).ok){seen.add(key);own.push(b);}}
  check(own,Math.min(frames.length,Math.max(2,Math.ceil(frames.length*.2))));}
 if(!best)return null;best.box=snap(frames,best.box);const fixed=refine(frames,best.box);if(fixed){const s=hudScore(frames,fixed.box);if(s.ok>=best.score){best.box=fixed.box;best.score=s.ok;best.dy=s.dy;best.refined=fixed.fit;}}
 return {...best,frames:frames.length,aspect:+((best.box[2]-best.box[0])/(best.box[3]-best.box[1])).toFixed(3)};}
// Horizontal fit from the Poké Balls (2026-10-11). Branded layouts frame the phone with borders that the
// edge search can take for the screen's edge: a box 1–8% too wide or shifted reads the nameplates off
// target (the opponent's third ball reads '?', names are cut), so no fresh HUD is ever seen, battles merge
// (GMF7uTFAyHM: 1 battle of 12 minutes) or none is found. The six balls' centres on the ball row give the
// screen's true left edge and width: centre = left + width × reference x / 886.
const BALL_X=[46,93,142,743,791,840];
function ballCentres(c,dy){const s=c.width/886,y=Math.round((173+dy)*s),w=c.width,d=c.data;if(y<0||y>=c.height)return null;
 const plain=x=>{const i=(y*w+x)*4,mn=Math.min(d[i],d[i+1],d[i+2]),mx=Math.max(d[i],d[i+1],d[i+2]);return mn>=170&&mx-mn<60;};
 const runs=[];let a=-1;for(let x=0;x<=w;x++){const on=x<w&&!plain(x);if(on&&a<0)a=x;if(!on&&a>=0){runs.push([a,x-1]);a=-1;}}
 // Balls: icon-sized runs with nameplate on both sides; yours are the first three, the opponent's the last three.
 const icons=runs.filter(([p,q])=>p>0&&q<w-1&&q-p+1>=18*s&&q-p+1<=40*s),mid=w/2,left=icons.filter(r=>r[1]<mid).slice(0,3),right=icons.filter(r=>r[0]>mid).slice(-3);
 if(left.length<3||right.length<3)return null;return [...left,...right].map(([p,q])=>(p+q)/2);}
// The screen's left edge o and scale k inside crop c (least squares: centres = o + k·u); null unless all six balls
// are found within 3 reference px of the fit.
function ballFit(c,dy){const xs=ballCentres(c,dy);if(!xs)return null;const s=c.width/886,u=BALL_X.map(x=>x*s);
 const n=6,mu=u.reduce((p,q)=>p+q,0)/n,mx=xs.reduce((p,q)=>p+q,0)/n;let num=0,den=0;for(let i=0;i<n;i++){num+=(u[i]-mu)*(xs[i]-mx);den+=(u[i]-mu)**2;}const k=num/den,o=mx-k*mu;
 return Math.max(...xs.map((x,i)=>Math.abs(o+k*u[i]-x)))<=3*s&&k>.85&&k<1.15?{o,k}:null;}
function refine(frames,box,{minShift=.008,minScale=.012}={}){const fits=[];
 for(const f of frames){const c=crop(f,box),dy=C.calibrate(c);if(dy===null)continue;const fit=ballFit(c,dy);if(fit)fits.push(fit);}
 if(fits.length<3)return null;const med=a=>[...a].sort((p,q)=>p-q)[a.length>>1],o=med(fits.map(f=>f.o)),k=med(fits.map(f=>f.k)),w=box[2]-box[0];
 if(Math.abs(o)<minShift*w&&Math.abs(k-1)<minScale&&Math.abs(o+k*w-w)<minShift*w)return null;
 const W=frames[0].width,x0=Math.max(0,Math.round(box[0]+o)),x1=Math.min(W,Math.round(box[0]+o+k*w));if(x1-x0<w*.8)return null;
 return {box:[x0,box[1],x1,box[3]],fit:{shift:+o.toFixed(1),scale:+k.toFixed(3),frames:fits.length}};}
// A scaled border usually smears over two columns; the screen starts after the last strong column on
// its left side and ends before the first on its right (same for rows).
function snap(frames,box){const out=[...box];for(const [axis,lo,hi] of [['x',0,2],['y',1,3]]){const P=frames.map(f=>edgeProfile(f,axis)),n=P[0].length,med=a=>{const v=P.map(p=>p[a]).sort((x,y)=>x-y);return v[v.length>>1];};
  const strong=a=>a>0&&a<n&&med(a)>=.2;
  if(out[lo]>0){let a=out[lo];while(strong(a+1)&&a+1-out[lo]<=2)a++;out[lo]=a;}
  if(out[hi]<n){let a=out[hi];while(strong(a-1)&&out[hi]-(a-1)<=2)a--;if(strong(a))out[hi]=a;}}
 return out;}
// screenCentre: undefined without a HUD in b (hudScore's test), null for a HUD without a ball fit, else the centre of the
// screen fitted to the balls (left edge + half the fitted width).
function screenCentre(f,b){const c=crop(f,b),dy=C.calibrate(c);if(dy===null)return undefined;const h=C.readHud(c,dy);if(h&&!(inked(h.my)&&inked(h.opponent)))return undefined;const fit=ballFit(c,dy);return fit?b[0]+fit.o+fit.k*(b[2]-b[0])/2:null;}
const median=a=>[...a].sort((p,q)=>p-q)[a.length>>1];
// Other placements of the located screen (2026-10-17). Edited compilations place each clip's phone a few pixels apart,
// and a box reads the HUD only within about 1% of its width (±3 px at 960): Npoke's M5ED7uc0aao has its phone's left
// edge at 429, 438, 432, 436 and 432 of 960 over five clips; the box at 432 read nothing in the 438 clip (2 battles).
// Each frame's own edges don't separate them (peaks keeps one edge per 6 px, and the art panel's border is 6 px from
// the phone's), so on frames where `box` reads nothing the box is moved sideways by up to 4% of its width (one Poké Ball
// spacing is 5.3%: further, the balls read in the wrong slots) and, where it reads, the six balls give the exact
// shift. The fitted screen's centre is compared with the box's centre: locate and refine fit the box to the balls, a
// box between two clips (-QiUVfUf8jo's at 430, clips at 428.9 and 430.9) has no better own margin, and a box a little
// too wide (maw_a7oKYMM: 277 px for a 273.5 px screen, its left edge 3 px out) is still centred. A placement is at
// least 1% of the width from the box (nearer, the box reads it); shifts within 0.6% of each other form one placement.
// Returns [{box, shift (frame px), frames (indices)}], most frames first.
function placements(frames,box,{reach=.04,merge=.006,distinct=.01}={}){if(!frames.length)return [];const w=box[2]-box[0],W=frames[0].width,step=Math.max(1,Math.round(w/133)),moved=[];
 const mid=(box[0]+box[2])/2;frames.forEach((f,i)=>{if(screenCentre(f,box)!==undefined)return;
  search:for(let d=step;d<=w*reach;d+=step)for(const s of [d,-d]){const b=[box[0]+s,box[1],box[2]+s,box[3]];if(b[0]<0||b[2]>W)continue;const y=screenCentre(f,b);if(y===undefined||y===null)continue;moved.push({i,x:y-mid});break search;}});
 const tol=merge*w,groups=[];
 for(const m of moved.map(m=>({i:m.i,s:m.x})).filter(m=>Math.abs(m.s)>=distinct*w).sort((a,b)=>a.s-b.s)){const g=groups.at(-1);if(g&&m.s-g[0].s<=tol)g.push(m);else groups.push([m]);}
 return groups.map(g=>{const s=median(g.map(m=>m.s)),r=Math.round(s);return {box:[box[0]+r,box[1],box[2]+r,box[3]],shift:+s.toFixed(2),frames:g.map(m=>m.i)};}).filter(p=>p.box[0]>=0&&p.box[2]<=W).sort((a,b)=>b.frames.length-a.frames.length);}
const api={locate,snap,refine,ballCentres,ballFit,placements,edgeProfile,peaks,crop,hudScore};if(typeof module!=='undefined')module.exports=api;root.MetaScreen=api;
})(typeof window==='undefined'?globalThis:window);
