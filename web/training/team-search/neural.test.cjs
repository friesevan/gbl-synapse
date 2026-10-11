'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Network,trainEnsemble,predict}=require('./neural.cjs');
test('backpropagation matches finite-difference gradients for every parameter group',()=>{
 const n=new Network(3,4,19),x=[.2,.7,-.4],y=.83,{g}=n.gradient(x,y),arrays=[n.w1,n.b1,n.w2,n.b2];
 for(let a=0;a<arrays.length;a++)for(let i=0;i<arrays[a].length;i++){const v=arrays[a][i],eps=1e-5;arrays[a][i]=v+eps;const plus=.5*(n.predict(x)-y)**2;arrays[a][i]=v-eps;const minus=.5*(n.predict(x)-y)**2;arrays[a][i]=v;assert.ok(Math.abs(g[a][i]-(plus-minus)/(2*eps))<1e-7);}
});
test('network learns a nonlinear interaction and survives exact serialization',()=>{
 const samples=Array.from({length:80},(_,i)=>{const a=(i%10)/9,b=Math.floor(i/10)/7;return {x:[a,b],y:Math.abs(a-b)};});
 const n=new Network(2,16,13);n.train(samples,{epochs:450,seed:99,rate:.01,batch:16});
 const mse=samples.reduce((s,r)=>s+(n.predict(r.x)-r.y)**2,0)/samples.length;assert.ok(mse<.005,'MSE '+mse);
 const loaded=Network.fromJSON(JSON.parse(JSON.stringify(n)));for(const r of samples)assert.equal(loaded.predict(r.x),n.predict(r.x));
 assert.throws(()=>loaded.predict([NaN,1]),/Nonfinite/);
});
test('seeded bootstrap ensembles are reproducible and return bounded predictions',()=>{
 const samples=Array.from({length:25},(_,i)=>({x:[i/24,1-i/24],y:i/24}));const a=trainEnsemble(samples,{epochs:10,seed:30}),b=trainEnsemble(samples,{epochs:10,seed:30});
 const pa=predict(a,[.2,.8]),pb=predict(b,[.2,.8]);assert.deepEqual(pa,pb);assert.ok(pa.mean>0&&pa.mean<1&&pa.uncertainty>=0);
});
