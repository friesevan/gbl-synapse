'use strict';
const {ActiveClock}=require('./active-clock.cjs');const path=require('node:path');const {Worker}=require('node:worker_threads');
// Discard the whole V8 isolate regularly; collection of repeatedly compiled VM
// contexts in a long-lived isolate was insufficient for overnight runs.
class BattleRunner{
 constructor({workerFile=path.join(__dirname,'battle-worker.cjs'),heapMb=128,maxBattles=8,recycleHeapFraction=.7}={}){this.maxBattles=maxBattles;this.recycleHeapFraction=recycleHeapFraction;this.workerFile=workerFile;this.heapMb=heapMb;this.worker=null;this.completed=0;this.recycles=0;this.workerHeapBytes=0;this.pending=null;this.failure=null;}
 start(){
  const worker=this.worker=new Worker(this.workerFile,{resourceLimits:{maxOldGenerationSizeMb:this.heapMb}});this.completed=0;this.failure=null;
  worker.on('message',message=>{this.workerHeapBytes=message.heapBytes||0;if(!this.pending)return;const {resolve,reject,timer}=this.pending;this.pending=null;timer.close();if(message.error)reject(new Error(message.error));else{this.completed++;resolve(message.result);}});
  worker.on('error',error=>this.fail(error));
  worker.on('exit',code=>{if(this.worker===worker)this.fail(new Error('Battle worker exited unexpectedly ('+code+')'));});
 }
 fail(error){this.failure=error;if(this.pending){this.pending.timer.close();this.pending.reject(error);this.pending=null;}}
 async close(){const worker=this.worker;this.worker=null;if(this.pending)this.fail(new Error('Battle worker closed before finishing'));if(worker)await worker.terminate();}
 async play(...args){
  if(this.pending)throw Error('BattleRunner supports one battle at a time');
  if(this.completed>=this.maxBattles||this.workerHeapBytes>this.heapMb*1048576*this.recycleHeapFraction){await this.close();this.recycles++;}
  if(!this.worker)this.start();if(this.failure)throw this.failure;
  return new Promise((resolve,reject)=>{const clock=new ActiveClock(),started=clock.now(),timer={close(){clearInterval(this.id);clock.close();}};timer.id=setInterval(()=>{if(clock.now()-started>=120000){this.fail(new Error('Battle worker exceeded 120 awake-second watchdog'));void this.close();}},1000);this.pending={resolve,reject,timer};this.worker.postMessage(args);});
 }
}
module.exports={BattleRunner};
