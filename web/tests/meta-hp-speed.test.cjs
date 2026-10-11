// The sped-up findBars (colour table, sparse coarse pass, open-blob linking) must return exactly what the
// straightforward version below (hp.js before 2026-10-11's speed work) returns.
const test=require('node:test'),assert=require('node:assert/strict'),Hp=require('../includes/meta/hp.js'),{keepRows,plan}=require('./meta-benchmark/decode-plan.cjs');
const REF_W=886,FILL_W=246;
function reference(img,yOffset=0,P=Hp.BAR){const cls=Hp.cls,s=img.width/REF_W,w=img.width,h=img.height,d=img.data,rows=[],minRun=P.minRun*s,maxRun=FILL_W*s*1.04,gapMax=P.gapPx*s;
 const want=new Uint8Array(h);for(let y=0;y<h;y+=3){let run=0,hit=false;for(let x=0;x<w;x+=2){if(cls(d,(y*w+x)*4,P)){if(++run*2>=minRun){hit=true;break;}}else run=0;}if(hit)for(let k=Math.max(0,y-3);k<=Math.min(h-1,y+3);k++)want[k]=1;}
 for(let y=0;y<h;y++){if(!want[y])continue;let x=0;while(x<w){const c=cls(d,(y*w+x)*4,P);if(!c){x++;continue;}const x0=x;let fillEnd=x0,end=x0,gap=0;
   while(x<w){const k=cls(d,(y*w+x)*4,P);if(!k){if(++gap>gapMax)break;x++;continue;}gap=0;if(k===1&&end===fillEnd)fillEnd=x+1;end=x+1;x++;}
   if(end-x0>=minRun&&end-x0<=maxRun)rows.push({y,x0,fillEnd,end});}}
 const blobs=[];for(const r of rows){const b=blobs.find(b=>b.last===r.y-1&&Math.abs(b.lastX0-r.x0)<=P.linkX*s&&Math.max(b.maxX0,r.x0)-Math.min(b.minX0,r.x0)<=P.spanX*s&&(Math.abs(b.ends.at(-1)-r.end)<=3*s||Math.abs(b.fills.at(-1)-r.fillEnd)<=3*s));
  if(b){b.last=r.y;b.lastX0=r.x0;b.minX0=Math.min(b.minX0,r.x0);b.maxX0=Math.max(b.maxX0,r.x0);b.x0s.push(r.x0);b.ends.push(r.end);b.fills.push(r.fillEnd);}
  else blobs.push({first:r.y,last:r.y,lastX0:r.x0,minX0:r.x0,maxX0:r.x0,x0s:[r.x0],ends:[r.end],fills:[r.fillEnd]});}
 const med=a=>[...a].sort((p,q)=>p-q)[a.length>>1],mid=a=>{const s=[...a].sort((p,q)=>p-q),k=a.length>>2,m=s.slice(k,a.length-k);return m.reduce((p,q)=>p+q,0)/m.length;},near=x=>Object.values(P.sides).some(([lo,hi])=>x>=(lo-5)*s&&x<=(hi+5)*s),out=[];
 for(const b of blobs){const bh=b.last-b.first+1;if(bh<P.hMin*s||bh>P.hMax*s)continue;const x0=med(b.x0s);if(!near(x0))continue;
  const frame=Hp.outline(img,x0,b.first,b.last,s,P);if(frame<P.frameMin)continue;const end=mid(b.ends),fe=mid(b.fills);
  out.push({x0,y0:b.first+yOffset,x1:x0+Math.round(FILL_W*s),y1:b.last+yOffset,frame:+frame.toFixed(2),fill:(fe-x0)/(FILL_W*s),trail:(end-fe)/(FILL_W*s)});}
 return out.sort((a,b)=>a.x0-b.x0);}
// Seeded scenes: bars with outlines, fill/trail splits and ragged edges, plus look-alike blobs, sparse
// speckles (runs held together by short gaps) and noise in fill, trail and near-miss colours.
function scene(seed,W,H){let st=seed>>>0;const rnd=()=>((st=(st*1664525+1013904223)>>>0)/2**32),d=Buffer.alloc(W*H*4),s=W/REF_W;
 const put=(x,y,c)=>{if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*4;d[i]=c[0];d[i+1]=c[1];d[i+2]=c[2];d[i+3]=255;};
 const cols=[[30,254,194],[0,228,172],[240,220,40],[230,40,40],[250,150,40],[200,120,60],[180,180,180],[120,60,200],[255,255,255],[60,60,60],[178,120,20],[179,110,60]];
 for(let i=0;i<W*H;i++){const v=rnd()*90|0;d[i*4]=v;d[i*4+1]=v+(rnd()*40|0);d[i*4+2]=v;d[i*4+3]=255;}
 const bars=1+(rnd()*4|0);for(let b=0;b<bars;b++){const x0=Math.round((rnd()<.5?30+rnd()*50:230+rnd()*370)*s),y0=Math.round(rnd()*(H-40))+12,bh=Math.round((8+rnd()*12)*s),fill=Math.round(rnd()*FILL_W*s),trail=Math.round(rnd()*40*s);
  for(let x=x0;x<x0+FILL_W*s;x+=1)put(x,y0-Math.round(5*s),[250,250,250]);
  for(let y=y0;y<y0+bh;y++){const jx=rnd()<.3?(rnd()*3|0)-1:0;for(let x=x0+jx;x<x0+fill;x++)put(x,y,rnd()<.03?[90,90,90]:cols[rnd()<.5?0:1]);for(let x=x0+fill;x<x0+fill+trail;x++)put(x,y,cols[4]);}}
 for(let k=0;k<200;k++){const x=rnd()*W|0,y=rnd()*H|0,len=rnd()*300|0,c=cols[rnd()*cols.length|0],step=1+(rnd()*5|0),tall=1+(rnd()*20|0);for(let yy=y;yy<y+tall;yy++)for(let xx=x;xx<x+len;xx+=step)put(xx,yy,c);}
 return {data:d,width:W,height:H};}
test('findBars matches the reference implementation on varied synthetic scenes',()=>{let found=0;
 for(let seed=1;seed<=60;seed++)for(const [W,H] of [[886,400],[560,260],[443,220],[1080,480]]){const img=scene(seed*7+W,W,H),a=Hp.findBars(img,300),b=reference(img,300);assert.deepEqual(a,b,`seed ${seed} ${W}x${H}`);found+=a.length;}
 assert.ok(found>20,'scenes contain real bars');});
test('findBars uses the given settings, not a stale colour table',()=>{const img=scene(5,886,400),P={...Hp.BAR,teal:[100,200],minRun:4,gapPx:5};
 assert.deepEqual(Hp.findBars(img,0,P),reference(img,0,P));assert.deepEqual(Hp.findBars(img,0),reference(img,0));});
test('findBars accepts canvas pixel arrays (Uint8ClampedArray)',()=>{const img=scene(9,886,300),c={...img,data:new Uint8ClampedArray(img.data)};assert.deepEqual(Hp.findBars(c,0),reference(c,0));});
test('keepRows crops after an explicit rgba conversion and keeps full frames unchanged',()=>{const p=plan({width:1920,height:1080,crop:[706,0,1214,1080]});
 assert.deepEqual(keepRows(p,1450).filters,[...p.filters,'format=rgba','crop=886:1450:0:0']);assert.equal(keepRows(p,1450).rows,1450);assert.deepEqual(keepRows(p,p.height).filters,p.filters);
 for(const bad of [0,1.5,p.height+1])assert.throws(()=>keepRows(p,bad));});
