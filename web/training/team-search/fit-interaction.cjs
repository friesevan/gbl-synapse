'use strict';
const path=require('node:path');const {BattlePool}=require('../pool.cjs');const {BattleRunner}=require('../runner.cjs');const {Network}=require('./interaction.cjs');
async function fitParallel(samples,{workers=12,size=12,hidden=8,epochs=10,seed=1,bootstrap='fixture'}={}){
 if(!samples.length)throw Error('Need pairwise training samples');for(const [name,value] of Object.entries({workers,size,hidden,epochs}))if(!Number.isInteger(value)||value<1)throw Error('Invalid fitting '+name);const input=samples[0].a?.length;if(!Number.isInteger(input)||input<1)throw Error('Invalid pairwise feature dimension');const map=new Map(),vectors=[];
 if(!['fixture','team'].includes(bootstrap))throw Error('Unknown bootstrap mode');
 const index=x=>{if(!map.has(x)){map.set(x,vectors.length);vectors.push(x);}return map.get(x);};const pairs=new Int32Array(new SharedArrayBuffer(samples.length*2*4)),targets=new Float64Array(new SharedArrayBuffer(samples.length*8)),groups=bootstrap==='team'?new Int32Array(new SharedArrayBuffer(samples.length*4)):null,groupIds=new Map();
 samples.forEach((s,i)=>{if(!Number.isFinite(s.y)||s.y<0||s.y>1||s.a?.length!==input||s.b?.length!==input)throw Error('Invalid pairwise training fixture');pairs[i*2]=index(s.a);pairs[i*2+1]=index(s.b);targets[i]=s.y;if(groups){const key=s.key??pairs[i*2];if(!groupIds.has(key))groupIds.set(key,groupIds.size);groups[i]=groupIds.get(key);}});
 const matrix=new Float64Array(new SharedArrayBuffer(vectors.length*input*8));vectors.forEach((x,i)=>{for(const v of x)if(!Number.isFinite(v))throw Error('Nonfinite pairwise training feature');matrix.set(x,i*input);});
 const pool=new BattlePool(Math.min(workers,size),()=>new BattleRunner({workerFile:path.join(__dirname,'interaction-worker.cjs'),heapMb:128}));
 try{const results=await pool.map(Array.from({length:size},(_,i)=>[{featuresBuffer:matrix.buffer,pairsBuffer:pairs.buffer,targetsBuffer:targets.buffer,groupsBuffer:groups?.buffer,bootstrap,input,count:samples.length,hidden,epochs,seed:seed+i*991}]));return results.map(Network.fromJSON);}finally{await pool.close();}
}
module.exports={fitParallel};
