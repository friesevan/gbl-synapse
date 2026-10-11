const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
require('./includes/pro/search.js');
const base=path.join(__dirname,'includes/pro'),data=JSON.parse(fs.readFileSync(path.join(base,'data/gamemaster.json')));
function index(cp){
 const context=vm.createContext({console:{log(){}},setInterval,clearInterval,setTimeout,JSON,Math,Date});let result;
 context.self=context;context.addEventListener=()=>{};context.postMessage=value=>{result=JSON.parse(JSON.stringify(value));};
 context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),context));
 vm.runInContext(fs.readFileSync(path.join(base,'worker.js'),'utf8'),context);
 const published=JSON.parse(fs.readFileSync(path.join(base,'data/league-'+cp+'.json'))).overall,meta=JSON.parse(fs.readFileSync(path.join(base,'data/meta-'+cp+'.json')));
 context.onmessage({data:{mode:'searchIndex',data,cp,published,meta}});
 assert.equal(result.type,'searchIndex',result.error);
 return {published,records:new Map(result.records.map(record=>[record.id,record])),context,meta};
}
const fixtures=new Map();const fixture=cp=>{if(!fixtures.has(cp))fixtures.set(cp,index(cp));return fixtures.get(cp);};
function ids(query,cp=1500){const {published,records}=fixture(cp),match=PvPProSearch.compile(query,data);return published.filter(row=>match(row,records)).map(row=>row.speciesId);}
test('engine builds searchable metadata for every published entry in every league',()=>{
 for(const cp of [500,1500,2500,10000]){
  const {published,records}=fixture(cp);assert.equal(records.size,published.length);assert.equal(ids('',cp).length,published.length);
  for(const record of records.values()){assert.ok(record.moves.length);assert.equal(typeof record.xl,'boolean');assert.equal(typeof record.hundo,'boolean');}
 }
});
test('names, nicknames, types, tags, dex, generations and families match PvPoke syntax',()=>{
 assert.ok(ids('azumarill').includes('azumarill'));assert.ok(ids('gfisk').includes('stunfisk_galarian'));
 assert.ok(ids('water').includes('azumarill'));assert.ok(ids('184').includes('azumarill'));
 assert.ok(ids('galarian').includes('stunfisk_galarian'));assert.ok(ids('gen5').includes('stunfisk_galarian'));
 assert.ok(!ids('gen1').includes('raichu_alolan'));assert.deepEqual(ids('gen2'),ids('johto'));
 const family=ids('+politoed');assert.ok(family.includes('politoed'));assert.ok(family.includes('poliwrath'));assert.ok(!family.includes('azumarill'));
 for(const tag of ['legendary','mythical','ultrabeast','regional','alolan','galarian','starter','shadow','shadoweligible','mega','supermega']){
  const {records}=fixture(1500);assert.deepEqual(ids(tag),fixture(1500).published.filter(row=>records.get(row.speciesId).tags.includes(tag)||records.get(row.speciesId).name.startsWith(tag)||records.get(row.speciesId).id.startsWith(tag)).map(row=>row.speciesId));
 }
});
test('move queries use only the displayed moveset, including type and legacy restrictions',()=>{
 const {published,records}=fixture(1500);
 for(const query of ['@counter','@1fighting','@2mud','@special','@legacy']){
  for(const id of ids(query)){const row=published.find(r=>r.speciesId===id),moves=records.get(id).moves.filter(m=>row.moveset.includes(m.id));assert.ok(moves.length);if(query==='@counter')assert.ok(moves.some(m=>m.name.startsWith('counter')));if(query==='@1fighting')assert.ok(moves.some(m=>m.kind==='fast'&&m.type==='fighting'));if(query==='@2mud')assert.ok(moves.some(m=>m.kind==='charged'&&m.name.startsWith('mud')));if(query==='@legacy')assert.ok(moves.some(m=>(m.legacy||m.elite)&&!['RETURN','FRUSTRATION'].includes(m.id)));}
 }
});
test('AND binds before OR, NOT inverts a term, case and whitespace are accepted',()=>{
 const water=new Set(ids('water')),fight=new Set(ids('@fighting'));
 assert.deepEqual(ids(' WATER & @FIGHTING '),ids('').filter(id=>water.has(id)&&fight.has(id)));
 assert.deepEqual(ids('water,fighting'),ids('').filter(id=>water.has(id)||ids('fighting').includes(id)));
 assert.deepEqual(ids('!water'),ids('').filter(id=>!water.has(id)));
 assert.deepEqual(ids('water&!shadow'),ids('water').filter(id=>!ids('shadow').includes(id)));
 assert.deepEqual(ids('water&@fighting,gfisk'),ids('').filter(id=>water.has(id)&&fight.has(id)||id==='stunfisk_galarian'));
 assert.deepEqual(ids('water,'),ids('water'));assert.equal(ids('water&').length,0);assert.equal(ids('not a real query').length,0);
});
test('cost, distance, meta, editor notes, XL, hundo and traits use league-aware metadata',()=>{
 const {published,records}=fixture(1500);
 for(const [query,predicate] of [['50k',r=>r.cost===50000],['5km',r=>r.distance===5],['meta',r=>r.meta],['xl',r=>r.xl],['hundo',r=>r.hundo],['spammy',r=>r.traits.includes('spammy')],['bulky',r=>r.traits.includes('bulky')||r.traits.includes('extremely bulky')]])assert.deepEqual(ids(query),published.filter(row=>predicate(records.get(row.speciesId))).map(row=>row.speciesId),query);
 assert.deepEqual(ids('hundo'),ids('4*'));assert.ok(ids('hundo',10000).length>0);assert.ok(ids('xl',2500).length>0);
 assert.deepEqual(ids('notes'),published.filter(row=>row.editorNotes?.trim()).map(row=>row.speciesId));
 const row={...published.find(row=>row.editorNotes),editorNotes:undefined};assert.equal(PvPProSearch.compile('notes',data)(row,records),false);
});
test('generated and saved variants match their actual moveset, not species capability',()=>{
 const {published,records}=fixture(1500),sample=published.find(row=>row.speciesId==='poliwrath');
 const variants=[{...sample,variantId:'poliwrath|A',moveset:['BUBBLE','ICE_PUNCH','SCALD']},{...sample,variantId:'poliwrath|B',moveset:['COUNTER','ICE_PUNCH','SCALD']}];
 assert.equal(variants.filter(row=>PvPProSearch.compile('@counter',data)(row,records)).length,1);
 assert.equal(variants.filter(row=>PvPProSearch.compile('!@counter',data)(row,records)).length,1);
});

test('representative search results agree with the pinned upstream GameMaster search',()=>{
 const {published,context,meta}=fixture(1500);
 context.$=function(selector){return {first(){return this;},attr(){return typeof selector==='object'?selector.speciesId:'searchMeta';},each(callback){if(typeof selector==='string'&&selector.startsWith('.rank'))published.filter(row=>row.editorNotes).forEach((row,i)=>callback(i,row));}};};
 context.$.each=(items,callback)=>items.forEach((item,i)=>callback(i,item));
 context.window={location:{href:'/rankings/all/1500/overall/'}};
 vm.runInContext("var searchGM=GameMaster.getInstance();var searchBattle=new Battle();searchBattle.setCP(1500);searchBattle.setCup('all');",context);
 context.searchGM.groups.searchMeta=meta;
 for(const query of ['azumarill','gfisk','water','galarian','184','gen2','+politoed','spammy','bulky','50k','5km','meta','notes','hundo','xl','water,fighting','!water']){
  context.query=query;const native=new Set(vm.runInContext('searchGM.generatePokemonListFromSearchString(query,searchBattle)',context));
  assert.deepEqual(ids(query),published.filter(row=>native.has(row.speciesId)).map(row=>row.speciesId),query);
 }
});

test('team AND terms can match different members, and NOT excludes any matching member',()=>{
 const {records}=fixture(1500);
 const team=[
  {speciesId:'melmetal',moveset:['THUNDER_SHOCK','DOUBLE_IRON_BASH','DYNAMIC_PUNCH']},
  {speciesId:'cramorant',moveset:['PECK','DIVE','FLY']},
  {speciesId:'poliwrath',moveset:['COUNTER','ICE_PUNCH','SCALD']}
 ];
 const matches=query=>PvPProSearch.compileTeam(query,data)(team,records);
 assert.equal(matches('melmetal&cramorant'),true);
 assert.equal(matches(' MELMETAL & CRAMORANT & @counter '),true);
 assert.equal(matches('melmetal&cramorant&@1fighting'),true);
 assert.equal(matches('melmetal&azumarill'),false);
 assert.equal(matches('melmetal&!cramorant'),false);
 assert.equal(matches('melmetal&!azumarill'),true);
 assert.equal(matches('!@counter'),false);
 assert.equal(matches('melmetal&azumarill,cramorant'),true);
 assert.equal(matches('water&@counter'),true);
 assert.equal(matches(''),true);
 assert.equal(matches('melmetal&'),false);
 const withoutCounter=team.map(row=>row.speciesId==='poliwrath'?{...row,moveset:['BUBBLE','ICE_PUNCH','SCALD']}:row);
 assert.equal(PvPProSearch.compileTeam('melmetal&cramorant&@counter',data)(withoutCounter,records),false);
 assert.equal(PvPProSearch.compileTeam('!@counter',data)(withoutCounter,records),true);
});

test('single-term team searches preserve all ranking predicates',()=>{
 const {published,records}=fixture(1500);
 for(const query of ['gfisk','water','shadow','gen2','184','+politoed','@counter','@2mud','@legacy','@special','bulky','50k','5km','meta','notes','hundo','xl']){
  const single=PvPProSearch.compile(query,data),team=PvPProSearch.compileTeam(query,data);
  assert.deepEqual(published.filter(row=>team([row],records)).map(row=>row.speciesId),published.filter(row=>single(row,records)).map(row=>row.speciesId),query);
 }
});

test('lead-scoped team searches restrict all supported predicates to the first member',()=>{
 const {published,records}=fixture(1500),team=['melmetal','cramorant','poliwrath'].map(id=>published.find(r=>r.speciesId===id));
 const match=query=>PvPProSearch.compileTeam(query,data)(team,records);
 assert.equal(match('lead:melmetal&cramorant'),true);
 assert.equal(match('lead:cramorant'),false);
 assert.equal(match('lead:@thunder shock'),true);
 assert.equal(match('lead:melmetal/@thunder shock'),true);
 assert.equal(match('lead:steel&!lead:water'),true);
 assert.equal(match('lead:@counter'),false);
 assert.equal(match('lead:cramorant,lead:melmetal'),true);
 assert.equal(match('lead:'),false);
});
