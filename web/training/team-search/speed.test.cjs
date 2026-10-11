'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Network,train,reference,predict,preparePredictor}=require('./interaction.cjs');
const {random}=require('../utils.cjs');
test('cached minibatch fitting preserves all trained parameters exactly across updates and epochs',()=>{
 const r=random(12),vectors=Array.from({length:12},()=>Float64Array.from({length:20},()=>r()*2-1));
 const samples=Array.from({length:137},()=>({a:vectors[Math.floor(r()*12)],b:vectors[Math.floor(r()*12)],y:r()<.6?1:0}));
 for(const batch of [1,16,64,256])assert.deepEqual(train(new Network(20,8,7),samples,{seed:4,epochs:3,batch}).toJSON(),train(new Network(20,8,7),samples,{seed:4,epochs:3,batch,cacheForward:false}).toJSON());
});
test('prepared reference inference preserves scores and uncertainties exactly',()=>{
 const r=random(22),vectors=Array.from({length:25},()=>Float64Array.from({length:20},()=>r()*2-1));
 const models=[new Network(20,8,1),new Network(20,8,2)],refs=reference(models,vectors.slice(0,12)),fast=preparePredictor(models,refs);
 vectors.forEach(x=>assert.deepEqual(fast(x),predict(models,x,refs)));
 assert.throws(()=>preparePredictor(models,[]),/reference/);
 const invalid=structuredClone(refs);invalid[0][0].h[0]=NaN;assert.throws(()=>preparePredictor(models,invalid),/Nonfinite/);
});
