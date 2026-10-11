/* Exhaustive reference vs cheap cycles vs recommended-seeded scout selection.
 * Runs two disjoint rank bands in four leagues. Expect several minutes of CPU.
 * Usage: node scripts/benchmark-pro.cjs [output.json]
 */
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const base=path.resolve(__dirname,'../includes/pro');
const outputPath=path.resolve(process.argv[2]||'work/pro-benchmark.json');
const signature=m=>m[0]+'|'+m.slice(1,3).slice().sort().join('|')+'|'+(m[3]||'');
function run(cp,roster,policy,topN){
 const context=vm.createContext({console:{log(){}},JSON,Math,Date});context.self=context;
 context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),context));
 let result;context.postMessage=value=>{if(value.type==='error')throw new Error(value.error);if(value.type==='result')result=value;};
 vm.runInContext(fs.readFileSync(path.join(base,'worker.js'),'utf8'),context);
 const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json'))),published=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json'))).overall;
 context.onmessage({data:{mode:'generate',data,cp,published,roster,policy,topN}});
 if(!result)throw new Error('No result returned');return result;
}
const report={upstreamCommit:'f627e89e53c0c7b903fff097df7a0ad0ac95decc',adapterSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(base,'worker.js'))).update(fs.readFileSync(path.join(base,'core.js'))).digest('hex'),method:'Two disjoint published rank bands 1–15 and 16–30; each is a 15-species, equal-weight opponent meta in 500/1500/2500/Master. Ground truth is exhaustive five-scenario rectangular ranking. Best means any variant tied for highest truncated Overall score per species. Regret compares selected variants in the exhaustive report, avoiding normalization changes. Recommendation recall is separate from best recall. Scout retains the recommendation by design.',cases:[],runs:[]};
for(const offset of [0,15])for(const cp of [500,1500,2500,10000]){
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json'))).overall.slice(offset,offset+15);
 const roster=published.map(p=>({speciesId:p.speciesId,weight:1}));const full=run(cp,roster,'all',10);
 for(const n of [1,3,5,10]){
  const scout=run(cp,roster,'top',n);report.runs.push({offset,cp,n,fullBattles:full.summary.simulations,scoutBattles:scout.summary.simulations});
  for(const p of published){
   const rows=full.rows.filter(r=>r.speciesId===p.speciesId),cycle=rows.slice().sort((a,b)=>b.cycleProjection-a.cycleProjection||a.variantId.localeCompare(b.variantId)).slice(0,n),retained=new Set(scout.rows.filter(r=>r.speciesId===p.speciesId).map(r=>signature(r.moveset)));
   const chosen=rows.filter(r=>retained.has(signature(r.moveset))),best=rows[0].score;
   report.cases.push({offset,cp,n,speciesId:p.speciesId,total:rows.length,cycleBest:cycle.some(r=>r.score===best),cycleRecommended:cycle.some(r=>signature(r.moveset)===signature(p.moveset)),scoutBest:chosen.some(r=>r.score===best),scoutWithinOne:chosen.some(r=>r.score>=best-1),scoutRecommended:retained.has(signature(p.moveset)),regret:best-Math.max(...chosen.map(r=>r.score))});
  }
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify(report,null,2));
  console.log('Rank band',offset+1,'CP',cp,'N',n,'complete');
 }
}
console.log('Saved benchmark:',outputPath);
