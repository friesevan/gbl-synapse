// PvPoke Pro cups: the shared cup list, Little Cup eligibility and the published-rankings fetch fallback.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('./includes/pro/cups.js'),O=require('./includes/pro/observed-weights.js');
const base=path.join(__dirname,'includes/pro/data'),read=f=>JSON.parse(fs.readFileSync(path.join(base,f)));
const gm=read('gamemaster.json'),index=read('published-cups.json'),schedule=JSON.parse(fs.readFileSync(path.join(__dirname,'scripts/yt-harvest/data/gbl-schedule.json')));
const gmMap=new Map(gm.pokemon.map(p=>[p.speciesId,p]));
const presets=O.presets(schedule),list=C.catalog({presets,gamemaster:gm,index,schedule});

test('one cup list: GBL presets by season, then every PvPoke cup',()=>{
  const keys=new Set(list.entries.map(e=>e.key));
  for(const s of presets.seasons)for(const e of s.entries)assert.ok(keys.has(e.key),e.key);   // the builder's presets are in it
  for(const e of presets.all)assert.ok(keys.has(e.key),e.key);
  const pv=list.groups.at(-1);assert.match(pv.label,/^PvPoke cups/);
  for(const c of gm.cups)if(c.name!=='custom'&&(c.league||index.cups[c.name]||gm.formats.some(f=>f.cup===c.name)))assert.ok(pv.entries.some(e=>e.cup===c.name),c.name);
  for(const [cup,cps] of Object.entries(index.cups))for(const cp of cps)assert.ok(list.find('pvpoke|'+cup+'|'+cp),cup+' '+cp);
  assert.equal(list.find('pvpoke|custom|1500'),null);
  // This week's GBL format: Little Cup: Great League Edition (Season 28, format id "little", 500 CP).
  const lc=list.find('28|little|500');
  assert.equal(lc.name,'Little Cup: Great League Edition');assert.equal(lc.rankingCup,'little');assert.equal(lc.published,true);
  assert.equal(O.defaultPreset(presets,500,'2026-10-17').key,'28|little|500');
  assert.equal(list.find('28|great|1500').rankingCup,'all');                          // open leagues are PvPoke's "all"
  assert.equal(list.find('pvpoke|retro|1500').published,true);
  assert.equal(list.find('all|color|1500').published,false);                          // no color rankings at the commit
  assert.match(C.optionLabel(list.find('all|color|1500')),/no published rankings$/);
  assert.equal(C.defaultEntry(list,500).key,'pvpoke|little|500');
  assert.equal(C.defaultEntry(list,1500).key,'pvpoke|all|1500');
});

test('bundled 500 CP data is PvPoke Little Cup ("little"), not "all" at 500 CP',()=>{
  assert.deepEqual(index.defaults,{500:'little',1500:'all',2500:'all',10000:'all'});
  assert.equal(index.sha,C.SHA);assert.deepEqual(index.cups.little,[500]);
  const little=read('league-500.json');
  const ids=little.overall.map(r=>r.speciesId);
  assert.ok(ids.includes('onix'));assert.ok(!ids.includes('cresselia'));             // "all" at 500 had evolved Pokémon
  assert.deepEqual(ids.slice(0,5),['wynaut','hoothoot','bronzor','togepi','binacle']); // PvPoke little/overall/rankings-500.json at f627e89
  for(const c of C.CATEGORIES)assert.equal(little[c].length,ids.length,c);
});

test('Little Cup eligibility follows PvPoke evolution stages; Onix is in the roster',()=>{
  const st=id=>O.stage(gmMap.get(id));
  assert.equal(st('onix'),1);assert.equal(st('steelix'),3);assert.equal(st('pinsir'),0);assert.equal(st('marill'),2);
  const cup=O.cupDefinition(schedule,'little',500),allowed=id=>O.rosterAllowed('little',cup,id,gmMap.get(id),gmMap);
  assert.equal(allowed('onix'),true);assert.equal(allowed('onix_shadow'),true);
  for(const id of ['registeel','pinsir','lapras_shadow','steelix','marill','shuckle'])assert.equal(allowed(id),false,id);
  const little=read('league-500.json').overall.map(r=>r.speciesId);
  const roster=O.cupRoster(schedule,'little',500,little,gmMap);
  assert.equal(roster.allowed.size,little.length);assert.ok(roster.allowed.has('onix'));
  // Every released species the rules allow is in PvPoke's Little Cup population (bar Shadows PvPoke bans below level 8).
  const ranked=new Set(little),missing=gm.pokemon.filter(p=>p.released!==false&&!gm.greatLeagueIneligible.includes(p.speciesId)&&O.rosterAllowed('little',cup,p.speciesId,p,gmMap)===true&&!ranked.has(p.speciesId)).map(p=>p.speciesId);
  assert.ok(missing.every(id=>id.endsWith('_shadow')),missing.join(' '));
  // A PvPoke gamemaster cup's own rules work the same way.
  const rules=C.gamemasterRules(gm,'little');assert.equal(O.cupRoster(null,'little',500,['onix','steelix'],gmMap,rules).allowed.has('onix'),true);
  assert.equal(O.cupRoster(null,'little',500,['onix','steelix'],gmMap,rules).allowed.has('steelix'),false);
});

function fakeFetch(files){
  const calls=[];
  const fn=async url=>{calls.push(url);const body=files[url.replace('https://raw.githubusercontent.com/pvpoke/pvpoke/'+C.SHA+'/','')];
    if(body===undefined)return {ok:false,status:404,json:async()=>({message:'Not Found'})};
    if(body instanceof Error)return {ok:false,status:500,json:async()=>({})};
    return {ok:true,status:200,json:async()=>body};};
  return {fn,calls};
}

test('published rankings: bundled default, else fetched from PvPoke at the pinned commit, else missing',async()=>{
  const bundled=async()=>[{overall:[{speciesId:'onix'}]},[{speciesId:'onix',weight:1}]];
  const none=fakeFetch({});
  let r=await C.loadPublished({cup:'little',cp:500,index,bundled,fetch:none.fn});
  assert.equal(r.status,'bundled');assert.equal(r.league.overall[0].speciesId,'onix');assert.equal(none.calls.length,0);
  const retro=fakeFetch({'src/data/rankings/retro/overall/rankings-1500.json':[{speciesId:'snorlax'}],'src/data/rankings/retro/leads/rankings-1500.json':[{speciesId:'snorlax'}],'src/data/overrides/retro/1500.json':[{speciesId:'snorlax',weight:5}]});
  r=await C.loadPublished({cup:'retro',cp:1500,index,bundled,fetch:retro.fn});
  assert.equal(r.status,'fetched');assert.deepEqual(Object.keys(r.league),['overall','leads']);assert.equal(r.overrides[0].weight,5);
  assert.ok(retro.calls.every(u=>u.startsWith('https://raw.githubusercontent.com/pvpoke/pvpoke/f627e89e53c0c7b903fff097df7a0ad0ac95decc/src/data/')));
  // The index already knows Color Cup has no rankings: nothing is fetched.
  const color=fakeFetch({});r=await C.loadPublished({cup:'color',cp:1500,index,bundled,fetch:color.fn});
  assert.equal(r.status,'missing');assert.equal(r.checked,'index');assert.equal(color.calls.length,0);
  // Without an index the 404 decides.
  r=await C.loadPublished({cup:'color',cp:1500,index:null,bundled,fetch:color.fn});
  assert.equal(r.status,'missing');assert.equal(r.checked,'fetch');assert.equal(color.calls.length,1);
  assert.match(C.missingMessage(list.find('all|color|1500'),'Great League'),/no published Color Cup: Great League Edition rankings at 1,500 CP at commit f627e89/);
  // Server errors surface instead of passing for "missing"; malformed ids never reach a URL.
  await assert.rejects(C.loadPublished({cup:'retro',cp:1500,index:null,bundled,fetch:fakeFetch({'src/data/rankings/retro/overall/rankings-1500.json':new Error()}).fn}),/GitHub returned 500/);
  await assert.rejects(C.loadPublished({cup:'../x',cp:1500,bundled,fetch:none.fn}),/Unknown cup/);
});

test('the page loads cups.js before ui.js and both builds ship the new files',()=>{
  for(const page of ['familyRanks.html','../artifact/pvp-iv-pro.html']){const html=fs.readFileSync(path.join(__dirname,page),'utf8');
    assert.ok(html.indexOf('includes/pro/cups.js')>0&&html.indexOf('includes/pro/cups.js')<html.indexOf('includes/pro/ui.js'),page);
    assert.match(html,/id="proPublishedCup"/);assert.match(html,/id="proPublishedInfo"/);}
  const manifest=fs.readFileSync(path.join(__dirname,'../artifact/manifest.txt'),'utf8').split('\n');
  for(const f of ['includes/pro/cups.js','includes/pro/data/published-cups.json'])assert.ok(manifest.includes(f),f);
  const shim=fs.readFileSync(path.join(__dirname,'../artifact/includes/artifact-shim.js'),'utf8');
  assert.match(shim,/RANKING_CUPS = \{500: 'little'/);
});
