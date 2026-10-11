/* Reproducible CPU benchmark: node scripts/benchmark-weights.cjs [roster-size=100]. */
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const base=path.resolve(__dirname,'../includes/pro'),count=Number(process.argv[2]||100);
if(!Number.isInteger(count)||count<2||count>2000)throw new Error('Roster size must be 2–2000.');
const summaries=[];
for(const cp of [500,1500,2500,10000]){
 const context=vm.createContext({console:{log(){}},setTimeout,setInterval(){},clearInterval(){},JSON,Math,Date});context.self=context;context.addEventListener=()=>{};let model;
 context.postMessage=m=>{if(m.type==='weights')model=m.model;if(m.type==='error')throw new Error(m.error);};context.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),context));vm.runInContext(fs.readFileSync(path.join(base,'worker.js'),'utf8'),context);
 const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json'))),published=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json'))).overall,overrides=JSON.parse(fs.readFileSync(path.join(base,'data/overrides-'+cp+'.json'))),defaults=new Map(overrides.map(r=>[r.speciesId,r.weight??1]));
 const roster=published.slice(0,count).map(r=>({speciesId:r.speciesId,weight:1}));const started=Date.now();context.onmessage({data:{mode:'weights',data,published,roster,cp,weightGuidance:.75,defaultWeights:Object.fromEntries(defaults)}});
 const original=roster.map(r=>Math.max(0,defaults.get(r.speciesId)??1)),estimated=model.entries.map(r=>r.weight),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),top=new Set(roster.map((r,i)=>({id:r.speciesId,weight:original[i]})).sort((a,b)=>b.weight-a.weight).slice(0,20).map(r=>r.id));
 summaries.push({cp,pokemon:roster.length,milliseconds:Date.now()-started,simulations:model.simulations,converged:model.converged,iterations:model.iterations,residual:model.residual,cosineSimilarity:dot(original,estimated)/Math.sqrt(dot(original,original)*dot(estimated,estimated)),top20Overlap:model.entries.slice().sort((a,b)=>b.weight-a.weight).slice(0,20).filter(r=>top.has(r.speciesId)).length,minimum:model.minimum,maximum:model.maximum,effectiveOpponents:model.effectiveOpponents,bottomHalfShare:model.bottomHalfShare,lowPriorShare:model.lowPriorShare});
}
console.log(JSON.stringify({source:'f627e89e53c0c7b903fff097df7a0ad0ac95decc',model:'adaptive-meta-v1',guidance:.75,summaries},null,2));
