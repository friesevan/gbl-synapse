'use strict';
const {parentPort}=require('node:worker_threads');
const {play}=require('./engine.cjs');
parentPort.on('message',args=>{
 try{const result=play(...args);parentPort.postMessage({result,heapBytes:process.memoryUsage().heapUsed});}
 catch(error){parentPort.postMessage({error:error.stack||error.message});}
});
