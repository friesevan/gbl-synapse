'use strict';
const {random}=require('../utils.cjs');
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
// A real dense neural network: input -> tanh hidden layer -> sigmoid score.
// Adam updates every weight by backpropagation; no Python/npm dependency needed.
class Network{
 constructor(input,hidden=24,seed=1){
  this.input=input;this.hidden=hidden;const r=random(seed);
  this.w1=Float64Array.from({length:input*hidden},()=> (r()*2-1)*Math.sqrt(6/(input+hidden)));this.b1=new Float64Array(hidden);
  this.w2=Float64Array.from({length:hidden},()=> (r()*2-1)*Math.sqrt(6/(hidden+1)));this.b2=new Float64Array(1);
 }
 forward(x){if(x.length!==this.input)throw Error('Nonfinite or wrong-dimensional features');const h=new Float64Array(this.hidden);for(let j=0;j<this.hidden;j++){let z=this.b1[j];for(let i=0;i<this.input;i++)z+=x[i]*this.w1[j*this.input+i];if(!Number.isFinite(z))throw Error('Nonfinite features or neural weights');h[j]=Math.tanh(z);}let z=this.b2[0];for(let j=0;j<this.hidden;j++)z+=h[j]*this.w2[j];return {h,z,y:sigmoid(z)};}
 predict(x){return this.forward(x).y;}
 gradient(x,target){const {h,y}=this.forward(x),error=(y-target)*y*(1-y);const g=[new Float64Array(this.w1.length),new Float64Array(this.b1.length),new Float64Array(this.w2.length),Float64Array.of(error)];for(let j=0;j<this.hidden;j++){g[2][j]=error*h[j];const d=error*this.w2[j]*(1-h[j]*h[j]);g[1][j]=d;for(let i=0;i<this.input;i++)g[0][j*this.input+i]=d*x[i];}return {loss:.5*(y-target)**2,g};}
 train(samples,{epochs=20,rate=.003,seed=1,batch=32}={}){
  if(!samples.length)return;const arrays=[this.w1,this.b1,this.w2,this.b2],m=arrays.map(a=>new Float64Array(a.length)),v=arrays.map(a=>new Float64Array(a.length));const r=random(seed);let step=0;
  for(let epoch=0;epoch<epochs;epoch++){
   const order=samples.map((_,i)=>i);for(let i=order.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
   for(let start=0;start<order.length;start+=batch){const grads=arrays.map(a=>new Float64Array(a.length)),n=Math.min(batch,order.length-start);
    for(let q=0;q<n;q++){const s=samples[order[start+q]];if(!Number.isFinite(s.y)||s.y<0||s.y>1)throw Error('Invalid neural target');const {g}=this.gradient(s.x,s.y);for(let a=0;a<g.length;a++)for(let i=0;i<g[a].length;i++)grads[a][i]+=g[a][i]/n;}
    step++;const c1=1-.9**step,c2=1-.999**step;
    for(let a=0;a<arrays.length;a++)for(let i=0;i<arrays[a].length;i++){const g=Math.max(-1,Math.min(1,grads[a][i]+(a%2===0?.00001*arrays[a][i]:0)));m[a][i]=.9*m[a][i]+.1*g;v[a][i]=.999*v[a][i]+.001*g*g;arrays[a][i]-=rate*(m[a][i]/c1)/(Math.sqrt(v[a][i]/c2)+1e-8);}
   }
  }
 }
 toJSON(){return {input:this.input,hidden:this.hidden,w1:Array.from(this.w1),b1:Array.from(this.b1),w2:Array.from(this.w2),b2:Array.from(this.b2)};}
 static fromJSON(s){const n=new Network(s.input,s.hidden);for(const k of ['w1','b1','w2','b2']){if(s[k].length!==n[k].length||s[k].some(x=>!Number.isFinite(x)))throw Error('Invalid saved network');n[k]=Float64Array.from(s[k]);}return n;}
}
function trainEnsemble(samples,{seed=1,epochs=20,hidden=24,size=3}={}){if(!samples.length)throw Error('Need neural samples');return Array.from({length:size},(_,i)=>{const r=random(seed+i*991),bootstrap=Array.from({length:samples.length},()=>samples[Math.floor(r()*samples.length)]);const n=new Network(samples[0].x.length,hidden,seed+i*919);n.train(bootstrap,{epochs,seed:seed+i*431});return n;});}
function predict(models,x){const values=models.map(n=>n.predict(x)),mean=values.reduce((s,v)=>s+v,0)/values.length;return {mean,uncertainty:Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length)};}
module.exports={Network,trainEnsemble,predict};
