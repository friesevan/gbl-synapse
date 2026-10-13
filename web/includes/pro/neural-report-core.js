(function(root){
'use strict';
function validate(d){
 const fail=m=>{throw Error('Invalid neural report: '+m);};
 if(!d||d.format!=='pvp-team-report'||d.schemaVersion!==1)fail('unsupported format/version');
 if(!['neural-team-search-v1','neural-team-search-v2','neural-team-search-v3','neural-team-search-v4'].includes(d.engineVersion)||d.fixtureMode!==(d.engineVersion==='neural-team-search-v1'?'paired':'single'))fail('engine/fixture mismatch');
 const table=d.table;if(!table||!Array.isArray(table.rows)||table.rows.length>30000||!Array.isArray(table.variants)||table.variants.length>10000||!Array.isArray(table.opponents)||table.opponents.length>2000||!table.matches)fail('missing or oversized tables');
 const pokemon=p=>p&&typeof p.speciesId==='string'&&typeof p.speciesName==='string'&&Array.isArray(p.moveset)&&p.moveset.length>=2&&p.moveset.length<=4&&p.moveset.every(m=>typeof m==='string'&&m.length<100)&&Array.isArray(p.recommended);
 if(!table.variants.every(pokemon)||!table.opponents.every(pokemon))fail('invalid Pokémon');
 if(!d.snapshot?.gameMaster?.pokemon||!Array.isArray(d.snapshot.gameMaster.moves)||!Array.isArray(d.snapshot.published)||!Array.isArray(d.snapshot.overrides)||!Array.isArray(d.snapshot.meta))fail('missing pinned search data');
 if(d.engineVersion==='neural-team-search-v4'){
  const o=d.engineOptions;if(!o||!Array.isArray(o.beliefRoster)||!o.beliefRoster.length||o.beliefRoster.length>2000||!Array.isArray(o.beliefTeams)||o.beliefTeams.length>10000||!Number.isInteger(o.beliefSamples)||o.beliefSamples<1||o.beliefSamples>16)fail('invalid observation prior');
  const ids=new Set(o.beliefRoster.map(p=>p.speciesId));
  if(ids.size!==o.beliefRoster.length||o.beliefRoster.some(p=>typeof p.speciesId!=='string'||!Number.isInteger(p.dex)||!Number.isFinite(p.weight)||p.weight<0||!Array.isArray(p.moveset)||p.moveset.length<2||p.moveset.length>4||p.moveset.some(m=>typeof m!=='string')))fail('invalid belief species');
  if(o.beliefTeams.some(t=>!Array.isArray(t)||t.length!==3||new Set(t).size!==3||t.some(id=>!ids.has(id))))fail('invalid belief lineup');
  // Controller options travel in engineOptions (one controller for both sides); per-side controllers are evaluation-only.
  if(o.controllerTeams!=null)fail('invalid controller options');
 }
 const ids=new Set();let fixtures=0;
 for(const row of table.rows){
  if(!Number.isInteger(row.id)||row.id<0||ids.has(row.id)||!Array.isArray(row.team)||row.team.length!==3||row.team.some(i=>!Number.isInteger(i)||!table.variants[i]))fail('invalid or duplicate team');ids.add(row.id);
  for(const field of ['training','selection','screen','test'])if(row[field]!=null&&(!Number.isFinite(row[field])||row[field]<-1||row[field]>1))fail('invalid score');
  if(!Number.isSafeInteger(row.games)||row.games<0)fail('invalid battle count');
  const matches=table.matches[row.id];if(!matches)fail('missing battles');
  for(const key of ['training','screen','test','baseline']){
   if(!Array.isArray(matches[key]))fail('missing battle stage');fixtures+=matches[key].length;if(fixtures>3000000)fail('too many battles');
   for(const m of matches[key])if(!Array.isArray(m)||m.length!==3||!Array.isArray(m[0])||m[0].length!==3||m[0].some(i=>!Number.isInteger(i)||!table.opponents[i])||!Number.isInteger(m[1])||m[1]<0||m[1]>0xffffffff||!Number.isFinite(m[2])||m[2]<0||m[2]>1)fail('malformed battle');
  }
 }
 // Optional (added with the previous-champions baseline group); older reports simply lack it.
 if(d.champions!=null){const c=d.champions,ok=i=>Number.isInteger(i)&&table.variants[i];if(!Array.isArray(c.teams)||c.teams.length>500||c.teams.some(t=>!Array.isArray(t.team)||t.team.length!==3||!t.team.every(ok)||typeof t.label!=='string'||t.label.length>200)||c.skipped!=null&&(!Array.isArray(c.skipped)||c.skipped.length>500||c.skipped.some(x=>!x||typeof x.label!=='string'||typeof x.detail!=='string')))fail('invalid previous champions');if(c.comparisons!=null&&(!Array.isArray(c.comparisons.entries)||c.comparisons.entries.length>500||c.comparisons.entries.some(e=>!Array.isArray(e.team)||e.team.length!==3||!e.team.every(ok)||!Number.isFinite(e.score)||!Number.isFinite(e.delta)||!Array.isArray(e.interval95)||e.interval95.length!==2||!e.interval95.every(Number.isFinite)||typeof e.verdict!=='string')))fail('invalid champion comparisons');}
 // Optional (added with the meta-sensitivity panel, training/team-search/sensitivity.cjs); older reports simply lack it.
 if(d.sensitivity!=null){
  const s=d.sensitivity,ok=i=>Number.isInteger(i)&&table.variants[i],unit=v=>Number.isFinite(v)&&v>=0&&v<=1,optional=v=>v==null||unit(v);
  const meta=m=>m&&typeof m.id==='string'&&m.id.length<=80&&typeof m.label==='string'&&m.label.length<=300&&Number.isInteger(m.fixtures)&&m.fixtures>=1&&Number.isInteger(m.seed)&&m.seed>=0&&m.seed<=0xffffffff;
  const rowOk=t=>t&&typeof t.kind==='string'&&Array.isArray(t.team)&&t.team.length===3&&t.team.every(ok)&&Array.isArray(t.scores)&&t.scores.length===s.metas.length&&t.scores.every(unit)&&unit(t.mean)&&unit(t.min)&&unit(t.max)&&unit(t.spread)&&t.min<=t.mean+1e-9&&t.mean<=t.max+1e-9&&optional(t.finalScore)&&optional(t.noiseSpread)&&(t.spreadInterval95==null||Array.isArray(t.spreadInterval95)&&t.spreadInterval95.length===2&&t.spreadInterval95.every(unit))&&(t.ranks==null||Array.isArray(t.ranks)&&t.ranks.length===s.metas.length&&t.ranks.every(Number.isInteger));
  if(typeof s!=='object'||!Array.isArray(s.metas)||!s.metas.length||s.metas.length>32||!s.metas.every(meta)||new Set(s.metas.map(m=>m.id)).size!==s.metas.length||!Number.isInteger(s.fixtures)||s.fixtures<1||!Array.isArray(s.teams)||s.teams.length>500||!s.teams.every(rowOk))fail('invalid sensitivity panel');
 }
 // Optional (added with the sealed confirmation test): null when no challenger needed confirming; older reports lack it.
 if(d.confirmation!=null){const c=d.confirmation,ok=i=>Number.isInteger(i)&&table.variants[i],team=t=>Array.isArray(t)&&t.length===3&&t.every(ok),score=v=>v==null||Number.isFinite(v)&&v>=0&&v<=1,band=b=>Array.isArray(b)&&b.length===2&&b.every(Number.isFinite);
  if(typeof c!=='object'||!Number.isInteger(c.seed)||c.seed<0||c.seed>0xffffffff||!Number.isSafeInteger(c.requestedFixtures)||c.requestedFixtures<1||c.requestedFixtures>100000||!Number.isSafeInteger(c.completedFixtures)||c.completedFixtures<0||c.completedFixtures>c.requestedFixtures||!team(c.primary)||!['challenger-confirmed','not-confirmed','incomplete'].includes(c.outcome)||typeof c.summary!=='string'||c.summary.length>4000||(c.method!=null&&(typeof c.method!=='string'||c.method.length>2000))
   ||!Array.isArray(c.teams)||c.teams.length<1||c.teams.length>500||c.teams.some(t=>!team(t.team)||!['primary','challenger'].includes(t.role)||!score(t.score)||!score(t.finalScore))
   ||!Array.isArray(c.comparisons)||c.comparisons.length>500||c.comparisons.some(x=>!team(x.team)||!Number.isFinite(x.delta)||!band(x.interval95)||!band(x.simultaneous95)||!['primary-better','challenger-better','unresolved'].includes(x.verdict)||typeof x.confirmed!=='boolean')
   ||c.pairs!=null&&(!Array.isArray(c.pairs)||c.pairs.length>5000||c.pairs.some(p=>!team(p.a)||!team(p.b)||!Number.isFinite(p.delta)||!band(p.simultaneous95))))fail('invalid confirmation');}
 // Optional (opponent policy styles: search.cjs --policy-panel, training/next/policy-panel.cjs); older reports lack it.
 if(d.policyPanel!=null){const p=d.policyPanel,ok=i=>Number.isInteger(i)&&table.variants[i],score=x=>Number.isFinite(x)&&x>=0&&x<=1,band=b=>Array.isArray(b)&&b.length===2&&b.every(x=>Number.isFinite(x)&&x>=-1&&x<=1),name=x=>typeof x==='string'&&x.length>0&&x.length<=64;
  if(!Array.isArray(p.styles)||p.styles.length<2||p.styles.length>12||p.styles.some(s=>!s||!name(s.name)||typeof s.label!=='string'||s.label.length>100)||new Set(p.styles.map(s=>s.name)).size!==p.styles.length)fail('invalid policy panel styles');
  if(!p.fixtures||!Number.isInteger(p.fixtures.requested)||!Number.isInteger(p.fixtures.completed)||p.fixtures.completed<0||p.fixtures.completed>p.fixtures.requested||p.own!=null&&typeof p.own.label!=='string')fail('invalid policy panel fixtures');
  if(!Array.isArray(p.teams)||p.teams.length>64||p.teams.some(t=>!t||!Array.isArray(t.team)||t.team.length!==3||!t.team.every(ok)||!p.styles.every(s=>score(t.scores?.[s.name]))||![t.mean,t.min,t.max].every(score)||!Number.isFinite(t.spread)||!band(t.spreadInterval95)||t.versusDefault!=null&&(!Array.isArray(t.versusDefault)||t.versusDefault.some(v=>!v||!name(v.style)||!Number.isFinite(v.delta)||!band(v.interval95)))))fail('invalid policy panel teams');
 }
 return d;
}
async function verifySnapshot(d){const raw=JSON.stringify([d.snapshot.published,d.snapshot.overrides,d.snapshot.gameMaster]),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==d.dataHash)throw Error('The report’s pinned data failed its integrity check');return d;}
async function readFile(file){
 if(file.size>128*1024*1024)throw Error('Report exceeds 128 MB');
 const gzip=/\.gz$/i.test(file.name);if(gzip&&!globalThis.DecompressionStream)throw Error('This browser needs an uncompressed .json report');
 const reader=(gzip?file.stream().pipeThrough(new DecompressionStream('gzip')):file.stream()).getReader(),chunks=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>256*1024*1024){await reader.cancel();throw Error('Expanded report exceeds 256 MB');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;chunks.forEach(c=>{bytes.set(c,offset);offset+=c.length;});return verifySnapshot(validate(JSON.parse(new TextDecoder().decode(bytes))));
}
const api={validate,verifySnapshot,readFile};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.NeuralReportCore=api;
})(globalThis);
