'use strict';
const {parentPort}=require('node:worker_threads');const {play}=require('./engine-v4.cjs');
parentPort.on('message',args=>{try{parentPort.postMessage({result:play(...args),heapBytes:process.memoryUsage().heapUsed});}catch(error){parentPort.postMessage({error:error.stack||error.message});}});
