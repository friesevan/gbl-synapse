#!/usr/bin/env node
'use strict';
// Deterministic microbenchmarks. Speed varies with workload, JIT and system load;
// require exact model/prediction parity before reporting any timing improvement.
const {performance}=require('node:perf_hooks'),assert=require('node:assert/strict');
const {Network,train,reference,predict,preparePredictor}=require('./interaction.cjs'),{random}=require('../utils.cjs');
const r=random(12),vectors=Array.from({length:96},()=>Float64Array.from({length:366},()=>r()*2-1));
const samples=Array.from({length:4096},()=>({a:vectors[Math.floor(r()*24)],b:vectors[24+Math.floor(r()*72)],y:r()<.6?1:0}));
const models=Array.from({length:12},(_,i)=>new Network(366,16,i+1)),refs=reference(models,vectors),inputs=Array.from({length:6000},()=>vectors[Math.floor(r()*96)]),fast=preparePredictor(models,refs);
const times={fitBaseline:[],fitFast:[],predictBaseline:[],predictFast:[]};
const timed=(key,fn)=>{const t=performance.now(),result=fn();times[key].push(performance.now()-t);return result;};
for(let round=0;round<4;round++){
 const fitted={};for(const cacheForward of (round%2?[true,false]:[false,true]))fitted[cacheForward]=timed(cacheForward?'fitFast':'fitBaseline',()=>train(new Network(366,16,42),samples,{seed:7,epochs:3,cacheForward}).toJSON());assert.deepEqual(fitted.true,fitted.false);
 const values={};for(const optimized of (round%2?[true,false]:[false,true]))values[optimized]=timed(optimized?'predictFast':'predictBaseline',()=>inputs.map(optimized?fast:x=>predict(models,x,refs)));assert.deepEqual(values.true,values.false);
}
const median=xs=>xs.slice(1).sort((a,b)=>a-b)[1],summary=Object.fromEntries(Object.entries(times).map(([k,v])=>[k,median(v)]));
console.log(JSON.stringify({input:366,hidden:16,models:12,fixtures:4096,epochs:3,candidates:6000,referenceOpponents:96,parity:'exact',medianMilliseconds:summary,fitSpeedup:summary.fitBaseline/summary.fitFast,predictSpeedup:summary.predictBaseline/summary.predictFast,times},null,2));
