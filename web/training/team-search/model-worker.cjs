'use strict';
const {parentPort}=require('node:worker_threads');const {Network}=require('./neural.cjs');const {train}=require('./pairwise.cjs');const {random}=require('../utils.cjs');
parentPort.on('message',([request])=>{try{
 const {featuresBuffer,pairsBuffer,targetsBuffer,input,count,hidden,epochs,seed}=request;
 const matrix=new Float64Array(featuresBuffer),pairs=new Int32Array(pairsBuffer),targets=new Float64Array(targetsBuffer),r=random(seed);
 const samples=Array.from({length:count},()=>{const i=Math.floor(r()*count),a=pairs[i*2]*input,b=pairs[i*2+1]*input;return {a:matrix.subarray(a,a+input),b:matrix.subarray(b,b+input),y:targets[i]};});
 const network=train(new Network(input,hidden,seed),samples,{epochs,seed});parentPort.postMessage({result:network.toJSON(),heapBytes:process.memoryUsage().heapUsed});
 }catch(error){parentPort.postMessage({error:error.stack||error.message});}});
