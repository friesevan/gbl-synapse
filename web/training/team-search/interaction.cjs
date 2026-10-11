'use strict';
const {Network:Base}=require('./neural.cjs');const {random}=require('../utils.cjs');
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
class Network extends Base{
 constructor(input,hidden=8,seed=1){if(!Number.isInteger(input)||input<1||!Number.isInteger(hidden)||hidden<1)throw Error('Invalid neural dimensions');super(input,hidden,seed);this.interaction=new Float64Array(hidden*hidden);}
 toJSON(){return {...super.toJSON(),interaction:Array.from(this.interaction)};}
 static fromJSON(s){const n=new Network(s.input,s.hidden),base=Base.fromJSON(s);Object.assign(n,base);if(s.interaction){if(s.interaction.length!==n.hidden*n.hidden||s.interaction.some(v=>!Number.isFinite(v)))throw Error('Invalid neural interaction matrix');n.interaction=Float64Array.from(s.interaction);for(let i=0;i<n.hidden;i++)for(let j=0;j<n.hidden;j++)if(Math.abs(n.interaction[i*n.hidden+j]+n.interaction[j*n.hidden+i])>1e-9)throw Error('Interaction matrix must be antisymmetric');}return n;}
}
function projected(n,h,out=new Float64Array(n.hidden)){out.fill(0);for(let i=0;i<n.hidden;i++)for(let j=0;j<n.hidden;j++)out[j]+=h[i]*n.interaction[i*n.hidden+j];return out;}
// Fitting never uses the scalar sigmoid, and its two activations have a fixed size.
// Reuse these buffers per worker instead of allocating five arrays per fixture.
function workspace(n){return {aa:{h:new Float64Array(n.hidden),z:0},bb:{h:new Float64Array(n.hidden),z:0},pa:new Float64Array(n.hidden),pb:new Float64Array(n.hidden)};}
function forwardInto(n,x,out){if(x.length!==n.input)throw Error('Nonfinite or wrong-dimensional features');for(let j=0;j<n.hidden;j++){let z=n.b1[j];for(let i=0;i<n.input;i++)z+=x[i]*n.w1[j*n.input+i];if(!Number.isFinite(z))throw Error('Nonfinite features or neural weights');out.h[j]=Math.tanh(z);}out.z=n.b2[0];for(let j=0;j<n.hidden;j++)out.z+=out.h[j]*n.w2[j];return out;}
function logit(n,a,b){const p=projected(n,a.h);let z=a.z-b.z;for(let j=0;j<n.hidden;j++)z+=p[j]*b.h[j];return z;}
function matchup(n,a,b){return sigmoid(logit(n,n.forward(a),n.forward(b)));}
function accumulate(n,a,b,y,grads,scale=1,scratch=workspace(n)){
 // Weights are constant inside a minibatch. Repeated candidate/opponent
 // vectors can share their forward pass and projection until the Adam update.
 const cached=x=>{let value=scratch.cache.get(x);if(!value){const activation=forwardInto(n,x,{h:new Float64Array(n.hidden),z:0});value={activation,projection:projected(n,activation.h)};scratch.cache.set(x,value);}return value;};
 const ac=scratch.cache?cached(a):null,bc=scratch.cache?cached(b):null;
 const aa=ac?ac.activation:forwardInto(n,a,scratch.aa),bb=bc?bc.activation:forwardInto(n,b,scratch.bb),pa=ac?ac.projection:projected(n,aa.h,scratch.pa),pb=bc?bc.projection:projected(n,bb.h,scratch.pb);let z=aa.z-bb.z;
 for(let j=0;j<n.hidden;j++)z+=pa[j]*bb.h[j];
 const prob=sigmoid(z),error=(prob-y)*scale;
 for(let j=0;j<n.hidden;j++){
  // K is antisymmetric: K*hB = -(hB^T*K); hA^T*K is the derivative for hB.
  const da=error*(n.w2[j]-pb[j])*(1-aa.h[j]**2),db=error*(-n.w2[j]+pa[j])*(1-bb.h[j]**2);
  grads[1][j]+=da+db;grads[2][j]+=error*(aa.h[j]-bb.h[j]);
  for(let i=0;i<n.input;i++)grads[0][j*n.input+i]+=da*a[i]+db*b[i];
  // Each stored upper/lower pair represents one parameter, updated with opposite gradients.
  for(let k=j+1;k<n.hidden;k++){const g=error*(aa.h[j]*bb.h[k]-aa.h[k]*bb.h[j]);grads[4][j*n.hidden+k]+=g;grads[4][k*n.hidden+j]-=g;}
 }
 return {prob,loss:-y*Math.log(Math.max(prob,1e-12))-(1-y)*Math.log(Math.max(1-prob,1e-12))};
}
function gradient(n,a,b,y){const g=[n.w1,n.b1,n.w2,n.b2,n.interaction].map(x=>new Float64Array(x.length));return {...accumulate(n,a,b,y,g),g};}
function train(n,samples,{epochs=10,rate=.002,seed=1,batch=64,cacheForward=true}={}){
 if(!samples.length)throw Error('Need training fixtures');if(!Number.isInteger(epochs)||epochs<1||!Number.isInteger(batch)||batch<1||!Number.isFinite(rate)||rate<=0)throw Error('Invalid neural training configuration');for(const s of samples)if(!Number.isFinite(s.y)||s.y<0||s.y>1)throw Error('Invalid neural training target');
 const arrays=[n.w1,n.b1,n.w2,n.b2,n.interaction],m=arrays.map(a=>new Float64Array(a.length)),v=arrays.map(a=>new Float64Array(a.length)),grads=arrays.map(a=>new Float64Array(a.length)),r=random(seed),scratch=workspace(n);if(cacheForward)scratch.cache=new Map();let step=0;
 for(let epoch=0;epoch<epochs;epoch++){const order=samples.map((_,i)=>i);for(let i=order.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
 for(let start=0;start<order.length;start+=batch){for(const g of grads)g.fill(0);scratch.cache?.clear();const count=Math.min(batch,order.length-start);for(let q=0;q<count;q++){const s=samples[order[start+q]];accumulate(n,s.a,s.b,s.y,grads,1/count,scratch);}step++;const c1=1-.9**step,c2=1-.999**step;
 for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const g=Math.max(-1,Math.min(1,grads[k][i]+(k===4?.001:k%2===0?.0001:0)*arrays[k][i]));m[k][i]=.9*m[k][i]+.1*g;v[k][i]=.999*v[k][i]+.001*g*g;arrays[k][i]-=rate*(m[k][i]/c1)/(Math.sqrt(v[k][i]/c2)+1e-8);}}
 }
 return n;
}
function reference(models,opponents){if(!models.length||!opponents.length)throw Error('Need models and reference opponents');return models.map(n=>opponents.map(x=>n.forward(x)));}
function predict(models,x,refs){
 if(!models.length||refs.length!==models.length||refs.some(rows=>!rows.length))throw Error('Invalid inference reference panel');
 const values=models.map((n,i)=>{const a=n.forward(x),p=projected(n,a.h);return refs[i].reduce((sum,b)=>{let z=a.z-b.z;for(let j=0;j<n.hidden;j++)z+=p[j]*b.h[j];return sum+sigmoid(z);},0)/refs[i].length;});
 const mean=values.reduce((s,v)=>s+v,0)/values.length;
 if(!Number.isFinite(mean))throw Error('Nonfinite inference reference panel or weights');
 return {mean,uncertainty:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length)};
}
// Prepare immutable reference data once and reuse activation/projection buffers.
// Arithmetic order matches predict; scratch stays local to this synchronous scorer.
function preparePredictor(models,refs){
 if(!models.length||refs.length!==models.length||refs.some(rows=>!rows.length))throw Error('Invalid inference reference panel');
 const buffers=models.map((n,i)=>{for(const b of refs[i])if(b.h.length!==n.hidden||!Number.isFinite(b.z)||Array.from(b.h).some(v=>!Number.isFinite(v)))throw Error('Nonfinite inference reference panel or weights');return {a:{h:new Float64Array(n.hidden),z:0},p:new Float64Array(n.hidden)};});
 return x=>{
  const values=models.map((n,i)=>{const a=forwardInto(n,x,buffers[i].a),p=projected(n,a.h,buffers[i].p);return refs[i].reduce((sum,b)=>{let z=a.z-b.z;for(let j=0;j<n.hidden;j++)z+=p[j]*b.h[j];return sum+sigmoid(z);},0)/refs[i].length;});
  const mean=values.reduce((s,v)=>s+v,0)/values.length;if(!Number.isFinite(mean))throw Error('Nonfinite inference reference panel or weights');return {mean,uncertainty:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length)};
 };
}
module.exports={Network,matchup,gradient,train,reference,predict,preparePredictor,logit};
