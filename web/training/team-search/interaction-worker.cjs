'use strict';
const {parentPort}=require('node:worker_threads');const {Network,train}=require('./interaction.cjs');const {random}=require('../utils.cjs');
parentPort.on('message',([request])=>{try{
 const {featuresBuffer,pairsBuffer,targetsBuffer,groupsBuffer,bootstrap='fixture',input,count,hidden,epochs,seed,rank=0,l2=1}=request;
 const matrix=new Float64Array(featuresBuffer),pairs=new Int32Array(pairsBuffer),targets=new Float64Array(targetsBuffer),r=random(seed);
 let indices;
 if(bootstrap==='team'){
  // One whole candidate is the sampling unit: its fixture outcomes are correlated.
  // Resampling complete candidate blocks preserves within-team opponent coverage.
  const ids=new Int32Array(groupsBuffer),byGroup=new Map();for(let i=0;i<count;i++){if(!byGroup.has(ids[i]))byGroup.set(ids[i],[]);byGroup.get(ids[i]).push(i);}const blocks=[...byGroup.values()];indices=[];for(let i=0;i<blocks.length;i++)for(const index of blocks[Math.floor(r()*blocks.length)])indices.push(index);
 }else indices=Array.from({length:count},()=>Math.floor(r()*count));
 const vectors=new Map(),view=index=>{if(!vectors.has(index))vectors.set(index,matrix.subarray(index*input,(index+1)*input));return vectors.get(index);};
 const samples=indices.map(i=>({a:view(pairs[i*2]),b:view(pairs[i*2+1]),y:targets[i]}));
 const network=train(new Network(input,hidden,seed,rank),samples,{epochs,seed,l2});parentPort.postMessage({result:network.toJSON(),heapBytes:process.memoryUsage().heapUsed});
 }catch(error){parentPort.postMessage({error:error.stack||error.message});}});
