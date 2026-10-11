'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../includes/meta/screen.js'),C=require('../includes/meta/core.js');
function overlay(seed=0){
 const W=960,H=540,x0=355,w=250,data=new Uint8ClampedArray(W*H*4);
 for(let i=0;i<data.length;i+=4)data.set([95,110,150,255],i);
 const fill=(box,c)=>{const [a,b,z,d]=box;for(let y=b;y<d;y++)for(let x=a;x<z;x++)data.set([...c,255],(y*W+x)*4);};
 fill([x0,0,x0+w,H],[70+seed,140,80]);
 // The branded frame and playing field have similar luminance for most of the border.
 fill([x0,350,x0+w,425],[20,40,30]);
 const scale=w/886;
 for(const side of ['my','opponent']){
  const box=b=>b.map((v,i)=>Math.round(v*scale)+(i%2===0?x0:0));
  fill(box(C.HUD.panel[side]),[250,250,250]);
  for(const b of C.HUD.balls[side])fill(box(b),[230,40,40]);
 }
 return {width:W,height:H,data};
}
test('weak overlay borders recover the complete phone instead of cropping at a horizontal banner',()=>{
 const frames=[0,1,2,3].map(overlay),xs=S.peaks(frames.map(f=>S.edgeProfile(f,'x')));
 assert.ok(!xs.includes(355),'the strong-edge pass misses the phone boundary');
 const found=S.locate(frames);assert.deepEqual(found.box,[355,0,605,540]);assert.equal(found.score,4);
});
test('a plain branded frame without a readable battle HUD is not accepted by the fallback',()=>{
 const width=960,height=540,data=new Uint8ClampedArray(width*height*4);
 for(let i=0;i<data.length;i+=4)data.set([95,110,150,255],i);
 assert.equal(S.locate([{width,height,data},{width,height,data}]),null);
});
const P=require('./meta-benchmark/probe.cjs');
test('probe ranges merge nearby HUD hits and pad whole battles',()=>{const times=[],hits=[];for(let t=0;t<=1200;t+=6){times.push(t);hits.push((t>=100&&t<=300)||(t>=330&&t<=500)||t===900);}
 const r=P.rangesFrom(times,hits,1200,{pre:30,post:45,gap:60});assert.deepEqual(r.map(x=>[x.start,x.end]),[[72,543],[870,945]]);
 assert.deepEqual(P.rangesFrom(times,times.map(()=>false),1200),[]);assert.equal(P.rangesFrom([0,6],[true,true],10)[0].end,10);});
test('probe plan: skip without HUD, whole video when mostly battles, ranges otherwise',()=>{const p={box:[1,2,3,4],ranges:[{start:0,end:10}],coverage:.2,keyInterval:6};
 assert.equal(P.plan({...p,ranges:[]}),null);assert.equal(P.plan({box:null,ranges:[]}),null);assert.deepEqual(P.plan({...p,coverage:.9}),{CROP:'1,2,3,4'});
 assert.deepEqual(P.plan(p),{CROP:'1,2,3,4',RANGES:'0-10'});assert.deepEqual(P.plan({...p,keyInterval:30,ranges:[]}),{CROP:'1,2,3,4'});assert.deepEqual(P.plan(null),{});});
test('a second phone screen of the same size is found beside the first (championship broadcasts)',()=>{const frames=[0,1,2].map(()=>{const f=overlay(0),W=f.width,x0=650,w=250,scale=w/886;
  const fill=(box,c)=>{const [a,b,z,d]=box;for(let y=b;y<d;y++)for(let x=a;x<z;x++)f.data.set([...c,255],(y*W+x)*4);};fill([x0,0,x0+w,f.height],[70,140,80]);
  for(const side of ['my','opponent']){const box=b=>b.map((v,i)=>Math.round(v*scale)+(i%2===0?x0:0));fill(box(C.HUD.panel[side]),[250,250,250]);for(const b of C.HUD.balls[side])fill(box(b),[230,40,40]);}return f;});
 const s=P.secondScreen(frames,[355,0,605,540],3);assert.ok(s&&Math.abs(s.box[0]-650)<=32,'second screen near x=650');assert.equal(P.secondScreen([overlay(0)],[355,0,605,540],1),null);});
