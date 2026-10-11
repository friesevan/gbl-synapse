#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {random}=require('../utils.cjs'),{digest}=require('./common.cjs');
const baseline=process.argv[2];if(!baseline)throw Error('Pass a saved baseline interaction.cjs file');
// Resolve the baseline's unchanged helper modules exactly as the current trainer does.
const filename=path.join(__dirname,'interaction.cjs'),beforeText=fs.readFileSync(baseline,'utf8'),before=new Module(filename);before.filename=filename;before.paths=module.paths;before._compile(beforeText,filename);
const libraries=[before.exports,require('./interaction.cjs')],r=random(19),input=366,hidden=16;
const vectors=Array.from({length:128},()=>Float64Array.from({length:input},()=>r()));
const samples=Array.from({length:8000},()=>({a:vectors[Math.floor(r()*vectors.length)],b:vectors[Math.floor(r()*vectors.length)],y:r()<.5?0:1}));
const seconds=[[],[]];let exact=true;
for(let repeat=0;repeat<5;repeat++){
 const models=[];
 for(const i of repeat%2?[1,0]:[0,1]){const start=performance.now(),n=libraries[i].train(new libraries[i].Network(input,hidden,25),samples,{epochs:3,seed:78});seconds[i].push((performance.now()-start)/1000);models[i]=JSON.stringify(n.toJSON());}
 exact=exact&&models[0]===models[1];
}
const median=x=>x.slice().sort((a,b)=>a-b)[Math.floor(x.length/2)],beforeMedian=median(seconds[0]),afterMedian=median(seconds[1]);
console.log(JSON.stringify({baselineHash:digest(beforeText),currentHash:digest(fs.readFileSync(filename,'utf8')),input,hidden,fixtures:samples.length,epochs:3,repeats:5,baselineSeconds:seconds[0],currentSeconds:seconds[1],baselineMedian:beforeMedian,currentMedian:afterMedian,relativeSpeedup:beforeMedian/afterMedian-1,serializedModelsExactlyEqual:exact},null,2));
if(!exact)process.exitCode=1;
