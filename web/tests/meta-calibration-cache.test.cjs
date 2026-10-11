'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../includes/meta/core.js'),{createCalibrationCache}=require('./meta-benchmark/calibration-cache.cjs'),{getHeight}=require('./meta-benchmark/hud-scan-plan.cjs');
const blank=(width=443,height=960)=>({width,height,data:Buffer.alloc(width*height*4,255)});
test('static negative HUD calibration is computed once and does not inspect unconsulted lower pixels',()=>{
 const cache=createCalibrationCache(),img=blank();let calls=0;const compute=()=>{calls++;return C.calibrate(img);};
 assert.equal(cache.run(img,compute),null);assert.equal(cache.run(img,compute),null);
 img.data[getHeight(img.width,img.height)*img.width*4+4]=0;
 assert.equal(cache.run(img,compute),null);assert.equal(calls,1);assert.equal(cache.metrics.reused,2);
});
test('any changed consulted pixel and original image dimensions invalidate negative reuse',()=>{
 const cache=createCalibrationCache(),img=blank();let calls=0;const compute=()=>{calls++;return null;};cache.run(img,compute);
 img.data[100]=0;cache.run(img,compute);cache.run(blank(443,962),compute);assert.equal(calls,3);
});
test('positive calibration is never reused as a negative and decoder buffer mutation is isolated',()=>{
 const cache=createCalibrationCache(),img=blank();let calls=0;
 assert.equal(cache.run(img,()=>{calls++;return 12;}),12);
 assert.equal(cache.run(img,()=>{calls++;return null;}),null);
 img.data[0]=1;assert.equal(cache.run(img,()=>{calls++;return 15;}),15);assert.equal(calls,3);
});
test('disabled/oversized caches always compute and throwing calibration does not poison the cache',()=>{
 for(const opts of [{enabled:false},{maxBytes:1}]){const cache=createCalibrationCache(opts),img=blank();let calls=0;for(let i=0;i<2;i++)cache.run(img,()=>{calls++;return null;});assert.equal(calls,2);}
 const cache=createCalibrationCache(),img=blank();assert.throws(()=>cache.run(img,()=>{throw Error('failed');}),/failed/);
 assert.equal(cache.run(img,()=>null),null);assert.equal(cache.metrics.reused,0);
});
