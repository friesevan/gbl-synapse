'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./meta-benchmark/hud-scan-plan.cjs'),C=require('../includes/meta/core.js');
function hud(dy){
 const width=443,height=960,data=new Uint8ClampedArray(width*height*4);for(let i=0;i<data.length;i+=4)data.set([40,75,25,255],i);
 const fill=(b,rgb)=>{const box=b.map((v,i)=>Math.round((v+(i%2?dy:0))*.5));for(let y=Math.max(0,box[1]);y<Math.min(height,box[3]);y++)for(let x=box[0];x<box[2];x++)data.set([...rgb,255],(y*width+x)*4);};
 for(const side of ['my','opponent']){fill(C.HUD.panel[side],[240,240,240]);for(const box of C.HUD.balls[side])fill(box,[230,40,40]);}
 return {width,height,data};
}
function band(img,dy){const height=P.hudScanHeight(img.width,img.height,dy);return {width:img.width,height,data:img.data.subarray(0,height*img.width*4)};}
test('443-wide screening transfers only208 rows, while high offsets and short images stay covered',()=>{
 assert.equal(P.hudScanHeight(443,960,160),208);assert.equal(P.hudScanHeight(443,960,300),262);assert.equal(P.hudScanHeight(443,160,0),160);
});
test('all default calibrate and known-offset reads agree on full frames and HUD bands',()=>{
 for(const offset of [-100,-50,0,50,100,160,185,195,300]){const img=hud(offset),small=band(img,offset);
  assert.equal(C.calibrate(small),C.calibrate(img));
  for(const dy of [offset,offset-4,offset+4,offset-8,offset+8])assert.deepEqual(C.readHud(small,dy),C.readHud(img,dy));
 }
});
test('no HUD remains no HUD after removing the unused lower screen',()=>{
 const img=hud(0);img.data.fill(80);assert.equal(C.calibrate(img),null);assert.equal(C.calibrate(band(img,0)),null);
});
test('invalid offsets/dimensions fail rather than truncating silently',()=>{
 assert.throws(()=>P.hudScanHeight(443,960,NaN));assert.throws(()=>P.hudScanHeight(0,960,0));assert.throws(()=>P.hudScanHeight(443,-1,0));
});
