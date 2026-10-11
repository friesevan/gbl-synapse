const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
require('./includes/pro/core.js');const {calculateMetaWeights,weightPrior}=PvPPro;
const base=path.join(__dirname,'includes/pro');
function run(mode='generate',options={}){
 const ctx=vm.createContext({console:{log(){}},setInterval(){},clearInterval(){},setTimeout,JSON,Math,Date});const messages=[];ctx.self=ctx;ctx.addEventListener=()=>{};ctx.postMessage=m=>messages.push(JSON.parse(JSON.stringify(m)));ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(base,f),'utf8'),ctx));vm.runInContext(fs.readFileSync(path.join(base,'worker.js'),'utf8'),ctx);
 const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json'))),published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall,overrides=JSON.parse(fs.readFileSync(path.join(base,'data/overrides-1500.json')));
 if(options.forbidSimulations)vm.runInContext("Battle.prototype.simulate=function(){throw new Error('Unexpected battle simulation');}",ctx);
 ctx.onmessage({data:{mode,data,cp:1500,published,roster:published.slice(0,5).map(r=>({speciesId:r.speciesId,weight:1})),defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1])),weightMode:'calculate',policy:'top',topN:1,...options}});assert.ok(!messages.some(m=>m.type==='error'),JSON.stringify(messages.filter(m=>m.type==='error')));return messages;
}
test('fractional floor prevents a large weak tail overwhelming a few strong opponents',()=>{
 const rows=Array.from({length:1000},(_,i)=>({speciesId:String(i),score:i<3?95:30,weight:i<3?40-i*10:1})),matrix=rows.map((_,i)=>rows.map((_,j)=>i===j?.5:i<3?.75:.2));
 const model=calculateMetaWeights(rows,matrix);assert.ok(model.converged);assert.ok(model.lowPriorShare<.01);assert.ok(model.minimum>0&&model.minimum<.001);assert.equal(model.maximum,40);assert.ok(Math.abs(model.entries.reduce((s,e)=>s+e.share,0)-1)<1e-12);assert.ok(model.effectiveOpponents<5);
});
test('deterministic weights ignore diagonal and are invariant to roster ordering',()=>{
 const rows=[{speciesId:'a',score:95,weight:40},{speciesId:'b',score:90,weight:15},{speciesId:'c',score:80,weight:1}],matrix=[[.5,.8,.9],[.2,.5,.7],[.1,.3,.5]],first=calculateMetaWeights(rows,matrix);
 assert.deepEqual(calculateMetaWeights(rows,matrix),first);
 const reordered=calculateMetaWeights(rows.slice().reverse(),matrix.slice().reverse().map(r=>r.slice().reverse()));for(let i=0;i<3;i++)assert.ok(Math.abs(first.entries[i].weight-reordered.entries[2-i].weight)<1e-10);
 const diagonal=matrix.map((r,i)=>r.map((v,j)=>i===j?1:v));assert.deepEqual(calculateMetaWeights(rows,diagonal),first);
});
test('performance-only mode promotes a counter and reacts to changing matchups',()=>{
 const rows=[{speciesId:'a',score:95,weight:40},{speciesId:'b',score:90,weight:20},{speciesId:'c',score:60,weight:1}],good=[[.5,.7,.1],[.3,.5,.8],[.9,.2,.5]],bad=good.map(r=>r.slice());bad[2]=[.1,.1,.5];
 const best=calculateMetaWeights(rows,good,{guidance:0}),worst=calculateMetaWeights(rows,bad,{guidance:0});assert.ok(best.entries[2].weight>worst.entries[2].weight*3);assert.ok(best.entries[2].weight>weightPrior(rows)[2]);assert.ok(best.converged&&worst.converged);
});
test('ties retain diversity, tiny rosters remain finite and unfinished iterations are explicit',()=>{
 const rows=[{speciesId:'a',score:90,weight:1},{speciesId:'b',score:90,weight:1}],matrix=[[.5,.5],[.5,.5]],model=calculateMetaWeights(rows,matrix,{guidance:0});assert.equal(model.effectiveOpponents,2);assert.equal(model.entries[0].weight,40);assert.equal(model.entries[1].weight,40);
 const unfinished=calculateMetaWeights([{...rows[0],weight:40},rows[1]],[[.5,.1],[.9,.5]],{maxIterations:1,guidance:0});assert.equal(unfinished.converged,false);assert.ok(unfinished.entries.every(r=>Number.isFinite(r.weight)&&r.weight>0));
});
test('invalid matrices and model parameters are rejected',()=>{
 const r=[{speciesId:'a',score:90},{speciesId:'b',score:80}],m=[[.5,.6],[.4,.5]];for(const settings of [{guidance:-1},{guidance:NaN},{temperature:0},{peak:Infinity},{maxIterations:0},{tolerance:0}])assert.throws(()=>calculateMetaWeights(r,m,settings));assert.throws(()=>calculateMetaWeights(r,[[.5,NaN],[.5,.5]]));assert.throws(()=>calculateMetaWeights(r.slice(0,1),[[.5]]));
});
test('calculated generation saves exact weights and reuses all baseline simulations',()=>{
 const messages=run(),model=messages.find(m=>m.type==='weights').model,result=messages.find(m=>m.type==='result');assert.ok(model.converged);assert.equal(model.entries.length,5);assert.equal(result.summary.weightSimulations,100);assert.equal(result.summary.simulations,100);assert.equal(result.weightModel.version,PvPPro.weightModelVersion);
 for(const entry of model.entries)assert.equal(result.targets.find(r=>r.speciesId===entry.speciesId).weight,entry.weight);assert.ok(result.rows.every(r=>Number.isFinite(r.score)));
});
test('weight estimates are independent of candidate moveset count and available as a preview',()=>{
 const preview=run('weights').find(m=>m.type==='weights').model,multiple=run('generate',{topN:2}).find(m=>m.type==='result').weightModel;assert.deepEqual(multiple.entries,preview.entries);assert.equal(multiple.guidance,.75);
});
test('calculated category scoring uses frozen weights without a second meta weighting',()=>{
 const targets=[{speciesId:'a',weight:10},{speciesId:'b',weight:.001},{speciesId:'c',weight:1}];const candidate=[{speciesId:'a',matches:[{adjRating:500},{adjRating:600},{adjRating:400}]}];const baselines=targets.map(t=>({speciesId:t.speciesId,matches:targets.map(()=>({adjRating:500}))}));const other=baselines.map((r,i)=>({...r,matches:targets.map(()=>({adjRating:i===0?800:100}))}));
 assert.deepEqual(PvPPro.categoryScores(candidate,baselines,targets,'leads',true),PvPPro.categoryScores(candidate,other,targets,'leads',true));
});

test('post-simulation reweighting reproduces original scores and supports repeated mode changes',()=>{
 const result=run('generate',{topN:2}).find(m=>m.type==='result');
 const report={_targets:result.targets,_weightModel:result.weightModel,overall:result.rows,...Object.fromEntries(result.categories.map(c=>[c.slug,c.rows]))};
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall,overrides=JSON.parse(fs.readFileSync(path.join(base,'data/overrides-1500.json'))),settings={published,defaultWeights:Object.fromEntries(overrides.map(r=>[r.speciesId,r.weight??1]))};
 const original=PvPPro.rescoreRankings(report,{...settings,mode:'original'});
 for(const slug of ['overall','leads','closers','switches','chargers','attackers'])assert.deepEqual(original[slug].map(r=>[r.variantId,r.score]),report[slug].map(r=>[r.variantId,r.score]));
 const equal=PvPPro.rescoreRankings(original,{...settings,mode:'equal'});assert.ok(equal._targets.every(t=>t.weight===1));assert.ok(equal.overall.some(r=>r.score!==original.overall.find(o=>o.variantId===r.variantId).score));
 const restored=PvPPro.rescoreRankings(equal,{...settings,mode:'original'});assert.deepEqual(restored.overall.map(r=>[r.variantId,r.score]),original.overall.map(r=>[r.variantId,r.score]));
 const calculated=PvPPro.rescoreRankings(equal,{...settings,mode:'calculate',guidance:.75});for(let i=0;i<result.targets.length;i++)assert.ok(Math.abs(calculated._targets[i].weight-result.targets[i].weight)<1e-10);
 assert.deepEqual(report._targets,result.targets);assert.equal(report._weightReference,undefined);
 const manual={...original,_targets:original._targets.map((t,i)=>({...t,weight:i===0?.01:1}))};const edited=PvPPro.rescoreRankings(manual,{...settings,mode:'manual'});assert.equal(edited._targets[0].weight,.01);
 const incomplete=JSON.parse(JSON.stringify(report));incomplete.leads[0].matches=[];assert.throws(()=>PvPPro.rescoreRankings(incomplete,settings),/incomplete/);
});

test('saved reports missing charger metadata can be reweighted with battle simulation forbidden',()=>{
 const result=run('generate',{weightMode:'equal',topN:1}).find(m=>m.type==='result'),report={_targets:result.targets,overall:result.rows,...Object.fromEntries(result.categories.map(c=>[c.slug,c.rows]))};
 for(const slug of ['leads','closers','switches','chargers','attackers'])for(const row of report[slug])delete row.chargerFactor;
 const updated=run('reweight',{report,settings:{mode:'equal'},forbidSimulations:true}).find(m=>m.type==='reweighted');assert.equal(updated.simulations,0);assert.deepEqual(updated.report.overall.map(r=>[r.variantId,r.score]),report.overall.map(r=>[r.variantId,r.score]));
});

test('top N opponents use assigned weights, default fallback and deterministic ties',()=>{
 const rows=[{speciesId:'a',weight:1},{speciesId:'b',weight:8},{speciesId:'c',weight:1},{speciesId:'d',weight:0}];assert.deepEqual(PvPPro.chooseOpponents(rows,2,{a:10,c:30}).map(r=>r.speciesId),['b','c']);assert.deepEqual(PvPPro.chooseOpponents([{speciesId:'a'},{speciesId:'b'},{speciesId:'c'}],2,{a:2,b:30,c:10}).map(r=>r.speciesId),['b','c']);assert.deepEqual(PvPPro.chooseOpponents(rows,null),rows);assert.throws(()=>PvPPro.chooseOpponents(rows,1));
});
test('opponent limit retains all candidates, reduces simulations, and supports extra score snapshots',()=>{
 const result=run('generate',{weightMode:'equal',topN:1,opponentLimit:2}).find(m=>m.type==='result');assert.equal(result.targets.length,2);assert.equal(result.rows.length,5);assert.equal(result.summary.opponents,2);assert.equal(result.summary.simulations,40);for(const category of result.categories)for(const row of category.rows)assert.equal(row.matches.length,result.targets.some(t=>t.speciesId===row.speciesId)?1:2);
 const report={_targets:result.targets,overall:result.rows,...Object.fromEntries(result.categories.map(c=>[c.slug,c.rows]))},before=JSON.stringify(report),rescored=PvPPro.rescoreRankings(report,{mode:'equal'}),column=PvPPro.scoreColumn(rescored,{mode:'equal',id:'extra'});assert.equal(JSON.stringify(report),before);assert.equal(column.label,'Equal');assert.equal(column.targets.length,2);assert.equal(Object.keys(column.scores.overall).length,5);for(const row of report.overall)assert.equal(column.scores.overall[row.variantId],row.score);
 const calculated=PvPPro.rescoreRankings(report,{mode:'calculate',guidance:.5});assert.ok(calculated.overall.every(r=>Number.isFinite(r.score)));assert.equal(PvPPro.scoreColumn(calculated,{mode:'calculate',guidance:.5}).label,'50%');
});

test('candidate rank limits use published league order within the filtered pool, independently of weights',()=>{
 const published=[{speciesId:'a'},{speciesId:'b'},{speciesId:'c'},{speciesId:'d'},{speciesId:'e'}],eligible=[{speciesId:'e',weight:900},{speciesId:'c',weight:20},{speciesId:'b',weight:1},{speciesId:'d',weight:40}],before=JSON.stringify(eligible);
 assert.deepEqual(PvPPro.chooseCandidates(eligible,published,3).map(r=>r.speciesId),['b','c','d']);assert.equal(JSON.stringify(eligible),before);assert.deepEqual(PvPPro.chooseCandidates(eligible,published,null),eligible);
 const candidates=PvPPro.chooseCandidates(eligible,published,3),opponents=PvPPro.chooseOpponents(candidates,2);assert.deepEqual(opponents.map(r=>r.speciesId),['d','c']);assert.equal(candidates.length,3);
 for(const limit of [1,0,2.5,NaN,10001])assert.throws(()=>PvPPro.chooseCandidates(eligible,published,limit));assert.deepEqual(PvPPro.chooseCandidates(eligible,published,100),[eligible[2],eligible[1],eligible[3],eligible[0]]);
});
test('published score columns map category references to every species variant without simulating',()=>{
 const report={overall:[{speciesId:'a',variantId:'a:recommended',score:99},{speciesId:'a',variantId:'a:alternate',score:80},{speciesId:'missing',variantId:'missing',score:70}],leads:[{speciesId:'a',variantId:'a:alternate',score:50}]};
 const league={overall:[{speciesId:'a',score:92.3}],leads:[{speciesId:'a',score:88.1}]};const before=JSON.stringify(report),column=PvPPro.publishedScoreColumn(report,league,{id:'published-test'});
 assert.equal(column.mode,'published');assert.equal(column.label,'PvPoke');assert.deepEqual(column.targets,[]);assert.equal(column.scores.overall['a:recommended'],92.3);assert.equal(column.scores.overall['a:alternate'],92.3);assert.equal(column.scores.leads['a:alternate'],88.1);assert.equal(column.scores.overall.missing,undefined);assert.deepEqual(column.scores.closers,{});assert.equal(JSON.stringify(report),before);
});
test('new ranking columns follow the rightmost column of their kind after arbitrary reordering',()=>{
 const base=['rank','pokemon','score:primary','score:equal','score:new','diff:old','diff:new','moves'];
 assert.deepEqual(PvPPro.rankingColumnOrder(base,['rank','score:equal','pokemon','diff:old','moves','score:primary']),['rank','score:equal','pokemon','diff:old','diff:new','moves','score:primary','score:new']);
 assert.deepEqual(PvPPro.rankingColumnOrder(base,[]),base);
 assert.deepEqual(PvPPro.rankingColumnOrder(['rank','score:a','score:b','diff:new','moves'],['rank','score:b','moves','score:a']),['rank','score:b','moves','score:a','diff:new']);
 assert.deepEqual(PvPPro.rankingColumnOrder(['rank','score:a'],['removed','rank','score:a','score:a']),['rank','score:a']);
});
