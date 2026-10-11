'use strict';
const {Network}=require('./neural.cjs');const {random}=require('../utils.cjs');
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
function logitGradient(network,x,sign){const {h,z}=network.forward(x);const g=[new Float64Array(network.w1.length),new Float64Array(network.b1.length),new Float64Array(network.w2.length),Float64Array.of(sign)];for(let j=0;j<network.hidden;j++){g[2][j]=sign*h[j];const d=sign*network.w2[j]*(1-h[j]**2);g[1][j]=d;for(let i=0;i<network.input;i++)g[0][j*network.input+i]=d*x[i];}return {z,g};}
function matchup(network,a,b){return sigmoid(network.forward(a).z-network.forward(b).z);}
function gradient(network,a,b,target){const aa=logitGradient(network,a,1),bb=logitGradient(network,b,1),p=sigmoid(aa.z-bb.z),error=p-target;const g=aa.g.map((values,k)=>Float64Array.from(values,(v,i)=>error*(v-bb.g[k][i])));return {p,g,loss:-target*Math.log(Math.max(p,1e-12))-(1-target)*Math.log(Math.max(1-p,1e-12))};}
function train(network,samples,{epochs=15,rate=.002,seed=1,batch=64}={}){
 const arrays=[network.w1,network.b1,network.w2,network.b2],m=arrays.map(a=>new Float64Array(a.length)),v=arrays.map(a=>new Float64Array(a.length)),r=random(seed);let step=0;
 for(let epoch=0;epoch<epochs;epoch++){const order=samples.map((_,i)=>i);for(let i=order.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
 for(let start=0;start<order.length;start+=batch){const grads=arrays.map(a=>new Float64Array(a.length)),n=Math.min(batch,order.length-start);for(let q=0;q<n;q++){const s=samples[order[start+q]],aa=network.forward(s.a),bb=network.forward(s.b),error=(sigmoid(aa.z-bb.z)-s.y)/n;for(let j=0;j<network.hidden;j++){const da=error*network.w2[j]*(1-aa.h[j]**2),db=-error*network.w2[j]*(1-bb.h[j]**2);grads[1][j]+=da+db;grads[2][j]+=error*(aa.h[j]-bb.h[j]);for(let i=0;i<network.input;i++)grads[0][j*network.input+i]+=da*s.a[i]+db*s.b[i];}}
 step++;const c1=1-.9**step,c2=1-.999**step;for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const g=Math.max(-1,Math.min(1,grads[k][i]+(k%2===0?.0001*arrays[k][i]:0)));m[k][i]=.9*m[k][i]+.1*g;v[k][i]=.999*v[k][i]+.001*g*g;arrays[k][i]-=rate*(m[k][i]/c1)/(Math.sqrt(v[k][i]/c2)+1e-8);}}
 }
 return network;
}
function fit(samples,{hidden=12,epochs=15,size=3,seed=1}={}){return Array.from({length:size},(_,i)=>{const r=random(seed+i*991),bootstrap=Array.from({length:samples.length},()=>samples[Math.floor(r()*samples.length)]);return train(new Network(samples[0].a.length,hidden,seed+i*171),bootstrap,{epochs,seed:seed+i*991});});}
function reference(models,opponents){return models.map(n=>opponents.map(x=>n.forward(x).z));}
function predict(models,x,referenceLogits){const values=models.map((n,i)=>{const z=n.forward(x).z;return referenceLogits[i].reduce((sum,op)=>sum+sigmoid(z-op),0)/referenceLogits[i].length;}),mean=values.reduce((s,v)=>s+v,0)/values.length;return {mean,uncertainty:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length)};}
module.exports={matchup,gradient,train,fit,reference,predict};
