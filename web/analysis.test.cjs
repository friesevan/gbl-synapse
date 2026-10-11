const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const core=vm.createContext({console});
vm.runInContext(fs.readFileSync('includes/analysis/core.js','utf8'),core);
const {buildReport,moveUpdates}=core.PvPokeAnalysis;
const xl={non_shadow:{'45':118},shadow:{'45':141}};
const pokemon=(id,types=['grass','poison'])=>({speciesId:id,speciesName:id,baseStats:{atk:100,def:120,hp:130},types,fastMoves:['FAST'],chargedMoves:['CHARGE','OTHER'],defaultIVs:{cp1500:[45,0,15,15]}});
const moves=[{moveId:'FAST',name:'Fast',type:'grass',power:4,energyGain:8,turns:2},{moveId:'CHARGE',name:'Charge',type:'poison',power:60,energy:40},{moveId:'OTHER',name:'Other',type:'grass',power:60,energy:40}];
const rank=(id,score,moveset=['FAST','CHARGE','OTHER'])=>({speciesId:id,speciesName:id,score,moveset});
function snapshot(rankings,p=[pokemon('test')],m=moves){return {rankings,pokemon:p,moves:m};}
test('scores differ from ordinal ranks and equal snapshots have no changes',()=>{
 const a=snapshot([rank('test',90)]);const report=buildReport(a,a,'1500',xl);
 assert.equal(report.rows[0].Score,90);assert.equal(report.rows[0].Rank,1);assert.equal(report.rows[0].Difference,0);assert.equal(report.rows[0].Update,'');assert.equal(report.rows[0].XL,118);
 assert.equal(report.types.length,2);assert.equal(report.types[0].Difference,0);
});
test('moveset comparisons ignore charged move order and pair additions/removals',()=>{
 const old=snapshot([rank('test',90)]);
 let result=buildReport(old,snapshot([rank('test',95,['FAST','OTHER','CHARGE'])]),'1500',xl).rows[0];
 assert.equal(result['Moveset Change'],'');assert.equal(result.Difference,5);
 result=buildReport(old,snapshot([rank('test',80,['OTHER','FAST','CHARGE'])]),'1500',xl).rows[0];
 assert.match(result['Moveset Change'],/Fast → Other/);assert.match(result['Moveset Change'],/Other → Fast/);assert.equal(result.Difference,-10);
});
test('move changes classify power, energy, turns, mechanics and new moves',()=>{
 const updated=[{...moves[0],power:5},{...moves[1],power:80,energy:50},{...moves[2],power:40},{moveId:'NEW',name:'New',type:'water'}];
 const changes=moveUpdates(moves,updated);
 assert.equal(changes.get('FAST').kind,'buff');assert.equal(changes.get('CHARGE').kind,'rework');assert.equal(changes.get('OTHER').kind,'nerf');assert.equal(changes.get('NEW').kind,'new');
 assert.equal(moveUpdates([moves[0]],[{...moves[0],turns:1}]).get('FAST').kind,'buff');
 assert.equal(moveUpdates([moves[0]],[{...moves[0],buffApplyChance:1}]).get('FAST').kind,'rework');
});
test('shadow new availability uses base species and correct XL table',()=>{
 const oldBase={...pokemon('test'),chargedMoves:['CHARGE']};
 const next=snapshot([rank('test_shadow',92)],[pokemon('test'),pokemon('test_shadow')],[{...moves[0],power:5},...moves.slice(1)]);
 const row=buildReport(snapshot([rank('test_shadow',90)],[oldBase,pokemon('test_shadow')]),next,'1500',xl).rows[0];
 assert.equal(row.XL,141);assert.equal(row.Shadow,'Yes');assert.equal(row['Attack Availability'],'Other');assert.equal(row.Buffs,'Fast');assert.match(row.Update,/New moves/);assert.equal(row.Bulk,15600);assert.equal(row['Stat Product'],1560000);
});
test('new and removed entrants have no invented deltas; type averages use matched cohort',()=>{
 const old=snapshot([rank('test',80),rank('gone',20)],[pokemon('test'),pokemon('gone')]);
 const next=snapshot([rank('test',90),rank('new',100)],[pokemon('test'),pokemon('new')]);
 const report=buildReport(old,next,'1500',xl);
 assert.equal(report.rows.find(row=>row.id==='new').Difference,null);assert.equal(report.rows.find(row=>row.id==='gone').Difference,null);
 assert.equal(report.rows.find(row=>row.id==='gone').Status,'Removed');assert.equal(report.types[0].Difference,10);assert.equal(report.types[0].Compared,1);assert.equal(report.types[0].New,1);assert.equal(report.types[0].Removed,1);
});
test('missing metadata and score produce nulls rather than zeros or NaN',()=>{
 const report=buildReport(snapshot([rank('missing',null)],[]),snapshot([rank('missing',90)],[]),'10000',xl);
 assert.equal(report.rows[0].Difference,null);assert.equal(report.rows[0].Attack,null);assert.equal(report.rows[0].XL,null);
});
function dataContext(fetcher){const c=vm.createContext({fetch:fetcher,URL,URLSearchParams,Date,console});vm.runInContext(fs.readFileSync('includes/analysis/data.js','utf8'),c);return c.PvPokeData;}
test('snapshot resolver uses whole branch commit and inclusive UTC cutoff',async()=>{
 let requested;
 const data=dataContext(async url=>{requested=url;return {ok:true,json:async()=>[{sha:'abc',commit:{committer:{date:'2025-01-01T12:00:00Z'}}}]};});
 const result=await data.resolveSnapshot({branch:'feature/name',date:'2025-01-01',cup:'all'});
 const url=new URL(requested);assert.equal(url.searchParams.get('sha'),'feature/name');assert.equal(url.searchParams.get('until'),'2025-01-01T23:59:59Z');assert.equal(url.searchParams.has('path'),false);assert.equal(result.sha,'abc');
});
test('optional ranking 404 skips league, mandatory data errors remain visible',async()=>{
 const data=dataContext(async url=>url.includes('rankings-2500')?{status:404,ok:false}:{ok:true,json:async()=>[]});
 const result=await data.loadSnapshot({sha:'abc',cup:'all'},['1500','2500']);assert.ok(Array.isArray(result.rankings['1500']));assert.equal(result.rankings['2500'],null);
 const bad=dataContext(async()=>({status:404,ok:false,headers:{get:()=>null}}));await assert.rejects(bad.loadSnapshot({sha:'abc',cup:'bad'},['1500']),/404/);
});
test('API rate limits and empty commit histories report actionable errors',async()=>{
 const limited=dataContext(async()=>({status:403,ok:false,headers:{get:key=>key==='x-ratelimit-remaining'?'0':null}}));await assert.rejects(limited.resolveSnapshot({branch:'master'}),/rate limit/);
 const empty=dataContext(async()=>({ok:true,json:async()=>[]}));await assert.rejects(empty.resolveSnapshot({branch:'master',date:'1900-01-01'}),/No commits/);
});

test('historical cooldown schema normalizes to turns without false nerfs',()=>{
 const historical=[{moveId:'FAST',power:4,energyGain:9,cooldown:1000}];
 const current=[{...historical[0],turns:2}];
 assert.equal(moveUpdates(historical,current).size,0);
 assert.equal(moveUpdates(historical,[{...current[0],turns:1}]).get('FAST').kind,'buff');
 const charged=[{moveId:'CHARGE',power:50,energy:35,cooldown:500}];
 assert.equal(moveUpdates(charged,[{...charged[0],turns:1}]).size,0);
});

test('shadow level uses its own recommended IVs rather than normal form defaults',()=>{
 const base=pokemon('test');const shadow={...pokemon('test_shadow'),defaultIVs:{cp1500:[40,15,15,15]}};
 const data=snapshot([rank('test_shadow',90)],[base,shadow]);const report=buildReport(data,data,'1500',xl);
 assert.equal(report.rows[0].Level,40);assert.equal(report.rows[0].XL,0);
});

test('branch options include every API page',async()=>{
 let requests=0;
 const data=dataContext(async url=>{requests++;const page=new URL(url).searchParams.get('page');return {ok:true,json:async()=>page==='1'?Array.from({length:100},(_,i)=>({name:'branch-'+i})):[{name:'last-branch'}]};});
 const names=await data.branches();assert.equal(names.length,101);assert.equal(names.at(-1),'last-branch');assert.equal(requests,2);
});
