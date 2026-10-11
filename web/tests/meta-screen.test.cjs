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
