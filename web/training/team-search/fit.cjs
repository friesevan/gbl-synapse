'use strict';
const path=require('node:path');const {BattlePool}=require('../pool.cjs');const {BattleRunner}=require('../runner.cjs');const {Network}=require('./neural.cjs');
async function fitParallel(samples,{workers=12,size=12,hidden=8,epochs=10,seed=1}={}){
 if(!samples.length)throw Error('Need pairwise training samples');const input=samples[0].a.length,map=new Map(),vectors=[];
 const index=x=>{if(!map.has(x)){map.set(x,vectors.length);vectors.push(x);}return map.get(x);};const pairs=new Int32Array(new SharedArrayBuffer(samples.length*2*4)),targets=new Float64Array(new SharedArrayBuffer(samples.length*8));
 samples.forEach((s,i)=>{if(!Number.isFinite(s.y)||s.y<0||s.y>1||s.a.length!==input||s.b.length!==input)throw Error('Invalid pairwise training fixture');pairs[i*2]=index(s.a);pairs[i*2+1]=index(s.b);targets[i]=s.y;});
 const matrix=new Float64Array(new SharedArrayBuffer(vectors.length*input*8));vectors.forEach((x,i)=>matrix.set(x,i*input));
 const pool=new BattlePool(Math.min(workers,size),()=>new BattleRunner({workerFile:path.join(__dirname,'model-worker.cjs'),heapMb:128}));
 try{const results=await pool.map(Array.from({length:size},(_,i)=>[{featuresBuffer:matrix.buffer,pairsBuffer:pairs.buffer,targetsBuffer:targets.buffer,input,count:samples.length,hidden,epochs,seed:seed+i*991}]));return results.map(Network.fromJSON);}finally{await pool.close();}
}
module.exports={fitParallel};
