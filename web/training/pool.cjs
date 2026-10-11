'use strict';
const os=require('node:os');const {BattleRunner}=require('./runner.cjs');
const availableCores=()=>typeof os.availableParallelism==='function'?os.availableParallelism():os.cpus().length;
const defaultWorkers=()=>Math.min(availableCores(),Math.max(1,Math.floor(os.totalmem()*.5/(256*1048576))));
class BattlePool{
 constructor(size=defaultWorkers(),runnerFactory=()=>new BattleRunner()){if(!Number.isInteger(size)||size<1)throw Error('Worker count must be a positive integer');this.runners=Array.from({length:size},()=>runnerFactory());this.busy=false;}
 get size(){return this.runners.length;}
 get peakWorkerHeapBytes(){return Math.max(0,...this.runners.map(r=>r.workerHeapBytes));}
 get recycles(){return this.runners.reduce((sum,r)=>sum+r.recycles,0);}
 async map(jobs,{shouldStop=()=>false,onResult=()=>{}}={}){
  if(this.busy)throw Error('BattlePool supports one batch at a time');this.busy=true;
  const results=new Array(jobs.length);let next=0,completed=0,failure=null;
  try{
   await Promise.all(this.runners.map(async runner=>{
    while(next<jobs.length&&!failure&&!shouldStop()){
     const index=next++;
     try{const result=await runner.play(...jobs[index]);results[index]=result;completed++;onResult(result,index);}
     catch(error){failure=failure||error;}
    }
   }));
   if(failure)throw failure;
   return completed===jobs.length?results:null;
  }finally{this.busy=false;}
 }
 async close(){await Promise.all(this.runners.map(r=>r.close()));}
}
module.exports={BattlePool,availableCores,defaultWorkers};
