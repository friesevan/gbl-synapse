'use strict';
const {Network:Base}=require('./neural.cjs');const {random}=require('../utils.cjs');
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
class Network extends Base{
 // rank > 0 (opt-in) replaces the free antisymmetric K by K = A Bᵀ − B Aᵀ with A, B of size hidden × rank
 // (rank at most hidden/2 already spans every antisymmetric matrix). `interaction` always holds the current K, so every
 // inference path is unchanged; the factors only matter while fitting. A starts small and random, B at zero, so K starts at 0 like the free matrix.
 constructor(input,hidden=8,seed=1,rank=0){if(!Number.isInteger(input)||input<1||!Number.isInteger(hidden)||hidden<1)throw Error('Invalid neural dimensions');if(!Number.isInteger(rank)||rank<0||rank>hidden)throw Error('Invalid interaction rank');super(input,hidden,seed);this.interaction=new Float64Array(hidden*hidden);if(rank>0){this.rank=rank;const r=random(seed+7919);this.ka=Float64Array.from({length:hidden*rank},()=>(r()*2-1)*.3);this.kb=new Float64Array(hidden*rank);}}
 syncInteraction(){const H=this.hidden,R=this.rank,K=this.interaction;for(let i=0;i<H;i++){K[i*H+i]=0;for(let j=i+1;j<H;j++){let v=0;for(let r=0;r<R;r++)v+=this.ka[i*R+r]*this.kb[j*R+r]-this.kb[i*R+r]*this.ka[j*R+r];K[i*H+j]=v;K[j*H+i]=-v;}}return this;}
 toJSON(){return {...super.toJSON(),interaction:Array.from(this.interaction),...(this.rank?{rank:this.rank,ka:Array.from(this.ka),kb:Array.from(this.kb)}:{})};}
 static fromJSON(s){const rank=s.rank||0,n=new Network(s.input,s.hidden,1,rank),base=Base.fromJSON(s);Object.assign(n,base);if(rank){if(!s.ka||!s.kb||s.ka.length!==n.ka.length||s.kb.length!==n.kb.length||s.ka.some(v=>!Number.isFinite(v))||s.kb.some(v=>!Number.isFinite(v)))throw Error('Invalid neural interaction factors');n.ka=Float64Array.from(s.ka);n.kb=Float64Array.from(s.kb);}if(s.interaction){if(s.interaction.length!==n.hidden*n.hidden||s.interaction.some(v=>!Number.isFinite(v)))throw Error('Invalid neural interaction matrix');n.interaction=Float64Array.from(s.interaction);for(let i=0;i<n.hidden;i++)for(let j=0;j<n.hidden;j++)if(Math.abs(n.interaction[i*n.hidden+j]+n.interaction[j*n.hidden+i])>1e-9)throw Error('Interaction matrix must be antisymmetric');if(rank){const saved=n.interaction;n.interaction=new Float64Array(saved.length);n.syncInteraction();if(saved.some((v,i)=>Math.abs(v-n.interaction[i])>1e-9))throw Error('Interaction matrix does not match its factors');}}else if(rank)n.syncInteraction();return n;}
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
// Low-rank K = A Bᵀ − B Aᵀ: with G the gradient of the antisymmetric pair parameters (G[j][k] = dL/dκ_jk, antisymmetric), dL/dA = G B and dL/dB = −G A.
function lowRankGradients(n,G){const H=n.hidden,R=n.rank,da=new Float64Array(H*R),db=new Float64Array(H*R);for(let i=0;i<H;i++)for(let k=0;k<H;k++){const g=G[i*H+k];if(g===0)continue;for(let r=0;r<R;r++){da[i*R+r]+=g*n.kb[k*R+r];db[i*R+r]-=g*n.ka[k*R+r];}}return [da,db];}
// g[4] is the gradient of the free antisymmetric matrix; with a low-rank interaction g[5] and g[6] are the gradients of its factors A and B.
function gradient(n,a,b,y){const g=[n.w1,n.b1,n.w2,n.b2,n.interaction].map(x=>new Float64Array(x.length)),result=accumulate(n,a,b,y,g);if(n.rank>0)g.push(...lowRankGradients(n,g[4]));return {...result,g};}
function train(n,samples,{epochs=10,rate=.002,seed=1,batch=64,cacheForward=true,l2=1}={}){
 if(!samples.length)throw Error('Need training fixtures');if(!Number.isInteger(epochs)||epochs<1||!Number.isInteger(batch)||batch<1||!Number.isFinite(rate)||rate<=0||!Number.isFinite(l2)||l2<0)throw Error('Invalid neural training configuration');for(const s of samples)if(!Number.isFinite(s.y)||s.y<0||s.y>1)throw Error('Invalid neural training target');
 // l2 scales every weight-decay term (0.0001 on weights, 0.001 on K or on its factors); the default 1 is the production setting.
 const lowRank=n.rank>0,arrays=lowRank?[n.w1,n.b1,n.w2,n.b2,n.ka,n.kb]:[n.w1,n.b1,n.w2,n.b2,n.interaction],decay=arrays.map((_,k)=>(k===4||k===5?.001:k%2===0?.0001:0)*l2),m=arrays.map(a=>new Float64Array(a.length)),v=arrays.map(a=>new Float64Array(a.length)),grads=arrays.map(a=>new Float64Array(a.length)),pairGrad=lowRank?new Float64Array(n.hidden*n.hidden):grads[4],accumulating=lowRank?[grads[0],grads[1],grads[2],grads[3],pairGrad]:grads,r=random(seed),scratch=workspace(n);if(cacheForward)scratch.cache=new Map();let step=0;
 for(let epoch=0;epoch<epochs;epoch++){const order=samples.map((_,i)=>i);for(let i=order.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
 for(let start=0;start<order.length;start+=batch){for(const g of grads)g.fill(0);if(lowRank)pairGrad.fill(0);scratch.cache?.clear();const count=Math.min(batch,order.length-start);for(let q=0;q<count;q++){const s=samples[order[start+q]];accumulate(n,s.a,s.b,s.y,accumulating,1/count,scratch);}if(lowRank){const [da,db]=lowRankGradients(n,pairGrad);grads[4].set(da);grads[5].set(db);}step++;const c1=1-.9**step,c2=1-.999**step;
 for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const g=Math.max(-1,Math.min(1,grads[k][i]+decay[k]*arrays[k][i]));m[k][i]=.9*m[k][i]+.1*g;v[k][i]=.999*v[k][i]+.001*g*g;arrays[k][i]-=rate*(m[k][i]/c1)/(Math.sqrt(v[k][i]/c2)+1e-8);}
 if(lowRank)n.syncInteraction();}
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
module.exports={Network,matchup,gradient,lowRankGradients,train,reference,predict,preparePredictor,logit};
