'use strict';
// Pins the battle emulator's mechanics. reference/mechanics-fixtures.json holds seeded battles chosen from the
// prepared pool for CMP ties, buff chances, form changes, the switch clock, forced replacements, shields on both
// sides and Shadow Pokémon, each with its complete traced outcome. Every battle is replayed through engine-v4 and
// must reproduce score, turns, remaining, charged counts, planner statistics, the controller's observation
// records, every HP sample and every timeline event exactly. If this fails after a mechanics change, the change
// altered what the emulator does: review it, then accept it with
//   node training/mechanics-fixtures.cjs --write --reason "<why>"
// (see the header of mechanics-fixtures.cjs). The fixtures pin the emulator; they are not evidence that the game
// behaves the same (see findings/mechanics-fidelity.md).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const mf=require('./mechanics-fixtures.cjs');
const text=fs.readFileSync(mf.FIXTURE_FILE,'utf8'),fixture=JSON.parse(text);
const hint='Mechanics changed? Run `node training/mechanics-fixtures.cjs` to see every difference and accept reviewed changes with --write --reason.';

test('the fixture file is the canonical output of the regeneration script and untouched by hand',()=>{
 assert.equal(fixture.schema,mf.SCHEMA);
 assert.equal(mf.format(fixture),text,'file differs from what mechanics-fixtures.cjs writes; regenerate it instead of editing it');
 for(const b of fixture.battles)assert.equal(b.digest,mf.digest({a:b.a,b:b.b,seed:b.seed,expected:b.expected}),'digest of '+b.id);
});
test('at least 24 distinct battles cover every situation the emulator approximates',()=>{
 assert.ok(fixture.battles.length>=mf.MIN_BATTLES,fixture.battles.length+' battles');
 assert.equal(new Set(fixture.battles.map(b=>b.id)).size,fixture.battles.length,'unique ids');
 assert.equal(new Set(fixture.battles.map(b=>JSON.stringify([b.a,b.b,b.seed]))).size,fixture.battles.length,'no battle is pinned twice');
 const {missing,count}=mf.coverage(fixture.battles);
 assert.deepEqual(missing,[],'uncovered: '+missing.join(', ')+' (covered: '+[...count].map(([k,v])=>k+'='+v).join(' ')+')');
});
test('stored tags and summaries still describe what each pinned outcome exercises',()=>{
 for(const b of fixture.battles){
  const f=mf.analyse(b.expected);
  assert.deepEqual(mf.tagsOf(f,{a:b.a,b:b.b}),b.tags,b.id);
  assert.ok(b.tags.length>0,b.id+' exercises nothing');
 }
});
test('the pinned set exercises both sides of a CMP exchange, both outcomes of the tie break, and every form',()=>{
 const f=fixture.battles.map(b=>mf.analyse(b.expected));
 // equal-attack ties are broken by a seeded coin per turn: across the fixtures either side must win some
 const firsts=new Set();
 for(const b of fixture.battles.filter(b=>b.tags.includes('cmp-equal-attack'))){
  const byTurn=new Map();for(const e of b.expected.timeline)if(e.type.startsWith('charged '))byTurn.set(e.turn,[...(byTurn.get(e.turn)||[]),e.actor]);
  for(const actors of byTurn.values())if(actors.length===2)firsts.add(actors[0]);
 }
 assert.deepEqual([...firsts].sort(),[0,1],'both sides win some equal-attack ties');
 assert.ok(f.some(x=>x.cmpUnequalAttack>0)&&f.some(x=>x.cmpShadowRawTie>0));
 for(const form of ['aegislash-blade','cramorant-gulp','mimikyu-busted','morpeko-toggle','darmanitan-control'])assert.ok(f.some(x=>x.forms.includes(form)),form);
});
for(const b of fixture.battles){
 test('replay '+b.id+' reproduces the pinned traced outcome exactly',()=>{
  const spec={a:b.a,b:b.b,seed:b.seed},got=mf.tracedOutcome(fixture,spec);
  assert.deepEqual(got,b.expected,hint+' First difference: '+mf.firstDifference(b.expected,got));
  // The production path (no trace, no audit) must agree on everything it reports.
  const headless=mf.replay(fixture,spec),want={...b.expected};
  for(const key of ['samples','teamStats','timeline','traceScore','observed'])delete want[key];
  assert.deepEqual(headless,want,'headless path differs from the traced run. '+hint);
 });
}
test('swapping the sides of a pinned battle gives the complementary result (side invariance)',()=>{
 const swapped=fixture.battles.filter(b=>b.swapOf);
 assert.ok(swapped.length>=2);
 for(const b of swapped){
  const source=fixture.battles.find(x=>x.id===b.swapOf);assert.ok(source,b.id);
  assert.deepEqual([b.a,b.b],[source.b,source.a]);
  assert.equal(b.expected.score,1-source.expected.score,b.id);
  assert.equal(b.expected.turns,source.expected.turns);assert.equal(b.expected.charged,source.expected.charged);
  assert.deepEqual(b.expected.remaining,[...source.expected.remaining].reverse());
  assert.deepEqual(b.expected.planner,source.expected.planner);
 }
});
test('identical teams are reported as the expectation of the battle and its mirror',()=>{
 const twin=fixture.battles.find(b=>b.tags.includes('identical-teams'));
 assert.ok(twin);
 assert.equal(twin.expected.score,0.5);assert.equal(twin.expected.scoreMode,'identical-team-mirrored-expectation');
 assert.equal(twin.expected.mirroredOutcomes[0]+twin.expected.mirroredOutcomes[1],1);
});
test('Darmanitan has no in-battle form change in the pinned engine: a control, not a mechanic',()=>{
 const gm=require('../includes/pro/data/gamemaster.json');
 for(const p of gm.pokemon.filter(p=>/^darmanitan/.test(p.speciesId)))assert.equal(p.formChange,undefined,p.speciesId+' now has a form change; the control fixtures need review');
});
test('pinned teams are variants of the prepared pool when that pool is available locally',t=>{
 if(!fs.existsSync(mf.POOL_FILE))return t.skip('prepared pool not present (training/runs/team-search/pool.json is outside git)');
 const pool=JSON.parse(fs.readFileSync(mf.POOL_FILE,'utf8'));
 if(pool.hash!==fixture.provenance.pool.hash)return t.skip('local pool differs from the one the fixtures were chosen from');
 const known=new Set([...pool.variants,...pool.species].map(v=>v.speciesId+'|'+v.moveset.join(',')));
 for(const b of fixture.battles)for(const [id,moves] of [...b.a,...b.b]){
  if(/^darmanitan/.test(id))continue;
  assert.ok(known.has(id+'|'+moves.join(',')),b.id+': '+id+' '+moves.join('/')+' is not in the pool');
 }
});
test('provenance records the mechanics and data hashes the outcomes were pinned under',t=>{
 const {mechanicsHash,dataHash}=require('./team-search/common.cjs');
 assert.match(fixture.provenance.mechanicsHash,/^[0-9a-f]{64}$/);assert.match(fixture.provenance.dataHash,/^[0-9a-f]{64}$/);
 // Informational only: a behaviour-preserving edit changes the hash without changing any outcome.
 if(fixture.provenance.mechanicsHash!==mechanicsHash({version:'v4'}))t.diagnostic('mechanics hash differs from the one pinned; outcomes above decide whether behaviour changed');
 if(fixture.provenance.dataHash!==dataHash())t.diagnostic('data hash differs from the one pinned (rankings, weights or game master changed)');
 assert.ok(fixture.changelog.length>=1&&fixture.changelog.every(c=>c.reason),'every change of the pinned set has a recorded reason');
});
test('the regeneration script reports, refuses and records: no write without --write, no changed outcome without --reason',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mechanics-'));
 try{
  const file=path.join(dir,'fixtures.json'),id=fixture.battles[0].id,tampered=structuredClone(fixture);
  tampered.battles[0].expected.turns+=1;tampered.battles[0].digest=mf.digest({a:tampered.battles[0].a,b:tampered.battles[0].b,seed:tampered.battles[0].seed,expected:tampered.battles[0].expected});
  const before=mf.format(tampered);fs.writeFileSync(file,before);
  const run=(...args)=>spawnSync(process.execPath,[path.join(__dirname,'mechanics-fixtures.cjs'),'--file',file,'--ids',id,...args],{encoding:'utf8'});
  let r=run();
  assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/changed .* - \$\.turns/);assert.equal(fs.readFileSync(file,'utf8'),before,'a dry run never writes');
  r=run('--write');
  assert.equal(r.status,2,r.stdout+r.stderr);assert.match(r.stderr,/--reason/);assert.equal(fs.readFileSync(file,'utf8'),before,'refused without a reason');
  r=run('--write','--reason','test: accept the tampered turn count back to the engine value');
  assert.equal(r.status,0,r.stdout+r.stderr);
  const after=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(after.battles[0].expected,fixture.battles[0].expected,'the engine\'s own outcome is restored');
  assert.equal(after.changelog.at(-1).reason,'test: accept the tampered turn count back to the engine value');assert.deepEqual(after.changelog.at(-1).changed,[id]);
  r=run();assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/reproduce exactly/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
