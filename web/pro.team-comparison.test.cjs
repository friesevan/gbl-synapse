const test=require('node:test'),assert=require('node:assert/strict');require('./includes/pro/team-comparison-core.js');const C=TeamComparisonCore;
test('compares identical opponents and seeds, preserving opponent order',()=>{
 const a=[[[1,2,3],10,1],[[1,2,3],11,0],[[3,2,1],10,.5]],b=[[[1,2,3],10,0],[[1,2,3],12,1]];
 assert.deepEqual(C.shared(a,b),[{opponents:[1,2,3],seed:10,a:1,b:0}]);assert.equal(C.stage({screen:a},{screen:b}).name,'screen');assert.equal(C.stage({training:a},{training:[]}).rows.length,0);
});
test('paired improvement, regression and uncertainty use the same fixture panel',()=>{
 const s=C.summarize([{a:1,b:0},{a:0,b:1},{a:1,b:1},{a:1,b:.5}]);assert.equal(s.a,.75);assert.equal(s.b,.625);assert.equal(s.delta,.125);assert.equal(s.better,2);assert.equal(s.worse,1);assert.equal(s.same,1);assert.ok(s.margin>.125);assert.equal(C.summarize([]),null);
});
test('alphabetical bench display preserves the original simulation order and lead',()=>{
 const team=[{speciesName:'Melmetal',speciesId:'melmetal',publishedRank:1,moveset:['A']},{speciesName:'Jumpluff',speciesId:'jumpluff',publishedRank:56,moveset:['B']},{speciesName:'Cramorant',speciesId:'cramorant',publishedRank:4,moveset:['C']}];
 assert.deepEqual(C.bench(team).map(p=>p.speciesName),['Melmetal','Cramorant','Jumpluff']);assert.equal(team[1].speciesId,'jumpluff');assert.deepEqual(C.ranks(team),{minRank:1,maxRank:56,avgRank:61/3});assert.notEqual(C.signature(team),C.signature(C.bench(team)));
});
test('screenshot teams compare on their full shared screening panel',()=>{
 const d=require('./includes/pro/data/team-teams/index.json');const get=id=>{const r=d.rows.find(r=>r.id===id);return require('./includes/pro/data/team-teams/'+r.chunk+'.json')[id];};const panel=C.stage(get(2605),get(804)),s=C.summarize(panel.rows);
 assert.equal(panel.name,'screen');assert.equal(s.n,512);assert.equal(s.a,.63525390625);assert.equal(s.b,.64599609375);assert.equal(s.better,111);assert.equal(s.worse,119);
});
test('move explanations distinguish landed damage, shielding, knockouts and changed outcomes',()=>{
 const event=(shielded,knockout,damage)=>({turn:20,actor:0,type:'charged normal',name:'Return',values:[damage,-70],detail:{moveId:'RETURN',attacker:'corviknight',attackerName:'Corviknight',defenderName:'Target',hpBefore:30,maxHP:100,shielded,knockout}});
 const rows=[{a:1,b:0,evidence:{a:[event(false,true,70)],b:[]}},{a:0,b:0,evidence:{a:[event(true,false,1)],b:[]}}],c={speciesId:'corviknight',a:['RETURN'],b:['IRON_HEAD']},stats=C.moveEvidence(rows,c,'a');
 assert.equal(stats.hits,2);assert.equal(stats.landed,1);assert.equal(stats.shielded,1);assert.equal(stats.knockouts,1);assert.equal(stats.improved,1);assert.equal(stats.damagePercent,15.5);assert.equal(C.moveEvidence(rows,c,'b').hits,0);assert.match(C.eventText(event(false,true,70)),/30 HP damage; knockout/);
});
test('explanations detect a first action difference and find charged move changes regardless of slot order',()=>{
 const a=[{speciesId:'x',speciesName:'X',moveset:['FAST','RETURN','AIR']}],b=[{speciesId:'x',speciesName:'X',moveset:['FAST','AIR','IRON']}];assert.deepEqual(C.changes(a,b),[{speciesId:'x',name:'X',a:['RETURN'],b:['IRON']}]);
 const x={turn:5,actor:0,type:'charged normal',name:'Return'},y={...x,name:'Iron Head'};assert.equal(C.firstDivergence([x],[y]).a,x);assert.equal(C.firstDivergence([x],[x]),null);
});
