#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const {features,digest}=require('./common.cjs');const {Network}=require('./neural.cjs');
const [checkpoint,poolFile]=process.argv.slice(2);if(!checkpoint||!poolFile)throw Error('Pass checkpoint.json and pool.json');
const state=JSON.parse(fs.readFileSync(checkpoint)),pool=JSON.parse(fs.readFileSync(poolFile));
const samples=state.records.map(r=>({x:features(r.team,pool.variants),y:r.reward/r.games,fold:parseInt(digest(r.team.join(',')).slice(0,8),16)%5}));
const results=[];
for(const hidden of [4,8,16,24,48])for(const epochs of [15,50,150]){
 let sq=0,constantSq=0,mae=0,n=0;
 for(let fold=0;fold<5;fold++){
  const train=samples.filter(s=>s.fold!==fold),test=samples.filter(s=>s.fold===fold);if(!train.length||!test.length)continue;
  const network=new Network(train[0].x.length,hidden,321+fold);network.train(train,{epochs,seed:911+fold});const mean=train.reduce((s,r)=>s+r.y,0)/train.length;
  for(const r of test){const error=network.predict(r.x)-r.y;sq+=error**2;mae+=Math.abs(error);constantSq+=(mean-r.y)**2;n++;}
 }
 results.push({hidden,epochs,n,mse:sq/n,mae:mae/n,constantMSE:constantSq/n,improvement:1-sq/constantSq});
}
results.sort((a,b)=>a.mse-b.mse);console.log(JSON.stringify({teams:samples.length,input:samples[0]?.x.length,results},null,2));
