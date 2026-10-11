'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Network}=require('./neural.cjs');const {matchup,gradient,train,reference,predict}=require('./pairwise.cjs');
test('pairwise cross-entropy gradient matches numerical derivatives and swapping teams complements probabilities',()=>{const n=new Network(2,4,11),a=[.2,.8],b=[.7,.1],y=.75,{g}=gradient(n,a,b,y),arrays=[n.w1,n.b1,n.w2,n.b2];for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const old=arrays[k][i],eps=1e-5;arrays[k][i]=old+eps;const plus=gradient(n,a,b,y).loss;arrays[k][i]=old-eps;const minus=gradient(n,a,b,y).loss;arrays[k][i]=old;assert.ok(Math.abs(g[k][i]-(plus-minus)/(2*eps))<1e-7);}assert.ok(Math.abs(matchup(n,a,b)+matchup(n,b,a)-1)<1e-12);});
test('pairwise neural ranker learns nonlinear strength and ranks against a reference population',()=>{
 const points=Array.from({length:12},(_,i)=>[i/11,1-i/11]);const strength=x=>Math.sin(x[0]*Math.PI*1.7)*2;const samples=points.flatMap(a=>points.map(b=>({a,b,y:1/(1+Math.exp(-(strength(a)-strength(b))))})));
 const n=train(new Network(2,12,72),samples,{epochs:360,rate:.007,seed:91});const mse=samples.reduce((s,r)=>s+(matchup(n,r.a,r.b)-r.y)**2,0)/samples.length;assert.ok(mse<.003,'MSE '+mse);
 const ref=reference([n],points),high=predict([n],points[3],ref),low=predict([n],points[11],ref);assert.ok(high.mean>low.mean);assert.equal(high.uncertainty,0);
});
