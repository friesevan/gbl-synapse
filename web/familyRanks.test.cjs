const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({perfTiming: false, console});
for (const file of ['pokeListObj.js', 'calculate.js', 'familyRanksCore.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'includes', file), 'utf8'), context);
}
const {FamilyRanks: core, pokeListObj: data, calculate} = context;
function ranks(mon, league, floor = 0, min = 1, max = 50) {
  return calculate(...data[mon].split(',').slice(1, 4).map(Number), floor, min, max, false, league, mon);
}
test('base and branching families include all existing members without duplicates', () => {
  assert.equal(core.family('Eevee', data).length, 9);
  assert.ok(core.family('Eevee', data).includes('Sylveon'));
  assert.ok(core.family('Bulbasaur', data).includes('Venusaur'));
  assert.equal(core.family('Unown', data).length, 1);
  assert.equal(core.family('unknown', data).length, 0);
  assert.equal(core.family('Meowth_Galarian', data).join(','), 'Meowth_Galarian,Perrserker');
});
test('Tyrogue single and tied highest IVs permit only possible branches', () => {
  assert.equal(core.eligible('Tyrogue', 'Hitmonlee', [15, 14, 13]), true);
  assert.equal(core.eligible('Tyrogue', 'Hitmontop', [15, 14, 13]), false);
  assert.equal(core.eligible('Tyrogue', 'Hitmonchan', [15, 15, 13]), true);
  assert.equal(core.eligible('Tyrogue', 'Hitmontop', [15, 15, 15]), true);
});
test('all four leagues use complete ranking lists and enforce their CP ceilings', () => {
  for (const [league] of core.leagues) {
    const result = core.summarize(ranks('Venusaur', league), [0, 15, 15]);
    assert.ok(result.rank >= 1 && result.rank <= 4096);
    assert.equal(result.total, 4096);
    assert.ok(result.level <= 50);
    assert.ok(result.perfection > 0 && result.perfection <= 100);
    if (league !== 'ML') assert.ok(result.cp <= Number(league));
  }
});
test('perfect Master League IVs rank first and best-spread mode agrees', () => {
  const list = ranks('Umbreon', 'ML');
  assert.equal(core.summarize(list, [15, 15, 15]).rank, 1);
  assert.equal(core.summarize(list, null).ivs.join('/'), '15/15/15');
});
test('IV floor, impossible CP and Best Buddy levels are respected', () => {
  assert.equal(core.summarize(ranks('Venusaur', '1500', 10), [0, 15, 15]), null);
  assert.equal(core.summarize(ranks('Venusaur', '500', 0, 50), [15, 15, 15]), null);
  assert.equal(core.summarize(ranks('Umbreon', 'ML', 0, 1, 51), [15, 15, 15]).level, 51);
});
test('every IV combination is preserved, including entries sharing ranking keys', () => {
  const list = ranks('Eevee', '500');
  const entries = Object.entries(list).filter(([key, value]) => key !== 'invalids' && Array.isArray(value)).flatMap(([, value]) => value);
  assert.equal(entries.length, 4096);
  assert.equal(new Set(entries.map(entry => [entry.IVs.A, entry.IVs.D, entry.IVs.S].join('/'))).size, 4096);
  const last = entries.at(-1);
  assert.equal(core.summarize(list, [last.IVs.A, last.IVs.D, last.IVs.S]).rank, 4096);
});
test('IV entries all inherit the selected base Pokémon and keep row identifiers', () => {
  const parsed = core.candidatesFromRows([['1','15','15'],['2','15','15']], 'Eevee');
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates.map(candidate => candidate.mon).join(','), 'Eevee,Eevee');
  assert.equal(parsed.candidates[0].ivs.join('/'), '1/15/15');
  assert.equal(parsed.candidates[1].key, 2);
});
test('IV rows preserve duplicate Pokémon and reject missing, fractional or out-of-range IVs', () => {
  const parsed = core.candidatesFromRows([[0,15,15],[0,15,15],['',15,15],[16,2,3],[-1,2,3],[1.5,2,3],[1,2]], 'Eevee');
  assert.equal(parsed.candidates.length, 2);
  assert.notEqual(parsed.candidates[0].key, parsed.candidates[1].key);
  assert.equal(parsed.errors.length, 5);
  assert.equal(core.candidatesFromRows([], 'Eevee').errors.length, 1);
});
test('winners are independent per evolution and league; duplicates tie; invalids never win', () => {
  const rows = [
    {evo:'Umbreon',league:'1500',result:{rank:1}},
    {evo:'Umbreon',league:'1500',result:{rank:1}},
    {evo:'Umbreon',league:'1500',result:{rank:20}},
    {evo:'Umbreon',league:'ML',result:{rank:30}},
    {evo:'Vaporeon',league:'1500',result:{rank:5}},
    {evo:'Vaporeon',league:'1500',result:null}
  ];
  assert.equal(core.markBest(rows).map(row => row.best).join(','), 'true,true,false,true,true,false');
});
test('duplicate IV spreads become one matrix row with references to original entries', () => {
  const candidates = core.candidatesFromRows([[1,15,15],[2,15,15],[1,15,15]], 'Eevee').candidates;
  const unique = core.uniqueCandidates(candidates);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].entryKeys.join(','), '1,3');
  assert.equal(unique[1].ivs.join('/'), '2/15/15');
  assert.equal(candidates[0].entryKeys, undefined);
});
test('column sorting keeps complete IV rows together and places unavailable results last', () => {
  const candidates = core.candidatesFromRows([[1,15,15],[2,15,15],[3,15,15]], 'Eevee').candidates;
  const rows = [
    {evo:'Umbreon',league:'1500',candidate:candidates[0],result:{rank:10}},
    {evo:'Umbreon',league:'1500',candidate:candidates[1],result:{rank:2}},
    {evo:'Umbreon',league:'1500',candidate:candidates[2],result:null},
    {evo:'Vaporeon',league:'ML',candidate:candidates[0],result:{rank:1}},
    {evo:'Vaporeon',league:'ML',candidate:candidates[1],result:{rank:5}}
  ];
  assert.equal(core.sortCandidates(candidates,rows,JSON.stringify(['Umbreon','1500'])).map(row => row.key).join(','),'2,1,3');
  assert.equal(core.sortCandidates(candidates,rows,JSON.stringify(['Vaporeon','ML'])).map(row => row.key).join(','),'1,2,3');
  assert.equal(core.sortCandidates(candidates,rows,'').map(row => row.key).join(','),'1,2,3');
  assert.equal(candidates[0].key,1);
});
test('batch worker ratings agree with the existing calculator, preserve keys and reuse cache', () => {
  const messages = [];
  const worker = vm.createContext({console, postMessage: message => messages.push(message)});
  worker.self = worker;
  worker.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname,'includes',file),'utf8'),worker));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'includes/familyRanksWorker.js'),'utf8'),worker);
  const request = {id:1,mon:'Umbreon',league:'1500',floor:0,min:1,max:50,
    candidates:[{key:1,ivs:[0,15,15]},{key:2,ivs:[2,15,15]},{key:3,ivs:[0,15,15]}]};
  worker.onmessage({data:request}); worker.onmessage({data:{...request,id:2}});
  const expected = core.summarize(ranks('Umbreon','1500'), [0,15,15]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].results.length, 3);
  assert.equal(JSON.stringify(messages[0].results[0].result), JSON.stringify(expected));
  assert.equal(messages[0].results[2].result.rank, expected.rank);
  assert.equal(messages[1].id,2);
  assert.equal(vm.runInContext('cache.size',worker),1);
  const cp = core.cpAtLevel(data.Eevee.split(',').slice(1, 4).map(Number), [1,15,15], 30, context.cpm);
  worker.onmessage({data:{...request, mon:'Vaporeon', candidates:[
    {key:1,mon:'Eevee',ivs:[1,15,15],currentCp:cp},
    {key:2,mon:'Eevee',ivs:[2,15,15],currentCp:1000000}
  ]}});
  assert.equal(messages.at(-1).results[0].result, null);
  assert.match(messages.at(-1).results[0].error, /powering down/);
  assert.equal(messages.at(-1).results[0].levels[0], 30);
  assert.equal(messages.at(-1).results[1].result, null);
  assert.match(messages.at(-1).results[1].error, /does not match/);

  const example = core.candidatesFromRows([[1,15,15],[2,15,15]], 'Eevee').candidates;
  const start = messages.length;
  for (const evo of core.family('Eevee', data)) for (const [league] of core.leagues) {
    worker.onmessage({data:{...request,id:3,mon:evo,league,candidates:example}});
  }
  const comparisons = messages.slice(start);
  assert.equal(comparisons.length, 36); // Eevee + eight evolutions, four leagues.
  assert.equal(comparisons.flatMap(message => message.results).length, 72);
  const allRows = comparisons.flatMap(message => message.results.map(item => ({
    evo:message.mon,league:message.league,candidate:example[item.key - 1],result:item.result
  })));
  assert.ok(allRows.every(row => row.result && row.result.rank > 0));
  assert.equal(new Set(core.markBest(allRows).filter(row => row.best).map(row => row.evo + ':' + row.league)).size, 36);
});

function allocationFixture(costs) {
  const candidates = costs.map((_, i) => ({key:i+1, mon:'Eevee', ivs:[i,15,15]}));
  const columns = costs[0].map((_, i) => ({evo:'Evolution'+i, league:'1500'}));
  const results = candidates.flatMap((candidate,i) => columns.map((column,j) => ({candidate,...column,
    result: costs[i][j] === null ? null : {rank:costs[i][j],total:4096}})));
  return {candidates,columns,results};
}
test('allocation beats greedy rankings and never reuses a spread', () => {
  const f = allocationFixture([[1,2],[2,100]]);
  const plan = core.allocate(f.candidates,f.columns,f.results);
  assert.equal(plan.assignments.length,2);
  assert.equal(plan.totalRank,4);
  assert.equal(new Set(plan.assignments.map(item => item.candidate.key)).size,2);
});
test('locks constrain the optimum; missing candidates leave slots unfilled; invalids never allocate', () => {
  const f = allocationFixture([[1,2],[2,100]]);
  const choices = [{ivs:[0,15,15],...f.columns[0]}];
  const plan = core.allocate(f.candidates,f.columns,f.results,choices);
  assert.equal(plan.totalRank,101);
  assert.equal(plan.assignments[0].locked,true);
  const scarce = allocationFixture([[100,1,null]]);
  const result = core.allocate(scarce.candidates,scarce.columns,scarce.results);
  assert.equal(result.assignments.length,1);
  assert.equal(result.totalRank,1);
  assert.equal(result.unfilled.length,2);
  assert.throws(() => core.allocate(f.candidates,f.columns,f.results,[...choices,{ivs:[0,15,15],...f.columns[1]}]));
});
test('hidden columns do not compete for candidates and empty reports have no allocations', () => {
  const f = allocationFixture([[1,2],[2,100]]);
  const plan = core.allocate(f.candidates,[f.columns[0]],f.results);
  assert.equal(plan.totalRank,1);
  assert.equal(plan.unused.length,1);
  const empty = core.allocate(f.candidates,[],f.results);
  assert.equal(empty.assignments.length,0);
  assert.equal(empty.unused.length,2);
});
test('allocation matches exhaustive search for 100 deterministic small matrices', () => {
  let seed = 31;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial=0;trial<100;trial++) {
    const costs = Array.from({length:1+trial%4}, () => Array.from({length:1+trial%3}, () => random()<.3 ? null : 1+Math.floor(random()*100)));
    const f = allocationFixture(costs);
    let bestCount=-1, bestRank=Infinity;
    function exhaustive(slot,used,count,rank) {
      if (slot===f.columns.length) { if (count>bestCount || (count===bestCount && rank<bestRank)) {bestCount=count;bestRank=rank;} return; }
      exhaustive(slot+1,used,count,rank);
      for (let i=0;i<costs.length;i++) if (!used.has(i) && costs[i][slot]!==null) {
        used.add(i);exhaustive(slot+1,used,count+1,rank+costs[i][slot]);used.delete(i);
      }
    }
    exhaustive(0,new Set(),0,0);
    const plan = core.allocate(f.candidates,f.columns,f.results);
    assert.equal(plan.assignments.length,bestCount,'coverage trial '+trial);
    assert.equal(plan.totalRank,bestRank,'rank trial '+trial);
  }
});
test('saved search round-trips exact Applin columns, IVs, settings and choices', () => {
  const state = {mon:'Applin',ivs:[[1,15,15],[2,15,15]],floor:0,min:1,max:50,
    columns:[['Applin','500'],['Flapple','1500'],['Appletun','1500'],['Hydrapple','1500'],['Hydrapple','ML']],
    choices:[{ivs:[1,15,15],evo:'Hydrapple',league:'ML'}]};
  const restored = core.importSearch(core.exportSearch(state),data);
  assert.equal(JSON.stringify(restored),JSON.stringify(state));
  for (const patch of [{mon:'Unknown'},{ivs:[[16,15,15]]},{max:52},{columns:[['Umbreon','ML']]},
    {choices:[...state.choices,{ivs:[1,15,15],evo:'Flapple',league:'1500'}]}]) {
    assert.throws(() => core.importSearch(core.exportSearch({...state,...patch}),data));
  }
  assert.throws(() => core.importSearch('PVPIVS1:{broken',data));
  assert.throws(() => core.importSearch('something else',data));
});
test('gradient score maps best, midpoint and worst ranks to a stable percentile', () => {
  assert.equal(core.percentile({rank:1,total:4096}),100);
  assert.equal(core.percentile({rank:4096,total:4096}),0);
  assert.equal(core.percentile({rank:51,total:101}),50);
  assert.equal(core.percentile({rank:1,total:1}),100);
});

test('current CP infers base level and rejects evolved cup fits requiring powering down', () => {
  const ivs = [1, 15, 15];
  const cp = core.cpAtLevel(data.Eevee.split(',').slice(1, 4).map(Number), ivs, 30, context.cpm);
  const candidate = {key: 1, mon: 'Eevee', ivs, currentCp: cp};
  assert.equal(core.inferLevels(candidate, data, context.cpm).levels.join(','), '30');
  assert.ok(cp < 1500);
  const great = core.summarize(ranks('Vaporeon', '1500'), ivs);
  assert.ok(great.level < 30);
  const blocked = core.checkCurrentLevel(candidate, great, data, context.cpm);
  assert.equal(blocked.result, null);
  assert.match(blocked.error, /powering down/);
  const master = core.summarize(ranks('Vaporeon', 'ML'), ivs);
  assert.equal(core.checkCurrentLevel(candidate, master, data, context.cpm).result, master);
  assert.ok(core.checkCurrentLevel(candidate, {...master, level: 30}, data, context.cpm).result);
  assert.equal(core.checkCurrentLevel({...candidate, currentCp: 1000000}, master, data, context.cpm).result, null);
  assert.equal(core.checkCurrentLevel({...candidate, currentCp: null}, great, data, context.cpm).result, great);
});
test('rounded CP exposes all possible levels and uncertain fits are excluded', () => {
  const candidate = {mon: 'Tiny', ivs: [0, 0, 0], currentCp: 10};
  const tiny = {Tiny: '1,1,1,1'};
  const info = core.inferLevels(candidate, tiny, context.cpm);
  assert.equal(info.levels.length, 99);
  assert.equal(info.levels[0], 1);
  assert.equal(info.levels.at(-1), 50);
  const result = {rank: 1, level: 2};
  assert.match(core.checkCurrentLevel(candidate, result, tiny, context.cpm).error, /uncertain/);
  assert.ok(core.checkCurrentLevel(candidate, {...result, level: 50}, tiny, context.cpm).result);
});
test('CP inputs validate, preserve known CP through deduplication and reject conflicts', () => {
  const parsed = core.candidatesFromRows([[1, 15, 15, ''], [1, 15, 15, 500]], 'Eevee');
  assert.equal(parsed.errors.length, 0);
  assert.equal(core.uniqueCandidates(parsed.candidates)[0].currentCp, 500);
  for (const cp of [0, 9, 10.5, 'bad']) assert.ok(core.candidatesFromRows([[1, 15, 15, cp]], 'Eevee').errors.length);
  assert.match(core.candidatesFromRows([[1, 15, 15, 500], [1, 15, 15, 600]], 'Eevee').errors[0], /conflicting CP/);
});
test('saved CP values round-trip and legacy saved searches remain supported', () => {
  const state = {mon: 'Eevee', ivs: [[1, 15, 15], [2, 15, 15]], cps: [500, null], columns: [['Vaporeon', '1500']], floor: 0, min: 1, max: 50, choices: []};
  const restored = core.importSearch(core.exportSearch(state), data);
  assert.equal(JSON.stringify(restored.cps), '[500,null]');
  for (const cps of [[500], [500, 0], [500, 12.5]]) assert.throws(() => core.importSearch(core.exportSearch({...state, cps}), data), /CP/);
  const {cps, ...legacy} = state;
  assert.equal(core.importSearch(core.exportSearch(legacy), data).cps, undefined);
});
