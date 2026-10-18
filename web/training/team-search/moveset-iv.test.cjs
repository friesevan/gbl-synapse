'use strict';
// --moveset-mutation and --iv-panel (README sections 7 and 12; findings/moveset-iv.md): defaults unchanged, mutated movesets legal,
// IV builds under the CP cap, a deterministic panel, the order of the post-final panels. The search loop is the real one;
// battles are replaced by a deterministic hash of (team, opponent, seed) that includes the movesets and IV builds.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {BattlePool} = require('../pool.cjs'), {search} = require('./search.cjs'), M = require('./moveset-mutation.cjs'), IV = require('./iv-panel.cjs'), P = require('./engine-pools.cjs');
const O = require('./observed-moves.cjs'), {createMeta} = require('./meta.cjs'), {VERSION, dataHash, digest, teamKey, mechanicsHash} = require('./common.cjs');

function testPool(poolPath) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [], variants = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);if (!p || used.has(p.dex) || row.moveset.length !== 3 || [...O.movePools(p.speciesId).charged].filter(m => !row.moveset.includes(m)).length < 4) continue;used.add(p.dex);
  const s = {speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: Array(97).fill(.5), scoutByType: Array(18).fill(.5), scoutScore: .6, ivs: {atk: 0, def: 15, hp: 15}, cp: 1500, level: 30};
  species.push(s);
  const others = [...O.movePools(s.speciesId).charged].filter(m => !s.moveset.includes(m)).sort();
  variants.push({...s, recommended: true}, {...s, moveset: [s.moveset[0], others[0], others[1]], scoutScore: .5, recommended: false}, {...s, moveset: [s.moveset[0], others[2], others[3]], scoutScore: .4, recommended: false});
  if (species.length === 6) break;
 }
 variants.forEach((v, i) => { v.index = i; });
 const prepared = {config: {version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 3}, species, variants};prepared.hash = digest(prepared);fs.writeFileSync(poolPath, JSON.stringify(prepared));return {species, variants, prepared};
}
const REAL_MAP = BattlePool.prototype.map;
const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
const dropListeners = () => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };
const read = (out, name = 'checkpoint.json') => JSON.parse(fs.readFileSync(path.join(out, name)));
const base = poolPath => ({pool: poolPath, hours: 1, workers: 1, initialTeams: 8, batchTeams: 4, opponents: 6, acquisitionFixtures: 1, promotionFraction: .5, screenTeams: 3, screenOpponents: 2, validationTeams: 2, validationOpponents: 4, baselineCount: 3, candidates: 8, epochs: 1, hidden: 4, ensemble: 1, referenceOpponents: 2, fitFixtures: 16, seed: 123, validationSeed: 902, rounds: 1, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1, confirmationOpponents: 0});

// `retained` = every moveset the pool holds per species; `shape(id, team, h)` may override the score of a job.
function mockBattles({retained = null, shape = null} = {}) {
 const log = {calls: []};
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return REAL_MAP.call(this, jobs, options);
  const {onResult = () => {}, shouldStop = () => false} = options, results = [], call = {size: jobs.length, jobs: []};
  log.calls.push(call);
  for (let i = 0; i < jobs.length; i++) {
   if (shouldStop()) return null;
   const [team, opponent, , , settings] = jobs[i], id = digest([team.map(p => [p.speciesId, p.moveset, p.ivBuild || null]), opponent.map(p => [p.speciesId, p.moveset]), settings.seed]);
   call.jobs.push({team: team.map(p => ({speciesId: p.speciesId, moveset: p.moveset, ivBuild: p.ivBuild || null, ivs: p.ivs, level: p.level, cp: p.cp})), opponent: opponent.map(p => p.speciesId), seed: settings.seed});
   let score = parseInt(id.slice(0, 2), 16) % 3 / 2;
   if (shape) score = shape(score, team, retained);
   const result = {score};results.push(result);onResult(result, i);
  }
  return results;
 };
 return {log, restore: () => { BattlePool.prototype.map = REAL_MAP; }};
}
// Wall-clock fields differ between two runs of the same search; everything else must not.
const TIMES = /^(createdAt|timestamp|startedAt|deadline|runtime)$|[sS]econds$/, strip = x => Array.isArray(x) ? x.map(strip) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !TIMES.test(k)).map(([k, v]) => [k, strip(v)])) : x;
const isRetained = (retained, p) => retained.some(v => v.speciesId === p.speciesId && O.sameMoveset(v.moveset, p.moveset));
async function run(opts, directory, name, mockOptions) {
 const mock = mockBattles(mockOptions), out = path.join(directory, name);
 try { await search({...opts, out}); } finally { mock.restore();dropListeners(); }
 return {out, state: read(out), calls: mock.log.calls};
}

test('engine pools: the legal movesets are preparation\'s 12,335 source, and IV builds respect the CP cap and their ordering', () => {
 const published = require('../../includes/pro/data/league-1500.json').overall.slice(0, 24);
 let checked = 0, differs = 0;
 for (const row of published) {
  const legal = P.legalMovesets(row.speciesId);
  assert.ok(legal.length > 0 && legal.every(m => m.length === 3 && m[0] && m[1]));
  assert.ok(legal.some(m => O.sameMoveset(m, row.moveset)), row.speciesId + ': the recommended moveset is legal');
  assert.equal(new Set(legal.map(m => JSON.stringify([m[0], m.slice(1).sort()]))).size, legal.length, 'no duplicate combinations');
  const b = P.builds(row.speciesId);
  assert.deepEqual(Object.keys(b), P.BUILD_IDS);
  const stats = Object.fromEntries(Object.entries(b).map(([id, build]) => [id, P.statsOf(row.speciesId, build)]));
  for (const [id, build] of Object.entries(b)) {
   assert.ok(build.cp <= P.CP, row.speciesId + ' ' + id + ' exceeds the cap');
   assert.equal(P.cpOf(row.speciesId, build), build.cp, row.speciesId + ' ' + id + ': recorded CP matches the engine\'s formula');
   for (const k of ['atk', 'def', 'hp']) assert.ok(Number.isInteger(build[k]) && build[k] >= 0 && build[k] <= 15);
   assert.ok(build.level >= 1 && build.level <= 50 && (build.level * 2) % 1 === 0);
   checked++;
  }
  for (const id of P.BUILD_IDS) { assert.ok(stats.rank1.overall >= stats[id].overall - 1e-9, 'rank1 has the best stat product'); assert.ok(stats.attack.atk >= stats[id].atk - 1e-9, 'attack has the highest attack'); assert.ok(stats.bulk.def * stats.bulk.hp >= stats[id].def * stats[id].hp - 1e-9, 'bulk has the best defence times HP'); }
  if (JSON.stringify([b.default.atk, b.default.def, b.default.hp]) !== JSON.stringify([b.rank1.atk, b.rank1.def, b.rank1.hp])) differs++;
 }
 assert.ok(checked >= 24 * 4);assert.ok(differs > 0, 'the default spread is not always the rank-1 spread');
});

test('the engine plays an IV build only when the row carries one: no override reproduces the default exactly, a build changes the stats', () => {
 const {play} = require('../engine-v4.cjs'), rows = require('../../includes/pro/data/league-1500.json').overall.slice(0, 6).map(r => ({speciesId: r.speciesId, moveset: r.moveset})), mine = rows.slice(0, 3), theirs = rows.slice(3);
 const b = mine.map(r => P.builds(r.speciesId)), options = {seed: 5, cp: 1500, horizon: 4, interval: 4, beliefSamples: 1};
 const plain = play(mine, theirs, undefined, undefined, options);
 const same = play(mine.map((r, i) => ({...r, ivBuild: b[i].default})), theirs, undefined, undefined, options);
 assert.deepEqual(same, plain, 'a row whose build is the default spread plays the default battle');
 const attack = mine.map((r, i) => ({...r, ivBuild: b[i].attack}));
 assert.ok(attack.some((r, i) => b[i].attack.atk !== b[i].default.atk), 'the attack build differs from the default');
 const changed = play(attack, theirs, undefined, undefined, options);
 assert.notDeepEqual(changed, plain, 'a different spread plays a different battle');
 assert.deepEqual(play(attack, theirs, undefined, undefined, options), changed, 'and it is deterministic');
});

test('defaults: with neither option the checkpoint, report and mechanics id are exactly those of the unchanged search', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json');testPool(poolPath);
 try {
  const opts = {...base(poolPath), sensitivityFixtures: 2, confirmationOpponents: 4, policyPanel: 2, alternatePanel: 2};
  const plain = await run(opts, directory, 'plain'), zero = await run({...opts, movesetMutation: 0, ivPanel: 0, mutationTeams: 4, mutationMargin: 0}, directory, 'zero');
  for (const key of ['movesetMutation', 'ivPanel', 'ivScores']) { assert.equal(key in plain.state, false, key);assert.equal(key in read(plain.out, 'recommendations.json'), false, key); }
  for (const key of ['movesetMutation', 'mutationTeams', 'mutationMargin', 'ivPanel', 'ivPanelSeed']) assert.equal(key in plain.state.config, false, key);
  assert.equal(plain.state.config.mechanicsHash, mechanicsHash({version: 'v4'}), 'the registered v4 id is untouched');
  assert.doesNotMatch(plain.state.config.mechanicsHash, /\+(moveset-mutation|iv-panel)/);
  for (const name of ['report.html', 'findings.md']) assert.doesNotMatch(fs.readFileSync(path.join(plain.out, name), 'utf8'), /Moveset mutation|IV builds/);
  // Explicit zeros are the same run: same battles in the same order, same stored results.
  assert.deepEqual(zero.calls.map(c => c.jobs), plain.calls.map(c => c.jobs));
  assert.deepEqual(strip(zero.state), strip(plain.state));
  assert.deepEqual(strip(read(zero.out, 'recommendations.json')), strip(read(plain.out, 'recommendations.json')));
  assert.equal(P.BUILD_IDS.length, 4);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('--moveset-mutation: mutated movesets are legal, outside the retained five, one move away; kept swaps are paired against their parent; the mechanics id changes', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json'), {variants, prepared} = testPool(poolPath);
 try {
  const opts = {...base(poolPath), movesetMutation: 3, mutationTeams: 2}, shape = (score, team, retained) => team.some(p => !isRetained(retained, p)) ? 1 : Math.min(.5, score);
  const reference = await run(base(poolPath), directory, 'reference', {retained: variants, shape});
  const r = await run(opts, directory, 'mutation', {retained: variants, shape}), state = r.state, block = state.movesetMutation;
  assert.equal(state.config.mechanicsHash, mechanicsHash({version: 'v4'}) + '+moveset-mutation:swaps=3,teams=2,margin=0');
  assert.deepEqual([state.config.movesetMutation, state.config.mutationTeams, state.config.mutationMargin], [3, 2, 0]);
  // Training is untouched; the screening call is followed by exactly one mutation call, then the final test.
  for (const key of ['observations', 'records', 'history']) assert.deepEqual(key === 'history' ? state.history.map(h => h.battles) : state[key], key === 'history' ? reference.state.history.map(h => h.battles) : reference.state[key], key);
  const mutationCall = r.calls.find(c => c.size === block.proposals * 2);assert.ok(mutationCall, 'one call of proposals x screening fixtures');
  assert.equal(r.calls.length, reference.calls.length + 1);
  assert.ok(block.proposals > 0 && block.proposals <= 2 * 3);assert.equal(block.events.length, block.proposals);
  assert.ok(block.variants.length >= 1 && block.variants.length <= block.proposals);
  block.variants.forEach((v, k) => { assert.equal(v.index, prepared.variants.length + k);assert.equal(v.mutated, true);assert.equal(v.recommended, false);assert.equal(v.scoutScore, null); });
  for (const e of block.events) {
   const legal = P.legalMovesets(e.speciesId), mutated = state.movesetMutation.variants[e.team.find(i => i >= prepared.variants.length) - prepared.variants.length];
   assert.ok(mutated && mutated.speciesId === e.speciesId, 'the swapped member is the mutated variant');
   assert.ok(legal.some(m => O.sameMoveset(m, e.to)), 'legal by the engine\'s pools: ' + e.to);
   assert.ok(!variants.some(v => v.speciesId === e.speciesId && O.sameMoveset(v.moveset, e.to)), 'outside the retained five');
   assert.equal(M.distance(e.from, e.to), 1, 'one move changed');
   assert.deepEqual(mutated.moveset, e.to);
   assert.equal(e.team.filter((i, s) => s !== e.slot && i !== e.parent[s]).length, 0, 'only the swapped slot differs from the parent');
   assert.ok(Number.isFinite(e.delta) && e.interval95[0] <= e.delta + 1e-12 && e.delta <= e.interval95[1] + 1e-12);
   assert.equal(e.kept, e.delta > 0);assert.equal(e.fixtures, 2);
  }
  // The scores order the mock gives (swap 1, parent at most .5) keep every swap; the best per parent enters screening.
  assert.equal(block.kept, block.events.length);assert.equal(block.selected, new Set(block.events.map(e => teamKey(e.parent))).size);
  assert.equal(state.screenResults.length, 3 + block.selected);
  for (const e of block.events.filter(e => e.selected)) assert.ok(state.screenResults.some(s => teamKey(s.team) === teamKey(e.team)));
  // The mutant is a finalist (it screened at 1.0) and the report carries its real moveset.
  const recommendations = read(r.out, 'recommendations.json'), mutatedRow = recommendations.rows.find(row => row.variantIndices.some(i => i >= prepared.variants.length));
  assert.ok(mutatedRow, 'a mutated finalist is listed');
  mutatedRow.variantIndices.forEach((i, s) => { if (i >= prepared.variants.length) assert.deepEqual(mutatedRow.team[s].moveset, block.variants[i - prepared.variants.length].moveset); });
  assert.equal(mutatedRow.neural, null);assert.equal('variants' in recommendations.movesetMutation, false);
  const html = fs.readFileSync(path.join(r.out, 'report.html'), 'utf8'), findings = fs.readFileSync(path.join(r.out, 'findings.md'), 'utf8');
  assert.match(html, /<h2>Moveset mutation<\/h2>/);assert.match(findings, /Moveset mutation \(\d+ swaps/);
  assert.equal(fs.existsSync(path.join(r.out, 'report.pvpteams.json.gz')), true);
  // The final comparison against the parent exists only when both finalists; here the parents did not make the final.
  assert.ok(block.events.every(e => e.final === null || Number.isFinite(e.final.delta)));
  // Resuming a finished run starts the final stage over and reaches the same mutation record.
  const mock = mockBattles({retained: variants, shape});try { await search({...opts, out: r.out, resume: true}); } finally { mock.restore();dropListeners(); }
  assert.deepEqual(read(r.out).movesetMutation, block);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('--moveset-mutation: a swap that does not improve the paired score is dropped, and the run is the unmutated one', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json'), {variants} = testPool(poolPath);
 try {
  const worse = (score, team, retained) => team.some(p => !isRetained(retained, p)) ? 0 : score, mockOptions = {retained: variants, shape: worse};
  const reference = await run(base(poolPath), directory, 'reference', mockOptions), r = await run({...base(poolPath), movesetMutation: 2, mutationTeams: 2}, directory, 'worse', mockOptions), block = r.state.movesetMutation;
  assert.ok(block.proposals > 0);assert.equal(block.kept, block.events.filter(e => e.delta > 0).length);
  assert.ok(block.events.every(e => !e.selected || e.kept));
  // Dropped swaps never reach screening or the final test: the finalists are the unmutated run's, and the panel's rows too.
  if (block.selected === 0) { assert.deepEqual(r.state.screenResults, reference.state.screenResults);assert.deepEqual(r.state.finalistTeams, reference.state.finalistTeams);assert.deepEqual(r.state.validations, reference.state.validations); }
  assert.ok(r.state.finalistTeams.every(t => t.every(i => i < variants.length) || block.events.some(e => e.selected && teamKey(e.team) === teamKey(t))));
  // A stricter margin keeps no more swaps than a looser one.
  const strict = await run({...base(poolPath), movesetMutation: 2, mutationTeams: 2, mutationMargin: .25}, directory, 'strict', mockOptions);
  assert.ok(strict.state.movesetMutation.kept <= block.kept);assert.equal(strict.state.config.mechanicsHash.endsWith('margin=0.25'), true);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('--iv-panel runs last, after confirmation, policy, alternate and sensitivity; arms share opponents and seeds, differ only in IVs, and stay under the cap', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json'), {species, prepared} = testPool(poolPath);
 try {
  const opts = {...base(poolPath), sensitivityFixtures: 2, confirmationOpponents: 4, policyPanel: 2, alternatePanel: 2};
  const reference = await run(opts, directory, 'without'), r = await run({...opts, ivPanel: 3}, directory, 'with'), state = r.state, block = state.ivPanel;
  assert.equal(state.config.mechanicsHash, mechanicsHash({version: 'v4'}) + '+iv-panel:builds=default|rank1|attack|bulk');
  // Everything before the panel is unchanged; exactly one extra call, last, of finalists x arms x fixtures battles.
  for (const key of ['observations', 'records', 'screenResults', 'validations', 'baselineResults', 'finalistTeams', 'finalPanel', 'comparisons', 'finalistComparisons', 'confirmation', 'alternatePanel', 'sensitivity', 'policyPanel']) assert.deepEqual(strip(state[key]), strip(reference.state[key]), key);
  assert.equal(r.calls.length, reference.calls.length + 1);assert.deepEqual(r.calls.slice(0, -1).map(c => c.jobs), reference.calls.map(c => c.jobs));
  const call = r.calls.at(-1);assert.equal(call.size, 2 * 4 * 3);assert.equal(state.battles, reference.state.battles + 24);
  // Seed: derived and distinct from every other panel seed.
  const config = state.config, seed = config.ivPanelSeed, others = [902, require('./common.cjs').screeningSeed(902), require('./confirmation.cjs').confirmationSeed(902), config.policyPanelSeed, config.alternatePanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed, ...state.sensitivity.metas.map(m => m.seed)];
  assert.equal(config.ivPanel, 3);assert.ok(!others.includes(seed));
  assert.equal(seed, IV.panelSeed(123, [require('./common.cjs').screeningSeed(902), 902, require('./confirmation.cjs').confirmationSeed(902), config.policyPanelSeed, config.retestPanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed, config.alternatePanelSeed].filter(Number.isInteger)));
  // Jobs are fixture-major over (finalist, arm); the opponent and seed repeat across a fixture's eight teams.
  const meta = createMeta(prepared.species, {mode: 'independent'}), cases = meta.fixtures(3, seed), finalists = state.validations.map(v => v.team);
  call.jobs.forEach((job, i) => {
   const t = i % 8, f = Math.floor(i / 8), finalist = Math.floor(t / 4), arm = P.BUILD_IDS[t % 4];
   assert.equal(job.seed, cases[f].seed);assert.deepEqual(job.opponent, cases[f].team.map(p => p.speciesId));
   job.team.forEach((p, s) => {
    const member = prepared.variants[finalists[finalist][s]], builds = P.builds(member.speciesId);
    assert.equal(p.speciesId, member.speciesId);assert.deepEqual(p.moveset, member.moveset);
    if (arm === 'default') assert.equal(p.ivBuild, null);
    else { assert.deepEqual(p.ivBuild, builds[arm]);assert.ok(p.ivBuild.cp <= 1500);assert.equal(P.cpOf(member.speciesId, p.ivBuild), p.ivBuild.cp);assert.deepEqual([p.ivs.atk, p.ivs.def, p.ivs.hp, p.level, p.cp], [builds[arm].atk, builds[arm].def, builds[arm].hp, builds[arm].level, builds[arm].cp]); }
   });
  });
  // The block: paired deltas against the default arm, intervals around them, raw scores that reproduce the means.
  assert.deepEqual([block.version, block.requestedFixtures, block.fixtures, block.complete, block.seed, block.cpCap], [1, 3, 3, true, seed, 1500]);
  assert.deepEqual(block.teams.map(t => teamKey(t.team)), state.validations.map(v => teamKey(v.team)));assert.deepEqual(block.teams.map(t => t.primary), [true, false]);
  block.teams.forEach((t, i) => {
   assert.equal(t.finalScore, state.validations[i].score);assert.deepEqual(t.deltas.map(d => d.arm), ['rank1', 'attack', 'bulk']);
   const raw = state.ivScores[teamKey(t.team)];assert.deepEqual(Object.keys(raw), P.BUILD_IDS);
   for (const d of t.deltas) { assert.ok(Number.isFinite(d.delta) && d.interval95[0] <= d.delta + 1e-12 && d.delta <= d.interval95[1] + 1e-12);assert.ok(Math.abs(raw[d.arm].reduce((a, b) => a + b, 0) / 3 - raw.default.reduce((a, b) => a + b, 0) / 3 - d.delta) < 1e-12); }
   t.members.forEach(m => { assert.ok(Object.values(m.builds).every(b => b.cp <= 1500));assert.deepEqual(Object.keys(m.changed), ['rank1', 'attack', 'bulk']); });
  });
  const recommendations = read(r.out, 'recommendations.json');assert.deepEqual(recommendations.ivPanel, block);
  assert.match(fs.readFileSync(path.join(r.out, 'report.html'), 'utf8'), /<h2>IV builds<\/h2>/);assert.match(fs.readFileSync(path.join(r.out, 'findings.md'), 'utf8'), /IV builds \(3 common fixtures/);
  assert.equal(fs.existsSync(path.join(r.out, 'report.pvpteams.json.gz')), true);
  // The panel's synthetic variants are not left behind: reports list only the pool's own variants.
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.out, 'pool.json'))).variants.length, prepared.variants.length);
  assert.ok(species.length > 0);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('the IV panel is deterministic for a fixed seed, and a deadline leaves whole fixtures', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json');testPool(poolPath);
 try {
  const opts = {...base(poolPath), ivPanel: 4};
  const a = await run(opts, directory, 'a'), b = await run(opts, directory, 'b');
  assert.deepEqual(a.state.ivPanel, b.state.ivPanel);assert.deepEqual(a.state.ivScores, b.state.ivScores);
  // A different run seed moves the panel's fixtures and, with them, the numbers.
  const c = await run({...opts, seed: 124}, directory, 'c');assert.notEqual(c.state.ivPanel.seed, a.state.ivPanel.seed);
  // assemble on fixed rows: a stable answer, and only whole fixtures count.
  const info = {armCount: 4, fixtures: 4, seed: 7, arms: P.BUILD_IDS}, finalists = [{team: [0, 1, 2], primary: true, finalScore: .6}];
  const members = [[0, 1, 2].map(i => ({variant: i, speciesId: 'x', builds: {}, changed: {rank1: true, attack: true, bulk: false}}))];
  const rows = [[1, 0, 1, 0], [1, 1, 1, 0], [0, 0, 1, 1], [.5, .5, .5, .5]].map((scores, k) => ({team: [k], scores}));
  const one = IV.assemble(info, finalists, members, rows, {seed: 9, samples: 400}), two = IV.assemble(info, finalists, members, rows, {seed: 9, samples: 400});
  assert.deepEqual(one, two);assert.equal(one.block.fixtures, 4);assert.equal(one.block.teams[0].scores.default, .5);assert.equal(one.block.teams[0].deltas[0].delta, .25);assert.ok(Math.abs(one.block.teams[0].deltas[1].delta) < 1e-12);assert.ok(Math.abs(one.block.teams[0].deltas[2].delta) < 1e-12);
  const cut = IV.assemble(info, finalists, members, rows.map((r, k) => ({...r, scores: r.scores.slice(0, k === 2 ? 2 : 4)})), {seed: 9, samples: 400});assert.equal(cut.block.fixtures, 2);assert.equal(cut.block.complete, false);
  assert.equal(IV.assemble(info, finalists, members, rows.map(r => ({...r, scores: []})), {seed: 9}), null);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('invalid options are refused before any battle', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moveset-iv-')), poolPath = path.join(directory, 'source-pool.json');testPool(poolPath);
 try {
  const mock = mockBattles();
  try {
   for (const [name, extra, pattern] of [['m1', {movesetMutation: -1}, /moveset-mutation/], ['m2', {movesetMutation: 2.5}, /moveset-mutation/], ['m3', {movesetMutation: 65}, /moveset-mutation/], ['m4', {movesetMutation: 2, mutationTeams: 0}, /mutation-teams/], ['m5', {movesetMutation: 2, mutationMargin: .5}, /mutation-margin/], ['i1', {ivPanel: -1}, /iv-panel/], ['i2', {ivPanel: 1.5}, /iv-panel/], ['i3', {ivPanel: 5000}, /iv-panel/]]) await assert.rejects(search({...base(poolPath), ...extra, out: path.join(directory, name)}), pattern);
  } finally { mock.restore();dropListeners(); }
  assert.equal(mock.log.calls.length, 0);
  assert.equal(M.suffix({}), '');assert.equal(IV.suffix({}), '');assert.equal(IV.suffix({ivPanel: 0}), '');
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('the detached launcher and the search accept the new options', () => {
 const launch = fs.readFileSync(path.join(__dirname, 'launch.cjs'), 'utf8'), searchSource = fs.readFileSync(path.join(__dirname, 'search.cjs'), 'utf8');
 for (const file of [launch, searchSource]) for (const name of ['movesetMutation:0', 'mutationTeams:4', 'mutationMargin:0', 'ivPanel:0']) assert.ok(file.includes(name), name);
 for (const flag of ['--moveset-mutation', '--mutation-teams', '--mutation-margin', '--iv-panel']) assert.ok(searchSource.includes(flag), flag);
 assert.ok(require('./common.cjs').algorithmHash().length === 64);
});
