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
function hudScore(frames,box){let ok=0,dys=[];for(const f of frames){const c=crop(f,box),dy=C.calibrate(c);if(dy!==null){ok++;dys.push(dy);}}return {ok,dy:dys.sort((a,b)=>a-b)[dys.length>>1]??null};}
// frames: several RGBA images ({data,width,height}) spread over the video, ideally mid-battle.
// Returns {box:[x0,y0,x1,y1] in frame pixels, score, frames, dy, aspect} or null when no HUD is found.
// Phones run from about 9:16 to 9:21; letterboxed or cropped uploads may lose some height, so
// widths from 0.38 to 0.75 of the height are tried.
function locate(frames,{minAspect=.38,maxAspect=.75}={}){if(!frames.length)return null;
 const xs=peaks(frames.map(f=>edgeProfile(f,'x'))),ys=peaks(frames.map(f=>edgeProfile(f,'y')),.35,4);
 const tried=[];for(let i=0;i<ys.length;i++)for(let j=i+1;j<ys.length;j++){const y0=ys[i],y1=ys[j],h=y1-y0;if(h<frames[0].height*.5)continue;
  for(let a=0;a<xs.length;a++)for(let b=a+1;b<xs.length;b++){const x0=xs[a],x1=xs[b],r=(x1-x0)/h;if(r<minAspect||r>maxAspect)continue;tried.push([x0,y0,x1,y1]);}}
 // Full-frame portrait recordings: the whole frame is always a candidate.
 const full=[0,0,frames[0].width,frames[0].height];if(!tried.some(b=>b.join()===full.join()))tried.push(full);
 let best=null;for(const box of tried){const s=hudScore(frames,box);if(s.ok&&(!best||s.ok>best.score||(s.ok===best.score&&(box[2]-box[0])>(best.box[2]-best.box[0]))))best={box,score:s.ok,dy:s.dy};}
 if(!best)return null;best.box=snap(frames,best.box);return {...best,frames:frames.length,aspect:+((best.box[2]-best.box[0])/(best.box[3]-best.box[1])).toFixed(3)};}
// A scaled border usually smears over two columns; the screen starts after the last strong column on
// its left side and ends before the first on its right (same for rows).
function snap(frames,box){const out=[...box];for(const [axis,lo,hi] of [['x',0,2],['y',1,3]]){const P=frames.map(f=>edgeProfile(f,axis)),n=P[0].length,med=a=>{const v=P.map(p=>p[a]).sort((x,y)=>x-y);return v[v.length>>1];};
  const strong=a=>a>0&&a<n&&med(a)>=.2;
  if(out[lo]>0){let a=out[lo];while(strong(a+1)&&a+1-out[lo]<=2)a++;out[lo]=a;}
  if(out[hi]<n){let a=out[hi];while(strong(a-1)&&out[hi]-(a-1)<=2)a--;if(strong(a))out[hi]=a;}}
 return out;}
const api={locate,snap,edgeProfile,peaks,crop,hudScore};if(typeof module!=='undefined')module.exports=api;root.MetaScreen=api;
})(typeof window==='undefined'?globalThis:window);
