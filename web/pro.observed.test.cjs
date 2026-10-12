// Observed opponent weights and GBL cup presets (includes/pro/observed-weights.js; README section 4e).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const O=require('./includes/pro/observed-weights.js');
const read=f=>JSON.parse(fs.readFileSync(path.join(__dirname,f),'utf8'));
const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`${a} ≉ ${b}`);
const group=(species,{lineups=10,leadLineups=0}={})=>({cp:1500,cup:'great',season:28,battles:lineups,lineups,leadLineups,species});
const sp=(teams,{leads=0,yes=0,no=teams,unknown=0}={})=>({teams,leads,shadow:{yes,no,unknown}});

test('weight = 100 × (observed count + K × PvPoke share) / (N + K); PvPoke share = 3w/Σw',()=>{
 const ids=['a','b','c','d'],pvpoke={a:4,b:2,c:0,d:0};       // Σw = 6 → PvPoke shares 3w/Σw: a 2, b 1, c 0, d 0
 const r=O.weights({ids,pvpoke,group:group({a:sp(5),c:sp(2)},{lineups:10}),priorStrength:10,leadBonus:0});
 const by=Object.fromEntries(r.rows.map(x=>[x.id,x]));
 close(by.a.pvpoke,2);close(by.b.pvpoke,1);close(by.c.pvpoke,0);
 close(by.a.weight,100*(5+10*2)/20);close(by.b.weight,100*(0+10*1)/20);close(by.c.weight,100*(2+0)/20);close(by.d.weight,0,0);
 close(by.a.observed,.5);close(by.c.observed,.2);assert.equal(r.lineups,10);close(r.observedFraction,.5);
 // Missing or invalid PvPoke weights count as 1, like the PvPoke weights option.
 const u=O.weights({ids,pvpoke:{a:1,b:NaN,d:3},group:null});close(u.rows[0].pvpoke,.5);close(u.rows[1].pvpoke,.5);close(u.rows[3].pvpoke,1.5);
});

test('smoothing: no observations give the PvPoke prior; K = 0 gives raw shares; large samples approach observed usage',()=>{
 const ids=['a','b','c'],pvpoke={a:1,b:1,c:1};
 const none=O.weights({ids,pvpoke,group:null});assert.equal(none.lineups,0);assert.equal(none.observedFraction,0);
 for(const row of none.rows)close(row.weight,100);                         // 3·1/3 = 1 → 100
 const empty=O.weights({ids,pvpoke,group:group({},{lineups:0})});for(const row of empty.rows)close(row.weight,100);
 const raw=O.weights({ids,pvpoke,group:group({a:sp(10),b:sp(4)},{lineups:10}),priorStrength:0,leadBonus:0});
 assert.deepEqual(raw.rows.map(r=>Math.round(r.weight)),[100,40,0]);
 const big=O.weights({ids,pvpoke,group:group({a:sp(9000),b:sp(1000)},{lineups:10000}),leadBonus:0});
 close(big.observedFraction,10000/10050);assert.ok(Math.abs(big.rows[0].weight-90)<0.5&&big.rows[2].weight>0&&big.rows[2].weight<1,'unobserved species keep a small positive prior');
 // Small samples don't collapse: 2 lineups barely move the prior.
 const small=O.weights({ids,pvpoke,group:group({a:sp(2)},{lineups:2}),leadBonus:0});
 close(small.rows[1].weight,100*50/52);assert.ok(small.rows[0].weight>small.rows[1].weight);
 assert.equal(O.PRIOR_STRENGTH,50);
 // A stored report re-weights its opponent subset with the roster's original PvPoke total, so the weights repeat exactly.
 close(O.weights({ids:['a'],pvpoke,group:null}).rows[0].weight,300);const kept=O.weights({ids:['a'],pvpoke,group:null,priorTotal:none.priorTotal});close(kept.rows[0].weight,100);
});

test('Shadow split: known ratio, unknown spread by it (pseudo-counts toward PvPoke’s ratio); single-form rosters keep everything',()=>{
 const ids=['m','m_shadow','x'],pvpoke={m:1,m_shadow:1,x:1};
 const r=O.weights({ids,pvpoke,group:group({m:sp(8,{yes:6,no:2,unknown:0})},{lineups:8}),priorStrength:0,leadBonus:0});
 const f=(6+2*.5)/(8+2);close(r.rows[1].observed,f);close(r.rows[0].observed,1-f);
 // Unknown status doesn't move the ratio, only the mass: 4 known (3 yes) + 4 unknown.
 const u=O.weights({ids,pvpoke,group:group({m:sp(8,{yes:3,no:1,unknown:4})},{lineups:8}),priorStrength:0,leadBonus:0});
 close(u.rows[1].teams+u.rows[0].teams,8);close(u.rows[1].teams/8,(3+1)/(4+2));
 // No known status: PvPoke's form ratio (shadow weight 3 vs base 1 → .75).
 const p=O.weights({ids,pvpoke:{m:1,m_shadow:3,x:1},group:group({m:sp(4,{yes:0,no:0,unknown:4})},{lineups:4}),priorStrength:0,leadBonus:0});
 close(p.rows[1].teams,3);close(p.rows[0].teams,1);
 // Only the base form in the roster (e.g. a cup that bans Shadows): all of it stays on the base form.
 const b=O.weights({ids:['m','x'],pvpoke,group:group({m:sp(4,{yes:4,no:0})},{lineups:4}),priorStrength:0,leadBonus:0});close(b.rows[0].observed,1);
 // Observed species outside the roster are reported, not counted.
 const out=O.weights({ids:['x'],pvpoke,group:group({m_mega:sp(2),m:sp(1)},{lineups:4})});assert.deepEqual(out.unmatched.map(u=>u.id),['m_mega','m']);
});

test('lead bonus: β × N × lead share is added to the observed count (only with confirmed leads)',()=>{
 const ids=['a','b'],pvpoke={a:1,b:1},g=group({a:sp(5,{leads:4}),b:sp(5,{leads:1})},{lineups:10,leadLineups:5});
 const r=O.weights({ids,pvpoke,group:g,priorStrength:0});
 close(r.rows[0].observed,(5+.25*10*4/5)/10);close(r.rows[1].observed,(5+.25*10*1/5)/10);
 const n=O.weights({ids,pvpoke,group:{...g,leadLineups:0},priorStrength:0});close(n.rows[0].observed,.5);
});

test('cup roster rules match league.py on the shared fixtures (tests/fixtures/cup-rules.json)',()=>{
 const schedule=read('scripts/yt-harvest/data/gbl-schedule.json'),gm=new Map(read('includes/pro/data/gamemaster.json').pokemon.map(p=>[p.speciesId,p]));
 const {cases}=read('tests/fixtures/cup-rules.json');assert.ok(cases.length>1000);let checked=0;
 for(const [cupId,cp,sid,expected] of cases){const mon=gm.get(sid)||gm.get(sid.replace(/_shadow$/,''));assert.equal(O.rosterAllowed(cupId,{...schedule.cups[cupId],cp},sid,mon,gm),expected,`${cupId}@${cp} ${sid}`);checked++;}
 assert.equal(checked,cases.length);
 // Spot checks of the semantics.
 const at=(cup,cp,sid)=>O.rosterAllowed(cup,{...schedule.cups[cup],cp},sid,gm.get(sid),gm);
 assert.equal(at('great',1500,'venusaur_mega'),false,'no Megas outside Mega Edition');
 assert.equal(at('mega',1500,'venusaur_mega'),true);assert.equal(at('mega',1500,'mewtwo_mega_x'),false,'league-scoped exclude');assert.equal(at('mega',10000,'mewtwo_mega_x'),true);
 assert.equal(at('little',500,'bulbasaur'),true);assert.equal(at('little',500,'venusaur'),false,'evolution stage');assert.equal(at('little',500,'shuckle'),false);
 assert.equal(at('bidoof',1500,'bidoof_shadow'),true);assert.equal(at('bidoof',1500,'medicham'),false);
 const roster=O.cupRoster(schedule,'catchmega',1500,['medicham','azumarill'],gm);assert.equal(roster.rulesUnknown,true);assert.equal(roster.allowed.size,2,'unknown rules do not restrict');
});

test('presets: seasons from the schedule, repeat runs of a cup pooled into one entry, all-seasons pooling, latest open league default',()=>{
 const schedule={seasons:[{season:27,name:'Forever Forward',start:'2026-06-02',end:'2026-09-07'},{season:28,name:'Twilight Trails',start:'2026-09-08',end:'2026-11-30'}],cups:{great:{name:'Great League',cp:1500},mega:{name:'Mega Edition',cp:10000}},periods:[
  {season:27,start:'2026-08-01',end:'2026-08-07',formats:[{id:'great',name:'Great League',cp:1500},{id:'mega',name:'Great League: Mega Edition',cp:1500}]},
  {season:28,start:'2026-09-22',end:'2026-09-28',formats:[{id:'mega',name:'Great League: Mega Edition',cp:1500},{id:'mega',name:'Master League: Mega Edition',cp:10000}]},
  {season:28,start:'2026-10-06',end:'2026-10-12',formats:[{id:'mega',name:'Great League: Mega Edition',cp:1500},{id:'great',name:'Great League',cp:1500}]}]};
 const p=O.presets(schedule);assert.deepEqual(p.seasons.map(s=>s.season),[28,27]);
 const glMega=p.seasons[0].entries.find(e=>e.cup==='mega'&&e.cp===1500);assert.equal(glMega.periods.length,2);assert.equal(glMega.key,'28|mega|1500');
 assert.equal(O.presetLabel(glMega),'Season 28 · Twilight Trails › Great League: Mega Edition');
 assert.equal(p.seasons[0].entries[0].cup,'great','the open league is listed first');
 const all=p.all.find(e=>e.cup==='mega'&&e.cp===1500);assert.equal(all.periods.length,3);assert.equal(all.season,'all');assert.equal(O.find(p,'all|mega|1500'),all);
 assert.equal(O.defaultPreset(p,1500,'2026-10-12').key,'28|great|1500');
 assert.equal(O.defaultPreset(p,1500,'2026-08-20').key,'27|great|1500','before season 28 starts');
 assert.equal(O.defaultPreset(p,2500,'2026-10-12'),null);
 // The real schedule: Season 28 GL Mega Edition consolidates its weeks.
 const real=O.presets(read('scripts/yt-harvest/data/gbl-schedule.json')),s28=real.seasons.find(s=>s.season===28);
 assert.ok(s28.entries.find(e=>e.key==='28|mega|1500').periods.length>=2);assert.equal(O.defaultPreset(real,1500,'2026-10-12').key,'28|great|1500');
});

test('usage parity: observed_usage.py groups and the Observed meta analysis count the same lineups (tests/fixtures/observed-usage.json)',()=>{
 const C=require('./includes/meta/observed-core.js'),fx=read('tests/fixtures/observed-usage.json'),occ=C.dedupe(fx.occurrences);
 for(const g of fx.expected){
  const sel=occ.filter(o=>o.cp===g.cp&&o.cupId===g.cup&&o.format==='gbl'&&o.rangeStatus==='text-confirmed'&&(g.season==='all'||o.season===g.season));
  const a=C.analyze(sel,{side:'opponent'});
  assert.equal(a.battles,g.battles);assert.equal(a.completeLineups,g.lineups);assert.equal(a.leadLineups,g.leadLineups);assert.equal(a.creators,g.creators);
  assert.deepEqual(Object.fromEntries(a.usage.map(u=>[u.id,{teams:u.teams,leads:u.leads,shadow:u.shadow}])),g.species,`${g.cp} ${g.cup} ${g.season}`);
 }
 const usage=O.parseUsage({format:O.FORMAT,version:1,groups:fx.expected});
 assert.equal(O.group(usage,1500,'mega',28).lineups,4);assert.equal(O.group(usage,1500,'mega','all').battles,9,'all seasons pool seasons 22 and 28');assert.equal(O.group(usage,1500,'mega',27),null);
});

test('fallback and import: invalid files are rejected; a missing group leaves PvPoke’s relative weights',()=>{
 assert.throws(()=>O.parseUsage({occurrences:[]}),/observed-usage/);assert.throws(()=>O.parseUsage({format:O.FORMAT,version:2,groups:[]}),/version/);
 const parsed=O.parseUsage({format:O.FORMAT,version:1,revision:'r',groups:[{cp:1500,cup:'great',season:28,lineups:2,species:{'bad id':{teams:1},azumarill:{teams:2,shadow:{no:2}}}}]});
 assert.deepEqual(Object.keys(parsed.groups[0].species),['azumarill']);assert.equal(O.group(null,1500,'great',28),null);
 const pv={a:10,b:5,c:1},r=O.weights({ids:['a','b','c'],pvpoke:pv,group:null});
 assert.deepEqual(r.rows.map(x=>x.id).sort((x,y)=>r.weights.get(y)-r.weights.get(x)),['a','b','c']);close(r.weights.get('a')/r.weights.get('b'),2);
});

test('pages: Observed is the default, PvPoke weights an explicit option; cup selector, import and artifact parity',()=>{
 const manifest=fs.readFileSync(path.join(__dirname,'..','artifact','manifest.txt'),'utf8').split('\n');
 for(const f of ['includes/pro/observed-weights.js','scripts/yt-harvest/data/gbl-schedule.json'])assert.ok(manifest.includes(f),f);
 for(const page of [path.join(__dirname,'familyRanks.html'),path.join(__dirname,'..','artifact','pvp-iv-pro.html')]){
  const html=fs.readFileSync(page,'utf8');
  assert.match(html,/name="proWeightMode" value="observed" checked/);assert.match(html,/name="proWeightMode" value="default"><span><strong>PvPoke weights/);
  assert.match(html,/name="proScoreMode" value="observed" checked/);assert.match(html,/id="proCup"/);assert.match(html,/id="proUsageImport"/);
  assert.ok(html.indexOf('includes/pro/observed-weights.js')<html.indexOf('includes/pro/ui.js'));
 }
 const ui=fs.readFileSync(path.join(__dirname,'includes/pro/ui.js'),'utf8');
 assert.match(ui,/\/api\/observed-usage/);assert.match(ui,/localStorage\.setItem\(USAGE_KEY/);assert.match(ui,/mode:observed\?'manual':mode/,'observed scores reuse the worker protocol');
 assert.match(fs.readFileSync(path.join(__dirname,'includes/meta/observed.js'),'utf8'),/Export usage weights for PvPoke Pro/);
});
