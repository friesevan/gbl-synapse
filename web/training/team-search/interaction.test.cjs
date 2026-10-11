'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Network,gradient,matchup,train}=require('./interaction.cjs');
test('interaction gradients respect antisymmetric paired parameters and swapping teams',()=>{
 const n=new Network(3,4,79);for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){n.interaction[i*4+j]=.2;n.interaction[j*4+i]=-.2;}const a=[.2,.1,.9],b=[.6,.4,.1],y=.8,{g}=gradient(n,a,b,y),arrays=[n.w1,n.b1,n.w2,n.b2];
 for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const old=arrays[k][i],eps=1e-5;arrays[k][i]=old+eps;const plus=gradient(n,a,b,y).loss;arrays[k][i]=old-eps;const minus=gradient(n,a,b,y).loss;arrays[k][i]=old;assert.ok(Math.abs(g[k][i]-(plus-minus)/(2*eps))<1e-7);}
 for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){const upper=i*4+j,lower=j*4+i,old=n.interaction[upper],eps=1e-5;n.interaction[upper]=old+eps;n.interaction[lower]=-old-eps;const plus=gradient(n,a,b,y).loss;n.interaction[upper]=old-eps;n.interaction[lower]=-old+eps;const minus=gradient(n,a,b,y).loss;n.interaction[upper]=old;n.interaction[lower]=-old;assert.ok(Math.abs(g[4][upper]-(plus-minus)/(2*eps))<1e-7);}
 assert.ok(Math.abs(matchup(n,a,b)+matchup(n,b,a)-1)<1e-12);
});
test('neural matchup interactions learn cyclic counters that a scalar strength model cannot represent',()=>{
 const x=[[1,0,0],[0,1,0],[0,0,1]],samples=x.flatMap((a,i)=>x.map((b,j)=>({a,b,y:i===j?.5:(i+1)%3===j?.9:.1})));const n=train(new Network(3,8,41),samples,{epochs:600,rate:.01,batch:9,seed:29});
 const mse=samples.reduce((sum,s)=>sum+(matchup(n,s.a,s.b)-s.y)**2,0)/samples.length;assert.ok(mse<.005,'Cyclic matchup MSE '+mse);const loaded=Network.fromJSON(JSON.parse(JSON.stringify(n)));assert.equal(matchup(loaded,x[0],x[1]),matchup(n,x[0],x[1]));
});

test('training rejects zero batches and invalid optimization limits instead of hanging or skipping fitting',()=>{
 const n=new Network(2,3,10),samples=[{a:[1,0],b:[0,1],y:.5}];
 for(const opts of [{batch:0},{batch:1.5},{epochs:0},{epochs:NaN},{rate:0},{rate:Infinity}])assert.throws(()=>train(n,samples,opts),/configuration/);
});

test('empty or nonfinite inference references fail instead of returning a NaN score',()=>{
 const {reference,predict}=require('./interaction.cjs'),models=[new Network(2,3,8)];
 assert.throws(()=>reference(models,[]),/reference opponents/);
 assert.throws(()=>predict(models,[1,0],[]),/reference panel/);
 assert.throws(()=>predict(models,[1,0],[[]]),/reference panel/);
 assert.throws(()=>predict(models,[1,0],[[{h:[0,0,0],z:NaN}]]),/Nonfinite/);
});
