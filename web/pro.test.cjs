const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const base=path.join(__dirname,'includes/pro');
require('./includes/pro/core.js');
const {validateRoster,enumerate,filterVariants}=globalThis.PvPPro;
function run(mode='generate',options={}){
  const timers=[],messages=[];
  const context=vm.createContext({console:{log(){}},setInterval(fn){timers.push(fn);return timers.length;},clearInterval(){},setTimeout,JSON,Math,Date});
  context.self=context;context.addEventListener=()=>{};context.postMessage=value=>messages.push(JSON.parse(JSON.stringify(value)));
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),context));
  vm.runInContext(fs.readFileSync(path.join(base,'worker.js'),'utf8'),context);
  const data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json'))),published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall;
  const roster=published.slice(0,5).map(row=>({speciesId:row.speciesId,weight:1}));
  context.onmessage({data:{mode,data,cp:1500,published,roster,speciesId:roster[0].speciesId,limit:500,shields:1,...options}});
  for(const fn of timers)fn();
  return messages;
}
test('rejects invalid, duplicate, and unrecognized weighted rosters',()=>{
 const allowed=new Set(['a','b']);
 for(const roster of [[],[{speciesId:'a',weight:1}],[{speciesId:'a',weight:1},{speciesId:'a',weight:2}],[{speciesId:'a',weight:0},{speciesId:'b',weight:1}],[{speciesId:'a',weight:NaN},{speciesId:'b',weight:1}],[{speciesId:'a',weight:1},{speciesId:'c',weight:1}]])assert.throws(()=>validateRoster(roster,allowed));
 assert.equal(validateRoster([{speciesId:'a',weight:.5},{speciesId:'b',weight:1000}],allowed).length,2);
});
test('move enumeration covers combinations without duplicate charged move permutations',()=>{
 assert.deepEqual(enumerate(['F','F'],['A','B','C']),[['F','A','B'],['F','A','C'],['F','B','C']]);
 assert.equal(enumerate(['F','G'],['A','B','C'],['D','E']).length,12);
 assert.deepEqual(enumerate(['F'],['A']),[['F','A','none']]);
});
test('moveset threshold keeps ties and includes boundary scores',()=>{
 const rows=[{rating:800},{rating:1000},{rating:900},{rating:1000}];
 assert.deepEqual(filterVariants(rows,true,10).map(p=>p.rating),[1000,1000]);
 assert.deepEqual(filterVariants(rows,false,10).map(p=>p.rating),[1000,1000,900]);
 assert.equal(filterVariants(rows,false,100).length,4);
});
test('all four leagues include published overall data and five ranking scenarios',()=>{
 for(const cp of [500,1500,2500,10000]){
 const league=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json')));
 for(const category of ['overall','leads','closers','switches','chargers','attackers'])assert.ok(league[category].length>0,cp+' '+category);
 for(const row of league.overall)assert.ok(Number.isFinite(row.score)&&row.moveset.length>=1);
 }
});
test('all moveset candidates rank against recommended-only opponents with unique identities',()=>{
 const messages=run(),result=messages.find(p=>p.type==='result');
 assert.equal(messages.filter(p=>p.type==='error').length,0,JSON.stringify(messages));
 assert.ok(result.rows.length>5);assert.equal(result.categories.length,5);
 assert.equal(new Set(result.rows.map(p=>p.variantId)).size,result.rows.length);
 assert.equal(result.summary.opponents,5);
 assert.equal(result.summary.simulations%5,0);
 assert.ok(result.summary.simulations<=5*(result.rows.length+5)*4);
 assert.equal(result.rows.length,result.summary.totalCombinations);
 assert.equal(new Set(result.rows.map(p=>p.speciesId)).size,5);
 for(const row of result.rows)assert.ok(Number.isFinite(row.score)&&row.score>=0&&row.score<=100);
 assert.ok(result.rows.every((row,i)=>i===0||row.score<=result.rows[i-1].score));
 const ids=[...new Set(result.rows.map(row=>row.speciesId))];
 const changed=run('generate',{roster:ids.map((speciesId,i)=>({speciesId,weight:i===0?20:1}))}).find(p=>p.type==='result');
 assert.notDeepEqual(changed.rows.map(p=>[p.speciesId,p.score]),result.rows.map(p=>[p.speciesId,p.score]));
});
test('moveset lab simulates every combination with bounded ratings and explicit limits',()=>{
 const messages=run('variants'),result=messages.find(p=>p.type==='variants');
 assert.ok(result,JSON.stringify(messages));assert.ok(result.total>1);assert.equal(result.total,result.rows.length);
 for(const row of result.rows){assert.ok(row.rating>=0&&row.rating<=1000);assert.equal(row.matches.length,4);}
 const limited=run('variants',{limit:1});assert.match(limited.find(p=>p.type==='error').error,/exceed/);assert.ok(!limited.some(p=>p.type==='variants'));
});

test('scouted top N respects individual limits and retains every published recommendation',()=>{
 const all=run().find(p=>p.type==='result');const ids=[...new Set(all.rows.map(p=>p.speciesId))];
 const top=run('generate',{policy:'top',topN:2,limits:{[ids[0]]:1}}).find(p=>p.type==='result');
 assert.equal(top.rows.length,9);assert.equal(top.rows.filter(p=>p.speciesId===ids[0]).length,1);
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall;
 const sig=m=>m[0]+'|'+m.slice(1,3).slice().sort().join('|')+'|'+(m[3]||'');
 for(const id of ids){assert.ok(top.rows.filter(p=>p.speciesId===id).some(row=>sig(row.moveset)===sig(published.find(p=>p.speciesId===id).moveset)));}
 assert.ok(top.summary.simulations<all.summary.simulations);assert.equal(top.summary.scoutOpponents,5);
 for(const category of top.categories)assert.equal(new Set(category.rows.map(p=>p.variantId)).size,9);
 assert.ok(top.rows.every(row=>Number.isFinite(row.scoutScore)&&Number.isFinite(row.cycleProjection)));
});
test('recommendation reservation replaces one projected slot without exceeding N',()=>{
 const rows=[{variantId:'a',projection:100},{variantId:'b',projection:90},{variantId:'c',projection:1}];
 assert.deepEqual(PvPPro.seededCandidates(rows,2,rows[2]).map(row=>row.variantId),['a','c']);
 assert.deepEqual(PvPPro.seededCandidates(rows,1,rows[2]).map(row=>row.variantId),['c']);
});
test('projection is intuitive cycle damage per turn and handles no energy generation',()=>{
 assert.equal(PvPPro.cycleDpt({damage:4,turns:2,energyGain:8},[{damage:80,energy:40}]),10);
 assert.equal(PvPPro.cycleDpt({damage:4,turns:2,energyGain:0},[{damage:80,energy:40}]),2);
});
test('rectangular scoring ignores variant population when setting opponent meta weights',()=>{
 const targets=[{speciesId:'a',weight:1},{speciesId:'b',weight:1},{speciesId:'c',weight:1}];
 const row=(id,values)=>({speciesId:id,chargerFactor:1,matches:values.map(adjRating=>({adjRating}))});
 const base=[row('a',[500,650,400]),row('b',[350,500,600]),row('c',[600,400,500])];
 const candidates=[row('a',[500,640,420]),row('b',[360,500,590])];
 const before=PvPPro.categoryScores(candidates,base,targets,'leads').scores;
 const after=PvPPro.categoryScores([...candidates,{...candidates[0]}],base,targets,'leads').scores;
 assert.deepEqual(after.slice(0,2),before);assert.equal(after[2],before[0]);
 assert.deepEqual(base[0].matches.map(m=>m.adjRating),[500,650,400]);
});
test('upstream Include filters support all nine types, AND, and Species override',()=>{
 const league=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))),data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json')));
 const check=filters=>{const m=run('filter',{filters});const result=m.find(p=>p.type==='filtered');assert.ok(result,JSON.stringify(m));return result.ids;};
 assert.ok(check([{filterType:'id',values:['melmetal','altaria']}]).includes('melmetal'));
 const water=check([{filterType:'type',values:['water']}]);assert.ok(water.length>1);assert.ok(water.every(id=>data.pokemon.find(p=>p.speciesId===id).types.includes('water')));
 const override=check([{filterType:'type',values:['water']},{filterType:'id',values:['melmetal']}]);assert.ok(override.includes('melmetal'));
 for(const filter of [{filterType:'tag',values:['shadow']},{filterType:'dex',values:[1,151]},{filterType:'move',values:['COUNTER']},{filterType:'moveType',values:['water']},{filterType:'cost',values:[10000]},{filterType:'distance',values:[1]},{filterType:'evolution',values:[3]}])assert.ok(check([filter]).length>0,filter.filterType);
 const narrowed=check([{filterType:'type',values:['water']},{filterType:'dex',values:[1,151]}]);assert.ok(narrowed.length>0&&narrowed.length<water.length);assert.ok(narrowed.every(id=>data.pokemon.find(p=>p.speciesId===id).dex<=151));
});

test('published zero weights cannot make an explicitly included custom roster invalid',()=>{
 for(const cp of [500,1500,2500,10000]){
  const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json'))).overall;
  const overrides=JSON.parse(fs.readFileSync(path.join(base,'data/overrides-'+cp+'.json')));
  const weights=new Map(overrides.map(row=>[row.speciesId,row.weight]));
  const roster=published.map(row=>({speciesId:row.speciesId,weight:PvPPro.customWeight(weights.get(row.speciesId))}));
  assert.equal(validateRoster(roster,new Set(published.map(row=>row.speciesId))).length,published.length);
 }
 for(const value of [-1,NaN,undefined,Infinity,1001])assert.equal(PvPPro.customWeight(value),1);
 assert.equal(PvPPro.customWeight(0),0);assert.equal(PvPPro.customWeight(.5),.5);assert.equal(PvPPro.customWeight(1000),1000);
 assert.throws(()=>validateRoster([{speciesId:'a',weight:1},{speciesId:'b',weight:0}],new Set(['a','b'])),/at least two Pokémon with weights greater than 0/);
});

test('moveset highlights ignore ordinary charged order but retain fast and extra move differences',()=>{
 const recommended={moveset:['F','A','B','EXTRA']};
 assert.equal(PvPPro.compareMoveset({moveset:['F','B','A','EXTRA'],score:90},recommended,89).kind,'recommended');
 assert.equal(PvPPro.compareMoveset({moveset:['G','B','A','EXTRA'],score:90},recommended,89).kind,'better');
 assert.equal(PvPPro.compareMoveset({moveset:['F','A','EXTRA','B'],score:88},recommended,89).kind,'alternate');
 assert.ok(PvPPro.sameMoveset(['F','A'],['F','A','none']));
 assert.equal(PvPPro.compareMoveset({moveset:['F','X','B'],score:89},recommended,89).kind,'alternate');
 assert.equal(PvPPro.compareMoveset({moveset:['F','X','B'],score:88},recommended,89).kind,'alternate');
 assert.equal(PvPPro.compareMoveset({moveset:['F','X','B'],score:90},recommended,undefined).kind,'alternate');
 assert.equal(PvPPro.compareMoveset({moveset:['F','X','B'],score:90},null,89),null);
});
test('generated moveset comparisons use the same report and category baseline',()=>{
 const result=run('generate',{policy:'top',topN:5}).find(item=>item.type==='result');assert.ok(result);
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall;
 let better=0,alternate=0;
 for(const rows of [result.rows,...result.categories.map(c=>c.rows)])for(const row of rows){
  const recommended=published.find(p=>p.speciesId===row.speciesId),baseline=rows.find(p=>p.speciesId===row.speciesId&&PvPPro.sameMoveset(p.moveset,recommended.moveset));
  assert.ok(baseline);const comparison=PvPPro.compareMoveset(row,recommended,baseline.score);
  if(comparison.kind==='better'){assert.ok(row.score>baseline.score);better++;}
  if(comparison.kind==='alternate'){assert.ok(row.score<=baseline.score);alternate++;}
 }
 assert.ok(better>0);assert.ok(alternate>0);
});

test('custom reports retain every matchup for all five scenarios and replay the exact battle',()=>{
 const report=run('generate',{policy:'top',topN:1}).find(m=>m.type==='result');
 assert.equal(report.targets.length,5);
 for(const category of report.categories){
  const row=category.rows[0];assert.equal(row.matches.length,4);assert.equal(row.scenario,category.slug);
  assert.ok(row.matches.every(m=>Number.isFinite(m.rating)&&Number.isFinite(m.adjRating)));
  const opponent=row.matches[0];
  const messages=run('battle',{row,targets:report.targets,scenario:category.slug,opponent:opponent.opponent});
  const battle=messages.find(m=>m.type==='battle');assert.ok(battle,JSON.stringify(messages));
  assert.equal(battle.rating,opponent.rating);assert.equal(battle.adjRating,opponent.adjRating);
  assert.ok(battle.events.length);assert.equal(battle.fighters.length,2);
  for(let i=0;i<2;i++){
   const damage=battle.events.filter(e=>e.actor!==i&&/^(fast |charged )/.test(e.type)).reduce((sum,e)=>sum+e.damage,0);
   assert.equal(Math.max(0,battle.fighters[i].hp-damage),battle.fighters[i].remaining);
  }
 }
});
test('detail reconstruction includes all opponents, ties and accurate move bonuses',()=>{
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall;
 const row=published.find(r=>r.speciesId==='melmetal'),targets=published.slice(0,8).map(r=>({speciesId:r.speciesId,moveset:r.moveset,weight:1}));
 const result=run('details',{row,targets,scenario:'leads'}).find(m=>m.type==='details');
 assert.ok(result);assert.equal(result.matches.length,7);
 const iron=result.moveInfo.find(m=>m.id==='DOUBLE_IRON_BASH');assert.ok(Math.abs(iron.power-84)<.0001);assert.equal(iron.energy,35);
 const shock=result.moveInfo.find(m=>m.id==='THUNDER_SHOCK');assert.equal(shock.energyGain/shock.turns,4.5);
 const retained=[{opponent:targets[1].speciesId,rating:500,adjRating:500}];
 const saved=run('details',{row,targets,scenario:'leads',matches:retained}).find(m=>m.type==='details');assert.deepEqual(saved.matches,retained);
});

test('zero-weight candidates remain rankable while excluded from opponent scoring',()=>{
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-1500.json'))).overall;
 const roster=published.slice(0,3).map((p,i)=>({speciesId:p.speciesId,weight:i===0?0:1}));
 const result=run('generate',{roster,policy:'top',topN:1}).find(m=>m.type==='result');
 assert.ok(result);assert.equal(result.rows.length,3);assert.ok(result.rows.every(r=>Number.isFinite(r.score)));assert.equal(result.targets[0].weight,0);
});
test('preview exclusions are exact species IDs and cannot be overridden by Includes',()=>{
 const filters=[{filterType:'type',values:['fire']},{filterType:'id',values:['melmetal']}];
 const filtered=run('filter',{filters,excludedIds:['ninetales_shadow']}).find(m=>m.type==='filtered');
 assert.ok(filtered.ids.includes('melmetal'));assert.ok(filtered.ids.includes('ninetales'));assert.ok(!filtered.ids.includes('ninetales_shadow'));
 const none=run('filter',{filters:[{filterType:'type',values:[]}]}).find(m=>m.type==='filtered');assert.equal(none.ids.length,0);
});
